import { expect, test } from '@playwright/test'

test('tutor dapat memulihkan daftar kelas dan siswa lewat sinkronisasi penuh dari builder', async ({ page }) => {
  let synced = false
  let requestedFullSync = false

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })

    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/assessments' && method === 'GET') return json([])
    if (path === '/staff/master/classes' && method === 'GET') return json(synced ? [{ id: 'class-1', nama: 'Paket A Kelas 1', jenjang: 1 }] : [])
    if (path === '/staff/master/students' && method === 'GET') return json(synced ? [{ id: 'student-1', nama: 'Siswa Satu', nisn: '1234567890', kelasId: 'class-1' }] : [])
    if (path === '/staff/sync/run' && method === 'POST') {
      requestedFullSync = true
      synced = true
      return json({ status: 'ok', syncRun: { status: 'success', classes: 1, students: 1, message: 'Rekonsiliasi penuh berhasil: 1 siswa, 1 kelas.' } })
    }
    if (path === '/staff/assessments/drafts' && method === 'POST') return json({ assessment: { id: 'draft-1', revision: 1, status: 'draft' } }, 201)
    if (path === '/staff/assessments/draft-1/draft' && method === 'PUT') return json({ id: 'draft-1', revision: 2, status: 'draft' })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
  await page.getByRole('button', { name: 'Buat formulir baru' }).click()

  await expect(page.getByText('Kelas dan siswa dari LMS belum tersedia di CBT')).toBeVisible()
  await page.getByRole('button', { name: 'Sinkronkan kelas & siswa' }).click()
  await expect(page.getByText('Kelas dan siswa dari LMS belum tersedia di CBT')).toHaveCount(0)
  await expect(page.getByLabel('Kelas peserta')).toContainText('Paket A Kelas 1')
  await expect.poll(() => requestedFullSync).toBe(true)
})
