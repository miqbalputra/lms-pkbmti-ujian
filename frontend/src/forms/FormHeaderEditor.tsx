import { useEffect, useRef, useState } from 'react';
import { api, type Session } from '../api';
import { optimizeQuestionMedia } from '../questionMedia';
import { ProtectedQuestionMedia } from '../QuestionAnswerControl';
import type { FormHeaderImage } from './types';

export function FormHeaderEditor({value,onChange,session,disabled,onUploadBusy}:{value?:FormHeaderImage|null;onChange:(value:FormHeaderImage|null)=>void;session:Session;disabled:boolean;onUploadBusy:(change:number)=>void}) {
  const [alt,setAlt]=useState(value?.alt||''),[uploading,setUploading]=useState(false),[error,setError]=useState('');
  const latest=useRef({value,disabled,alt});latest.current={value,disabled,alt};
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
  useEffect(()=>{setAlt(value?.alt||'')},[value?.alt]);
  async function upload(file:File){
    const previous=latest.current.value?.assetId;
    setUploading(true);setError('');onUploadBusy(1);
    try {
      if(!navigator.onLine)throw new Error('Unggah header memerlukan koneksi internet.');
      if(!/^image\/(png|jpeg|webp)$/.test(file.type))throw new Error('Pilih gambar JPG, PNG, atau WebP.');
      const safe=await optimizeQuestionMedia(file),body=new FormData();body.set('file',safe);
      const media=await api<{id:string;kind:string}>('/staff/question-media',{method:'POST',body},session);
      if(!mounted.current)return;
      if(media.kind!=='image')throw new Error('Header harus berupa gambar.');
      if(latest.current.disabled||latest.current.value?.assetId!==previous)throw new Error('Header atau izin editor berubah saat unggahan berlangsung. Gambar tidak menimpa perubahan tersebut.');
      onChange({assetId:media.id,alt:latest.current.alt});
    } catch(e){if(mounted.current)setError((e as Error).message)}finally{if(mounted.current)setUploading(false);onUploadBusy(-1)}
  }
  return <section aria-label="Gambar header formulir" className="grid gap-3 rounded-xl border p-3">
    <h3 className="font-semibold">Gambar header</h3>
    <p className="text-sm">Opsional. Gambar tidak menutupi nama sekolah atau kontrol ujian. Unggahan tetap privat.</p>
    {value&&<div className="form-header-image"><ProtectedQuestionMedia media={{assetId:value.assetId,kind:'image'}} accessToken={session.accessToken} alt={value.alt||'Pratinjau gambar header'}/></div>}
    <label className="form-field">Unggah gambar header<input type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled||uploading} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value=''}}/></label>
    <label className="form-field">Teks alternatif header<input maxLength={1000} disabled={disabled} value={alt} placeholder="Jelaskan isi gambar" onChange={e=>{setAlt(e.target.value);if(value)onChange({...value,alt:e.target.value})}}/></label>
    {value&&<button className="form-button secondary" disabled={disabled||uploading} onClick={()=>onChange(null)}>Hapus gambar header</button>}
    {uploading&&<p role="status">Mengunggah header… Pratinjau dan publikasi menunggu unggahan selesai.</p>}
    {error&&<p role="alert" className="text-rose-800">{error}</p>}
  </section>;
}
