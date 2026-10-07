import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  Check,
  Copy,
  Eye,
  Image,
  Plus,
  Redo2,
  Send,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { api, type Session } from "../api";
import { optimizeQuestionMedia } from "../questionMedia";
import { VisualAnswerEditor, VisualTableEditor } from "../QuestionEditor";
import {
  questionTypes,
  defaultQuestionConfig,
  questionStarterPrompt,
  type QuestionType,
} from "../questionTypes";
import { useFormDocument } from "./useFormDocument";
import {
  ordered,
  blankConfig,
  type FormCard,
  type FormSettings,
  type FormDraft,
  type FormEnvelope,
  type StimulusBlock,
} from "./types";
import { SortableList } from "./SortableList";
import { useDialogFocus } from "./useDialogFocus";
import { FormAccessLinks } from "./FormAccessLinks";
import { TypePalette } from "./TypePalette";
import { RichQuestionEditor } from "./RichText";
import { FormHeaderEditor } from "./FormHeaderEditor";
import { readableAnswer } from "../answerText";
import { ProtectedQuestionMedia } from "../QuestionAnswerControl";
import { canvasRows, canvasOrderPatch, isSection } from "./canvasOrder";
import "./forms.css";

type MasterClass = { id: string; nama: string; kelompokBelajar?: string };
type Student = { id: string; nama: string; nisn: string; kelasId: string };
type Subject = { id: string; nama: string };
const labels = {
  connecting: "Menghubungkan…",
  saving: "Menyimpan…",
  saved: "Tersimpan",
  offline: "Offline — tersimpan lokal",
  error: "Gagal menyimpan",
  conflict: "Konflik versi",
  readonly: "Baca-saja",
};
function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {isValidElement<{ "aria-label"?: string }>(children) &&
      typeof children.type === "string" &&
      ["input", "textarea", "select"].includes(children.type)
        ? cloneElement(children, { "aria-label": label })
        : children}
    </label>
  );
}
export function FormCanvas({
  kind,
  id,
  session,
}: {
  kind: "assessment" | "package";
  id: string;
  session: Session;
}) {
  const model = useFormDocument(kind, id, session),
    { content, patch, envelope } = model;
  const [params, setParams] = useSearchParams(),
    location = useLocation(), navigate = useNavigate();
  const tab = params.get("tab") || "questions",
    panel = params.get("panel") || "";
  const [notice, setNotice] = useState(""),
    [bank, setBank] = useState<
      Array<{
        id: string;
        type: QuestionType;
        prompt: string;
        points: number;
        configJson: string;
        stimulusJson?: string;
      }>
    >([]),
    [search, setSearch] = useState("");
  const [classes, setClasses] = useState<MasterClass[]>([]),
    [subjects, setSubjects] = useState<Subject[]>([]),
    [students, setStudents] = useState<Student[]>([]),
    [member, setMember] = useState(""),
    [memberRole, setMemberRole] = useState("editor"),
    [members, setMembers] = useState<
      Array<{ accountId: string; role: string; username: string; name: string }>
    >([]),
    [busy, setBusy] = useState(false);
  const [pendingUploads,setPendingUploads] = useState(0);
  const uploadBusy = (change:number) => setPendingUploads(n=>Math.max(0,n+change));
  const setPanel = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("panel", value);
    else next.delete("panel");
    setParams(next);
  };
  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", value);
    next.delete("panel");
    setParams(next);
  };
  useDialogFocus(Boolean(panel), () => setPanel(""));
  useEffect(() => {
    void Promise.all([
      api<MasterClass[]>("/staff/master/classes", {}, session),
      api<Student[]>("/staff/master/students", {}, session),
      api<Subject[]>("/staff/master/subjects", {}, session),
    ])
      .then(([a, b, c]) => {
        setClasses(a);
        setStudents(b);
        setSubjects(c);
      })
      .catch((e) => setNotice(e.message));
  }, [session.accessToken]);
  useEffect(() => {
    if (panel === "bank")
      void api<typeof bank>("/staff/questions", {}, session)
        .then(setBank)
        .catch((e) => setNotice(e.message));
    if (panel === "share")
      void api<typeof members>(
        `/staff/forms/${kind}/${id}/collaborators`,
        {},
        session,
      )
        .then(setMembers)
        .catch((e) => setNotice(e.message));
  }, [panel, kind, id, session.accessToken]);
  if (!content || !envelope)
    return (
      <main className="form-app">
        <div className="form-card" role="status">
          {model.error || "Menyiapkan kanvas…"}
          {model.error && (
            <button className="form-button" onClick={model.reconnect}>
              Coba lagi
            </button>
          )}
        </div>
      </main>
    );
  const editable =
    !envelope.frozen && !model.publicationPending && model.status !== "conflict" && ["owner", "editor"].includes(envelope.role);
  const cards = ordered(content.cards),
    sections = ordered(content.sections);
  const cardPatch = (card: FormCard, value: Partial<FormCard>) =>
    patch(["cards", card.id], value);
  const configPatch = (card: FormCard, value: object) =>
    patch(["cards", card.id, "config"], value);
  const settingsPatch = (value: Partial<FormSettings>) =>
    patch(["settings"], value);
  function add(
    type: QuestionType = "pg_tunggal",
    source?: (typeof bank)[number],
  ) {
    const newID = crypto.randomUUID();
    const card: FormCard = {
      id: newID,
      position: (cards.at(-1)?.position || 0) + 1,
      deleted: false,
      type,
      prompt: source?.prompt || "",
      description: "",
      points: source?.points ?? content!.settings.defaultQuestionPoints ?? 1,
      required: source ? Boolean(JSON.parse(source.configJson).required) : content!.settings.defaultQuestionRequired || false,
      sectionId: sections.at(-1)?.id || "",
      stimulusGroupId: "",
      config: source ? JSON.parse(source.configJson) : blankConfig(type),
      ...(source && JSON.parse(source.configJson).promptRich ? {promptRich: JSON.parse(source.configJson).promptRich} : {}),
      explanation: "",
      ...(source ? { sourceId: source.id } : {}),
    };
    const groups: { [id: string]: unknown } = {};
    if (source?.stimulusJson) {
      try {
        const rows = JSON.parse(source.stimulusJson) as StimulusBlock[];
        if (rows.length) {
          const gid = crypto.randomUUID();
          card.stimulusGroupId = gid;
          groups[gid] = {
            id: gid,
            title: "Bahan soal",
            position: Object.keys(content!.stimuli).length,
            deleted: false,
            blocks: rows.map((r) => ({ ...r, id: crypto.randomUUID() })),
          };
        }
      } catch {
        setNotice("Bahan soal sumber tidak dapat dibaca");
        return;
      }
    }
    patch([], { cards: { [newID]: card }, stimuli: groups });
    setPanel("");
    window.setTimeout(
      () =>
        document
          .getElementById(`card-${newID}`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      100,
    );
  }
  function addSection() {
    const sid = crypto.randomUUID();
    patch(["sections"], {
      [sid]: {
        id: sid,
        title: "Bagian tanpa judul",
        description: "",
        position: (sections.at(-1)?.position || 0) + 1,
        deleted: false,
        next: "",
      },
    });
  }
  function duplicate(card: FormCard) {
    const newID = crypto.randomUUID();
    patch(["cards"], {
      [newID]: {
        ...structuredClone(card),
        id: newID,
        sourceId: undefined,
        position: card.position + 0.5,
      },
    });
  }
  function removeSection(sectionId: string) {
    // Moving questions back to the initial section preserves work and clears
    // dangling branches in the same collaborative transaction. Undo restores all.
    patch([], {
      sections: Object.fromEntries(sections.map(s=>[s.id,{...(s.id===sectionId?{deleted:true}:{}),...(s.next===sectionId?{next:''}:{})}])),
      cards: Object.fromEntries(cards.map(q=>[q.id,{...(q.sectionId===sectionId?{sectionId:''}:{}),config:{branchToByAnswer:Object.fromEntries(Object.entries(q.config.branchToByAnswer||{}).filter(([,target])=>target===sectionId).map(([key])=>[key,undefined]))}}])),
    });
    setNotice('Bagian dihapus; soal dipindahkan ke Bagian awal. Gunakan Batalkan untuk memulihkan.');
  }
  async function preview() {
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setNotice("Izinkan tab pratinjau pada browser ini.");
      return;
    }
    tab.opener = null;
    setBusy(true);
    try {
      if (editable) await model.flush();
      tab.location.href = `${location.pathname.replace(/\/preview$/, "")}/preview`;
    } catch (e) {
      tab.close();
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    setBusy(true);
    try {
      await model.flush(true);
      setNotice("Berhasil diterbitkan. Versi ini tidak dapat diubah.");
      setPanel("");
      model.reconnect();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveCopy(local = false, assessmentKind?: "ujian_online" | "simulasi", recovery?:FormDraft) {
    setBusy(true);
    try {
      if (assessmentKind && editable) await model.flush();
      const copy = await api<FormEnvelope>(`/staff/forms/${kind}/${id}/copy`, {method:'POST',body:JSON.stringify({...local ? {content:recovery||content} : {}, ...assessmentKind ? {resourceType:"assessment",assessmentKind} : {}})}, session);
      navigate(`/editor/${copy.resourceType}/${copy.resourceId}`);
      setNotice('Salinan baru dibuat. Paket asli dan hasil lama tidak berubah.');
    } catch(error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }
  return (
    <main
      className="form-app form-canvas"
      style={
        {
          "--form-accent": content.settings.themeColor || "#326698",
          fontFamily: content.settings.font || "sans-serif",
        } as React.CSSProperties
      }
    >
      <header className="form-header">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            className="form-icon"
            aria-label="Kembali ke daftar"
            to={
              kind === "package"
                ? "/soal"
                : content.settings.kind === "simulasi"
                  ? "/simulasi"
                  : "/ujian"
            }
          >
            <ArrowLeft />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate font-semibold">
              {content.title || "Paket tanpa judul"}
            </h1>
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-slate-600"
            >
              {labels[model.status]}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <div className="hidden gap-1 md:flex">
            {model.people.slice(0, 4).map((p, i) => (
              <span
                key={i}
                title={`${p.name}${p.field ? ` · ${p.field}` : ""}`}
                className="form-avatar"
              >
                {p.name.slice(0, 2).toUpperCase()}
              </span>
            ))}
          </div>
          <button
            className="form-icon"
            aria-label="Batalkan perubahan saya"
            disabled={!editable}
            onClick={model.undo}
          >
            <Undo2 />
          </button>
          <button
            className="form-icon"
            aria-label="Ulangi perubahan saya"
            disabled={!editable}
            onClick={model.redo}
          >
            <Redo2 />
          </button>
          <button
            className="form-icon"
            aria-label="Tema"
            onClick={() => {
              setTab("settings");
              setPanel("theme");
            }}
          >
            Aa
          </button>
          <button
            className="form-icon"
            aria-label="Pratinjau di tab baru"
            disabled={busy || pendingUploads > 0 || model.status === "offline"}
            onClick={() => void preview()}
          >
            <Eye />
          </button>
          <button
            className="form-button secondary"
            onClick={() => setPanel("share")}
          >
            <Users size={18} />
            <span className="hidden sm:inline">Berbagi</span>
          </button>
          {['owner','editor'].includes(envelope.role) && (envelope.frozen || model.status === 'conflict') && <button className="form-button secondary" disabled={busy || model.status === 'offline'} onClick={()=>void saveCopy(model.status === 'conflict')}><Copy size={18}/>{model.status === 'conflict' ? 'Simpan lokal sebagai salinan' : 'Buat salinan untuk diedit'}</button>}
          {model.status === 'conflict' && <Link className="form-button secondary" target="_blank" rel="noopener noreferrer" to={`${location.pathname}/preview`}>Lihat versi server</Link>}
          {model.status === 'conflict' && <button className="form-button secondary" onClick={()=>void model.loadServer().catch(e=>setNotice(e.message))}>Muat versi server (lokal dicadangkan)</button>}
          {kind === "package" && envelope.role === "owner" && <><button className="form-button secondary" disabled={busy || model.status === "offline"} onClick={()=>void saveCopy(false,"ujian_online")}>Buat Ujian Online</button><button className="form-button secondary" disabled={busy || model.status === "offline"} onClick={()=>void saveCopy(false,"simulasi")}>Buat Simulasi</button></>}
          <button
            className="form-button"
            aria-label="Terbitkan"
            disabled={
              !editable ||
              envelope.role !== "owner" ||
              busy ||
              pendingUploads > 0 ||
              model.status === "offline" ||
              model.status === "error"
            }
            onClick={() => setPanel("publish")}
          >
            <Send size={18} />
            <span className="hidden sm:inline">Terbitkan</span>
          </button>
        </div>
      </header>
      <nav aria-label="Tab editor" className="form-tabs">
        {[
          ["questions", "Pertanyaan"],
          ["responses", kind === "package" ? "Penggunaan" : "Respons"],
          ["settings", "Setelan"],
        ].map(([key, label]) => (
          <button
            className={tab === key ? "active" : ""}
            key={key}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {(notice || model.error) && (
        <div className="form-notice" role="alert">
          {notice || model.error}
          <button className="form-button secondary" onClick={model.reconnect}>
            Hubungkan ulang
          </button>
        </div>
      )}
      {model.publicationPending && <div className="form-notice" role="status">Menyelaraskan semua editor sebelum penerbitan. Penyuntingan dikunci sementara.</div>}
      {model.recoveryContent && ['owner','editor'].includes(envelope.role) && <div className="form-notice"><p>Draf lokal sebelumnya tetap dicadangkan di perangkat ini.</p><button className="form-button secondary" disabled={busy||model.status==='offline'} onClick={()=>void saveCopy(true,undefined,model.recoveryContent!)}>Pulihkan sebagai salinan terpisah</button></div>}
      <div className="form-content">
        {tab === "questions" && (
          <>
            {content.settings.headerImage && <div className="form-header-image"><ProtectedQuestionMedia media={{assetId:content.settings.headerImage.assetId,kind:'image'}} accessToken={session.accessToken} alt={content.settings.headerImage.alt||'Pratinjau gambar header'}/></div>}
            <section className="form-card form-title-card">
              <input
                aria-label="Judul paket"
                placeholder="Paket tanpa judul"
                className="form-title-input"
                value={content.title}
                disabled={!editable}
                onChange={(e) => patch([], { title: e.target.value })}
                onFocus={() => model.focus("judul")}
              />
              <textarea
                aria-label="Deskripsi paket"
                placeholder="Deskripsi formulir (opsional)"
                value={content.description}
                disabled={!editable}
                onChange={(e) => patch([], { description: e.target.value })}
              />
            </section>
          </>
        )}
        {tab === "questions" && (
          <SortableList
            items={canvasRows(content)}
            disabled={!editable}
            onOrder={(rows,movedId) => patch([],canvasOrderPatch(rows,movedId))}
            render={(entry) => {
              if (isSection(entry)) {
                const section = entry;
                return (
                  <section className="form-card form-section">
                    <Control label="Judul bagian">
                      <input
                        value={section.title}
                        disabled={!editable}
                        onChange={(e) =>
                          patch(["sections", section.id], {
                            title: e.target.value,
                          })
                        }
                      />
                    </Control>
                    <Control label="Deskripsi bagian">
                      <input
                        value={section.description}
                        disabled={!editable}
                        onChange={(e) =>
                          patch(["sections", section.id], {
                            description: e.target.value,
                          })
                        }
                      />
                    </Control>
                    <Control label="Setelah bagian ini">
                      <select
                        value={section.next}
                        disabled={!editable}
                        onChange={(e) =>
                          patch(["sections", section.id], {
                            next: e.target.value,
                          })
                        }
                      >
                        <option value="">Lanjutkan ke bagian berikutnya</option>
                        <option value="submit">Kirim formulir</option>
                        {sections
                          .filter((s) => s.position > section.position)
                          .map((s) => (
                            <option value={s.id} key={s.id}>
                              {s.title}
                            </option>
                          ))}
                      </select>
                    </Control>
                    <button className="form-button secondary mt-3" disabled={!editable} onClick={()=>removeSection(section.id)}><Trash2 size={18}/>Hapus bagian, pertahankan soal</button>
                  </section>
                );
              }
              const card=entry, index=canvasRows(content).filter(row=>!isSection(row)).findIndex(q=>q.id===card.id);
              return (
              <section
                id={`card-${card.id}`}
                className="form-card form-question"
              >
                <div className="form-question-top">
                  <span className="form-number">{index + 1}</span>
                  <Control label="Jenis pertanyaan">
                    <select
                      value={card.type}
                      disabled={!editable}
                      onChange={(e) => {
                        const type = e.target.value as QuestionType;
                        const clear = Object.fromEntries(
                          Object.keys(card.config).map((key) => [
                            key,
                            undefined,
                          ]),
                        );
                        cardPatch(card, {
                          type,
                          config: { ...clear, ...blankConfig(type) },
                        });
                      }}
                    >
                      {questionTypes.map(([type, name]) => (
                        <option key={type} value={type}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Control>
                </div>
                <RichQuestionEditor value={card.prompt} parts={card.promptRich} peers={model.people.filter(p=>p.path?.[1]===card.id&&p.name!==session.user.nama)} disabled={!editable} onChange={prompt=>cardPatch(card,{prompt})} onFormat={(start,end,attributes)=>model.format(['cards',card.id,'prompt'],start,end,attributes)} onSelection={(start,end)=>model.select(['cards',card.id,'prompt'],start,end)} onUndo={model.undo} onRedo={model.redo}/>
                {model.people.filter(p=>p.path?.[1]===card.id&&p.name!==session.user.nama).map((p,i)=><p key={i} className="text-xs text-blue-700" role="status">{p.name} · kursor {p.start===p.end?p.start:`${p.start}–${p.end}`}</p>)}
                <MathTools
                  text={card.prompt}
                  onChange={(prompt) => cardPatch(card, { prompt })}
                  disabled={!editable}
                />
                <Control label="Deskripsi (opsional)">
                  <input
                    value={card.description}
                    disabled={!editable}
                    onChange={(e) =>
                      cardPatch(card, { description: e.target.value })
                    }
                  />
                </Control>
                <fieldset disabled={!editable}>
                  <VisualAnswerEditor
                    type={card.type}
                    config={card.config}
                    update={(value) => configPatch(card, value)}
                    session={session}
                  />
                </fieldset>
                <div className="form-question-footer">
                  <details>
                    <summary>Kunci jawaban & poin</summary>
                    <div className="mt-3 grid gap-3">
                      <Control label="Poin soal">
                        <input
                          type="number"
                          min="0"
                          max="10000"
                          value={card.points}
                          disabled={!editable}
                          onChange={(e) =>
                            cardPatch(card, { points: Number(e.target.value) })
                          }
                        />
                      </Control>
                      <Control label="Aturan skor">
                        <select
                          value={card.config.partialScoring || "exact"}
                          disabled={!editable}
                          onChange={(e) =>
                            configPatch(card, {
                              partialScoring: e.target.value,
                            })
                          }
                        >
                          <option value="exact">Kecocokan lengkap</option>
                          <option value="proportional">
                            Skor parsial proporsional
                          </option>
                        </select>
                      </Control>
                      <Control label="Pembahasan/umpan balik staf">
                        <textarea
                          value={card.explanation}
                          disabled={!editable}
                          onChange={(e) =>
                            cardPatch(card, { explanation: e.target.value })
                          }
                        />
                      </Control>
                    </div>
                  </details>
                  <button
                    className="form-icon"
                    disabled={!editable}
                    aria-label={`Duplikasi pertanyaan ${index + 1}`}
                    onClick={() => duplicate(card)}
                  >
                    <Copy size={18} />
                  </button>
                  <button
                    className="form-icon text-rose-700"
                    disabled={!editable}
                    aria-label={`Hapus pertanyaan ${index + 1}`}
                    onClick={() => cardPatch(card, { deleted: true })}
                  >
                    <Trash2 size={18} />
                  </button>
                  <label className="flex min-h-12 items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={card.required}
                      onChange={(e) =>
                        cardPatch(card, { required: e.target.checked })
                      }
                    />
                    Wajib
                  </label>
                </div>
                <details className="mt-3">
                  <summary>Bagian, stimulus & validasi</summary>
                  <div className="mt-3 grid gap-3">
                    <Control label="Bagian">
                      <select
                        value={card.sectionId}
                        disabled={!editable}
                        onChange={(e) =>
                          cardPatch(card, { sectionId: e.target.value })
                        }
                      >
                        <option value="">Bagian awal</option>
                        {sections.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                      </select>
                    </Control>
                    <Control label="Stimulus bersama">
                      <select
                        value={card.stimulusGroupId}
                        disabled={!editable}
                        onChange={(e) =>
                          cardPatch(card, { stimulusGroupId: e.target.value })
                        }
                      >
                        <option value="">Tanpa stimulus</option>
                        {ordered(content.stimuli).map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.title}
                          </option>
                        ))}
                      </select>
                    </Control>
                    {card.stimulusGroupId && (
                      <StimulusEditor
                        draft={content}
                        groupId={card.stimulusGroupId}
                        patch={patch}
                        session={session}
                        onUploadBusy={uploadBusy}
                        disabled={!editable}
                      />
                    )}
                    <button
                      className="form-button secondary"
                      disabled={!editable}
                      onClick={() => {
                        const gid = crypto.randomUUID();
                        patch(["stimuli"], {
                          [gid]: {
                            id: gid,
                            title: `Bahan ${Object.keys(content.stimuli).length + 1}`,
                            position: Object.keys(content.stimuli).length + 1,
                            deleted: false,
                            blocks: [],
                          },
                        });
                        cardPatch(card, { stimulusGroupId: gid });
                      }}
                    >
                      Tambah bahan pendukung
                    </button>
                    {["pg_tunggal", "dropdown"].includes(card.type) &&
                      card.config.choices?.map((choice) => (
                        <Control
                          key={choice.id}
                          label={`Jika memilih ${choice.text || "opsi tanpa judul"}`}
                        >
                          <select
                            disabled={!editable}
                            value={
                              card.config.branchToByAnswer?.[choice.id] || ""
                            }
                            onChange={(e) =>
                              configPatch(card, {
                                branchToByAnswer: {
                                  ...card.config.branchToByAnswer,
                                  [choice.id]: e.target.value,
                                },
                              })
                            }
                          >
                            <option value="">Lanjut biasa</option>
                            <option value="submit">Kirim formulir</option>
                            {sections
                              .filter(
                                (s) =>
                                  !card.sectionId ||
                                  s.position >
                                    (content.sections[card.sectionId]
                                      ?.position || 0),
                              )
                              .map((s) => (
                                <option value={s.id} key={s.id}>
                                  {s.title}
                                </option>
                              ))}
                          </select>
                        </Control>
                      ))}
                    {["isian_singkat", "uraian"].includes(card.type) && (
                      <div className="grid grid-cols-2 gap-3">
                        <Control label="Minimal karakter">
                          <input
                            type="number"
                            min="0"
                            value={card.config.textMinLength || 0}
                            disabled={!editable}
                            onChange={(e) =>
                              configPatch(card, {
                                textMinLength: Number(e.target.value),
                              })
                            }
                          />
                        </Control>
                        <Control label="Maksimal karakter">
                          <input
                            type="number"
                            min="1"
                            value={card.config.textMaxLength || 2000}
                            disabled={!editable}
                            onChange={(e) =>
                              configPatch(card, {
                                textMaxLength: Number(e.target.value),
                              })
                            }
                          />
                        </Control>
                      </div>
                    )}
                    {["pg_tunggal","pg_kompleks","dropdown"].includes(card.type) && <label className="flex min-h-12 items-center gap-3"><input type="checkbox" disabled={!editable} checked={Boolean(card.config.otherOption)} onChange={e=>configPatch(card,{otherOption:e.target.checked})}/>Tambahkan pilihan Lainnya (bukan kunci objektif)</label>}
                    {card.type === "pg_kompleks" && <div className="grid grid-cols-2 gap-3"><Control label="Minimal pilihan saat kirim"><input type="number" min="0" max="300" disabled={!editable} value={card.config.minChoices??0} onChange={e=>configPatch(card,{minChoices:Number(e.target.value)})}/></Control><Control label="Maksimal pilihan (0: bebas)"><input type="number" min="0" max="300" disabled={!editable} value={card.config.maxChoices??0} onChange={e=>configPatch(card,{maxChoices:Number(e.target.value)})}/></Control></div>}
                    {["isian_singkat","uraian"].includes(card.type) && <div className="grid gap-3"><Control label="Validasi jawaban"><select disabled={!editable} value={card.config.validationKind||"none"} onChange={e=>configPatch(card,{validationKind:e.target.value})}><option value="none">Teks biasa</option><option value="email">Alamat email</option><option value="url">Tautan HTTPS</option><option value="number">Angka dalam rentang</option><option value="contains">Harus memuat kata</option></select></Control>{card.config.validationKind==="number"&&<div className="grid grid-cols-2 gap-3"><Control label="Angka minimal"><input type="number" step="any" disabled={!editable} value={card.config.numberMin??""} onChange={e=>configPatch(card,{numberMin:e.target.value?Number(e.target.value):undefined})}/></Control><Control label="Angka maksimal"><input type="number" step="any" disabled={!editable} value={card.config.numberMax??""} onChange={e=>configPatch(card,{numberMax:e.target.value?Number(e.target.value):undefined})}/></Control></div>}{card.config.validationKind==="contains"&&<Control label="Kata yang harus ada"><input disabled={!editable} value={card.config.textContains||""} onChange={e=>configPatch(card,{textContains:e.target.value})}/></Control>}</div>}
                  </div>
                </details>
                <button
                  className="form-template"
                  disabled={!editable}
                  onClick={() =>
                    cardPatch(card, {
                      prompt: questionStarterPrompt(card.type),
                      config: defaultQuestionConfig(card.type),
                    })
                  }
                >
                  Gunakan template untuk jenis ini
                </button>
              </section>
              );
            }}
          />
        )}
        {tab === "questions" && cards.length === 0 && (
          <section className="form-card text-center">
            <BookOpen className="mx-auto mb-3 text-slate-400" />
            <h2 className="font-semibold">Mulai dengan pertanyaan pertama</h2>
            <p className="my-3 text-sm text-slate-600">
              Ketik pertanyaan dan pilih jenisnya. Tidak perlu kode atau
              sintaks.
            </p>
          <button
            className="form-button"
              disabled={!editable}
              onClick={() => add()}
            >
              Tambah pertanyaan
            </button>
          </section>
        )}
        {tab === "settings" && (
          <section className="form-card space-y-5">
            <h2 className="text-xl font-semibold">Setelan</h2>
            <fieldset disabled={!editable} className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Control label="Jenis asesmen">
                  <select
                    value={content.settings.kind}
                    onChange={(e) =>
                      settingsPatch({
                        kind: e.target.value as FormSettings["kind"],
                      })
                    }
                  >
                    <option value="ujian_online">Ujian Online</option>
                    <option value="simulasi">Simulasi</option>
                  </select>
                </Control>
                <Control label="Mata pelajaran">
                  <select
                    value={content.settings.subjectId}
                    onChange={(e) =>
                      settingsPatch({ subjectId: e.target.value })
                    }
                  >
                    <option value="">Pilih mata pelajaran dari LMS</option>
                    {subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.nama}</option>)}
                  </select>
                </Control>
                <Control label="Durasi (menit)">
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={content.settings.durationMinute}
                    onChange={(e) =>
                      settingsPatch({ durationMinute: Number(e.target.value) })
                    }
                  />
                </Control>
                <Control label="Batas percobaan">
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={content.settings.maxAttempts}
                    onChange={(e) =>
                      settingsPatch({ maxAttempts: Number(e.target.value) })
                    }
                  />
                </Control>
                <Control label="Nilai minimum lulus (poin)">
                  <input type="number" min="0" value={content.settings.passScore} onChange={e => settingsPatch({passScore:Number(e.target.value)})}/>
                </Control>
                <Control label="Mulai (opsional)">
                  <input
                    type="datetime-local"
                    value={localDate(content.settings.startsAt)}
                    onChange={(e) =>
                      settingsPatch({
                        startsAt: e.target.value
                          ? new Date(e.target.value).toISOString()
                          : null,
                      })
                    }
                  />
                </Control>
                <Control label="Berakhir (opsional)">
                  <input
                    type="datetime-local"
                    value={localDate(content.settings.endsAt)}
                    onChange={(e) =>
                      settingsPatch({
                        endsAt: e.target.value
                          ? new Date(e.target.value).toISOString()
                          : null,
                      })
                    }
                  />
                </Control>
              </div>
              <Control label="Kode akses peserta">
                <input
                  autoComplete="off"
                  value={content.settings.accessCode}
                  onChange={(e) =>
                    settingsPatch({ accessCode: e.target.value })
                  }
                />
              </Control>
              <button
                className="form-button secondary"
                onClick={() =>
                  settingsPatch({
                    accessCode: crypto.randomUUID().slice(0, 8).toUpperCase(),
                  })
                }
              >
                Buat/ganti kode acak
              </button>
              <Control label="Instruksi siswa">
                <textarea
                  value={content.settings.instructions}
                  onChange={(e) =>
                    settingsPatch({ instructions: e.target.value })
                  }
                />
              </Control>
              {[
                ["randomize", "Acak soal (kelompok stimulus tetap bersama)"],
                ["randomizeOptions", "Acak pilihan jawaban"],
                ["progressBar", "Tampilkan progres"],
                ["showResult", "Tampilkan nilai setelah penilaian"],
                ["showReview", "Tampilkan tinjauan jawaban"],
                ["acceptResponses", "Terima respons"],
                ["allowResponseEdit", "Izinkan revisi respons setelah kirim, hanya sebelum tenggat"],
              ].map(([key, label]) => (
                <label key={key} className="flex min-h-12 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={Boolean(
                      content.settings[key as keyof FormSettings],
                    )}
                    onChange={(e) => settingsPatch({ [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
              <Control label="Rilis nilai">
                <select
                  value={content.settings.resultsPolicy}
                  onChange={(e) =>
                    settingsPatch({ resultsPolicy: e.target.value })
                  }
                >
                  <option value="after_review">Setelah ditinjau tutor</option>
                  <option value="immediate">
                    Langsung setelah kirim (nilai objektif)
                  </option>
                  <option value="hidden">Tidak ditampilkan</option>
                </select>
              </Control>
              <Control label="Pesan setelah kirim">
                <textarea
                  value={content.settings.confirmationMessage}
                  onChange={(e) =>
                    settingsPatch({ confirmationMessage: e.target.value })
                  }
                />
              </Control>
              <Control label="Tema">
                <select
                  value={content.settings.themeColor}
                  onChange={(e) =>
                    settingsPatch({ themeColor: e.target.value })
                  }
                >
                  <option value="#326698">Biru CBT</option>
                  <option value="#155e75">Toska sekolah</option>
                  <option value="#6d28d9">Ungu</option>
                  <option value="#166534">Hijau</option>
                </select>
              </Control>
              <Control label="Font">
                <select
                  value={content.settings.font}
                  onChange={(e) => settingsPatch({ font: e.target.value })}
                >
                  <option value="sans-serif">Sans serif</option>
                  <option value="serif">Serif</option>
                  <option value="monospace">Monospace</option>
                </select>
              </Control>
              <button
                className="form-button secondary"
                onClick={() => setPanel("participants")}
              >
                Atur peserta dari LMS
              </button>
            </fieldset>
          </section>
        )}
        {tab === "responses" && (
          <FormResponses kind={kind} id={id} session={session} owner={envelope.role === 'owner'} frozen={envelope.frozen} canGrade={['owner','editor','grader'].includes(envelope.role)&&session.user.role!=='kepala_sekolah'}/>
        )}
      </div>
      {tab === "questions" && editable && (
        <aside aria-label="Tambah konten" className="form-toolbar">
          <button
            className="form-icon"
            aria-label="Tambah pertanyaan"
            onClick={() => add()}
          >
            <Plus />
          </button>
          <button
            className="form-icon"
            aria-label="Gunakan soal Bank Soal"
            onClick={() => setPanel("bank")}
          >
            <BookOpen />
          </button>
          <button
            className="form-icon"
            aria-label="Tambah bagian"
            onClick={addSection}
          >
            Tt
          </button>
          <button
            className="form-icon"
            aria-label="Tambah stimulus"
            onClick={() => setPanel("stimulus")}
          >
            <Image />
          </button>
          <button
            className="form-icon"
            aria-label="Pilih jenis soal"
            onClick={() => setPanel("types")}
          >
            15
          </button>
        </aside>
      )}
      {panel && (
        <div className="form-overlay" onClick={() => setPanel("")}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="panel-title"
            className="form-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id="panel-title" className="text-xl font-semibold">
                {
                  (
                    {
                      bank: "Gunakan ulang soal",
                      types: "Jenis pertanyaan",
                      share: "Bagikan dokumen",
                      participants: "Peserta dari LMS",
                      publish: "Siapkan & terbitkan",
                      stimulus: "Bahan pendukung",
                      theme: "Tema",
                    } as Record<string, string>
                  )[panel]
                }
              </h2>
              <button
                className="form-icon"
                aria-label="Tutup panel"
                onClick={() => setPanel("")}
              >
                <X />
              </button>
            </div>
            {panel === "types" && (
              <TypePalette add={add}/>
            )}
            {panel === "bank" && (
              <>
                <Control label="Cari soal">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </Control>
                <div className="mt-4 grid gap-2">
                  {bank
                    .filter((q) =>
                      q.prompt.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((q) => (
                      <button
                        key={q.id}
                        className="form-bank-item"
                        onClick={() => add(q.type, q)}
                      >
                        {q.prompt}
                        <span className="text-xs text-slate-500">
                          Salinan draf · {q.points} poin
                        </span>
                      </button>
                    ))}
                </div>
              </>
            )}
            {panel === "participants" && (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-slate-600">
                  Pilih beberapa kelas atau siswa tertentu. Data identitas
                  berasal dari LMS.
                </p>
                <button
                  className="form-button secondary"
                  disabled={!editable}
                  onClick={() =>
                    settingsPatch({
                      classIds: classes.map((c) => c.id),
                      studentIds: [],
                    })
                  }
                >
                  Pilih semua kelas
                </button>
                {classes.map((c) => (
                  <label
                    key={c.id}
                    className="flex min-h-12 items-center gap-3"
                  >
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={
                        content.settings.classIds?.includes(c.id) || false
                      }
                      onChange={(e) =>
                        settingsPatch({
                          classIds: e.target.checked
                            ? [...(content.settings.classIds || []), c.id]
                            : (content.settings.classIds || []).filter(
                                (v) => v !== c.id,
                              ),
                          studentIds: [],
                        })
                      }
                    />
                    {c.nama} {c.kelompokBelajar && `· ${c.kelompokBelajar}`}
                  </label>
                ))}
                <Control label="Cari siswa">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </Control>
                <button
                  className="form-button secondary"
                  disabled={!editable}
                  onClick={() =>
                    settingsPatch({
                      classIds: [],
                      studentIds: students
                        .filter((s) =>
                          s.nama.toLowerCase().includes(search.toLowerCase()),
                        )
                        .map((s) => s.id),
                    })
                  }
                >
                  Pilih semua siswa yang ditampilkan
                </button>
                {students
                  .filter((s) =>
                    s.nama.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((s) => (
                    <label
                      key={s.id}
                      className="flex min-h-12 items-center gap-3"
                    >
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={
                          content.settings.studentIds?.includes(s.id) || false
                        }
                        onChange={(e) =>
                          settingsPatch({
                            classIds: [],
                            studentIds: e.target.checked
                              ? [...(content.settings.studentIds || []), s.id]
                              : (content.settings.studentIds || []).filter(
                                  (v) => v !== s.id,
                                ),
                          })
                        }
                      />
                      <span>
                        {s.nama}
                        <small className="block text-slate-500">
                          NISN {s.nisn}
                        </small>
                      </span>
                    </label>
                  ))}
                {!classes.length && !students.length && (
                  <p role="alert">
                    Belum ada roster.{" "}
                    <Link to="/sinkronisasi" className="underline">
                      Sinkronkan LMS
                    </Link>{" "}
                    sebelum menerbitkan.
                  </p>
                )}
              </div>
            )}
            {panel === "share" && (
              <div className="mt-4 space-y-4">
                <p className="text-sm">
                  Tautan editor memerlukan akun staf dan izin dokumen ini.
                </p>
                <button
                  className="form-button secondary"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(window.location.href)
                      .then(() => setNotice("Tautan editor disalin"))
                  }
                >
                  <Copy size={18} />
                  Salin tautan editor
                </button>
                <Control label="Username kolaborator">
                  <input
                    value={member}
                    onChange={(e) => setMember(e.target.value)}
                  />
                </Control>
                <Control label="Peran">
                  <select
                    value={memberRole}
                    onChange={(e) => setMemberRole(e.target.value)}
                  >
                    <option value="editor">Editor</option>
                    <option value="grader">Penilai</option>
                    <option value="viewer">Pembaca</option>
                  </select>
                </Control>
                <button
                  className="form-button"
                  disabled={envelope.role !== "owner" || !member}
                  onClick={() =>
                    void api(
                      `/staff/forms/${kind}/${id}/collaborators`,
                      {
                        method: "PUT",
                        body: JSON.stringify({
                          username: member,
                          role: memberRole,
                        }),
                      },
                      session,
                    )
                      .then(() => {
                        setNotice("Izin dokumen disimpan");
                        setMember("");
                      })
                      .catch((e) => setNotice(e.message))
                  }
                >
                  Tambahkan kolaborator
                </button>
                {members.map((m) => (
                  <div
                    key={m.accountId}
                    className="flex flex-wrap justify-between gap-2 border-t py-2"
                  >
                    <p className="text-sm">
                      {m.name || m.username} · {m.role}
                    </p>
                    {envelope.role === "owner" && (
                      <button
                        className="form-button secondary"
                        onClick={() =>
                          void api(
                            `/staff/forms/${kind}/${id}/collaborators`,
                            {
                              method: "PUT",
                              body: JSON.stringify({
                                username: m.username,
                                role: m.role,
                                revoked: true,
                              }),
                            },
                            session,
                          )
                            .then(() => {
                              setMembers((rows) =>
                                rows.filter((r) => r.accountId !== m.accountId),
                              );
                              setNotice(
                                "Izin dicabut; editor akan diminta tersambung ulang.",
                              );
                            })
                            .catch((e) => setNotice(e.message))
                        }
                      >
                        Cabut izin
                      </button>
                    )}
                  </div>
                ))}
                {kind === "assessment" && envelope.role === "owner" && (
                  <FormAccessLinks
                    id={id}
                    session={session}
                    frozen={envelope.frozen}
                    onNotice={setNotice}
                  />
                )}
              </div>
            )}
            {panel === "theme" && (
              <div className="mt-4 grid gap-4">
                <FormHeaderEditor value={content.settings.headerImage} onChange={headerImage=>settingsPatch({headerImage})} session={session} disabled={!editable} onUploadBusy={uploadBusy}/>
                <Control label="Warna tema">
                  <select
                    disabled={!editable}
                    value={content.settings.themeColor}
                    onChange={(e) =>
                      settingsPatch({ themeColor: e.target.value })
                    }
                  >
                    <option value="#326698">Biru CBT</option>
                    <option value="#155e75">Toska sekolah</option>
                    <option value="#6d28d9">Ungu</option>
                    <option value="#166534">Hijau</option>
                  </select>
                </Control>
                <Control label="Font formulir">
                  <select
                    disabled={!editable}
                    value={content.settings.font}
                    onChange={(e) => settingsPatch({ font: e.target.value })}
                  >
                    <option value="sans-serif">Sans serif</option>
                    <option value="serif">Serif</option>
                    <option value="monospace">Monospace</option>
                  </select>
                </Control>
                <p className="text-sm">
                  Palet ini menjaga kontras kontrol utama. Ukuran teks siswa
                  dapat diubah saat pengerjaan.
                </p>
                <Control label="Poin bawaan soal baru"><input type="number" min={0} max={10000} disabled={!editable} value={content.settings.defaultQuestionPoints??1} onChange={e=>settingsPatch({defaultQuestionPoints:Number(e.target.value)})}/></Control>
                <label className="flex min-h-12 items-center gap-3"><input type="checkbox" disabled={!editable} checked={content.settings.defaultQuestionRequired||false} onChange={e=>settingsPatch({defaultQuestionRequired:e.target.checked})}/>Soal baru wajib dijawab secara default</label>
                <button className="form-button secondary" disabled={session.user.role==='kepala_sekolah'} onClick={()=>void api('/staff/form-preferences',{method:'PUT',body:JSON.stringify({themeColor:content.settings.themeColor,font:content.settings.font,durationMinute:content.settings.durationMinute,progressBar:content.settings.progressBar,defaultQuestionPoints:content.settings.defaultQuestionPoints??1,defaultQuestionRequired:content.settings.defaultQuestionRequired||false})},session).then(()=>setNotice('Default disimpan untuk formulir baru di semua perangkat. Kode dan peserta tidak disimpan sebagai default.')).catch(e=>setNotice(e.message))}>Simpan sebagai bawaan saya</button>
              </div>
            )}
            {panel === "stimulus" && (
              <div className="mt-4 space-y-3">
                {ordered(content.stimuli).map((g) => (
                  <div key={g.id}>
                    <h3 className="font-semibold">{g.title}</h3>
                    <StimulusEditor
                      draft={content}
                      groupId={g.id}
                      patch={patch}
                      session={session}
                      onUploadBusy={uploadBusy}
                      disabled={!editable}
                    />
                  </div>
                ))}
                <p className="text-sm">
                  Tambah atau pilih bahan pendukung dari kartu soal, lalu
                  tautkan ke beberapa soal.
                </p>
              </div>
            )}
            {panel === "publish" && (
              <div className="mt-4 grid gap-4">
                {[
                  [Boolean(content.title.trim()), "Judul paket"],
                  [cards.length > 0, "Minimal satu pertanyaan"],
                  [
                    kind === "package" ||
                      Boolean(
                        content.settings.classIds?.length ||
                        content.settings.studentIds?.length,
                      ),
                    "Penugasan peserta",
                  ],
                  [
                    kind === "package" ||
                      Boolean(content.settings.accessCode.trim()),
                    "Kode akses",
                  ],
                  [model.status === "saved", "Semua perubahan diakui server"],
                ].map(([ready, label]) => (
                  <p key={String(label)} className="flex items-center gap-2">
                    {ready ? (
                      <Check className="text-emerald-700" size={18} />
                    ) : (
                      <span className="size-4 rounded-full border" />
                    )}
                    {label}
                  </p>
                ))}
                <p className="text-sm text-slate-600">
                  Server memeriksa kunci, rubrik, bahan, peserta, jadwal, dan
                  snapshot dalam transaksi penerbitan.
                </p>
                <button
                  className="form-button secondary"
                  onClick={() => setPanel("participants")}
                >
                  Atur peserta
                </button>
                <button
                  className="form-button"
                  disabled={busy || pendingUploads > 0 || !editable}
                  onClick={() => void publish()}
                >
                  Terbitkan versi ini
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function localDate(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function MathTools({
  text,
  onChange,
  disabled,
}: {
  text: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [kind, setKind] = useState(""),
    [a, setA] = useState(""),
    [b, setB] = useState("");
  return (
    <div className="flex flex-wrap gap-2">
      <button
        className="form-template"
        disabled={disabled}
        onClick={() => setKind("fraction")}
      >
        Pecahan
      </button>
      <button
        className="form-template"
        disabled={disabled}
        onClick={() => setKind("power")}
      >
        Pangkat
      </button>
      <button
        className="form-template"
        disabled={disabled}
        onClick={() => setKind("root")}
      >
        Akar
      </button>
      {kind && (
        <div className="w-full rounded-xl bg-slate-50 p-3">
          <Control
            label={
              kind === "fraction"
                ? "Pembilang"
                : kind === "power"
                  ? "Bilangan dasar"
                  : "Bilangan di dalam akar"
            }
          >
            <input value={a} onChange={(e) => setA(e.target.value)} />
          </Control>
          {kind !== "root" && (
            <Control label={kind === "fraction" ? "Penyebut" : "Pangkat"}>
              <input value={b} onChange={(e) => setB(e.target.value)} />
            </Control>
          )}
          <button
            className="form-button secondary mt-2"
            onClick={() => {
              const superscripts: Record<string, string> = {
                "0": "⁰",
                "1": "¹",
                "2": "²",
                "3": "³",
                "4": "⁴",
                "5": "⁵",
                "6": "⁶",
                "7": "⁷",
                "8": "⁸",
                "9": "⁹",
                "-": "⁻",
              };
              const value =
                kind === "fraction"
                  ? `${a}⁄${b}`
                  : kind === "root"
                    ? `√(${a})`
                    : `${a}${[...b].map((c) => superscripts[c] || c).join("")}`;
              onChange(`${text}${text ? " " : ""}${value}`);
              setKind("");
              setA("");
              setB("");
            }}
          >
            Sisipkan
          </button>
        </div>
      )}
    </div>
  );
}
function StimulusEditor({
  draft,
  groupId,
  patch,
  session,
  disabled,
  onUploadBusy,
}: {
  draft: FormDraft;
  groupId: string;
  patch: (path: string[], value: object) => void;
  session: Session;
  disabled: boolean;
  onUploadBusy: (change:number) => void;
}) {
  const group = draft.stimuli[groupId],
    blocks = group?.blocks || [],
    [error, setError] = useState(""), [uploading,setUploading] = useState(''),
    [confirmRemove,setConfirmRemove] = useState(false);
  const latest = useRef(draft); latest.current = draft;
  const update = (id: string, value: Partial<StimulusBlock>) => {
    const current = latest.current.stimuli[groupId];
    if (!current || current.deleted) return;
    patch(["stimuli", groupId], {
      blocks: current.blocks.map((b) => (b.id === id ? { ...b, ...value } : b)),
    });
  };
  const add = (type: string) =>
    patch(["stimuli", groupId], {
      blocks: [
        ...blocks,
        {
          id: crypto.randomUUID(),
          type,
          title: "",
          content:
            type === "table"
              ? JSON.stringify([
                  ["", ""],
                  ["", ""],
                ])
              : "",
          alt: "",
        },
      ],
    });
  async function upload(id: string, file: File) {
    setUploading(id);setError('');onUploadBusy(1);
    try {
      if (!navigator.onLine)
        throw new Error("Hubungkan internet sebelum mengunggah media");
      const body = new FormData();
      body.set("file", await optimizeQuestionMedia(file));
      const media = await api<{
        id: string;
        url: string;
        kind: string;
        contentType: string;
      }>("/staff/question-media", { method: "POST", body }, session);
      update(id, {
        assetId: media.id,
        content: media.url,
        contentType: media.contentType,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {setUploading('');onUploadBusy(-1);}
  }
  if (!group || group.deleted) return null;
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-xl border p-3">
      <Control label="Judul stimulus bersama">
        <input
          value={group.title}
          onChange={(e) =>
            patch(["stimuli", groupId], { title: e.target.value })
          }
        />
      </Control>
      <SortableList
        items={blocks}
        disabled={disabled}
        onOrder={(rows) => patch(["stimuli", groupId], { blocks: rows })}
        render={(b) => (
          <div className="space-y-2 rounded-lg bg-slate-50 p-3">
            <Control label="Judul blok">
              <input
                value={b.title || ""}
                onChange={(e) => update(b.id, { title: e.target.value })}
              />
            </Control>
            {b.type === "table" ? (
              <VisualTableEditor
                table={JSON.parse(b.content || "[]")}
                onChange={(table) =>
                  update(b.id, { content: JSON.stringify(table) })
                }
              />
            ) : b.type === "text" ? (
              <Control label="Teks bacaan">
                <textarea
                  value={b.content}
                  onChange={(e) => update(b.id, { content: e.target.value })}
                />
              </Control>
            ) : (
              <>
                <Control label="Tautan HTTPS">
                  <input
                    type="url"
                    value={b.assetId ? "" : b.content}
                    onChange={(e) =>
                      update(b.id, {
                        content: e.target.value,
                        assetId: undefined,
                      })
                    }
                  />
                </Control>
                <Control label="Atau unggah media">
                  <input
                    type="file"
                    disabled={disabled || Boolean(uploading)}
                    accept={
                      b.type === "image"
                        ? "image/png,image/jpeg,image/webp"
                        : "audio/*,video/mp4,video/webm"
                    }
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void upload(b.id, file);
                    }}
                  />
                </Control>
                {b.assetId && (
                  <p className="text-sm text-emerald-700">
                    Media sudah diunggah
                  </p>
                )}
                {uploading===b.id && <p role="status">Mengunggah media… Publikasi menunggu unggahan selesai.</p>}
                {(b.assetId || /^https:\/\//i.test(b.content||'')) && <div aria-label="Pratinjau media stimulus" className="rounded-lg border bg-white p-3"><ProtectedQuestionMedia media={{...b,kind:b.type==='image'?'image':undefined}} accessToken={session.accessToken} alt={b.alt||b.title||'Pratinjau bahan soal'}/></div>}
              </>
            )}
            {b.type === "image" && (
              <Control label="Teks alternatif gambar (wajib)">
                <input
                  value={b.alt || ""}
                  onChange={(e) => update(b.id, { alt: e.target.value })}
                />
              </Control>
            )}
            <button
              className="form-icon text-rose-700"
              aria-label="Hapus blok stimulus"
              onClick={() =>
                patch(["stimuli", groupId], {
                  blocks: blocks.filter((v) => v.id !== b.id),
                })
              }
            >
              <Trash2 size={18} />
            </button>
          </div>
        )}
      />
      <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-900">
        {confirmRemove ? <><p>Hapus bahan ini dari semua soal dalam draf? Soal dan hasil terbit tetap aman. Batalkan perubahan saya dapat memulihkannya.</p><div className="mt-2 flex flex-wrap gap-2"><button className="form-button secondary" onClick={()=>setConfirmRemove(false)}>Pertahankan bahan</button><button className="form-button" onClick={()=>patch([],{
          stimuli:{[groupId]:{deleted:true}},
          cards:Object.fromEntries(ordered(latest.current.cards).filter(c=>c.stimulusGroupId===groupId).map(c=>[c.id,{stimulusGroupId:''}]))
        })}>Hapus bahan dari draf</button></div></> : <button className="form-button secondary" disabled={Boolean(uploading)} onClick={()=>setConfirmRemove(true)}><Trash2 size={18}/>Hapus bahan bersama</button>}
      </div>
      <div className="flex flex-wrap gap-2">
        {[
          ["text", "Teks"],
          ["table", "Tabel"],
          ["image", "Gambar"],
          ["media", "Audio/video"],
        ].map(([type, label]) => (
          <button
            key={type}
            className="form-button secondary"
            onClick={() => add(type)}
          >
            + {label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-rose-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}
function FormResponses({
  kind,
  id,
  session,
  owner,
  frozen,
  canGrade,
}: {
  kind: string;
  id: string;
  session: Session;
  owner: boolean;
  frozen: boolean;
  canGrade: boolean;
}) {
  const [release, setRelease] = useState<{releasedAt: string | null; policy: string; showResult: boolean} | null>(null);
  const [usage,setUsage]=useState<Array<{id:string;resourceType:string;title:string;kind:string;frozen:boolean}>>([]);
  const [params,setParams] = useSearchParams();
  const view=params.get('respons')||'summary', selected=params.get('upaya')||'';
  const choose=(key:string,value:string)=>{const next=new URLSearchParams(params);next.set(key,value);setParams(next)};
  const [analysis,setAnalysis]=useState<{items:Array<{questionId:string;position:number;prompt:string;answeredCount:number;attemptCount:number;correctRate?:number;meanScore?:number;weight:number;reason?:string}>}|null>(null);
  const [detail,setDetail]=useState<{attempt:{id:string;studentName:string;status:string;score:number};items:Array<{itemId:string;position:number;answerId:string;answer:string;weight:number;autoScore:number;manualScore?:number|null;correct?:boolean|null;comment:string;question:{prompt:string;type:string;configJson?:string}}> }|null>(null);
  const [marks,setMarks]=useState<Record<string,{score:string;comment:string}>>({}),[markBusy,setMarkBusy]=useState(false);
  const [rows, setRows] = useState<
      Array<{
        id: string;
        studentName: string;
        score: number;
        status: string;
        classIdAtAttempt: string;
      }>
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    if (kind === "assessment") {
      void api<typeof rows>(`/staff/assessments/${id}/results`, {}, session)
        .then(setRows)
        .catch((e) => setError(e.message));
      void api<typeof release>(`/staff/forms/${kind}/${id}/result-release`, {}, session).then(setRelease).catch(e=>setError(e.message));
    }else void api<typeof usage>(`/staff/forms/${kind}/${id}/usage`,{},session).then(setUsage).catch(e=>setError(e.message));
  }, [kind, id, session.accessToken]);
  useEffect(()=>{
    if(kind!=='assessment')return;
    if(view==='questions')void api<typeof analysis>(`/staff/assessments/${id}/item-analysis`,{},session).then(setAnalysis).catch(e=>setError(e.message));
    if(view==='individual'&&selected) {setDetail(null);void api<typeof detail>(`/staff/attempts/${selected}`,{},session).then(setDetail).catch(e=>setError(e.message));}
  },[kind,id,session.accessToken,view,selected]);
  async function mark(answerId:string){
    const value=marks[answerId];if(!value||value.score.trim()===''||!value.comment.trim()){setError('Isi nilai dan komentar sebelum menyimpan.');return}
    setMarkBusy(true);try{await api(`/staff/answers/${answerId}/grade`,{method:'POST',body:JSON.stringify({score:Number(value.score),comment:value.comment})},session);setDetail(await api<typeof detail>(`/staff/attempts/${selected}`,{},session));setRows(await api<typeof rows>(`/staff/assessments/${id}/results`,{},session));setError('')}catch(e){setError((e as Error).message)}finally{setMarkBusy(false)}
  }
  if(kind==='package')return <section className="form-card grid gap-4"><h2 className="text-xl font-semibold">Penggunaan paket</h2><p>Salinan dipakai tanpa mengubah soal sumber atau hasil lama.</p>{error&&<p role="alert">{error}</p>}{usage.length?usage.map(row=><Link className="form-bank-item" key={row.id} to={`/editor/${row.resourceType}/${row.id}`}><b>{row.title}</b><span>{row.kind==='simulasi'?'Simulasi':'Ujian Online'} · {row.frozen?'Diterbitkan':'Draf'}</span></Link>):<p>Paket belum digunakan dari kanvas baru. Pilih Buat Ujian Online atau Buat Simulasi di header.</p>}</section>;
  return (
    <section className="form-card space-y-4">
      <h2 className="text-xl font-semibold">
        {kind === "package" ? "Penggunaan paket" : "Respons"}
      </h2>
      {error && <p role="alert">{error}</p>}
      {release?.policy === 'after_review' && <div className="rounded-lg border p-4"><p>{release.releasedAt ? `Nilai dirilis ${new Date(release.releasedAt).toLocaleString('id-ID')}.` : 'Nilai belum dirilis ke siswa. Jawaban yang masih menunggu penilaian tetap ditahan.'}</p>{!release.showResult && <p className="mt-2 text-sm">Tampilan nilai dinonaktifkan di Setelan.</p>}{owner && frozen && <button className="form-button mt-3" onClick={()=>void api<typeof release>(`/staff/forms/${kind}/${id}/result-release`,{method:'POST'},session).then(setRelease).catch(e=>setError(e.message))}>{release.releasedAt ? 'Rilis revisi nilai terbaru' : 'Rilis nilai ke siswa'}</button>}</div>}
      <p>
        {kind === "package"
          ? "Paket Bank Soal dapat digunakan untuk membuat Ujian Online atau Simulasi."
          : `${rows.length} respons · ${rows.filter((r) => r.status === "pending_grade").length} menunggu penilaian`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link className="form-button secondary" to={`/hasil?assessment=${id}`}>
          Ringkasan, statistik & penilaian
        </Link>
        <Link
          className="form-button secondary"
          to={`/monitor?assessment=${id}`}
        >
          Monitor peserta
        </Link>
        {kind === "assessment" &&
          ["csv", "xlsx", "pdf"].map((format) => (
            <button
              key={format}
              className="form-button secondary"
              onClick={() =>
                void fetch(
                  `/api/staff/assessments/${id}/results/export.${format}`,
                  {
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                  },
                )
                  .then(async (r) => {
                    if (!r.ok) throw new Error("Unduhan gagal");
                    const url = URL.createObjectURL(await r.blob());
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `hasil.${format}`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  })
                  .catch((e) => setError(e.message))
              }
            >
              Unduh {format.toUpperCase()}
            </button>
          ))}
      </div>
      {kind === 'assessment'&&<nav className="flex flex-wrap gap-2" aria-label="Tampilan respons">{[['summary','Ringkasan'],['questions','Pertanyaan'],['individual','Individu']].map(([key,label])=><button key={key} className={`form-button ${view===key?'':'secondary'}`} aria-pressed={view===key} onClick={()=>choose('respons',key)}>{label}</button>)}</nav>}
      {view==='summary'&&<div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-4"><p>Total percobaan</p><b className="text-2xl">{rows.length}</b></div><div className="rounded-xl bg-slate-50 p-4"><p>Selesai dinilai</p><b className="text-2xl">{rows.filter(r=>r.status==='completed').length}</b></div><div className="rounded-xl bg-slate-50 p-4"><p>Rata-rata poin selesai</p><b className="text-2xl">{rows.some(r=>r.status==='completed')?(rows.filter(r=>r.status==='completed').reduce((n,r)=>n+r.score,0)/rows.filter(r=>r.status==='completed').length).toFixed(1):'—'}</b></div></div>}
      {view==='questions'&&analysis?.items.map(q=><article key={q.questionId} className="grid gap-2 rounded-xl border p-4"><h3 className="font-semibold">{q.position}. {q.prompt}</h3><p>{q.answeredCount} terjawab · {q.attemptCount} respons yang dinilai</p><p>{q.correctRate==null?'Dinilai manual':`${Math.round(q.correctRate*100)}% benar`} · rata-rata {q.meanScore?.toFixed(1)??'—'} / {q.weight} poin</p>{q.reason&&<p className="text-sm text-amber-800">{q.reason}</p>}</article>)}
      {view==='individual'&&<div className="grid gap-4"><Control label="Pilih respons siswa"><select value={selected} onChange={e=>choose('upaya',e.target.value)}><option value="">Pilih siswa / percobaan</option>{rows.map(r=><option key={r.id} value={r.id}>{r.studentName} · {r.status}</option>)}</select></Control>{detail&&<><h3 className="font-semibold">{detail.attempt.studentName} · {detail.attempt.score} poin</h3>{detail.items.map(item=><article className="grid gap-3 rounded-xl border p-4" key={item.itemId}><h4 className="font-semibold">{item.position}. {item.question.prompt}</h4><p className="whitespace-pre-wrap">{readableResponse(item.question,item.answer)}</p><StaffFileDownloads answerId={item.answerId} raw={item.answer} session={session} onError={setError}/><p>Skor {item.manualScore??item.autoScore} / {item.weight}</p>{item.comment&&<p>Komentar: {item.comment}</p>}{['uraian','unggah_berkas'].includes(item.question.type)&&item.answerId&&canGrade&&<div className="grid gap-3"><Control label={`Nilai soal ${item.position}`}><input type="number" min={0} max={item.weight} value={marks[item.answerId]?.score??String(item.manualScore??'')} onChange={e=>setMarks(v=>({...v,[item.answerId]:{score:e.target.value,comment:v[item.answerId]?.comment??item.comment}}))}/></Control><Control label={`Komentar soal ${item.position}`}><textarea value={marks[item.answerId]?.comment??item.comment} onChange={e=>setMarks(v=>({...v,[item.answerId]:{score:v[item.answerId]?.score??String(item.manualScore??''),comment:e.target.value}}))}/></Control><button className="form-button" disabled={markBusy||detail.attempt.status==='started'} onClick={()=>void mark(item.answerId)}>Simpan penilaian soal {item.position}</button></div>}</article>)}</>}</div>}
      {view==='summary'&&rows.map((r) => (
        <div
          key={r.id}
          className="flex flex-wrap justify-between gap-2 border-t py-3"
        >
          <span>{r.studentName}</span>
          <span>
            {r.status} · {r.score} poin
          </span>
        </div>
      ))}
    </section>
  );
}
function StaffFileDownloads({answerId,raw,session,onError}:{answerId:string;raw:string;session:Session;onError:(message:string)=>void}) {
  let values:unknown;try{values=JSON.parse(raw)}catch{return null}
  if(!Array.isArray(values))return null;
  const files=values.filter(v=>v&&typeof v==='object'&&typeof v.id==='string'&&typeof v.name==='string');
  async function download(id:string,name:string){try{
    const response=await fetch(`/api/staff/answers/${encodeURIComponent(answerId)}/files/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${session.accessToken}`},cache:'no-store'});
    if(!response.ok)throw new Error('Berkas tidak tersedia atau akses ditolak');
    const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){onError((error as Error).message)}}
  return files.length?<div className="grid gap-2">{files.map(file=><button key={file.id} className="form-button secondary" onClick={()=>void download(file.id,file.name)}>Unduh jawaban: {file.name}</button>)}</div>:null;
}
function readableResponse(question:{type:string;configJson?:string},raw:string):string {
  try { return readableAnswer({type:question.type,config:JSON.parse(question.configJson||'{}')},JSON.parse(raw)); }
  catch { return raw||'Belum dijawab'; }
}
