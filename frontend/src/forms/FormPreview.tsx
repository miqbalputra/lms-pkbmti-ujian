import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type Session } from "../api";
import type { StudentQuestion } from "../QuestionAnswerControl";
import { TkaExamPlayer } from "./TkaExamPlayer";
import type { FormHeaderImage } from './types';

type Preview = {title:string; items:StudentQuestion[]; activeItemIds:string[]; themeColor:string; font:string; progressBar:boolean; confirmationMessage:string;headerImage?:FormHeaderImage|null};
export function FormPreview({kind,id,session}:{kind:string;id:string;session:Session}) {
  const [data,setData]=useState<Preview|null>(null), [error,setError]=useState(""), [answers,setAnswers]=useState<Record<string,unknown>>({}), [marked,setMarked]=useState<string[]>([]), [done,setDone]=useState(false);
  const [params,setParams]=useSearchParams(), sequence=useRef(0);
  const [prefillURL,setPrefillURL]=useState(''),[sharing,setSharing]=useState(false);
  async function prefill(){setSharing(true);try{const row=await api<{url:string}>(`/staff/forms/${kind}/${id}/links`,{method:'POST',body:JSON.stringify({prefill:answers})},session);setPrefillURL(row.url);setError('')}catch(e){setError((e as Error).message)}finally{setSharing(false)}}
  const all=params.get("jalur")==="semua";
  useEffect(()=>{
    const request=++sequence.current;
    void api<Preview>(`/staff/forms/${kind}/${id}/preview`,{method:"POST",body:JSON.stringify({answers})},session).then(v=>{if(sequence.current===request){setData(v);setError("")}}).catch(e=>{if(sequence.current===request)setError(e.message)});
  },[kind,id,session.accessToken,answers]);
  const items=(data?.items||[]).filter(q=>all||data?.activeItemIds.includes(q.id)).map(q=>({id:q.id,question:q,flagged:marked.includes(q.id),answer:JSON.stringify(answers[q.id]??"")}));
  const index=Math.max(0,Math.min(items.length-1,(Number(params.get("soal"))||1)-1));
  const setIndex=(n:number)=>{const next=new URLSearchParams(params);next.set("soal",String(n+1));setParams(next)};
  const note=<div className="tka-preview-note"><p>Pratinjau — jawaban di layar ini tidak disimpan sebagai percobaan atau nilai siswa.</p><label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={all} onChange={e=>{const next=new URLSearchParams(params);next.set("jalur",e.target.checked?"semua":"siswa");next.set("soal","1");setParams(next)}}/>Tampilkan semua soal untuk memeriksa seluruh cabang</label>{kind==='assessment'&&<button className="form-button secondary" disabled={sharing} onClick={()=>void prefill()}>Buat tautan isian awal</button>}{prefillURL&&<label className="form-field">Tautan isian awal — siswa tetap login dan dapat mengganti jawaban<input readOnly value={prefillURL} onFocus={e=>e.target.select()}/></label>}{error&&<p role="alert">{error}</p>}</div>;
  if(!data||!items.length||done)return <main className="tka-shell"><section className="form-card mx-auto mt-8 max-w-xl">{note}<p role="status">{done ? data?.confirmationMessage||"Jawaban pratinjau selesai." : data ? "Belum ada pertanyaan. Tambahkan soal di editor." : "Memuat soal…"}</p>{done&&<button className="form-button" onClick={()=>{setDone(false);setAnswers({});setIndex(0)}}>Ulangi pratinjau</button>}</section></main>;
  return <TkaExamPlayer headerImage={data.headerImage} title={data.title} student="Pratinjau tutor" items={items} index={index} onIndex={setIndex} onAnswer={(item,value)=>setAnswers(v=>({...v,[item.id]:value}))} onFlag={item=>setMarked(v=>v.includes(item.id)?v.filter(id=>id!==item.id):[...v,item.id])} onSubmit={async()=>{setDone(true);return true}} timeText="--:--:--" remaining={Infinity} saveState="saved" queueCount={0} accessToken={session.accessToken} notice={note} preview themeColor={data.themeColor} formFont={data.font} progressBar={data.progressBar} onFileUpload={async()=>{throw new Error("Berkas hanya dapat diunggah saat percobaan siswa nyata, bukan di pratinjau.")}} onFileRemove={async()=>{}} onFileDownload={()=>{}}/>;
}
