import { expect, test } from '@playwright/test'

test('tutor mengunduh template lalu mengimpor soal dengan laporan baris gagal', async ({ page }) => {
  let importRequestSeen = false
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown) => route.fulfill({ status: 200, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/questions/import/example-20' && method === 'GET') return route.fulfill({ status: 200, body: 'Judul,Jenis,Pertanyaan,Poin\n', headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="contoh-20-soal-cbt.csv"' } })
    if (path === '/staff/questions/import/template/csv' && method === 'GET') return route.fulfill({ status: 200, body: 'Judul,Jenis,Pertanyaan\n', headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="template-soal-cbt.csv"' } })
    if (path === '/staff/questions/import' && method === 'POST') {
      importRequestSeen = true
      return json({ imported: 2, failed: 1, errors: ['Baris 4: kunci jawaban wajib diisi'] })
    }
    return route.fulfill({ status: 500, json: { error: `Unmocked request: ${method} ${path}` } })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Bank Soal' }).click()
  await page.getByRole('link', { name: 'Pustaka soal lepas' }).click()
  await page.getByText('Impor soal dari CSV, Excel, atau Word').click()
  const examplePromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Unduh contoh 20 soal' }).click()
  const example = await examplePromise
  expect(example.suggestedFilename()).toBe('contoh-20-soal-cbt.csv')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Unduh template CSV' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('template-soal-cbt.csv')

  await page.getByLabel('Pilih file soal untuk diimpor').setInputFiles({ name: 'soal.csv', mimeType: 'text/csv', buffer: Buffer.from('Judul,Jenis,Pertanyaan\n') })
  await expect(page.getByText('Hasil impor: 2 berhasil · 1 gagal')).toBeVisible()
  await expect(page.getByText('Baris 4: kunci jawaban wajib diisi')).toBeVisible()
  expect(importRequestSeen).toBe(true)
})
