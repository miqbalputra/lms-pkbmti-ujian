import { expect, test } from '@playwright/test'

test('seluruh 15 jenis soal dimulai dengan contoh pertanyaan yang bisa langsung diedit', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown) => route.fulfill({ status: 200, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/question-folders' && method === 'GET') return json([])
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
  await page.getByRole('button', { name: 'Buat soal' }).click()
  await page.getByRole('button', { name: 'Mulai sederhana' }).click()

  const type = page.getByLabel('Jenis soal', { exact: true })
  const prompt = page.getByLabel('Pertanyaan')
  const supportedTypes = [
    'pg_tunggal', 'pg_kompleks', 'dropdown', 'benar_salah', 'menjodohkan',
    'isian_singkat', 'uraian', 'susun_urutan', 'kisi_pg', 'kisi_checkbox',
    'skala_linear', 'rating', 'tanggal', 'waktu', 'unggah_berkas',
  ]

  for (const questionType of supportedTypes) {
    await type.selectOption(questionType)
    await expect(prompt).not.toHaveValue('')
    await expect(page.getByText('Contoh awal untuk tipe ini — ubah sesuai materi dan tujuan penilaianmu.')).toBeVisible()
  }

  await type.selectOption('pg_tunggal')
  await expect(page.getByLabel('Teks pilihan 1')).toHaveValue('42')
  await type.selectOption('uraian')
  await expect(page.getByLabel('Kriteria rubrik 1')).toHaveValue('Ketepatan jawaban')
  await expect(page.getByLabel('Kriteria rubrik 1').locator('..').getByLabel('Poin')).toHaveValue('5')
  await type.selectOption('isian_singkat')
  await expect(page.getByLabel('Jawaban yang diterima (satu jawaban per baris)')).toHaveValue('42')
})
