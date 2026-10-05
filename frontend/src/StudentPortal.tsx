import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Clock3, Cloud, CloudOff, FileCheck2, Flag, GraduationCap, Info, ListChecks, LogOut, Play, Send, Type, X } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError, type Session } from './api'
import { QuestionAnswerControl, StimulusContent, type AnswerFile, type StudentQuestion } from './QuestionAnswerControl'
import { getQueuedAnswers, removeQueuedAnswer, saveQueuedAnswer, type QueuedAnswer } from './studentAnswerQueue'

type Assessment = { id: string; kind: string; title: string; description?: string; instructions?: string; room?: string; className?: string; subjectName?: string; gradeLevel?: number; durationMinute: number; startsAt?: string; endsAt?: string; accessCodeRequired?: boolean }
type Attempt = { id: string; assessmentId: string; status: string; deadlineAt?: string; score?: number }
type AttemptItem = { id: string; position: number; flagged: boolean; answer?: string; revision: number; question: StudentQuestion }
type HistoryRow = { id: string; assessmentId: string; title: string; kind: string; status: string; deadlineAt?: string; number: number; resultAvailable: boolean; score?: number }
type VerifiedCandidate = { id: string; name: string; nis?: string; nisn?: string; className?: string }
type Notice = { kind: 'ok' | 'error'; text: string } | null
type Result = { available: boolean; status: string; pendingManual: boolean; title: string; score?: number; className?: string; showReview?: boolean; items?: Array<{ position: number; question: StudentQuestion; answer: string; correct?: boolean; score: number; weight: number }> }

const parseAnswer = (raw?: string): unknown => {
  if (!raw) return ''
  try { return JSON.parse(raw) as unknown } catch { return raw }
}
const isAnswered = (item: AttemptItem) => {
  const value = parseAnswer(item.answer)
  return value !== '' && value !== null && !(Array.isArray(value) && value.length === 0) && !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)
}
const queueKey = (studentId: string, attemptId: string, itemId: string) => `${studentId}:${attemptId}:${itemId}`

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) { return <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</section> }
function Action({ children, variant = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const color = variant === 'primary' ? 'bg-brand text-white hover:bg-brand-dark' : variant === 'danger' ? 'bg-rose-600 text-white hover:bg-rose-700' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
  return <button {...props} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${color} ${className}`}>{children}</button>
}
function StatusNote({ value }: { value: Notice }) { return value ? <div role="alert" className={`rounded-xl border p-3 text-sm ${value.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{value.text}</div> : null }

export function StudentPortal({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [assessments, setAssessments] = useState<Assessment[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [selected, setSelected] = useState<Assessment | null>(null)
  const [wizardStep, setWizardStep] = useState<'identity' | 'confirm'>('identity')
  const [accessCode, setAccessCode] = useState('')
  const [verifiedCandidate, setVerifiedCandidate] = useState<VerifiedCandidate | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [confirmAccepted, setConfirmAccepted] = useState(false)
  const [assessmentFilter, setAssessmentFilter] = useState<'semua' | 'ujian_online' | 'simulasi'>('semua')
  const [gradeFilter, setGradeFilter] = useState('')
  const [subjectCategoryFilter, setSubjectCategoryFilter] = useState('wajib')
  const [subjectFilter, setSubjectFilter] = useState('')
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [items, setItems] = useState<AttemptItem[]>([])
  const [index, setIndex] = useState(0)
  const [notice, setNotice] = useState<Notice>(null)
  const [now, setNow] = useState(Date.now())
  const [serverOffset, setServerOffset] = useState(0)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'offline' | 'conflict' | 'error'>('saved')
  const [answerConflicts, setAnswerConflicts] = useState<string[]>([])
  const [fontSize, setFontSize] = useState(18)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [lateReview, setLateReview] = useState(false)
  const [resultLoading, setResultLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [queueCount, setQueueCount] = useState(0)
  const timers = useRef(new Map<string, number>())
  const pending = useRef(new Map<string, QueuedAnswer>())
  const inFlight = useRef(new Set<string>())
  const latestItems = useRef<AttemptItem[]>([])
  const latestAttempt = useRef<Attempt | null>(null)
  const expiredSubmit = useRef(false)
  const studentIdentity = session.user.pesertaDidikId || session.user.id
  const assessmentRouteId = location.pathname.match(/^\/siswa\/asesmen\/([^/]+)$/)?.[1]

  useEffect(() => { latestItems.current = items }, [items])
  useEffect(() => { latestAttempt.current = attempt }, [attempt])
  const reloadLists = useCallback(async () => {
    setLoading(true)
    try {
      const [available, past] = await Promise.all([api<Assessment[]>('/student/assessments', {}, session), api<HistoryRow[]>('/student/attempts', {}, session)])
      setAssessments(available)
      setHistory(past)
      setNotice(null)
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Daftar asesmen gagal dimuat.' }) }
    finally { setLoading(false) }
  }, [session])
  useEffect(() => { void reloadLists() }, [reloadLists])
  useEffect(() => {
    if (!assessmentRouteId) {
      setSelected(null)
      return
    }
    if (loading) return
    const row = assessments.find((candidate) => candidate.id === decodeURIComponent(assessmentRouteId))
    if (!row) {
      setNotice({ kind: 'error', text: 'Asesmen tidak tersedia untuk akun ini.' })
      navigate('/', { replace: true })
      return
    }
    setSelected(row)
    setWizardStep('identity')
    setVerifiedCandidate(null)
    setAccessCode('')
    setConfirmAccepted(false)
  }, [assessmentRouteId, assessments, loading, navigate])
  useEffect(() => {
    if (assessmentRouteId) return
    const params = new URLSearchParams(location.search)
    const requested = params.get('jenis')
    setAssessmentFilter(requested === 'ujian_online' || requested === 'simulasi' ? requested : 'semua')
    setGradeFilter(params.get('jenjang') || '')
    setSubjectCategoryFilter(params.get('kategori_mapel') || 'wajib')
    setSubjectFilter(params.get('mapel') || '')
  }, [assessmentRouteId, location.search])
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const timer = window.setInterval(tick, 1000)
    window.addEventListener('focus', tick)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [])

  const openAttempt = useCallback(async (attemptId: string) => {
    try {
      const data = await api<{ attempt: Attempt; items: AttemptItem[]; serverTime?: string }>(`/student/attempts/${attemptId}`, {}, session)
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear(); pending.current.clear(); inFlight.current.clear()
      latestAttempt.current = data.attempt
      setAttempt(data.attempt)
      setSelected(null)
      navigate('/', { replace: true })
      setItems(data.items)
      setIndex(0)
      setAnswerConflicts([])
      expiredSubmit.current = false
      if (data.serverTime) setServerOffset(new Date(data.serverTime).getTime() - Date.now())
      const localRows = await getQueuedAnswers(studentIdentity, data.attempt.id).catch(() => [])
      const localByItem = new Map(localRows.map((row) => [row.itemId, row]))
      const conflicts: string[] = []
      const restored = data.items.map((row) => {
        const local = localByItem.get(row.id)
        if (!local) return row
        pending.current.set(row.id, local)
        if (local.baseRevision !== row.revision) conflicts.push(row.id)
        return { ...row, answer: local.value }
      })
      latestItems.current = restored
      setItems(restored)
      setQueueCount(localRows.length)
      setAnswerConflicts(conflicts)
      setLateReview(false)
      if (conflicts.length) {
        setSaveState('conflict')
        setNotice({ kind: 'error', text: `${conflicts.length} jawaban berbeda dengan versi terbaru di server. Pilih versi yang ingin dipertahankan sebelum melanjutkan.` })
      } else if (localRows.length) setNotice({ kind: 'ok', text: 'Ada jawaban yang belum tersinkron dari perangkat ini. Kami akan mencoba menyimpannya saat tersambung.' })
      if (navigator.onLine && localRows.length) window.setTimeout(() => { for (const row of localRows) if (!conflicts.includes(row.itemId)) void flushItem(row.itemId) }, 0)
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Percobaan tidak dapat dibuka.' }) }
  }, [session, studentIdentity, navigate])

  const flushItem = useCallback(async (itemId: string): Promise<boolean> => {
    const record = pending.current.get(itemId)
    const currentAttempt = latestAttempt.current
    if (!record || !currentAttempt || inFlight.current.has(itemId)) return !record
    if (!navigator.onLine) { setSaveState('offline'); return false }
    inFlight.current.add(itemId)
    setSaveState('saving')
    try {
      const response = await api<{ revision: number }>(`/student/attempts/${currentAttempt.id}/items/${itemId}/answer`, { method: 'PUT', body: JSON.stringify({ value: JSON.parse(record.value) as unknown, revision: record.baseRevision }) }, session)
      const currentPending = pending.current.get(itemId)
      setItems((current) => current.map((row) => row.id === itemId ? { ...row, revision: response.revision } : row))
      if (currentPending?.updatedAt === record.updatedAt) {
        pending.current.delete(itemId)
        await removeQueuedAnswer(record.key).catch(() => undefined)
      } else if (currentPending) {
        const next = { ...currentPending, baseRevision: response.revision }
        pending.current.set(itemId, next)
        await saveQueuedAnswer(next)
        window.setTimeout(() => void flushItem(itemId), 50)
      }
      const left = pending.current.size
      setQueueCount(left)
      setSaveState(left ? 'saving' : 'saved')
      if (!left) setNotice({ kind: 'ok', text: 'Semua jawaban sudah tersimpan di server.' })
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setAnswerConflicts((current) => current.includes(itemId) ? current : [...current, itemId])
        setSaveState('conflict')
      } else setSaveState(navigator.onLine ? 'error' : 'offline')
      setQueueCount(pending.current.size)
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Jawaban belum tersinkron. Jawaban lokal tetap disimpan.' })
      return false
    } finally { inFlight.current.delete(itemId) }
  }, [session])

  async function resolveAnswerConflicts(choice: 'server' | 'device') {
    if (!attempt || !answerConflicts.length || !navigator.onLine) return
    const conflictIds = [...answerConflicts]
    try {
      if (choice === 'server') {
        for (const itemId of conflictIds) {
          const row = pending.current.get(itemId)
          pending.current.delete(itemId)
          if (row) await removeQueuedAnswer(row.key).catch(() => undefined)
        }
        setAnswerConflicts([])
        await openAttempt(attempt.id)
        setNotice({ kind: 'ok', text: 'Jawaban versi server digunakan. Jawaban perangkat yang konflik dibuang.' })
        return
      }
      const latest = await api<{ items: AttemptItem[] }>(`/student/attempts/${attempt.id}`, {}, session)
      const revisions = new Map(latest.items.map((row) => [row.id, row.revision]))
      for (const itemId of conflictIds) {
        const row = pending.current.get(itemId)
        const revision = revisions.get(itemId)
        if (!row || revision === undefined) throw new Error('Versi server terbaru tidak lengkap. Muat ulang percobaan lalu coba lagi.')
        const rebased = { ...row, baseRevision: revision, updatedAt: Date.now() }
        pending.current.set(itemId, rebased)
        await saveQueuedAnswer(rebased)
      }
      setAnswerConflicts([])
      setNotice({ kind: 'ok', text: 'Jawaban perangkat dipilih. Kami menyimpan jawaban tersebut sebagai revisi baru.' })
      for (const itemId of conflictIds) await flushItem(itemId)
    } catch (error) {
      setSaveState('error')
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Konflik jawaban belum dapat diselesaikan.' })
    }
  }

  function retryPendingAnswers() {
    for (const itemId of pending.current.keys()) if (!answerConflicts.includes(itemId)) void flushItem(itemId)
  }

  function changeAnswer(item: AttemptItem, value: unknown) {
    const serialized = JSON.stringify(value)
    const record: QueuedAnswer = { key: queueKey(studentIdentity, attempt?.id || '', item.id), studentId: studentIdentity, attemptId: attempt?.id || '', itemId: item.id, value: serialized, baseRevision: item.revision, updatedAt: Date.now() }
    pending.current.set(item.id, record)
    setItems((current) => current.map((row) => row.id === item.id ? { ...row, answer: serialized } : row))
    setSaveState('saving')
    setQueueCount(pending.current.size)
    void saveQueuedAnswer(record).then(() => {
      const old = timers.current.get(item.id)
      if (old) window.clearTimeout(old)
      timers.current.set(item.id, window.setTimeout(() => void flushItem(item.id), 650))
    }).catch((error: unknown) => {
      setSaveState('error')
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Jawaban tidak dapat disimpan di perangkat ini.' })
    })
  }

  useEffect(() => {
    const onOnline = () => {
      if (pending.current.size) {
        setNotice({ kind: 'ok', text: 'Koneksi kembali. Menyinkronkan jawaban…' })
        for (const itemId of pending.current.keys()) if (!answerConflicts.includes(itemId)) void flushItem(itemId)
      }
    }
    const onOffline = () => { if (pending.current.size) { setSaveState('offline'); setNotice({ kind: 'ok', text: 'Koneksi terputus. Jawaban baru disimpan sementara di perangkat ini.' }) } }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [answerConflicts, flushItem])

  async function verifyCandidate() {
    if (!selected) return
    setVerifyBusy(true)
    setNotice(null)
    try {
      const data = await api<{ verified: boolean; student: VerifiedCandidate }>(`/student/assessments/${selected.id}/verify`, { method: 'POST', body: JSON.stringify({ accessCode }) }, session)
      setVerifiedCandidate(data.student)
      setWizardStep('confirm')
      setConfirmAccepted(false)
      navigate(`/siswa/asesmen/${encodeURIComponent(selected.id)}?tahap=konfirmasi`)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Data peserta atau token belum dapat diverifikasi.' })
    } finally {
      setVerifyBusy(false)
    }
  }
  function chooseAssessment(row: Assessment) {
    setSelected(row)
    setWizardStep('identity')
    setAccessCode('')
    setVerifiedCandidate(null)
    setConfirmAccepted(false)
    setNotice(null)
    navigate(`/siswa/asesmen/${encodeURIComponent(row.id)}?tahap=data`)
  }
  function closeAssessmentFlow() {
    setSelected(null)
    setVerifiedCandidate(null)
    setAccessCode('')
    setConfirmAccepted(false)
    navigate('/', { replace: true })
  }
  async function startSelected() {
    if (!selected) return
    if (!confirmAccepted) { setNotice({ kind: 'error', text: 'Centang konfirmasi kesiapan sebelum memulai tes.' }); return }
    try {
      const next = await api<Attempt>(`/student/assessments/${selected.id}/start`, { method: 'POST', body: JSON.stringify({ accessCode }) }, session)
      await openAttempt(next.id)
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Asesmen belum dapat dimulai.' }) }
  }
  async function toggleFlag(item: AttemptItem) {
    try {
      const next = !item.flagged
      await api(`/student/attempts/${attempt?.id}/items/${item.id}/flag`, { method: 'PUT', body: JSON.stringify({ flagged: next }) }, session)
      setItems((current) => current.map((row) => row.id === item.id ? { ...row, flagged: next } : row))
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Penanda belum tersimpan.' }) }
  }
  async function submitConfirmed() {
    if (!attempt || !navigator.onLine || remaining === 0) { setNotice({ kind: 'error', text: remaining === 0 ? 'Waktu telah berakhir. Jawaban yang belum tersinkron dapat diajukan untuk peninjauan tutor.' : 'Pengiriman memerlukan koneksi internet. Jawaban tersimpan di perangkat dan akan disinkronkan saat online.' }); return }
    const pendingIds = [...pending.current.keys()]
    for (const id of pendingIds) {
      const saved = await flushItem(id)
      if (!saved) return
    }
    try {
      const response = await api<{ status: string; score: number; showResult: boolean }>(`/student/attempts/${attempt.id}/submit`, { method: 'POST' }, session)
      setAttempt({ ...attempt, status: response.status, score: response.score })
      setSummaryOpen(false)
      setNotice({ kind: 'ok', text: response.showResult ? `Jawaban terkirim. Nilai: ${response.score}` : 'Jawaban berhasil dikirim. Hasil mengikuti kebijakan asesmen.' })
      await reloadLists()
      if (response.showResult) await showResult(attempt.id)
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Pengiriman jawaban gagal.' }) }
  }
  async function uploadFile(item: AttemptItem, file: File): Promise<AnswerFile> {
    if (!attempt) throw new Error('Percobaan belum dimulai.')
    const body = new FormData(); body.set('file', file)
    return api<AnswerFile>(`/student/attempts/${attempt.id}/items/${item.id}/files`, { method: 'POST', body }, session)
  }
  async function removeFile(item: AttemptItem, fileId: string) {
    if (!attempt) return
    await api(`/student/attempts/${attempt.id}/items/${item.id}/files/${fileId}`, { method: 'DELETE' }, session)
  }
  async function downloadFile(fileId: string, name: string) {
    if (!attempt) return
    const response = await fetch(`/api/student/attempts/${attempt.id}/files/${fileId}`, { headers: { Authorization: `Bearer ${session.accessToken}` } })
    if (!response.ok) { setNotice({ kind: 'error', text: 'Berkas tidak dapat diunduh.' }); return }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url)
  }
  async function showResult(attemptId: string) {
    setResultLoading(true)
    try { setResult(await api<Result>(`/student/attempts/${attemptId}/results`, {}, session)) }
    catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Hasil belum dapat dibuka.' }) }
    finally { setResultLoading(false) }
  }

  async function expireAttempt() {
    const current = latestAttempt.current
    if (!current || expiredSubmit.current || !navigator.onLine) return
    try {
      const response = await api<{ status: string; score: number; showResult: boolean }>(`/student/attempts/${current.id}/submit`, { method: 'POST' }, session)
      expiredSubmit.current = true
      setAttempt({ ...current, status: response.status, score: response.score })
      setNotice({ kind: 'ok', text: pending.current.size ? 'Waktu berakhir. Jawaban tersimpan server sudah dikunci; perubahan lokal dapat diajukan terpisah untuk ditinjau tutor.' : 'Waktu berakhir dan jawaban yang tersimpan di server telah dikunci.' })
      if (pending.current.size) setLateReview(true)
      else if (response.showResult) await showResult(current.id)
      await reloadLists()
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Penutupan asesmen sedang diproses server.' }) }
  }
  async function sendLateRecovery() {
    if (!attempt || !pending.current.size || !navigator.onLine) return
    const answers = [...pending.current.values()].map((row) => ({ itemId: row.itemId, value: JSON.parse(row.value) as unknown }))
    try {
      await api(`/student/attempts/${attempt.id}/recovery`, { method: 'POST', body: JSON.stringify({ answers }) }, session)
      for (const row of pending.current.values()) await removeQueuedAnswer(row.key).catch(() => undefined)
      pending.current.clear(); setQueueCount(0); setLateReview(false)
      setNotice({ kind: 'ok', text: 'Jawaban lokal dikirim untuk ditinjau tutor. Nilai tidak berubah sampai tutor memutuskan.' })
      await reloadLists()
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Jawaban belum berhasil diajukan untuk ditinjau.' }) }
  }

  const resumeAttempt = useMemo(() => selected ? history.find((row) => row.assessmentId === selected.id && row.status === 'started') : undefined, [history, selected])
  const unanswered = items.filter((row) => !isAnswered(row))
  const flagged = items.filter((row) => row.flagged)
  const item = items[index]
  const remaining = attempt?.deadlineAt ? Math.max(0, new Date(attempt.deadlineAt).getTime() - (now + serverOffset)) : 0
  const timerText = `${String(Math.floor(remaining / 3600000)).padStart(2, '0')}:${String(Math.floor(remaining / 60000) % 60).padStart(2, '0')}:${String(Math.floor(remaining / 1000) % 60).padStart(2, '0')}`
  const active = Boolean(attempt && ['started'].includes(attempt.status))

  useEffect(() => {
    if (attempt?.deadlineAt && remaining === 0 && active && !expiredSubmit.current && navigator.onLine) void expireAttempt()
  }, [attempt?.deadlineAt, remaining, active])
  useEffect(() => {
    const retryClose = () => { if (latestAttempt.current?.deadlineAt && Date.now() + serverOffset >= new Date(latestAttempt.current.deadlineAt).getTime()) void expireAttempt() }
    window.addEventListener('online', retryClose)
    return () => window.removeEventListener('online', retryClose)
  }, [serverOffset])
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!active || event.altKey === false || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
      const target = event.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return
      event.preventDefault()
      setIndex((current) => Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1))))
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [active, items.length])
  useEffect(() => {
    if (!paletteOpen) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPaletteOpen(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [paletteOpen])

  if (result) return <main className="min-h-screen bg-slate-50 p-4"><div className="mx-auto max-w-3xl space-y-4"><Panel className="overflow-hidden"><div className="bg-brand p-6 text-white"><p className="text-sm font-bold uppercase tracking-wide text-cyan-100">Hasil asesmen</p><h1 className="mt-1 text-2xl font-bold">{result.title}</h1></div><div className="space-y-4 p-6"><p className="text-slate-700">{result.available ? `Nilai: ${result.score}` : result.pendingManual ? 'Jawaban uraian/berkas sedang menunggu penilaian tutor.' : 'Hasil belum dirilis oleh tutor.'}</p>{result.className && <p className="text-sm text-slate-500">Kelas saat ujian: {result.className}</p>}{result.items?.map((row) => <article className="rounded-xl border p-4" key={row.position}><p className="font-semibold">{row.position}. {row.question.prompt}</p><p className="mt-2 text-sm text-slate-600">Jawabanmu: {String(parseAnswer(row.answer) || 'Belum dijawab')}</p><p className="mt-1 text-sm">Skor {row.score} dari {row.weight}</p></article>)}<Action onClick={() => { setResult(null); void reloadLists() }}>Kembali ke daftar asesmen</Action></div></Panel></div></main>

  if (lateReview && attempt) return <main className="grid min-h-screen place-items-center bg-slate-50 p-4"><Panel className="w-full max-w-xl space-y-4 p-6"><p className="text-xs font-bold uppercase tracking-wider text-amber-800">Waktu ujian berakhir</p><h1 className="text-2xl font-bold">Jawaban lokal belum tersinkron</h1><p className="text-slate-600">Ada {pending.current.size} jawaban yang hanya tersimpan di perangkat ini. Kamu dapat mengajukannya kepada tutor untuk ditinjau. Pengajuan ini tidak langsung mengubah nilai.</p><StatusNote value={notice}/><div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Action variant="secondary" onClick={() => setLateReview(false)}>Kembali ke riwayat</Action><Action onClick={() => void sendLateRecovery()} disabled={!navigator.onLine || !pending.current.size}><Send className="size-4"/>Ajukan ke tutor</Action></div></Panel></main>

  if (selected && !attempt) {
    return <main className="relative min-h-screen overflow-hidden bg-[#f4f7fb] pt-28">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-52 overflow-hidden bg-[#356b9a]"><div className="absolute inset-0 opacity-40 [background-image:linear-gradient(32deg,transparent_0_17%,rgba(255,255,255,.12)_17.2%_35%,transparent_35.2%),linear-gradient(145deg,transparent_0_28%,rgba(17,87,147,.55)_28.2%_56%,transparent_56.2%)]"/></div>
      <header className="absolute inset-x-0 top-0 z-10 mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 text-white"><div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-full border border-white/30 bg-white/10"><GraduationCap/></span><div><p className="text-sm font-black tracking-wide">PKBM TUNAS ILMU</p><p className="text-xs text-blue-100">SIMULASI ANBK · TKA</p></div></div><Action variant="secondary" className="min-h-11" onClick={closeAssessmentFlow}><ChevronLeft className="size-4"/>Kembali</Action></header>
      <div className="relative mx-auto max-w-3xl px-4 pb-8 pt-6 sm:pt-9"><div className="mx-auto max-w-2xl"><ol aria-label="Tahap sebelum ujian" className="mb-5 grid grid-cols-3 gap-2 text-center text-xs font-semibold sm:text-sm">{[['1', 'Pilih asesmen'], ['2', 'Data peserta'], ['3', 'Konfirmasi']].map(([number, label], stepIndex) => { const current = wizardStep === 'identity' ? 1 : 2; const done = stepIndex < current; const selectedStep = stepIndex === current; return <li key={number} aria-current={selectedStep ? 'step' : undefined} className={`rounded-xl px-2 py-2 shadow-sm ${selectedStep ? 'bg-[#356b9a] text-white' : done ? 'bg-emerald-100 text-emerald-900' : 'bg-white text-slate-500'}`}><span className="mr-1 inline-grid size-6 place-items-center rounded-full border border-current">{done ? '✓' : number}</span>{label}</li> })}</ol>
      <Panel className="overflow-hidden border-0 shadow-[0_24px_55px_rgba(15,23,42,.22)]"><div className="h-2 bg-[#356b9a]"/><div className="p-5 sm:p-8">
        {wizardStep === 'identity' ? <>
          <p className="text-xs font-bold uppercase tracking-wider text-[#356b9a]">Verifikasi sebelum tes</p><h1 className="mt-1 text-2xl font-bold">Konfirmasi data peserta</h1><p className="mt-2 text-sm leading-relaxed text-slate-600">Pastikan kamu membuka asesmen yang benar. Data peserta berasal dari akun sekolah dan tidak dapat diubah di sini.</p>
          <dl className="mt-5 divide-y rounded-2xl border bg-slate-50 px-4"><div className="py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Nama peserta</dt><dd className="mt-1 font-bold">{session.user.nama}</dd></div><div className="py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">ID peserta</dt><dd className="mt-1 font-mono text-sm">{session.user.username}</dd></div><div className="py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Asesmen</dt><dd className="mt-1 font-bold">{selected.title}</dd></div><div className="py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mata pelajaran</dt><dd className="mt-1">{selected.subjectName || 'Sesuai penugasan tutor'}</dd></div></dl>
          <label className="mt-5 grid gap-2 text-sm font-semibold">Token asesmen{selected.accessCodeRequired && <span className="text-rose-700">Wajib</span>}<input autoComplete="one-time-code" inputMode="text" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder={selected.accessCodeRequired ? 'Masukkan token dari tutor' : 'Masukkan jika tutor memberikan token'} className="min-h-12 rounded-xl border border-slate-300 px-3 text-base font-normal uppercase tracking-widest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"/><span className="text-xs font-normal text-slate-500">{selected.accessCodeRequired ? 'Token wajib dan diverifikasi oleh server sebelum tes dimulai.' : 'Jika paket memakai token, masukkan token yang dibagikan tutor. Token tidak disimpan di browser.'}</span></label>
          <StatusNote value={notice}/><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between"><Action variant="secondary" onClick={closeAssessmentFlow}>Pilih asesmen lain</Action>{resumeAttempt ? <Action className="bg-[#0878ed] hover:bg-blue-700" onClick={() => void openAttempt(resumeAttempt.id)}><Play className="size-4"/>Lanjutkan percobaan</Action> : <Action className="bg-[#0878ed] hover:bg-blue-700" onClick={() => void verifyCandidate()} disabled={verifyBusy || !navigator.onLine || (selected.accessCodeRequired === true && !accessCode.trim())}>{verifyBusy ? 'Memeriksa…' : 'Verifikasi & lanjutkan'}</Action>}</div>
        </> : <>
          <p className="text-xs font-bold uppercase tracking-wider text-[#356b9a]">Tahap akhir sebelum pengerjaan</p><h1 className="mt-1 text-2xl font-bold">Konfirmasi Tes</h1><p className="mt-2 text-sm text-slate-600">Periksa kembali identitas, jadwal, dan aturan pengerjaan.</p>
          <dl className="mt-5 divide-y rounded-2xl border bg-slate-50 px-4"><div className="py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Nama peserta</dt><dd className="mt-1 font-bold">{verifiedCandidate?.name || session.user.nama}</dd></div><div className="py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">NIS / NISN</dt><dd className="mt-1 font-mono text-sm">NIS: {verifiedCandidate?.nis || '—'}</dd><dd className="font-mono text-sm">NISN: {verifiedCandidate?.nisn || session.user.username}</dd></div><div className="py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mata ujian</dt><dd className="mt-1 font-bold">{selected.subjectName || selected.title}</dd><dd className="text-sm text-slate-600">{selected.title}{selected.room ? ` · ${selected.room}` : ''}</dd></div><div className="grid gap-3 py-3 sm:grid-cols-2"><div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status tes</dt><dd className="mt-1">Siap dimulai</dd></div><div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Alokasi waktu</dt><dd className="mt-1 font-bold">{selected.durationMinute} menit</dd></div></div>{selected.startsAt && <div className="py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Jadwal</dt><dd className="mt-1">{new Date(selected.startsAt).toLocaleString('id-ID')}{selected.endsAt ? ` – ${new Date(selected.endsAt).toLocaleString('id-ID')}` : ''}</dd></div>}</dl>
          {selected.instructions && <div className="mt-4 rounded-xl border border-sky-100 bg-sky-50 p-4"><h2 className="font-bold">Petunjuk pengerjaan</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{selected.instructions}</p></div>}
          <ul className="mt-4 space-y-2 text-sm text-slate-700"><li>• Jawaban tersimpan otomatis saat terhubung ke internet.</li><li>• Timer berjalan sesuai waktu server dan ujian dikunci saat tenggat berakhir.</li><li>• Gunakan daftar soal untuk meninjau jawaban sebelum dikirim.</li><li>• Jangan tutup halaman sampai pengiriman terkonfirmasi.</li></ul>
          <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm"><input type="checkbox" className="mt-0.5 size-5 accent-sky-700" checked={confirmAccepted} onChange={(event) => setConfirmAccepted(event.target.checked)}/><span>Saya memastikan data peserta benar dan mengerjakan tes ini sendiri.</span></label><StatusNote value={notice}/>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between"><Action variant="secondary" onClick={() => { setWizardStep('identity'); setVerifiedCandidate(null); navigate(`/siswa/asesmen/${encodeURIComponent(selected.id)}?tahap=data`) }}>Kembali</Action><Action className="bg-[#0878ed] hover:bg-blue-700" onClick={() => void startSelected()} disabled={!confirmAccepted || !navigator.onLine}><Play className="size-4"/>Mulai tes</Action></div>
        </>}
      </div></Panel><p className="mt-4 text-center text-xs text-slate-500">Identitas siswa diverifikasi dari LMS · {session.user.nama} · Simulasi mandiri PKBM Tunas Ilmu, bukan aplikasi resmi pemerintah.</p></div></div>
    </main>
  }

  if (attempt && active && item) {
    return <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 bg-[#356b9a] text-white shadow-sm"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 sm:px-5 sm:py-3"><div className="flex min-w-0 items-center gap-2.5"><span className="grid size-9 shrink-0 place-items-center rounded-full border border-white/30 bg-white/10"><GraduationCap className="size-5"/></span><div className="min-w-0"><b className="block truncate text-sm sm:text-base">PKBM Tunas Ilmu · CBT</b><p className="truncate text-xs text-blue-100 sm:text-sm">{session.user.nama} · Soal {index + 1} dari {items.length}</p></div></div><div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2"><span aria-label={saveState === 'saved' ? 'Tersimpan' : saveState === 'saving' ? 'Menyimpan' : saveState === 'offline' ? `Offline, ${queueCount} jawaban lokal` : saveState === 'conflict' ? 'Perlu pilih versi' : 'Gagal menyimpan'} className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xl px-2 text-white sm:min-h-11 sm:text-sm">{saveState === 'offline' || !navigator.onLine ? <CloudOff className="size-4"/> : <Cloud className="size-4"/>}<span className="hidden sm:inline">{saveState === 'saved' ? 'Tersimpan' : saveState === 'saving' ? 'Menyimpan…' : saveState === 'offline' ? `Offline · ${queueCount} lokal` : saveState === 'conflict' ? 'Perlu pilih versi' : 'Gagal menyimpan'}</span></span><span aria-live="polite" className={`inline-flex min-h-10 items-center gap-1.5 rounded-xl px-2 font-mono text-sm font-bold sm:min-h-11 sm:gap-2 sm:px-3 sm:text-base ${remaining <= 300000 ? 'bg-rose-600' : remaining <= 900000 ? 'bg-amber-300 text-slate-950' : 'bg-white/15'}`}><Clock3 className="size-4"/><span>{timerText}</span></span><Action variant="secondary" className="min-h-10 gap-1.5 px-2 sm:min-h-11 sm:px-3" onClick={() => setInfoOpen(true)} aria-label="Informasi soal"><Info className="size-4"/><span className="hidden sm:inline">Informasi soal</span></Action><span className="hidden lg:block"><Action variant="secondary" className="min-h-10 gap-1.5 px-2 sm:min-h-11 sm:px-3" onClick={() => setPaletteOpen(true)} aria-label="Daftar soal"><ListChecks className="size-4"/><span className="hidden sm:inline">Daftar soal</span></Action></span><Action variant="secondary" className="min-h-10 gap-1.5 px-2 sm:min-h-11 sm:px-3" onClick={() => setFontSize((size) => size === 15 ? 18 : size === 18 ? 22 : 15)} aria-label={`Ukuran teks ${fontSize} piksel`}><Type className="size-4"/><span className="text-xs">{fontSize}</span></Action></div></div></header>
      <main className="mx-auto grid max-w-7xl gap-4 p-3 pb-24 sm:p-5 sm:pb-28 lg:grid-cols-[230px_minmax(0,1fr)] lg:pb-5">
        <aside className="order-2 hidden lg:order-1 lg:block"><Panel className="p-3 lg:sticky lg:top-24"><div className="mb-3 flex items-center justify-between"><p className="font-bold">Daftar soal</p><span className="text-xs text-slate-500">{items.filter(isAnswered).length}/{items.length} terjawab</span></div><div className="grid grid-cols-6 gap-2 sm:grid-cols-8 lg:grid-cols-4">{items.map((row, itemIndex) => <button type="button" key={row.id} aria-label={`Soal ${itemIndex + 1}${row.flagged ? ', ditandai untuk ditinjau' : ''}${isAnswered(row) ? ', sudah dijawab' : ', belum dijawab'}`} aria-current={itemIndex === index ? 'step' : undefined} onClick={() => setIndex(itemIndex)} className={`relative min-h-11 rounded-lg text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-700 ${itemIndex === index ? 'bg-brand text-white' : isAnswered(row) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{itemIndex + 1}{row.flagged && <span aria-hidden className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-white bg-amber-500"/>}</button>)}</div><div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600"><span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-emerald-500"/>Terjawab</span><span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-amber-500"/>Ditandai</span><span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-slate-300"/>Kosong</span></div><Action variant="secondary" className="mt-4 w-full" onClick={() => setSummaryOpen(true)}><ListChecks className="size-4"/>Periksa & kirim</Action></Panel></aside>
        <section className="order-1 min-w-0 space-y-3 lg:order-2"><StatusNote value={notice}/>{answerConflicts.length > 0 && <Panel className="space-y-3 border-amber-300 bg-amber-50 p-4"><div><h2 className="font-bold text-amber-950">Jawaban berubah di perangkat lain</h2><p className="mt-1 text-sm text-amber-900">{answerConflicts.length} jawaban lokal berbeda dari versi terbaru di server. Pilih versi sebelum melanjutkan. Memilih jawaban perangkat akan menyimpan revisi baru dan mempertahankan riwayatnya.</p></div><div className="flex flex-col gap-2 sm:flex-row"><Action variant="secondary" disabled={!navigator.onLine} onClick={() => void resolveAnswerConflicts('server')}>Gunakan versi server</Action><Action disabled={!navigator.onLine} onClick={() => void resolveAnswerConflicts('device')}>Pertahankan jawaban perangkat</Action></div></Panel>}{saveState === 'error' && !answerConflicts.length && pending.current.size > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"><span>Jawaban belum tersinkron. Jawaban lokal tetap aman di perangkat ini.</span><Action variant="secondary" onClick={retryPendingAnswers}>Coba sinkronkan</Action></div>}{remaining === 0 && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">Waktu sudah habis. Jawaban sedang dikirim ke server; jangan tutup halaman dulu.</div>}<Panel className="overflow-hidden p-0"><div className="flex flex-wrap items-start justify-between gap-3 border-b bg-white p-4 sm:px-6"><div><p className="text-sm font-bold text-[#356b9a]">{attempt ? assessments.find((row) => row.id === attempt.assessmentId)?.title || 'Asesmen' : 'Asesmen'}</p><p className="mt-1 text-sm text-slate-600">Soal {index + 1} dari {items.length}</p></div><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-[#356b9a]">{item.question.points} poin</span></div><div className={item.question.stimulus?.length ? 'grid min-w-0 lg:grid-cols-2 lg:divide-x' : 'mx-auto max-w-4xl'}>{item.question.stimulus?.length ? <aside aria-label="Bahan bacaan atau stimulus" className="min-w-0 border-b bg-white p-4 sm:p-6 lg:max-h-[calc(100dvh-290px)] lg:overflow-y-auto lg:border-b-0"><div className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Bahan pendukung</div><div style={{ fontSize }}><StimulusContent rows={item.question.stimulus} accessToken={session.accessToken}/></div></aside> : null}<div className="min-w-0 p-4 sm:p-7 lg:max-h-[calc(100dvh-290px)] lg:overflow-y-auto"><p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Pertanyaan {index + 1}</p><h1 className="mb-4 text-xl font-bold">{item.question.title}</h1><div style={{ fontSize }}><p className="whitespace-pre-wrap text-lg leading-relaxed">{item.question.prompt}</p>{item.question.description && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600">{item.question.description}</p>}<QuestionAnswerControl question={item.question} questionId={item.id} value={parseAnswer(item.answer)} onChange={(value) => changeAnswer(item, value)} onFileUpload={(file) => uploadFile(item, file)} onFileRemove={(fileId) => removeFile(item, fileId)} onFileDownload={(fileId, name) => void downloadFile(fileId, name)} accessToken={session.accessToken}/></div></div></div></Panel><div className="hidden grid-cols-3 gap-2 rounded-2xl border bg-white p-2 shadow-sm lg:grid"><Action variant="danger" className="min-h-12 px-2" disabled={index === 0} onClick={() => setIndex((value) => value - 1)}><ChevronLeft className="size-4"/>Soal sebelumnya</Action><Action variant="secondary" className={`min-h-12 px-2 ${item.flagged ? 'border-amber-400 bg-amber-50 text-amber-900' : ''}`} onClick={() => void toggleFlag(item)} aria-pressed={item.flagged}><Flag className={`size-4 ${item.flagged ? 'fill-amber-400 text-amber-600' : ''}`}/>{item.flagged ? 'Ditandai untuk ditinjau' : 'Ragu-ragu'}</Action><Action className="min-h-12 bg-[#0878ed] px-2 hover:bg-blue-700" disabled={index === items.length - 1} onClick={() => setIndex((value) => value + 1)}>Soal berikutnya<ChevronRight className="size-4"/></Action></div></section>
      </main>
      <nav aria-label="Navigasi pengerjaan" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 gap-1.5 border-t border-slate-200 bg-white/95 p-2 shadow-[0_-8px_24px_rgba(15,23,42,0.12)] backdrop-blur [padding-bottom:calc(env(safe-area-inset-bottom)+0.5rem)] lg:hidden"><Action variant="danger" className="min-h-12 px-1.5" disabled={index === 0} onClick={() => setIndex((value) => value - 1)} aria-label="Soal sebelumnya"><ChevronLeft className="size-5"/><span className="hidden min-[360px]:inline">Sebelumnya</span></Action><Action variant="secondary" className="min-h-12 px-1.5" onClick={() => setPaletteOpen(true)} aria-label="Daftar soal"><ListChecks className="size-5"/><span className="hidden min-[360px]:inline">Daftar soal</span></Action><Action variant="secondary" className={`min-h-12 px-1.5 ${item.flagged ? 'border-amber-400 bg-amber-50 text-amber-900' : ''}`} onClick={() => void toggleFlag(item)} aria-pressed={item.flagged}><Flag className="size-4"/><span className="hidden min-[360px]:inline">Ragu-ragu</span></Action><Action className="min-h-12 bg-[#0878ed] px-1.5 hover:bg-blue-700" disabled={index === items.length - 1} onClick={() => setIndex((value) => value + 1)} aria-label="Soal berikutnya"><span className="hidden min-[360px]:inline">Berikutnya</span><ChevronRight className="size-5"/></Action></nav>
      {paletteOpen && <div className="fixed inset-0 z-40 grid items-end bg-slate-950/50 sm:place-items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false) }}><section role="dialog" aria-modal="true" aria-labelledby="question-palette-title" className="max-h-[82dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-2xl sm:max-w-xl sm:rounded-2xl sm:p-5"><div className="flex items-start justify-between gap-3"><div><h2 id="question-palette-title" className="text-lg font-bold">Daftar soal</h2><p className="mt-1 text-sm text-slate-600">{items.filter(isAnswered).length} dari {items.length} soal terjawab · {flagged.length} ditandai</p></div><Action variant="secondary" className="size-11 shrink-0 p-0" aria-label="Tutup daftar soal" onClick={() => setPaletteOpen(false)}><X className="size-5"/></Action></div><div className="mt-4 grid grid-cols-5 gap-2 min-[420px]:grid-cols-6">{items.map((row, itemIndex) => <button type="button" key={row.id} aria-label={`Soal ${itemIndex + 1}${row.flagged ? ', ditandai untuk ditinjau' : ''}${isAnswered(row) ? ', sudah dijawab' : ', belum dijawab'}`} aria-current={itemIndex === index ? 'step' : undefined} onClick={() => { setIndex(itemIndex); setPaletteOpen(false) }} className={`relative min-h-12 rounded-xl text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-700 ${itemIndex === index ? 'bg-[#356b9a] text-white' : isAnswered(row) ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-100 text-slate-700'}`}>{itemIndex + 1}{row.flagged && <span aria-label="Ditandai" className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-white bg-amber-500"/>}</button>)}</div><div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-600"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full bg-emerald-500"/>Terjawab</span><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full bg-amber-500"/>Ditandai</span><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full bg-slate-300"/>Kosong</span></div><Action variant="secondary" className="mt-4 w-full" onClick={() => { setPaletteOpen(false); setSummaryOpen(true) }}><ListChecks className="size-4"/>Periksa & kirim</Action></section></div>}
      {infoOpen && <div className="fixed inset-0 z-50 grid place-items-end bg-slate-950/50 p-0 sm:place-items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setInfoOpen(false) }}><section role="dialog" aria-modal="true" aria-labelledby="test-info-title" className="max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-[#356b9a]">Informasi tes</p><h2 id="test-info-title" className="mt-1 text-xl font-bold">{assessments.find((row) => row.id === attempt.assessmentId)?.title || 'Asesmen'}</h2></div><Action variant="secondary" className="size-11 shrink-0 p-0" aria-label="Tutup informasi tes" onClick={() => setInfoOpen(false)}><X className="size-5"/></Action></div><dl className="mt-4 divide-y rounded-xl border px-4"><div className="py-3"><dt className="text-xs font-semibold uppercase text-slate-500">Peserta</dt><dd className="mt-1 font-semibold">{session.user.nama}</dd></div><div className="py-3"><dt className="text-xs font-semibold uppercase text-slate-500">Mata pelajaran</dt><dd className="mt-1">{assessments.find((row) => row.id === attempt.assessmentId)?.subjectName || 'Sesuai penugasan tutor'}</dd></div><div className="py-3"><dt className="text-xs font-semibold uppercase text-slate-500">Sisa waktu</dt><dd className="mt-1 font-mono font-bold">{timerText}</dd></div></dl><div className="mt-4 rounded-xl bg-blue-50 p-4 text-sm leading-relaxed text-slate-700"><b>Petunjuk pengerjaan</b><p className="mt-1 whitespace-pre-wrap">{assessments.find((row) => row.id === attempt.assessmentId)?.instructions || 'Baca setiap soal dengan teliti. Jawaban tersimpan otomatis saat perangkat tersambung ke internet. Gunakan daftar soal untuk melihat status jawaban dan kembali ke nomor tertentu.'}</p></div><p className="mt-4 text-xs leading-relaxed text-slate-500">Simulasi mandiri PKBM Tunas Ilmu. Referensi pola navigasi: <a href="https://pusmendik.kemendikdasmen.go.id/tka/simulasi_tka/" target="_blank" rel="noreferrer" className="font-semibold text-[#356b9a] underline">Simulasi TKA Pusmendik</a>. CBT ini bukan aplikasi resmi pemerintah.</p><Action className="mt-4 w-full bg-[#0878ed] hover:bg-blue-700" onClick={() => setInfoOpen(false)}>Kembali ke soal</Action></section></div>}
      {summaryOpen && <div className="fixed inset-0 z-50 grid place-items-end bg-slate-950/50 p-0 sm:place-items-center sm:p-4" role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="submit-summary-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl"><h2 id="submit-summary-title" className="text-xl font-bold">Periksa jawaban sebelum dikirim</h2><p className="mt-1 text-sm text-slate-600">Pilih nomor untuk kembali memeriksa jawaban. Setelah dikirim, jawaban tidak dapat diubah.</p><div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-xl bg-rose-50 p-3"><p className="text-xs font-bold uppercase text-rose-800">Belum dijawab</p><p className="mt-1 text-2xl font-bold text-rose-900">{unanswered.length}</p></div><div className="rounded-xl bg-amber-50 p-3"><p className="text-xs font-bold uppercase text-amber-800">Ditandai</p><p className="mt-1 text-2xl font-bold text-amber-900">{flagged.length}</p></div></div><div className="mt-3 flex flex-wrap gap-2">{[...new Set([...unanswered, ...flagged])].map((row) => { const position = items.findIndex((candidate) => candidate.id === row.id); return <button type="button" key={row.id} onClick={() => { setIndex(position); setSummaryOpen(false) }} className="min-h-11 rounded-lg border px-3 text-sm font-semibold">Soal {position + 1}{!isAnswered(row) ? ' · kosong' : ''}{row.flagged ? ' · ditandai' : ''}</button> })}{!unanswered.length && !flagged.length && <p className="text-sm text-emerald-800">Semua soal telah terjawab dan tidak ada yang ditandai.</p>}</div>{queueCount > 0 && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{queueCount} jawaban masih menunggu sinkronisasi.</p>}<p className="mt-4 rounded-xl border p-3 text-sm text-slate-700">Pastikan kamu mengirim jawaban sendiri dan tidak meminta orang lain mengerjakan ujian ini.</p><div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Action variant="secondary" onClick={() => setSummaryOpen(false)}>Kembali memeriksa</Action><Action onClick={() => void submitConfirmed()} disabled={!navigator.onLine || saveState === 'conflict'}><Send className="size-4"/>Konfirmasi & kirim</Action></div></section></div>}
    </div>
  }

  const visibleAssessments = assessments.filter((row) =>
    (assessmentFilter === 'semua' || row.kind === assessmentFilter) &&
    (!gradeFilter || !row.gradeLevel || String(row.gradeLevel) === gradeFilter) &&
    (!subjectFilter || !row.subjectName || row.subjectName.toLocaleLowerCase('id-ID').includes(subjectFilter.toLocaleLowerCase('id-ID'))),
  )
  const availableLevels = [...new Set(assessments.filter((row) => row.kind === 'simulasi' && row.gradeLevel).map((row) => row.gradeLevel as number))].sort()
  const availableSubjects = [...new Set(assessments.filter((row) => row.kind === 'simulasi' && row.subjectName).map((row) => row.subjectName as string))].sort((a, b) => a.localeCompare(b, 'id-ID'))
  function updateSelection(next: { jenis?: string; jenjang?: string; kategori_mapel?: string; mapel?: string }) {
    const params = new URLSearchParams(location.search)
    if (next.jenis !== undefined) { if (next.jenis) params.set('jenis', next.jenis); else params.delete('jenis') }
    if (next.jenjang !== undefined) { if (next.jenjang) params.set('jenjang', next.jenjang); else params.delete('jenjang') }
    if (next.kategori_mapel !== undefined) { if (next.kategori_mapel) params.set('kategori_mapel', next.kategori_mapel); else params.delete('kategori_mapel') }
    if (next.mapel !== undefined) { if (next.mapel) params.set('mapel', next.mapel); else params.delete('mapel') }
    const query = params.toString()
    navigate(query ? `/?${query}` : '/')
  }
  const filters: Array<{ id: typeof assessmentFilter; label: string }> = [{ id: 'semua', label: 'Semua' }, { id: 'ujian_online', label: 'Ujian Online' }, { id: 'simulasi', label: 'Simulasi ANBK / TKA' }]
  return <div className="min-h-screen bg-[#f3f7fb]"><header className="relative overflow-hidden bg-[#356b9a] text-white shadow-sm"><div aria-hidden="true" className="absolute inset-0 opacity-40 [background-image:linear-gradient(32deg,transparent_0_17%,rgba(255,255,255,.12)_17.2%_35%,transparent_35.2%),linear-gradient(145deg,transparent_0_28%,rgba(17,87,147,.55)_28.2%_56%,transparent_56.2%)]"/><div className="relative mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4"><div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-full border border-white/30 bg-white/10"><GraduationCap/></span><div><p className="text-sm font-black tracking-wide">PKBM TUNAS ILMU</p><p className="text-xs text-blue-100">SIMULASI ANBK · TKA</p></div></div><div className="flex items-center gap-3"><span className="hidden text-right text-sm sm:block"><b>{session.user.nama}</b><br/><span className="text-blue-100">Peserta didik</span></span><Action variant="secondary" onClick={onLogout}><LogOut className="size-4"/>Keluar</Action></div></div></header>
  <main className="mx-auto max-w-5xl space-y-5 px-4 pb-8 pt-6 sm:pt-9"><StatusNote value={notice}/><section className="mx-auto -mt-2 max-w-2xl rounded-2xl border border-slate-100 bg-white p-5 text-center shadow-[0_18px_42px_rgba(15,23,42,.15)] sm:p-7"><span className="mx-auto grid size-14 place-items-center rounded-full bg-[#3d79ae] text-white shadow-md"><GraduationCap/></span><p className="mt-3 text-xs font-bold uppercase tracking-wider text-[#356b9a]">Ruang peserta · {session.user.nama}</p><h1 className="mt-1 text-2xl font-bold">{assessmentFilter === 'simulasi' ? 'Simulasi ANBK / TKA' : 'Pilih asesmen'}</h1><p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-600">Pilih jenjang dan mata pelajaran. Daftar berikut hanya memuat asesmen yang ditugaskan kepadamu oleh tutor.</p>
    <div className="mt-5 grid gap-3 text-left sm:grid-cols-2"><label className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-700"><span>Jenjang pendidikan</span><select aria-label="Jenjang pendidikan" className="min-h-12 min-w-0 rounded-xl border border-slate-300 bg-white px-3" value={gradeFilter} onChange={(event) => updateSelection({ jenjang: event.target.value })}><option value="">Sesuai akun / semua jenjang</option>{(availableLevels.length ? availableLevels : [1, 2, 3]).map((level) => <option key={level} value={level}>{['Paket A / setara SD/MI', 'Paket B / setara SMP/MTs', 'Paket C / setara SMA/MA'][level - 1] || `Jenjang ${level}`}</option>)}</select></label>
    <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-700"><span>Jenis mata pelajaran</span><select aria-label="Jenis mata pelajaran" className="min-h-12 min-w-0 rounded-xl border border-slate-300 bg-white px-3" value={subjectCategoryFilter} onChange={(event) => updateSelection({ kategori_mapel: event.target.value })}><option value="wajib">Mata Pelajaran Wajib</option><option value="pilihan">Mata Pelajaran Pilihan</option></select></label>
    <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-700 sm:col-span-2"><span>Mata pelajaran</span><select aria-label="Mata pelajaran" className="min-h-12 min-w-0 rounded-xl border border-slate-300 bg-white px-3" value={subjectFilter} onChange={(event) => updateSelection({ mapel: event.target.value })}><option value="">Semua mapel yang ditugaskan</option>{availableSubjects.map((name) => <option key={name} value={name}>{name}</option>)}</select></label></div>
    <p className="mt-4 text-left text-xs text-slate-500">Identitas peserta dan penugasan diverifikasi oleh akun sekolah. Pilihan jenjang tidak memberi akses ke asesmen yang tidak ditugaskan.</p></section>
  <div role="tablist" aria-label="Jenis asesmen" className="flex gap-2 overflow-x-auto rounded-2xl border bg-white p-2 shadow-sm">{filters.map((filter) => <button key={filter.id} type="button" role="tab" aria-selected={assessmentFilter === filter.id} onClick={() => updateSelection({ jenis: filter.id === 'semua' ? '' : filter.id, ...(filter.id === 'simulasi' ? {} : { jenjang: '', mapel: '' }) })} className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-semibold transition ${assessmentFilter === filter.id ? 'bg-brand text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}>{filter.label}{filter.id === 'semua' ? ` · ${assessments.length}` : ` · ${assessments.filter((row) => row.kind === filter.id).length}`}</button>)}</div>
  {loading ? <Panel className="p-6 text-slate-600">Memuat asesmen…</Panel> : visibleAssessments.length ? <div className="grid gap-3">{visibleAssessments.map((row) => { const activeAttempt = history.find((past) => past.assessmentId === row.id && past.status === 'started'); return <Panel key={row.id} className="overflow-hidden"><div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"><div className="min-w-0"><span className="inline-flex min-h-7 items-center rounded-full bg-sky-50 px-3 text-xs font-bold text-brand">{row.kind === 'simulasi' ? 'Simulasi ANBK / TKA' : 'Ujian Online'}</span><h2 className="mt-2 text-lg font-bold">{row.title}</h2><p className="mt-1 text-sm text-slate-600">{row.subjectName || 'Mata pelajaran sesuai penugasan'}{row.className ? ` · ${row.className}` : ''}{row.room ? ` · ${row.room}` : ''}</p><p className="mt-1 text-xs text-slate-500">Durasi {row.durationMinute} menit{row.startsAt ? ` · Mulai ${new Date(row.startsAt).toLocaleString('id-ID')}` : ''}{row.endsAt ? ` · Tenggat ${new Date(row.endsAt).toLocaleString('id-ID')}` : ''}</p>{row.description && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{row.description}</p>}</div><Action className="w-full shrink-0 sm:w-auto" onClick={() => activeAttempt ? void openAttempt(activeAttempt.id) : chooseAssessment(row)}><Play className="size-4"/>{activeAttempt ? 'Lanjutkan pengerjaan' : 'Pilih asesmen'}</Action></div></Panel> })}</div> : <Panel className="p-7 text-center"><FileCheck2 className="mx-auto size-9 text-slate-400"/><h2 className="mt-3 font-bold">{assessments.length ? 'Tidak ada asesmen pada kategori ini' : 'Belum ada asesmen yang ditugaskan'}</h2><p className="mt-1 text-sm text-slate-600">{assessments.length ? 'Pilih kategori lain untuk melihat penugasan yang tersedia.' : 'Jika kamu merasa seharusnya ada ujian, tanyakan kepada tutor.'}</p></Panel>}
  {history.length > 0 && <Panel className="overflow-hidden"><div className="border-b p-4"><h2 className="font-bold">Riwayat pengerjaan</h2><p className="mt-1 text-sm text-slate-600">Hasil hanya terlihat sesuai kebijakan tutor.</p></div><div className="divide-y">{history.slice(0, 10).map((row) => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><b>{row.title}</b><p className="mt-1 text-sm text-slate-500">Percobaan {row.number} · {row.status}</p></div>{row.resultAvailable ? <Action variant="secondary" onClick={() => void showResult(row.id)}>Lihat hasil{row.score !== undefined ? ` · ${row.score}` : ''}</Action> : row.status === 'pending_grade' ? <span className="text-sm text-amber-800">Menunggu penilaian</span> : <span className="text-sm text-slate-500">Hasil belum dirilis</span>}</div>)}</div></Panel>}<p className="text-center text-xs leading-relaxed text-slate-500">Simulasi mandiri PKBM Tunas Ilmu · Pola alur asesmen merujuk pada <a href="https://pusmendik.kemendikdasmen.go.id/tka/simulasi_tka/" target="_blank" rel="noreferrer" className="font-semibold text-[#356b9a] underline">Simulasi TKA Pusmendik</a>. Bukan aplikasi resmi pemerintah.</p></main>
  {resultLoading && <div className="fixed inset-0 z-50 grid place-items-center bg-white/80 text-slate-700" role="status">Memuat hasil…</div>}
  </div>
}
