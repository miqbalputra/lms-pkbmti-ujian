import { test, expect } from '@playwright/test'
import { SessionMediaCache } from '../src/studentUx'

test('media privat digunakan ulang hanya dalam sesi dan seluruh URL dicabut saat sesi berakhir', async () => {
  const fetchOriginal = globalThis.fetch, createOriginal = URL.createObjectURL, revokeOriginal = URL.revokeObjectURL
  const requests: RequestInit[] = [], revoked: string[] = []
  let created = 0
  const cache = new SessionMediaCache()
  globalThis.fetch = async (_url, options) => { requests.push(options!); return new Response(new Blob(['image'], { type: 'image/png' })) }
  URL.createObjectURL = () => `blob:private-${++created}`
  URL.revokeObjectURL = url => { revoked.push(url) }
  try {
    const first = cache.load('image-id', 'first-session'), second = cache.load('image-id', 'first-session')
    expect(first).toBe(second)
    expect(await first).toBe('blob:private-1')
    expect(requests).toHaveLength(1)
    expect(requests[0].cache).toBe('no-store')
    expect(requests[0].headers).toEqual({ Authorization: 'Bearer first-session' })
    cache.clear()
    expect(revoked).toEqual(['blob:private-1'])
    expect(await cache.load('image-id', 'second-session')).toBe('blob:private-2')
    expect(requests).toHaveLength(2)
    expect(requests[1].headers).toEqual({ Authorization: 'Bearer second-session' })
    cache.clear()
    expect(revoked).toEqual(['blob:private-1', 'blob:private-2'])
  } finally {
    cache.clear(); globalThis.fetch = fetchOriginal; URL.createObjectURL = createOriginal; URL.revokeObjectURL = revokeOriginal
  }
})

test('media yang selesai dimuat setelah sesi berakhir tidak membuat URL privat baru', async () => {
  const fetchOriginal = globalThis.fetch, createOriginal = URL.createObjectURL
  let respond!: (response: Response) => void, created = 0
  const cache = new SessionMediaCache()
  globalThis.fetch = () => new Promise(resolve => { respond = resolve })
  URL.createObjectURL = () => `blob:private-${++created}`
  try {
    const pending = cache.load('image-id', 'old-session')
    // Even a transport that ignores abort cannot repopulate the next session.
    cache.clear()
    respond(new Response(new Blob(['image'], { type: 'image/png' })))
    await expect(pending).rejects.toThrow('Sesi media telah berakhir.')
    expect(created).toBe(0)
  } finally {
    cache.clear(); globalThis.fetch = fetchOriginal; URL.createObjectURL = createOriginal
  }
})
