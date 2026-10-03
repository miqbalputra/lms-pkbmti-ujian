import { expect, test } from '@playwright/test'

test('pencarian Bank Soal menapis judul dan isi secara langsung', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown) => route.fulfill({ status: 200, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/question-folders' && method === 'GET') return json([])
    if (path === '/staff/questions' && method === 'GET') return json([
      { id: 'q-1', title: 'Siklus air', type: 'pg_tunggal', prompt: 'Bagaimana hujan terbentuk?', points: 2, status: 'draft' },
      { id: 'q-2', title: 'Kebun sekolah', type: 'uraian', prompt: 'Jelaskan cara merawat tanaman.', points: 5, status: 'draft' },
    ])
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    return json({ error: `Unmocked request: ${method} ${path}` })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Bank Soal' }).click()
  await page.getByRole('link', { name: 'Pustaka soal lepas' }).click()
  await expect(page.getByText('Siklus air', { exact: true })).toBeVisible()
  await page.getByLabel('Cari soal').fill('tanaman')
  await expect(page.getByText('Kebun sekolah', { exact: true })).toBeVisible()
  await expect(page.getByText('Siklus air', { exact: true })).toHaveCount(0)
  await page.getByLabel('Cari soal').fill('kata yang tidak ada')
  await expect(page.getByText('Tidak ada soal yang cocok dengan pencarian atau filter ini.')).toBeVisible()
})
