import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

// Private blobs live only in this authenticated UI session, never in IndexedDB/SW.
export class SessionMediaCache {
  private entries = new Map<string, Promise<string>>()
  private controllers = new Set<AbortController>()
  private urls = new Set<string>()
  private generation = 0
  load(id: string, token: string) {
    const cached = this.entries.get(id)
    if (cached) return cached
    const controller = new AbortController(), generation = this.generation
    this.controllers.add(controller)
    const promise = fetch(`/api/question-media/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 401 ? 'Sesi akses berakhir. Masuk kembali untuk memuat media.' : response.status === 403 ? 'Media tidak tersedia untuk akun ini. Hubungi tutor.' : response.status === 404 ? 'Bahan ini tidak ditemukan. Hubungi tutor.' : 'Media belum dapat dimuat. Periksa koneksi lalu coba lagi.')
        const blob = await response.blob()
        if (generation !== this.generation) throw new Error('Sesi media telah berakhir.')
        const url = URL.createObjectURL(blob)
        this.urls.add(url)
        return url
      }).catch(error => { if (this.entries.get(id) === promise) this.entries.delete(id); throw error })
      .finally(() => this.controllers.delete(controller))
    this.entries.set(id, promise)
    return promise
  }
  invalidate(id: string) { this.entries.delete(id) }
  clear() {
    this.generation++
    this.controllers.forEach(controller => controller.abort())
    this.controllers.clear()
    this.urls.forEach(url => URL.revokeObjectURL(url))
    this.urls.clear(); this.entries.clear()
  }
}
const StudentUxContext = createContext<{ enabled: boolean; cache: SessionMediaCache | null }>({ enabled: false, cache: null })
export function StudentUxProvider({ enabled, token, children }: { enabled: boolean; token: string; children: ReactNode }) {
  const cache = useMemo(() => new SessionMediaCache(), [token])
  useEffect(() => () => cache.clear(), [cache])
  return <StudentUxContext.Provider value={{ enabled, cache }}>{children}</StudentUxContext.Provider>
}
export const useStudentUx = () => useContext(StudentUxContext)
export const attemptStatusLabel = (status: string) => ({ started: 'Sedang dikerjakan', completed: 'Selesai', submitted: 'Terkirim', pending_grade: 'Menunggu penilaian', expired: 'Waktu berakhir' })[status] || 'Selesai dikumpulkan'
