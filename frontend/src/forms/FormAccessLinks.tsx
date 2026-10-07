import { useEffect, useState } from "react";
import { api, type Session } from "../api";
type AccessLink = { id: string; expiresAt?: string; revoked: boolean };
export function FormAccessLinks({
  id,
  session,
  frozen,
  onNotice,
}: {
  id: string;
  session: Session;
  frozen: boolean;
  onNotice: (v: string) => void;
}) {
  const [links, setLinks] = useState<AccessLink[]>([]),
    [paused, setPaused] = useState(false),
    [expires, setExpires] = useState(""),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false);
  const path = `/staff/forms/assessment/${id}`;
  async function load() {
    const value = await api<{ links: AccessLink[]; paused: boolean }>(
      `${path}/links`,
      {},
      session,
    );
    setLinks(value.links);
    setPaused(value.paused);
  }
  useEffect(() => {
    void load().catch((e) => onNotice(e.message));
  }, [id, session.accessToken]);
  async function create() {
    setBusy(true);
    try {
      const result = await api<{ url: string }>(
        `${path}/links`,
        {
          method: "POST",
          body: JSON.stringify({
            expiresAt: expires ? new Date(expires).toISOString() : null,
          }),
        },
        session,
      );
      setUrl(result.url);
      await load();
      onNotice(
        "Tautan terbatas dibuat. Siswa tetap menggunakan NISN dan kode tutor.",
      );
    } catch (e) {
      onNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(link: AccessLink) {
    try {
      await api(`${path}/links/${link.id}`, { method: "DELETE" }, session);
      await load();
      setUrl("");
      onNotice("Tautan dicabut. Percobaan aktif tidak dihentikan.");
    } catch (e) {
      onNotice((e as Error).message);
    }
  }
  return (
    <section className="space-y-3 border-t pt-4">
      <h3 className="font-semibold">Akses peserta</h3>
      <p className="text-sm text-slate-600">
        Tautan tidak memberikan akses anonim. NISN, kode, penugasan, dan jadwal
        tetap diperiksa server.
      </p>
      <label className="flex min-h-12 items-center gap-3">
        <input
          type="checkbox"
          checked={paused}
          onChange={(e) => {
            const value = e.target.checked;
            void api(
              `${path}/acceptance`,
              { method: "PUT", body: JSON.stringify({ paused: value }) },
              session,
            )
              .then(() => {
                setPaused(value);
                onNotice(
                  value
                    ? "Peserta baru dijeda; percobaan aktif tetap berjalan."
                    : "Penerimaan peserta dibuka kembali.",
                );
              })
              .catch((e) => onNotice(e.message));
          }}
        />
        Jeda peserta baru
      </label>
      <label className="form-field">
        Tautan berlaku sampai (opsional)
        <input
          type="datetime-local"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
      </label>
      <button
        className="form-button"
        disabled={!frozen || busy}
        onClick={() => void create()}
      >
        Buat tautan peserta
      </button>
      {!frozen && (
        <p className="text-sm">Terbitkan dahulu untuk membagikan asesmen.</p>
      )}
      {url && (
        <label className="form-field">
          Tautan baru (simpan sebelum menutup)
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button
            className="form-button secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(url)
                .then(() => onNotice("Tautan disalin"))
                .catch(() => onNotice("Pilih dan salin tautan secara manual."))
            }
          >
            Salin tautan peserta
          </button>
        </label>
      )}
      {url&&<label className="form-field">Embed (hanya situs yang diizinkan admin)<textarea readOnly value={`<iframe src="${url}" title="Asesmen PKBM Tunas Ilmu" width="100%" height="820" loading="lazy"></iframe>`} onFocus={e=>e.target.select()}/><p className="text-sm text-slate-600">Admin perlu mengisi CBT_EMBED_ALLOWED_ORIGINS. Tanpa izin origin, browser menolak iframe.</p></label>}
      {links.map((link) => (
        <div
          key={link.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
        >
          <span className="text-sm">
            {link.expiresAt
              ? `Sampai ${new Date(link.expiresAt).toLocaleString("id-ID")}`
              : "Tanpa kedaluwarsa"}{" "}
            · {link.revoked ? "Dicabut" : "Aktif"}
          </span>
          <button
            className="form-button secondary"
            disabled={link.revoked}
            onClick={() => void revoke(link)}
          >
            Cabut tautan
          </button>
        </div>
      ))}
    </section>
  );
}
