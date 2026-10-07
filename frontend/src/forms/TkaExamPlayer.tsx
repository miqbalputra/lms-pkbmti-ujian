import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudOff,
  GraduationCap,
  X,
} from "lucide-react";
import {
  QuestionAnswerControl,
  ProtectedQuestionMedia,
  StimulusContent,
  type StudentQuestion,
  type AnswerFile,
} from "../QuestionAnswerControl";
import { questionTypes } from "../questionTypes";
import { useDialogFocus } from "./useDialogFocus";
import { RichText } from "./RichText";
import type { FormHeaderImage } from './types';
import "./forms.css";
import "./tka.css";

export type PlayerItem = {
  id: string;
  flagged: boolean;
  answer?: string;
  question: StudentQuestion;
};
const value = (raw?: string) => {
  try {
    return raw ? JSON.parse(raw) : "";
  } catch {
    return raw || "";
  }
};
const answered = (item: PlayerItem) => {
  const v = value(item.answer);
  return (
    v !== null &&
    v !== "" &&
    (!Array.isArray(v) || v.length > 0) &&
    (typeof v !== "object" || Object.keys(v || {}).length > 0)
  );
};
export function TkaExamPlayer({
  title,
  student,
  items,
  index,
  onIndex,
  onAnswer,
  onFlag,
  onSubmit,
  timeText,
  remaining,
  saveState,
  queueCount,
  accessToken,
  notice,
  onFileUpload,
  onFileRemove,
  onFileDownload,
  preview = false,
  themeColor = "#326698",
  formFont = "sans-serif",
  progressBar = false,
  headerImage,
}: {
  title: string;
  student: string;
  items: PlayerItem[];
  index: number;
  onIndex: (index: number) => void;
  onAnswer: (item: PlayerItem, value: unknown) => void;
  onFlag: (item: PlayerItem) => void;
  onSubmit: () => Promise<boolean>;
  timeText: string;
  remaining: number;
  saveState: string;
  queueCount: number;
  accessToken: string;
  notice?: ReactNode;
  onFileUpload: (item: PlayerItem, file: File) => Promise<AnswerFile>;
  onFileRemove: (item: PlayerItem, id: string) => Promise<void>;
  onFileDownload: (id: string, name: string) => void;
  preview?: boolean;
  themeColor?: string;
  formFont?: string;
  progressBar?: boolean;
  headerImage?: FormHeaderImage | null;
}) {
  const [params,setParams] = useSearchParams();
  const modal = ["info","palette","submit"].includes(params.get("dialog")||"") ? params.get("dialog")! : "";
  const setModal = (value:string) => {const next = new URLSearchParams(window.location.search);if(value)next.set("dialog",value);else next.delete("dialog");setParams(next)};
  const [font, setFont] = useState(18),
    [integrity, setIntegrity] = useState(false),
    [busy, setBusy] = useState(false);
  const item = items[index],
    question = item?.question;
  useDialogFocus(Boolean(modal), () => setModal(""));
  const stimulus = useRef<HTMLDivElement>(null),
    positions = useRef(new Map<string, number>()),
    lastGroup = useRef("");
  const group =
    question?.config?.stimulusGroupId ||
    JSON.stringify(question?.stimulus || []);
  useEffect(() => {
    const node = stimulus.current;
    if (!node) return;
    node.scrollTop = positions.current.get(group) || 0;
    lastGroup.current = group;
  }, [group]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModal("");
        return;
      }
      if (modal || !event.altKey) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onIndex(Math.min(items.length - 1, index + 1));
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onIndex(Math.max(0, index - 1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [index, items.length, onIndex, modal]);
  const empty = items.filter((i) => !answered(i)),
    marked = items.filter((i) => i.flagged);
  if (!question) return <p role="status">Menyiapkan soal…</p>;
  async function submit() {
    if (!integrity || busy) return;
    setBusy(true);
    try {
      const path = window.location.pathname;
      // The portal navigates to the receipt on success. Do not let this
      // player's stale search-param closure navigate back over that receipt.
      if (await onSubmit() && window.location.pathname === path) setModal("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="tka-shell" style={{fontFamily: formFont === "serif" ? "Georgia, serif" : formFont === "monospace" ? "ui-monospace, monospace" : "system-ui, sans-serif"}}>
      <header className="tka-header" style={/^#[0-9a-f]{6}$/i.test(themeColor) ? {backgroundColor:themeColor} : undefined}>
        <div className="flex items-center gap-3">
          <GraduationCap size={36} />
          <div>
            <b>PKBM TUNAS ILMU</b>
            <p className="text-xs">APLIKASI CBT — Ujian & Simulasi</p>
          </div>
        </div>
        <span>{student}</span>
      </header>
      <section className="tka-exam">
        {headerImage && <div className="form-header-image mb-4"><ProtectedQuestionMedia media={{assetId:headerImage.assetId,kind:'image'}} accessToken={accessToken} alt={headerImage.alt}/></div>}
        {notice}
        {progressBar && <div className="mb-3"><label htmlFor="tka-progress" className="text-sm">{items.filter(answered).length} dari {items.length} soal terjawab</label><progress id="tka-progress" className="block h-2 w-full accent-blue-700" max={items.length} value={items.filter(answered).length}/></div>}
        <div className="tka-exam-top">
          <div>
            <h1>Soal nomor {index + 1}</h1>
            <div className="flex items-center gap-1 text-xs">
              Ukuran font soal:
              {[15, 18, 22].map((size) => (
                <button
                  key={size}
                  className="form-icon"
                  aria-label={`Ukuran teks ${size} piksel`}
                  aria-pressed={font === size}
                  style={{ fontSize: size }}
                  onClick={() => setFont(size)}
                >
                  A
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button className="tka-pill" onClick={() => setModal("info")}>
              INFORMASI SOAL
            </button>
            <span
              aria-label={`Sisa waktu ${timeText}`}
              className={`tka-time ${remaining <= 300000 ? "bg-rose-100 text-rose-800" : remaining <= 900000 ? "bg-orange-100 text-orange-800" : "bg-emerald-50 text-emerald-800"}`}
            >
              Sisa Waktu: <b className="ml-1 font-mono">{timeText}</b>
            </span>
            <button className="tka-pill" onClick={() => setModal("palette")}>
              Daftar Soal
            </button>
            <div className="flex w-full flex-wrap justify-end gap-3 text-xs">
              <p>{title}</p>
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-1"
              >
                {saveState === "offline" ? (
                  <CloudOff size={14} />
                ) : (
                  <Cloud size={14} />
                )}{" "}
                {preview ? "Pratinjau — tidak direkam" : saveState === "saved"
                  ? "Tersimpan"
                  : saveState === "saving"
                    ? "Menyimpan…"
                    : saveState === "offline"
                      ? `Offline · ${queueCount} perubahan lokal`
                      : saveState === "conflict"
                        ? "Konflik — pilih versi"
                        : "Gagal menyimpan"}
              </p>
            </div>
          </div>
        </div>
        <div
          className={`tka-question-grid ${question.stimulus?.length ? "" : "no-stimulus"}`}
          style={{ fontSize: font }}
        >
          <div
            ref={stimulus}
            onScroll={() => {
              if (stimulus.current)
                positions.current.set(
                  lastGroup.current,
                  stimulus.current.scrollTop,
                );
            }}
            className="tka-stimulus"
            aria-label="Bahan bacaan atau stimulus"
          >
            <StimulusContent
              rows={question.stimulus || []}
              accessToken={accessToken}
            />
          </div>
          <div className="tka-answer">
            <p className="mb-4 whitespace-pre-wrap leading-relaxed">
              <RichText text={question.prompt} parts={question.config?.promptRich}/>
              {question.config?.required && (
                <span aria-label="Wajib dijawab" className="ml-1 text-rose-700">
                  *
                </span>
              )}
            </p>
            {question.description && (
              <p className="mb-4 text-slate-600">{question.description}</p>
            )}
            <QuestionAnswerControl
              question={question}
              questionId={item.id}
              value={value(item.answer)}
              onChange={(answer) => onAnswer(item, answer)}
              onFileUpload={(file) => onFileUpload(item, file)}
              onFileRemove={(id) => onFileRemove(item, id)}
              onFileDownload={onFileDownload}
              accessToken={accessToken}
            />
          </div>
        </div>
        <nav className="tka-bottom" aria-label="Navigasi pengerjaan">
          <button
            className="tka-prev"
            disabled={index === 0}
            onClick={() => onIndex(index - 1)}
          >
            <ChevronLeft size={18} />
            Soal sebelumnya
          </button>
          <button
            className="tka-flag"
            aria-pressed={item.flagged}
            onClick={() => onFlag(item)}
          >
            {item.flagged ? "✓ " : ""}Ragu-ragu
          </button>
          {index === items.length - 1 ? (
            <button
              className="tka-next"
              onClick={() => {
                setIntegrity(false);
                setModal("submit");
              }}
            >
              Periksa & kirim
            </button>
          ) : (
            <button className="tka-next" onClick={() => onIndex(index + 1)}>
              Soal berikutnya
              <ChevronRight size={18} />
            </button>
          )}
        </nav>
      </section>
      <footer className="tka-credit">
        Referensi pola tampilan:{" "}
        <a
          href="https://pusmendik.kemendikdasmen.go.id/tka/simulasi_tka/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Simulasi TKA Pusmendik
        </a>
        . Layanan PKBM Tunas Ilmu, bukan aplikasi pemerintah.
      </footer>
      {modal && (
        <div className="form-overlay" onClick={() => setModal("")}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="tka-modal-title"
            className="form-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 id="tka-modal-title" className="text-lg font-semibold">
                {modal === "palette"
                  ? "Daftar Soal"
                  : modal === "info"
                    ? "Informasi soal"
                    : "Periksa sebelum mengirim"}
              </h2>
              <button
                className="form-icon"
                aria-label="Tutup dialog"
                onClick={() => setModal("")}
              >
                <X />
              </button>
            </div>
            {modal === "palette" && (
              <>
                <p className="my-4 text-sm">
                  {items.filter(answered).length}/{items.length} terjawab ·{" "}
                  {marked.length} ragu-ragu
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {items.map((row, i) => (
                    <button
                      key={row.id}
                      className={`form-icon border ${row.flagged ? "bg-amber-200 text-amber-950" : answered(row) ? "bg-slate-700 text-white" : "bg-white"}`}
                      aria-current={i === index ? "step" : undefined}
                      aria-label={`Soal ${i + 1}, ${row.flagged ? "ragu-ragu" : answered(row) ? "terjawab" : "kosong"}`}
                      onClick={() => {
                        onIndex(i);
                        setModal("");
                      }}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
                <button
                  className="form-button mt-5 w-full"
                  onClick={() => {
                    setIntegrity(false);
                    setModal("submit");
                  }}
                >
                  Periksa & kirim
                </button>
              </>
            )}
            {modal === "info" && (
              <dl className="my-4 grid gap-4">
                <div>
                  <dt>Jenis soal</dt>
                  <dd>
                    {questionTypes.find(([id]) => id === question.type)?.[1] ||
                      question.type}
                  </dd>
                </div>
                <div>
                  <dt>Bobot</dt>
                  <dd>{question.points} poin</dd>
                </div>
                <div>
                  <dt>Navigasi keyboard</dt>
                  <dd>Alt + panah kiri/kanan. Escape menutup dialog.</dd>
                </div>
                <div>
                  <dt>Penyimpanan</dt>
                  <dd>
                    Perubahan offline ditahan di perangkat. Nilai hanya berasal
                    dari jawaban yang diakui server.
                  </dd>
                </div>
              </dl>
            )}
            {modal === "submit" && (
              <div className="mt-4 grid gap-4">
                {notice}
                <p>
                  {items.filter(answered).length} terjawab · {empty.length}{" "}
                  kosong · {marked.length} ragu-ragu
                </p>
                {[
                  ["Soal kosong", empty],
                  ["Ditandai ragu-ragu", marked],
                ].map(([label, rows]) => (
                  <div key={label as string}>
                    <p className="mb-2 font-medium">{label as string}</p>
                    <div className="flex flex-wrap gap-2">
                      {(rows as PlayerItem[]).map((row) => (
                        <button
                          key={row.id}
                          className="form-icon border"
                          onClick={() => {
                            onIndex(items.findIndex((i) => i.id === row.id));
                            setModal("");
                          }}
                        >
                          {items.findIndex((i) => i.id === row.id) + 1}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <label className="flex min-h-12 items-start gap-3 rounded-xl border p-3">
                  <input
                    type="checkbox"
                    className="mt-1 size-5"
                    checked={integrity}
                    onChange={(e) => setIntegrity(e.target.checked)}
                  />
                  <span>
                    Saya sudah memeriksa jawaban dan mengerjakan asesmen ini
                    sendiri.
                  </span>
                </label>
                <p className="text-sm text-slate-600">{preview ? "Mode pratinjau: tidak ada percobaan siswa atau nilai yang dibuat." : "Jawaban akan dikunci setelah pengiriman berhasil. Soal wajib dan jalur percabangan diperiksa server."}</p>
                <button
                  className="form-button"
                  disabled={
                    !integrity || busy || !navigator.onLine || remaining === 0
                  }
                  onClick={() => void submit()}
                >
                  {busy ? "Mengirim…" : "Kirim jawaban sekarang"}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
