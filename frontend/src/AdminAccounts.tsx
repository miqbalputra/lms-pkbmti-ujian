import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Plus, RefreshCw, Search, ShieldCheck, UserRoundCog, X } from 'lucide-react'
import { api, type Session } from './api'

type Account = { id: string; sourceUserId?: string; username: string; nama: string; role: string; pesertaDidikId?: string; active: boolean; createdAt: string }
type Student = { id: string; nama: string; nis?: string; nisn?: string; kelas?: string; active: boolean }
type Notice = { kind: 'ok' | 'error'; text: string } | null

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</section>
}
function Button({ children, variant = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  return <button {...props} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 font-semibold disabled:opacity-50 ${variant === 'primary' ? 'bg-brand text-white hover:bg-brand-dark' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'} ${className}`}>{children}</button>
}

export function AdminAccounts({ session, notify }: { session: Session; notify: (value: Notice) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [nama, setNama] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('guru')
  const [studentId, setStudentId] = useState('')
  const [studentSearch, setStudentSearch] = useState('')
  const [resetAccount, setResetAccount] = useState<Account | null>(null)
  const [newPassword, setNewPassword] = useState('')

  async function load() {
    setError('')
    try {
      const [nextAccounts, nextStudents] = await Promise.all([
        api<Account[]>('/admin/accounts', {}, session),
        api<Student[]>('/staff/master/students?includeInactive=true', {}, session),
      ])
      setAccounts(nextAccounts)
      setStudents(nextStudents)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Data akun belum dapat dimuat.')
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [session.accessToken])

  const visible = useMemo(() => accounts.filter((row) =>
    (!roleFilter || row.role === roleFilter) && `${row.nama} ${row.username}`.toLocaleLowerCase('id-ID').includes(search.toLocaleLowerCase('id-ID')),
  ), [accounts, roleFilter, search])
  const availableStudents = students.filter((student) => student.active && `${student.nama} ${student.nis || ''} ${student.nisn || ''} ${student.kelas || ''}`.toLocaleLowerCase('id-ID').includes(studentSearch.toLocaleLowerCase('id-ID')))
  const roleNames: Record<string, string> = { admin: 'Administrator CBT', guru: 'Tutor', kepala_sekolah: 'Kepala sekolah', siswa: 'Siswa' }

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const created = await api<Account>('/admin/accounts', { method: 'POST', body: JSON.stringify({ username: username.trim(), password, nama: nama.trim(), role, pesertaDidikID: role === 'siswa' ? studentId : '', active: true }) }, session)
      setAccounts((rows) => [...rows, created].sort((a, b) => a.username.localeCompare(b.username, 'id-ID')))
      setNama(''); setUsername(''); setPassword(''); setStudentId(''); setShowCreate(false)
      notify({ kind: 'ok', text: `Akun CBT ${created.username} berhasil dibuat.` })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Akun gagal dibuat.') }
    finally { setBusy(false) }
  }

  async function reset(event: FormEvent) {
    event.preventDefault(); if (!resetAccount) return; setBusy(true); setError('')
    try {
      await api(`/admin/accounts/${encodeURIComponent(resetAccount.id)}/password`, { method: 'PUT', body: JSON.stringify({ password: newPassword }) }, session)
      notify({ kind: 'ok', text: `Kata sandi akun CBT ${resetAccount.username} berhasil diatur ulang.` })
      setResetAccount(null); setNewPassword('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Kata sandi belum dapat diatur ulang.') }
    finally { setBusy(false) }
  }

  return <div className="space-y-5">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-bold uppercase tracking-wider text-brand">Administrasi akses</p><h2 className="text-2xl font-bold">Manajemen akun</h2><p className="mt-1 max-w-2xl text-sm text-slate-600">Akun yang berasal dari LMS dikelola LMS. Di sini admin membuat akun CBT lokal dan mengatur ulang kata sandi lokal.</p></div><div className="flex gap-2"><Button variant="secondary" className="size-11 px-0" aria-label="Muat ulang akun" onClick={() => { setLoading(true); void load() }}><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`}/></Button><Button onClick={() => { setShowCreate((value) => !value); setError('') }}><Plus className="size-4"/>{showCreate ? 'Tutup form' : 'Buat akun'}</Button></div></header>
    <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"><ShieldCheck className="mt-0.5 size-5 shrink-0"/><p>Perubahan akun lokal tidak menulis ke database LMS. Password SSO LMS tidak disalin dan tidak bisa diatur dari halaman ini.</p></div>
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {showCreate && <Card className="p-4 sm:p-5"><h3 className="text-lg font-bold">Buat akun CBT lokal</h3><p className="mt-1 text-sm text-slate-600">Gunakan untuk staf atau siswa yang memang membutuhkan kredensial lokal CBT.</p><form onSubmit={(event) => void create(event)} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold">Nama lengkap<input required autoComplete="name" className="min-h-11 min-w-0 rounded-xl border px-3 font-normal" value={nama} onChange={(event) => setNama(event.target.value)} placeholder="Nama pengguna"/></label>
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold">Username<input required autoComplete="username" className="min-h-11 min-w-0 rounded-xl border px-3 font-normal" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username CBT"/></label>
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold">Peran<select className="min-h-11 min-w-0 rounded-xl border bg-white px-3 font-normal" value={role} onChange={(event) => { setRole(event.target.value); setStudentId('') }}><option value="guru">Tutor</option><option value="kepala_sekolah">Kepala sekolah</option><option value="admin">Administrator CBT</option><option value="siswa">Siswa</option></select></label>
      {role === 'siswa' && <div className="grid gap-2 sm:col-span-2 xl:col-span-3"><label className="grid gap-1.5 text-sm font-semibold">Cari siswa<input className="min-h-11 rounded-xl border px-3 font-normal" value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} placeholder="Nama, NIS, NISN, atau kelas"/></label><label className="grid gap-1.5 text-sm font-semibold">Hubungkan ke peserta didik<select required className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={studentId} onChange={(event) => { const id = event.target.value; setStudentId(id); const student = students.find((row) => row.id === id); if (student && !nama) setNama(student.nama) }}><option value="">Pilih siswa aktif dari LMS</option>{availableStudents.map((student) => <option key={student.id} value={student.id}>{student.nama} · NISN {student.nisn || '—'} · {student.kelas || 'Tanpa kelas'}</option>)}</select><span className="text-xs font-normal text-slate-500">Identitas dan status siswa tetap mengikuti data roster LMS.</span></label></div>}
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold">Kata sandi awal (minimal 10 karakter)<input required minLength={10} autoComplete="new-password" type="password" className="min-h-11 min-w-0 rounded-xl border px-3 font-normal" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Kata sandi sementara"/></label>
      <div className="flex items-end gap-2"><Button type="submit" disabled={busy || (role === 'siswa' && !studentId)}>{busy ? 'Menyimpan…' : 'Simpan akun'}</Button><Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>Batal</Button></div>
    </form></Card>}
    <Card className="overflow-hidden"><div className="grid gap-3 border-b p-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:p-5"><label className="grid gap-1.5 text-sm font-semibold">Cari akun<span className="relative"><Search className="absolute left-3 top-3.5 size-4 text-slate-400"/><input className="min-h-11 w-full rounded-xl border pl-9 pr-3 font-normal" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nama atau username"/></span></label><label className="grid gap-1.5 text-sm font-semibold">Peran<select className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="">Semua peran</option>{Object.entries(roleNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><p className="text-sm text-slate-600 sm:col-span-2">{visible.length} akun ditampilkan dari {accounts.length}.</p></div>
      {loading ? <div role="status" className="p-8 text-center text-sm text-slate-600">Memuat akun…</div> : visible.length === 0 ? <div className="p-8 text-center"><UserRoundCog className="mx-auto size-8 text-slate-400"/><p className="mt-2 font-semibold">{accounts.length ? 'Tidak ada akun yang cocok.' : 'Belum ada akun.'}</p><p className="mt-1 text-sm text-slate-600">{accounts.length ? 'Coba ubah pencarian atau filter peran.' : 'Buat akun lokal bila pengguna belum memiliki akses melalui SSO LMS.'}</p></div> : <div className="divide-y">{visible.map((row) => { const student = students.find((item) => item.id === row.pesertaDidikId); return <article key={row.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">{row.nama || row.username}</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold">{roleNames[row.role] || row.role}</span><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.active ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{row.active ? 'Aktif' : 'Nonaktif'}</span>{row.sourceUserId && <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-900">Dikelola LMS</span>}</div><p className="mt-1 truncate text-sm text-slate-600">{row.username}{student ? ` · Siswa ${student.nama} · ${student.kelas || 'Tanpa kelas'}` : ''}</p></div>{!row.sourceUserId && <Button variant="secondary" className="w-full sm:w-auto" onClick={() => { setResetAccount(row); setNewPassword(''); setError('') }}>Atur ulang sandi</Button>}</article> })}</div>}
    </Card>
    {resetAccount && <div className="fixed inset-0 z-50 grid items-end bg-slate-950/45 p-0 sm:place-items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="reset-password-title" className="w-full rounded-t-2xl bg-white p-5 shadow-2xl sm:max-w-lg sm:rounded-2xl"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-brand">Akun lokal CBT</p><h3 id="reset-password-title" className="text-lg font-bold">Atur ulang kata sandi</h3><p className="text-sm text-slate-600">{resetAccount.nama} · {resetAccount.username}</p></div><button type="button" aria-label="Tutup" className="grid size-11 place-items-center rounded-xl border" onClick={() => setResetAccount(null)}><X className="size-4"/></button></div><form className="mt-4 space-y-3" onSubmit={(event) => void reset(event)}><label className="grid gap-1.5 text-sm font-semibold">Kata sandi baru (minimal 10 karakter)<input autoFocus required minLength={10} type="password" autoComplete="new-password" className="min-h-12 rounded-xl border px-3 font-normal" value={newPassword} onChange={(event) => setNewPassword(event.target.value)}/></label><p className="text-xs text-slate-500">Password tidak ditampilkan kembali setelah disimpan.</p><div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={() => setResetAccount(null)}>Batal</Button><Button type="submit" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan kata sandi'}</Button></div></form></section></div>}
  </div>
}
