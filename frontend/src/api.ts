export type Session = { accessToken: string; user: { id: string; username: string; nama: string; role: string; pesertaDidikId?: string } }
const storageKey = 'pkbm-cbt-session'
export const loadSession = (): Session | null => { try { const value = localStorage.getItem(storageKey); return value ? JSON.parse(value) as Session : null } catch { return null } }
export const saveSession = (session: Session | null) => { if (session) localStorage.setItem(storageKey, JSON.stringify(session)); else localStorage.removeItem(storageKey) }
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError' }
}
export async function api<T>(path: string, init: RequestInit = {}, session = loadSession()): Promise<T> {
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (session?.accessToken) headers.set('Authorization', `Bearer ${session.accessToken}`)
  const response = await fetch(`/api${path}`, { ...init, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const fallback = response.status === 502
      ? 'Layanan CBT atau LMS sementara tidak tersedia (HTTP 502). Periksa LMS_BASE_URL dan status aplikasi di Coolify.'
      : `Permintaan gagal (${response.status})`
    throw new ApiError(payload.error || fallback, response.status)
  }
  return payload as T
}
