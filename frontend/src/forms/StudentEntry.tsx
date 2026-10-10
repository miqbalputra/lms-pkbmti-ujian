import { useState, useEffect } from "react";
import { GraduationCap, KeyRound, UserRound, Eye, EyeOff } from "lucide-react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { api, type Session } from "../api";
import "./tka.css";
import '../student-ux.css';

let entryCode = "";
export const takeEntryCode = () => entryCode;
export function StudentEntry({ onLogin, uxEnabled=false }: { onLogin: (s: Session) => void; uxEnabled?: boolean }) {
  const [online,setOnline]=useState(navigator.onLine);
  useEffect(()=>{const sync=()=>setOnline(navigator.onLine);window.addEventListener('online',sync);window.addEventListener('offline',sync);return()=>{window.removeEventListener('online',sync);window.removeEventListener('offline',sync)}},[]);
  const [step, setStep] = useState<"code" | "choose" | "login">("code"),
    [code, setCode] = useState(""),
    [nisn, setNisn] = useState(""),
    [selected, setSelected] = useState(""),
    [rows, setRows] = useState<
      Array<{
        id: string;
        title: string;
        kind: string;
        gradeLevel: number;
        subjectName: string;
        durationMinute?: number;
        startsAt?: string;
        endsAt?: string;
      }>
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [visible, setVisible] = useState(false);
  const navigate = useNavigate();
  const location = useLocation(),
    linkToken = location.pathname.match(/^\/akses\/([^/]+)$/)?.[1] || "";
  useEffect(() => {
    if (!linkToken) return;
    setBusy(true);
    void api<{ assessments: typeof rows }>(
      "/public/assessments/resolve",
      { method: "POST", body: JSON.stringify({ linkToken }) },
      null,
    )
      .then((result) => {
        setRows(result.assessments);
        setSelected(result.assessments[0]?.id || "");
        setStep("choose");
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [linkToken]);
  async function resolve() {
    if(busy||!online)return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ assessments: typeof rows }>(
        "/public/assessments/resolve",
        { method: "POST", body: JSON.stringify({ accessCode: code }) },
        null,
      );
      setRows(result.assessments);
      setSelected(result.assessments[0]?.id || "");
      setStep("choose");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function login() {
    if(busy||!online||!selected)return;
    setBusy(true);
    setError("");
    try {
      const result = await api<Session>(
        "/public/assessments/login",
        {
          method: "POST",
          body: JSON.stringify({
            nisn,
            accessCode: code,
            linkToken,
            assessmentId: selected,
          }),
        },
        null,
      );
      entryCode = code;
      onLogin(result);
      navigate(`/siswa/asesmen/${selected}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const choice = rows.find((row) => row.id === selected),
    grade = choice?.gradeLevel || 0;
  return (
    <main className={`tka-entry ${step === "login" ? "login" : ""} ${uxEnabled?'student-ux':''}`}>
      <header className="tka-entry-brand">
        <GraduationCap size={44} />
        <div>
          <h1>PKBM TUNAS ILMU</h1>
          <p>APLIKASI CBT — Ujian & Simulasi</p>
        </div>
      </header>
      <section className="tka-entry-card">
        {uxEnabled&&<ol className="student-steps" aria-label="Tahap masuk"><li aria-current={step==='code'?'step':undefined}>1. Kode</li><li aria-current={step==='choose'?'step':undefined}>2. Asesmen</li><li aria-current={step==='login'?'step':undefined}>3. Masuk</li></ol>}
        <div className="tka-entry-icon">
          <GraduationCap size={32} />
        </div>
        <h2>
          {step === "login"
            ? "Selamat Datang"
            : step === "choose"
              ? "Pilih Asesmen"
              : "Ujian & Simulasi"}
        </h2>
        <p>
          {step === "code"
            ? "Masukkan kode yang diberikan tutor untuk melihat asesmen yang tersedia."
            : step === "choose"
              ? "Pilih paket yang akan kamu kerjakan."
              : "Gunakan NISN dan kode akses yang diberikan tutor."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (step === "code") void resolve();
            else if (step === "choose") setStep("login");
            else void login();
          }}
          className="mt-6 grid gap-5"
        >
          {step === "code" && (
            <label className="tka-entry-field">
              <span>
                <KeyRound size={16} />
                Kode dari tutor
              </span>
              <input
                autoComplete="off"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Masukkan kode akses"
              />
            </label>
          )}
          {step === "choose" && (
            <>
              {uxEnabled&&rows.length===0&&<p role="status">Tidak ada asesmen tersedia untuk kode ini. Periksa kode atau tanyakan kepada tutor.</p>}
              <label className="tka-entry-field">
                <span>Jenjang Pendidikan</span>
                <input
                  readOnly
                  value={
                    !grade
                      ? "Sesuai penugasan"
                      : grade <= 3
                        ? ['SD / Paket A','SMP / Paket B','SMA / Paket C'][grade-1]
                      : grade <= 6
                        ? "SD / Paket A"
                        : grade <= 9
                          ? "SMP / Paket B"
                          : "SMA / Paket C"
                  }
                />
              </label>
              <label className="tka-entry-field">
                <span>Mata Pelajaran & Paket</span>
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.subjectName || ""}
                      {r.subjectName ? " — " : ""}
                      {r.title}
                    </option>
                  ))}
                </select>
              </label>
              {uxEnabled&&choice&&<div className="rounded-xl bg-blue-50 p-3 text-left text-sm"><p className="font-semibold">{choice.kind==='simulasi'?'Simulasi latihan':'Ujian Online formal'}</p><p>{choice.subjectName||'Mapel sesuai paket'}{choice.durationMinute?` · ${choice.durationMinute} menit`:''}</p>{choice.startsAt&&<p>Mulai: {new Date(choice.startsAt).toLocaleString('id-ID')}</p>}{choice.endsAt&&<p>Batas akses: {new Date(choice.endsAt).toLocaleString('id-ID')}</p>}</div>}
            </>
          )}
          {step === "login" && (
            <>
              <div className="rounded-xl bg-blue-50 p-3 text-sm">
                {choice?.title}
                {uxEnabled&&<p className="mt-1">{choice?.kind==='simulasi'?'Simulasi latihan':'Ujian Online formal'}{choice?.subjectName?` · ${choice.subjectName}`:''}</p>}
                {uxEnabled&&choice?.durationMinute&&<p>{choice.durationMinute} menit</p>}
              </div>
              <label className="tka-entry-field">
                <span>
                  <UserRound size={16} />
                  NISN siswa
                </span>
                <input
                  inputMode="numeric"
                  autoComplete="username"
                  required
                  value={nisn}
                  onChange={(e) => setNisn(e.target.value)}
                  placeholder="Masukkan NISN"
                />
              </label>
              <label className="tka-entry-field">
                <span>
                  <KeyRound size={16} />
                  Kode akses
                </span>
                <div className="relative">
                  <input
                    className="pr-14"
                    type={visible ? "text" : "password"}
                    autoComplete="off"
                    required={!linkToken}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <button
                    className="absolute right-0 top-0 grid size-12 place-items-center"
                    type="button"
                    aria-label={visible ? "Sembunyikan kode" : "Tampilkan kode"}
                    onClick={() => setVisible((v) => !v)}
                  >
                    {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>
            </>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800"
            >
              {error}
            </p>
          )}
          {uxEnabled&&(!online||step==='choose'&&!selected||step==='login'&&!nisn.trim()||step==='code'&&!code.trim())&&<p className="student-disabled-reason">{!online?'Hubungkan internet untuk melanjutkan.':step==='choose'?'Belum ada asesmen yang dipilih.':step==='login'?'Isi NISN untuk masuk.':'Isi kode dari tutor untuk melihat asesmen.'}</p>}
          <button className="tka-entry-submit" disabled={busy || uxEnabled&&(!online||step==='choose'&&!selected||step==='login'&&!nisn.trim()||step==='code'&&!code.trim())}>
            {busy
              ? "Memeriksa…"
              : step === "code"
                ? "Lihat asesmen"
                : step === "choose"
                  ? "Mulai Simulasi / Ujian"
                  : "Login"}
          </button>
          {step !== "code" && (
            <button
              type="button"
              className="min-h-12 text-sm text-blue-700"
              onClick={() => {
                setStep("code");
                setError("");
              }}
            >
              Ganti kode atau paket
            </button>
          )}
        </form>
      </section>
      <footer className="tka-entry-footer">
        <Link to="/?masuk=staf">Masuk tutor melalui LMS</Link>
        <p>
          Referensi tampilan:{" "}
          <a
            href="https://pusmendik.kemendikdasmen.go.id/tka/simulasi_tka/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Simulasi TKA Pusmendik
          </a>{" "}
          · Identitas dan layanan PKBM Tunas Ilmu.
        </p>
      </footer>
    </main>
  );
}
