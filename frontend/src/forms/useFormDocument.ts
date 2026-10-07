import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { createCrdt } from "../../../shared/form-crdt.mjs";
import { api, ApiError, type Session } from "../api";
import type { FormDraft, FormEnvelope } from "./types";
import { cacheEnvelope, readEnvelope, saveRecovery, readRecovery } from "./draftCache";

const { patchWithUndo, readDocument } = createCrdt(Y);
type FormPerson = { name: string; field?: string; path?: string[]; start?: number; end?: number };
const isPerson = (person: FormPerson | null): person is FormPerson => person !== null;
export type SaveStatus =
  | "connecting"
  | "saving"
  | "saved"
  | "offline"
  | "error"
  | "conflict"
  | "readonly";
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export function useFormDocument(kind: string, id: string, session: Session) {
  const [envelope, setEnvelope] = useState<FormEnvelope | null>(null),
    [content, setContent] = useState<FormDraft | null>(null),
    [status, setStatus] = useState<SaveStatus>("connecting"),
    [error, setError] = useState(""),
    [people, setPeople] = useState<FormPerson[]>([]);
  const [recoveryContent,setRecoveryContent]=useState<FormDraft|null>(null);
  const live = useRef<{
    doc: Y.Doc;
    provider: HocuspocusProvider;
    undo: Y.UndoManager;
    origin: object;
  } | null>(null);
  const revision = useRef(0),
    ack = useRef(""),
    flushers = useRef(
      new Map<
        string,
        { resolve: (value: number) => void; reject: (error: Error) => void }
      >(),
    );
  const [retry, setRetry] = useState(0);
  const [publicationPending, setPublicationPending] = useState(false), publicationLock = useRef(false);
  useEffect(() => {
    let active = true;
    let cleanup = () => {};
    setContent(null);
    setStatus("connecting");
    setError("");
    setPublicationPending(false); publicationLock.current=false;
    void (async () => {
      const cacheKey = `${session.user.id}:${kind}:${id}`;
      const recover=await readRecovery(cacheKey).catch(()=>undefined);
      if(active)setRecoveryContent(recover||null);
      const result = await api<FormEnvelope & { collaborationUrl?: string }>(
        `/staff/forms/${kind}/${id}`,
        {},
        session,
      ).catch(async (error) => {
        if (navigator.onLine) throw error;
        const cached = await readEnvelope(cacheKey);
        if (!cached) throw error;
        return cached;
      });
      if (!active) return;
      setEnvelope(result);
      revision.current = result.revision;
      ack.current = "";
      if (result.frozen) {
        setContent(result.content);
        setStatus("readonly");
        return;
      }
      const ticket = await api<{
        ticket: string;
        documentId: string;
        url: string;
        name: string;
        role: string;
      }>(
        `/staff/forms/${kind}/${id}/ticket`,
        { method: "POST" },
        session,
      ).catch((error) => {
        if (navigator.onLine) throw error;
        return {
          ticket: "",
          documentId: result.id,
          url: result.collaborationUrl || "/realtime",
          name: session.user.nama,
          role: result.role,
        };
      });
      if (!active) return;
      void cacheEnvelope(cacheKey, {
        ...result,
        collaborationUrl: ticket.url,
      }).catch(() => {});
      const doc = new Y.Doc(),
        origin = {},
        root = doc.getMap("form");
      let blocked = false, needsCheck = !navigator.onLine;
      const conflict = (message: string) => {
        blocked = true;
        setStatus("conflict");
        setError(message);
      };
      const baselineKey=`cbt-form-baseline:${session.user.id}:${kind}:${id}:${result.syncEpoch||0}`;
      const persistence = new IndexeddbPersistence(
        `cbt-form:${session.user.id}:${result.id}:${result.syncEpoch || 0}${localStorage.getItem(baselineKey)||''}`,
        doc,
      );
      await persistence.whenSynced;
      if (!active) {
        persistence.destroy();
        doc.destroy();
        return;
      }
      if (root.has("schemaVersion")) {
        setContent(readDocument(doc) as FormDraft);
        setStatus(navigator.onLine ? "connecting" : "offline");
      }
      // Never seed client-side: merging independently seeded maps would create
      // competing Y.Texts. Bootstrap is exclusively done by the collaboration host.
      const undo = new Y.UndoManager(root, {
        trackedOrigins: new Set([origin]),
        captureTimeout: 400,
      });
      const url = new URL(ticket.url, window.location.origin);
      url.protocol =
        url.protocol === "https:"
          ? "wss:"
          : url.protocol === "http:"
            ? "ws:"
            : url.protocol;
      const provider = new HocuspocusProvider({
        url: url.href,
        name: ticket.documentId,
        document: doc,
        token: async () =>
          (
            await api<{ ticket: string }>(
              `/staff/forms/${kind}/${id}/ticket`,
              { method: "POST" },
              session,
            )
          ).ticket,
        onStatus: ({ status: connection }) => {
          if (active && !blocked && connection !== "connected")
            setStatus(navigator.onLine ? "connecting" : "offline");
        },
        onSynced: ({ state }) => {
          if (active && !blocked && state) {
            setContent(readDocument(doc) as FormDraft);
            if (!["owner", "editor"].includes(result.role))
              setStatus("readonly");
            else
              provider.sendStateless(
                JSON.stringify({
                  type: "flush",
                  requestId: crypto.randomUUID(),
                }),
              );
          }
        },
        onAuthenticationFailed: () => {
          if (active) {
            conflict(
              "Akses berubah atau tiket tidak berlaku. Hubungkan ulang.",
            );
          }
        },
        onStateless: ({ payload }) => {
          if (!active) return;
          try {
            const m = JSON.parse(payload);
            if(m.type === 'prepare-publish') {
              publicationLock.current = true;
              setPublicationPending(true);
              provider.sendStateless(JSON.stringify({type:'publication-ready',requestId:m.requestId,vector:base64(Y.encodeStateVector(doc))}));
            }
            if(m.type === 'publish-cancelled') {
              publicationLock.current = false;
              setPublicationPending(false);
              setError(m.message);
            }
            if (m.type === "saved") {
              if (blocked) return;
              revision.current = m.revision;
              ack.current = m.vector;
              setStatus(
                !navigator.onLine ? "offline" : base64(Y.encodeStateVector(doc)) === m.vector
                  ? "saved"
                  : "saving",
              );
            }
            if (m.type === "flushed") {
              revision.current = m.revision;
              flushers.current.get(m.requestId)?.resolve(m.revision);
              flushers.current.delete(m.requestId);
            }
            if (m.type === "published") {
              publicationLock.current = false;
              setPublicationPending(false);
              setStatus("readonly");
              setEnvelope((old) => (old ? { ...old, frozen: true } : old));
              flushers.current.get(m.requestId)?.resolve(revision.current);
              flushers.current.delete(m.requestId);
            }
            if (m.type === "error") {
              if (m.status === 409 || m.status === 403) blocked = true;
              setStatus(blocked ? "conflict" : "error");
              setError(m.message);
              for (const f of flushers.current.values())
                f.reject(new Error(m.message));
              flushers.current.clear();
            }
          } catch {
            /* Ignore unknown protocol frames. */
          }
        },
        onAwarenessChange: ({ states }) => {
          if (active)
            setPeople(
              states
                .map((s) => cursorPerson(s.user,doc))
                .filter(isPerson),
            );
        },
      });
      provider.setAwarenessField("user", {
        name: session.user.nama,
        field: "",
      });
      const refresh = () => {
        if (active) {
          if (!navigator.onLine) needsCheck = true;
          setContent(readDocument(doc) as FormDraft);
          setPeople([...provider.awareness?.getStates().values()||[]].map(s=>cursorPerson(s.user,doc)).filter(isPerson));
          if (!blocked && formEditable(result.role))
            setStatus(
              navigator.onLine
                ? base64(Y.encodeStateVector(doc)) === ack.current
                  ? "saved"
                  : "saving"
                : "offline",
            );
        }
      };
      root.observeDeep(refresh);
      live.current = { doc, provider, undo, origin };
      let checking = false;
      const reconnect = async () => {
        if (!active || blocked || checking || !navigator.onLine) return;
        checking = true;
        try {
          // An external REST save starts a new CRDT epoch. Never reconnect the
          // previous local room into it: retain the local draft for recovery.
          const current = await api<FormEnvelope>(`/staff/forms/${kind}/${id}`, {}, session);
          if (!active) return;
          if (current.syncEpoch !== result.syncEpoch || current.frozen || current.role !== result.role) {
            conflict("Versi atau akses draf berubah di server. Perubahan lokal tetap disimpan; pilih versi server atau buat salinan.");
            provider.configuration.websocketProvider.disconnect();
            return;
          }
          needsCheck = false;
          setError("");
          if (provider.configuration.websocketProvider.status === "connected" && provider.isAuthenticated) {
            setStatus(formEditable(result.role) ? base64(Y.encodeStateVector(doc)) === ack.current ? "saved" : "saving" : "readonly");
          } else {
            setStatus("connecting");
            void provider.configuration.websocketProvider.connect().catch(() => {
              if (active && !blocked) setStatus(navigator.onLine ? "error" : "offline");
            });
          }
        } catch (reason) {
          if (!active) return;
          if (reason instanceof ApiError && [403, 404, 409].includes(reason.status)) {
            conflict("Akses draf berubah. Perubahan lokal tetap aman; hubungi pemilik paket.");
          } else {
            setStatus(navigator.onLine ? "error" : "offline");
            setError("Koneksi belum pulih. Perubahan lokal tetap aman dan akan dicoba kembali.");
          }
        } finally { checking = false; }
      };
      const offline = () => { needsCheck = true; if (active && !blocked) setStatus("offline"); };
      const visible = () => { if (document.visibilityState === "visible") void reconnect(); };
      // Browser/network proxies do not always emit an online event. Also retry
      // disconnected rooms periodically, without polling healthy connections.
      const recoveryTimer = window.setInterval(() => {
        if (needsCheck || provider.configuration.websocketProvider.status !== "connected" || !provider.isAuthenticated)
          void reconnect();
      }, 5000);
      window.addEventListener("online", reconnect);
      window.addEventListener("offline", offline);
      document.addEventListener("visibilitychange", visible);
      cleanup = () => {
        window.removeEventListener("online", reconnect);
        window.removeEventListener("offline", offline);
        document.removeEventListener("visibilitychange", visible);
        window.clearInterval(recoveryTimer);
        root.unobserveDeep(refresh);
        provider.destroy();
        persistence.destroy();
        undo.destroy();
        doc.destroy();
        live.current = null;
      };
    })().catch((reason) => {
      if (active) {
        setStatus("error");
        setError(
          reason instanceof Error ? reason.message : "Draf belum dapat dimuat",
        );
      }
    });
    return () => {
      active = false;
      cleanup();
      for (const f of flushers.current.values())
        f.reject(new Error("Editor ditutup"));
      flushers.current.clear();
    };
  }, [kind, id, session.accessToken, retry]);
  const patch = useCallback(
    (path: string[], value: object) => {
      const state = live.current;
      if (!state || !envelope || envelope.frozen || publicationLock.current || !formEditable(envelope.role)) return;
      if (!patchWithUndo(state.doc,path,value,state.origin,state.undo))
        setError("Bidang belum tersinkron. Coba hubungkan ulang.");
    },
    [envelope],
  );
  const flush = useCallback(async (publish = false) => {
    const state = live.current;
    if (!state || !navigator.onLine)
      throw new Error("Koneksi diperlukan untuk menyimpan dan menerbitkan");
    const id = crypto.randomUUID();
    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        flushers.current.delete(id);
        reject(new Error("Belum ada pengakuan penyimpanan dari server"));
      }, 20000);
      flushers.current.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });
      state.provider.sendStateless(
        JSON.stringify({ type: publish ? "publish" : "flush", requestId: id }),
      );
    });
  }, []);
  const focus = useCallback(
    (field: string) => {
      live.current?.provider.setAwarenessField("user", {
        name: session.user.nama,
        field,
      });
    },
    [session.user.nama],
  );
  const format = (path:string[],start:number,end:number,attributes:Record<string,boolean|null>) => {
    const state=live.current;if(!state||!envelope||envelope.frozen||publicationLock.current||!formEditable(envelope.role))return;
    const text=textAt(state.doc,path);if(!text||start<0||end>text.length||end<=start)return;
    state.undo.stopCapturing();
    state.doc.transact(()=>text.format(start,end-start,attributes),state.origin);
    state.undo.stopCapturing();
  };
  const select = (path:string[],start:number,end:number) => {
    const state=live.current;if(!state)return;const text=textAt(state.doc,path);if(!text)return;
    state.provider.setAwarenessField('user',{name:session.user.nama,field:'Pertanyaan',cursor:{path,start:[...Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text,Math.min(start,text.length)))],end:[...Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text,Math.min(end,text.length)))]}});
  };
  const loadServer=async()=>{
    if(!envelope||!content||!navigator.onLine)throw new Error('Hubungkan internet sebelum memuat versi server');
    const cacheKey=`${session.user.id}:${kind}:${id}`;
    await saveRecovery(cacheKey,content);
    // Keep the old IndexedDB intact for recovery. A fresh, persistent local
    // baseline prevents discarded pending changes from reappearing on reload.
    localStorage.setItem(`cbt-form-baseline:${session.user.id}:${kind}:${id}:${envelope.syncEpoch||0}`,`:server:${crypto.randomUUID()}`);
    setRetry(n=>n+1);
  };
  return {
    envelope,
    content,
    status,
    error,
    people,
    publicationPending,
    patch,
    flush,
    focus,
    format,
    select,
    loadServer,
    recoveryContent,
    undo: () => live.current?.undo.undo(),
    redo: () => live.current?.undo.redo(),
    reconnect: () => setRetry((n) => n + 1),
  };
}
function textAt(doc:Y.Doc,path:string[]):Y.Text|null{let value:unknown=doc.getMap('form');for(const key of path){if(!(value instanceof Y.Map))return null;value=value.get(key)}return value instanceof Y.Text?value:null}
function cursorPerson(user:any,doc:Y.Doc):FormPerson|null{
  if(!user||typeof user.name!=='string')return null;
  const person:FormPerson={name:user.name,field:typeof user.field==='string'?user.field:undefined};
  const cursor=user.cursor;
  try{if(cursor&&Array.isArray(cursor.path)&&Array.isArray(cursor.start)&&cursor.start.length<1024&&Array.isArray(cursor.end)&&cursor.end.length<1024){const text=textAt(doc,cursor.path),start=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(new Uint8Array(cursor.start)),doc),end=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(new Uint8Array(cursor.end)),doc);if(text&&start?.type===text&&end?.type===text){person.path=cursor.path;person.start=start.index;person.end=end.index}}}catch{/* Ignore malformed peer awareness, not document state. */}
  return person;
}
function formEditable(role: string) {
  return role === "owner" || role === "editor";
}
