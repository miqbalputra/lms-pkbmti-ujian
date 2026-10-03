import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Copy, Edit3, Plus, Send, Trash2 } from 'lucide-react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, type Session } from './api'
import { QuestionEditor } from './QuestionEditor'

type Question = {
  id: string; revision?: number; packageId?: string; packagePosition?: number; title: string; type: string; prompt: string; description?: string; configJson?: string; answerJson?: string; rubricJson?: string; stimulusJson?: string; points: number; status: string; subject?: string; grade?: number; tags?: string; templatePlaceholder?: boolean; [key: string]: unknown
}
type PackageAssignment = { id: string; packageId: string; targetType: 'class' | 'student'; targetId: string; classId?: string; studentId?: string }
type QuestionPackage = { id: string; ownerId: string; title: string; description?: string; subject?: string; status: 'draft' | 'published' | 'archived'; createdAt: string; updatedAt: string; questionCount?: number; assignmentCount?: number; classIds?: string[]; studentIds?: string[] }
type PackageDetail = QuestionPackage & { questions: Question[]; assignments: PackageAssignment[] }
type Kelas = { id: string; nama: string; jenjang: number; active?: boolean }
type Student = { id: string; nama: string; nisn: string; kelasId: string; active?: boolean }
type Notice = (value: { kind: 'ok' | 'error'; text: string } | null) => void

const packageTabs = [
  ['all', 'Semua paket'],
  ['draft', 'Draf'],
  ['published', 'Diterbitkan'],
] as const

function packagePath(id: string, suffix = '') { return `/soal/paket/${encodeURIComponent(id)}${suffix}` }

function packageTargetSummary(row: QuestionPackage, classNames: Map<string, string>, studentNames: Map<string, string>) {
  const targets = [
    ...(row.classIds || []).map((id) => classNames.get(id) || id),
    ...(row.studentIds || []).map((id) => studentNames.get(id) || id),
  ]
  if (targets.length === 0) return 'Belum ditetapkan'
  return `${targets.slice(0, 2).join(' · ')}${targets.length > 2 ? ` +${targets.length - 2}` : ''}`
}

function packageQuery(search: string) {
  const input = new URLSearchParams(search)
  const output = new URLSearchParams()
  for (const key of ['tab', 'q']) {
    const value = input.get(key)
    if (value) output.set(key === 'q' ? 'search' : key, value)
  }
  for (const [source, target] of [['mapel', 'subject'], ['kelas', 'classId'], ['dari', 'createdFrom'], ['sampai', 'createdTo']] as const) {
    const value = input.get(source)
    if (value) output.set(target, value)
  }
  return output.toString()
}

export function QuestionPackages({ session, notify }: { session: Session; notify: Notice }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const routeMatch = location.pathname.match(/^\/soal\/paket\/([^/]+)(?:\/(edit|penugasan))?\/?$/)
  const packageId = routeMatch ? decodeURIComponent(routeMatch[1]) : ''
  const view = routeMatch?.[2] || 'detail'
  const [packages, setPackages] = useState<QuestionPackage[]>([])
  const [packageData, setPackageData] = useState<PackageDetail | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [classes, setClasses] = useState<Kelas[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [subject, setSubject] = useState('')
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<string[]>([])
  const [questionSearch, setQuestionSearch] = useState('')
  const [questionEditorOpen, setQuestionEditorOpen] = useState(false)
  const [editingQuestion, setEditingQuestion] = useState<Question | undefined>()
  const [assignmentScope, setAssignmentScope] = useState<'class' | 'student'>('class')
  const [classIds, setClassIds] = useState<string[]>([])
  const [studentIds, setStudentIds] = useState<string[]>([])
  const [studentClassFilter, setStudentClassFilter] = useState('')
  const [studentSearch, setStudentSearch] = useState('')
  const dragID = useRef('')
  const canWrite = session.user.role !== 'kepala_sekolah'
  const packageListURL = `/staff/question-packages${packageQuery(location.search) ? `?${packageQuery(location.search)}` : ''}`

  useEffect(() => {
    let active = true
    setLoading(true)
    const master = Promise.all([
      api<Kelas[]>('/staff/master/classes', {}, session).catch(() => [] as Kelas[]),
      api<Student[]>('/staff/master/students', {}, session).catch(() => [] as Student[]),
    ]).then(([classPayload, studentPayload]) => {
      if (!active) return
      setClasses(Array.isArray(classPayload) ? classPayload : [])
      setStudents(Array.isArray(studentPayload) ? studentPayload : [])
    })
    if (packageId) {
      const detail = api<PackageDetail>(`/staff/question-packages/${encodeURIComponent(packageId)}`, {}, session).then((row) => {
        if (!active) return
        setPackageData(row)
        setTitle(row.title)
        setDescription(row.description || '')
        setSubject(row.subject || '')
        setSelectedQuestionIds(row.questions.map((question) => question.id))
        const assignedClasses = row.assignments.filter((item) => item.targetType === 'class').map((item) => item.targetId)
        const assignedStudents = row.assignments.filter((item) => item.targetType === 'student').map((item) => item.targetId)
        setAssignmentScope(assignedStudents.length ? 'student' : 'class')
        setClassIds(assignedClasses)
        setStudentIds(assignedStudents)
      })
      const questionRows = view === 'edit' ? api<unknown>('/staff/questions', {}, session).then((rows) => { if (active) setQuestions(Array.isArray(rows) ? rows as Question[] : []) }) : Promise.resolve()
      void Promise.all([detail, master, questionRows]).catch((error) => { if (active) notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket soal belum dapat dimuat.' }) }).finally(() => { if (active) setLoading(false) })
    } else {
      setPackageData(null)
      setSelectedQuestionIds([])
      void Promise.all([
        api<unknown>(packageListURL, {}, session).then((rows) => { if (active) setPackages(Array.isArray(rows) ? rows as QuestionPackage[] : []) }),
        master,
      ]).catch((error) => { if (active) notify({ kind: 'error', text: error instanceof Error ? error.message : 'Daftar paket soal belum dapat dimuat.' }) }).finally(() => { if (active) setLoading(false) })
    }
    return () => { active = false }
  }, [packageId, view, packageListURL, session.accessToken, notify])

  const subjects = useMemo(() => [...new Set(packages.map((row) => row.subject?.trim()).filter((row): row is string => Boolean(row)))].sort((a, b) => a.localeCompare(b, 'id')), [packages])
  const listClassNames = new Map(classes.map((row) => [row.id, row.nama]))
  const listStudentNames = new Map(students.map((row) => [row.id, row.nama]))
  const availableQuestions = useMemo(() => questions
    .filter((question) => !question.packageId || question.packageId === packageId)
    .filter((question) => `${question.title} ${question.prompt} ${question.subject || ''} ${question.tags || ''}`.toLowerCase().includes(questionSearch.trim().toLowerCase())), [questions, packageId, questionSearch])
  const selectedQuestions = useMemo(() => selectedQuestionIds.map((id) => questions.find((row) => row.id === id) || packageData?.questions.find((row) => row.id === id)).filter((row): row is Question => Boolean(row)), [selectedQuestionIds, questions, packageData])

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next, { replace: true })
  }

  async function createPackage() {
    if (!canWrite) return
    setSaving(true)
    try {
      const created = await api<QuestionPackage>('/staff/question-packages', { method: 'POST', body: JSON.stringify({ title: 'Paket soal tanpa judul' }) }, session)
      notify({ kind: 'ok', text: 'Paket soal dibuat sebagai draf. Tambahkan soal dan targetnya.' })
      navigate(packagePath(created.id, '/edit'))
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket soal gagal dibuat.' }) }
    finally { setSaving(false) }
  }

  async function savePackage(event?: FormEvent) {
    event?.preventDefault()
    if (!packageData || !canWrite) return
    setSaving(true)
    try {
      await api<QuestionPackage>(`/staff/question-packages/${encodeURIComponent(packageData.id)}`, { method: 'PUT', body: JSON.stringify({ title, description, subject, questionIds: selectedQuestionIds }) }, session)
      notify({ kind: 'ok', text: 'Paket dan urutan soal berhasil disimpan.' })
      setQuestionEditorOpen(false)
      setEditingQuestion(undefined)
      navigate(packagePath(packageData.id))
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket soal gagal disimpan.' }) }
    finally { setSaving(false) }
  }

  async function saveQuestion(payload: Record<string, unknown>) {
    if (!packageData) return
    setSaving(true)
    try {
      let nextSelection = [...selectedQuestionIds]
      const questionID = typeof payload.id === 'string' ? payload.id : ''
      const { id: _id, ...body } = payload
      if (questionID) {
        await api(`/staff/questions/${encodeURIComponent(questionID)}`, { method: 'PUT', body: JSON.stringify(body) }, session)
      } else {
        const created = await api<Question>(`/staff/question-packages/${encodeURIComponent(packageData.id)}/questions`, { method: 'POST', body: JSON.stringify(body) }, session)
        nextSelection = [...nextSelection, created.id]
      }
      const [detail, questionRows] = await Promise.all([
        api<PackageDetail>(`/staff/question-packages/${encodeURIComponent(packageData.id)}`, {}, session),
        api<Question[]>('/staff/questions', {}, session),
      ])
      setPackageData(detail)
      setQuestions(questionRows)
      setSelectedQuestionIds(nextSelection)
      setQuestionEditorOpen(false)
      setEditingQuestion(undefined)
      notify({ kind: 'ok', text: questionID ? 'Perubahan soal tersimpan.' : 'Soal baru tersimpan di dalam paket.' })
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Soal gagal disimpan.' }); throw error }
    finally { setSaving(false) }
  }

  async function saveAssignments() {
    if (!packageData || !canWrite) return
    setSaving(true)
    try {
      const result = await api<PackageDetail>(`/staff/question-packages/${encodeURIComponent(packageData.id)}/assignments`, {
        method: 'PUT',
        body: JSON.stringify({ classIds: assignmentScope === 'class' ? classIds : [], studentIds: assignmentScope === 'student' ? studentIds : [] }),
      }, session)
      setPackageData(result)
      notify({ kind: 'ok', text: 'Target penugasan paket berhasil disimpan.' })
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Penugasan paket gagal disimpan.' }) }
    finally { setSaving(false) }
  }

  async function publishPackage() {
    if (!packageData || !canWrite) return
    if (!window.confirm('Terbitkan paket ini? Soal draf di dalamnya akan dikunci sebagai soal terbit.')) return
    setSaving(true)
    try {
      const result = await api<PackageDetail>(`/staff/question-packages/${encodeURIComponent(packageData.id)}/publish`, { method: 'POST' }, session)
      setPackageData(result)
      notify({ kind: 'ok', text: 'Paket soal berhasil diterbitkan.' })
      navigate(packagePath(packageData.id))
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket soal belum dapat diterbitkan.' }) }
    finally { setSaving(false) }
  }

  async function duplicatePackage() {
    if (!packageData) return
    setSaving(true)
    try {
      const copy = await api<PackageDetail>(`/staff/question-packages/${encodeURIComponent(packageData.id)}/duplicate`, { method: 'POST' }, session)
      notify({ kind: 'ok', text: 'Salinan draf dibuat. Target penugasan harus dipilih ulang.' })
      navigate(packagePath(copy.id, '/edit'))
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket belum dapat diduplikasi.' }) }
    finally { setSaving(false) }
  }

  async function archivePackage() {
    if (!packageData || !window.confirm(`Arsipkan paket “${packageData.title}”? Soal di dalamnya tidak dihapus.`)) return
    setSaving(true)
    try {
      await api(`/staff/question-packages/${encodeURIComponent(packageData.id)}/archive`, { method: 'POST' }, session)
      notify({ kind: 'ok', text: 'Paket diarsipkan. Semua butir soal tetap aman di Bank Soal.' })
      navigate('/soal?tab=all')
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket belum dapat diarsipkan.' }) }
    finally { setSaving(false) }
  }

  async function unarchivePackage() {
    if (!packageData) return
    setSaving(true)
    try {
      await api(`/staff/question-packages/${encodeURIComponent(packageData.id)}/unarchive`, { method: 'POST' }, session)
      notify({ kind: 'ok', text: 'Paket dipulihkan sebagai draf.' })
      const updated = await api<PackageDetail>(`/staff/question-packages/${encodeURIComponent(packageData.id)}`, {}, session)
      setPackageData(updated)
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket gagal dipulihkan.' }) }
    finally { setSaving(false) }
  }

  function moveQuestion(index: number, next: number) {
    if (next < 0 || next >= selectedQuestionIds.length) return
    setSelectedQuestionIds((current) => {
      const reordered = [...current]
      const [item] = reordered.splice(index, 1)
      reordered.splice(next, 0, item)
      return reordered
    })
  }

  function reorderDragged(targetID: string) {
    const sourceID = dragID.current
    dragID.current = ''
    if (!sourceID || sourceID === targetID) return
    setSelectedQuestionIds((current) => {
      const next = [...current]
      const sourceIndex = next.indexOf(sourceID)
      const targetIndex = next.indexOf(targetID)
      if (sourceIndex < 0 || targetIndex < 0) return current
      next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, sourceID)
      return next
    })
  }

  function editQuestion(question?: Question) {
    setEditingQuestion(question)
    setQuestionEditorOpen(true)
  }

  if (!packageId) {
    const tab = searchParams.get('tab') || 'all'
    const selectedClass = searchParams.get('kelas') || ''
    const selectedSubject = searchParams.get('mapel') || ''
    return <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-bold uppercase tracking-wider text-brand">Bank Soal</p><h2 className="text-2xl font-bold">Paket Soal</h2><p className="mt-1 max-w-3xl text-sm text-slate-600">Kelola soal per paket: isi butir, susun urutan, tentukan target kelas atau siswa, lalu bagikan tautan detail.</p></div><div className="flex flex-wrap gap-2">{canWrite && <button type="button" disabled={saving} onClick={() => void createPackage()} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-white disabled:opacity-50"><Plus className="size-4"/>Buat paket soal</button>}<Link to="/soal?tab=questions" className="inline-flex min-h-11 items-center rounded-xl border bg-white px-4 font-semibold text-slate-700">Pustaka soal lepas</Link></div></div>
      <section className="rounded-2xl border bg-white p-4 shadow-sm" aria-label="Pencarian dan filter paket soal"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><label className="grid gap-1 text-sm font-semibold sm:col-span-2 xl:col-span-1">Cari paket<input aria-label="Cari nama paket" className="min-h-11 rounded-xl border px-3 font-normal" value={searchParams.get('q') || ''} onChange={(event) => setFilter('q', event.target.value)} placeholder="Nama paket atau deskripsi"/></label><label className="grid gap-1 text-sm font-semibold">Mata pelajaran<select aria-label="Filter mata pelajaran paket" className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={selectedSubject} onChange={(event) => setFilter('mapel', event.target.value)}><option value="">Semua mapel</option>{subjects.map((name) => <option key={name}>{name}</option>)}</select></label><label className="grid gap-1 text-sm font-semibold">Kelas target<select aria-label="Filter kelas paket" className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={selectedClass} onChange={(event) => setFilter('kelas', event.target.value)}><option value="">Semua kelas</option>{classes.map((row) => <option key={row.id} value={row.id}>{row.nama}</option>)}</select></label><label className="grid gap-1 text-sm font-semibold">Dibuat dari<input aria-label="Filter dibuat dari" type="date" className="min-h-11 rounded-xl border px-3 font-normal" value={searchParams.get('dari') || ''} onChange={(event) => setFilter('dari', event.target.value)}/></label><label className="grid gap-1 text-sm font-semibold">Sampai<input aria-label="Filter dibuat sampai" type="date" className="min-h-11 rounded-xl border px-3 font-normal" value={searchParams.get('sampai') || ''} onChange={(event) => setFilter('sampai', event.target.value)}/></label></div><div className="mt-4 flex flex-wrap gap-2 border-t pt-3" aria-label="Status paket">{packageTabs.map(([value, label]) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setFilter('tab', value)} className={`min-h-10 rounded-full px-4 text-sm font-semibold ${tab === value ? 'bg-brand text-white' : 'border bg-white text-slate-700'}`}>{label}</button>)}<button type="button" aria-pressed={tab === 'archived'} onClick={() => setFilter('tab', 'archived')} className={`min-h-10 rounded-full px-4 text-sm font-semibold ${tab === 'archived' ? 'bg-brand text-white' : 'border bg-white text-slate-700'}`}>Arsip</button></div></section>
      {loading ? <div role="status" className="rounded-2xl border bg-white p-8 text-center text-slate-500">Memuat paket soal…</div> : packages.length === 0 ? <section className="rounded-2xl border border-dashed bg-white p-8 text-center"><h3 className="font-bold">Belum ada paket soal</h3><p className="mt-1 text-sm text-slate-600">Buat satu paket, lalu tambahkan butir dari pustaka atau tulis soal baru.</p>{canWrite && <button type="button" onClick={() => void createPackage()} className="mt-4 min-h-11 rounded-xl bg-brand px-4 font-semibold text-white"><Plus className="mr-2 inline size-4"/>Buat paket soal</button>}</section> : <div className="grid gap-3 md:grid-cols-2">{packages.map((row) => <article key={row.id} className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><Link to={packagePath(row.id)} className="break-words text-lg font-bold text-slate-900 hover:text-brand">{row.title}</Link><p className="mt-1 line-clamp-2 text-sm text-slate-600">{row.description || 'Belum ada deskripsi.'}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${row.status === 'published' ? 'bg-emerald-50 text-emerald-800' : row.status === 'archived' ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-900'}`}>{row.status === 'published' ? 'Diterbitkan' : row.status === 'archived' ? 'Arsip' : 'Draf'}</span></div><div className="flex flex-wrap gap-2 text-xs text-slate-600"><span className="rounded-full bg-sky-50 px-2.5 py-1">{row.subject || 'Mapel belum diisi'}</span><span className="rounded-full bg-slate-100 px-2.5 py-1">{row.questionCount || 0} soal</span><span className="rounded-full bg-slate-100 px-2.5 py-1" title={packageTargetSummary(row, listClassNames, listStudentNames)}>{row.assignmentCount || 0} target · {packageTargetSummary(row, listClassNames, listStudentNames)}</span><span className="rounded-full bg-slate-100 px-2.5 py-1">Dibuat {new Date(row.createdAt).toLocaleDateString('id-ID')}</span></div><div className="mt-auto flex flex-wrap gap-2 border-t pt-3"><Link className="inline-flex min-h-10 items-center rounded-lg bg-slate-100 px-3 text-sm font-semibold" to={packagePath(row.id)}>Detail paket</Link>{row.status !== 'archived' && <><Link className="inline-flex min-h-10 items-center rounded-lg border px-3 text-sm font-semibold" to={packagePath(row.id, '/edit')}>Edit paket</Link><Link className="inline-flex min-h-10 items-center rounded-lg border px-3 text-sm font-semibold" to={packagePath(row.id, '/penugasan')}>Penugasan</Link></>}</div></article>)}</div>}
    </div>
  }

  const classNames = new Map(classes.map((row) => [row.id, row.nama]))
  const studentNames = new Map(students.map((row) => [row.id, row.nama]))
  if (loading) return <div role="status" className="rounded-2xl border bg-white p-8 text-center text-slate-500">Memuat detail paket…</div>
  if (!packageData) return <section className="rounded-2xl border bg-white p-6"><h2 className="text-xl font-bold">Paket tidak ditemukan</h2><p className="mt-2 text-sm text-slate-600">Tautan mungkin sudah tidak berlaku atau paket tidak termasuk kewenangan akun ini.</p><Link to="/soal" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-semibold text-white">Kembali ke daftar paket</Link></section>

  const classTargetIDs = packageData.assignments.filter((row) => row.targetType === 'class').map((row) => row.targetId)
  const studentTargetIDs = packageData.assignments.filter((row) => row.targetType === 'student').map((row) => row.targetId)
  const assignmentLabel = classTargetIDs.length ? classTargetIDs.map((id) => classNames.get(id) || id).join(', ') : studentTargetIDs.length ? studentTargetIDs.map((id) => studentNames.get(id) || id).join(', ') : 'Belum ada target penugasan'
  const availableStudents = students.filter((row) => (!studentClassFilter || row.kelasId === studentClassFilter) && `${row.nama} ${row.nisn}`.toLowerCase().includes(studentSearch.toLowerCase()))

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white p-3 shadow-sm"><div className="flex min-w-0 flex-wrap items-center gap-2"><Link to="/soal" className="inline-flex min-h-11 items-center rounded-xl border px-3 font-semibold">← Paket Soal</Link><div className="min-w-0"><p className="truncate font-bold">{packageData.title}</p><p className="text-xs text-slate-500">{view === 'edit' ? 'Edit isi dan urutan paket' : view === 'penugasan' ? 'Target kelas atau siswa' : 'Detail paket soal'}</p></div></div><div className="flex flex-wrap gap-2">{view !== 'edit' && packageData.status !== 'archived' && <Link to={packagePath(packageId, '/edit')} className="inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 font-semibold"><Edit3 className="size-4"/>Edit</Link>}{view !== 'penugasan' && <Link to={packagePath(packageId, '/penugasan')} className="inline-flex min-h-11 items-center rounded-xl border px-3 font-semibold">Penugasan</Link>}</div></div>

    {view === 'detail' && <>
      <section className="rounded-2xl border bg-white p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">{packageData.subject || 'Mata pelajaran belum diisi'} · {packageData.status === 'published' ? 'Diterbitkan' : packageData.status === 'archived' ? 'Arsip' : 'Draf'}</p><h2 className="mt-1 text-2xl font-bold">{packageData.title}</h2><p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-slate-600">{packageData.description || 'Belum ada deskripsi untuk paket ini.'}</p></div><div className="flex flex-wrap gap-2">{canWrite && packageData.status !== 'archived' && packageData.questions.length > 0 && <><Link to={`/ujian?paket=${encodeURIComponent(packageId)}&jenis=ujian_online`} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-white">Buat Ujian Online</Link><Link to={`/ujian?paket=${encodeURIComponent(packageId)}&jenis=simulasi`} className="inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 font-semibold">Buat Simulasi</Link></>}{canWrite && packageData.status === 'draft' && <button type="button" disabled={saving} onClick={() => void publishPackage()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 font-semibold"><Send className="size-4"/>Terbitkan paket</button>}{canWrite && <button type="button" disabled={saving} onClick={() => void duplicatePackage()} className="min-h-11 rounded-xl border px-3 font-semibold">Duplikasi</button>}{canWrite && packageData.status === 'archived' && <button type="button" disabled={saving} onClick={() => void unarchivePackage()} className="min-h-11 rounded-xl border px-3 font-semibold">Pulihkan dari arsip</button>}{canWrite && packageData.status !== 'archived' && <button type="button" disabled={saving} onClick={() => void archivePackage()} className="min-h-11 rounded-xl border px-3 font-semibold text-rose-700">Arsipkan</button>}<button type="button" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}${packagePath(packageId)}`).then(() => notify({ kind: 'ok', text: 'Tautan detail paket disalin.' })).catch(() => notify({ kind: 'error', text: 'Tautan tidak dapat disalin otomatis. Salin URL dari bilah alamat.' })) }} className="inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 font-semibold"><Copy className="size-4"/>Salin tautan</button></div></div><div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-3"><div><p className="text-xs text-slate-500">Jumlah soal</p><b>{packageData.questions.length} butir</b></div><div><p className="text-xs text-slate-500">Target</p><b>{assignmentLabel}</b></div><div><p className="text-xs text-slate-500">Dibuat</p><b>{new Date(packageData.createdAt).toLocaleString('id-ID')}</b></div></div>{packageData.status === 'published' && <p className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">Paket terbit dikunci agar isi tetap konsisten. Untuk versi baru, duplikasi paket terlebih dahulu.</p>}</section>
      <section className="space-y-3"><div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="text-lg font-bold">Daftar soal</h3><p className="text-sm text-slate-600">Urutan yang tampil di sini adalah urutan butir dalam paket.</p></div>{canWrite && packageData.status === 'draft' && <Link to={packagePath(packageId, '/edit')} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-white"><Plus className="size-4"/>Tambah atau susun soal</Link>}</div>{packageData.questions.length === 0 ? <div className="rounded-2xl border border-dashed bg-white p-8 text-center"><b>Paket ini belum memiliki soal.</b><p className="mt-1 text-sm text-slate-600">Tambahkan soal dari pustaka atau buat pertanyaan baru.</p>{canWrite && packageData.status === 'draft' && <Link to={packagePath(packageId, '/edit')} className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-semibold text-white">Mulai tambah soal</Link>}</div> : packageData.questions.map((question, index) => <article key={question.id} className="rounded-2xl border bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand text-sm font-bold text-white">{index + 1}</span><div className="min-w-0"><p className="text-xs font-semibold uppercase text-slate-500">{question.type.replaceAll('_', ' ')} · {question.points} poin</p><h4 className="mt-1 font-bold">{question.title}</h4><p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{question.prompt}</p></div></div>{question.status === 'draft' && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-900">Draf</span>}</div>{canWrite && packageData.status === 'draft' && question.status === 'draft' && <button type="button" className="mt-3 min-h-10 rounded-lg border px-3 text-sm font-semibold" onClick={() => { setQuestions(packageData.questions); editQuestion(question) }}>Edit butir soal</button>}</article>)}</section>
    </>}

    {view === 'edit' && <>
      {packageData.status !== 'draft' ? <section className="rounded-2xl border bg-amber-50 p-5"><h2 className="font-bold">Paket ini tidak dapat diedit</h2><p className="mt-1 text-sm text-slate-700">Paket yang diterbitkan atau diarsipkan menjaga histori tetap stabil. Duplikasi untuk membuat versi baru.</p>{canWrite && <button type="button" disabled={saving} onClick={() => void duplicatePackage()} className="mt-3 min-h-11 rounded-xl bg-brand px-4 font-semibold text-white">Duplikasi ke draf</button>}</section> : <>
        <form onSubmit={(event) => void savePackage(event)} className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">Informasi paket</p><h2 className="text-xl font-bold">Atur paket soal</h2></div><div className="grid gap-3 md:grid-cols-2"><label className="grid gap-1.5 text-sm font-semibold">Judul paket<input required maxLength={160} className="min-h-11 rounded-xl border px-3 font-normal" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Contoh: Ujian Akhir Semester — Matematika"/></label><label className="grid gap-1.5 text-sm font-semibold">Mata pelajaran<input maxLength={120} className="min-h-11 rounded-xl border px-3 font-normal" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Matematika" list="package-subjects"/><datalist id="package-subjects">{subjects.map((name) => <option key={name} value={name}/>)}</datalist></label><label className="grid gap-1.5 text-sm font-semibold md:col-span-2">Deskripsi (opsional)<textarea maxLength={5000} className="min-h-24 rounded-xl border p-3 font-normal" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Tujuan atau cakupan materi paket soal"/></label></div></form>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"><section className="rounded-2xl border bg-white p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold">Pilih dari pustaka soal</h3><p className="text-sm text-slate-600">Soal hanya berpindah paket saat Anda menyimpan.</p></div></div><input aria-label="Cari soal pustaka" className="mt-3 min-h-11 w-full rounded-xl border px-3" value={questionSearch} onChange={(event) => setQuestionSearch(event.target.value)} placeholder="Cari judul, isi, mapel, atau tag"/><div className="mt-3 max-h-[34rem] space-y-2 overflow-y-auto">{availableQuestions.map((question) => { const included = selectedQuestionIds.includes(question.id); const otherPackage = question.packageId && question.packageId !== packageId; return <button key={question.id} type="button" disabled={Boolean(otherPackage) || question.status === 'archived'} onClick={() => setSelectedQuestionIds((current) => included ? current.filter((id) => id !== question.id) : [...current, question.id])} aria-pressed={included} className={`w-full rounded-xl border p-3 text-left transition ${included ? 'border-brand bg-sky-50' : 'hover:border-sky-400'} disabled:opacity-50`}><span className="flex items-start justify-between gap-3"><span className="min-w-0"><b className="block">{question.title}</b><span className="mt-1 block text-xs text-slate-600">{question.type.replaceAll('_', ' ')} · {question.points} poin{question.subject ? ` · ${question.subject}` : ''}</span></span><span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md border text-sm font-bold">{included ? '✓' : '+'}</span></span></button>})}{availableQuestions.length === 0 && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Tidak ada soal lepas yang cocok. Anda bisa membuat soal baru di paket ini.</p>}</div><button type="button" onClick={() => editQuestion()} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 font-semibold"><Plus className="size-4"/>Buat soal baru di paket</button></section>
          <section className="rounded-2xl border bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold">Urutan soal dalam paket</h3><p className="text-sm text-slate-600">Seret kartu atau gunakan tombol naik/turun.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold">{selectedQuestionIds.length} soal</span></div><div className="mt-3 space-y-2">{selectedQuestions.map((question, index) => <article key={question.id} data-testid="package-question-row" draggable onDragStart={() => { dragID.current = question.id }} onDragOver={(event) => event.preventDefault()} onDrop={() => reorderDragged(question.id)} className="grid min-w-0 grid-cols-[20px_32px_minmax(0,1fr)] items-center gap-2 rounded-xl border p-3"><span className="cursor-grab text-slate-400" aria-label="Seret untuk mengurutkan">⠿</span><span className="grid size-8 place-items-center rounded-full bg-brand text-xs font-bold text-white">{index + 1}</span><span className="min-w-0 truncate text-sm font-semibold">{question.title}</span><div className="col-span-3 flex flex-wrap justify-end gap-2 border-t pt-2">{question.status === 'draft' && <button type="button" className="min-h-11 rounded-lg border px-3 text-sm font-semibold" onClick={() => editQuestion(question)}>Edit soal</button>}<button type="button" aria-label={`Naikkan ${question.title}`} disabled={index === 0} onClick={() => moveQuestion(index, index - 1)} className="grid size-11 place-items-center rounded-lg border disabled:opacity-40"><ArrowUp className="size-4"/></button><button type="button" aria-label={`Turunkan ${question.title}`} disabled={index === selectedQuestionIds.length - 1} onClick={() => moveQuestion(index, index + 1)} className="grid size-11 place-items-center rounded-lg border disabled:opacity-40"><ArrowDown className="size-4"/></button><button type="button" aria-label={`Keluarkan ${question.title} dari paket`} onClick={() => setSelectedQuestionIds((current) => current.filter((id) => id !== question.id))} className="grid size-11 place-items-center rounded-lg border text-rose-700"><Trash2 className="size-4"/></button></div></article>)}{selectedQuestionIds.length === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-slate-500">Paket belum berisi soal. Pilih dari pustaka atau buat soal baru.</p>}</div><button type="button" onClick={() => void savePackage()} disabled={saving || !title.trim()} className="mt-4 min-h-11 w-full rounded-xl bg-brand px-4 font-semibold text-white disabled:opacity-50">{saving ? 'Menyimpan…' : 'Simpan paket dan urutan'}</button></section></div>
      </>}
      {questionEditorOpen && packageData.status === 'draft' && <section className="rounded-2xl border bg-white p-5 shadow-sm"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold">{editingQuestion ? 'Edit butir soal' : 'Buat butir soal dalam paket'}</h3><p className="text-sm text-slate-600">Editor visual yang sama digunakan di Bank Soal dan paket asesmen.</p></div><button type="button" onClick={() => { setQuestionEditorOpen(false); setEditingQuestion(undefined) }} className="min-h-11 rounded-xl border px-3 font-semibold">Tutup editor</button></div><QuestionEditor key={editingQuestion?.id || `new-${packageId}`} initial={editingQuestion} mode="simple" busy={saving} session={session} storageKey={`cbt-question-draft-${session.user.id}-question-package-${packageId}-${editingQuestion?.id || 'new'}`} onSave={saveQuestion} onCancel={() => { setQuestionEditorOpen(false); setEditingQuestion(undefined) }}/></section>}
    </>}

    {view === 'penugasan' && <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">Target paket</p><h2 className="text-xl font-bold">Atur kelas atau siswa</h2><p className="mt-1 text-sm text-slate-600">Pilih salah satu cara penetapan. Siswa tertentu tidak dapat digabung dengan penetapan seluruh kelas.</p></div><div className="grid gap-3 sm:grid-cols-2"><button type="button" aria-pressed={assignmentScope === 'class'} onClick={() => { setAssignmentScope('class'); setStudentIds([]) }} className={`min-h-16 rounded-xl border p-3 text-left ${assignmentScope === 'class' ? 'border-brand bg-sky-50' : ''}`}><b>Satu atau beberapa kelas</b><span className="mt-1 block text-xs text-slate-600">Paket ditandai untuk seluruh kelas yang dipilih.</span></button><button type="button" aria-pressed={assignmentScope === 'student'} onClick={() => { setAssignmentScope('student'); setClassIds([]) }} className={`min-h-16 rounded-xl border p-3 text-left ${assignmentScope === 'student' ? 'border-brand bg-sky-50' : ''}`}><b>Siswa tertentu</b><span className="mt-1 block text-xs text-slate-600">Pilih banyak siswa tanpa menetapkan seluruh kelas.</span></button></div>{assignmentScope === 'class' ? <div className="max-h-96 divide-y overflow-y-auto rounded-xl border">{classes.map((row) => <label key={row.id} className="flex min-h-12 cursor-pointer items-center gap-3 p-3"><input className="size-5 accent-sky-700" type="checkbox" checked={classIds.includes(row.id)} onChange={() => setClassIds((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id])}/><span className="font-medium">{row.nama}</span></label>)}{classes.length === 0 && <p className="p-4 text-sm text-slate-500">Belum ada kelas tersinkron dari LMS.</p>}</div> : <><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm font-semibold">Saring kelas siswa<select className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={studentClassFilter} onChange={(event) => setStudentClassFilter(event.target.value)}><option value="">Semua kelas</option>{classes.map((row) => <option key={row.id} value={row.id}>{row.nama}</option>)}</select></label><label className="grid gap-1 text-sm font-semibold">Cari siswa<input className="min-h-11 rounded-xl border px-3 font-normal" value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} placeholder="Nama atau NISN"/></label></div><div className="max-h-96 divide-y overflow-y-auto rounded-xl border">{availableStudents.map((row) => <label key={row.id} className="flex min-h-12 cursor-pointer items-center gap-3 p-3"><input className="size-5 accent-sky-700" type="checkbox" checked={studentIds.includes(row.id)} onChange={() => setStudentIds((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id])}/><span className="min-w-0"><b>{row.nama}</b><span className="ml-2 text-xs text-slate-500">{row.nisn} · {classNames.get(row.kelasId) || 'Kelas belum diketahui'}</span></span></label>)}{availableStudents.length === 0 && <p className="p-4 text-sm text-slate-500">Tidak ada siswa aktif yang cocok dengan filter.</p>}</div></>}<p className="text-sm text-slate-600">Terpilih: {assignmentScope === 'class' ? `${classIds.length} kelas` : `${studentIds.length} siswa`}</p><button type="button" onClick={() => void saveAssignments()} disabled={saving} className="min-h-11 w-full rounded-xl bg-brand px-4 font-semibold text-white disabled:opacity-50">{saving ? 'Menyimpan…' : 'Simpan target penugasan'}</button></section>}
  </div>
}
