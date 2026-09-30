export type Session = { accessToken: string; user: { id: string; username: string; nama: string; role: string; pesertaDidikId?: string } }
const storageKey = 'pkbm-cbt-session'
export const loadSession = (): Session | null => { try { const value = localStorage.getItem(storageKey); return value ? JSON.parse(value) as Session : null } catch { return null } }
export const saveSession = (session: Session | null) => { if (session) localStorage.setItem(storageKey, JSON.stringify(session)); else localStorage.removeItem(storageKey) }
export async function api<T>(path: string, init: RequestInit = {}, session = loadSession()): Promise<T> {
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (session?.accessToken) headers.set('Authorization', `Bearer ${session.accessToken}`)
  const response = await fetch(`/api${path}`, { ...init, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Permintaan gagal (${response.status})`)
  return payload as T
}
