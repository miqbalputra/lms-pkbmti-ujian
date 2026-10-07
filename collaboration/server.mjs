import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import { createCrdt } from '../shared/form-crdt.mjs'
const {seedDocument,readDocument}=createCrdt(Y)

const base = process.env.CBT_INTERNAL_URL || 'http://app:8080'
const secret = process.env.CBT_COLLABORATION_SECRET || ''
if (secret.length < 32) throw new Error('CBT_COLLABORATION_SECRET must contain at least 32 characters')
const metadata = new Map()
async function request(name, action='', body) {
  const response=await fetch(`${base}/api/internal/form-docs/${encodeURIComponent(name)}${action ? `/${action}` : ''}`, {method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CBT-Collaboration':secret},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)})
  const data=await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || 'Persistence failed'),{status:response.status}); return data
}
async function persist(name,document,ticket) {
  const meta=metadata.get(name)
  if (!meta || meta.frozen) throw new Error('Document is frozen')
  const state=Y.encodeStateAsUpdate(document), vector=Buffer.from(Y.encodeStateVector(document)).toString('base64')
  const saved=await request(name,'store',{ticket,revision:meta.revision,content:readDocument(document),yState:Buffer.from(state).toString('base64')})
  meta.revision=saved.revision
  document.broadcastStateless(JSON.stringify({type:'saved',revision:saved.revision,vector}))
  return saved
}
async function publishAfterBarrier(name, document, connection, message) {
  const meta = metadata.get(name)
  if (meta.publication || meta.frozen) throw Object.assign(new Error('Penerbitan sedang berlangsung. Tunggu atau muat ulang.'), {status:409})
  const peers = document.getConnections().filter(c => ['owner','editor'].includes(c.context.role) && !c.readOnly)
  let finish, abort
  const ready = new Promise((resolve, reject) => {finish=resolve;abort=reject})
  const pending = new Set(peers)
  meta.publication = {requestId:message.requestId, pending, finish, abort}
  const timeout = setTimeout(()=>abort(Object.assign(new Error('Ada editor yang belum mengakui sinkronisasi. Sambungkan kembali sebelum menerbitkan.'),{status:409})),8000)
  for (const peer of peers) peer.sendStateless(JSON.stringify({type:'prepare-publish',requestId:message.requestId}))
  if (!pending.size) finish()
  try {
    await ready
    // The per-connection message queue processes updates before its ready frame.
    // Freeze only after every current editor acknowledges its latest vector.
    meta.freezing = true
    meta.chain = meta.chain.catch(()=>{}).then(async()=>{
      await persist(name,document,connection.context.ticket)
      const published=await request(name,'publish',{ticket:connection.context.ticket,revision:meta.revision})
      meta.frozen=true
      document.broadcastStateless(JSON.stringify({type:'published',requestId:message.requestId,...published}))
    })
    await meta.chain
  } catch(error) {
    meta.freezing=false
    document.broadcastStateless(JSON.stringify({type:'publish-cancelled',requestId:message.requestId,message:error.message,status:error.status}))
    throw error
  } finally {clearTimeout(timeout);meta.publication=null}
}
// Every connection is reauthorized before processing messages. Revocation and
// publication therefore stop existing editors, not just newly issued tickets.
const server = new Server({
  port:Number(process.env.PORT || 1234), debounce:700, maxDebounce:3000,
  websocketOptions:{maxPayload:2*1024*1024}, timeout:30000,
  async onAuthenticate({token,documentName,connectionConfig}) {
    if(metadata.get(documentName)?.publication)throw new Error('Publication synchronization in progress; retry')
    const auth=await request(documentName,'authorize',{ticket:token})
    connectionConfig.readOnly=auth.frozen || !['owner','editor'].includes(auth.role)
    return {ticket:token,role:auth.role}
  },
  async onLoadDocument({documentName}) {
    const stored=await request(documentName),document=new Y.Doc()
    if (stored.yState) Y.applyUpdate(document,Buffer.from(stored.yState,'base64'))
    seedDocument(document,stored.content)
    metadata.set(documentName,{revision:stored.revision,frozen:stored.frozen,chain:Promise.resolve(),ticket:null})
    return document
  },
  async beforeHandleMessage({documentName,context}) {
    const auth=await request(documentName,'authorize',{ticket:context.ticket})
    if (auth.frozen || auth.role!==context.role || metadata.get(documentName)?.freezing) throw new Error('Document frozen or access changed; reconnect')
  },
  async onChange({documentName,context}) { if(context?.ticket && ['owner','editor'].includes(context.role)) metadata.get(documentName).ticket=context.ticket },
  async onStoreDocument({documentName,document}) {
    const meta=metadata.get(documentName);if (!meta?.ticket || meta.frozen) return
    meta.chain=meta.chain.catch(()=>{}).then(()=>meta.frozen?undefined:persist(documentName,document,meta.ticket))
    try {await meta.chain} catch(error) {document.broadcastStateless(JSON.stringify({type:'error',message:error.message,status:error.status}));throw error}
  },
  async onStateless({documentName,document,connection,payload}) {
    const context=connection.context
    let message;try{message=JSON.parse(payload)}catch{return}
    if(message.type==='publication-ready'){
      const barrier=metadata.get(documentName)?.publication
      if(!barrier || barrier.requestId!==message.requestId || !barrier.pending.has(connection))return
      try {
        if(typeof message.vector!=='string' || message.vector.length>40000)throw new Error('Invalid acknowledgement')
        const client=Y.decodeStateVector(Buffer.from(message.vector,'base64')), current=Y.decodeStateVector(Y.encodeStateVector(document))
        for(const [id,clock] of client)if((current.get(id)||0)<clock)throw new Error('Perubahan editor belum diterima. Coba terbitkan lagi.')
        barrier.pending.delete(connection)
        if(!barrier.pending.size)barrier.finish()
      }catch(error){barrier.abort(error)}
      return
    }
    if(!['flush','publish'].includes(message.type))return
    const auth=await request(documentName,'authorize',{ticket:context.ticket})
    if(auth.frozen || !['owner','editor'].includes(auth.role))return
    const meta=metadata.get(documentName)
    if(message.type==='publish'){
      if(auth.role!=='owner')throw new Error('Only owner may publish')
      // Do not await the barrier in this hook: ready frames must be able to run
      // in the same connection's serial message queue.
      void publishAfterBarrier(documentName,document,connection,message).catch(error=>connection.sendStateless(JSON.stringify({type:'error',requestId:message.requestId,message:error.message,status:error.status})))
      return
    }
    meta.chain=meta.chain.catch(()=>{}).then(()=>persist(documentName,document,context.ticket))
    try {await meta.chain;connection.sendStateless(JSON.stringify({type:'flushed',requestId:message.requestId,revision:meta.revision}))}catch(error){connection.sendStateless(JSON.stringify({type:'error',requestId:message.requestId,message:error.message,status:error.status}))}
  },
  async onRequest({request,response}) {if(request.url==='/health'){response.writeHead(200,{'Content-Type':'application/json'});response.end('{"status":"ok","service":"collaboration"}');throw null}},
})
await server.listen()
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await server.destroy();process.exit(0)})
