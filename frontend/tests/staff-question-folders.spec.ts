import { expect, test } from '@playwright/test'

test('tutor membuat folder mapel/topik, memindahkan soal, lalu menyaring folder dan tag', async ({ page }) => {
  const folder = { id: 'folder-math', ownerId: 'teacher-1', name: 'Pecahan', subject: 'Matematika', parentId: '' }
  const questions = [
    { id: 'q-math', revision: 1, title: 'Tambah pecahan', type: 'pg_tunggal', prompt: 'Berapakah 1/2 + 1/4?', points: 2, status: 'draft', tags: 'numerasi, pecahan', folderId: '' },
    { id: 'q-read', revision: 1, title: 'Gagasan bacaan', type: 'uraian', prompt: 'Apa gagasan utamanya?', points: 3, status: 'draft', tags: 'literasi', folderId: '' },
  ]
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json(questions)
    if (path === '/staff/question-folders' && method === 'GET') return json(folder.id ? [folder] : [])
    if (path === '/staff/question-folders' && method === 'POST') { Object.assign(folder, request.postDataJSON(), { id: 'folder-math', ownerId: 'teacher-1' }); return json(folder, 201) }
    if (path === '/staff/questions/q-math/folder' && method === 'PUT') { const body = request.postDataJSON() as { folderId: string }; questions[0].folderId = body.folderId; questions[0].revision += 1; return json(questions[0]) }
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Bank Soal' }).click()
  await page.getByRole('link', { name: 'Pustaka soal lepas' }).click()
  await page.getByText('Kelola folder mapel dan topik').click()
  await page.getByLabel('Nama mapel').fill('Matematika')
  await page.getByLabel('Nama folder/topik').fill('Pecahan')
  await page.getByRole('button', { name: 'Buat folder' }).click()
  await expect(page.getByText('Folder soal berhasil dibuat.')).toBeVisible()
  await page.getByLabel('Pindahkan folder untuk Tambah pecahan').selectOption('folder-math')
  await expect(page.getByText('Soal “Tambah pecahan” dipindahkan ke folder.')).toBeVisible()
  await page.getByLabel('Filter folder').selectOption('folder-math')
  await expect(page.getByRole('heading', { name: 'Tambah pecahan' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Gagasan bacaan' })).toHaveCount(0)
  await page.getByLabel('Filter tag').selectOption('pecahan')
  await expect(page.getByRole('heading', { name: 'Tambah pecahan' })).toBeVisible()
  await page.getByLabel('Filter tag').selectOption('numerasi')
  await expect(page.getByRole('heading', { name: 'Tambah pecahan' })).toBeVisible()
})

test('tutor menemukan satu soal spesifik di pustaka 500 soal dengan filter metadata', async ({ page }) => {
  const questions = Array.from({ length: 500 }, (_, index) => ({
    id: `q-${index}`,
    revision: 1,
    title: index === 499 ? 'Target: luas persegi panjang' : `Soal latihan ${index + 1}`,
    type: index === 499 ? 'pg_tunggal' : index % 2 ? 'pg_tunggal' : 'uraian',
    prompt: index === 499 ? 'Hitung luas persegi panjang pada diagram.' : `Pertanyaan latihan nomor ${index + 1}.`,
    points: 2,
    status: 'draft',
    subject: index === 499 ? 'Matematika' : index % 2 ? 'Bahasa Indonesia' : 'IPA',
    grade: index === 499 ? 6 : index % 6 + 1,
    difficulty: index === 499 ? 'mudah' : 'sedang',
    tags: index === 499 ? 'numerasi, luas bangun' : index % 2 ? 'literasi' : 'latihan',
    usedCount: index === 499 ? 4 : index % 4,
    updatedAt: new Date(2026, 0, 1 + index).toISOString(),
  }))
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown) => route.fulfill({ status: 200, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json(questions)
    if (path === '/staff/question-folders' && method === 'GET') return json([])
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    return route.fulfill({ status: 500, json: { error: `Unmocked request: ${method} ${path}` } })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Bank Soal' }).click()
  await page.getByRole('link', { name: 'Pustaka soal lepas' }).click()
  const started = Date.now()
  await page.getByLabel('Cari soal').fill('Target: luas persegi panjang')
  await expect(page.getByRole('heading', { name: 'Target: luas persegi panjang' })).toBeVisible()
  expect(Date.now() - started).toBeLessThan(30_000)
  await page.getByLabel('Cari soal').fill('')
  await page.getByLabel('Filter jenis soal').selectOption('pg_tunggal')
  await page.getByLabel('Filter mapel').selectOption('Matematika')
  await page.getByLabel('Filter kelas').selectOption('6')
  await page.getByLabel('Filter tag').selectOption('luas bangun')
  await page.getByLabel('Filter kesukaran').selectOption('mudah')
  await expect(page.getByRole('heading', { name: 'Target: luas persegi panjang' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Soal latihan 499' })).toHaveCount(0)
  await page.getByLabel('Urutkan soal').selectOption('used')
  await expect(page.getByText('4 asesmen')).toBeVisible()
})
