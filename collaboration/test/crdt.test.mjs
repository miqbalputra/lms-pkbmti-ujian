import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {createCrdt} from '../../shared/form-crdt.mjs'
const {seedDocument,readDocument,patchMap,patchWithUndo}=createCrdt(Y)
const content={schemaVersion:1,title:'Tes',cards:{a:{id:'a',prompt:'Kalimat awal',position:1,deleted:false,config:{choices:[{id:'x',text:'Pilihan pertama'},{id:'y',text:'Pilihan kedua'}],correctIds:[]}},b:{id:'b',prompt:'Soal B',position:2,deleted:false}},settings:{classIds:[]},sections:{},stimuli:{}}
function pair(){const server=new Y.Doc();seedDocument(server,content);const a=new Y.Doc(),b=new Y.Doc();Y.applyUpdate(a,Y.encodeStateAsUpdate(server));Y.applyUpdate(b,Y.encodeStateAsUpdate(server));return [a,b]}
function merge(a,b){const av=Y.encodeStateAsUpdate(a),bv=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bv);Y.applyUpdate(b,av);assert.deepEqual(readDocument(a),readDocument(b))}
test('two writers on one Y.Text retain both insertions',()=>{const [a,b]=pair();const ta=a.getMap('form').get('cards').get('a').get('prompt'),tb=b.getMap('form').get('cards').get('a').get('prompt');ta.insert(0,'Tutor A: ');tb.insert(tb.length,' — Tutor B');merge(a,b);assert.match(readDocument(a).cards.a.prompt,/Tutor A: .*Tutor B/)})
test('simultaneous reorder converges without duplicate IDs',()=>{const [a,b]=pair();patchMap(a.getMap('form'),{cards:{a:{position:3}}});patchMap(b.getMap('form'),{cards:{b:{position:0}}});merge(a,b);assert.deepEqual(Object.keys(readDocument(a).cards).sort(),['a','b'])})
test('delete versus edit preserves tombstone and recoverable text',()=>{const [a,b]=pair();patchMap(a.getMap('form'),{cards:{a:{deleted:true}}});patchMap(b.getMap('form'),{cards:{a:{prompt:'Perubahan saat offline'}}});merge(a,b);assert.equal(readDocument(a).cards.a.deleted,true);assert.equal(readDocument(a).cards.a.prompt,'Perubahan saat offline')})
test('personal undo does not undo another tutor',()=>{const [a,b]=pair(),origin={};const undo=new Y.UndoManager(a.getMap('form'),{trackedOrigins:new Set([origin])});a.transact(()=>patchMap(a.getMap('form'),{title:'Judul saya'}),origin);patchMap(b.getMap('form'),{cards:{b:{prompt:'Soal tutor lain'}}});merge(a,b);undo.undo();assert.equal(readDocument(a).title,'Tes');assert.equal(readDocument(a).cards.b.prompt,'Soal tutor lain')})
test('binary restore retains IDs and scalar-array edits',()=>{const [a]=pair();patchMap(a.getMap('form'),{settings:{classIds:['kelas-a','kelas-b']}});const b=new Y.Doc();Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.deepEqual(readDocument(b),readDocument(a));assert.deepEqual(readDocument(b).settings.classIds,['kelas-a','kelas-b'])})
test('concurrent edits to different options retain both',()=>{const [a,b]=pair();patchMap(a.getMap('form'),{cards:{a:{config:{choices:[{id:'x',text:'A baru'},{id:'y',text:'Pilihan kedua'}]}}}});patchMap(b.getMap('form'),{cards:{a:{config:{choices:[{id:'x',text:'Pilihan pertama'},{id:'y',text:'B baru'}]}}}});merge(a,b);assert.deepEqual(readDocument(a).cards.a.config.choices.map(r=>r.text),['A baru','B baru'])})
test('stale option editing cannot resurrect a deleted option',()=>{const [a,b]=pair();patchMap(a.getMap('form'),{cards:{a:{config:{choices:[{id:'y',text:'Pilihan kedua'}]}}}});patchMap(b.getMap('form'),{cards:{a:{config:{choices:[{id:'x',text:'Offline edit'},{id:'y',text:'Pilihan kedua'}]}}}});merge(a,b);assert.deepEqual(readDocument(a).cards.a.config.choices.map(r=>r.id),['y']);patchMap(a.getMap('form'),{cards:{a:{config:{choices:[{id:'x',text:'Stale later edit'},{id:'y',text:'Pilihan kedua'}]}}}});assert.deepEqual(readDocument(a).cards.a.config.choices.map(r=>r.id),['y'])})

test('rich text survives two writers, binary restart and personal format undo',()=>{
  const [a,b]=pair(),origin={};
  const undo=new Y.UndoManager(a.getMap('form'),{trackedOrigins:new Set([origin])});
  const ta=a.getMap('form').get('cards').get('a').get('prompt');
  a.transact(()=>ta.format(0,7,{bold:true}),origin);
  const tb=b.getMap('form').get('cards').get('a').get('prompt');
  tb.insert(tb.length,' tambahan');
  merge(a,b);
  const restored=new Y.Doc();Y.applyUpdate(restored,Y.encodeStateAsUpdate(a));
  assert.deepEqual(readDocument(restored).cards.a.promptRich,readDocument(a).cards.a.promptRich);
  assert.equal(readDocument(restored).cards.a.promptRich[0].attributes.bold,true);
  undo.undo();
  assert.match(readDocument(a).cards.a.prompt,/tambahan$/);
  assert.ok(readDocument(a).cards.a.promptRich.every(p=>!p.attributes?.bold));
})

test('REST bootstrap restores marks and relative cursor remains attached to text',()=>{
  const doc=new Y.Doc();const rich=structuredClone(content);
  rich.cards.a.promptRich=[{insert:'Kalimat',attributes:{italic:true}},{insert:' awal'}];
  seedDocument(doc,rich);
  assert.deepEqual(readDocument(doc).cards.a.promptRich,rich.cards.a.promptRich);
  const text=doc.getMap('form').get('cards').get('a').get('prompt');
  const cursor=Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text,7));
  text.insert(0,'Baru ');
  assert.equal(Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(cursor),doc).index,12);
})

test('rapid structural undo restores only deleted stimulus, not earlier creation or text',()=>{
  const [doc]=pair(),origin={},undo=new Y.UndoManager(doc.getMap('form'),{trackedOrigins:new Set([origin]),captureTimeout:400});
  patchWithUndo(doc,[],{stimuli:{g:{id:'g',title:'Bahan',deleted:false,blocks:[]}},cards:{a:{stimulusGroupId:'g'}}},origin,undo);
  patchWithUndo(doc,['cards','a'],{prompt:'Tulisan baru'},origin,undo);
  patchWithUndo(doc,[],{stimuli:{g:{deleted:true}},cards:{a:{stimulusGroupId:''}}},origin,undo);
  undo.undo();
  const result=readDocument(doc);
  assert.equal(result.stimuli.g.deleted,false);
  assert.equal(result.cards.a.stimulusGroupId,'g');
  assert.equal(result.cards.a.prompt,'Tulisan baru');
  assert.equal(Object.keys(result.cards).length,2);
  undo.redo();assert.equal(readDocument(doc).stimuli.g.deleted,true);
})

test('typing groups by field without undoing text in a different question',()=>{
  const [doc]=pair(),origin={},undo=new Y.UndoManager(doc.getMap('form'),{trackedOrigins:new Set([origin]),captureTimeout:400});
  patchWithUndo(doc,['cards','a'],{prompt:'A'},origin,undo);
  patchWithUndo(doc,['cards','a'],{prompt:'A B'},origin,undo);
  patchWithUndo(doc,['cards','b'],{prompt:'C'},origin,undo);
  undo.undo();assert.equal(readDocument(doc).cards.b.prompt,'Soal B');assert.equal(readDocument(doc).cards.a.prompt,'A B');
  undo.undo();assert.equal(readDocument(doc).cards.a.prompt,'Kalimat awal');
})
