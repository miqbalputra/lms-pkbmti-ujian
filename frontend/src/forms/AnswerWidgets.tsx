import { useLayoutEffect, useRef, useState } from 'react';
import type { QuestionConfig } from '../questionTypes';
import { SortableList } from './SortableList';
import { ProtectedQuestionMedia } from '../QuestionAnswerControl';
import type { QuestionMediaAttachment } from '../questionMedia';
import './answer-widgets.css';
import {useStudentUx} from '../studentUx';

type Row = {id:string;text:string;media?:QuestionMediaAttachment};
function Media({row,accessToken}:{row:Row;accessToken?:string}){return row.media?<ProtectedQuestionMedia media={row.media} alt={row.media.alt||row.text} accessToken={accessToken} presentation="option"/>:null;}
export function OrderingAnswer({choices,value,onChange,accessToken,readOnly=false}:{choices:Row[];value:unknown;onChange:(value:unknown)=>void;accessToken?:string;readOnly?:boolean}) {
  const ids = Array.isArray(value)&&value.length?value as string[]:choices.map(row=>row.id);
  const rows=ids.map(id=>choices.find(row=>row.id===id)).filter((row):row is Row=>Boolean(row));
  if(readOnly)return <div className="mt-5 space-y-3">{Array.isArray(value)&&value.length?rows.map((row,index)=><div key={row.id} className="rounded-xl border p-3"><b>{index+1}.</b> {row.text}<Media row={row} accessToken={accessToken}/></div>):<p>Belum dijawab.</p>}</div>;
  return <div className="mt-5 space-y-3"><p>Seret pegangan, gunakan spasi dan panah, atau tombol pindah. Urutan baru akan tersimpan otomatis.</p>
    <SortableList items={rows} onOrder={next=>onChange(next.map(row=>row.id))} render={(row,index)=><div className="rounded-b-xl border bg-white p-4"><b className="mr-3">{index+1}.</b>{row.text}<Media row={row} accessToken={accessToken}/></div>}/>
    {(!Array.isArray(value)||!value.length)&&<button className="form-button secondary" onClick={()=>onChange(ids)}>Gunakan urutan yang tampil</button>}
  </div>;
}

export function MatrixAnswer({config,questionId,value,onChange,type,accessToken,readOnly=false}:{config:QuestionConfig;questionId:string;value:unknown;onChange:(value:unknown)=>void;type:string;accessToken?:string;readOnly?:boolean}) {
  const rows:Row[]=type==='benar_salah'?config.statements||[]:config.rows||[];
  const columns:Row[]=type==='benar_salah'?[{id:'true',text:'Benar'},{id:'false',text:'Salah'}]:config.columns||[];
  const answers=(value&&typeof value==='object'?value:{}) as Record<string,unknown>;
  const multi=type==='kisi_checkbox';
  function control(row:Row,col:Row,suffix:string) {
    const expected=type==='benar_salah'?col.id==='true':col.id,current=answers[row.id];
    const checked=multi?Array.isArray(current)&&current.includes(expected):current===expected;
    return <label className="matrix-target"><input disabled={readOnly} className="size-5 accent-sky-700" type={multi?'checkbox':'radio'} name={`${questionId}-${suffix}-${row.id}`} aria-label={`${row.text}: ${col.text}`} checked={checked} onChange={()=>{
      const prior=Array.isArray(current)?current:[];
      onChange({...answers,[row.id]:multi?checked?prior.filter(id=>id!==expected):[...prior,expected]:expected});
    }}/><span className="matrix-choice-label">{col.text}</span></label>;
  }
  return <div className="mt-5">
    <div className="matrix-desktop"><table><thead><tr><th scope="col">Pernyataan</th>{columns.map(col=><th key={col.id} scope="col">{col.text}<Media row={col} accessToken={accessToken}/></th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.id}><th scope="row">{row.text}<Media row={row} accessToken={accessToken}/></th>{columns.map(col=><td key={col.id}>{control(row,col,'desktop')}</td>)}</tr>)}</tbody></table></div>
    <div className="matrix-mobile">{rows.map(row=><fieldset className="rounded-xl border p-4" key={row.id}><legend className="px-1 font-semibold">{row.text}</legend><Media row={row} accessToken={accessToken}/><div className="grid gap-2">{columns.map(col=><div key={col.id}>{control(row,col,'mobile')}<Media row={col} accessToken={accessToken}/></div>)}</div></fieldset>)}</div>
  </div>;
}

export function MatchingAnswer({config,value,onChange,accessToken,readOnly=false}:{config:QuestionConfig;value:unknown;onChange:(value:unknown)=>void;accessToken?:string;readOnly?:boolean}) {
  const ux=useStudentUx();
  const left:Row[]=config.left||[],right:Row[]=config.right||[];
  const answers=(value&&typeof value==='object'?value:{}) as Record<string,string>;
  const [selected,setSelected]=useState(''),[lines,setLines]=useState<Array<{id:string;x1:number;y1:number;x2:number;y2:number}>>([]);
  const container=useRef<HTMLDivElement>(null), nodes=useRef(new Map<string,HTMLButtonElement>());
  useLayoutEffect(()=>{
    const root=container.current;if(!root)return;
    const update=()=>{
      const box=root.getBoundingClientRect();
      setLines(Object.entries(answers).flatMap(([id,target])=>{
        const a=nodes.current.get(`left:${id}`)?.getBoundingClientRect(),b=nodes.current.get(`right:${target}`)?.getBoundingClientRect();
        return a&&b?[{id,x1:a.right-box.left,y1:a.top+a.height/2-box.top,x2:b.left-box.left,y2:b.top+b.height/2-box.top}]:[];
      }));
    };
    update();const observer=new ResizeObserver(update);observer.observe(root);window.addEventListener('resize',update);
    return()=>{observer.disconnect();window.removeEventListener('resize',update)};
  },[JSON.stringify(answers),JSON.stringify(left),JSON.stringify(right)]);
  function remove(id:string){const next={...answers};delete next[id];onChange(next)}
  return <div className="mt-5 space-y-4">
    {!readOnly&&<p className="text-sm">{ux.enabled?<><span className="student-matching-desktop-help">Pilih pernyataan kiri, lalu pasangan kanan. </span>Pilih pasangan melalui daftar pilihan untuk menggunakan sentuhan atau keyboard.</>:'Pilih pernyataan kiri, lalu pasangan kanan. Kamu juga dapat memakai daftar pilihan di bawah.'}</p>}
    <div ref={container} className="matching-visual">
      <svg aria-hidden className="matching-lines">{lines.map(line=><line key={line.id} {...line} stroke="#326698" strokeWidth="2"/>)}</svg>
      <div className="grid content-start gap-2"><h3 className="font-semibold">Pernyataan</h3>{left.map((row,index)=><div className="matching-card-wrap" key={row.id}><button disabled={readOnly} ref={node=>{if(node)nodes.current.set(`left:${row.id}`,node);else nodes.current.delete(`left:${row.id}`)}} className={`matching-card ${selected===row.id?'selected':''} ${answers[row.id]?'paired':''}`} aria-pressed={selected===row.id} aria-label={`Pilih pernyataan ${row.text}`} onClick={()=>setSelected(row.id)}><b>{index+1}.</b> {row.text}{answers[row.id]&&<span className="sr-only">Sudah dipasangkan</span>}</button>{ux.enabled&&<Media row={row} accessToken={accessToken}/>}</div>)}</div>
      <div className="grid content-start gap-2"><h3 className="font-semibold">Pasangan</h3>{right.map(row=><div className="matching-card-wrap" key={row.id}><button ref={node=>{if(node)nodes.current.set(`right:${row.id}`,node);else nodes.current.delete(`right:${row.id}`)}} className={`matching-card ${Object.values(answers).includes(row.id)?'paired':''}`} disabled={readOnly||!selected} aria-label={`Pasangkan dengan ${row.text}`} onClick={()=>{onChange({...answers,[selected]:row.id});setSelected('')}}>{row.text}</button>{ux.enabled&&<Media row={row} accessToken={accessToken}/>}</div>)}</div>
    </div>
    <div className="grid gap-3" aria-label="Alternatif pasangan sentuh dan keyboard">{left.map(row=><div className="grid gap-2 rounded-xl border p-3 sm:grid-cols-2" key={row.id}><span className="font-semibold">{row.text}</span><span className="flex min-w-0 gap-2"><select disabled={readOnly} className="min-h-12 min-w-0 flex-1 rounded-lg border px-3" aria-label={`Pilih pasangan untuk ${row.text}`} value={answers[row.id]||''} onChange={e=>e.target.value?onChange({...answers,[row.id]:e.target.value}):remove(row.id)}><option value="">Pilih pasangan…</option>{right.map(option=><option key={option.id} value={option.id}>{option.text}</option>)}</select></span>{ux.enabled&&<Media row={row} accessToken={accessToken}/>} {ux.enabled&&answers[row.id]&&right.filter(r=>r.id===answers[row.id]).map(paired=><div key={paired.id}><b>Pasangan: {paired.text}</b><Media row={paired} accessToken={accessToken}/></div>)}</div>)}</div>
    {ux.enabled?<div className="student-matching-options space-y-3">{right.some(row=>row.media)&&<h3 className="font-semibold">Gambar pilihan pasangan</h3>}{right.filter(row=>row.media).map(row=><div key={row.id} className="rounded-lg border p-3"><b>{row.text}</b><Media row={row} accessToken={accessToken}/></div>)}</div>:[...left,...right].filter(row=>row.media).map(row=><div key={row.id} className="rounded-lg border p-3"><b>{row.text}</b><Media row={row} accessToken={accessToken}/></div>)}
  </div>;
}
