import { useEffect, useState, type ChangeEvent } from 'react'
import { ArrowDown, ArrowUp, FileUp, Trash2 } from 'lucide-react'
import type { QuestionConfig } from './questionTypes'
import type { QuestionMediaAttachment } from './questionMedia'

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
    }).then((url) => { objectUrl = url; if (!disposed) setSource(url) }).catch(() => { if (!disposed) setFailed(true) })
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
    if (question.type === 'dropdown') return <label className="grid gap-2"><span className="font-semibold">Pilih satu jawaban</span><select aria-label="Pilih satu jawaban" className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600" value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}><option value="">Pilih jawaban…</option>{choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.text}</option>)}</select></label>
    return <fieldset className="mt-5 space-y-2"><legend className="mb-2 font-semibold">Pilih satu jawaban</legend>{choices.map((choice, index) => <label key={choice.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input className="size-5 accent-sky-700" type="radio" name={questionId} checked={value === choice.id} onChange={() => onChange(choice.id)} /><span><b className="mr-2">{String.fromCharCode(65 + index)}.</b>{choice.text}<ChoiceMedia media={choice.media} accessToken={accessToken} alt={`Media pilihan ${index + 1}`} /></span></label>)}</fieldset>
  }
  if (question.type === 'pg_kompleks') {
    const selected: string[] = Array.isArray(value) ? value as string[] : []
    return <fieldset className="mt-5 space-y-2"><legend className="mb-2 font-semibold">Pilih semua jawaban yang benar</legend>{choices.map((choice) => <label key={choice.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input className="size-5 accent-sky-700" type="checkbox" checked={selected.includes(choice.id)} onChange={() => onChange(selected.includes(choice.id) ? selected.filter((id) => id !== choice.id) : [...selected, choice.id])} /><span>{choice.text}<ChoiceMedia media={choice.media} accessToken={accessToken} alt={`Media pilihan ${choice.text}`} /></span></label>)}</fieldset>
  }
  if (question.type === 'benar_salah') {
    const answers = (value && typeof value === 'object' ? value : {}) as Record<string, boolean>
    return <div className="mt-5 overflow-x-auto rounded-xl border"><table className="min-w-full"><thead className="bg-slate-100"><tr><th className="p-3 text-left">Pernyataan</th><th className="p-3 text-center">Benar</th><th className="p-3 text-center">Salah</th></tr></thead><tbody>{(config.statements || []).map((row: any) => <tr key={row.id} className="border-t"><th scope="row" className="min-w-52 p-3 text-left font-medium">{row.text}<ChoiceMedia media={row.media} accessToken={accessToken} alt={`Media pernyataan ${row.text}`} /></th>{[true, false].map((answer) => <td className="p-3 text-center" key={String(answer)}><input aria-label={`${row.text}: ${answer ? 'Benar' : 'Salah'}`} className="size-5 accent-sky-700" type="radio" name={`${questionId}-${row.id}`} checked={answers[row.id] === answer} onChange={() => onChange({ ...answers, [row.id]: answer })} /></td>)}</tr>)}</tbody></table></div>
  }
  if (question.type === 'menjodohkan') {
    const answers = (value && typeof value === 'object' ? value : {}) as Record<string, string>
    return <div className="mt-5 space-y-3">{(config.left || []).map((row: any, index: number) => <label className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_1fr] sm:items-center" key={row.id}><span><b className="mr-2 text-sky-800">{index + 1}.</b>{row.text}<ChoiceMedia media={row.media} accessToken={accessToken} alt={`Media pernyataan ${row.text}`} /></span><div className="space-y-2">{(config.right || []).some((option: any) => option.media) && <div className="grid gap-2">{(config.right || []).map((option: any) => <div key={option.id} className="flex items-center gap-2 text-sm"><span className="font-semibold">{option.text}</span><ChoiceMedia media={option.media} accessToken={accessToken} alt={`Media pasangan ${option.text}`} /></div>)}</div>}<select className="min-h-11 w-full rounded-lg border px-3" aria-label={`Pilih pasangan untuk ${row.text}`} value={answers[row.id] || ''} onChange={(event) => onChange({ ...answers, [row.id]: event.target.value })}><option value="">Pilih pasangan…</option>{(config.right || []).map((option: any) => <option value={option.id} key={option.id}>{option.text}</option>)}</select></div></label>)}</div>
  }
  if (question.type === 'susun_urutan') {
    const ordered: string[] = Array.isArray(value) && (value as string[]).length ? value as string[] : choices.map((choice) => choice.id)
    function move(index: number, target: number) { const next = [...ordered]; const [item] = next.splice(index, 1); next.splice(target, 0, item); onChange(next) }
    return <div className="mt-5 space-y-2"><p className="text-sm text-slate-600">Seret untuk mengurutkan, atau gunakan tombol panah.</p>{ordered.map((id, index) => { const choice = choices.find((row) => row.id === id); if (!choice) return null; return <div key={id} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData('text/plain')); if (from !== index) move(from, index) }} className="flex min-h-12 items-center gap-2 rounded-xl border bg-white p-2"><span className="min-w-6 text-center font-bold text-sky-800">{index + 1}.</span><span className="flex-1">{choice.text}<ChoiceMedia media={choice.media} accessToken={accessToken} alt={`Media langkah ${index + 1}`} /></span><button type="button" className="grid size-11 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-40" disabled={index === 0} aria-label="Pindahkan ke atas" onClick={() => move(index, index - 1)}><ArrowUp className="size-4" /></button><button type="button" className="grid size-11 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-40" disabled={index === ordered.length - 1} aria-label="Pindahkan ke bawah" onClick={() => move(index, index + 1)}><ArrowDown className="size-4" /></button></div>})}</div>
  }
  if (question.type === 'kisi_pg' || question.type === 'kisi_checkbox') {
    const answers = (value && typeof value === 'object' ? value : {}) as Record<string, string | string[]>
    const multiple = question.type === 'kisi_checkbox'
    return <div className="mt-5 overflow-x-auto rounded-xl border"><table className="min-w-full"><thead className="bg-slate-100"><tr><th className="min-w-40 p-3 text-left">Pernyataan</th>{(config.columns || []).map((column: any) => <th className="min-w-24 p-3 text-center" key={column.id}>{column.text}<ChoiceMedia media={column.media} accessToken={accessToken} alt={`Media kolom ${column.text}`} /></th>)}</tr></thead><tbody>{(config.rows || []).map((row: any) => <tr key={row.id} className="border-t"><th scope="row" className="p-3 text-left">{row.text}<ChoiceMedia media={row.media} accessToken={accessToken} alt={`Media baris ${row.text}`} /></th>{(config.columns || []).map((column: any) => { const current = answers[row.id]; const checked = multiple ? Array.isArray(current) && current.includes(column.id) : current === column.id; return <td key={column.id} className="p-3 text-center"><input className="size-5 accent-sky-700" type={multiple ? 'checkbox' : 'radio'} name={`${questionId}-${row.id}`} checked={checked} aria-label={`${row.text}: ${column.text}`} onChange={() => { if (multiple) { const prior = Array.isArray(current) ? current : []; onChange({ ...answers, [row.id]: checked ? prior.filter((id) => id !== column.id) : [...prior, column.id] }) } else onChange({ ...answers, [row.id]: column.id }) }} /></td>})}</tr>)}</tbody></table></div>
  }
  if (question.type === 'skala_linear' || question.type === 'rating') {
    const min = question.type === 'rating' ? 1 : Number(config.scaleMin || 1)
    const max = question.type === 'rating' ? Number(config.ratingMax || 5) : Number(config.scaleMax || 5)
    return <div className="mt-5 space-y-2"><div className="flex justify-between gap-2 text-sm text-slate-600"><span>{config.scaleMinLabel || ''}</span><span>{config.scaleMaxLabel || ''}</span></div><div role="radiogroup" aria-label="Pilih nilai" className="flex flex-wrap gap-2">{Array.from({ length: Math.max(0, Math.min(11, max - min + 1)) }, (_, index) => min + index).map((n) => <button type="button" role="radio" aria-checked={Number(value) === n} aria-label={`Nilai ${n}`} key={n} className={`min-h-12 min-w-12 rounded-xl border px-3 font-semibold ${Number(value) === n ? 'border-sky-700 bg-sky-50 text-sky-900' : 'bg-white'}`} onClick={() => onChange(n)}>{question.type === 'rating' ? '★'.repeat(n) : n}</button>)}</div></div>
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
