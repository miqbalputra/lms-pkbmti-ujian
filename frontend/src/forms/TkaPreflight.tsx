import { GraduationCap, ChevronLeft, Play } from "lucide-react";
import "./tka.css";
import { useStudentUx } from '../studentUx';

export type RosterIdentity = {
  id: string;
  name: string;
  nis?: string;
  nisn?: string;
  className?: string;
  gender?: string;
  learningGroup?: string;
};
export function TkaPreflight({
  assessment,
  student,
  step,
  code,
  onCode,
  onVerify,
  onBack,
  onStart,
  onIdentity,
  accepted,
  onAccepted,
  busy,
  notice,
  resume,
}: {
  assessment: {
    title: string;
    kind?: string;
    accessCodeRequired?: boolean;
    subjectName?: string;
    durationMinute: number;
    instructions?: string;
    startsAt?: string;
    endsAt?: string;
  };
  student: RosterIdentity | null;
  step: "identity" | "confirm";
  code: string;
  onCode: (v: string) => void;
  onVerify: () => void;
  onBack: () => void;
  onStart: () => void;
  onIdentity: () => void;
  accepted: boolean;
  onAccepted: (v: boolean) => void;
  busy: boolean;
  notice: React.ReactNode;
  resume?: () => void;
}) {
  const ux=useStudentUx();
  const codeNeeded=assessment.accessCodeRequired!==false;
  const disabledReason=!navigator.onLine?'Hubungkan internet untuk melanjutkan.':!student?'Data peserta sedang dimuat.':step==='identity'&&codeNeeded&&!code.trim()&&!resume?'Masukkan token yang diberikan tutor.':step==='confirm'&&!accepted?'Centang pernyataan kesiapan setelah membaca panduan.':'';
  const identity = [
    ["Nama Peserta", student?.name],
    ["NIS", student?.nis],
    ["NISN", student?.nisn],
    ["Kelas", student?.className],
    ["Kelompok Belajar", student?.learningGroup],
    [
      "Jenis Kelamin",
      student?.gender === "L"
        ? "Laki-laki"
        : student?.gender === "P"
          ? "Perempuan"
          : student?.gender,
    ],
  ];
  return (
    <main
      className={`tka-preflight ${step === "confirm" ? "confirmation" : ""} ${ux.enabled?'student-ux':''}`}
    >
      <header className="tka-header">
        <div className="flex items-center gap-3">
          <GraduationCap size={40} />
          <div>
            <b>PKBM TUNAS ILMU</b>
            <p className="text-xs">APLIKASI CBT — Ujian & Simulasi</p>
          </div>
        </div>
        <button className="tka-pill" onClick={onBack}>
          <ChevronLeft size={18} />
          Kembali
        </button>
      </header>
      <div className="tka-preflight-layout">
        {step === "identity" && (
          <aside className="tka-preflight-note">
            <h2>Persiapan tes</h2>
            <p>
              Pastikan data peserta sesuai dengan identitasmu. Jika berbeda,
              hubungi tutor sebelum mulai.
            </p>
            <p>
              Gunakan token yang diberikan tutor. Nama, NISN, kelas, dan
              kelompok belajar berasal dari LMS.
            </p>
            {assessment.instructions && (
              <p className="whitespace-pre-wrap">{assessment.instructions}</p>
            )}
          </aside>
        )}
        <section className="tka-preflight-card">
          {ux.enabled&&<><p className="student-pane-title">{assessment.kind==='simulasi'?'Simulasi latihan':'Ujian Online formal'}</p><ol className="student-steps" aria-label="Persiapan asesmen"><li aria-current={step==='identity'?'step':undefined}>1. Data peserta</li><li aria-current={step==='confirm'?'step':undefined}>2. Siap mulai</li></ol><p className="mb-4 font-semibold">{assessment.title} · {assessment.durationMinute} menit</p></>}
          <h1>
            {step === "identity" ? "Konfirmasi data Peserta" : "Konfirmasi Tes"}
          </h1>
          {notice}
          {step === "identity" ? (
            <>
              <dl>
                {identity.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      {student ? value || "—" : "Memuat data terverifikasi…"}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>Mata Ujian</dt>
                  <dd>{assessment.subjectName || assessment.title}</dd>
                </div>
              </dl>
              <label className="tka-entry-field mt-5">
                <span>Token asesmen</span>
                <input
                  autoComplete="off"
                  value={code}
                  onChange={(e) => onCode(e.target.value)}
                  placeholder="Masukkan token dari tutor"
                />
              </label>
              <p className="my-3 text-xs text-slate-600">
                Identitas tidak dapat diganti di sini. Token tidak dicantumkan
                dalam URL.
              </p>
              <button
                className="tka-entry-submit"
                disabled={busy || !student || !navigator.onLine || (ux.enabled ? codeNeeded&&!code.trim()&&!resume : !code.trim())}
                onClick={resume || onVerify}
              >
                {busy
                  ? "Memeriksa…"
                  : resume
                    ? "Lanjutkan percobaan"
                    : "Verifikasi & lanjutkan"}
              </button>
              {ux.enabled&&disabledReason&&<p className="student-disabled-reason">{disabledReason}</p>}
            </>
          ) : (
            <>
              <dl>
                {[
                  ["Nama Tes", assessment.title],
                  ["Peserta", student?.name],
                  ["Status Tes", "Tes Baru"],
                  [
                    "Waktu Tes",
                    assessment.startsAt
                      ? new Date(assessment.startsAt).toLocaleString("id-ID")
                      : "Dapat dimulai sekarang",
                  ],
                  ["Alokasi Waktu Tes", `${assessment.durationMinute} Menit`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value || "—"}</dd>
                  </div>
                ))}
              </dl>
              {assessment.instructions && (
                <div className="my-4 rounded-xl bg-blue-50 p-4">
                  <h2 className="mb-2 font-semibold">Panduan pengerjaan</h2>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {assessment.instructions}
                  </p>
                </div>
              )}
              <label className="my-4 flex min-h-12 items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0"
                  checked={accepted}
                  onChange={(e) => onAccepted(e.target.checked)}
                />
                <span className="text-sm">
                  Identitas saya benar, saya sudah membaca panduan, dan siap
                  memulai tes.
                </span>
              </label>
              <button
                className="tka-entry-submit"
                disabled={!accepted || !navigator.onLine || busy}
                onClick={onStart}
              >
                <Play size={18} />
                Mulai tes
              </button>
              {ux.enabled&&disabledReason&&<p className="student-disabled-reason">{disabledReason}</p>}
              <button
                className="min-h-12 w-full text-blue-700"
                onClick={onIdentity}
              >
                Kembali ke data peserta
              </button>
            </>
          )}
        </section>
      </div>
      <footer className="tka-credit">
        Pola tampilan merujuk{" "}
        <a
          href="https://pusmendik.kemendikdasmen.go.id/tka/simulasi_tka/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Simulasi TKA Pusmendik
        </a>
        . Layanan PKBM Tunas Ilmu, bukan aplikasi pemerintah.
      </footer>
    </main>
  );
}
