import { lazy, Suspense, useEffect, useState, type ChangeEvent } from 'react'
import { FileUp, Trash2 } from 'lucide-react'
import type { QuestionConfig } from './questionTypes'
import type { QuestionMediaAttachment } from './questionMedia'

const MatchingAnswer = lazy(() => import('./forms/AnswerWidgets').then((module) => ({ default: module.MatchingAnswer })))
const MatrixAnswer = lazy(() => import('./forms/AnswerWidgets').then((module) => ({ default: module.MatrixAnswer })))
const OrderingAnswer = lazy(() => import('./forms/AnswerWidgets').then((module) => ({ default: module.OrderingAnswer })))
const answerLoading = <p role="status" className="p-3 text-slate-600">Memuat kontrol jawaban…</p>

export type StudentQuestion = { id: string; title: string; type: string; prompt: string; description?: string; config?: QuestionConfig; stimulus?: Stimulus[]; points: number }
export type Stimulus = { type: 'text' | 'table' | 'image' | 'media'; title?: string; content?: string; alt?: string; assetId?: string; contentType?: string; kind?: 'image' | 'audio' | 'video' }
export type AnswerFile = { id: string; name: string; size: number; contentType?: string }

export function StimulusContent({ rows, accessToken }: { rows?: Stimulus[]; accessToken?: string }) {
  if (!rows?.length) return null
  return <section className="mb-5 space-y-3 rounded-2xl border border-sky-100 bg-sky-50/60 p-4" aria-label="Bahan pendukung">
    {rows.map((row, index) => <div key={`${row.type}-${index}`}>
      {row.title && <h3 className="mb-2 font-bold text-slate-800">{row.title}</h3>}
      {row.type === 'text' && <p className="whitespace-pre-wrap leading-relaxed">{row.content}</p>}
      {row.type === 'image' && <ProtectedQuestionMedia media={row} accessToken={accessToken} alt={row.alt || 'Gambar bahan soal'} />}
      {row.type === 'media' && (row.assetId ? <ProtectedQuestionMedia media={row} accessToken={accessToken} alt={row.title || 'Media pendukung soal'} /> : <a href={row.content} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-xl border border-sky-200 bg-white px-3 font-semibold text-sky-800 underline">Buka media pendukung di tab baru</a>)}
      {row.type === 'table' && <StimulusTable content={row.content || '[]'} />}
    </div>)}
  </section>
}

export function ProtectedQuestionMedia({ media, accessToken, alt }: { media: Partial<QuestionMediaAttachment> & { content?: string }; accessToken?: string; alt: string }) {
  const [source, setSource] = useState(media.assetId ? '' : media.url || media.content || '')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    let objectUrl = ''
    if (!media.assetId) { setSource(media.url || media.content || ''); setFailed(false); return }
    setSource(''); setFailed(false)
    if (!accessToken) { setFailed(true); return }
    void fetch(`/api/question-media/${encodeURIComponent(media.assetId)}`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Media tidak tersedia untuk sesi ini.')
      return URL.createObjectURL(await response.blob())
    }).then((url) => { objectUrl = url; if (!disposed) setSource(url); else URL.revokeObjectURL(url) }).catch(() => { if (!disposed) setFailed(true) })
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [media.assetId, media.content, media.url, accessToken])
  if (failed) return <p role="status" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">Media tidak dapat dimuat. Periksa koneksi atau unggah ulang bahan ini.</p>
  if (!source) return <p role="status" className="text-sm text-slate-500">Memuat media…</p>
  const contentType = media.contentType || ''
  if (contentType.startsWith('audio/') || media.kind === 'audio') return <audio controls preload="metadata" src={source} className="w-full max-w-2xl">Browser tidak dapat memutar audio ini.</audio>
  if (contentType.startsWith('video/') || media.kind === 'video') return <video controls preload="metadata" src={source} className="max-h-[28rem] w-full max-w-3xl rounded-xl border bg-black">Browser tidak dapat memutar video ini.</video>
  return <img src={source} alt={alt} className="max-h-[28rem] max-w-full rounded-xl border bg-white object-contain" loading="lazy" />
}

function ChoiceMedia({ media, accessToken, alt }: { media?: QuestionMediaAttachment; accessToken?: string; alt: string }) {
  return media ? <ProtectedQuestionMedia media={media} accessToken={accessToken} alt={media.alt || alt} /> : null
}

function StimulusTable({ content }: { content: string }) {
  let rows: string[][] = []
  try { rows = JSON.parse(content) as string[][] } catch { rows = content.split('\n').map((line) => line.split('\t')) }
  if (!Array.isArray(rows)) return <p className="text-sm text-slate-600">Tabel tidak dapat ditampilkan.</p>
  return <div className="overflow-x-auto rounded-xl border bg-white"><table className="min-w-full border-collapse text-sm"><tbody>{rows.map((row, index) => <tr key={index} className={index === 0 ? 'bg-slate-100 font-semibold' : ''}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border-b border-r px-3 py-2 last:border-r-0">{cell}</td>)}</tr>)}</tbody></table></div>
}

export function QuestionAnswerControl({ question, questionId, value, onChange, onFileUpload, onFileRemove, onFileDownload, accessToken }: {
  question: StudentQuestion; questionId: string; value: unknown; onChange: (value: unknown) => void
  onFileUpload?: (file: File) => Promise<AnswerFile>; onFileRemove?: (fileId: string) => Promise<void>; onFileDownload?: (fileId: string, name: string) => void
  accessToken?: string
}) {
  const config = question.config || {}
  const choices: Array<{ id: string; text: string; media?: QuestionMediaAttachment }> = config.choices || []
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  if (question.type === 'pg_tunggal' || question.type === 'dropdown') {
    if (question.type === 'dropdown') return <div className="grid gap-3"><label className="grid gap-2"><span className="font-semibold">Pilih satu jawaban</span><select aria-label="Pilih satu jawaban" className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 focus-visible:ring-2 focus-visible:ring-sky-600" value={typeof value==='string'?value.startsWith('__other__:')?'__other__':value:''} onChange={e=>onChange(e.target.value==='__other__'?'__other__:':e.target.value)}><option value="">Pilih jawaban…</option>{choices.map(choice=><option key={choice.id} value={choice.id}>{choice.text}</option>)}{config.otherOption&&<option value="__other__">Lainnya…</option>}</select></label>{typeof value==='string'&&value.startsWith('__other__:')&&<label className="grid gap-2">Jawaban lainnya<input aria-label="Jawaban lainnya" className="min-h-12 rounded-xl border px-3" value={value.slice(10)} onChange={e=>onChange(`__other__:${e.target.value}`)}/></label>}</div>
    return <fieldset className="mt-5 space-y-2"><legend className="mb-2 font-semibold">Pilih satu jawaban</legend>{choices.map((choice, index) => <label key={choice.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input className="size-5 accent-sky-700" type="radio" name={questionId} checked={value === choice.id} onChange={() => onChange(choice.id)} /><span><b className="mr-2">{String.fromCharCode(65 + index)}.</b>{choice.text}<ChoiceMedia media={choice.media} accessToken={accessToken} alt={`Media pilihan ${index + 1}`} /></span></label>)}{config.otherOption&&<OtherResponse checked={typeof value==='string'&&value.startsWith('__other__:')} text={typeof value==='string'?value.replace(/^__other__:/,''):''} onSelect={()=>onChange('__other__:')} onText={text=>onChange(`__other__:${text}`)}/>}</fieldset>
  }
  if (question.type === 'pg_kompleks') {
    const selected: string[] = Array.isArray(value) ? value as string[] : []
    return <fieldset className="mt-5 space-y-2"><legend className="mb-2 font-semibold">Pilih semua jawaban yang benar</legend>{choices.map((choice) => <label key={choice.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input className="size-5 accent-sky-700" type="checkbox" checked={selected.includes(choice.id)} onChange={() => onChange(selected.includes(choice.id) ? selected.filter((id) => id !== choice.id) : [...selected, choice.id])} /><span>{choice.text}<ChoiceMedia media={choice.media} accessToken={accessToken} alt={`Media pilihan ${choice.text}`} /></span></label>)}{config.otherOption&&<OtherResponse multi checked={selected.some(v=>v.startsWith('__other__:'))} text={selected.find(v=>v.startsWith('__other__:'))?.replace(/^__other__:/,'')||''} onSelect={()=>onChange(selected.some(v=>v.startsWith('__other__:'))?selected.filter(v=>!v.startsWith('__other__:')):[...selected,'__other__:'])} onText={text=>onChange([...selected.filter(v=>!v.startsWith('__other__:')),`__other__:${text}`])}/>}</fieldset>
  }
  if (question.type === 'benar_salah') return <Suspense fallback={answerLoading}><MatrixAnswer accessToken={accessToken} config={config} type={question.type} questionId={questionId} value={value} onChange={onChange}/></Suspense>
  if (question.type === 'menjodohkan') return <Suspense fallback={answerLoading}><MatchingAnswer accessToken={accessToken} config={config} value={value} onChange={onChange}/></Suspense>
  if (question.type === 'susun_urutan') return <Suspense fallback={answerLoading}><OrderingAnswer accessToken={accessToken} choices={choices} value={value} onChange={onChange}/></Suspense>
  if (question.type === 'kisi_pg' || question.type === 'kisi_checkbox') return <Suspense fallback={answerLoading}><MatrixAnswer accessToken={accessToken} config={config} type={question.type} questionId={questionId} value={value} onChange={onChange}/></Suspense>
  if (question.type === 'skala_linear' || question.type === 'rating') {
    const min = question.type === 'rating' ? 1 : Number(config.scaleMin ?? 1)
    const max = question.type === 'rating' ? Number(config.ratingMax || 5) : Number(config.scaleMax || 5)
    const selected = value !== '' && value !== null && value !== undefined ? Number(value) : null
    return <div className="mt-5 space-y-2"><div className="flex justify-between gap-2 text-sm text-slate-600"><span>{config.scaleMinLabel || ''}</span><span>{config.scaleMaxLabel || ''}</span></div><div role="radiogroup" aria-label="Pilih nilai" className="flex flex-wrap gap-2">{Array.from({ length: Math.max(0, Math.min(11, max - min + 1)) }, (_, index) => min + index).map((n) => <button type="button" role="radio" aria-checked={selected === n} aria-label={`Nilai ${n}`} key={n} className={`min-h-12 min-w-12 rounded-xl border px-3 font-semibold ${selected === n ? 'border-sky-700 bg-sky-50 text-sky-900' : 'bg-white'}`} onClick={() => onChange(n)}>{question.type === 'rating' ? '★'.repeat(n) : n}</button>)}</div></div>
  }
  if (question.type === 'unggah_berkas') {
    const files: AnswerFile[] = Array.isArray(value) ? value as AnswerFile[] : []
    const allowed: string[] = config.allowedFileTypes || ['pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg']
    const maxFiles = Number(config.maxFiles || 1); const maxMB = Number(config.maxFileSizeMB || 10)
    async function upload(event: ChangeEvent<HTMLInputElement>) {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''
      if (!file) return
      if (!allowed.includes(file.name.split('.').pop()?.toLowerCase() || '')) { setUploadError(`Format berkas yang dipilih tidak diizinkan. Pilih: ${allowed.join(', ')}.`); return }
      if (file.size > maxMB * 1024 * 1024) { setUploadError(`Ukuran berkas maksimal ${maxMB} MB.`); return }
      if (!onFileUpload) { setUploadError('Unggahan tidak tersedia. Periksa koneksi lalu coba kembali.'); return }
      setUploading(true); setUploadError('')
      try { onChange([...files, await onFileUpload(file)]) } catch (error) { setUploadError(error instanceof Error ? error.message : 'Berkas gagal diunggah.') } finally { setUploading(false) }
    }
    return <div className="mt-5 space-y-3"><label className={`flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-center font-semibold text-sky-800 ${files.length >= maxFiles || uploading ? 'opacity-50' : ''}`}><FileUp className="size-5" />{uploading ? 'Mengunggah…' : 'Pilih berkas jawaban'}<input className="sr-only" type="file" accept={allowed.map((ext) => `.${ext}`).join(',')} disabled={files.length >= maxFiles || uploading} onChange={(event) => void upload(event)} /></label><p className="text-xs text-slate-500">Format {allowed.join(', ')} · Maksimal {maxFiles} berkas · {maxMB} MB per berkas</p>{uploadError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{uploadError}</p>}{files.map((file) => <div className="flex items-center gap-2 rounded-xl border p-2 text-sm" key={file.id}><button type="button" className="min-h-11 min-w-0 flex-1 truncate text-left font-semibold text-sky-800 underline" onClick={() => onFileDownload?.(file.id, file.name)}>{file.name} · {(file.size / 1024).toFixed(0)} KB</button>{onFileRemove && <button type="button" className="grid size-11 place-items-center rounded-lg text-rose-700 hover:bg-rose-50" aria-label={`Hapus ${file.name}`} onClick={() => void onFileRemove(file.id).then(() => onChange(files.filter((row) => row.id !== file.id))).catch((error) => setUploadError(error instanceof Error ? error.message : 'Gagal menghapus berkas'))}><Trash2 className="size-4" /></button>}</div>)}</div>
  }

  const text = typeof value === 'string' ? value : ''
  const inputType = question.type === 'tanggal' ? 'date' : question.type === 'waktu' ? 'time' : 'text'
  const minLength = Number(config.textMinLength || 0); const maxLength = Number(config.textMaxLength || 0)
  return <div className="mt-5 space-y-2">{question.type === 'uraian' ? <><label className="font-semibold" htmlFor={`${questionId}-answer`}>Jawaban uraian</label><textarea id={`${questionId}-answer`} className="min-h-40 w-full rounded-xl border border-slate-300 p-3 leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600" maxLength={maxLength || undefined} value={text} onChange={(event) => onChange(event.target.value)} placeholder="Tuliskan jawabanmu dengan jelas…" /></> : <><label className="font-semibold" htmlFor={`${questionId}-answer`}>{question.type === 'tanggal' ? 'Pilih tanggal' : question.type === 'waktu' ? 'Pilih waktu' : 'Jawaban singkat'}</label><input id={`${questionId}-answer`} type={inputType} className="min-h-12 w-full rounded-xl border border-slate-300 px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600" minLength={minLength || undefined} maxLength={maxLength || undefined} value={text} onChange={(event) => onChange(event.target.value)} placeholder="Ketik jawabanmu…" /></>}{minLength > 0 && <p className="text-xs text-slate-500">Minimal {minLength} karakter.</p>}{maxLength > 0 && <p className="text-right text-xs text-slate-500">{Array.from(text).length}/{maxLength} karakter</p>}</div>
}

function OtherResponse({checked,text,onSelect,onText,multi=false}:{checked:boolean;text:string;onSelect:()=>void;onText:(text:string)=>void;multi?:boolean}) {
  return <div className="grid gap-2 rounded-xl border p-3"><label className="flex min-h-12 items-center gap-3"><input type={multi?'checkbox':'radio'} className="size-5" checked={checked} onChange={onSelect}/>Lainnya…</label>{checked&&<label className="grid gap-2">Jawaban lainnya<input aria-label="Jawaban lainnya" className="min-h-12 rounded-lg border px-3" maxLength={1900} value={text} onChange={e=>onText(e.target.value)}/></label>}</div>
}
