import { useLayoutEffect, useRef, useState } from 'react';
import { editorText, renderRichEditor, restoreTextSelection, shiftedSelection, textSelection, type TextSelection } from './richTextDom';
export type RichPart={insert:string;attributes?:{bold?:boolean;italic?:boolean;underline?:boolean}};
export function RichText({text,parts}:{text:string;parts?:RichPart[]}) {
  if(!parts?.length||parts.some(p=>typeof p.insert!=='string')||parts.map(p=>p.insert).join('')!==text)return <>{text}</>;
  return <>{parts.map((p,i)=><span key={i} style={{fontWeight:p.attributes?.bold?'bold':undefined,fontStyle:p.attributes?.italic?'italic':undefined,textDecoration:p.attributes?.underline?'underline':undefined}}>{p.insert}</span>)}</>;
}
type PeerSelection={name:string;start?:number;end?:number};
function CursorPreview({text,parts,peers}:{text:string;parts?:RichPart[];peers:PeerSelection[]}) {
  const validParts=parts?.length&&parts.map(p=>p.insert).join('')===text?parts:[{insert:text}];
  const boundaries=new Set([0,text.length]);let offset=0;
  const formats=validParts.map(p=>{const start=offset;offset+=p.insert.length;boundaries.add(offset);return {start,end:offset,attributes:p.attributes}});
  const cursors=peers.filter(p=>p.start!=null&&p.end!=null).map(p=>({...p,start:Math.max(0,Math.min(text.length,p.start!)),end:Math.max(0,Math.min(text.length,p.end!))}));
  cursors.forEach(p=>{boundaries.add(p.start);boundaries.add(p.end)});
  const stops=[...boundaries].sort((a,b)=>a-b);
  return <>{stops.map((start,index)=>{
    const end=stops[index+1]??start,format=formats.find(p=>p.start<=start&&p.end>start),selection=cursors.some(p=>Math.min(p.start,p.end)<=start&&Math.max(p.start,p.end)>start);
    return <span key={start}>{cursors.filter(p=>p.start===start).map((p,i)=><span key={i} className="form-peer-caret" title={`Kursor ${p.name}`} aria-label={`Kursor ${p.name}`}><small>{p.name}</small></span>)}<span style={{backgroundColor:selection?'#dbeafe':undefined,fontWeight:format?.attributes?.bold?'bold':undefined,fontStyle:format?.attributes?.italic?'italic':undefined,textDecoration:format?.attributes?.underline?'underline':undefined}}>{text.slice(start,end)}</span></span>
  })}</>;
}
export function RichQuestionEditor({value,parts,peers=[],onChange,onFormat,onSelection,onUndo,onRedo,disabled}:{value:string;parts?:RichPart[];peers?:PeerSelection[];onChange:(v:string)=>void;onFormat:(start:number,end:number,attributes:Record<string,boolean|null>)=>void;onSelection:(start:number,end:number)=>void;onUndo:()=>void;onRedo:()=>void;disabled:boolean}) {
  const host=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),selection=useRef<TextSelection>({start:0,end:0}),composing=useRef(false);
  const [simple,setSimple]=useState(false),[compositionVersion,setCompositionVersion]=useState(0),[selectionVersion,setSelectionVersion]=useState(0);
  useLayoutEffect(()=>{
    const node=host.current;if(!node||composing.current)return;
    const current=textSelection(node),previous=editorText(node);
    renderRichEditor(node,value,parts);
    if(current&&document.activeElement===node){const shifted=shiftedSelection(current,previous,value);restoreTextSelection(node,shifted);selection.current=shifted;}
  },[value,parts,simple,compositionVersion]);
  function select(){
    const current=simple&&input.current?{start:input.current.selectionStart,end:input.current.selectionEnd}:host.current?textSelection(host.current):null;
    if(current){selection.current=current;onSelection(current.start,current.end);setSelectionVersion(n=>n+1);}
  }
  function format(attributes:Record<string,boolean|null>){
    const {start,end}=selection.current;if(disabled||start===end)return;
    onFormat(start,end,attributes);
    if(simple){input.current?.focus();input.current?.setSelectionRange(start,end);}
    else if(host.current){host.current.focus();restoreTextSelection(host.current,selection.current);}
  }
  function formatted(key:'bold'|'italic'|'underline'){
    let offset=0,matched=false;const {start,end}=selection.current;
    if(start===end)return false;
    for(const part of parts||[{insert:value}]){const from=offset;offset+=part.insert.length;if(from<end&&offset>start){matched=true;if(!part.attributes?.[key])return false;}}
    return matched;
  }
  function insert(text:string){
    const node=host.current;if(!node||disabled)return;
    const current=textSelection(node)||selection.current,previous=editorText(node);
    const next=previous.slice(0,current.start)+text+previous.slice(current.end),caret=current.start+text.length;
    // Render from textContent, never innerHTML/execCommand, even for clipboard data.
    renderRichEditor(node,next);restoreTextSelection(node,{start:caret,end:caret});selection.current={start:caret,end:caret};onChange(next);onSelection(caret,caret);
  }
  function keyboard(e:React.KeyboardEvent<HTMLElement>){
    if(disabled||composing.current)return;
    if((e.ctrlKey||e.metaKey)&&!e.altKey){
      const key=e.key.toLowerCase();
      if(['b','i','u'].includes(key)){e.preventDefault();select();const attribute=({b:'bold',i:'italic',u:'underline'} as const)[key as 'b'|'i'|'u'];format({[attribute]:formatted(attribute)?null:true});}
      if(key==='z'||key==='y'){e.preventDefault();if(e.shiftKey||key==='y')onRedo();else onUndo();}
    }
    if(!simple&&e.key==='Enter'){e.preventDefault();insert('\n');}
  }
  return <div className="grid gap-2" data-selection-version={selectionVersion}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">Pertanyaan</span><label className="flex min-h-12 items-center gap-2 text-xs"><input type="checkbox" checked={simple} onChange={e=>setSimple(e.target.checked)}/>Gunakan teks sederhana</label></div>
    {simple?<textarea ref={input} aria-label="Pertanyaan" placeholder="Pertanyaan tanpa judul" value={value} disabled={disabled} onChange={e=>onChange(e.target.value)} onSelect={select} onFocus={select} onKeyDown={keyboard}/>:
      <div ref={host} role="textbox" aria-label="Pertanyaan" aria-multiline="true" aria-readonly={disabled} contentEditable={!disabled} suppressContentEditableWarning tabIndex={0} className="form-rich-editor" data-placeholder="Pertanyaan tanpa judul" onInput={e=>{onChange(editorText(e.currentTarget));select();}} onMouseUp={select} onKeyUp={select} onFocus={select} onKeyDown={keyboard} onBlur={select} onPaste={e=>{e.preventDefault();insert(e.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n'));}} onDrop={e=>{e.preventDefault();}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={e=>{composing.current=false;onChange(editorText(e.currentTarget));setCompositionVersion(n=>n+1);select();}} onBeforeInput={e=>{const type=(e.nativeEvent as InputEvent).inputType;if(type==='historyUndo'||type==='historyRedo'){e.preventDefault();if(type==='historyUndo')onUndo();else onRedo();}if(type==='insertParagraph'||type==='insertLineBreak'){e.preventDefault();insert('\n');}}}/>
    }
    <div className="flex flex-wrap gap-1" aria-label="Format teks pertanyaan">{([['bold','Tebal','B'],['italic','Miring','I'],['underline','Garis bawah','U']] as const).map(([key,label,letter])=><button key={key} className="form-icon border" disabled={disabled||!value} type="button" aria-label={label} aria-pressed={formatted(key)} onMouseDown={e=>e.preventDefault()} onClick={()=>format({[key]:formatted(key)?null:true})}>{letter}</button>)}<button className="form-button secondary" disabled={disabled||!value} type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>format({bold:null,italic:null,underline:null})}>Hapus format</button></div>
    <p className="text-xs text-slate-500">Pilih teks untuk memformatnya. Pintasan: Ctrl/Cmd+B, I, U; undo Ctrl/Cmd+Z.</p>
    {peers.length>0&&<div className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 leading-relaxed" aria-label="Posisi kursor tutor lain"><CursorPreview text={value} parts={parts} peers={peers}/></div>}
  </div>;
}
