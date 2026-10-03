import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react'
import { defaultQuestionConfig, parseConfig, questionStarterPrompt, questionTypes, type QuestionConfig, type QuestionType } from './questionTypes'
import { api, type Session } from './api'
import { ProtectedQuestionMedia, QuestionAnswerControl, StimulusContent } from './QuestionAnswerControl'
import { optimizeQuestionMedia, questionMediaMaxBytes, type QuestionMediaAttachment, type QuestionMediaUpload } from './questionMedia'

type EditorQuestion = {
  id?: string; revision?: number; title?: string; type?: string; prompt?: string; description?: string; configJson?: string; answerJson?: string; rubricJson?: string; stimulusJson?: string; points?: number; status?: string
  grade?: number; program?: string; phase?: string; mode?: string; subject?: string; domain?: string; topic?: string; competency?: string; cognitiveLevel?: string; difficulty?: string; estimatedMinutes?: number; curriculum?: string; tags?: string; folderId?: string; internalExplanation?: string
}
export type QuestionFolder = { id: string; name: string; subject?: string; parentId?: string }
type Draft = EditorQuestion & { title: string; type: QuestionType; prompt: string; description: string; config: QuestionConfig; rubric: { id: string; text: string; points: number }[]; stimulusType: string; stimulusTitle: string; stimulusContent: string; stimulusAssetId: string; stimulusContentType: string; stimulusKind: 'image' | 'audio' | 'video' | ''; table: string[][]; alt: string; points: number; grade: number; program: string; mode: string; subject: string; domain: string; topic: string; competency: string; cognitiveLevel: string; difficulty: string; estimatedMinutes: number; curriculum: string; tags: string; folderId: string; internalExplanation: string }

const inputClass = 'min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-500'
const areaClass = 'min-h-24 w-full rounded-xl border border-slate-300 bg-white p-3 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-sky-500'
const labelClass = 'grid gap-1.5 text-sm font-semibold text-slate-700'
const idFor = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
const suggestedQuestionTags = ['literasi', 'numerasi', 'inferensi', 'pemahaman', 'penalaran', 'AKM', 'TKA', 'mudah', 'sedang', 'menantang']

function cleanTags(raw: string) { return raw.split(',').map((tag) => tag.trim()).filter(Boolean) }
function defaultQuestionMinutes(type: string) { return ['uraian', 'paragraf', 'unggah_berkas'].includes(type) ? 5 : ['susun_urutan', 'menjodohkan', 'kisi_pg', 'kisi_checkbox'].includes(type) ? 3 : 2 }
function folderName(folder: QuestionFolder, folders: QuestionFolder[]) {
  const parent = folders.find((row) => row.id === folder.parentId)
  return [folder.subject || parent?.subject, parent?.name, folder.name].filter((part, index, all) => part && all.indexOf(part) === index).join(' · ')
}

function initialDraft(question?: EditorQuestion): Draft {
  const type = (question?.type && questionTypes.some(([id]) => id === question.type) ? question.type : 'pg_tunggal') as QuestionType
  const config = { ...defaultQuestionConfig(type), ...parseConfig(question?.configJson) }
  const stimulus = (() => { try { return (JSON.parse(question?.stimulusJson || '[]') as Array<{type:string;title?:string;content?:string;alt?:string;assetId?:string;contentType?:string;kind?:'image'|'audio'|'video'}>)[0] } catch { return undefined } })()
  let table = [['Kolom 1', 'Kolom 2'], ['Isi 1', 'Isi 2']]
  if (stimulus?.type === 'table') { try { table = JSON.parse(stimulus.content || '[]') as string[][] } catch { /* Keep a friendly starter grid. */ } }
  const rubricRaw = (() => { try { return JSON.parse(question?.rubricJson || '[]') as Array<{id?:string;text?:string;points?:number}> } catch { return [] } })()
  const stimulusType = stimulus?.assetId ? stimulus.type === 'image' ? 'image_upload' : 'media_upload' : stimulus?.type || ''
  return {
    ...question, title: question?.title || '', type, prompt: question?.prompt || questionStarterPrompt(type), description: question?.description || '', config,
    rubric: rubricRaw.length ? rubricRaw.map((row, index) => ({ id: row.id || `rubrik-${index}`, text: row.text || '', points: Number(row.points || 0) })) : (config.rubrik || []),
    stimulusType, stimulusTitle: stimulus?.title || '', stimulusContent: stimulus?.type === 'table' ? '' : stimulus?.content || '', stimulusAssetId: stimulus?.assetId || '', stimulusContentType: stimulus?.contentType || '', stimulusKind: stimulus?.kind || '', table,
    alt: stimulus?.alt || '', points: question?.points ?? 1, grade: question?.grade || 0, program: question?.program || '', mode: question?.mode || 'akm', subject: question?.subject || '', domain: question?.domain || '', topic: question?.topic || '', competency: question?.competency || '', cognitiveLevel: question?.cognitiveLevel || '', difficulty: question?.difficulty || 'sedang', estimatedMinutes: question?.estimatedMinutes || defaultQuestionMinutes(type), curriculum: question?.curriculum || 'Belum dipetakan', tags: question?.tags || '', folderId: question?.folderId || '', internalExplanation: question?.internalExplanation || '',
}
}

export function QuestionEditor({ initial, mode, busy, storageKey, session, onSave, onCancel, onDelete, folders = [] }: { initial?: EditorQuestion; mode: 'simple' | 'complete'; busy?: boolean; storageKey?: string; session: Session; onSave: (payload: Record<string, unknown>) => Promise<void>; onCancel?: () => void; onDelete?: () => void; folders?: QuestionFolder[] }) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(initial))
  const [usingStarterPrompt, setUsingStarterPrompt] = useState(() => !initial?.prompt?.trim())
  const [showAdvanced, setShowAdvanced] = useState(mode === 'complete')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'recovered' | 'error'>('idle')
  const [edited, setEdited] = useState(false)
  const [previewAnswer, setPreviewAnswer] = useState<unknown>('')
  const [mediaError, setMediaError] = useState('')
  const [newTag, setNewTag] = useState('')
  const autosaveTimer = useRef<number | undefined>(undefined)
  const latestDraft = useRef(draft)
  const committed = useRef(false)
  const change = (key: keyof Draft, value: unknown) => { committed.current = false; setEdited(true); setDraft((current) => ({ ...current, [key]: value })) }
  const updateConfig = (patch: QuestionConfig) => { committed.current = false; setEdited(true); setDraft((current) => ({ ...current, config: { ...current.config, ...patch } })) }
  const normalizedRubric = useMemo(() => draft.rubric.map((row) => ({ id: row.id, text: row.text.trim(), points: Number(row.points) || 0 })).filter((row) => row.text), [draft.rubric])

  async function uploadQuestionMedia(file: File): Promise<QuestionMediaUpload> {
    const body = new FormData()
    body.set('file', file)
    return api<QuestionMediaUpload>('/staff/question-media', { method: 'POST', body }, session)
  }

  function updateStimulusMedia(asset?: QuestionMediaUpload | QuestionMediaAttachment) {
    const id = asset ? ('assetId' in asset ? asset.assetId : asset.id) : ''
    setDraft((current) => ({ ...current, stimulusAssetId: id, stimulusContent: asset?.url || '', stimulusContentType: asset?.contentType || '', stimulusKind: asset?.kind || '' }))
    committed.current = false; setEdited(true); setMediaError('')
  }

  useEffect(() => {
    if (!storageKey) return
    try {
      const recovered = localStorage.getItem(storageKey)
      if (!recovered) return
      const parsed = JSON.parse(recovered) as Partial<Draft>
      setDraft((current) => ({ ...current, ...parsed, config: { ...current.config, ...parsed.config } }))
      const recoveredType = (parsed.type || initial?.type || 'pg_tunggal') as QuestionType
      setUsingStarterPrompt(!parsed.prompt?.trim() || parsed.prompt === questionStarterPrompt(recoveredType))
      setSaveState('recovered')
    } catch {
      localStorage.removeItem(storageKey)
    }
  }, [storageKey])

  useEffect(() => { latestDraft.current = draft }, [draft])
  useEffect(() => () => {
    if (!storageKey || !edited || committed.current) return
    try { localStorage.setItem(storageKey, JSON.stringify(latestDraft.current)) } catch { /* Keep the latest durable copy if browser storage is available. */ }
  }, [edited, storageKey])

  useEffect(() => {
    if (!storageKey || !edited) return
    setSaveState('saving')
    autosaveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(draft))
        setSaveState('saved')
      } catch {
        setSaveState('error')
      }
    }, 2000)
    return () => { if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current) }
  }, [draft, edited, storageKey])

  function setType(type: QuestionType) {
    if (draft.estimatedMinutes === defaultQuestionMinutes(draft.type)) change('estimatedMinutes', defaultQuestionMinutes(type))
    change('type', type)
    const starterConfig = defaultQuestionConfig(type)
    updateConfig(starterConfig)
    if (!draft.prompt.trim() || usingStarterPrompt) {
      change('prompt', questionStarterPrompt(type))
      setUsingStarterPrompt(true)
    }
    change('rubric', type === 'uraian' ? starterConfig.rubrik || [] : [])
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current)
    if ((draft.stimulusType === 'image_upload' || draft.stimulusType === 'media_upload') && !draft.stimulusAssetId) { setMediaError('Unggah bahan pendukung terlebih dahulu sebelum menyimpan soal.'); return }
    const stimulusType = draft.stimulusType === 'image_upload' ? 'image' : draft.stimulusType === 'media_upload' ? 'media' : draft.stimulusType
    const stimulusJson = draft.stimulusType ? JSON.stringify([{ type: stimulusType, title: draft.stimulusTitle.trim(), content: draft.stimulusType === 'table' ? JSON.stringify(draft.table) : draft.stimulusContent.trim(), alt: draft.alt.trim(), ...(draft.stimulusAssetId ? { assetId: draft.stimulusAssetId, contentType: draft.stimulusContentType, kind: draft.stimulusKind } : {}) }]) : ''
    const config = { ...draft.config }
    if (draft.type === 'uraian') config.rubrik = normalizedRubric
    const answer = draft.type === 'isian_singkat' || draft.type === 'tanggal' || draft.type === 'waktu' ? (config.acceptedAnswers || []) : config.correctIds || config.correctOrder || config.pairs || config.gridCorrect || config.gridMultiCorrect || config.correctNumber || null
    const payload = {
      id: draft.id, revision: draft.revision, title: draft.title.trim() || draft.prompt.trim().slice(0, 72), type: draft.type, prompt: draft.prompt.trim(), description: draft.description.trim(), points: Number(draft.points), status: draft.status || 'draft',
    configJson: JSON.stringify(config), answerJson: JSON.stringify(answer), rubricJson: JSON.stringify(normalizedRubric), stimulusJson,
      grade: Number(draft.grade), program: draft.program, phase: draft.phase, mode: draft.mode, subject: draft.subject, domain: draft.domain, topic: draft.topic, competency: draft.competency, cognitiveLevel: draft.cognitiveLevel, difficulty: draft.difficulty, estimatedMinutes: Number(draft.estimatedMinutes), curriculum: draft.curriculum, tags: cleanTags(draft.tags).join(', '), folderId: draft.folderId, internalExplanation: draft.internalExplanation,
    }
    setSaveState('saving')
    try {
      await onSave(payload)
      if (storageKey) localStorage.removeItem(storageKey)
      committed.current = true
      setEdited(false)
      setSaveState('saved')
    } catch {
      if (storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify(draft)) } catch { /* The previously saved local copy remains available. */ }
      }
      setSaveState('error')
    }
  }

  return <form onSubmit={submit} className="space-y-5">
    {storageKey && <p aria-live="polite" className={`text-xs ${saveState === 'error' ? 'text-rose-700' : 'text-slate-600'}`}>{saveState === 'saving' ? 'Menyimpan draf di perangkat ini…' : saveState === 'saved' ? 'Tersimpan otomatis di perangkat ini ✓' : saveState === 'recovered' ? 'Draf lokal dipulihkan. Lanjutkan, lalu simpan ke Bank Soal.' : saveState === 'error' ? 'Draf lokal gagal disimpan. Periksa ruang penyimpanan browser.' : 'Perubahan draf disimpan otomatis setelah berhenti mengetik.'}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={labelClass}>Jenis soal<select aria-label="Jenis soal" className={inputClass} value={draft.type} onChange={(event) => setType(event.target.value as QuestionType)}>{questionTypes.map(([id, title]) => <option value={id} key={id}>{title}</option>)}</select></label>
      <label className={labelClass}>Poin untuk jawaban benar<input className={inputClass} type="number" min="0" step="0.5" value={draft.points} onChange={(event) => change('points', Number(event.target.value))} /></label>
    </div>
    {mediaError && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{mediaError}</p>}
    <details className="rounded-xl border border-slate-200 px-3"><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">Pilih jenis soal dengan kartu (bisa diseret)</summary><div className="grid gap-2 pb-3 sm:grid-cols-2 lg:grid-cols-3" onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-cbt-question-type')) event.preventDefault() }} onDrop={(event) => { const type = event.dataTransfer.getData('application/x-cbt-question-type') as QuestionType; if (questionTypes.some(([id]) => id === type)) setType(type) }}>{questionTypes.map(([id, title]) => <button key={id} type="button" draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-cbt-question-type', id) }} onClick={() => setType(id)} className={`min-h-11 rounded-xl border px-3 text-left text-sm font-medium hover:border-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${draft.type === id ? 'border-sky-600 bg-sky-50 text-sky-900' : 'bg-white'}`}>{title}<span className="ml-1 text-xs text-slate-500">· klik / seret</span></button>)}</div></details>
    <label className={labelClass}>Judul soal (opsional)<input className={inputClass} value={draft.title} onChange={(event) => change('title', event.target.value)} placeholder="Contoh: Membaca jadwal bus" /></label>
    <label className={labelClass}>Pertanyaan<textarea className={areaClass} required value={draft.prompt} onChange={(event) => { setUsingStarterPrompt(false); change('prompt', event.target.value) }} placeholder="Ketik pertanyaan dengan bahasa yang akan dibaca siswa…" />{usingStarterPrompt && <span className="text-xs font-normal text-sky-800">Contoh awal untuk tipe ini — ubah sesuai materi dan tujuan penilaianmu.</span>}</label>
    <label className={labelClass}>Petunjuk tambahan (opsional)<textarea className={areaClass} value={draft.description} onChange={(event) => change('description', event.target.value)} placeholder="Contoh: Pilih semua jawaban yang benar." /></label>

    <section className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4" aria-label="Pengaturan jawaban">
      <div><h3 className="font-bold text-slate-900">Jawaban dan kunci</h3><p className="mt-1 text-sm text-slate-600">Bagian ini hanya terlihat oleh tutor, tidak dikirim sebagai kunci ke siswa.</p></div>
      {['pg_tunggal', 'pg_kompleks', 'dropdown'].includes(draft.type) && <ChoiceEditor type={draft.type} config={draft.config} update={updateConfig} onUploadMedia={uploadQuestionMedia} accessToken={session.accessToken} />}
      {draft.type === 'benar_salah' && <TrueFalseEditor config={draft.config} update={updateConfig} />}
      {draft.type === 'menjodohkan' && <MatchingEditor config={draft.config} update={updateConfig} />}
      {draft.type === 'susun_urutan' && <OrderEditor config={draft.config} update={updateConfig} />}
      {['kisi_pg', 'kisi_checkbox'].includes(draft.type) && <GridEditor type={draft.type} config={draft.config} update={updateConfig} />}
      {['isian_singkat', 'tanggal', 'waktu'].includes(draft.type) && <AcceptedAnswersEditor type={draft.type} config={draft.config} update={updateConfig} />}
      {draft.type === 'uraian' && <RubricEditor rows={draft.rubric} onChange={(rows) => change('rubric', rows)} />}
      {['skala_linear', 'rating'].includes(draft.type) && <ScaleEditor type={draft.type} config={draft.config} update={updateConfig} />}
      {draft.type === 'unggah_berkas' && <UploadEditor config={draft.config} update={updateConfig} />}
    </section>

    <section className="space-y-3 rounded-2xl border border-slate-200 p-4">
      <div><h3 className="font-bold">Bahan pendukung <span className="font-normal text-slate-500">(opsional)</span></h3><p className="text-sm text-slate-600">Tambahkan bacaan, tabel, atau media untuk membantu siswa memahami soal.</p></div>
      <label className={labelClass}>Jenis bahan<select className={inputClass} value={draft.stimulusType} onChange={(event) => { const next = event.target.value; change('stimulusType', next); if (next.endsWith('_upload') || draft.stimulusType.endsWith('_upload')) { change('stimulusAssetId', ''); change('stimulusContentType', ''); change('stimulusKind', ''); change('stimulusContent', '') } }}><option value="">Tidak menggunakan bahan</option><option value="text">Teks bacaan</option><option value="table">Tabel</option><option value="image">Gambar melalui tautan HTTPS</option><option value="image_upload">Gambar dari perangkat</option><option value="media">Tautan video / media HTTPS</option><option value="media_upload">Audio atau video dari perangkat</option></select></label>
      {draft.stimulusType && <>
        <label className={labelClass}>Judul bahan<input className={inputClass} value={draft.stimulusTitle} onChange={(event) => change('stimulusTitle', event.target.value)} placeholder="Judul bacaan atau tabel" /></label>
        {draft.stimulusType === 'table' ? <TableStimulusEditor table={draft.table} onChange={(table) => change('table', table)} /> : draft.stimulusType === 'text' ? <label className={labelClass}>Isi bacaan<textarea className={areaClass} value={draft.stimulusContent} onChange={(event) => change('stimulusContent', event.target.value)} /></label> : draft.stimulusType.endsWith('_upload') ? <MediaDropZone label={draft.stimulusType === 'image_upload' ? 'Seret gambar ke sini atau pilih dari perangkat' : 'Seret audio/video ke sini atau pilih dari perangkat'} accept={draft.stimulusType === 'image_upload' ? 'image/jpeg,image/png,image/webp' : 'audio/mpeg,audio/wav,audio/mp4,video/mp4,video/webm'} media={draft.stimulusAssetId ? { assetId: draft.stimulusAssetId, url: draft.stimulusContent, kind: draft.stimulusKind || 'image', contentType: draft.stimulusContentType, alt: draft.alt } : undefined} accessToken={session.accessToken} onUpload={uploadQuestionMedia} onChange={updateStimulusMedia} onError={setMediaError} /> : <label className={labelClass}>Tautan HTTPS<input className={inputClass} type="url" placeholder="https://…" value={draft.stimulusContent} onChange={(event) => change('stimulusContent', event.target.value)} /></label>}
        {(draft.stimulusType === 'image' || draft.stimulusType === 'image_upload') && <label className={labelClass}>Teks alternatif untuk pembaca layar<input className={inputClass} value={draft.alt} onChange={(event) => change('alt', event.target.value)} placeholder="Jelaskan isi gambar secara singkat" /></label>}
      </>}
    </section>

    <div className="rounded-2xl border border-sky-100 bg-sky-50/50 p-4"><h3 className="font-semibold text-sky-950">Pratinjau tampilan siswa</h3><div className="mt-3 rounded-xl border bg-white p-4"><StimulusContent accessToken={session.accessToken} rows={draft.stimulusType ? [{ type: draft.stimulusType === 'image_upload' ? 'image' : draft.stimulusType === 'media_upload' ? 'media' : draft.stimulusType, title: draft.stimulusTitle, content: draft.stimulusType === 'table' ? JSON.stringify(draft.table) : draft.stimulusContent, alt: draft.alt, ...(draft.stimulusAssetId ? { assetId: draft.stimulusAssetId, contentType: draft.stimulusContentType, kind: draft.stimulusKind } : {}) } as any] : []} /><p className="whitespace-pre-wrap text-lg font-medium text-slate-900">{draft.prompt || 'Pertanyaan akan tampil di sini.'}</p>{draft.description && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{draft.description}</p>}<QuestionAnswerControl question={{ id: draft.id || 'preview-question', title: draft.title || 'Pratinjau pertanyaan', type: draft.type, prompt: draft.prompt, description: draft.description, config: draft.config, points: draft.points }} questionId={`preview-${draft.id || draft.type}`} value={previewAnswer} onChange={setPreviewAnswer} accessToken={session.accessToken} /></div><p className="mt-2 text-xs text-slate-600">{draft.points} poin · {questionTypes.find(([id]) => id === draft.type)?.[1]}</p></div>

    {(mode === 'complete' || showAdvanced) && <details open={mode === 'complete'} className="rounded-2xl border border-slate-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-bold">Standar, jenjang, dan metadata tutor</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className={labelClass}>Program<select className={inputClass} value={draft.program} onChange={(event) => change('program', event.target.value)}><option value="">Pilih program</option><option value="Paket A">Paket A</option><option value="Paket B">Paket B</option><option value="Paket C">Paket C</option></select></label>
      <label className={labelClass}>Kelas<input className={inputClass} type="number" min="1" max="12" value={draft.grade || ''} onChange={(event) => change('grade', Number(event.target.value))} placeholder="Contoh: 6" /></label>
      <label className={labelClass}>Kerangka asesmen<select className={inputClass} value={draft.mode} onChange={(event) => change('mode', event.target.value)}><option value="akm">AKM</option><option value="tka">TKA</option><option value="latihan">Latihan umum</option></select></label>
      <label className={labelClass}>Mata pelajaran / domain<input className={inputClass} value={draft.subject} onChange={(event) => change('subject', event.target.value)} placeholder="Bahasa Indonesia / Matematika" /></label>
      <label className={labelClass}>Topik<input className={inputClass} value={draft.topic} onChange={(event) => change('topic', event.target.value)} /></label>
      <label className={labelClass}>Kompetensi<input className={inputClass} value={draft.competency} onChange={(event) => change('competency', event.target.value)} /></label>
      <label className={labelClass}>Level kognitif<input className={inputClass} value={draft.cognitiveLevel} onChange={(event) => change('cognitiveLevel', event.target.value)} placeholder="Memahami, menerapkan, menalar" /></label>
      <label className={labelClass}>Kesulitan<select className={inputClass} value={draft.difficulty} onChange={(event) => change('difficulty', event.target.value)}><option value="mudah">Mudah</option><option value="sedang">Sedang</option><option value="sulit">Sulit</option></select></label>
      <label className={labelClass}>Estimasi waktu (menit)<input className={inputClass} type="number" min="1" max="180" value={draft.estimatedMinutes} onChange={(event) => change('estimatedMinutes', Number(event.target.value))} /><span className="text-xs font-normal text-slate-500">Perkiraan waktu untuk menjawab satu soal.</span></label>
      <label className={labelClass}>Tag kurikulum / Capaian Pembelajaran<input className={inputClass} value={draft.curriculum} onChange={(event) => change('curriculum', event.target.value)} placeholder="Contoh: CP Matematika Fase C — pecahan" /><span className="text-xs font-normal text-slate-500">Jika belum dipetakan, biarkan nilai bawaan dan lengkapi nanti.</span></label>
      <div className={`${labelClass} sm:col-span-2`}><span>Folder soal <span className="font-normal text-slate-500">(opsional)</span></span><select aria-label="Folder soal" className={inputClass} value={draft.folderId} onChange={(event) => change('folderId', event.target.value)}><option value="">Belum dimasukkan ke folder</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folderName(folder, folders)}</option>)}</select><span className="font-normal text-xs text-slate-500">Kelompokkan berdasarkan mapel dan topik dari Bank Soal.</span></div>
      <div className={`${labelClass} sm:col-span-2`}><span>Tag soal <span className="font-normal text-slate-500">(pilih beberapa)</span></span><div className="flex flex-wrap gap-2">{suggestedQuestionTags.map((tag) => { const selected = cleanTags(draft.tags).some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase()); return <button key={tag} type="button" aria-pressed={selected} onClick={() => { const tags = cleanTags(draft.tags); change('tags', (selected ? tags.filter((value) => value.toLocaleLowerCase() !== tag.toLocaleLowerCase()) : [...tags, tag]).join(', ')) }} className={`min-h-11 rounded-full border px-3 text-sm ${selected ? 'border-sky-700 bg-sky-50 font-bold text-sky-900' : 'border-slate-300 bg-white text-slate-700'}`}>{tag}</button> })}</div><div className="flex gap-2"><input aria-label="Tag tambahan" className={inputClass} value={newTag} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); const value = newTag.trim(); if (value) { const tags = cleanTags(draft.tags); if (!tags.some((tag) => tag.toLocaleLowerCase() === value.toLocaleLowerCase())) change('tags', [...tags, value].join(', ')); setNewTag('') } } }} placeholder="Tag lain, lalu tekan Enter" /><button type="button" className="min-h-11 shrink-0 rounded-xl border px-3 font-semibold" onClick={() => { const value = newTag.trim(); if (!value) return; const tags = cleanTags(draft.tags); if (!tags.some((tag) => tag.toLocaleLowerCase() === value.toLocaleLowerCase())) change('tags', [...tags, value].join(', ')); setNewTag('') }}>Tambah tag</button></div><div className="flex flex-wrap gap-2">{cleanTags(draft.tags).map((tag) => <button key={tag} type="button" className="min-h-11 rounded-full bg-slate-100 px-3 text-sm hover:bg-rose-50" aria-label={`Hapus tag ${tag}`} onClick={() => change('tags', cleanTags(draft.tags).filter((value) => value !== tag).join(', '))}>{tag} ×</button>)}</div></div>
      <label className={`${labelClass} sm:col-span-2`}>Pembahasan internal<textarea className={areaClass} value={draft.internalExplanation} onChange={(event) => change('internalExplanation', event.target.value)} /></label>
    </div></details>}
    {mode === 'simple' && !showAdvanced && <button type="button" className="min-h-11 text-sm font-semibold text-sky-800 underline" onClick={() => setShowAdvanced(true)}>Tampilkan pengaturan lanjutan</button>}
    <div className="flex flex-wrap justify-between gap-2 border-t pt-4">{onDelete ? <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-300 px-4 font-semibold text-rose-800 hover:bg-rose-50" onClick={onDelete}><Trash2 className="size-4"/>Hapus soal</button> : <span/>}<div className="flex flex-wrap justify-end gap-2">{onCancel && <button type="button" className="min-h-11 rounded-xl border border-slate-300 px-4 font-semibold" onClick={onCancel}>Batal</button>}<button type="submit" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-sky-700 px-4 font-semibold text-white hover:bg-sky-800 disabled:opacity-50" disabled={busy || !draft.prompt.trim()}><Save className="size-4" />{busy ? 'Menyimpan…' : initial?.id ? 'Simpan perubahan' : 'Simpan soal'}</button></div></div>
  </form>
}

function ChoiceEditor({ type, config, update, onUploadMedia, accessToken }: { type: string; config: QuestionConfig; update: (value: QuestionConfig) => void; onUploadMedia: (file: File) => Promise<QuestionMediaUpload>; accessToken: string }) {
  const choices = config.choices || []
  const correct: string[] = config.correctIds || []
  function patchChoice(index: number, patch: Record<string, unknown>) { update({ choices: choices.map((row: any, i: number) => i === index ? { ...row, ...patch } : row) }) }
  function moveChoice(from: number, to: number) { if (to < 0 || to >= choices.length) return; const next = [...choices]; const [item] = next.splice(from, 1); next.splice(to, 0, item); update({ choices: next }) }
  return <div className="space-y-2"><p className="text-sm text-slate-600">{type === 'pg_kompleks' ? 'Centang semua pilihan yang benar.' : 'Pilih satu jawaban benar. Seret untuk mengurutkan atau gunakan tombol panah.'}</p>{choices.map((choice: any, index: number) => <div key={choice.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/x-cbt-choice-index', String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData('text/x-cbt-choice-index')); if (Number.isInteger(from)) moveChoice(from, index) }} className="rounded-xl border bg-white p-2"><div className="flex items-center gap-2"><span aria-hidden className="px-1 text-slate-400">⠿</span><input className="size-5 accent-sky-700" type={type === 'pg_kompleks' ? 'checkbox' : 'radio'} checked={correct.includes(choice.id)} aria-label={`Kunci pilihan ${index + 1}`} onChange={() => update({ correctIds: type === 'pg_kompleks' ? correct.includes(choice.id) ? correct.filter((id) => id !== choice.id) : [...correct, choice.id] : [choice.id] })} /><input className={inputClass} value={choice.text} aria-label={`Teks pilihan ${index + 1}`} onChange={(event) => patchChoice(index, { text: event.target.value })} /><button type="button" className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-40" aria-label="Naikkan opsi" disabled={index === 0} onClick={() => moveChoice(index, index - 1)}><ArrowUp className="size-4" /></button><button type="button" className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-40" aria-label="Turunkan opsi" disabled={index === choices.length - 1} onClick={() => moveChoice(index, index + 1)}><ArrowDown className="size-4" /></button><button type="button" className="grid size-11 shrink-0 place-items-center rounded-lg text-rose-700 hover:bg-rose-50 disabled:opacity-40" aria-label={`Hapus pilihan ${index + 1}`} disabled={choices.length <= 2} onClick={() => update({ choices: choices.filter((_: any, i: number) => i !== index), correctIds: correct.filter((id) => id !== choice.id) })}><Trash2 className="size-4" /></button></div><details className="ml-8 mt-2 rounded-lg bg-slate-50 p-2"><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-sky-800">Tambahkan gambar, audio, atau video ke pilihan</summary><MediaDropZone label="Seret media ke sini atau pilih dari perangkat" accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,audio/mp4,video/mp4,video/webm" media={choice.media} accessToken={accessToken} onUpload={onUploadMedia} onChange={(media) => patchChoice(index, { media })} onError={() => undefined} /></details></div>)}<button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm font-semibold" onClick={() => update({ choices: [...choices, { id: idFor('opsi'), text: '' }] })}><Plus className="size-4" /> Tambah pilihan</button></div>
}

function TrueFalseEditor({ config, update }: { config: QuestionConfig; update: (value: QuestionConfig) => void }) {
  const rows = config.statements || []
  return <div className="space-y-2">{rows.map((row: any, index: number) => <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto]" key={row.id}><input className={inputClass} value={row.text} aria-label={`Pernyataan ${index + 1}`} onChange={(event) => update({ statements: rows.map((item: any, i: number) => i === index ? { ...item, text: event.target.value } : item) })} /><select className={inputClass} aria-label={`Kunci pernyataan ${index + 1}`} value={String(row.correct)} onChange={(event) => update({ statements: rows.map((item: any, i: number) => i === index ? { ...item, correct: event.target.value === 'true' } : item) })}><option value="true">Benar</option><option value="false">Salah</option></select><button type="button" className="grid size-11 place-items-center rounded-lg text-rose-700 hover:bg-rose-50" aria-label={`Hapus pernyataan ${index + 1}`} onClick={() => update({ statements: rows.filter((_: any, i: number) => i !== index) })}><Trash2 className="size-4" /></button></div>)}<AddRow label="Tambah pernyataan" onClick={() => update({ statements: [...rows, { id: idFor('pernyataan'), text: '', correct: true }] })} /></div>
}

function MatchingEditor({ config, update }: { config: QuestionConfig; update: (value: QuestionConfig) => void }) {
  const left = config.left || []; const right = config.right || []; const pairs = config.pairs || {}
  const edit = (side: 'left' | 'right', rows: any[]) => update({ [side]: rows })
  return <div className="grid gap-4 md:grid-cols-2">{(['left', 'right'] as const).map((side) => { const rows = side === 'left' ? left : right; return <div className="space-y-2" key={side}><h4 className="font-semibold">{side === 'left' ? 'Pernyataan yang dijodohkan' : 'Pilihan pasangan'}</h4>{rows.map((row: any, index: number) => <div className="flex gap-2" key={row.id}><input className={inputClass} value={row.text} aria-label={`${side === 'left' ? 'Pernyataan' : 'Pasangan'} ${index + 1}`} onChange={(event) => edit(side, rows.map((item: any, i: number) => i === index ? { ...item, text: event.target.value } : item))} /><button type="button" className="grid size-11 shrink-0 place-items-center rounded-lg text-rose-700 hover:bg-rose-50" aria-label="Hapus baris" disabled={rows.length <= 1} onClick={() => edit(side, rows.filter((_: any, i: number) => i !== index))}><Trash2 className="size-4" /></button></div>)}<AddRow label={side === 'left' ? 'Tambah pernyataan' : 'Tambah pasangan'} onClick={() => edit(side, [...rows, { id: idFor(side), text: '' }])} /></div> })}<div className="space-y-2 md:col-span-2"><h4 className="font-semibold">Kunci pasangan</h4>{left.map((row: any, index: number) => <label className="grid gap-2 sm:grid-cols-[1fr_1fr]" key={row.id}><span className="rounded-lg bg-slate-100 p-3 text-sm">{row.text || `Pernyataan ${index + 1}`}</span><select className={inputClass} aria-label={`Pasangan benar untuk ${row.text || `pernyataan ${index + 1}`}`} value={pairs[row.id] || ''} onChange={(event) => update({ pairs: { ...pairs, [row.id]: event.target.value } })}><option value="">Pilih pasangan benar</option>{right.map((option: any) => <option value={option.id} key={option.id}>{option.text || 'Pasangan tanpa teks'}</option>)}</select></label>)}</div></div>
}

function OrderEditor({ config, update }: { config: QuestionConfig; update: (value: QuestionConfig) => void }) {
  const rows = config.choices || []
  function move(index: number, target: number) { const next = [...rows]; const [row] = next.splice(index, 1); next.splice(target, 0, row); update({ choices: next, correctOrder: next.map((item: any) => item.id) }) }
  return <div className="space-y-2"><p className="text-sm text-slate-600">Susun kartu dengan urutan yang benar. Siswa akan melihat urutan yang diacak.</p>{rows.map((row: any, index: number) => <div key={row.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(from) && from !== index) move(from, index) }} className="flex items-center gap-2 rounded-xl border bg-white p-2"><span className="text-xs font-bold text-slate-500">{index + 1}</span><input className={inputClass} value={row.text} aria-label={`Langkah ${index + 1}`} onChange={(event) => update({ choices: rows.map((item: any, i: number) => i === index ? { ...item, text: event.target.value } : item) })} /><button type="button" className="grid size-11 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-40" disabled={index === 0} onClick={() => move(index, index - 1)} aria-label="Naikkan urutan"><ArrowUp className="size-4" /></button><button type="button" className="grid size-11 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-40" disabled={index === rows.length - 1} onClick={() => move(index, index + 1)} aria-label="Turunkan urutan"><ArrowDown className="size-4" /></button></div>)}<AddRow label="Tambah langkah" onClick={() => { const next = [...rows, { id: idFor('langkah'), text: '' }]; update({ choices: next, correctOrder: next.map((item: any) => item.id) }) }} /></div>
}

function GridEditor({ type, config, update }: { type: string; config: QuestionConfig; update: (value: QuestionConfig) => void }) {
  const rows = config.rows || []; const columns = config.columns || []; const multiple = type === 'kisi_checkbox'
  function keyChange(rowId: string, columnId: string, checked: boolean) {
    if (multiple) { const current = config.gridMultiCorrect?.[rowId] || []; const next = checked ? [...current, columnId] : current.filter((id: string) => id !== columnId); update({ gridMultiCorrect: { ...config.gridMultiCorrect, [rowId]: next } }) }
    else update({ gridCorrect: { ...config.gridCorrect, [rowId]: columnId } })
  }
  return <div className="space-y-3"><p className="text-sm text-slate-600">Isi baris dan kolom, lalu pilih kunci untuk tiap baris.</p><div className="grid gap-3 sm:grid-cols-2">{[[rows, 'Baris'], [columns, 'Kolom jawaban']].map(([values, label]) => <div className="space-y-2" key={label as string}><h4 className="font-semibold">{label as string}</h4>{(values as any[]).map((row, index) => <div className="flex gap-2" key={row.id}><input className={inputClass} aria-label={`${label} ${index + 1}`} value={row.text} onChange={(event) => update(label === 'Baris' ? { rows: rows.map((item: any, i: number) => i === index ? { ...item, text: event.target.value } : item) } : { columns: columns.map((item: any, i: number) => i === index ? { ...item, text: event.target.value } : item) })} /><button type="button" className="grid size-11 shrink-0 place-items-center rounded-lg text-rose-700 hover:bg-rose-50" aria-label="Hapus baris atau kolom" disabled={(values as any[]).length <= 1} onClick={() => update(label === 'Baris' ? { rows: rows.filter((_: any, i: number) => i !== index) } : { columns: columns.filter((_: any, i: number) => i !== index) })}><Trash2 className="size-4" /></button></div>)}<AddRow label={`Tambah ${String(label).toLowerCase()}`} onClick={() => update(label === 'Baris' ? { rows: [...rows, { id: idFor('baris'), text: '' }] } : { columns: [...columns, { id: idFor('kolom'), text: '' }] })} /></div>)}</div><div className="overflow-auto rounded-xl border"><table className="min-w-full text-sm"><thead><tr><th className="p-2 text-left">Baris</th>{columns.map((column: any) => <th className="p-2" key={column.id}>{column.text || 'Kolom'}</th>)}</tr></thead><tbody>{rows.map((row: any) => <tr className="border-t" key={row.id}><th className="p-2 text-left">{row.text || 'Baris'}</th>{columns.map((column: any) => <td className="p-2 text-center" key={column.id}><input type={multiple ? 'checkbox' : 'radio'} name={`key-${row.id}`} checked={multiple ? (config.gridMultiCorrect?.[row.id] || []).includes(column.id) : config.gridCorrect?.[row.id] === column.id} onChange={(event) => keyChange(row.id, column.id, event.currentTarget.checked)} aria-label={`Kunci ${row.text}, ${column.text}`} /></td>)}</tr>)}</tbody></table></div></div>
}

function AcceptedAnswersEditor({ type, config, update }: { type: string; config: QuestionConfig; update: (value: QuestionConfig) => void }) { return <div className="space-y-2"><label className={labelClass}>Jawaban yang diterima (satu jawaban per baris)<textarea className={areaClass} value={(config.acceptedAnswers || []).join('\n')} onChange={(event) => update({ acceptedAnswers: event.target.value.split('\n').map((row) => row.trim()).filter(Boolean) })} placeholder={type === 'tanggal' ? '2026-10-01' : type === 'waktu' ? '08:30' : 'Jawaban utama\nJawaban alternatif'} /></label><p className="text-xs text-slate-500">Jawaban singkat dinilai setelah dinormalisasi (huruf besar/kecil, spasi, tanda baca, dan koma desimal).</p></div> }
function RubricEditor({ rows, onChange }: { rows: {id:string;text:string;points:number}[]; onChange: (rows: {id:string;text:string;points:number}[]) => void }) { return <div className="space-y-2"><p className="text-sm text-slate-600">Tambahkan kriteria penilaian yang mudah dipakai saat menilai jawaban siswa.</p>{rows.map((row, index) => <div className="grid gap-2 sm:grid-cols-[1fr_120px_auto]" key={row.id}><input className={inputClass} value={row.text} aria-label={`Kriteria rubrik ${index + 1}`} placeholder="Contoh: Menjelaskan alasan" onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /><label className="flex items-center gap-2 text-sm">Poin<input className={inputClass} type="number" min="0" step="0.5" value={row.points} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, points: Number(event.target.value) } : item))} /></label><button type="button" className="grid size-11 place-items-center rounded-lg text-rose-700 hover:bg-rose-50" aria-label="Hapus kriteria rubrik" onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 className="size-4" /></button></div>)}<AddRow label="Tambah kriteria rubrik" onClick={() => onChange([...rows, { id: idFor('rubrik'), text: '', points: 1 }])} /></div> }
function ScaleEditor({ type, config, update }: { type: string; config: QuestionConfig; update: (value: QuestionConfig) => void }) { const min = type === 'rating' ? 1 : Number(config.scaleMin || 1); const max = type === 'rating' ? Number(config.ratingMax || 5) : Number(config.scaleMax || 5); return <div className="grid gap-3 sm:grid-cols-2"><label className={labelClass}>{type === 'rating' ? 'Jumlah bintang maksimal' : 'Nilai maksimal'}<input className={inputClass} type="number" min="2" max="10" value={max} onChange={(event) => update(type === 'rating' ? { ratingMax: Number(event.target.value) } : { scaleMax: Number(event.target.value) })} /></label><label className={labelClass}>Kunci jawaban<input className={inputClass} type="number" min={min} max={max} value={config.correctNumber ?? max} onChange={(event) => update({ correctNumber: Number(event.target.value) })} /></label>{type === 'skala_linear' && <><label className={labelClass}>Label nilai terendah<input className={inputClass} value={config.scaleMinLabel || ''} onChange={(event) => update({ scaleMinLabel: event.target.value })} /></label><label className={labelClass}>Label nilai tertinggi<input className={inputClass} value={config.scaleMaxLabel || ''} onChange={(event) => update({ scaleMaxLabel: event.target.value })} /></label></>}</div> }
function UploadEditor({ config, update }: { config: QuestionConfig; update: (value: QuestionConfig) => void }) { const allowed = ['pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg']; const selected: string[] = config.allowedFileTypes || []; return <div className="space-y-3"><p className="text-sm text-slate-600">Pilih jenis dan ukuran berkas yang boleh dikirim.</p><div className="flex flex-wrap gap-2">{allowed.map((extension) => <label className="flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm" key={extension}><input type="checkbox" checked={selected.includes(extension)} onChange={(event) => update({ allowedFileTypes: event.target.checked ? [...selected, extension] : selected.filter((item) => item !== extension) })} />.{extension}</label>)}</div><div className="grid gap-3 sm:grid-cols-2"><label className={labelClass}>Jumlah berkas maksimum<input className={inputClass} type="number" min="1" max="10" value={config.maxFiles || 1} onChange={(event) => update({ maxFiles: Number(event.target.value) })} /></label><label className={labelClass}>Ukuran maksimum per berkas (MB)<input className={inputClass} type="number" min="1" max="20" value={config.maxFileSizeMB || 10} onChange={(event) => update({ maxFileSizeMB: Number(event.target.value) })} /></label></div></div> }
function AddRow({ label, onClick }: { label: string; onClick: () => void }) { return <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-slate-400 px-3 text-sm font-semibold hover:bg-white" onClick={onClick}><Plus className="size-4" />{label}</button> }

function MediaDropZone({ label, accept, media, accessToken, onUpload, onChange, onError }: { label: string; accept: string; media?: QuestionMediaAttachment; accessToken: string; onUpload: (file: File) => Promise<QuestionMediaUpload>; onChange: (media: QuestionMediaAttachment | undefined) => void; onError: (error: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function upload(file?: File) {
    if (!file) return
    setBusy(true); setError(''); setStatus('Mengoptimalkan media…'); onError('')
    try {
      const optimized = await optimizeQuestionMedia(file)
      if (optimized.size > questionMediaMaxBytes) throw new Error('Media maksimal 5 MB setelah dioptimalkan.')
      setStatus('Mengunggah media dengan aman…')
      const uploaded = await onUpload(optimized)
      onChange({ assetId: uploaded.id, url: uploaded.url, kind: uploaded.kind, contentType: uploaded.contentType, size: uploaded.size, originalName: uploaded.originalName, alt: media?.alt || '' })
      setStatus(file.size > optimized.size ? `Gambar dioptimalkan: ${(file.size / 1024 / 1024).toFixed(1)} MB → ${(optimized.size / 1024 / 1024).toFixed(1)} MB.` : `Tersimpan: ${uploaded.originalName} · ${(uploaded.size / 1024).toFixed(0)} KB.`)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Media gagal diunggah.'
      setError(message); onError(message); setStatus('')
    } finally { setBusy(false) }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void upload(file) }
  function onDrop(event: DragEvent<HTMLLabelElement>) { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]) }

  return <div className="space-y-2">
    <label onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }} onDrop={onDrop} className={`grid min-h-24 cursor-pointer place-items-center rounded-xl border-2 border-dashed p-4 text-center text-sm font-semibold transition ${dragging ? 'border-sky-600 bg-sky-50 text-sky-900' : 'border-slate-300 bg-white text-slate-700'} ${busy ? 'pointer-events-none opacity-60' : ''}`}>
      <span>{busy ? status : label}<span className="mt-1 block text-xs font-normal text-slate-500">JPG, PNG, WebP, MP3, WAV, M4A, MP4, atau WebM · Maksimal 5 MB</span></span>
      <input className="sr-only" type="file" accept={accept} disabled={busy} aria-label={label} onChange={onFileChange} />
    </label>
    {media && <div className="space-y-2 rounded-xl border bg-white p-3"><ProtectedQuestionMedia media={media} accessToken={accessToken} alt={media.alt || media.originalName || 'Media pilihan'} /><p className="text-xs text-slate-600">{media.originalName || 'Media soal'} · {((media.size || 0) / 1024).toFixed(0)} KB</p>{media.kind === 'image' && <label className={labelClass}>Teks alternatif (wajib untuk gambar)<input className={inputClass} value={media.alt || ''} onChange={(event) => onChange({ ...media, alt: event.target.value })} placeholder="Jelaskan isi gambar secara singkat" /></label>}<button type="button" className="min-h-11 rounded-lg px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50" onClick={() => { onChange(undefined); setStatus('Media dilepas dari soal.'); setError('') }}>Lepas media</button></div>}
    {status && !busy && <p role="status" className="text-xs text-emerald-800">{status}</p>}
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-2 text-sm text-rose-800">{error}</p>}
  </div>
}

function TableStimulusEditor({ table, onChange }: { table: string[][]; onChange: (table: string[][]) => void }) { return <div className="space-y-2"><p className="text-sm font-semibold">Isi tabel secara langsung</p><div className="overflow-auto rounded-xl border"><table className="min-w-full"><tbody>{table.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td className="min-w-36 border p-1" key={`${rowIndex}-${columnIndex}`}><input className="min-h-11 w-full rounded-lg px-2 text-sm focus-visible:ring-2 focus-visible:ring-sky-500" aria-label={`Sel baris ${rowIndex + 1} kolom ${columnIndex + 1}`} value={cell} onChange={(event) => onChange(table.map((current, ri) => current.map((value, ci) => ri === rowIndex && ci === columnIndex ? event.target.value : value)))} /></td>)}</tr>)}</tbody></table></div><div className="flex flex-wrap gap-2"><button type="button" className="min-h-11 rounded-xl border px-3 text-sm" onClick={() => onChange([...table, Array.from({ length: table[0]?.length || 1 }, () => '')])}>Tambah baris</button><button type="button" className="min-h-11 rounded-xl border px-3 text-sm" onClick={() => onChange(table.map((row) => [...row, '']))}>Tambah kolom</button></div></div> }
