import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, ArrowRight } from "lucide-react";
import { api, type Session } from "../api";
import type { FormEnvelope } from "./types";
import "./forms.css";

export function FormsHome({
  kind,
  assessmentKind,
  session,
}: {
  kind: "package" | "assessment";
  assessmentKind?: "ujian_online" | "simulasi";
  session: Session;
}) {
  const [rows, setRows] = useState<
      Array<{
        id: string;
        title: string;
        status: string;
        kind?: string;
        subject?: string;
        classIds: string[];
        createdAt: string;
        role: string;
        updatedAt: string;
      }>
    >([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams(),
    navigate = useNavigate();
  const [classes, setClasses] = useState<Array<{id:string;nama:string}>>([]);
  useEffect(() => {
    setLoading(true);
    void api<typeof rows>(
      `/staff/forms/${kind}`,
      {},
      session,
    )
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    void api<typeof classes>("/staff/master/classes",{},session).then(setClasses).catch(e=>setError(e.message));
  }, [kind, assessmentKind, session.accessToken]);
  async function create() {
    setBusy(true);
    try {
      const doc = await api<FormEnvelope>(
        `/staff/forms/${kind}`,
        { method: "POST", body: JSON.stringify({ kind: assessmentKind }) },
        session,
      );
      navigate(`/editor/${kind}/${doc.resourceId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function unpublish(row: (typeof rows)[number]) {
    const label = kind === "assessment" ? "asesmen" : "paket soal";
    const warning = kind === "assessment"
      ? "Peserta baru tidak dapat memulai setelah dibatalkan. Jika masih ada siswa yang sedang mengerjakan, sistem akan meminta Anda menunggu sampai mereka selesai. Hasil dan snapshot lama tetap tersimpan."
      : "Paket dan seluruh butirnya kembali menjadi draf. Snapshot asesmen lama tetap tersimpan.";
    if (!window.confirm("Batalkan terbit " + label + " “" + row.title + "”? " + warning)) return;
    try {
      await api("/staff/forms/" + kind + "/" + encodeURIComponent(row.id) + "/unpublish", { method: "POST" }, session);
      setRows((current) => current.map((item) => item.id === row.id ? { ...item, status: "draft", updatedAt: new Date().toISOString() } : item));
      setError("");
    } catch (e) { setError((e as Error).message || "Penerbitan belum dapat dibatalkan."); }
  }
  const search = params.get("q") || "",
    status = params.get("tab") || "all";
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  const visible = rows.filter(
    (r) =>
      (kind === "package" || r.kind === assessmentKind) &&
      (status === "all" || r.status === status) &&
      (!params.get("kelas") || r.classIds.includes(params.get("kelas")!)) &&
      (!params.get("mapel") || r.subject === params.get("mapel")) &&
      (!params.get("dari") || r.createdAt.slice(0,10) >= params.get("dari")!) &&
      (!params.get("sampai") || r.createdAt.slice(0,10) <= params.get("sampai")!) &&
      r.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="form-home">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">
            {kind === "package"
              ? "Bank Soal"
              : assessmentKind === "simulasi"
                ? "Simulasi Asesmen"
                : "Ujian Online"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Buat paket, susun pertanyaan, tetapkan peserta, lalu terbitkan.
          </p>
        </div>
        {session.user.role !== "kepala_sekolah" && (
          <button
            className="form-button"
            disabled={busy}
            onClick={() => void create()}
          >
            <Plus size={18} />
            Buat dari kosong
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <input
          className="min-h-12 flex-1 rounded-xl border bg-white px-4"
          aria-label="Cari paket"
          placeholder="Cari nama paket…"
          value={search}
          onChange={(e) => update("q", e.target.value)}
        />
        <select
          className="min-h-12 rounded-xl border bg-white px-3"
          aria-label="Status paket"
          value={status}
          onChange={(e) => update("tab", e.target.value)}
        >
          <option value="all">Semua status</option>
          <option value="draft">Draf</option>
          <option value="published">Diterbitkan</option>
          <option value="archived">Arsip</option>
        </select>
        <select className="min-h-12 min-w-0 rounded-xl border bg-white px-3" aria-label="Filter kelas" value={params.get("kelas")||""} onChange={e=>update("kelas",e.target.value)}><option value="">Semua kelas</option>{classes.map(c=><option key={c.id} value={c.id}>{c.nama}</option>)}</select>
        <select className="min-h-12 min-w-0 rounded-xl border bg-white px-3" aria-label="Filter mata pelajaran" value={params.get("mapel")||""} onChange={e=>update("mapel",e.target.value)}><option value="">Semua mapel</option>{[...new Set(rows.map(r=>r.subject).filter(Boolean))].map(s=><option key={s} value={s}>{s}</option>)}</select>
        <label className="grid text-sm">Dibuat mulai<input className="min-h-12 min-w-0 rounded-xl border bg-white px-3" type="date" value={params.get("dari")||""} onChange={e=>update("dari",e.target.value)}/></label>
        <label className="grid text-sm">Sampai<input className="min-h-12 min-w-0 rounded-xl border bg-white px-3" type="date" min={params.get("dari")||undefined} value={params.get("sampai")||""} onChange={e=>update("sampai",e.target.value)}/></label>
      </div>
      {error && (
        <p role="alert" className="text-rose-700">
          {error}
        </p>
      )}
      {loading && <p role="status">Memuat paket…</p>}
      <div className="form-home-grid">
        {visible.map((row) => (
          <article key={row.id} className="form-card grid gap-3">
            <Link className="grid gap-3 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" to={`/editor/${kind}/${row.id}`}>
              <span className="text-xs font-semibold uppercase text-brand">
                {row.status === "draft"
                  ? "Draf"
                  : row.status === "published"
                    ? "Diterbitkan"
                    : "Arsip"}
              </span>
              <h2 className="text-lg font-semibold">{row.title}</h2>
              <p className="text-xs text-slate-500">
                {row.subject || ""} ·{" "}
                {new Date(row.updatedAt).toLocaleDateString("id-ID")}
              </p>
              <span className="flex items-center gap-2 font-semibold text-brand">
                {row.role === "editor" ? "Dibagikan · Edit" : row.role === "grader" ? "Dibagikan · Nilai" : row.status === "draft" ? "Buka editor" : "Lihat versi"}
                <ArrowRight size={16} />
              </span>
            </Link>
            {row.status === "published" && row.role === "owner" && session.user.role !== "kepala_sekolah" && (
              <button type="button" className="min-h-11 justify-self-start rounded-xl border border-amber-300 bg-amber-50 px-4 font-semibold text-amber-900 hover:bg-amber-100" onClick={() => void unpublish(row)}>
                Batal Terbit
              </button>
            )}
          </article>
        ))}
      </div>
      {!loading && !visible.length && (
        <div className="form-card text-center">
          Belum ada paket untuk filter ini.
        </div>
      )}
      <Link
        className="min-h-12 text-sm text-brand underline"
        to={kind === "package" ? "/soal?legacy=1" : "/ujian?legacy=1"}
      >
        Buka pengelolaan lama / impor / arsip
      </Link>
    </div>
  );
}
