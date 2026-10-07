import { expect, test } from './fixtures'

test('status sinkronisasi menampilkan kegagalan LMS, menyimpan hitungan terakhir, lalu pulih saat retry berhasil', async ({ page }) => {
  let syncAttempts = 0
  let history: Array<Record<string, unknown>> = []
  const lastCounts = [{ key: 'last_master_sync_counts', value: 'siswa=12, kelas=2, tutor=1, mapel=3, akun=4', updatedAt: '2026-10-03T01:00:00Z' }]
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'admin-session', user: { id: 'admin-1', username: 'admin', nama: 'Admin CBT', role: 'admin' } })
    if (path === '/staff/sync/status' && method === 'GET') return json(lastCounts)
    if (path === '/staff/sync/history' && method === 'GET') return json(history)
    if (path === '/staff/sync/run' && method === 'POST') {
      syncAttempts++
      const failure = syncAttempts === 1 ? 'configuration' : syncAttempts === 2 ? 'gateway' : ''
      const failed = Boolean(failure)
      const message = failure === 'configuration'
        ? 'Endpoint integrasi LMS belum siap (HTTP 503). Periksa CBT_INTEGRATION_KEY_ID dan CBT_INTEGRATION_HMAC_SECRET di environment LMS, lalu lihat log LMS; data terakhir tetap digunakan.'
        : failure === 'gateway'
          ? 'Gateway gagal menghubungi LMS (HTTP 502). Periksa LMS_BASE_URL, domain/port di Coolify, dan log backend LMS; data terakhir tetap digunakan.'
          : 'Batch sinkronisasi berhasil: 12 siswa, 2 kelas, 1 tutor, 3 mapel, 4 akun diperbarui.'
      history = [{
        id: `run-${syncAttempts}`, status: failed ? 'failed' : 'success', trigger: 'manual',
        startedAt: '2026-10-03T01:01:00Z', finishedAt: '2026-10-03T01:01:02Z',
        accounts: 4, classes: 2, students: 12, tutors: 1, subjects: 3,
        message,
      }, ...history]
      if (failure === 'configuration') return json({ error: message }, 503)
      if (failure === 'gateway') return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' })
      return json({ status: 'ok' })
    }
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('admin')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Sinkronisasi' }).click()
  await page.getByRole('button', { name: 'Sinkronkan sekarang' }).click()
  await expect(page.getByRole('alert')).toContainText('CBT_INTEGRATION_KEY_ID dan CBT_INTEGRATION_HMAC_SECRET')
  await expect(page.getByText('Sinkronisasi terakhir gagal')).toBeVisible()
  await expect(page.getByText('siswa=12, kelas=2, tutor=1, mapel=3, akun=4')).toBeVisible()
  await page.getByRole('button', { name: 'Sinkronkan sekarang' }).click()
  await expect(page.getByRole('alert')).toContainText('Layanan CBT atau LMS sementara tidak tersedia (HTTP 502). Periksa LMS_BASE_URL dan status aplikasi di Coolify.')
  await page.getByRole('button', { name: 'Sinkronkan sekarang' }).click()
  await expect(page.getByRole('alert')).toContainText('Sinkronisasi selesai; data master dan waktu pembaruan sudah dicatat.')
  await expect(page.getByText('Sinkronisasi terakhir berhasil')).toBeVisible()
})
