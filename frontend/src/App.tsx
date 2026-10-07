import { lazy, Suspense, useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from 'react'
import { Activity, Archive, ArrowDown, ArrowUp, BarChart3, BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardList, Cloud, Copy, Download, GraduationCap, GripVertical, LayoutDashboard, LogOut, Pencil, Play, Plus, Send, Settings2, ShieldCheck, Trash2, UsersRound, type LucideIcon } from 'lucide-react'
import { api, ApiError, loadSession, saveSession, type Session } from './api'
import type { QuestionFolder } from './QuestionEditor'
import { questionTypes } from './questionTypes'
import { QuestionAnswerControl, StimulusContent, type AnswerFile, type StudentQuestion } from './QuestionAnswerControl'
import { Link, useLocation, useNavigate } from 'react-router-dom'

const QuestionEditor = lazy(() => import('./QuestionEditor').then((module) => ({ default: module.QuestionEditor })))
const StudentPortal = lazy(() => import('./StudentPortal').then((module) => ({ default: module.StudentPortal })))
const QuestionPackages = lazy(() => import('./QuestionPackages').then((module) => ({ default: module.QuestionPackages })))
const StudentRoster = lazy(() => import('./StudentRoster').then((module) => ({ default: module.StudentRoster })))
const FormCanvas = lazy(() => import('./forms/FormCanvas').then(m=>({default:m.FormCanvas})))
const FormPreview = lazy(() => import('./forms/FormPreview').then(m=>({default:m.FormPreview})))
const FormsHome = lazy(() => import('./forms/FormsHome').then(m=>({default:m.FormsHome})))
const StudentEntry = lazy(() => import('./forms/StudentEntry').then(m=>({default:m.StudentEntry})))

function ScreenLoading({ label }: { label: string }) {
  return <div role="status" className="grid min-h-48 place-items-center rounded-2xl border bg-white p-6 text-center text-slate-600"><span>{label}</span></div>
}

type Question = { id: string; revision?: number; folderId?: string; usedCount?: number; updatedAt?: string; title: string; type: string; prompt: string; description: string; configJson: string; answerJson?: string; rubricJson?: string; stimulusJson?: string; points: number; status: string; templatePlaceholder?: boolean; grade?: number; program?: string; phase?: string; mode?: string; subject?: string; domain?: string; topic?: string; competency?: string; cognitiveLevel?: string; difficulty?: string; estimatedMinutes?: number; curriculum?: string; tags?: string; internalExplanation?: string }
function questionFolderLabel(folder: QuestionFolder, folders: QuestionFolder[]) {
  const parts = [folder.subject]
  const ancestors: string[] = []
  let parent = folders.find((row) => row.id === folder.parentId)
  const seen = new Set<string>()
  while (parent && !seen.has(parent.id)) { seen.add(parent.id); ancestors.unshift(parent.name); parent = folders.find((row) => row.id === parent?.parentId) }
  parts.push(...ancestors, folder.name)
  return parts.filter((part, index) => part && parts.indexOf(part) === index).join(' · ')
}
type Assessment = { id: string; kind: string; title: string; description: string; classId: string; room?: string; subjectId: string; status: string; durationMinute: number; randomize: boolean; randomizeOptions?: boolean; showResult: boolean; showReview?: boolean; startsAt?: string; endsAt?: string; accessCode?: string; accessCodeConfigured?: boolean; instructions?: string; maxAttempts?: number; passScore?: number; resultsPolicy?: string; revision: number }
type AssessmentTemplate = { id: string; title: string; description: string; kind: string; durationMinute: number; questionCount: number; multipleChoiceCount: number; essayCount: number }
const assessmentTemplates: AssessmentTemplate[] = [
  { id: 'semester-40-pg-5-esai', title: 'Ujian Semester', description: '40 pilihan ganda + 5 esai · 90 menit', kind: 'ujian_online', durationMinute: 90, questionCount: 45, multipleChoiceCount: 40, essayCount: 5 },
  { id: 'tryout-20-pg', title: 'Try-out', description: '20 pilihan ganda · 60 menit', kind: 'ujian_online', durationMinute: 60, questionCount: 20, multipleChoiceCount: 20, essayCount: 0 },
  { id: 'kuis-10-pg', title: 'Kuis', description: '10 pilihan ganda · 30 menit', kind: 'ujian_online', durationMinute: 30, questionCount: 10, multipleChoiceCount: 10, essayCount: 0 },
]
type Kelas = { id: string; nama: string; jenjang: number; pokjarId?: string; kelompokBelajar?: string; tahunAjaran?: string; manualFallback?: boolean }
type MasterStudent = { id: string; nama: string; nis?: string; nisn: string; jenisKelamin?: string; kelasId: string; kelas?: string; jenjang?: number; pokjarId?: string; kelompokBelajar?: string; tahunAjaran?: string; program?: string; active?: boolean }
type Attempt = { id: string; assessmentId: string; studentId?: string; studentName?: string; classIdAtAttempt?: string; number?: number; status: string; deadlineAt?: string; startedAt?: string; submittedAt?: string; needsManual?: boolean; score: number }
type AttemptItem = { id: string; position: number; flagged: boolean; answer?: string; revision: number; question: StudentQuestion }
type Notice = { kind: 'ok' | 'error'; text: string } | null
const localDateInput = (value?: string) => { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
const scheduleDatePart = (value: string) => value.slice(0, 10)
const scheduleTimePart = (value: string) => value ? value.slice(11, 16) || '00:00' : ''
function formatAnswerKey(question: StudentQuestion & { answerJson?: string; configJson?: string }) {
  const parse = (raw?: string) => { try { return raw ? JSON.parse(raw) as any : null } catch { return null } }
  const config = parse(question.configJson) || {}
  const key = parse(question.answerJson)
  const choices: Array<{ id: string; text: string }> = config.choices || []
  const choiceText = (id: unknown) => choices.find((row) => row.id === id)?.text || String(id)
  if (question.type === 'pg_tunggal' || question.type === 'dropdown') return choiceText(Array.isArray(config.correctIds) ? config.correctIds[0] : key)
  if (question.type === 'pg_kompleks') return (Array.isArray(config.correctIds) ? config.correctIds : Array.isArray(key) ? key : []).map(choiceText).join(' · ')
  if (question.type === 'benar_salah') return (config.statements || []).map((row: { text: string; correct: boolean }) => `${row.text}: ${row.correct ? 'Benar' : 'Salah'}`).join('\n')
  if (question.type === 'menjodohkan') return Object.entries(config.pairs || key || {}).map(([leftId, rightId]) => `${(config.left || []).find((row: { id: string }) => row.id === leftId)?.text || leftId} → ${(config.right || []).find((row: { id: string }) => row.id === rightId)?.text || rightId}`).join('\n')
  if (question.type === 'susun_urutan') return (config.correctOrder || key || []).map(choiceText).join(' → ')
  if (question.type === 'kisi_pg' || question.type === 'kisi_checkbox') {
    const rows = question.type === 'kisi_pg' ? config.gridCorrect || key || {} : config.gridMultiCorrect || key || {}
    return Object.entries(rows).map(([rowId, columnId]) => `${(config.rows || []).find((row: { id: string }) => row.id === rowId)?.text || rowId}: ${Array.isArray(columnId) ? columnId.map((id) => (config.columns || []).find((column: { id: string }) => column.id === id)?.text || id).join(', ') : (config.columns || []).find((column: { id: string }) => column.id === columnId)?.text || columnId}`).join('\n')
  }
  if (['isian_singkat', 'tanggal', 'waktu'].includes(question.type)) return (config.acceptedAnswers || key || []).join(' · ')
  if (['skala_linear', 'rating'].includes(question.type)) return String(config.correctNumber ?? key ?? '—')
  if (question.type === 'uraian') return 'Dinilai manual berdasarkan rubrik.'
  if (question.type === 'unggah_berkas') return 'Dinilai manual oleh tutor.'
  return '—'
}

const kinds = questionTypes

function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</section> }
function Button({ children, className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) { const colors = variant === 'primary' ? 'bg-brand text-white hover:bg-brand-dark' : variant === 'danger' ? 'bg-rose-600 text-white hover:bg-rose-700' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'; return <button {...props} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${colors} ${className}`}>{children}</button> }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-700 [&_input]:w-full [&_input]:min-w-0 [&_select]:w-full [&_select]:min-w-0 [&_textarea]:w-full [&_textarea]:min-w-0"><span>{label}</span>{children}</label> }
function NoticeBox({ notice }: { notice: Notice }) { return notice ? <div role="alert" className={`rounded-xl border p-3 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{notice.text}</div> : null }

export function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [session, setSession] = useState<Session | null>(loadSession())
  const [notice, setNotice] = useState<Notice>(null)
  const [formsEnabled,setFormsEnabled]=useState<boolean|null>(null)
  const [configurationError,setConfigurationError]=useState(''),[configurationRetry,setConfigurationRetry]=useState(0)
  useEffect(()=>{
    let active=true;const controller=new AbortController();
    setConfigurationError('');
    const timer=window.setTimeout(()=>controller.abort(),10000);
    void api<{formsEnabled?:boolean}>('/public/config',{signal:controller.signal},null)
      .then(c=>{if(active)setFormsEnabled(Boolean(c.formsEnabled))})
      .catch(error=>{if(active){if(error instanceof ApiError&&error.status===404)setFormsEnabled(false);else setConfigurationError('Konfigurasi belum dapat dimuat. Periksa koneksi lalu coba lagi.')}})
      .finally(()=>clearTimeout(timer));
    return()=>{active=false;clearTimeout(timer);controller.abort()}
  },[configurationRetry])
  const tab = routeTab(location.pathname, new URLSearchParams(location.search))
  const questionLibrary = new URLSearchParams(location.search).get('tab') === 'questions'
  const setTab = (next: string) => navigate(routePath(next))
  const logout = () => { saveSession(null); setSession(null); navigate('/', { replace: true }) }
  if (location.pathname === '/sso/callback') return <SSOCallback onComplete={(next, nextPath) => { saveSession(next); setSession(next); navigate(nextPath, { replace: true }) }} />
  if (formsEnabled === null) return configurationError?<main className="mx-auto grid min-h-screen max-w-xl content-center gap-4 p-6"><p role="alert">{configurationError}</p><Button onClick={()=>setConfigurationRetry(n=>n+1)}>Coba lagi</Button></main>:<ScreenLoading label="Menyiapkan aplikasi CBT…"/>
  if (!session) return formsEnabled&&!new URLSearchParams(location.search).has('masuk')?<Suspense fallback={<ScreenLoading label="Menyiapkan akses…"/>}><StudentEntry onLogin={next=>{saveSession(next);setSession(next)}}/></Suspense>:<Login onLogin={(next) => { saveSession(next); setSession(next) }} />
  if (session.user.role === 'siswa') return <Suspense fallback={<main className="min-h-screen bg-slate-50 p-4"><ScreenLoading label="Menyiapkan ruang asesmen…"/></main>}><StudentPortal session={session} onLogout={logout} formsEnabled={formsEnabled}/></Suspense>
  const editorRoute=location.pathname.match(/^\/editor\/(assessment|package)\/([^/]+)(?:\/preview)?$/)
  if(formsEnabled&&editorRoute){const Canvas=location.pathname.endsWith('/preview')?FormPreview:FormCanvas;return <Suspense fallback={<ScreenLoading label="Menyiapkan editor…"/>}><Canvas key={`${editorRoute[1]}:${editorRoute[2]}`} kind={editorRoute[1] as 'assessment'|'package'} id={decodeURIComponent(editorRoute[2])} session={session}/></Suspense>}
  const nav: Array<[string, LucideIcon, string]> = [['dashboard', LayoutDashboard, 'Ringkasan'], ['students', UsersRound, 'Data Siswa'], ['questions', BookOpen, 'Bank Soal'], ['assessments', ClipboardList, 'Ujian & Simulasi'], ['schedule', CalendarDays, 'Jadwal'], ['monitor', Activity, 'Monitor live'], ['results', BarChart3, 'Hasil'], ['sync', Cloud, 'Sinkronisasi']]
  if(formsEnabled){nav.find(n=>n[0]==='assessments')![2]='Ujian Online';nav.splice(4,0,['simulations',BookOpen,'Simulasi'])}
  const navGroups = [
    { title: 'MULAI', ids: ['dashboard', 'students', 'assessments', 'simulations', 'questions'] },
    { title: 'PANTAU & NILAI', ids: ['schedule', 'monitor', 'results'] },
    { title: 'KONEKSI', ids: ['sync'] },
  ]
  return <div className="min-h-screen bg-slate-50">
    <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3"><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-brand text-white"><GraduationCap /></span><div><p className="text-xs font-bold uppercase tracking-wider text-brand">PKBM Tunas Ilmu</p><h1 className="font-bold">CBT & Asesmen</h1></div></div><div className="flex items-center gap-3"><span className="hidden text-right text-sm sm:block"><b>{session.user.nama}</b><br/><span className="text-slate-500">{session.user.role}</span></span><Button variant="secondary" aria-label="Keluar" onClick={logout}><LogOut className="size-4"/><span className="hidden sm:inline">Keluar</span></Button></div></div></header>
    <div className="mx-auto grid max-w-7xl gap-5 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="Navigasi utama" className="flex gap-3 overflow-x-auto pb-1 lg:block lg:space-y-4 lg:overflow-visible lg:pb-0">
        {navGroups.map((group) => <div key={group.title} className="flex shrink-0 gap-2 lg:block lg:space-y-1">
          <p className="hidden px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400 lg:block">{group.title}</p>
          {nav.filter(([id]) => group.ids.includes(id)).map(([id, Icon, label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)} className={`flex min-h-11 shrink-0 items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold ${tab === id ? 'bg-brand text-white' : 'text-slate-600 hover:bg-white'}`}><Icon className="size-4"/>{label}</button>)}
        </div>)}
      </nav>
      <main className="min-w-0 space-y-4"><NoticeBox notice={notice}/><Suspense fallback={<ScreenLoading label="Menyiapkan ruang kerja…"/>}>
        {tab==='dashboard'&&<Dashboard session={session} onNavigate={setTab}/>}
        {tab==='students'&&<StudentRoster session={session} notify={setNotice}/>}
        {tab==='questions'&&(formsEnabled&&!new URLSearchParams(location.search).has('legacy')&&!questionLibrary&&!location.pathname.startsWith('/soal/paket/')?<FormsHome kind="package" session={session}/>:questionLibrary?<QuestionLibrary session={session} notify={setNotice}/>:<QuestionPackages session={session} notify={setNotice}/>)}
        {(tab==='assessments'||tab==='simulations')&&(formsEnabled&&!new URLSearchParams(location.search).has('legacy')?<FormsHome kind="assessment" assessmentKind={tab==='simulations'?'simulasi':'ujian_online'} session={session}/>:<AssessmentBuilder session={session} notify={setNotice} onSync={()=>setTab('sync')}/>)}
        {tab==='schedule'&&<SchedulePanel session={session}/>} {tab==='monitor'&&<LiveMonitor session={session}/>} {tab==='results'&&<Results session={session}/>} {tab==='sync'&&<SyncPanel session={session} notify={setNotice}/>}
      </Suspense></main>
    </div>
  </div>
}

function SSOCallback({ onComplete }: { onComplete: (session: Session, nextPath: string) => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const ticket = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('ticket') || ''
    window.history.replaceState(null, '', '/sso/callback')
    if (!ticket) {
      setBusy(false)
      setError('Tiket masuk tidak ditemukan. Mulai kembali melalui LMS.')
      return
    }
    void api<Session & { nextPath?: string }>('/auth/sso/exchange', { method: 'POST', body: JSON.stringify({ ticket }) }, null)
      .then((response) => onComplete({ accessToken: response.accessToken, user: response.user }, response.nextPath || '/'))
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Masuk melalui LMS gagal. Silakan coba kembali.'))
      .finally(() => setBusy(false))
  }, [onComplete])
  return <main className="grid min-h-screen place-items-center bg-slate-50 p-4"><section className="w-full max-w-lg rounded-2xl border bg-white p-6 text-center shadow-sm"><div className={`mx-auto mb-4 size-8 rounded-full border-2 ${busy ? 'animate-spin border-brand border-t-transparent' : 'border-slate-200'}`} role="status" aria-label={busy ? 'Memverifikasi sesi LMS' : undefined}/><h1 className="text-xl font-bold">{busy ? 'Memverifikasi sesi LMS…' : error ? 'Belum dapat masuk' : 'Sesi CBT siap'}</h1><p className="mt-2 text-sm text-slate-600">Identitas dan hak akses diverifikasi oleh LMS. Password LMS tidak dikirim ke CBT.</p>{error && <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}<a href="/sso/start" className="mt-3 inline-block min-h-11 font-semibold underline">Mulai lagi melalui LMS</a></div>}</section></main>
}

function routeTab(pathname: string, _search: URLSearchParams) {
  if (pathname === '/soal' || pathname === '/bank-soal' || pathname.startsWith('/soal/paket/')) return 'questions'
  if (pathname === '/simulasi') return 'simulations'
  if (pathname === '/ujian') return 'assessments'
  if (pathname === '/jadwal') return 'schedule'
  if (pathname === '/monitor') return 'monitor'
  if (pathname === '/hasil') return 'results'
  if (pathname === '/sinkronisasi') return 'sync'
  if (pathname === '/data-siswa') return 'students'
  return 'dashboard'
}

function routePath(tab: string) {
  if (tab === 'questions') return '/soal'
  if (tab === 'questions-library') return '/soal?tab=questions'
  if (tab === 'assessments') return '/ujian'
  if (tab === 'simulations') return '/simulasi'
  if (tab === 'schedule') return '/jadwal'
  if (tab === 'monitor') return '/monitor'
  if (tab === 'results') return '/hasil'
  if (tab === 'sync') return '/sinkronisasi'
  if (tab === 'students') return '/data-siswa'
  return '/'
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [mode, setMode] = useState<'staff' | 'student' | 'student-account'>('student')
  const [service, setService] = useState<'ujian_online' | 'simulasi'>('simulasi')
  const [entryStage, setEntryStage] = useState<'choose' | 'login'>('choose')
  const [gradeLevel, setGradeLevel] = useState('1')
  const [subjectCategory, setSubjectCategory] = useState('wajib')
  const [subject, setSubject] = useState('Bahasa Indonesia')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [nisn, setNisn] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const simulationSubjects = gradeLevel === '3'
    ? subjectCategory === 'wajib' ? ['Bahasa Indonesia', 'Matematika', 'Bahasa Inggris'] : ['Ekonomi', 'Sosiologi', 'Geografi']
    : subjectCategory === 'wajib' ? ['Bahasa Indonesia', 'Matematika'] : []
  const nextPath = (() => {
    if (mode === 'staff') return '/'
    const params = new URLSearchParams({ jenis: service })
    if (service === 'simulasi') {
      params.set('jenjang', gradeLevel)
      params.set('kategori_mapel', subjectCategory)
      if (subject) params.set('mapel', subject)
    }
    return `/?${params.toString()}`
  })()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode !== 'student') {
        const next = await api<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }, null)
        if (mode === 'student-account' && next.user.role !== 'siswa') throw new Error('Gunakan menu Tutor / Admin untuk akun staf.')
        if (mode === 'staff' && next.user.role === 'siswa') throw new Error('Akun siswa harus masuk melalui menu Peserta.')
        onLogin(next)
      } else {
        const data = await api<{ accessToken: string; student: { id: string; nama: string } }>('/public/ujian-online/cek', { method: 'POST', body: JSON.stringify({ nisn, accessCode }) }, null)
        onLogin({ accessToken: data.accessToken, user: { id: data.student.id, username: nisn, nama: data.student.nama, role: 'siswa', pesertaDidikId: data.student.id } })
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login gagal')
    } finally {
      setBusy(false)
    }
  }
  const tab = (value: 'student' | 'student-account' | 'staff', label: string) => <button type="button" onClick={() => { setMode(value); setError('') }} className={`min-h-12 rounded-lg px-2 text-xs font-bold sm:text-sm ${mode === value ? 'bg-white text-brand shadow' : 'text-slate-500'}`}>{label}</button>

  return <main className="relative min-h-screen overflow-hidden bg-[#f4f7fb] px-4 pb-8 pt-28 sm:pt-32">
    <div aria-hidden="true" className="absolute inset-x-0 top-0 h-60 overflow-hidden bg-[#356b9a]"><div className="absolute inset-0 opacity-40 [background-image:linear-gradient(32deg,transparent_0_17%,rgba(255,255,255,.12)_17.2%_35%,transparent_35.2%),linear-gradient(145deg,transparent_0_28%,rgba(17,87,147,.55)_28.2%_56%,transparent_56.2%)]"/><div className="absolute inset-0 opacity-[.08] [background-image:radial-gradient(#fff_1px,transparent_1px)] [background-size:22px_22px]"/></div>
    <header className="absolute inset-x-0 top-0 z-10 mx-auto flex max-w-6xl items-center gap-3 px-4 py-5 text-white"><span className="grid size-11 place-items-center rounded-full border border-white/30 bg-white/10"><GraduationCap/></span><div><p className="text-sm font-black tracking-wide">PKBM TUNAS ILMU</p><p className="text-xs text-blue-100">SIMULASI ANBK · TKA</p></div></header>
    <Card className="relative mx-auto w-full max-w-xl overflow-hidden border-0 p-5 shadow-[0_24px_55px_rgba(15,23,42,.22)] sm:p-8">
      {entryStage === 'choose' ? <>
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-[#3d79ae] text-white shadow-lg"><GraduationCap/></div>
        <div className="text-center"><p className="text-xs font-bold uppercase tracking-wider text-[#356b9a]">Ruang asesmen sekolah</p><h1 className="mt-1 text-2xl font-bold">{service === 'simulasi' ? 'Simulasi TKA' : 'Ujian Online'}</h1><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-600">{service === 'simulasi' ? 'Pilih jenjang dan mata pelajaran untuk memulai simulasi.' : 'Lanjutkan untuk melihat ujian online yang ditugaskan kepadamu.'}</p></div>
        {service === 'simulasi' && <div className="mt-5 grid gap-4">
          <Field label="Jenjang pendidikan"><select aria-label="Jenjang pendidikan" className="min-h-12 rounded-xl border border-slate-300 bg-white px-3" value={gradeLevel} onChange={(event) => { setGradeLevel(event.target.value); setSubjectCategory('wajib'); setSubject('Bahasa Indonesia') }}><option value="1">Paket A / setara SD/MI</option><option value="2">Paket B / setara SMP/MTs</option><option value="3">Paket C / setara SMA/MA</option></select></Field>
          <Field label="Jenis mata pelajaran"><select aria-label="Kategori mata pelajaran simulasi" className="min-h-12 rounded-xl border border-slate-300 bg-white px-3" value={subjectCategory} onChange={(event) => { setSubjectCategory(event.target.value); setSubject('') }}><option value="wajib">Mata Pelajaran Wajib</option>{gradeLevel === '3' && <option value="pilihan">Mata Pelajaran Pilihan</option>}</select></Field>
          <Field label="Mata pelajaran"><select aria-label="Mata pelajaran simulasi" required className="min-h-12 rounded-xl border border-slate-300 bg-white px-3" value={subject} onChange={(event) => setSubject(event.target.value)}><option value="">Pilih mata pelajaran…</option>{simulationSubjects.map((name) => <option value={name} key={name}>{name}</option>)}</select></Field>
        </div>}
        {service === 'ujian_online' && <p className="mt-5 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm leading-relaxed text-sky-950">Setelah masuk, kamu akan melihat ujian online yang ditugaskan kepadamu. Gunakan kode akses dari tutor saat verifikasi.</p>}
        <Button type="button" className="mt-6 min-h-12 w-full bg-[#3478b5] hover:bg-[#2c669a]" disabled={service === 'simulasi' && !subject} onClick={() => { setMode('student'); setEntryStage('login') }}><Play className="size-4"/>{service === 'simulasi' ? 'Mulai Simulasi' : 'Lanjutkan ke Ujian Online'}</Button>
        <button type="button" className="mx-auto mt-2 block min-h-11 px-3 text-sm font-semibold text-slate-600 underline" onClick={() => { setService(service === 'simulasi' ? 'ujian_online' : 'simulasi'); setError('') }}>{service === 'simulasi' ? 'Beralih ke Ujian Online' : 'Kembali ke Simulasi TKA'}</button>
        <p className="mt-5 border-t pt-4 text-center text-xs leading-relaxed text-slate-500">Simulasi mandiri PKBM Tunas Ilmu. Pola alur asesmen merujuk pada <a href="https://pusmendik.kemendikdasmen.go.id/tka/simulasi_tka/" target="_blank" rel="noreferrer" className="font-semibold text-[#356b9a] underline">Simulasi TKA Pusmendik</a>; aplikasi ini tidak dikelola atau mewakili Kemendikdasmen.</p>
        <button type="button" className="mx-auto mt-3 block min-h-11 px-3 text-sm font-semibold text-slate-600 underline" onClick={() => { setMode('staff'); setEntryStage('login') }}>Masuk tutor / administrator CBT</button>
      </> : <>
        <div className="mb-5 flex items-start gap-3"><span className="grid size-12 shrink-0 place-items-center rounded-full bg-[#3d79ae] text-white"><GraduationCap/></span><div><p className="text-xs font-bold uppercase tracking-wider text-[#356b9a]">Masuk sesi</p><h1 className="text-2xl font-bold">Selamat datang</h1><p className="mt-1 text-sm text-slate-600">Gunakan akun sekolah yang sudah terdaftar.</p></div></div>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-100 bg-sky-50 p-3 text-sm"><div><b>{service === 'simulasi' ? `Simulasi · Paket ${['A', 'B', 'C'][Number(gradeLevel) - 1]} · ${subject}` : 'Ujian Online'}</b><p className="text-xs text-slate-600">Pilihan asesmenmu</p></div><button type="button" className="min-h-10 px-2 font-semibold text-[#356b9a] underline" onClick={() => { setEntryStage('choose'); setError('') }}>Ubah pilihan</button></div>
        <a href={`/sso/start?next=${encodeURIComponent(nextPath)}`} className="flex min-h-12 w-full items-center justify-center rounded-full bg-[#0878ed] px-4 text-center font-semibold text-white hover:bg-blue-700">Masuk dengan akun LMS</a>
        <p className="mt-2 text-center text-xs leading-relaxed text-slate-500">Masukkan username dan kata sandi di halaman LMS yang aman. CBT tidak menerima atau menyimpan kata sandi LMS.</p>
        <div className="my-5 flex items-center gap-3 text-xs font-semibold text-slate-400"><span className="h-px flex-1 bg-slate-200"/>ATAU<span className="h-px flex-1 bg-slate-200"/></div>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-3 rounded-xl bg-slate-100 p-1">{tab('student', 'NISN + kode')}{tab('student-account', 'Siswa lokal')}{tab('staff', 'Tutor / Admin')}</div>
          {mode === 'student' ? <>
            <Field label="NISN"><input required value={nisn} onChange={(e) => setNisn(e.target.value)} className="min-h-12 rounded-xl border border-slate-300 px-3" placeholder="Masukkan NISN" autoComplete="username"/></Field>
            <Field label="Kode akses ujian"><input required value={accessCode} onChange={(e) => setAccessCode(e.target.value)} className="min-h-12 rounded-xl border border-slate-300 px-3" placeholder="Diberikan tutor" autoComplete="one-time-code"/></Field>
          </> : mode === 'student-account' ? <>
            <p className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900">Akun siswa dari LMS gunakan tombol Masuk dengan akun LMS. Form ini hanya untuk akun CBT siswa lokal yang belum ditautkan.</p>
            <Field label="Username siswa"><input required value={username} onChange={(e) => setUsername(e.target.value)} className="min-h-12 rounded-xl border border-slate-300 px-3" autoComplete="username"/></Field>
            <Field label="Kata sandi"><input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-12 rounded-xl border border-slate-300 px-3" autoComplete="current-password"/></Field>
          </> : <>
            <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Akun tutor yang tersinkron dari LMS masuk melalui SSO. Login ini hanya untuk akun CBT lokal darurat.</p>
            <Field label="Username CBT"><input required value={username} onChange={(e) => setUsername(e.target.value)} className="min-h-12 rounded-xl border border-slate-300 px-3" autoComplete="username"/></Field>
            <Field label="Kata sandi"><input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-12 rounded-xl border border-slate-300 px-3" autoComplete="current-password"/></Field>
          </>}
          {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
          <Button type="submit" className="w-full bg-[#0878ed] hover:bg-blue-700" disabled={busy}>{busy ? 'Memeriksa…' : mode === 'student' ? 'Lihat ujian' : mode === 'student-account' ? 'Masuk sebagai siswa' : 'Masuk ke workspace'}</Button>
        </form>
        <p className="mt-5 border-t pt-4 text-center text-xs leading-relaxed text-slate-500">Simulasi mandiri PKBM Tunas Ilmu · Referensi alur: <a href="https://pusmendik.kemendikdasmen.go.id/tka/simulasi_tka/" target="_blank" rel="noreferrer" className="font-semibold text-[#356b9a] underline">Pusmendik</a>. Bukan aplikasi resmi pemerintah.</p>
      </>}
    </Card>
  </main>
}

function Dashboard({ session, onNavigate }: { session: Session; onNavigate: (tab: string) => void }) {
  const canWrite = session.user.role !== 'kepala_sekolah'
  return <div className="space-y-5">
    <div><p className="text-sm font-bold uppercase tracking-wider text-brand">Beranda tutor</p><h2 className="mt-1 text-2xl font-bold">Halo, {session.user.nama}</h2><p className="mt-1 text-slate-600">Semua pekerjaan asesmen dimulai dari sini.</p></div>
    <Card className="overflow-hidden border-sky-200">
      <div className="grid gap-5 bg-gradient-to-br from-sky-50 to-white p-5 sm:p-7 lg:grid-cols-[1fr_auto] lg:items-center">
        <div><p className="text-xs font-bold uppercase tracking-wider text-sky-800">Mulai di sini</p><h3 className="mt-1 text-xl font-bold">Buat formulir asesmen</h3><p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">Tidak perlu mengatur semuanya sekaligus. Tulis soal, pilih peserta, cek pratinjau, lalu terbitkan. Draf tersimpan otomatis dan bisa dilanjutkan nanti.</p></div>
        {canWrite ? <Button type="button" className="min-h-12 w-full sm:w-auto" onClick={() => onNavigate('assessments')}><Plus className="size-4"/>Buat asesmen</Button> : <Button type="button" variant="secondary" className="min-h-12 w-full sm:w-auto" onClick={() => onNavigate('assessments')}>Lihat asesmen</Button>}
      </div>
      <ol className="grid gap-3 border-t border-sky-100 p-5 sm:grid-cols-3 sm:p-6">
        {[["1", "Susun pertanyaan", "Ketik soal sendiri atau pilih dari Bank Soal."], ["2", "Pilih peserta", "Tugaskan ke satu kelas atau siswa tertentu."], ["3", "Pratinjau & terbitkan", "Periksa tampilan siswa sebelum asesmen dibagikan."]].map(([number, title, detail]) => <li key={number} className="flex gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-sky-100 text-sm font-bold text-sky-900">{number}</span><span><b className="text-sm">{title}</b><span className="mt-0.5 block text-sm text-slate-600">{detail}</span></span></li>)}
      </ol>
    </Card>
    <div className="grid gap-3 sm:grid-cols-2">
      <button type="button" aria-label="Buka pustaka soal" onClick={() => onNavigate('questions')} className="rounded-2xl border bg-white p-5 text-left shadow-sm transition hover:border-sky-300 hover:shadow"><BookOpen className="mb-3 size-5 text-brand"/><h3 className="font-bold">Bank Soal</h3><p className="mt-1 text-sm text-slate-600">Simpan dan gunakan kembali soal untuk beberapa asesmen.</p><span className="mt-3 inline-block text-sm font-bold text-brand">Buka Bank Soal →</span></button>
      <button type="button" aria-label="Buka laporan nilai" onClick={() => onNavigate('results')} className="rounded-2xl border bg-white p-5 text-left shadow-sm transition hover:border-sky-300 hover:shadow"><BarChart3 className="mb-3 size-5 text-brand"/><h3 className="font-bold">Hasil & nilai</h3><p className="mt-1 text-sm text-slate-600">Periksa hasil siswa, beri nilai uraian, dan unduh laporan.</p><span className="mt-3 inline-block text-sm font-bold text-brand">Buka hasil →</span></button>
    </div>
    <Card className="p-5"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 text-emerald-600"/><div><h3 className="font-bold">Data tetap tersambung dengan LMS</h3><p className="mt-1 text-sm text-slate-600">Identitas, kelas, dan mata pelajaran berasal dari LMS. Hasil asesmen disinkronkan kembali melalui antrean aman.</p></div></div></Card>
  </div>
}

function QuestionLibrary({ session, notify }: { session: Session; notify: (value: Notice) => void }) {
  type QuestionVersionRow = { id: string; revision: number; changedBy: string; createdAt: string }
  const [questions, setQuestions] = useState<Question[]>([])
  const [folders, setFolders] = useState<QuestionFolder[]>([])
  const [selected, setSelected] = useState<Question | undefined>()
  const [mode, setMode] = useState<'simple' | 'complete'>('simple')
  const [modePicker, setModePicker] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [historyQuestion, setHistoryQuestion] = useState<Question | null>(null)
  const [historyRows, setHistoryRows] = useState<QuestionVersionRow[]>([])
  const [historyCurrentRevision, setHistoryCurrentRevision] = useState(0)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [questionImportBusy, setQuestionImportBusy] = useState(false)
  const [questionImportReport, setQuestionImportReport] = useState<{ imported: number; failed: number; errors: string[] } | null>(null)
  const canWrite = session.user.role !== 'kepala_sekolah'
  const [searchText, setSearchText] = useState('')
  const [folderFilter, setFolderFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [subjectFilter, setSubjectFilter] = useState('')
  const [gradeFilter, setGradeFilter] = useState('')
  const [difficultyFilter, setDifficultyFilter] = useState('')
  const [sortBy, setSortBy] = useState<'newest' | 'used'>('newest')
  const [folderName, setFolderName] = useState('')
  const [folderSubject, setFolderSubject] = useState('')
  const [folderParent, setFolderParent] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const load = () => api<Question[]>('/staff/questions', {}, session).then(setQuestions).catch((error) => notify({ kind: 'error', text: error.message }))
  const loadFolders = () => api<unknown>('/staff/question-folders', {}, session).then((payload) => {
    if (Array.isArray(payload)) setFolders(payload as QuestionFolder[])
    else {
      setFolders([])
      notify({ kind: 'error', text: 'Daftar folder belum dapat dibaca. Soal tetap tersedia di Bank Soal; coba muat ulang.' })
    }
  }).catch((error) => { setFolders([]); notify({ kind: 'error', text: error.message }) })
  useEffect(() => { void load(); void loadFolders() }, [])

  async function downloadQuestionImportFile(path: string, filename: string, description: string) {
    try {
      const response = await fetch(`/api/staff/questions/import/${path}`, { headers: { Authorization: `Bearer ${session.accessToken}` } })
      if (!response.ok) throw new Error(`${description} belum dapat diunduh.`)
      const objectUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : `${description} belum dapat diunduh.` }) }
  }

  async function downloadImportTemplate(format: 'csv' | 'xlsx' | 'docx') { await downloadQuestionImportFile(`template/${format}`, `template-soal-cbt.${format}`, `Template ${format.toUpperCase()}`) }
  async function downloadImportExample() { await downloadQuestionImportFile('example-20', 'contoh-20-soal-cbt.csv', 'Contoh 20 soal') }

  async function importQuestionFile(file?: File) {
    if (!file) return
    setQuestionImportBusy(true)
    setQuestionImportReport(null)
    const body = new FormData()
    body.append('file', file)
    try {
      const report = await api<{ imported: number; failed: number; errors: string[] }>('/staff/questions/import', { method: 'POST', body }, session)
      setQuestionImportReport(report)
      notify({ kind: report.failed === 0 ? 'ok' : 'error', text: `${report.imported} soal berhasil diimpor sebagai draf${report.failed ? `; ${report.failed} baris perlu diperbaiki` : ''}.` })
      void load()
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : 'File gagal diimpor.' })
    } finally { setQuestionImportBusy(false) }
  }

  function openNew(nextMode: 'simple' | 'complete') { setSelected(undefined); setMode(nextMode); setModePicker(false); setEditorOpen(true) }
  async function createFolder(event: FormEvent) {
    event.preventDefault()
    setFolderBusy(true)
    try {
      await api<QuestionFolder>('/staff/question-folders', { method: 'POST', body: JSON.stringify({ name: folderName, subject: folderSubject, parentId: folderParent }) }, session)
      setFolderName(''); setFolderParent('')
      notify({ kind: 'ok', text: 'Folder soal berhasil dibuat.' })
      void loadFolders()
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Folder gagal dibuat.' }) }
    finally { setFolderBusy(false) }
  }
  async function deleteFolder(folder: QuestionFolder) {
    if (!window.confirm(`Hapus folder “${folder.name}”? Soal dan subfolder tidak dihapus; keduanya akan dilepas dari folder ini.`)) return
    try { await api(`/staff/question-folders/${folder.id}`, { method: 'DELETE' }, session); notify({ kind: 'ok', text: 'Folder dihapus; soal tetap aman di Bank Soal.' }); setFolderFilter(''); void loadFolders(); void load() }
    catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Folder gagal dihapus.' }) }
  }
  async function moveToFolder(question: Question, folderId: string) {
    try { await api<Question>(`/staff/questions/${question.id}/folder`, { method: 'PUT', body: JSON.stringify({ revision: question.revision, folderId }) }, session); notify({ kind: 'ok', text: `Soal “${question.title}” dipindahkan ke folder.` }); void load() }
    catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Soal gagal dipindahkan.' }) }
  }
  async function completeQuestionMetadata() {
    if (!window.confirm('Isi nilai bawaan hanya pada metadata yang kosong di soal draf milikmu? Soal terbit tidak akan diubah.')) return
    try {
      const result = await api<{ updatedCount: number; publishedNeedsRevision: number }>('/staff/questions/metadata-defaults', { method: 'POST' }, session)
      notify({ kind: 'ok', text: `${result.updatedCount} soal draf dilengkapi. ${result.publishedNeedsRevision ? `${result.publishedNeedsRevision} soal terbit tetap aman dan perlu revisi terpisah.` : ''}`.trim() })
      void load()
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Metadata belum dapat dilengkapi.' }) }
  }
  async function saveQuestion(payload: Record<string, unknown>) {
    setBusy(true)
    try {
      const id = typeof payload.id === 'string' ? payload.id : ''
      const { id: _id, ...body } = payload
      await api(id ? `/staff/questions/${id}` : '/staff/questions', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }, session)
      notify({ kind: 'ok', text: id ? 'Perubahan soal tersimpan.' : 'Soal tersimpan sebagai draf di Bank Soal.' })
      setSelected(undefined)
      setModePicker(false)
      setEditorOpen(false)
      void load()
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Soal gagal disimpan' }); throw error }
    finally { setBusy(false) }
  }
  async function archive(question: Question) {
    if (!window.confirm(`Arsipkan “${question.title}”? Riwayat ujian yang sudah diterbitkan tetap aman.`)) return
    try { await api(`/staff/questions/${question.id}`, { method: 'DELETE' }, session); notify({ kind: 'ok', text: 'Soal diarsipkan dan tidak akan dihapus dari riwayat paket.' }); window.dispatchEvent(new Event('cbt-storage-updated')); void load() }
    catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Soal gagal diarsipkan' }) }
  }
  async function trash(question: Question) {
    if (!window.confirm(`Pindahkan soal “${question.title}” ke Trash? Soal tetap dapat dipulihkan dan snapshot ujian yang sudah terbit tidak berubah.`)) return
    try { await api(`/staff/questions/${question.id}/trash`, { method: 'POST' }, session); notify({ kind: 'ok', text: `Soal “${question.title}” dipindahkan ke Trash.` }); window.dispatchEvent(new Event('cbt-storage-updated')); setEditorOpen(false); setSelected(undefined); void load() }
    catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Soal gagal dipindahkan ke Trash' }) }
  }
  async function createRevision(question: Question) {
    try {
      const revision = await api<Question>(`/staff/questions/${question.id}/revision`, { method: 'POST' }, session)
      setSelected(revision)
      setMode('complete')
      setEditorOpen(true)
      notify({ kind: 'ok', text: `Revisi “${revision.title}” dibuat sebagai draf baru. Soal terbit tetap tidak berubah.` })
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Revisi soal belum dapat dibuat' }) }
  }
  async function openHistory(question: Question) {
    setHistoryBusy(true)
    try {
      const result = await api<{ currentRevision: number; versions: QuestionVersionRow[] }>(`/staff/questions/${question.id}/history`, {}, session)
      setHistoryQuestion(question)
      setHistoryRows(result.versions)
      setHistoryCurrentRevision(result.currentRevision)
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Riwayat soal gagal dimuat' }) }
    finally { setHistoryBusy(false) }
  }
  async function restoreHistory(version: QuestionVersionRow) {
    if (!historyQuestion || !window.confirm(`Pulihkan isi soal dari versi ${version.revision}? Versi aktif tetap tercatat di riwayat.`)) return
    try {
      const restored = await api<Question>(`/staff/questions/${historyQuestion.id}/restore/${version.id}`, { method: 'POST', body: JSON.stringify({ revision: historyCurrentRevision }) }, session)
      setHistoryQuestion(null)
      setSelected(restored)
      setMode('complete')
      setEditorOpen(true)
      notify({ kind: 'ok', text: `Soal dipulihkan dari versi ${version.revision}; revisi baru ${restored.revision} tercatat.` })
      void load()
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Versi soal gagal dipulihkan' }) }
  }
  const allTags = [...new Set(questions.flatMap((question) => (question.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'id'))
  const allSubjects = [...new Set(questions.map((question) => question.subject?.trim()).filter((subject): subject is string => Boolean(subject)))].sort((a, b) => a.localeCompare(b, 'id'))
  const allGrades = [...new Set(questions.map((question) => question.grade).filter((grade): grade is number => Boolean(grade)))].sort((a, b) => a - b)
  const filteredQuestions = questions.filter((question) => {
    const matchesText = `${question.title} ${question.prompt} ${question.description} ${question.subject || ''} ${question.tags || ''}`.toLowerCase().includes(searchText.trim().toLowerCase())
    const matchesFolder = !folderFilter || (folderFilter === 'unfiled' ? !question.folderId : question.folderId === folderFilter)
    const matchesTag = !tagFilter || (question.tags || '').split(',').some((tag) => tag.trim().toLocaleLowerCase() === tagFilter.toLocaleLowerCase())
    const matchesType = !typeFilter || question.type === typeFilter
    const matchesSubject = !subjectFilter || question.subject?.toLocaleLowerCase() === subjectFilter.toLocaleLowerCase()
    const matchesGrade = !gradeFilter || question.grade === Number(gradeFilter)
    const matchesDifficulty = !difficultyFilter || question.difficulty?.toLocaleLowerCase() === difficultyFilter
    return matchesText && matchesFolder && matchesTag && matchesType && matchesSubject && matchesGrade && matchesDifficulty
  }).sort((a, b) => sortBy === 'used' ? (b.usedCount || 0) - (a.usedCount || 0) || (b.updatedAt || '').localeCompare(a.updatedAt || '') : (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4"><div><p className="font-bold text-sky-950">Pustaka soal lepas</p><p className="mt-1 text-sm text-sky-900">Untuk pengelolaan rutin, kelompokkan butir soal ke dalam paket supaya detail, urutan, dan targetnya mudah ditemukan.</p></div><Link to="/soal" className="inline-flex min-h-11 items-center rounded-xl border border-sky-300 bg-white px-4 font-semibold text-sky-950">Kembali ke Paket Soal</Link></div>
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-bold uppercase tracking-wider text-brand">Pustaka soal reusable</p><h2 className="text-2xl font-bold">Bank Soal</h2><p className="mt-1 text-sm text-slate-600">Buat soal dengan kontrol visual. Kunci tetap privat dan paket terbit menyimpan snapshot sendiri.</p></div>{canWrite && <Button onClick={() => setModePicker(true)}><Plus className="size-4"/> Buat soal</Button>}</div>
    {canWrite && <details className="rounded-2xl border border-slate-200 bg-white p-4"><summary className="min-h-11 cursor-pointer py-2 font-bold">Impor soal dari CSV, Excel, atau Word</summary><div className="mt-2 space-y-4"><p className="text-sm text-slate-600">Unduh template, isi satu soal per baris, lalu pilih file. Maksimal 500 soal dan 5 MB per file; hasil impor selalu berupa draf. Baris yang gagal dilaporkan tanpa membatalkan soal lain yang berhasil.</p><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={() => void downloadImportExample()}>Unduh contoh 20 soal</Button>{(['csv', 'xlsx', 'docx'] as const).map((format) => <Button key={format} type="button" variant="secondary" onClick={() => void downloadImportTemplate(format)}>Unduh template {format.toUpperCase()}</Button>)}</div><div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-700"><p><b>Pilihan ganda/kisi:</b> pisahkan daftar dengan tanda <code>|</code>. Kunci pilihan memakai nomor mulai dari 1 atau teks pilihan yang sama persis.</p><p><b>Benar/salah:</b> satu kunci Benar atau Salah per pernyataan. <b>Menjodohkan:</b> kunci berisi nomor pilihan kanan untuk setiap item kiri.</p><p><b>Kisi kotak centang:</b> pisahkan jawaban tiap baris dengan <code>|</code>, pilihan dalam satu baris dengan <code>+</code>. <b>Uraian:</b> tulis rubrik pada kolom opsi, misalnya <code>Ketepatan:3|Penjelasan:2</code>.</p><p><b>Bahan tabel:</b> pisahkan kolom dengan <code>|</code> dan baris dengan <code>;</code>. Tautan gambar/media harus memakai HTTPS.</p></div><label className="grid max-w-xl gap-1.5 text-sm font-semibold">Pilih file soal untuk diimpor<input aria-label="Pilih file soal untuk diimpor" className="min-h-11 w-full rounded-xl border border-slate-300 bg-white p-2 text-sm" type="file" accept=".csv,.xlsx,.docx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={questionImportBusy} onChange={(event) => { void importQuestionFile(event.target.files?.[0]); event.currentTarget.value = '' }} />{questionImportBusy && <span role="status" className="font-normal text-sky-800">Memeriksa file dan menyimpan draf…</span>}</label>{questionImportReport && <section role="status" className="space-y-2 rounded-xl border border-slate-200 p-3"><p className="font-semibold">Hasil impor: {questionImportReport.imported} berhasil · {questionImportReport.failed} gagal</p>{questionImportReport.errors.length > 0 && <ul className="list-inside list-disc space-y-1 text-sm text-rose-800">{questionImportReport.errors.map((error) => <li key={error}>{error}</li>)}</ul>}</section>}</div></details>}
    {modePicker && canWrite && <Card className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold">Pilih cara membuat soal</h3><p className="mt-1 text-sm text-slate-600">Keduanya memiliki semua tipe soal. Mode sederhana merapikan pengaturan lanjutan.</p></div><Button variant="secondary" onClick={() => setModePicker(false)}>Tutup</Button></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><button type="button" className="min-h-32 rounded-2xl border-2 border-sky-200 bg-sky-50 p-4 text-left hover:border-sky-500" onClick={() => openNew('simple')}><b className="text-lg">Mulai sederhana</b><span className="mt-2 block text-sm text-slate-600">Ketik soal, pilih tipe, siapkan jawaban dan skor. Metadata tambahan bisa dibuka kapan saja.</span></button><button type="button" className="min-h-32 rounded-2xl border-2 border-slate-200 p-4 text-left hover:border-sky-500" onClick={() => openNew('complete')}><b className="text-lg">Pengaturan lengkap</b><span className="mt-2 block text-sm text-slate-600">Tampilkan jenjang, standar AKM/TKA, topik, kompetensi, dan metadata sejak awal.</span></button></div></Card>}
    {canWrite && <details className="rounded-2xl border border-slate-200 bg-white p-4"><summary className="min-h-11 cursor-pointer py-2 font-bold">Kelola folder mapel dan topik</summary><div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><form onSubmit={(event) => void createFolder(event)} className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-sm font-semibold">Nama mapel<input className="min-h-11 rounded-xl border px-3 font-normal" value={folderSubject} onChange={(event) => setFolderSubject(event.target.value)} placeholder="Contoh: Matematika" /></label><label className="grid gap-1.5 text-sm font-semibold">Nama folder/topik<input className="min-h-11 rounded-xl border px-3 font-normal" required value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="Contoh: Pecahan" /></label><label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">Di dalam folder (opsional)<select className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={folderParent} onChange={(event) => setFolderParent(event.target.value)}><option value="">Folder utama mapel</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{questionFolderLabel(folder, folders)}</option>)}</select></label><Button type="submit" disabled={folderBusy} className="sm:col-span-2"><Plus className="size-4"/>{folderBusy ? 'Menyimpan…' : 'Buat folder'}</Button></form><div className="space-y-2">{folders.length === 0 ? <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">Belum ada folder. Soal tetap aman di daftar utama.</p> : folders.map((folder) => <div key={folder.id} className="flex items-center justify-between gap-3 rounded-xl border p-3"><span className="text-sm font-medium">{questionFolderLabel(folder, folders)}</span><Button type="button" variant="danger" onClick={() => void deleteFolder(folder)}>Hapus folder</Button></div>)}</div></div></details>}
    {canWrite && <Card className="flex flex-wrap items-center justify-between gap-3 p-4"><div><h3 className="font-bold">Lengkapi metadata soal lama</h3><p className="mt-1 text-sm text-slate-600">Mengisi hanya kolom kosong pada draf: tingkat sedang, estimasi waktu berdasarkan jenis, dan status kurikulum “Belum dipetakan”. Soal terbit tidak disentuh.</p></div><Button type="button" variant="secondary" onClick={() => void completeQuestionMetadata()}>Isi nilai bawaan pada draf</Button></Card>}
    {editorOpen && canWrite && <Card className="p-5"><div className="mb-4 flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold">{selected?.id ? 'Edit soal' : mode === 'simple' ? 'Buat soal — mode sederhana' : 'Buat soal — pengaturan lengkap'}</h3><p className="text-sm text-slate-600">Tidak perlu menulis kode atau format khusus.</p></div><Button variant="secondary" onClick={() => { setEditorOpen(false); setSelected(undefined) }}>Tutup editor</Button></div><QuestionEditor key={selected?.id || `new-${mode}`} initial={selected} folders={folders} mode={mode} busy={busy} session={session} storageKey={`cbt-question-draft-${session.user.id}-${selected?.id || 'new'}`} onSave={saveQuestion} onDelete={selected?.id ? () => void trash(selected) : undefined} onCancel={selected ? () => { setEditorOpen(false); setSelected(undefined) } : undefined}/></Card>}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"><label className="block text-sm font-semibold text-slate-700"><span>Cari soal</span><input aria-label="Cari soal" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Cari judul atau isi pertanyaan" /></label><label className="block text-sm font-semibold text-slate-700">Jenis soal<select aria-label="Filter jenis soal" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">Semua jenis</option>{questionTypes.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label><label className="block text-sm font-semibold text-slate-700">Mapel<select aria-label="Filter mapel" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}><option value="">Semua mapel</option>{allSubjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}</select></label><label className="block text-sm font-semibold text-slate-700">Kelas<select aria-label="Filter kelas" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal" value={gradeFilter} onChange={(event) => setGradeFilter(event.target.value)}><option value="">Semua kelas</option>{allGrades.map((grade) => <option key={grade} value={grade}>Kelas {grade}</option>)}</select></label><label className="block text-sm font-semibold text-slate-700">Tag<select aria-label="Filter tag" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">Semua tag</option>{allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label><label className="block text-sm font-semibold text-slate-700">Kesukaran<select aria-label="Filter kesukaran" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal" value={difficultyFilter} onChange={(event) => setDifficultyFilter(event.target.value)}><option value="">Semua tingkat</option><option value="mudah">Mudah</option><option value="sedang">Sedang</option><option value="sulit">Sulit</option></select></label><label className="block text-sm font-semibold text-slate-700">Folder<select aria-label="Filter folder" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal" value={folderFilter} onChange={(event) => setFolderFilter(event.target.value)}><option value="">Semua folder</option><option value="unfiled">Belum dimasukkan</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{questionFolderLabel(folder, folders)}</option>)}</select></label><label className="block text-sm font-semibold text-slate-700">Urutkan<select aria-label="Urutkan soal" className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 font-normal" value={sortBy} onChange={(event) => setSortBy(event.target.value as 'newest' | 'used')}><option value="newest">Terbaru</option><option value="used">Paling dipakai</option></select></label></div>
    <div className="grid gap-3 md:grid-cols-2">{questions.length === 0 ? <Card className="p-8 text-center text-slate-500 md:col-span-2">{canWrite ? 'Belum ada soal. Pilih “Buat soal” untuk memulai.' : 'Belum ada soal yang dapat ditampilkan.'}</Card> : filteredQuestions.length === 0 ? <Card className="p-8 text-center text-slate-500 md:col-span-2">Tidak ada soal yang cocok dengan pencarian atau filter ini.</Card> : filteredQuestions.map((question) => <Card key={question.id} className="space-y-3 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><span className="rounded-full bg-cyan-50 px-2 py-1 text-xs font-bold text-brand">{kinds.find(([id]) => id === question.type)?.[1] || question.type}</span><h3 className="mt-2 font-bold">{question.title}</h3><p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-slate-600">{question.prompt}</p></div><span className="shrink-0 text-sm font-bold text-slate-500">{question.points} poin</span></div><div className="flex flex-wrap gap-2 text-xs text-slate-500">{question.program && <span>{question.program}</span>}{question.grade ? <span>· Kelas {question.grade}</span> : null}{question.subject && <span>· {question.subject}</span>}{question.mode && <span>· {question.mode.toUpperCase()}</span>}{question.difficulty && <span className="rounded-full bg-amber-50 px-2 py-0.5">{question.difficulty}</span>}{question.estimatedMinutes ? <span>{question.estimatedMinutes} menit</span> : null}{question.curriculum && <span className="rounded-full bg-indigo-50 px-2 py-0.5">{question.curriculum}</span>}{question.folderId && <span className="rounded-full bg-sky-50 px-2 py-0.5">{questionFolderLabel(folders.find((folder) => folder.id === question.folderId) || { id: '', name: 'Folder' }, folders)}</span>}{(question.tags || '').split(',').filter((tag) => tag.trim()).map((tag) => <span key={tag} className="rounded-full bg-violet-50 px-2 py-0.5">#{tag.trim()}</span>)}<span className="rounded-full bg-slate-100 px-2 py-0.5">{question.status}</span><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800">{question.usedCount || 0} asesmen</span></div>{canWrite && <div className="flex flex-wrap items-center gap-2 border-t pt-3">{question.status === 'draft' && <><Button type="button" variant="secondary" onClick={() => { setSelected(question); setMode('complete'); setEditorOpen(true) }}><Pencil className="size-4"/> Edit</Button><Button type="button" variant="secondary" onClick={() => void openHistory(question)} disabled={historyBusy}>Riwayat versi</Button><label className="text-sm font-semibold">Pindahkan ke<select aria-label={`Pindahkan folder untuk ${question.title}`} className="ml-2 min-h-11 max-w-52 rounded-xl border bg-white px-2" value={question.folderId || ''} onChange={(event) => void moveToFolder(question, event.target.value)}><option value="">Tanpa folder</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{questionFolderLabel(folder, folders)}</option>)}</select></label></>}{question.status === 'published' && <Button type="button" variant="secondary" onClick={() => void createRevision(question)}><Copy className="size-4"/> Buat revisi</Button>}{question.status !== 'published' && <Button type="button" variant="secondary" onClick={() => { setSelected({ ...question, id: '', title: `${question.title} (salinan)`, status: 'draft' }); setMode('complete'); setEditorOpen(true) }}><Copy className="size-4"/> Duplikasi</Button>}<Button type="button" variant="secondary" className="text-amber-800" onClick={() => void archive(question)}><Archive className="size-4"/> Arsipkan</Button><Button type="button" variant="danger" onClick={() => void trash(question)}><Trash2 className="size-4"/> Hapus</Button></div>}</Card>)}</div>
    {historyQuestion && <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="question-history-title"><Card className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">Riwayat tersimpan</p><h3 id="question-history-title" className="text-lg font-bold">{historyQuestion.title}</h3><p className="text-sm text-slate-600">Versi aktif {historyCurrentRevision}. Memulihkan versi membuat revisi baru dan tetap menyimpan versi sebelum pemulihan.</p></div><Button type="button" variant="secondary" onClick={() => setHistoryQuestion(null)}>Tutup</Button></div>{historyRows.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Belum ada versi sebelumnya. Perubahan tersimpan berikutnya akan muncul di sini.</p> : <div className="space-y-2">{historyRows.map((version) => <div key={version.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"><div><b>Versi {version.revision}</b><p className="text-xs text-slate-600">{new Date(version.createdAt).toLocaleString('id-ID')} · {version.changedBy}</p></div><Button type="button" variant="secondary" onClick={() => void restoreHistory(version)}>Pulihkan versi {version.revision}</Button></div>)}</div>}</Card></div>}
    <StoragePanel session={session} notify={notify} onChanged={() => void load()}/>
  </div>
}

function StoragePanel({ session, notify, onChanged }: { session: Session; notify: (value: Notice) => void; onChanged?: () => void }) {
  const [trash, setTrash] = useState<{ questions: Question[]; assessments: Assessment[] }>({ questions: [], assessments: [] })
  const [archive, setArchive] = useState<{ questions: Question[]; assessments: Assessment[] }>({ questions: [], assessments: [] })
  const canWrite = session.user.role !== 'kepala_sekolah'
  const load = async () => {
    try {
      const [trashed, archived] = await Promise.all([
        api<typeof trash>('/staff/trash', {}, session),
        api<typeof archive>('/staff/archive', {}, session),
      ])
      setTrash(trashed)
      setArchive(archived)
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : 'Arsip dan Trash belum dapat dimuat.' })
    }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => { const refresh = () => void load(); window.addEventListener('cbt-storage-updated', refresh); return () => window.removeEventListener('cbt-storage-updated', refresh) }, [])
  async function restore(kind: 'questions' | 'assessments', id: string, from: 'trash' | 'archive') {
    const path = kind === 'questions'
      ? `/staff/questions/${id}/${from === 'trash' ? 'restore' : 'unarchive'}`
      : `/staff/assessments/${id}/${from === 'trash' ? 'restore' : 'unarchive'}`
    try {
      await api(path, { method: 'POST' }, session)
      notify({ kind: 'ok', text: from === 'trash' ? 'Data berhasil dipulihkan dari Trash.' : 'Data berhasil dikeluarkan dari arsip.' })
      onChanged?.()
      await load()
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : 'Data gagal dipulihkan.' })
    }
  }
  const empty = trash.questions.length + trash.assessments.length + archive.questions.length + archive.assessments.length === 0
  return <details onToggle={(event) => { if (event.currentTarget.open) void load() }} className="rounded-2xl border border-slate-200 bg-white p-4">
    <summary className="min-h-11 cursor-pointer py-2 font-bold">Arsip & Trash <span className="ml-1 text-sm font-normal text-slate-500">(data dapat dipulihkan)</span></summary>
    {empty ? <p className="mt-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Belum ada soal atau paket diarsipkan maupun dihapus.</p> : <div className="mt-3 grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border p-3"><h3 className="font-bold">Trash</h3><p className="mt-1 text-xs text-slate-500">Penghapusan bersifat lunak. Riwayat dan snapshot ujian tetap aman.</p>
        <div className="mt-3 space-y-2">{trash.questions.map((row) => <div key={`q-${row.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-sm"><span><b>Soal:</b> {row.title}</span>{canWrite && <Button type="button" variant="secondary" onClick={() => void restore('questions', row.id, 'trash')}>Pulihkan</Button>}</div>)}{trash.assessments.map((row) => <div key={`a-${row.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-sm"><span><b>Paket:</b> {row.title}</span>{canWrite && <Button type="button" variant="secondary" onClick={() => void restore('assessments', row.id, 'trash')}>Pulihkan</Button>}</div>)}{trash.questions.length + trash.assessments.length === 0 && <p className="text-sm text-slate-500">Trash kosong.</p>}</div>
      </section>
      <section className="rounded-xl border p-3"><h3 className="font-bold">Arsip</h3><p className="mt-1 text-xs text-slate-500">Arsip menyembunyikan soal/paket dari daftar aktif tanpa membuang histori.</p>
        <div className="mt-3 space-y-2">{archive.questions.map((row) => <div key={`q-${row.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-sm"><span><b>Soal:</b> {row.title}</span>{canWrite && <Button type="button" variant="secondary" onClick={() => void restore('questions', row.id, 'archive')}>Keluarkan dari arsip</Button>}</div>)}{archive.assessments.map((row) => <div key={`a-${row.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-sm"><span><b>Paket:</b> {row.title}</span>{canWrite && <Button type="button" variant="secondary" onClick={() => void restore('assessments', row.id, 'archive')}>Keluarkan dari arsip</Button>}</div>)}{archive.questions.length + archive.assessments.length === 0 && <p className="text-sm text-slate-500">Arsip kosong.</p>}</div>
      </section>
    </div>}
  </details>
}

function AssessmentManager({ rows, canWrite, onCreate, onResume, onPublish, onDuplicate, onCreateTemplate, onArchive, onUnarchive, onTrash }: {
  rows: Assessment[]
  canWrite: boolean
  onCreate: (mode: 'simple' | 'complete') => void
  onResume: (id: string) => void
  onPublish: (row: Assessment) => void
  onDuplicate: (row: Assessment) => void
  onCreateTemplate: (id: string) => void
  onArchive: (row: Assessment) => void
  onUnarchive: (row: Assessment) => void
  onTrash: (row: Assessment) => void
}) {
  return <div className="space-y-5">
    <div><p className="text-sm font-bold uppercase tracking-wider text-brand">Formulir dan asesmen</p><h2 className="text-2xl font-bold">Ujian Online & Simulasi</h2><p className="mt-1 max-w-3xl text-sm text-slate-600">Alurnya seperti membuat formulir: susun pertanyaan, pilih peserta, atur waktu, pratinjau sebagai siswa, kemudian terbitkan. Draf tersimpan otomatis.</p></div>
    {canWrite && <Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-sky-800">Cara paling mudah</p><h3 className="text-lg font-bold">Mulai dari formulir kosong</h3><p className="mt-1 text-sm text-slate-600">Ketik judul, lalu tambahkan pertanyaan satu per satu. Pengaturan lanjutan boleh diatur nanti.</p></div><Button type="button" className="min-h-12 w-full sm:w-auto" onClick={() => onCreate('simple')}><Plus className="size-4"/>Buat formulir baru</Button></div><ol className="mt-5 grid gap-3 border-t pt-4 text-sm sm:grid-cols-3"><li><b>1. Tambah pertanyaan</b><span className="mt-1 block text-slate-600">Buat soal baru atau pilih soal tersimpan.</span></li><li><b>2. Atur peserta</b><span className="mt-1 block text-slate-600">Pilih kelas atau siswa yang akan mengerjakan.</span></li><li><b>3. Pratinjau dan kirim</b><span className="mt-1 block text-slate-600">Cek tampilan siswa sebelum asesmen diterbitkan.</span></li></ol><details className="mt-4 rounded-xl border bg-slate-50 p-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold">Saya ingin mengatur semua detail dari awal</summary><p className="mt-1 text-sm text-slate-600">Mode lengkap menampilkan jadwal, percobaan, randomisasi, rubrik hasil, serta pesan setelah dikirim.</p><Button type="button" variant="secondary" className="mt-3" onClick={() => onCreate('complete')}>Buat dengan pengaturan lengkap</Button></details></Card>}
    {canWrite && <details className="rounded-2xl border border-slate-200 bg-white p-5"><summary className="min-h-11 cursor-pointer py-2 font-bold">Mulai lebih cepat dengan template (opsional)</summary><p className="mt-1 text-sm text-slate-600">Template membuat salinan draf berisi soal contoh. Ganti semua contoh dan lengkapi kunci atau rubrik sebelum diterbitkan.</p><div className="mt-4 grid gap-3 md:grid-cols-3">{assessmentTemplates.map((template) => <article key={template.id} className="flex flex-col items-start rounded-2xl border border-slate-200 p-4"><span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-bold text-brand">{template.questionCount} soal</span><h4 className="mt-3 font-bold">{template.title}</h4><p className="mt-1 flex-1 text-sm text-slate-600">{template.description}</p><Button type="button" className="mt-4 w-full" onClick={() => onCreateTemplate(template.id)}><Plus className="size-4"/> Buat draf</Button></article>)}</div></details>}
    <Card className="p-5"><h3 className="font-bold">Draf dan asesmen saya</h3><p className="mt-1 text-sm text-slate-600">Lanjutkan draf yang belum selesai, atau kelola asesmen yang sudah diterbitkan.</p><div className="mt-3 space-y-2">{rows.length === 0 && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Belum ada asesmen. Tekan “Buat formulir baru” untuk mulai.</p>}{rows.map((row) => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"><div><b>{row.title || 'Paket tanpa judul'}</b><p className="text-sm text-slate-500">{row.kind === 'simulasi' ? 'Simulasi' : 'Ujian Online'} · {row.durationMinute} menit · {row.status === 'draft' ? 'Draf' : row.status === 'published' ? 'Terbit' : 'Arsip'}</p></div><div className="flex flex-wrap gap-2">{canWrite && row.status === 'draft' && <Button variant="secondary" onClick={() => onResume(row.id)}>Lanjutkan draf</Button>}{canWrite && <Button type="button" variant="secondary" onClick={() => onDuplicate(row)}><Copy className="size-4"/> Duplikasi</Button>}{canWrite && row.status === 'draft' && <Button onClick={() => onPublish(row)}><Send className="size-4"/> Terbitkan</Button>}{canWrite && row.status === 'archived' && <Button variant="secondary" onClick={() => onUnarchive(row)}>Pulihkan arsip</Button>}{canWrite && row.status !== 'archived' && <Button type="button" variant="secondary" onClick={() => onArchive(row)}><Archive className="size-4"/> Arsipkan</Button>}{canWrite && <Button type="button" variant="danger" onClick={() => onTrash(row)}><Trash2 className="size-4"/> Hapus</Button>}</div></div>)}</div></Card>
  </div>
}

function AssessmentBuilder({ session, notify, onSync }: { session: Session; notify: (value: Notice) => void; onSync: () => void }) {
  type BuilderMode = 'simple' | 'complete'
  type DraftForm = { kind: string; title: string; description: string; instructions: string; classId: string; room: string; subjectId: string; accessCode: string; durationMinute: number; startsAt: string; endsAt: string; randomize: boolean; randomizeOptions: boolean; showResult: boolean; showReview: boolean; maxAttempts: number; passScore: number; resultsPolicy: string; progressBar: boolean; confirmationMessage: string }
  const blankForm = (): DraftForm => ({ kind: 'ujian_online', title: '', description: '', instructions: '', classId: '', room: '', subjectId: '', accessCode: '', durationMinute: 60, startsAt: '', endsAt: '', randomize: false, randomizeOptions: false, showResult: false, showReview: false, maxAttempts: 1, passScore: 0, resultsPolicy: 'after_review', progressBar: true, confirmationMessage: 'Jawabanmu sudah terkirim. Terima kasih.' })
  const [questions, setQuestions] = useState<Question[]>([])
  const [rows, setRows] = useState<Assessment[]>([])
  const [classes, setClasses] = useState<Kelas[]>([])
  const [students, setStudents] = useState<MasterStudent[]>([])
  const [classLoadIssue, setClassLoadIssue] = useState('')
  const [manualClassID, setManualClassID] = useState('')
  const [manualClassName, setManualClassName] = useState('')
  const [manualClassBusy, setManualClassBusy] = useState(false)
  const [masterSyncBusy, setMasterSyncBusy] = useState(false)
  const [studentIds, setStudentIds] = useState<string[]>([])
  const [assignmentScope, setAssignmentScope] = useState<'class' | 'selected'>('class')
  const [selected, setSelected] = useState<string[]>([])
  const [form, setForm] = useState<DraftForm>(blankForm)
  const [mode, setMode] = useState<BuilderMode>('simple')
  const [draftId, setDraftId] = useState('')
  const [revision, setRevision] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'conflict'>('idle')
  const [conflict, setConflict] = useState<Assessment | null>(null)
  const [loading, setLoading] = useState(true)
  const [publishBusy, setPublishBusy] = useState(false)
  const [questionOpen, setQuestionOpen] = useState(false)
  const [questionBusy, setQuestionBusy] = useState(false)
  const [questionEditing, setQuestionEditing] = useState<Question | null>(null)
  const [duplicateBusy, setDuplicateBusy] = useState('')
  const [preview, setPreview] = useState(false)
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [studentSearch, setStudentSearch] = useState('')
  const [previewAnswer, setPreviewAnswer] = useState<unknown>(null)
  const [retryCount, setRetryCount] = useState(0)
  const drag = useRef<string | null>(null)
  const lastSaved = useRef('')
  const key = `cbt-builder-draft-${session.user.id}`
  const localDraftKey = (id: string) => `${key}-local-${id}`
  const location = useLocation()
  const navigate = useNavigate()
  const packagePrefillHandled = useRef('')
  const packagePrefillID = new URLSearchParams(location.search).get('paket') || ''
  const scheduleInvalid = Boolean(form.startsAt && form.endsAt && new Date(form.endsAt).getTime() <= new Date(form.startsAt).getTime())

  const formPayload = (current: DraftForm, ids: string[], assignees: string[]) => ({
    kind: current.kind, title: current.title, description: current.description, instructions: current.instructions, classId: current.classId, room: current.room, subjectId: current.subjectId,
    accessCode: current.accessCode, durationMinute: Number(current.durationMinute || 60), startsAt: current.startsAt ? new Date(current.startsAt).toISOString() : null, endsAt: current.endsAt ? new Date(current.endsAt).toISOString() : null,
    randomize: current.randomize, randomizeOptions: current.randomizeOptions, showResult: current.showResult, showReview: current.showReview, maxAttempts: Number(current.maxAttempts), passScore: Number(current.passScore), resultsPolicy: current.resultsPolicy, progressBar: current.progressBar, confirmationMessage: current.confirmationMessage,
    status: 'draft', items: ids.map((questionId) => ({ questionId })), studentIds: assignees,
  })
  const serializeDraft = (current: DraftForm, ids: string[], assignees: string[]) => JSON.stringify(formPayload(current, ids, assignees))
  function preserveLegacyLocalDraft() {
    const activeDraftID = localStorage.getItem(key)
    const legacyLocal = localStorage.getItem(`${key}-local`)
    if (!activeDraftID || !legacyLocal) return
    const scopedKey = localDraftKey(activeDraftID)
    if (!localStorage.getItem(scopedKey)) localStorage.setItem(scopedKey, legacyLocal)
    localStorage.removeItem(`${key}-local`)
  }

  async function loadAll() {
    setLoading(true)
    try {
      const [questionResult, assessmentResult, classResult, studentResult] = await Promise.allSettled([
        api<Question[]>('/staff/questions', {}, session), api<Assessment[]>('/staff/assessments', {}, session), api<Kelas[]>('/staff/master/classes', {}, session), api<MasterStudent[]>('/staff/master/students', {}, session),
      ])
      if (questionResult.status === 'rejected') throw questionResult.reason
      if (assessmentResult.status === 'rejected') throw assessmentResult.reason
      const questionRows = questionResult.value
      const assessmentRows = assessmentResult.value
      const classRows = classResult.status === 'fulfilled' ? classResult.value : []
      const studentRows = studentResult.status === 'fulfilled' ? studentResult.value : []
      setQuestions(questionRows); setRows(assessmentRows); setClasses(classRows); setStudents(studentRows)
      setClassLoadIssue(classResult.status === 'rejected' ? 'Daftar kelas belum dapat dimuat dari LMS.' : classRows.length === 0 ? 'LMS belum mengirim data kelas aktif.' : '')
      if (studentResult.status === 'rejected') notify({ kind: 'error', text: 'Daftar peserta didik belum dapat dimuat. Sinkronkan ulang sebelum menugaskan asesmen.' })
      if (!form.classId && classRows[0]) setForm((current) => ({ ...current, classId: classRows[0].id }))
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Data asesmen gagal dimuat' }) }
    finally { setLoading(false) }
  }
  async function syncMasterNow() {
    setMasterSyncBusy(true)
    try {
      const result = await api<{ syncRun?: { status: string; message?: string; classes: number; students: number } }>('/staff/sync/run', { method: 'POST' }, session)
      await loadAll()
      const syncRun = result.syncRun
      const hasRoster = Boolean(syncRun && (syncRun.classes > 0 || syncRun.students > 0))
      notify({ kind: hasRoster ? 'ok' : 'error', text: syncRun?.message || (hasRoster ? 'Data kelas dan siswa berhasil dimuat ulang dari LMS.' : 'LMS belum mengirim kelas atau siswa. Buka status sinkronisasi untuk melihat penyebabnya.') })
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : 'Sinkronisasi penuh LMS gagal. Data asesmen yang ada tetap aman.' })
    } finally { setMasterSyncBusy(false) }
  }
  useEffect(() => { void loadAll() }, [])
  useEffect(() => { if (packagePrefillID) return; const resumeId = localStorage.getItem(key); if (!resumeId) return; void resumeDraft(resumeId, false) }, [key, packagePrefillID])

  async function createDraft(nextMode: BuilderMode, copyCurrent = false, prefill?: { form: DraftForm; questionIds: string[]; studentIds?: string[]; assignmentScope?: 'class' | 'selected' }) {
    const draftForm = prefill?.form || (copyCurrent ? form : { ...blankForm(), classId: classes[0]?.id || '' })
    const draftItems = prefill?.questionIds || (copyCurrent ? selected : [])
    const draftStudents = prefill?.studentIds || (copyCurrent && assignmentScope === 'selected' ? studentIds : [])
    try {
      const result = await api<{ assessment: Assessment }>('/staff/assessments/drafts', { method: 'POST', body: JSON.stringify(formPayload(draftForm, draftItems, draftStudents)) }, session)
      preserveLegacyLocalDraft()
      setForm(draftForm); setSelected(draftItems); setStudentIds(draftStudents); setAssignmentScope(prefill?.assignmentScope || (copyCurrent ? assignmentScope : 'class')); setMode(nextMode); setDraftId(result.assessment.id); setRevision(result.assessment.revision); setConflict(null); setSaveState('saved')
      localStorage.setItem(key, result.assessment.id)
      lastSaved.current = serializeDraft(draftForm, draftItems, draftStudents)
      void loadAll()
      return true
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Draf belum dapat dibuat' }); return false }
  }

  useEffect(() => {
    if (!packagePrefillID || loading || draftId || packagePrefillHandled.current === packagePrefillID) return
    packagePrefillHandled.current = packagePrefillID
    void (async () => {
      try {
        const source = await api<{ id: string; title: string; description?: string; subject?: string; status: string; questions: Question[]; assignments: Array<{ targetType: 'class' | 'student'; targetId: string }> }>(`/staff/question-packages/${encodeURIComponent(packagePrefillID)}`, {}, session)
        if (source.status === 'archived') throw new Error('Paket soal yang diarsipkan tidak dapat digunakan untuk asesmen baru.')
        const questionIds = source.questions.map((question) => question.id)
        if (!questionIds.length) throw new Error('Paket soal ini belum memiliki butir soal.')
        const classTargets = source.assignments.filter((assignment) => assignment.targetType === 'class').map((assignment) => assignment.targetId)
        const studentTargets = source.assignments.filter((assignment) => assignment.targetType === 'student').map((assignment) => assignment.targetId)
        let classId = classTargets.length === 1 ? classTargets[0] : ''
        let assignedStudents: string[] = []
        let selectedScope: 'class' | 'selected' = 'class'
        if (!classTargets.length && studentTargets.length) {
          const selectedRows = students.filter((student) => studentTargets.includes(student.id))
          const selectedClassIDs = [...new Set(selectedRows.map((student) => student.kelasId).filter(Boolean))]
          if (selectedRows.length === studentTargets.length && selectedClassIDs.length === 1) {
            classId = selectedClassIDs[0]
            assignedStudents = studentTargets
            selectedScope = 'selected'
          }
        }
        const queryKind = new URLSearchParams(location.search).get('jenis')
        const initial: DraftForm = { ...blankForm(), kind: queryKind === 'simulasi' ? 'simulasi' : 'ujian_online', title: source.title, description: source.description || '', subjectId: source.subject || '', classId }
        const created = await createDraft('simple', false, { form: initial, questionIds, studentIds: assignedStudents, assignmentScope: selectedScope })
        if (!created) return
        if (classTargets.length > 1 || (studentTargets.length && !assignedStudents.length)) notify({ kind: 'ok', text: 'Soal paket sudah dimasukkan. Pilih satu kelas dan peserta untuk asesmen; target paket mencakup lebih dari satu kelas.' })
        else notify({ kind: 'ok', text: `Draf ${initial.kind === 'simulasi' ? 'simulasi' : 'ujian online'} dibuat dari paket “${source.title}”. Periksa pengaturan lalu terbitkan.` })
        navigate('/ujian', { replace: true })
      } catch (error) {
        notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket soal belum dapat dimuat ke asesmen.' })
        navigate('/ujian', { replace: true })
      }
    })()
  }, [packagePrefillID, loading, draftId, session.accessToken, students, location.search])
  async function resumeDraft(id: string, showError = true) {
    try {
      const result = await api<{ assessment: Assessment; items: Array<{ questionId: string; position: number }>; assignments: Array<{ studentId: string }> }>('/staff/assessments/' + id, {}, session)
      const row = result.assessment
      if (row.status !== 'draft') return
      if (row.accessCodeConfigured && !row.accessCode && row.kind === 'ujian_online' && showError) notify({ kind: 'error', text: 'Draf lama menyimpan kode akses dalam bentuk hash sehingga nilainya tidak bisa ditampilkan kembali. Masukkan kode baru sebelum menerbitkan.' })
      const serverForm: DraftForm = { ...blankForm(), kind: row.kind || 'ujian_online', title: row.title === 'Paket tanpa judul' ? '' : row.title || '', description: row.description || '', instructions: row.instructions || '', classId: row.classId || '', room: row.room || '', subjectId: row.subjectId || '', accessCode: row.accessCode || '', durationMinute: row.durationMinute || 60, startsAt: localDateInput(row.startsAt), endsAt: localDateInput(row.endsAt), randomize: Boolean(row.randomize), randomizeOptions: Boolean(row.randomizeOptions), showResult: Boolean(row.showResult), showReview: Boolean(row.showReview), maxAttempts: row.maxAttempts || 1, passScore: row.passScore || 0, resultsPolicy: row.resultsPolicy || 'after_review', progressBar: true, confirmationMessage: '' }
      const serverIds = result.items.slice().sort((a, b) => a.position - b.position).map((item) => item.questionId)
      const serverAssignments = result.assignments.map((item) => item.studentId)
      let next = serverForm
      let ids = serverIds
      let assignments = serverAssignments
      let recoveredLocal = false
      try {
        const scopedLocalKey = localDraftKey(id)
        const rawLocal = localStorage.getItem(scopedLocalKey) || (localStorage.getItem(key) === id ? localStorage.getItem(`${key}-local`) : null)
        if (rawLocal) {
          const local = JSON.parse(rawLocal) as Record<string, unknown>
          next = { ...serverForm, ...local, startsAt: localDateInput(typeof local.startsAt === 'string' ? local.startsAt : undefined), endsAt: localDateInput(typeof local.endsAt === 'string' ? local.endsAt : undefined) } as DraftForm
          if (Array.isArray(local.items)) ids = local.items.map((entry) => typeof entry === 'object' && entry && 'questionId' in entry ? String((entry as { questionId: unknown }).questionId) : '').filter(Boolean)
          if (Array.isArray(local.studentIds)) assignments = local.studentIds.map(String)
          recoveredLocal = true
          localStorage.setItem(scopedLocalKey, rawLocal)
          if (localStorage.getItem(key) === id) localStorage.removeItem(`${key}-local`)
        }
      } catch { localStorage.removeItem(localDraftKey(id)); if (localStorage.getItem(key) === id) localStorage.removeItem(`${key}-local`) }
      setAssignmentScope(assignments.length ? 'selected' : 'class'); setStudentIds(assignments)
      setForm(next); setSelected(ids); setDraftId(row.id); setRevision(row.revision); setMode((localStorage.getItem(`${key}-mode`) as BuilderMode) || 'simple'); setConflict(null); setSaveState(recoveredLocal ? navigator.onLine ? 'saving' : 'offline' : 'saved'); localStorage.setItem(key, row.id)
      lastSaved.current = serializeDraft(serverForm, serverIds, serverAssignments)
    } catch (error) {
      localStorage.removeItem(key)
      if (showError) notify({ kind: 'error', text: error instanceof Error ? error.message : 'Draf tidak dapat dibuka' })
    }
  }
  useEffect(() => { if (mode) localStorage.setItem(`${key}-mode`, mode) }, [mode, key])

  async function autosave() {
    if (!draftId || conflict) return false
    const currentStudents = assignmentScope === 'class' ? [] : studentIds
    const serialized = serializeDraft(form, selected, currentStudents)
    localStorage.setItem(localDraftKey(draftId), serialized)
    if (serialized === lastSaved.current) return true
    if (scheduleInvalid) { setSaveState('error'); return false }
    if (!navigator.onLine) { setSaveState('offline'); return false }
    setSaveState('saving')
    try {
      const response = await fetch(`/api/staff/assessments/${draftId}/draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, body: JSON.stringify({ ...formPayload(form, selected, currentStudents), revision }) })
      const payload = await response.json().catch(() => ({}))
      if (response.status === 409) { setConflict(payload.server as Assessment); setSaveState('conflict'); return false }
      if (!response.ok) throw new Error(payload.error || 'Draf gagal disimpan')
      const saved = payload.assessment as Assessment
      setRevision(saved.revision); lastSaved.current = serialized; localStorage.removeItem(localDraftKey(draftId)); if (localStorage.getItem(key) === draftId) localStorage.removeItem(`${key}-local`); setSaveState('saved')
      return true
    } catch { setSaveState('error'); return false }
  }
  useEffect(() => {
    if (!draftId || conflict || loading) return
    const timer = window.setTimeout(() => { void autosave() }, 700)
    return () => window.clearTimeout(timer)
  }, [form, selected, studentIds, assignmentScope, draftId, conflict, retryCount, loading])
  useEffect(() => { const retry = () => setRetryCount((value) => value + 1); window.addEventListener('online', retry); return () => window.removeEventListener('online', retry) }, [])

  function setField(name: keyof DraftForm, value: string | number | boolean) { setForm((current) => ({ ...current, [name]: value })) }
  function setSchedulePart(field: 'startsAt' | 'endsAt', part: 'date' | 'time', value: string) {
    setForm((current) => {
      const [date = '', time = ''] = current[field].split('T')
      const nextDate = part === 'date' ? value : date
      const nextTime = part === 'time' ? value : time
      return { ...current, [field]: nextDate ? `${nextDate}T${nextTime || '00:00'}` : '' }
    })
  }
  function order(from: string, to: string) { const next = [...selected]; const a = next.indexOf(from); const b = next.indexOf(to); if (a >= 0 && b >= 0) { next.splice(a, 1); next.splice(b, 0, from); setSelected(next) } }
  function moveSelected(index: number, destination: number) { if (destination < 0 || destination >= selected.length) return; const next = [...selected]; const [value] = next.splice(index, 1); next.splice(destination, 0, value); setSelected(next) }
  async function trashBuilderQuestion(id: string) {
    const question = questions.find((row) => row.id === id)
    if (!question || !window.confirm(`Hapus soal “${question.title}” dari Bank Soal dan paket ini? Snapshot paket yang sudah terbit tetap aman.`)) return
    try {
      await api(`/staff/questions/${id}/trash`, { method: 'POST' }, session)
      setQuestions((current) => current.filter((row) => row.id !== id))
      setSelected((current) => current.filter((value) => value !== id))
      notify({ kind: 'ok', text: `Soal “${question.title}” dipindahkan ke Trash dan dikeluarkan dari draf ini.` })
      void loadAll()
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Soal tidak dapat dihapus' }) }
  }
  async function createManualClass() {
    if (!manualClassID || !manualClassName.trim() || manualClassBusy) return
    setManualClassBusy(true)
    try {
      const row = await api<Kelas>('/staff/master/classes/manual-label', { method: 'POST', body: JSON.stringify({ classId: manualClassID, name: manualClassName.trim() }) }, session)
      setClasses((current) => [...current, row].sort((a, b) => a.nama.localeCompare(b.nama, 'id')))
      setField('classId', row.id)
      setManualClassName('')
      notify({ kind: 'ok', text: `Kelas sementara “${row.nama}” dibuat dari data peserta yang sudah tersinkron.` })
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Label kelas sementara belum dapat dibuat' }) }
    finally { setManualClassBusy(false) }
  }
  async function archivePackage(row: Assessment) {
    if (!window.confirm(`Arsipkan paket “${row.title}”? Histori dan nilai tetap tersimpan.`)) return
    try { await api(`/staff/assessments/${row.id}/archive`, { method: 'POST' }, session); notify({ kind: 'ok', text: `Paket “${row.title}” diarsipkan.` }); void loadAll() }
    catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket gagal diarsipkan' }) }
  }
  async function trashPackage(row: Assessment) {
    if (!window.confirm(`Pindahkan paket “${row.title}” ke Trash? Histori percobaan tidak dihapus dan paket dapat dipulihkan.`)) return
    try { await api(`/staff/assessments/${row.id}/trash`, { method: 'POST' }, session); notify({ kind: 'ok', text: `Paket “${row.title}” dipindahkan ke Trash.` }); void loadAll() }
    catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket gagal dipindahkan ke Trash' }) }
  }
  async function unarchivePackage(row: Assessment) {
    try { await api(`/staff/assessments/${row.id}/unarchive`, { method: 'POST' }, session); notify({ kind: 'ok', text: `Paket “${row.title}” dikeluarkan dari arsip.` }); void loadAll() }
    catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Arsip paket gagal dipulihkan' }) }
  }
  async function saveNewQuestion(payload: Record<string, unknown>) {
    setQuestionBusy(true)
    try {
      const question = questionEditing
        ? await api<Question>(`/staff/questions/${questionEditing.id}`, { method: 'PUT', body: JSON.stringify(payload) }, session)
        : await api<Question>('/staff/questions', { method: 'POST', body: JSON.stringify(payload) }, session)
      setQuestions((current) => questionEditing ? current.map((row) => row.id === question.id ? question : row) : [question, ...current])
      if (questionEditing) { lastSaved.current = ''; setSelected((current) => current.slice()) }
      else setSelected((current) => [...current, question.id])
      setQuestionOpen(false); setQuestionEditing(null)
      notify({ kind: 'ok', text: questionEditing ? 'Soal contoh diperbarui. Periksa kembali kunci atau rubrik sebelum menerbitkan.' : 'Soal tersimpan di Bank Soal dan ditambahkan ke paket.' })
    }
    catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Soal gagal disimpan' }); throw error }
    finally { setQuestionBusy(false) }
  }

  async function createFromTemplate(templateID: string) {
    try {
      const result = await api<{ assessment: Assessment; questionCount: number }>(`/staff/assessment-templates/${templateID}/draft`, { method: 'POST', body: JSON.stringify({}) }, session)
      preserveLegacyLocalDraft()
      await loadAll()
      await resumeDraft(result.assessment.id, false)
      notify({ kind: 'ok', text: `${result.assessment.title} siap diatur dengan ${result.questionCount} soal contoh. Lengkapi isi dan kunci sebelum diterbitkan.` })
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Template belum dapat dibuat' }) }
  }

  async function duplicatePackage(row: Assessment) {
    if (duplicateBusy) return
    setDuplicateBusy(row.id)
    try {
      const result = await api<{ assessment: Assessment }>(`/staff/assessments/${row.id}/duplicate`, { method: 'POST' }, session)
      preserveLegacyLocalDraft()
      await loadAll()
      await resumeDraft(result.assessment.id, false)
      notify({ kind: 'ok', text: `Salinan draf “${result.assessment.title}” dibuat. Kelas, jadwal, kode akses, dan peserta perlu dipilih kembali.` })
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Paket belum dapat diduplikasi' }) }
    finally { setDuplicateBusy('') }
  }
  async function loadServerVersion() { if (!conflict) return; await resumeDraft(conflict.id); setConflict(null); setSaveState('saved') }
  async function publish() {
    if (!draftId) return
    if (scheduleInvalid) { notify({ kind: 'error', text: 'Tanggal selesai harus setelah tanggal mulai.' }); return }
    const missing: string[] = []
    if (!form.title.trim()) missing.push('judul asesmen')
    if (!form.classId) missing.push('kelas peserta')
    if (!selected.length) missing.push('minimal satu soal')
    if (assignmentScope === 'selected' && studentIds.length === 0) missing.push('pilihan peserta')
    if (form.kind === 'ujian_online' && !form.accessCode.trim()) missing.push('kode akses siswa')
    if (form.durationMinute < 1) missing.push('durasi asesmen')
    if (missing.length) { notify({ kind: 'error', text: `Belum dapat diterbitkan. Lengkapi dulu: ${missing.join(', ')}.` }); return }
    if (!navigator.onLine) { notify({ kind: 'error', text: 'Publikasi memerlukan koneksi internet.' }); return }
    setPublishBusy(true)
    try {
      if (!await autosave()) throw new Error('Perubahan belum tersimpan. Coba lagi setelah koneksi pulih dan status draf menunjukkan Tersimpan.')
      await api(`/staff/assessments/${draftId}/publish`, { method: 'POST' }, session)
      if (localStorage.getItem(key) === draftId) { localStorage.removeItem(key); localStorage.removeItem(`${key}-local`) }; localStorage.removeItem(localDraftKey(draftId)); setDraftId(''); setConflict(null); setSaveState('idle'); notify({ kind: 'ok', text: 'Asesmen diterbitkan. Snapshot soal dan pengaturan telah dibekukan.' }); await loadAll()
    } catch (error) { notify({ kind: 'error', text: error instanceof Error ? error.message : 'Asesmen belum dapat diterbitkan' }) }
    finally { setPublishBusy(false) }
  }
  function previewConfig(question: Question) {
    try { const config = JSON.parse(question.configJson || '{}') as Record<string, any>; for (const key of ['correctIds', 'acceptedAnswers', 'pairs', 'gridCorrect', 'gridMultiCorrect', 'correctOrder', 'correctNumber', 'rubrik', 'partialScoring']) delete config[key]; if (Array.isArray(config.statements)) config.statements = config.statements.map(({ correct: _correct, ...row }) => row); return config } catch { return {} }
  }

  if (loading) return <Card className="p-8 text-center text-slate-500">Memuat workspace asesmen…</Card>
  if (!draftId) return <AssessmentManager rows={rows} canWrite={session.user.role !== 'kepala_sekolah'} onCreate={(nextMode) => { setMode(nextMode); void createDraft(nextMode) }} onResume={(id) => void resumeDraft(id)} onPublish={(row) => void api(`/staff/assessments/${row.id}/publish`, { method: 'POST' }, session).then(() => loadAll()).catch((error) => notify({ kind: 'error', text: error instanceof Error ? error.message : 'Belum dapat diterbitkan' }))} onDuplicate={(row) => void duplicatePackage(row)} onCreateTemplate={(id) => void createFromTemplate(id)} onArchive={(row) => void archivePackage(row)} onUnarchive={(row) => void unarchivePackage(row)} onTrash={(row) => void trashPackage(row)} />

  const resultPreviewQuestion = selected.map((id) => questions.find((question) => question.id === id)).find(Boolean)
  const templatePlaceholderCount = questions.filter((question) => selected.includes(question.id) && question.templatePlaceholder).length
  const readinessItems: Array<[boolean, string]> = [
    [Boolean(form.title.trim()), 'Judul asesmen'],
    [Boolean(form.classId), 'Kelas peserta'],
    [selected.length > 0, 'Minimal satu soal'],
    [templatePlaceholderCount === 0, templatePlaceholderCount ? `Lengkapi ${templatePlaceholderCount} soal contoh template` : 'Soal contoh template sudah dilengkapi'],
  ]
  if (form.kind === 'ujian_online') readinessItems.push([Boolean(form.accessCode.trim()), 'Kode akses siswa'])
  readinessItems.push(
    [form.durationMinute > 0 && !scheduleInvalid, scheduleInvalid ? 'Periksa urutan tanggal' : 'Durasi dan jadwal valid'],
    [saveState === 'saved', 'Draf tersimpan dan sinkron'],
  )
  return <div className="space-y-4">
    {participantsOpen && <div className="fixed inset-0 z-50 grid place-items-end bg-slate-950/50 p-0 sm:place-items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="participants-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">Penugasan</p><h2 id="participants-title" className="text-xl font-bold">Pilih peserta asesmen</h2><p className="mt-1 text-sm text-slate-600">{classes.find((row) => row.id === form.classId)?.nama || 'Pilih kelas terlebih dahulu'}</p></div><Button type="button" variant="secondary" onClick={() => setParticipantsOpen(false)}>Tutup</Button></div><div className="mt-4 grid gap-2 sm:grid-cols-2"><button type="button" aria-pressed={assignmentScope === 'class'} onClick={() => { setAssignmentScope('class'); setStudentIds([]) }} className={`min-h-16 rounded-xl border p-3 text-left ${assignmentScope === 'class' ? 'border-brand bg-sky-50' : ''}`}><b>Semua siswa di kelas</b><span className="mt-1 block text-xs text-slate-600">Termasuk siswa aktif yang berada di kelas ini.</span></button><button type="button" aria-pressed={assignmentScope === 'selected'} onClick={() => setAssignmentScope('selected')} className={`min-h-16 rounded-xl border p-3 text-left ${assignmentScope === 'selected' ? 'border-brand bg-sky-50' : ''}`}><b>Siswa tertentu</b><span className="mt-1 block text-xs text-slate-600">Pilih siswa satu per satu atau pilih semuanya.</span></button></div>{assignmentScope === 'selected' && <><div className="mt-4 flex flex-wrap items-center gap-2"><input aria-label="Cari siswa" className="min-h-11 min-w-48 flex-1 rounded-xl border px-3" placeholder="Cari nama, NIS, atau NISN" value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)}/><Button type="button" variant="secondary" onClick={() => setStudentIds((current) => current.length === students.filter((row) => row.kelasId === form.classId).length ? [] : students.filter((row) => row.kelasId === form.classId).map((row) => row.id))}>{studentIds.length === students.filter((row) => row.kelasId === form.classId).length ? 'Kosongkan pilihan' : 'Pilih semua'}</Button></div><div className="mt-3 max-h-72 divide-y overflow-y-auto rounded-xl border">{students.filter((row) => row.kelasId === form.classId && `${row.nama} ${row.nis} ${row.nisn}`.toLowerCase().includes(studentSearch.toLowerCase())).map((row) => <label key={row.id} className="flex min-h-12 cursor-pointer items-center gap-3 p-3 hover:bg-slate-50"><input type="checkbox" className="size-5 accent-sky-700" checked={studentIds.includes(row.id)} onChange={() => setStudentIds((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id])}/><span className="min-w-0"><b>{row.nama}</b><span className="mt-1 block text-xs text-slate-600">NIS {row.nis || '—'} · NISN {row.nisn || '—'}{row.kelompokBelajar ? ` · ${row.kelompokBelajar}` : ''}</span></span></label>)}{students.filter((row) => row.kelasId === form.classId).length === 0 && <p className="p-4 text-sm text-slate-500">Belum ada siswa aktif pada kelas ini.</p>}</div><p className="mt-2 text-sm text-slate-600">Terpilih: {studentIds.length} siswa</p></>}<div className="mt-4 flex justify-end"><Button type="button" onClick={() => setParticipantsOpen(false)}>Selesai</Button></div></section></div>}
    {classes.length === 0 && <div role="status"><Card className="flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50 p-4"><div className="min-w-0"><p className="font-bold text-amber-950">Kelas dan siswa dari LMS belum tersedia di CBT</p><p className="mt-1 text-sm text-amber-900">Muat ulang penuh data master LMS. Ini tidak mengubah paket, soal, atau hasil asesmen yang sudah tersimpan.</p></div><div className="flex flex-wrap gap-2"><Button type="button" disabled={masterSyncBusy} onClick={() => void syncMasterNow()}>{masterSyncBusy ? 'Menyinkronkan…' : 'Sinkronkan kelas & siswa'}</Button><Button type="button" variant="secondary" onClick={onSync}>Lihat status integrasi</Button></div></Card></div>}
    <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white/95 p-3 shadow-sm backdrop-blur"><div className="flex min-w-0 items-center gap-2"><Button type="button" variant="secondary" onClick={() => { setDraftId(''); setConflict(null); setSaveState('idle'); void loadAll() }}>← Kembali</Button><div className="min-w-0"><p className="truncate font-bold">{form.title || 'Paket tanpa judul'}</p><p aria-live="polite" className={`text-xs ${saveState === 'error' || saveState === 'conflict' ? 'text-rose-700' : saveState === 'offline' ? 'text-amber-700' : 'text-slate-500'}`}>{saveState === 'saving' ? 'Menyimpan…' : saveState === 'saved' ? 'Tersimpan otomatis' : saveState === 'offline' ? 'Offline — draf tersimpan lokal' : saveState === 'error' ? 'Gagal menyimpan — coba lagi' : saveState === 'conflict' ? 'Konflik versi draf' : 'Draf baru'}</p></div></div><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={() => setParticipantsOpen(true)}>Peserta · {assignmentScope === 'class' ? 'Satu kelas' : `${studentIds.length} siswa`}</Button><Button type="button" variant="secondary" onClick={() => { setPreviewAnswer(null); setPreview(true) }}>Pratinjau siswa</Button><Button type="button" onClick={() => void publish()} disabled={publishBusy || saveState === 'conflict'}><Send className="size-4"/>{publishBusy ? 'Menerbitkan…' : 'Siapkan & terbitkan'}</Button></div></div>
    {conflict && <Card className="border-amber-300 bg-amber-50 p-4"><h3 className="font-bold">Draf ini berubah di sesi lain</h3><p className="mt-1 text-sm">Versi server saat ini: “{conflict.title || 'Paket tanpa judul'}” · revisi {conflict.revision}. Pilih versi yang ingin dilanjutkan.</p><div className="mt-3 flex flex-wrap gap-2"><Button type="button" onClick={() => void loadServerVersion()}>Muat versi server</Button><Button type="button" variant="secondary" onClick={() => void createDraft(mode, true)}>Simpan perubahan sebagai salinan</Button></div></Card>}
    {saveState === 'error' && <Card className="border-rose-200 bg-rose-50 p-3"><p className="text-sm text-rose-800">{scheduleInvalid ? 'Tanggal selesai harus setelah tanggal mulai. Draf lokal aman; perbaiki jadwal untuk menyimpan ke server.' : 'Perubahan tetap berada di perangkat ini. Periksa koneksi lalu coba simpan lagi.'}</p><Button className="mt-2" type="button" variant="secondary" onClick={() => { lastSaved.current = ''; setRetryCount((value) => value + 1) }}>Coba simpan lagi</Button></Card>}
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(210px,0.75fr)_minmax(420px,1.35fr)_minmax(270px,0.9fr)]">
      <Card className="p-4"><div className="flex items-start justify-between gap-2"><div><h3 className="font-bold">Tambah soal</h3><p className="text-xs text-slate-600">Klik soal untuk menambahkannya.</p></div><Button type="button" className="px-3" onClick={() => { setQuestionEditing(null); setQuestionOpen(true) }}><Plus className="size-4"/> Buat</Button></div><div className="mt-3 space-y-2">{questions.map((question) => <button key={question.id} type="button" onClick={() => { if (!selected.includes(question.id)) setSelected((current) => [...current, question.id]) }} disabled={selected.includes(question.id) || question.status === 'archived'} className="min-h-12 w-full rounded-xl border p-3 text-left text-sm hover:border-sky-500 disabled:opacity-50"><b className="block">{question.title}</b><span className="text-slate-500">{kinds.find(([id]) => id === question.type)?.[1] || question.type} · {question.points} poin</span>{question.templatePlaceholder && <span className="mt-1 block text-xs font-semibold text-amber-800">Contoh template · perlu diganti</span>}</button>)}{questions.length === 0 && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-500">Bank Soal masih kosong.</p>}</div></Card>
      <div className="min-w-0 space-y-4"><Card className="min-w-0 p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold">Urutan soal</h3><p className="text-sm text-slate-600">Seret kartu atau gunakan tombol naik/turun.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold">{selected.length} soal</span></div><div className="mt-3 space-y-2">{selected.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center text-sm text-slate-500">Pilih soal di kiri atau buat soal baru.</div>}{selected.map((id, index) => { const question = questions.find((row) => row.id === id); return <div key={id} data-testid="assessment-question-row" draggable onDragStart={() => { drag.current = id }} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (drag.current) order(drag.current, id) }} className="grid min-w-0 grid-cols-[20px_32px_minmax(0,1fr)] items-center gap-x-2 gap-y-2 rounded-xl border bg-white p-3"><GripVertical className="size-5 shrink-0 cursor-grab text-slate-400"/><span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand text-xs font-bold text-white">{index + 1}</span><span className="min-w-0 truncate text-sm font-semibold">{question?.title || 'Soal tidak ditemukan'}{question?.templatePlaceholder && <span className="ml-2 rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900">Contoh</span>}</span><div className="col-span-3 flex min-w-0 flex-wrap items-center justify-end gap-2 border-t pt-2">{question?.status === 'draft' && <Button type="button" variant="secondary" className="min-h-11 min-w-16 px-2 text-xs" onClick={() => { setQuestionEditing(question); setQuestionOpen(true) }}>Edit soal</Button>}<Button type="button" variant="secondary" className="size-11 shrink-0 px-0" disabled={index === 0} aria-label="Naikkan soal" onClick={() => moveSelected(index, index - 1)}><ArrowUp className="size-4"/></Button><Button type="button" variant="secondary" className="size-11 shrink-0 px-0" disabled={index === selected.length - 1} aria-label="Turunkan soal" onClick={() => moveSelected(index, index + 1)}><ArrowDown className="size-4"/></Button><Button type="button" variant="secondary" className="size-11 shrink-0 px-0 text-slate-700" aria-label="Hapus dari paket" onClick={() => setSelected((current) => current.filter((value) => value !== id))}>×</Button>{question && <Button type="button" variant="danger" className="size-11 shrink-0 px-0" aria-label={`Hapus soal ${question.title} ke Trash`} onClick={() => void trashBuilderQuestion(id)}><Trash2 className="size-4"/></Button>}</div></div>})}</div></Card>
        <Card className="p-4 sm:p-5"><h3 className="font-bold">Identitas paket</h3><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Jenis asesmen"><select className="min-h-11 rounded-xl border bg-white px-3" value={form.kind} onChange={(event) => setField('kind', event.target.value)}><option value="ujian_online">Ujian Online</option><option value="simulasi">Simulasi Asesmen</option></select></Field><Field label="Judul asesmen"><input className="min-h-11 rounded-xl border px-3" value={form.title} onChange={(event) => setField('title', event.target.value)} placeholder="Contoh: Literasi membaca — kelas 6" /></Field><Field label="Kelas peserta"><select className="min-h-11 rounded-xl border bg-white px-3" value={form.classId} onChange={(event) => { const classId = event.target.value; setField('classId', classId); setStudentIds((current) => current.filter((id) => students.some((student) => student.id === id && student.kelasId === classId))) }}><option value="">Pilih kelas</option>{classes.map((row) => <option key={row.id} value={row.id}>{row.nama}{row.manualFallback ? ' · Label sementara' : ` · Paket ${['A', 'B', 'C'][Math.max(0, Math.min(row.jenjang - 1, 2))]}`}{row.kelompokBelajar ? ` · ${row.kelompokBelajar}` : ''}{row.tahunAjaran ? ` · ${row.tahunAjaran}` : ''}</option>)}</select></Field>{classes.length === 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 sm:col-span-2"><p className="font-bold">{classLoadIssue || 'Data kelas belum tersedia dari LMS.'}</p>{students.length > 0 ? <><p className="mt-1">Fallback sementara hanya dapat memberi nama pada kelas yang masih memiliki peserta aktif tersinkron. Label ini akan diperbarui jika feed LMS mengirimkan data resmi untuk kelas tersebut.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Pilih kelompok peserta tersinkron"><select className="min-h-11 rounded-xl border bg-white px-3" value={manualClassID} onChange={(event) => setManualClassID(event.target.value)}><option value="">Pilih kelompok peserta</option>{[...new Set(students.map((student) => student.kelasId).filter(Boolean))].map((classID) => { const members = students.filter((student) => student.kelasId === classID); return <option key={classID} value={classID}>{members.length} peserta · {members.slice(0, 2).map((student) => student.nama).join(', ')}{classID.length > 18 ? ` · …${classID.slice(-8)}` : ` · ${classID}`}</option> })}</select></Field><Field label="Nama kelas (sementara)"><input className="min-h-11 rounded-xl border px-3" value={manualClassName} onChange={(event) => setManualClassName(event.target.value)} placeholder="Contoh: Paket B — Kelas 7" maxLength={100}/></Field></div><Button type="button" variant="secondary" className="mt-3 w-full sm:w-auto" disabled={!manualClassID || !manualClassName.trim() || manualClassBusy || session.user.role === 'kepala_sekolah'} onClick={() => void createManualClass()}>{manualClassBusy ? 'Menyimpan label…' : 'Buat pilihan kelas sementara'}</Button></> : <><p className="mt-1">Belum ada peserta aktif dari LMS, jadi kelas manual tidak dapat dipetakan dengan aman. Sinkronkan LMS dahulu sebelum membuat asesmen.</p>{session.user.role !== 'kepala_sekolah' && <Button type="button" variant="secondary" className="mt-3" onClick={onSync}>Buka sinkronisasi LMS</Button>}</>}</div>}{form.kind === 'ujian_online' && <Field label="Kode akses siswa"><input className="min-h-11 rounded-xl border px-3" value={form.accessCode} onChange={(event) => setField('accessCode', event.target.value)} placeholder="Dibagikan tutor kepada siswa" /></Field>}<Field label="Durasi (menit)"><input className="min-h-11 rounded-xl border px-3" type="number" min="1" max="1440" value={form.durationMinute} onChange={(event) => setField('durationMinute', Number(event.target.value))} /></Field><Field label="Mapel / domain"><input className="min-h-11 rounded-xl border px-3" value={form.subjectId} onChange={(event) => setField('subjectId', event.target.value)} placeholder="Bahasa Indonesia / Matematika" /></Field></div></Card>
        <Card className="p-4"><Field label="Ruang (opsional)"><input className="min-h-11 w-full rounded-xl border px-3" value={form.room} onChange={(event) => setField('room', event.target.value)} maxLength={120} placeholder="Contoh: Lab Komputer atau Ruang 2" /><span className="text-xs font-normal text-slate-500">Jadwal terbit akan ditolak bila kelas atau ruang yang sama sudah memiliki asesmen pada waktu yang bertumpang tindih.</span></Field></Card>
        {mode === 'simple' && <details className="rounded-2xl border bg-white p-4"><summary className="min-h-11 cursor-pointer py-2 font-bold">Pengaturan lainnya (opsional)</summary><div className="mt-3 space-y-3"><Field label="Instruksi siswa"><textarea className="min-h-24 w-full rounded-xl border p-3" value={form.instructions} onChange={(event) => setField('instructions', event.target.value)} placeholder="Baca instruksi sebelum mulai." /></Field><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.randomize} onChange={(event) => setField('randomize', event.target.checked)} />Acak urutan soal untuk setiap siswa</label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.showResult} onChange={(event) => setField('showResult', event.target.checked)} />Tampilkan hasil setelah dikirim</label><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={() => { setMode('complete'); localStorage.setItem(`${key}-mode`, 'complete') }}>Buka pengaturan lengkap</Button></div></div></details>}
        {mode === 'complete' && <Card className="space-y-4 p-4"><div><h3 className="font-bold">Jadwal dan pengerjaan</h3><p className="text-sm text-slate-600">Waktu server menjadi acuan buka, tutup, dan timer pengerjaan.</p></div><div className="grid gap-3 sm:grid-cols-2"><fieldset className="min-w-0 space-y-2"><legend className="text-sm font-semibold text-slate-700">Mulai (opsional)</legend><div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-xs font-medium text-slate-600"><span>Tanggal mulai</span><input aria-label="Tanggal mulai (opsional)" type="date" className="min-h-11 min-w-0 w-full rounded-xl border px-2 sm:px-3" value={scheduleDatePart(form.startsAt)} onChange={(event) => setSchedulePart('startsAt', 'date', event.target.value)} /></label><label className="grid gap-1 text-xs font-medium text-slate-600"><span>Jam mulai</span><input aria-label="Jam mulai (opsional)" type="time" className="min-h-11 min-w-0 w-full rounded-xl border px-2 sm:px-3" value={scheduleTimePart(form.startsAt)} disabled={!form.startsAt} onChange={(event) => setSchedulePart('startsAt', 'time', event.target.value)} /></label></div></fieldset><fieldset className="min-w-0 space-y-2"><legend className="text-sm font-semibold text-slate-700">Selesai (opsional)</legend><div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-xs font-medium text-slate-600"><span>Tanggal selesai</span><input aria-label="Tanggal selesai (opsional)" type="date" className="min-h-11 min-w-0 w-full rounded-xl border px-2 sm:px-3" value={scheduleDatePart(form.endsAt)} onChange={(event) => setSchedulePart('endsAt', 'date', event.target.value)} /></label><label className="grid gap-1 text-xs font-medium text-slate-600"><span>Jam selesai</span><input aria-label="Jam selesai (opsional)" type="time" className="min-h-11 min-w-0 w-full rounded-xl border px-2 sm:px-3" value={scheduleTimePart(form.endsAt)} disabled={!form.endsAt} onChange={(event) => setSchedulePart('endsAt', 'time', event.target.value)} /></label></div></fieldset><p className="text-xs text-slate-500 sm:col-span-2">Pilih tanggal melalui kalender, lalu atur jam. Jika jam tidak diubah, jadwal menggunakan pukul 00.00.</p><Field label="Batas percobaan"><input type="number" min="1" max="20" className="min-h-11 rounded-xl border px-3" value={form.maxAttempts} onChange={(event) => setField('maxAttempts', Number(event.target.value))} /></Field><Field label="Nilai lulus (0–100)"><input type="number" min="0" max="100" className="min-h-11 rounded-xl border px-3" value={form.passScore} onChange={(event) => setField('passScore', Number(event.target.value))} /></Field></div><Field label="Instruksi siswa"><textarea className="min-h-24 w-full rounded-xl border p-3" value={form.instructions} onChange={(event) => setField('instructions', event.target.value)} /></Field><div className="grid gap-2 sm:grid-cols-2"><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.randomize} onChange={(event) => setField('randomize', event.target.checked)} />Acak urutan soal</label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.randomizeOptions} onChange={(event) => setField('randomizeOptions', event.target.checked)} />Acak urutan opsi</label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.showResult} onChange={(event) => setField('showResult', event.target.checked)} />Tampilkan nilai</label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.showReview} onChange={(event) => setField('showReview', event.target.checked)} />Tampilkan ulasan jawaban</label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.progressBar} onChange={(event) => setField('progressBar', event.target.checked)} />Tampilkan progres</label></div><Field label="Kebijakan hasil"><select className="min-h-11 rounded-xl border bg-white px-3" value={form.resultsPolicy} onChange={(event) => setField('resultsPolicy', event.target.value)}><option value="immediate">Nilai langsung setelah kirim</option><option value="after_review">Nilai setelah ditinjau tutor</option><option value="hidden">Nilai disembunyikan</option></select></Field><Field label="Pesan setelah kirim"><textarea className="min-h-20 w-full rounded-xl border p-3" value={form.confirmationMessage} onChange={(event) => setField('confirmationMessage', event.target.value)} /></Field></Card>}
      </div>
      <Card className="space-y-4 p-4 xl:sticky xl:top-24"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">Siapkan & terbitkan</p><h3 className="text-lg font-bold">Checklist kesiapan</h3></div><ul className="space-y-2 text-sm">{readinessItems.map(([ok, label]) => <li key={label} className={`flex items-center gap-2 rounded-lg p-2 ${ok ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-50 text-slate-500'}`}><span aria-hidden>{ok ? '✓' : '○'}</span>{label}</li>)}</ul><Button className="w-full" onClick={() => void publish()} disabled={publishBusy || saveState === 'conflict'}><Send className="size-4"/>{publishBusy ? 'Menerbitkan…' : 'Terbitkan asesmen'}</Button><Button type="button" variant="secondary" className="w-full" onClick={() => { setPreviewAnswer(null); setPreview(true) }}>Pratinjau siswa</Button></Card>
    </div>
    {questionOpen && <Card className="p-5"><div className="mb-4 flex justify-between gap-3"><div><h3 className="text-lg font-bold">{questionEditing ? 'Edit soal dalam draf' : 'Tambah soal baru'}</h3><p className="text-sm text-slate-600">{questionEditing?.templatePlaceholder ? 'Ganti teks contoh dan lengkapi kunci jawaban atau rubrik. Perubahan tetap tersimpan sebagai draf.' : 'Soal baru tersimpan di Bank Soal, lalu dipakai dalam draf ini.'}</p></div><Button type="button" variant="secondary" onClick={() => { setQuestionOpen(false); setQuestionEditing(null) }}>Tutup</Button></div><QuestionEditor key={questionEditing?.id || 'builder-new-question'} initial={questionEditing || undefined} mode={mode} busy={questionBusy} session={session} storageKey={`cbt-question-draft-${session.user.id}-builder-${questionEditing?.id || 'new'}`} onSave={saveNewQuestion} onCancel={() => { setQuestionOpen(false); setQuestionEditing(null) }} /></Card>}
    {preview && <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-3 sm:p-8" role="dialog" aria-modal="true" aria-label="Pratinjau asesmen"><div className="mx-auto max-w-3xl rounded-2xl bg-white p-4 shadow-2xl sm:p-6"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">Pratinjau siswa</p><h3 className="text-xl font-bold">{form.title || 'Paket tanpa judul'}</h3></div><Button type="button" variant="secondary" onClick={() => setPreview(false)}>Tutup</Button></div>{resultPreviewQuestion ? <div className="mt-5"><StimulusContent rows={(() => { try { return JSON.parse(resultPreviewQuestion.stimulusJson || '[]') } catch { return [] } })()} accessToken={session.accessToken} /><p className="whitespace-pre-wrap text-lg">{resultPreviewQuestion.prompt}</p><QuestionAnswerControl question={{ id: resultPreviewQuestion.id, title: resultPreviewQuestion.title, type: resultPreviewQuestion.type, prompt: resultPreviewQuestion.prompt, description: resultPreviewQuestion.description, config: previewConfig(resultPreviewQuestion), points: resultPreviewQuestion.points }} questionId={`preview-${resultPreviewQuestion.id}`} value={previewAnswer} onChange={setPreviewAnswer} accessToken={session.accessToken} /></div> : <p className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Tambahkan soal untuk melihat pratinjau siswa.</p>}</div></div>}
  </div>
}

function SchedulePanel({ session }: { session: Session }) {
  const [rows, setRows] = useState<Assessment[]>([])
  const [classes, setClasses] = useState<Kelas[]>([])
  const [classID, setClassID] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { void Promise.all([api<Assessment[]>('/staff/schedule', {}, session), api<Kelas[]>('/staff/master/classes', {}, session)]).then(([schedule, classRows]) => { setRows(schedule); setClasses(classRows) }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Jadwal asesmen belum dapat dimuat.')) }, [session])
  const classNames = new Map(classes.map((row) => [row.id, row.nama]))
  const visible = rows.filter((row) => (!classID || row.classId === classID) && (!status || row.status === status))
  return <><div><p className="text-sm font-bold uppercase tracking-wider text-brand">Kalender asesmen</p><h2 className="text-2xl font-bold">Jadwal per kelas dan ruang</h2><p className="text-sm text-slate-600">Jadwal diurutkan berdasarkan waktu mulai. Waktu yang bertumpang tindih untuk kelas atau ruang yang sama ditolak saat diterbitkan.</p></div><Card className="space-y-4 p-5"><div className="grid gap-3 sm:grid-cols-2"><Field label="Filter kelas"><select className="min-h-11 rounded-xl border bg-white px-3" value={classID} onChange={(event) => setClassID(event.target.value)}><option value="">Semua kelas</option>{classes.map((row) => <option key={row.id} value={row.id}>{row.nama}</option>)}</select></Field><Field label="Status jadwal"><select className="min-h-11 rounded-xl border bg-white px-3" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Semua status</option><option value="published">Terbit</option><option value="draft">Draf</option><option value="archived">Arsip</option></select></Field></div>{error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}{visible.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Belum ada jadwal yang cocok dengan filter.</p> : <div className="space-y-3">{visible.map((row) => <article key={row.id} className="grid gap-3 rounded-xl border p-4 sm:grid-cols-[1fr_auto]"><div><p className="text-xs font-bold uppercase text-brand">{row.startsAt ? new Date(row.startsAt).toLocaleString('id-ID') : 'Waktu belum ditentukan'}{row.endsAt ? ` – ${new Date(row.endsAt).toLocaleString('id-ID')}` : ''}</p><h3 className="mt-1 font-bold">{row.title}</h3><p className="text-sm text-slate-600">{classNames.get(row.classId) || row.classId || 'Belum ditentukan'}{row.room ? ` · ${row.room}` : ''} · {row.kind === 'simulasi' ? 'Simulasi' : 'Ujian Online'}</p></div><span className="h-fit rounded-full bg-slate-100 px-3 py-1 text-sm">{row.status === 'published' ? 'Terbit' : row.status === 'archived' ? 'Arsip' : 'Draf'}</span></article>)}</div>}</Card></>
}

function LiveMonitor({ session }: { session: Session }) {
  type Participant = { studentId: string; name: string; status: string; attemptNumber?: number; startedAt?: string; deadlineAt?: string; submittedAt?: string; remainingSeconds?: number }
  type MonitorData = { assessmentId: string; title: string; serverTime: string; counts: Record<string, number>; participants: Participant[]; refreshAfterSeconds: number }
  const [assessments, setAssessments] = useState<Assessment[]>([])
  const [selected, setSelected] = useState('')
  const [data, setData] = useState<MonitorData | null>(null)
  const [updatedAt, setUpdatedAt] = useState('')
  const [error, setError] = useState('')
  const load = async (assessmentID: string) => {
    try { const next = await api<MonitorData>(`/staff/assessments/${assessmentID}/monitor`, {}, session); setData(next); setUpdatedAt(new Date().toLocaleTimeString('id-ID')); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Monitor belum dapat dimuat.') }
  }
  useEffect(() => { void api<Assessment[]>('/staff/assessments', {}, session).then((rows) => { const active = rows.filter((row) => row.status === 'published'); setAssessments(active); if (active[0]) setSelected(active[0].id) }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Daftar asesmen tidak dapat dimuat.')) }, [session])
  useEffect(() => { setData(null); if (!selected) return; void load(selected); const timer = window.setInterval(() => void load(selected), 15_000); return () => window.clearInterval(timer) }, [selected, session])
  return <><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-bold uppercase tracking-wider text-brand">Pemantauan sesi</p><h2 className="text-2xl font-bold">Monitor ujian live</h2><p className="text-sm text-slate-600">Status dan sisa waktu diperbarui otomatis setiap 15 detik. Jawaban siswa tidak ditampilkan di layar monitor.</p></div>{selected && <Button type="button" variant="secondary" onClick={() => void load(selected)}><Activity className="size-4"/>Perbarui sekarang</Button>}</div><Card className="space-y-4 p-5"><Field label="Asesmen yang dipantau"><select className="min-h-11 w-full rounded-xl border bg-white px-3" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Pilih asesmen terbit</option>{assessments.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></Field>{error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}{!assessments.length && !error && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Belum ada asesmen terbit untuk dipantau.</p>}{data && <><p className="text-xs text-slate-500" aria-live="polite">Pembaruan terakhir {updatedAt} · acuan waktu server {new Date(data.serverTime).toLocaleTimeString('id-ID')}</p><div className="grid grid-cols-3 gap-2">{[['Mengerjakan', data.counts.mengerjakan || 0, 'bg-sky-50 text-sky-900'], ['Selesai', data.counts.selesai || 0, 'bg-emerald-50 text-emerald-900'], ['Belum mulai', data.counts.belum_mulai || 0, 'bg-amber-50 text-amber-900']].map(([label, count, color]) => <div key={String(label)} className={`rounded-xl p-3 ${String(color)}`}><p className="text-xs font-semibold">{label}</p><p className="text-2xl font-bold">{count}</p></div>)}</div><div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="border-b text-slate-500"><tr><th className="p-3">Peserta</th><th className="p-3">Status</th><th className="p-3">Percobaan</th><th className="p-3">Sisa waktu</th></tr></thead><tbody>{data.participants.map((row) => <tr key={row.studentId} className="border-b"><td className="p-3 font-semibold">{row.name}</td><td className="p-3">{row.status === 'mengerjakan' ? 'Mengerjakan' : row.status === 'selesai' ? 'Selesai' : row.status === 'nonaktif' ? 'Akun nonaktif' : 'Belum mulai'}</td><td className="p-3">{row.attemptNumber || '—'}</td><td className="p-3 tabular-nums">{row.status === 'mengerjakan' ? `${Math.floor((row.remainingSeconds || 0) / 60)}:${String((row.remainingSeconds || 0) % 60).padStart(2, '0')}` : '—'}</td></tr>)}</tbody></table></div></>}</Card></>
}

function Results({ session }: { session: Session }) {
  const [rows, setRows] = useState<Assessment[]>([]); const [selected, setSelected] = useState(''); const [attempts, setAttempts] = useState<Attempt[]>([])
  const [classes, setClasses] = useState<Kelas[]>([])
  const [classFilter, setClassFilter] = useState(''); const [studentFilter, setStudentFilter] = useState(''); const [statusFilter, setStatusFilter] = useState(''); const [fromFilter, setFromFilter] = useState(''); const [toFilter, setToFilter] = useState('')
  useEffect(() => { void api<Assessment[]>('/staff/assessments', {}, session).then(setRows) }, [])
  useEffect(() => { void api<Kelas[]>('/staff/master/classes', {}, session).then(setClasses).catch(() => setClasses([])) }, [session])
  useEffect(() => { if (selected) void api<Attempt[]>(`/staff/assessments/${selected}/results`, {}, session).then(setAttempts) }, [selected])
  async function download(format: 'csv' | 'xlsx' | 'pdf') {
    const params = new URLSearchParams(); if (classFilter) params.set('classId', classFilter); if (studentFilter) params.set('studentId', studentFilter); if (statusFilter) params.set('status', statusFilter); if (fromFilter) params.set('from', new Date(`${fromFilter}T00:00:00`).toISOString()); if (toFilter) params.set('to', new Date(`${toFilter}T23:59:59.999`).toISOString())
    const query = params.size ? `?${params.toString()}` : ''
    const response = await fetch(`/api/staff/assessments/${selected}/results/export.${format}${query}`, { headers: { Authorization: `Bearer ${session.accessToken}` } })
    if (!response.ok) throw new Error('Laporan tidak dapat diunduh')
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `hasil-asesmen.${format}`; link.click(); URL.revokeObjectURL(url)
  }
  const visibleAttempts = attempts.filter((row) => {
    const timestamp = row.startedAt ? new Date(row.startedAt).getTime() : 0
    return (!classFilter || row.classIdAtAttempt === classFilter) && (!studentFilter || row.studentId === studentFilter) && (!statusFilter || row.status === statusFilter) && (!fromFilter || timestamp >= new Date(`${fromFilter}T00:00:00`).getTime()) && (!toFilter || timestamp <= new Date(`${toFilter}T23:59:59.999`).getTime())
  })
  const classIDs = [...new Set(attempts.map((row) => row.classIdAtAttempt).filter((value): value is string => Boolean(value)))].sort()
  const classNames = new Map(classes.map((row) => [row.id, row.nama]))
  const students = [...new Map(attempts.filter((row) => row.studentId).map((row) => [row.studentId, row])).values()].sort((a, b) => (a.studentName || '').localeCompare(b.studentName || '', 'id'))
  return <><div><p className="text-sm font-bold uppercase tracking-wider text-brand">Rekap dan penilaian</p><h2 className="text-2xl font-bold">Hasil asesmen</h2><p className="text-sm text-slate-600">Riwayat mengunci kelas pada saat ujian dikerjakan sehingga perpindahan kelas tidak mengubah laporan lama.</p></div><Card className="space-y-4 p-5"><Field label="Pilih asesmen"><select value={selected} onChange={(e) => { setSelected(e.target.value); setClassFilter(''); setStudentFilter(''); setStatusFilter(''); setFromFilter(''); setToFilter('') }} className="mt-1 min-h-11 w-full max-w-xl rounded-xl border border-slate-300 bg-white px-3"><option value="">Pilih asesmen</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></Field>{selected && <><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><Field label="Kelas"><select className="min-h-11 rounded-xl border bg-white px-3" value={classFilter} onChange={(event) => setClassFilter(event.target.value)}><option value="">Semua kelas</option>{classIDs.map((id) => <option key={id} value={id}>{classNames.get(id) || id}</option>)}</select></Field><Field label="Siswa"><select className="min-h-11 rounded-xl border bg-white px-3" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}><option value="">Semua siswa</option>{students.map((row) => <option key={row.studentId} value={row.studentId}>{row.studentName || row.studentId}</option>)}</select></Field><Field label="Status"><select className="min-h-11 rounded-xl border bg-white px-3" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">Semua status</option>{['started', 'submitted', 'completed', 'pending_grade', 'expired'].map((status) => <option key={status} value={status}>{status}</option>)}</select></Field><Field label="Dari tanggal"><input type="date" className="min-h-11 rounded-xl border px-3" value={fromFilter} onChange={(event) => setFromFilter(event.target.value)}/></Field><Field label="Sampai tanggal"><input type="date" className="min-h-11 rounded-xl border px-3" value={toFilter} onChange={(event) => setToFilter(event.target.value)}/></Field></div><div className="flex flex-wrap gap-2">{(['csv', 'xlsx', 'pdf'] as const).map((format) => <Button key={format} variant="secondary" onClick={() => void download(format).catch((error: unknown) => window.alert(error instanceof Error ? error.message : 'Laporan tidak dapat diunduh'))}><Download className="size-4"/> Unduh {format.toUpperCase()}</Button>)}</div><p className="text-sm text-slate-600">Menampilkan {visibleAttempts.length} dari {attempts.length} percobaan.</p><ScoreDistribution attempts={visibleAttempts}/><div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="border-b text-slate-500"><tr><th className="p-3">Siswa</th><th className="p-3">Kelas saat ujian</th><th className="p-3">Percobaan</th><th className="p-3">Status</th><th className="p-3">Nilai</th><th className="p-3">Waktu kirim</th></tr></thead><tbody>{visibleAttempts.map((row) => <tr key={row.id} className="border-b"><td className="p-3 font-semibold">{row.studentName || row.studentId || 'Peserta didik'}</td><td className="p-3">{classNames.get(row.classIdAtAttempt || '') || row.classIdAtAttempt || '—'}</td><td className="p-3">{row.number || '—'}</td><td className="p-3">{row.status}{row.needsManual ? ' · perlu penilaian' : ''}</td><td className="p-3 font-bold">{row.score}</td><td className="p-3">{row.submittedAt ? new Date(row.submittedAt).toLocaleString('id-ID') : '—'}</td></tr>)}</tbody></table></div></>}</Card>{selected && session.user.role !== 'kepala_sekolah' && <AssessmentItemAnalysis session={session} assessmentId={selected}/ >}{selected && <AttemptReviewPicker session={session} attempts={visibleAttempts} onUpdated={() => { void api<Attempt[]>(`/staff/assessments/${selected}/results`, {}, session).then(setAttempts) }}/>}<RecoveryInbox session={session}/></>
}

function ScoreDistribution({ attempts }: { attempts: Attempt[] }) {
  const bands = [{ label: '<60', count: 0 }, { label: '60–69', count: 0 }, { label: '70–79', count: 0 }, { label: '80–89', count: 0 }, { label: '90–100', count: 0 }]
  for (const attempt of attempts) {
    if (attempt.status === 'started' || attempt.needsManual) continue
    const score = attempt.score
    const index = score < 60 ? 0 : score < 70 ? 1 : score < 80 ? 2 : score < 90 ? 3 : 4
    bands[index].count++
  }
  const max = Math.max(1, ...bands.map((band) => band.count))
  return <section aria-label="Distribusi nilai" className="rounded-xl border p-4"><h3 className="font-bold">Distribusi nilai</h3><div className="mt-3 grid grid-cols-5 items-end gap-2" role="img" aria-label={bands.map((band) => `${band.label}: ${band.count} siswa`).join(', ')}>{bands.map((band) => <div key={band.label} className="text-center"><p className="text-xs font-semibold">{band.count}</p><div className="mx-auto mt-1 flex h-24 max-w-12 items-end rounded bg-slate-100"><div className="w-full rounded bg-brand" style={{ height: `${Math.max(4, band.count / max * 100)}%` }}/></div><p className="mt-1 text-xs text-slate-600">{band.label}</p></div>)}</div><p className="mt-2 text-xs text-slate-500">Percobaan yang masih berlangsung atau menunggu penilaian manual tidak dihitung.</p></section>
}

function AssessmentItemAnalysis({ session, assessmentId }: { session: Session; assessmentId: string }) {
  type Distractor = { id: string; text: string; selectedCount: number; selectionRate: number; nonFunctioning: boolean }
  type Row = { questionId: string; position: number; title: string; prompt: string; type: string; weight: number; attemptCount: number; answeredCount: number; correctRate?: number; difficultyIndex?: number; difficultyBand?: string; meanScore?: number; discrimination?: number; needsRevision: boolean; reason?: string; manual: boolean; distractors?: Distractor[] }
  type Report = { attemptCount: number; completedAttemptCount: number; items: Row[] }
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setReport(null); setError('')
    void api<Report>(`/staff/assessments/${assessmentId}/item-analysis`, {}, session).then(setReport).catch((reason) => setError(reason instanceof Error ? reason.message : 'Analisis butir belum dapat dimuat.'))
  }, [assessmentId, session])
  const percent = (value?: number) => value == null ? '—' : `${Math.round(value * 100)}%`
  return <Card className="space-y-4 p-5"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">Analisis per soal</p><h3 className="text-lg font-bold">Tingkat keberhasilan dan daya beda</h3><p className="mt-1 text-sm text-slate-600">Indeks kemudahan makin tinggi berarti makin banyak siswa memperoleh skor. Rekomendasi revisi baru aktif dengan minimal 10 percobaan bernilai lengkap; ini panduan telaah, bukan keputusan otomatis.</p></div>{error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}{!report && !error && <p role="status" className="text-sm text-slate-600">Memuat analisis soal…</p>}{report && <><p className="text-sm text-slate-600">{report.attemptCount} percobaan terkirim · {report.completedAttemptCount} percobaan bernilai lengkap dipakai untuk daya beda</p>{(report.items || []).length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Belum ada soal pada asesmen ini.</p> : <div className="space-y-3">{(report.items || []).map((row) => { const smallSample = report.completedAttemptCount < 10 || row.attemptCount < 10; return <article key={row.questionId} className="space-y-3 rounded-xl border p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-bold uppercase text-brand">Soal {row.position} · {row.type} · {row.weight} poin</p><h4 className="mt-1 font-semibold">{row.title || row.prompt}</h4><p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-slate-600">{row.prompt}</p></div><span className={`rounded-full px-3 py-1 text-sm font-bold ${smallSample ? 'bg-slate-100 text-slate-700' : row.needsRevision ? 'bg-amber-100 text-amber-900' : 'bg-emerald-50 text-emerald-800'}`}>{smallSample ? 'Sampel kecil' : row.needsRevision ? 'Perlu ditelaah' : 'Belum ada tanda kuat'}</span></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Jawaban terisi" value={`${row.answeredCount} / ${row.attemptCount}`} /><Metric label="Indeks kemudahan" value={percent(row.difficultyIndex)} detail={row.difficultyBand ? `Kategori ${row.difficultyBand}` : row.manual ? 'Menunggu penilaian uraian' : undefined} /><Metric label="Jawaban benar" value={row.manual ? '—' : percent(row.correctRate)} /><Metric label="Daya beda" value={row.discrimination == null ? 'Sampel kecil' : row.discrimination.toFixed(2)} detail="Kelompok atas dikurangi bawah" /></div>{row.reason && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{row.reason}</p>}{row.distractors && row.distractors.length > 0 && <details><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">Lihat pemakaian opsi pengecoh</summary><div className="mt-2 space-y-2">{row.distractors.map((choice) => <div key={choice.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-sm"><span>{choice.text}</span><span className="text-slate-600">Dipilih {choice.selectedCount}× ({percent(choice.selectionRate)}){choice.nonFunctioning && <b className="ml-2 text-amber-800">Pengecoh jarang dipilih</b>}</span></div>)}</div></details>}</article>})}</div>}</>}</Card>
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) { return <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-1 text-lg font-bold text-slate-900">{value}</p>{detail && <p className="mt-1 text-xs text-slate-600">{detail}</p>}</div> }

function AttemptReviewPicker({ session, attempts, onUpdated }: { session: Session; attempts: Attempt[]; onUpdated: () => void }) {
  type ReviewRow = { itemId: string; answerId: string; position: number; weight: number; question: StudentQuestion & { rubricJson?: string; configJson?: string }; answer: string; correct?: boolean | null; autoScore: number; manualScore?: number | null; comment?: string }
  type Detail = { attempt: { id: string; studentName: string; classIdAtAttempt: string; status: string; score: number; needsManual: boolean }; items: ReviewRow[] }
  const [attemptId, setAttemptId] = useState('')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [scores, setScores] = useState<Record<string, string>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { if (!attemptId) { setDetail(null); return }; void api<Detail>(`/staff/attempts/${attemptId}`, {}, session).then((result) => { setDetail(result); setScores(Object.fromEntries(result.items.map((row) => [row.answerId, String(row.manualScore ?? '')]))); setComments(Object.fromEntries(result.items.map((row) => [row.answerId, row.comment || '']))); setError('') }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Detail percobaan gagal dimuat.')) }, [attemptId, session])
  async function saveGrade(row: ReviewRow) {
    const score = Number(scores[row.answerId])
    const comment = comments[row.answerId]?.trim() || ''
    if (!comment || !Number.isFinite(score) || score < 0 || score > row.weight) { setError(`Masukkan nilai 0–${row.weight} dan catatan untuk soal ${row.position}.`); return }
    setBusy(row.answerId); setError('')
    try { await api(`/staff/answers/${row.answerId}/grade`, { method: 'POST', body: JSON.stringify({ score, comment }) }, session); const refreshed = await api<Detail>(`/staff/attempts/${attemptId}`, {}, session); setDetail(refreshed); setScores(Object.fromEntries(refreshed.items.map((item) => [item.answerId, String(item.manualScore ?? '')]))); setComments(Object.fromEntries(refreshed.items.map((item) => [item.answerId, item.comment || '']))); onUpdated() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Penilaian gagal disimpan.') }
    finally { setBusy('') }
  }
  return <Card className="space-y-4 p-5"><div><h3 className="font-bold">Detail jawaban & penilaian uraian</h3><p className="mt-1 text-sm text-slate-600">Kunci hanya tampil untuk staf berwenang. Isi skor lalu tekan Ctrl+Enter (Command+Enter di Mac) untuk menyimpan penilaian.</p></div><Field label="Pilih percobaan"><select className="min-h-11 w-full rounded-xl border bg-white px-3" value={attemptId} onChange={(event) => setAttemptId(event.target.value)}><option value="">Pilih siswa / percobaan</option>{attempts.map((row) => <option key={row.id} value={row.id}>{row.id.slice(0, 8)} · {row.status} · nilai {row.score}</option>)}</select></Field>{error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}{detail && <><div className="rounded-xl bg-slate-50 p-3 text-sm"><b>{detail.attempt.studentName}</b><span className="ml-2 text-slate-500">· {detail.attempt.status} · skor {detail.attempt.score}</span></div><div className="space-y-3">{detail.items.map((row) => { const isManual = row.correct == null; let answer = row.answer; try { answer = JSON.stringify(JSON.parse(row.answer), null, 2) } catch { /* Keep a readable plain answer. */ } return <article key={row.itemId} className="rounded-xl border p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold uppercase text-brand">Soal {row.position} · {row.question.type}</p><h4 className="mt-1 font-semibold">{row.question.prompt}</h4></div><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{isManual ? row.manualScore != null ? 'Sudah dinilai' : 'Perlu penilaian' : row.correct ? 'Benar' : 'Belum benar'}</span></div><p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{answer || 'Tidak dijawab'}</p>{row.question.rubricJson && <details className="mt-3"><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">Lihat rubrik</summary><pre className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{row.question.rubricJson}</pre></details>}<p className="mt-2 text-sm text-slate-600">Skor otomatis {row.autoScore} · Maksimal {row.weight}{row.manualScore != null ? ` · Skor manual ${row.manualScore}` : ''}</p>{isManual && session.user.role !== 'kepala_sekolah' && detail.attempt.status !== 'started' && <div className="mt-3 grid gap-2 sm:grid-cols-[140px_1fr_auto]"><label className="grid gap-1 text-sm font-semibold">Nilai<input type="number" min="0" max={row.weight} step="0.5" className="min-h-11 rounded-lg border px-3" value={scores[row.answerId] ?? ''} onChange={(event) => setScores((current) => ({ ...current, [row.answerId]: event.target.value }))} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void saveGrade(row) } }}/></label><label className="grid gap-1 text-sm font-semibold">Catatan penilaian<input className="min-h-11 rounded-lg border px-3" value={comments[row.answerId] ?? ''} onChange={(event) => setComments((current) => ({ ...current, [row.answerId]: event.target.value }))} placeholder="Jelaskan umpan balik untuk siswa"/></label><Button className="self-end" disabled={busy === row.answerId} onClick={() => void saveGrade(row)}>{busy === row.answerId ? 'Menyimpan…' : row.manualScore != null ? 'Perbarui nilai' : 'Simpan nilai'}</Button></div>}{!isManual && <p className="mt-2 text-sm text-slate-600">Kunci jawaban: {formatAnswerKey(row.question)}</p>}</article>})}</div></>}</Card>
}

function RecoveryInbox({ session }: { session: Session }) {
  type Recovery = { id: string; attemptId: string; assessmentTitle: string; studentName: string; status: string; submittedAt: string; comment?: string; answers: Array<{ itemId: string; value: unknown }> }
  const [rows, setRows] = useState<Recovery[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const load = () => api<Recovery[]>('/staff/recoveries', {}, session).then(setRows).catch((reason) => setError(reason instanceof Error ? reason.message : 'Pemulihan jawaban gagal dimuat.'))
  useEffect(() => { void load() }, [])
  async function decide(row: Recovery, decision: 'approve' | 'reject') {
    const comment = window.prompt(decision === 'approve' ? 'Catatan peninjauan (opsional):' : 'Alasan penolakan:')
    if (comment === null) return
    setBusy(row.id); setError('')
    try { await api(`/staff/recoveries/${row.id}/review`, { method: 'POST', body: JSON.stringify({ decision, comment }) }, session); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Tinjauan gagal disimpan.') }
    finally { setBusy('') }
  }
  if (!rows.length && !error) return null
  return <Card className="overflow-hidden"><div className="border-b p-5"><h3 className="font-bold">Jawaban terlambat untuk ditinjau</h3><p className="mt-1 text-sm text-slate-600">Jawaban offline yang masuk setelah tenggat tidak mengubah nilai sebelum disetujui tutor.</p></div>{error && <p role="alert" className="p-4 text-sm text-rose-800">{error}</p>}<div className="divide-y">{rows.map((row) => <article className="space-y-3 p-4" key={row.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><b>{row.studentName || 'Peserta didik'} · {row.assessmentTitle}</b><p className="mt-1 text-xs text-slate-500">Masuk {new Date(row.submittedAt).toLocaleString('id-ID')} · Status {row.status}</p></div>{row.status === 'pending' && session.user.role !== 'kepala_sekolah' && <div className="flex gap-2"><Button disabled={busy === row.id} onClick={() => void decide(row, 'approve')}>Setujui</Button><Button variant="secondary" disabled={busy === row.id} onClick={() => void decide(row, 'reject')}>Tolak</Button></div>}</div><details><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">Lihat jawaban yang diajukan ({row.answers.length})</summary><div className="space-y-2">{row.answers.map((answer) => <pre key={answer.itemId} className="overflow-auto rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(answer.value, null, 2)}</pre>)}</div></details>{row.comment && <p className="rounded-lg bg-slate-50 p-3 text-sm">Catatan: {row.comment}</p>}</article>)}</div></Card>
}

type SyncStateRow = { key: string; value: string; updatedAt: string }
type SyncRunRow = { id: string; trigger: string; status: string; startedAt: string; finishedAt?: string; accounts: number; classes: number; students: number; groups?: number; academicYears?: number; programs?: number; phases?: number; tutors: number; subjects: number; message?: string }
function SyncPanel({ session, notify }: { session: Session; notify: (value: Notice) => void }) {
  const [states, setStates] = useState<SyncStateRow[]>([])
  const [runs, setRuns] = useState<SyncRunRow[]>([])
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      const [nextStates, nextRuns] = await Promise.all([
        api<SyncStateRow[]>('/staff/sync/status', {}, session),
        api<SyncRunRow[]>('/staff/sync/history', {}, session),
      ])
      setStates(nextStates)
      setRuns(nextRuns)
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : 'Status sinkronisasi belum dapat dimuat.' })
    }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(timer) }, [])
  async function sync() {
    setBusy(true)
    try {
      await api('/staff/sync/run', { method: 'POST' }, session)
      notify({ kind: 'ok', text: 'Sinkronisasi selesai; data master dan waktu pembaruan sudah dicatat.' })
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : 'LMS belum dapat disinkronkan. Data terakhir tetap digunakan.' })
    } finally {
      setBusy(false)
      void load()
    }
  }
  const latest = runs[0]
  const latestSuccess = runs.find((run) => run.status === 'success')
  const syncDate = (value?: string) => value ? new Date(value).toLocaleString('id-ID') : 'Belum pernah'
  return <>
    <div><p className="text-sm font-bold uppercase tracking-wider text-brand">Integrasi LMS</p><h2 className="text-2xl font-bold">Status sinkronisasi</h2></div>
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="font-bold">Data master dari LMS</h3><p className="mt-1 text-sm text-slate-600">Roster siswa (termasuk NIS/NISN), kelas, kelompok belajar, tahun ajaran, program, tutor, mapel, dan status akun diperbarui otomatis setiap 5 menit. Jika LMS sementara tidak tersedia, CBT tetap menggunakan data terakhir.</p></div>
        <Button disabled={busy} onClick={() => void sync()}><Cloud className="size-4"/>{busy ? 'Mencoba sinkronisasi…' : 'Sinkronkan sekarang'}</Button>
      </div>
      {latest && <div role="status" className={`mt-5 rounded-xl border p-4 ${latest.status === 'success' ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
        <p className="font-bold">{latest.status === 'success' ? 'Sinkronisasi terakhir berhasil' : 'Sinkronisasi terakhir gagal'}</p>
        <p className="mt-1 text-sm">{latest.message || 'Status tersimpan.'}</p>
        <p className="mt-1 text-xs text-slate-600">{syncDate(latest.finishedAt || latest.startedAt)} · {latest.trigger === 'manual' ? 'Manual' : 'Otomatis'}</p>
      </div>}
      <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"><b>Aturan jika data berbeda</b><p className="mt-1">LMS adalah sumber utama untuk identitas, kelas, mapel, peran, dan status aktif. Perubahan master dari LMS akan menimpa salinan master di CBT; kata sandi lokal CBT tidak disalin atau ditimpa.</p></div>
      {latestSuccess && latest?.status !== 'success' && <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"><b>Sinkronisasi sukses terakhir</b><p className="mt-1">{syncDate(latestSuccess.finishedAt || latestSuccess.startedAt)} · {latestSuccess.message}</p></div>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {states.filter((row) => row.key === 'last_master_sync_counts').map((row) => <div key={row.key} className="rounded-xl bg-slate-50 p-3 text-sm sm:col-span-2 lg:col-span-5"><b>Data yang diperbarui pada batch terakhir</b><p className="mt-1 text-slate-600">{row.value || 'Belum tersedia'}</p></div>)}
        {states.filter((row) => row.key === 'master_cursor').map((row) => <div key={row.key} className="rounded-xl bg-slate-50 p-3 text-sm sm:col-span-2 lg:col-span-5"><b>Cursor pembaruan LMS</b><p className="mt-1 break-all text-slate-600">{row.value || 'Belum tersedia'}</p></div>)}
      </div>
      <div className="mt-6"><h3 className="font-bold">10 sinkronisasi terakhir</h3>{runs.length === 0 ? <p className="mt-2 text-sm text-slate-600">Belum ada catatan sinkronisasi.</p> : <div className="mt-2 space-y-2">{runs.slice(0, 10).map((run) => <div key={run.id} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-slate-200 p-3 text-sm"><div><b>{run.status === 'success' ? 'Berhasil' : run.status === 'running' ? 'Sedang berjalan' : 'Gagal'}</b><p className="mt-1 text-slate-600">{run.message || 'Sinkronisasi berlangsung.'}</p></div><span className="whitespace-nowrap text-xs text-slate-500">{syncDate(run.finishedAt || run.startedAt)}</span></div>)}</div>}</div>
    </Card>
  </>
}

export function LegacyStudentPortal({ session, onLogout }: { session: Session; onLogout: () => void }) { const [rows, setRows] = useState<Assessment[]>([]); const [attempt, setAttempt] = useState<Attempt | null>(null); const [items, setItems] = useState<AttemptItem[]>([]); const [index, setIndex] = useState(0); const [notice, setNotice] = useState<Notice>(null); const [now, setNow] = useState(Date.now()); const saveTimer = useRef<number | null>(null); const load = () => api<Assessment[]>('/student/assessments', {}, session).then(setRows).catch((error) => setNotice({ kind: 'error', text: error.message })); useEffect(() => { void load() }, []); useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, []); async function start(id: string) { try { const next = await api<Attempt>(`/student/assessments/${id}/start`, { method: 'POST' }, session); await open(next) } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Ujian tidak dapat dimulai' }) } } async function open(next: Attempt) { const data = await api<{ attempt: Attempt; items: AttemptItem[] }>(`/student/attempts/${next.id}`, {}, session); setAttempt(data.attempt); setItems(data.items); setIndex(0) } function save(item: AttemptItem, value: unknown) { setItems((current) => current.map((row) => row.id === item.id ? { ...row, answer: JSON.stringify(value), revision: row.revision + 1 } : row)); if (saveTimer.current) clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => { void api(`/student/attempts/${attempt?.id}/items/${item.id}/answer`, { method: 'PUT', body: JSON.stringify({ value, revision: item.revision }) }, session).then(() => setNotice({ kind: 'ok', text: 'Jawaban tersimpan otomatis.' })).catch((error) => setNotice({ kind: 'error', text: error.message })) }, 600) } async function flag(item: AttemptItem) { try { await api(`/student/attempts/${attempt?.id}/items/${item.id}/flag`, { method: 'PUT', body: JSON.stringify({ flagged: !item.flagged }) }, session); setItems((current) => current.map((row) => row.id === item.id ? { ...row, flagged: !row.flagged } : row)) } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Penanda tidak tersimpan' }) } } async function submit() { if (!attempt || !confirm('Kirim jawaban sekarang? Jawaban tidak dapat diubah setelah dikirim.')) return; try { const result = await api<{ status: string; score: number; showResult: boolean }>(`/student/attempts/${attempt.id}/submit`, { method: 'POST' }, session); setNotice({ kind: 'ok', text: result.showResult ? `Jawaban terkirim. Nilai sementara: ${result.score}` : 'Jawaban berhasil dikirim.' }); setAttempt({ ...attempt, status: result.status, score: result.score }) } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Gagal mengirim jawaban' }) } }
  async function uploadFile(item: AttemptItem, file: File): Promise<AnswerFile> { if (!attempt) throw new Error('Percobaan belum dimulai'); const body = new FormData(); body.set('file', file); return api<AnswerFile>(`/student/attempts/${attempt.id}/items/${item.id}/files`, { method: 'POST', body }, session) }
  async function removeFile(item: AttemptItem, fileId: string) { if (!attempt) return; await api(`/student/attempts/${attempt.id}/items/${item.id}/files/${fileId}`, { method: 'DELETE' }, session) }
  async function downloadFile(fileId: string, name: string) { if (!attempt) return; const response = await fetch(`/api/student/attempts/${attempt.id}/files/${fileId}`, { headers: { Authorization: `Bearer ${session.accessToken}` } }); if (!response.ok) { setNotice({ kind: 'error', text: 'Berkas tidak dapat diunduh.' }); return }; const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url) }
  if (!attempt) return <div className="min-h-screen bg-slate-50"><header className="bg-brand text-white"><div className="mx-auto flex max-w-4xl items-center justify-between gap-3 p-4"><div><b>CBT PKBM Tunas Ilmu</b><p className="text-sm text-cyan-100">{session.user.nama}</p></div><Button variant="secondary" onClick={onLogout}><LogOut className="size-4"/> Keluar</Button></div></header><main className="mx-auto max-w-3xl space-y-4 p-4"><NoticeBox notice={notice}/><div><p className="text-sm font-bold uppercase tracking-wider text-brand">Asesmen tersedia</p><h1 className="text-2xl font-bold">Pilih ujian</h1></div>{rows.map((row) => <Card key={row.id} className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><span className="rounded-full bg-cyan-50 px-2 py-1 text-xs font-bold text-brand">{row.kind === 'simulasi' ? 'Simulasi' : 'Ujian Online'}</span><h2 className="mt-2 text-lg font-bold">{row.title}</h2><p className="mt-1 text-sm text-slate-600">Durasi {row.durationMinute} menit</p></div><Button onClick={() => void start(row.id)}><Play className="size-4"/> Mulai</Button></div></Card>)}</main></div>
  const item = items[index]; const value = item?.answer ? (() => { try { return JSON.parse(item.answer) } catch { return item.answer } })() : ''; const remaining = attempt.deadlineAt ? Math.max(0, new Date(attempt.deadlineAt).getTime() - now) : 0; const time = `${String(Math.floor(remaining / 3600000)).padStart(2, '0')}:${String(Math.floor(remaining / 60000) % 60).padStart(2, '0')}:${String(Math.floor(remaining / 1000) % 60).padStart(2, '0')}`
  return <div className="min-h-screen bg-slate-100"><header className="sticky top-0 z-20 bg-brand text-white"><div className="mx-auto flex max-w-7xl items-center justify-between gap-3 p-3"><div><b>CBT PKBM Tunas Ilmu</b><span className="ml-3 text-sm text-cyan-100">Soal {index + 1} dari {items.length}</span></div><div className={`rounded-lg px-3 py-2 font-mono font-bold ${remaining <= 300000 ? 'bg-rose-600' : remaining <= 900000 ? 'bg-amber-500 text-slate-950' : 'bg-white/15'}`}>{time}</div></div></header><main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[200px_minmax(0,1fr)]"><aside className="order-2 lg:order-1"><Card className="p-3"><p className="mb-2 text-sm font-bold">Daftar soal</p><div className="grid grid-cols-5 gap-2 lg:grid-cols-3">{items.map((row, itemIndex) => <button key={row.id} aria-label={`Soal ${itemIndex + 1}${row.flagged ? ', ditandai' : ''}${row.answer ? ', sudah dijawab' : ', belum dijawab'}`} aria-current={itemIndex === index ? 'step' : undefined} onClick={() => setIndex(itemIndex)} className={`min-h-11 rounded-lg text-sm font-bold ${itemIndex === index ? 'bg-brand text-white' : row.answer && row.answer !== 'null' ? 'bg-emerald-100 text-emerald-800' : row.flagged ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>{itemIndex + 1}</button>)}</div></Card></aside><div className="order-1 space-y-3 lg:order-2"><NoticeBox notice={notice}/><Card className="p-5 sm:p-7"><div className="mb-4 flex items-start justify-between gap-3"><div><p className="text-sm font-bold text-brand">Pertanyaan {index + 1}</p><h1 className="mt-1 text-xl font-bold">{item.question.title}</h1><p className="mt-1 text-xs text-slate-500">{item.question.points} poin</p></div><Button variant="secondary" onClick={() => void flag(item)}>{item.flagged ? <Check className="size-4"/> : <Settings2 className="size-4"/>}{item.flagged ? 'Ditandai' : 'Ragu-ragu'}</Button></div><StimulusContent rows={item.question.stimulus} accessToken={session.accessToken}/><p className="whitespace-pre-wrap text-lg leading-relaxed">{item.question.prompt}</p>{item.question.description && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600">{item.question.description}</p>}<QuestionAnswerControl question={item.question} questionId={item.id} value={value} onChange={(next) => save(item, next)} onFileUpload={(file) => uploadFile(item, file)} onFileRemove={(fileId) => removeFile(item, fileId)} onFileDownload={(fileId, name) => void downloadFile(fileId, name)} accessToken={session.accessToken}/></Card><div className="flex flex-wrap items-center justify-between gap-3"><Button variant="secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft className="size-4"/> Sebelumnya</Button>{index === items.length - 1 ? <Button onClick={() => void submit()}><Send className="size-4"/> Kirim jawaban</Button> : <Button onClick={() => setIndex(index + 1)}>Berikutnya <ChevronRight className="size-4"/></Button>}</div></div></main></div>
}
