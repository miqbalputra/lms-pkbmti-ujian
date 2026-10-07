import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { createCrdt } from '../shared/form-crdt.mjs'

// Refuse production: this gate uses only explicitly disposable local fixtures.
const base = process.env.CBT_TEST_API_URL || 'http://127.0.0.1:8080'
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Live tests require a disposable local CBT API')
const port = 1236, {readDocument,patchMap}=createCrdt(Y)
async function api(path,token,body,method=body?'POST':'GET') {
  const response=await fetch(`${base}/api${path}`,{method,headers:{'Content-Type':'application/json',...token?{Authorization:`Bearer ${token}`} : {}},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)})
  const data=await response.json();assert.equal(response.ok,true,`${path}: ${response.status} ${data.error || ''}`);return data
}
async function until(check,timeout=12000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Live collaboration condition timed out')}
async function host(){
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,PORT:String(port),CBT_INTERNAL_URL:base},stdio:['ignore','pipe','pipe']})
  let diagnostics='';child.stdout.on('data',d=>diagnostics=(diagnostics+d).slice(-3000));child.stderr.on('data',d=>diagnostics=(diagnostics+d).slice(-3000))
  try {await until(async()=>{if(child.exitCode!==null)throw new Error(`Collaboration exited: ${diagnostics}`);try{return (await fetch(`http://127.0.0.1:${port}/health`)).ok}catch{return false}})}catch(error){child.kill();throw error}
  return {async stop(){if(child.exitCode!==null)return;const ended=once(child,'exit');child.kill('SIGTERM');await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Service did not stop cleanly'))},5000).unref())])}}
}
async function client(resource,session){
  const ticket=await api(`/staff/forms/package/${resource}/ticket`,session.accessToken,{}),doc=new Y.Doc(),frames=[],state={ready:true};let synced=false,failed=false
  const provider=new HocuspocusProvider({url:`ws://127.0.0.1:${port}`,name:ticket.documentId,document:doc,token:ticket.ticket,onSynced:({state})=>{synced=state},onAuthenticationFailed:()=>{failed=true},onStateless:({payload})=>{
    const m=JSON.parse(payload);frames.push(m)
    if(m.type==='prepare-publish'&&state.ready)provider.sendStateless(JSON.stringify({type:'publication-ready',requestId:m.requestId,vector:Buffer.from(Y.encodeStateVector(doc)).toString('base64')}))
  }})
  await until(()=>synced||failed);assert.equal(failed,false,'ticket failed')
  return {doc,provider,frames,state,patch(v){doc.transact(()=>patchMap(doc.getMap('form'),v),'test-own')},async flush(type='flush'){
    const requestId=crypto.randomUUID();provider.sendStateless(JSON.stringify({type,requestId}));await until(()=>frames.some(m=>m.requestId===requestId&&['flushed','published','error'].includes(m.type)),18000)
    return frames.find(m=>m.requestId===requestId&&['flushed','published','error'].includes(m.type))
  },close(){provider.destroy();doc.destroy()}}
}
test('live host: PostgreSQL durability after restart, revoked editor, publication barrier, immutable version', {timeout:90000}, async()=>{
  const owner=await api('/auth/login',null,{username:'e2e-owner',password:'CBT-E2E-password-ONLY-2026'}),editor=await api('/auth/login',null,{username:'e2e-editor',password:'CBT-E2E-password-ONLY-2026'})
  const form=await api('/staff/forms/package',owner.accessToken,{}),card=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID()
  const content={...form.content,title:'Live collaboration gate',cards:{[card]:{id:card,type:'pg_tunggal',position:1,deleted:false,prompt:'Pilih jawaban',description:'',points:1,required:false,sectionId:'',stimulusGroupId:'',config:{choices:[{id:a,text:'A'},{id:b,text:'B'}],correctIds:[a]},explanation:''}}}
  await api(`/staff/forms/package/${form.resourceId}`,owner.accessToken,{revision:form.revision,content},'PUT')
  await api(`/staff/forms/package/${form.resourceId}/collaborators`,owner.accessToken,{username:'e2e-editor',role:'editor'},'PUT')
  let service=await host(),one,two
  try {
    one=await client(form.resourceId,owner);two=await client(form.resourceId,editor)
    one.patch({settings:{defaultQuestionPoints:-1}})
    await until(()=>readDocument(two.doc).settings.defaultQuestionPoints===-1)
    const invalid=await one.flush();assert.equal(invalid.type,'error');assert.equal(invalid.status,400)
    assert.equal((await api(`/staff/forms/package/${form.resourceId}`,owner.accessToken)).content.settings.defaultQuestionPoints,1,'failed draft must not materialize')
    one.patch({settings:{defaultQuestionPoints:1}})
    assert.equal((await one.flush()).type,'flushed','corrected draft can retry after rejected flush')
    one.patch({title:'Persist after restart'});two.patch({description:'Peer edit survives'})
    await until(()=>readDocument(one.doc).description==='Peer edit survives'&&readDocument(two.doc).title==='Persist after restart')
    assert.equal((await one.flush()).type,'flushed')
    one.close();two.close();one=two=null;await service.stop();service=await host()
    one=await client(form.resourceId,owner);two=await client(form.resourceId,editor)
    assert.equal(readDocument(one.doc).title,'Persist after restart');assert.equal(readDocument(one.doc).description,'Peer edit survives')
    two.state.ready=false
    const denied=await one.flush('publish');assert.equal(denied.type,'error');assert.equal(denied.status,409)
    assert.equal((await api(`/staff/forms/package/${form.resourceId}`,owner.accessToken)).frozen,false)
    await api(`/staff/forms/package/${form.resourceId}/collaborators`,owner.accessToken,{username:'e2e-editor',role:'editor',revoked:true},'PUT')
    two.patch({title:'REVOKED MUST NOT SAVE'})
    await new Promise(r=>setTimeout(r,1000))
    assert.notEqual((await api(`/staff/forms/package/${form.resourceId}`,owner.accessToken)).content.title,'REVOKED MUST NOT SAVE')
    two.close();two=null
    await new Promise(r=>setTimeout(r,200))
    const published=await one.flush('publish');assert.equal(published.type,'published')
    const stored=await api(`/staff/forms/package/${form.resourceId}`,owner.accessToken);assert.equal(stored.frozen,true);assert.equal(stored.content.title,'Persist after restart')
    const noEdit=await fetch(`${base}/api/staff/forms/package/${form.resourceId}`,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:`Bearer ${owner.accessToken}`},body:JSON.stringify({revision:stored.revision,content})});assert.equal(noEdit.status,409)
  } finally {one?.close();two?.close();await service.stop()}
})
