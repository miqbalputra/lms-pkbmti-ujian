import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minus, Plus, RotateCcw, X } from 'lucide-react'
import type { QuestionMediaAttachment } from './questionMedia'
import { SessionMediaCache, useStudentUx } from './studentUx'
import { useDialogFocus } from './forms/useDialogFocus'
import './student-ux.css'

export type MediaPresentation = 'stimulus' | 'option' | 'header'
export function StudentMedia({ media, accessToken, alt, presentation = 'stimulus' }: { media: Partial<QuestionMediaAttachment> & { content?: string }; accessToken?: string; alt: string; presentation?: MediaPresentation }) {
  const { cache } = useStudentUx()
  const localCache = useRef<SessionMediaCache | null>(null)
  const [source, setSource] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0), [open, setOpen] = useState(false)
  useEffect(() => {
    let disposed = false
    setSource(''); setError(''); setOpen(false)
    if (!media.assetId) { const url=media.url || media.content || ''; if(url)setSource(url);else setError('Media belum tersedia. Hubungi tutor.'); return }
    if (!accessToken) { setError('Sesi akses berakhir. Masuk kembali untuk memuat media.'); return }
    const store = cache || (localCache.current ||= new SessionMediaCache())
    void store.load(media.assetId, accessToken).then(url => { if (!disposed) setSource(url) }).catch(e => { if (!disposed) setError(e.message) })
    return () => { disposed = true }
  }, [media.assetId, media.url, media.content, accessToken, retry, cache])
  useEffect(() => () => localCache.current?.clear(), [])
  const failed = () => { setError('Media tidak dapat ditampilkan. Coba muat ulang atau hubungi tutor.'); if (media.assetId) cache?.invalidate(media.assetId) }
  return <figure className={`student-media student-media-${presentation}`}>
    {error ? <div className="student-media-error" role="status"><p>{error}</p><button type="button" onClick={() => { if (media.assetId) (cache || localCache.current)?.invalidate(media.assetId); setRetry(n => n + 1) }}>Coba lagi</button></div> : !source ? <div className="student-media-loading" role="status">Memuat media…</div> : media.kind === 'audio' || media.contentType?.startsWith('audio/') ? <audio controls preload="metadata" src={source} onError={failed} aria-label={alt} /> : media.kind === 'video' || media.contentType?.startsWith('video/') ? <video controls preload="metadata" src={source} onError={failed} aria-label={alt} /> : <>
      <img src={source} alt={alt} onError={failed} decoding="async" />
      <button type="button" className="student-media-expand" aria-label={`Perbesar gambar: ${alt}`} onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(true) }}><Maximize2 size={16} /> Perbesar gambar</button>
      {open && createPortal(<ImageViewer source={source} alt={alt} onClose={() => setOpen(false)} />, document.body)}
    </>}
  </figure>
}

function ImageViewer({ source, alt, onClose }: { source: string; alt: string; onClose: () => void }) {
  const id = useId(), dialog = useRef<HTMLElement>(null), viewport = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const pointer = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  useDialogFocus(true, onClose, dialog)
  function reset() { setZoom(1); viewport.current?.scrollTo(0, 0) }
  return <div className="student-image-overlay" onClick={onClose}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={id} className="student-image-dialog" onClick={e => e.stopPropagation()}>
      <header><h2 id={id}>{alt}</h2><button type="button" aria-label="Tutup gambar" onClick={onClose}><X /></button></header>
      <div className="student-image-tools" aria-label="Ukuran gambar">
        <button type="button" aria-label="Perkecil gambar" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - .5))}><Minus /></button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Perbesar lagi" disabled={zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + .5))}><Plus /></button>
        <button type="button" onClick={reset}><RotateCcw size={16} /> Sesuaikan layar</button>
      </div>
      <p className="student-image-hint">Geser gambar atau gunakan tombol panah untuk melihat detail. Escape untuk menutup.</p>
      <div ref={viewport} className="student-image-viewport" tabIndex={0} role="region" aria-label="Detail gambar, dapat digeser" onKeyDown={e => {
        const directions: Record<string, [number, number]> = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] }
        if (directions[e.key]) { e.preventDefault(); const [left, top] = directions[e.key]; viewport.current?.scrollBy({ left, top }) }
      }} onPointerDown={e => { if (e.pointerType === 'touch') return; const node = viewport.current!; pointer.current = { x: e.clientX, y: e.clientY, left: node.scrollLeft, top: node.scrollTop }; node.setPointerCapture(e.pointerId) }} onPointerMove={e => { const p = pointer.current; if (p && viewport.current) { viewport.current.scrollLeft = p.left - e.clientX + p.x; viewport.current.scrollTop = p.top - e.clientY + p.y } }} onPointerUp={() => { pointer.current = null }} onPointerCancel={() => { pointer.current = null }}>
        <div style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }} className="student-image-stage"><img src={source} alt={alt} draggable={false} /></div>
      </div>
    </section>
  </div>
}
