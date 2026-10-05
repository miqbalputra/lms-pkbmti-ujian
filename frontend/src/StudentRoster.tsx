import { useEffect, useMemo, useState } from 'react'
import { Cloud, RefreshCw, Search, UsersRound } from 'lucide-react'
import { api, type Session } from './api'

type Student = {
  id: string; nama: string; nis: string; nisn: string; jenisKelamin: string
  kelasId: string; kelas: string; jenjang: number; pokjarId: string
  kelompokBelajar: string; tahunAjaran: string; program: string; active: boolean; updatedAt: string
}
type Group = { id: string; namaPokjar: string; tipe?: string }
type ClassRow = { id: string; nama: string; jenjang: number; kelompokBelajar: string; tahunAjaran: string; active: boolean }
type Notice = { kind: 'ok' | 'error'; text: string } | null

export function StudentRoster({ session, notify }: { session: Session; notify: (value: Notice) => void }) {
  const [students, setStudents] = useState<Student[]>([])
  const [classes, setClasses] = useState<ClassRow[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [search, setSearch] = useState('')
  const [classFilter, setClassFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [loadError, setLoadError] = useState('')

  async function load() {
    setLoadError('')
    try {
      const [studentRows, classRows, groupRows] = await Promise.all([
        api<Student[]>('/staff/master/students?includeInactive=true', {}, session),
        api<ClassRow[]>('/staff/master/classes', {}, session),
        api<Group[]>('/staff/master/groups', {}, session),
      ])
      setStudents(Array.isArray(studentRows) ? studentRows : [])
      setClasses(Array.isArray(classRows) ? classRows : [])
      setGroups(Array.isArray(groupRows) ? groupRows : [])
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Data siswa dari LMS belum dapat dimuat.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [session.accessToken])

  async function syncNow() {
    setSyncing(true)
    try {
      const result = await api<{ syncRun?: { message?: string } }>('/staff/sync/run', { method: 'POST' }, session)
      await load()
      notify({ kind: 'ok', text: result.syncRun?.message || 'Data kelas dan siswa berhasil disinkronkan dari LMS.' })
    } catch (error) {
      notify({ kind: 'error', text: error instanceof Error ? error.message : 'Sinkronisasi LMS gagal. Data CBT yang sudah ada tetap aman.' })
    } finally {
      setSyncing(false)
    }
  }

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('id')
    return students.filter((row) => {
      const matchesSearch = !needle || `${row.nama} ${row.nis} ${row.nisn} ${row.kelas} ${row.kelompokBelajar} ${row.program}`.toLocaleLowerCase('id').includes(needle)
      const matchesClass = !classFilter || row.kelasId === classFilter
      const matchesGroup = !groupFilter || row.pokjarId === groupFilter
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' ? row.active : !row.active)
      return matchesSearch && matchesClass && matchesGroup && matchesStatus
    })
  }, [students, search, classFilter, groupFilter, statusFilter])

  const activeCount = students.filter((row) => row.active).length
  const missingClassCount = students.filter((row) => !row.kelasId).length
  const classLabel = (row: Student) => row.kelas || classes.find((item) => item.id === row.kelasId)?.nama || 'Belum dipetakan'

  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-sm font-bold uppercase tracking-wider text-brand">Data induk tersinkron</p><h2 className="text-2xl font-bold">Kelas & peserta didik</h2><p className="mt-1 max-w-3xl text-sm text-slate-600">Daftar ini disalin dari LMS secara otomatis setiap 5 menit. LMS tetap menjadi sumber utama; CBT tidak mengedit identitas atau keanggotaan siswa.</p></div>
      {session.user.role !== 'kepala_sekolah' && <button type="button" onClick={() => void syncNow()} disabled={syncing} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-white disabled:opacity-60"><Cloud className={`size-4 ${syncing ? 'animate-pulse' : ''}`}/>{syncing ? 'Menyinkronkan…' : 'Sinkronkan dari LMS'}</button>}
    </header>

    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Ringkasan data roster">
      {[
        ['Total siswa tersalin', students.length], ['Siswa aktif', activeCount], ['Kelas tersedia', classes.length], ['Kelompok belajar', groups.length],
      ].map(([label, count]) => <div key={label} className="rounded-2xl border bg-white p-4 shadow-sm"><p className="text-sm text-slate-600">{label}</p><p className="mt-1 text-2xl font-bold">{count}</p></div>)}
    </section>

    <section className="rounded-2xl border bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold">Direktori siswa</h3><p className="text-sm text-slate-600">Cari menggunakan nama, NIS, NISN, kelas, atau kelompok belajar.</p></div><button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 font-semibold text-slate-700 disabled:opacity-50"><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`}/>Muat ulang</button></div>
      {loadError && <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{loadError}</div>}
      {missingClassCount > 0 && <div role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{missingClassCount} siswa dari LMS belum terhubung ke kelas. Pastikan penempatan kelasnya sudah dilengkapi di LMS.</div>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="relative block sm:col-span-2 xl:col-span-1"><span className="sr-only">Cari siswa</span><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-slate-400"/><input className="min-h-11 w-full rounded-xl border pl-9 pr-3" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nama, NIS, NISN…"/></label>
        <label className="grid gap-1 text-sm font-semibold">Kelas<select className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={classFilter} onChange={(event) => setClassFilter(event.target.value)}><option value="">Semua kelas</option>{classes.map((row) => <option key={row.id} value={row.id}>{row.nama} · Paket {['A', 'B', 'C'][Math.max(0, Math.min(row.jenjang - 1, 2))]}</option>)}</select></label>
        <label className="grid gap-1 text-sm font-semibold">Kelompok belajar<select className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}><option value="">Semua kelompok</option>{groups.map((row) => <option key={row.id} value={row.id}>{row.namaPokjar}{row.tipe ? ` · ${row.tipe}` : ''}</option>)}</select></label>
        <label className="grid gap-1 text-sm font-semibold">Status siswa<select className="min-h-11 rounded-xl border bg-white px-3 font-normal" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="active">Aktif</option><option value="inactive">Nonaktif</option><option value="all">Semua status</option></select></label>
      </div>

      <p className="mt-4 text-sm text-slate-600" aria-live="polite">Menampilkan {visible.length} dari {students.length} siswa tersinkron.</p>
      {loading ? <div role="status" className="grid min-h-32 place-items-center text-sm text-slate-600">Memuat data siswa dari CBT…</div> : visible.length === 0 ? <div className="mt-3 rounded-xl border border-dashed p-8 text-center"><UsersRound className="mx-auto size-7 text-slate-400"/><p className="mt-2 font-semibold">Tidak ada siswa yang cocok.</p><p className="mt-1 text-sm text-slate-600">Coba ubah pencarian atau filter kelas/kelompok.</p></div> : <>
        <div className="mt-3 space-y-3 md:hidden">{visible.map((row) => <article key={row.id} className="rounded-xl border p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="font-bold">{row.nama}</h4><p className="mt-1 text-sm text-slate-700">NIS: <span className="font-mono">{row.nis || '—'}</span></p><p className="text-sm text-slate-700">NISN: <span className="font-mono">{row.nisn || '—'}</span></p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${row.active ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{row.active ? 'Aktif' : 'Nonaktif'}</span></div><dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-3 text-sm"><div><dt className="text-xs text-slate-500">Kelas / jenjang</dt><dd className="font-medium">{classLabel(row)}{row.jenjang ? ` · Paket ${['A', 'B', 'C'][Math.max(0, Math.min(row.jenjang - 1, 2))]}` : ''}</dd></div><div><dt className="text-xs text-slate-500">Kelompok belajar</dt><dd className="font-medium">{row.kelompokBelajar || '—'}</dd></div><div><dt className="text-xs text-slate-500">Jenis kelamin</dt><dd className="font-medium">{row.jenisKelamin === 'L' ? 'Laki-laki' : row.jenisKelamin === 'P' ? 'Perempuan' : '—'}</dd></div><div><dt className="text-xs text-slate-500">Tahun ajaran</dt><dd className="font-medium">{row.tahunAjaran || '—'}</dd></div><div className="col-span-2"><dt className="text-xs text-slate-500">Program</dt><dd className="font-medium">{row.program || '—'}</dd></div></dl></article>)}</div>
        <div className="mt-3 hidden overflow-x-auto rounded-xl border md:block"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Nama / Identitas</th><th className="px-4 py-3">Kelas</th><th className="px-4 py-3">Kelompok belajar</th><th className="px-4 py-3">Program / tahun ajaran</th><th className="px-4 py-3">Status</th></tr></thead><tbody className="divide-y">{visible.map((row) => <tr key={row.id}><td className="px-4 py-3"><b>{row.nama}</b><div className="mt-1 text-xs text-slate-600">NIS <span className="font-mono">{row.nis || '—'}</span> · NISN <span className="font-mono">{row.nisn || '—'}</span>{row.jenisKelamin ? ` · ${row.jenisKelamin === 'L' ? 'Laki-laki' : row.jenisKelamin === 'P' ? 'Perempuan' : row.jenisKelamin}` : ''}</div></td><td className="px-4 py-3">{classLabel(row)}{row.jenjang ? <span className="block text-xs text-slate-500">Paket {['A', 'B', 'C'][Math.max(0, Math.min(row.jenjang - 1, 2))]}</span> : null}</td><td className="px-4 py-3">{row.kelompokBelajar || '—'}</td><td className="px-4 py-3">{row.program || '—'}<span className="block text-xs text-slate-500">{row.tahunAjaran || '—'}</span></td><td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${row.active ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{row.active ? 'Aktif' : 'Nonaktif'}</span></td></tr>)}</tbody></table></div>
      </>}
      <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">Data CBT yang disinkronkan: nama, NIS, NISN, jenis kelamin, kelas, kelompok belajar, program, dan status. Data yang tidak dibutuhkan untuk ujian seperti NIK, tanggal lahir, berkas identitas, dan data orang tua tidak disalin.</p>
    </section>
  </div>
}
