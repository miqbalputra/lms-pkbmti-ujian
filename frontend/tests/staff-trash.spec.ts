import { expect, test } from '@playwright/test'

test('kepala sekolah dapat membaca bank soal tanpa kontrol perubahan', async ({ page }) => {
  const question = {
    id: 'question-1', title: 'Bacaan untuk ditinjau', type: 'pg_tunggal', prompt: 'Pertanyaan contoh', points: 2, status: 'draft',
    configJson: JSON.stringify({ choices: [{ id: 'a', text: 'Pilihan A' }, { id: 'b', text: 'Pilihan B' }] }),
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown) => route.fulfill({ status: 200, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'viewer-session', user: { id: 'viewer-1', username: 'kepsek', nama: 'Kepala Sekolah', role: 'kepala_sekolah' } })
    if (path === '/staff/questions' && method === 'GET') return json([question])
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    return json({ error: `Unmocked request: ${method} ${path}` })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('kepsek')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Bank Soal' }).click()
  await page.getByRole('link', { name: 'Pustaka soal lepas' }).click()
  await expect(page.getByText('Bacaan untuk ditinjau', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Buat soal' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Arsipkan' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Hapus' })).toHaveCount(0)
})

test('tutor dapat menghapus soal ke Trash dan memulihkannya', async ({ page }) => {
  let trashed = false
  let archived = false
  const question = {
    id: 'question-1', title: 'Bacaan tentang lingkungan', type: 'pg_tunggal',
    prompt: 'Apa gagasan utama bacaan?', points: 2, status: 'draft',
    configJson: JSON.stringify({ choices: [{ id: 'a', text: 'Menjaga lingkungan' }, { id: 'b', text: 'Pergi berlibur' }], correctIds: ['a'] }),
    answerJson: '"a"', rubricJson: '[]', stimulusJson: '',
  }

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })

    if (path === '/auth/login' && method === 'POST') return json({
      accessToken: 'staff-session',
      user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' },
    })
    if (path === '/staff/questions' && method === 'GET') return json(trashed || archived ? [] : [question])
    if (path === '/staff/questions/question-1' && method === 'DELETE') { archived = true; return route.fulfill({ status: 204 }) }
    if (path === '/staff/questions/question-1/trash' && method === 'POST') { trashed = true; return route.fulfill({ status: 204 }) }
    if (path === '/staff/questions/question-1/restore' && method === 'POST') { trashed = false; return route.fulfill({ status: 204 }) }
    if (path === '/staff/questions/question-1/unarchive' && method === 'POST') { archived = false; return route.fulfill({ status: 204 }) }
    if (path === '/staff/trash' && method === 'GET') return json({ questions: trashed ? [question] : [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: archived ? [question] : [], assessments: [] })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  page.on('dialog', (dialog) => dialog.accept())
  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Bank Soal' }).click()
  await page.getByRole('link', { name: 'Pustaka soal lepas' }).click()
  await expect(page.getByText('Bacaan tentang lingkungan', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Hapus', exact: true }).click()
  await expect(page.getByText('Soal “Bacaan tentang lingkungan” dipindahkan ke Trash.')).toBeVisible()
  await page.getByText('Arsip & Trash').click()
  await expect(page.getByText(/Soal: Bacaan tentang lingkungan/)).toBeVisible()
  await page.getByRole('button', { name: 'Pulihkan', exact: true }).click()
  await expect(page.getByText('Bacaan tentang lingkungan', { exact: true })).toBeVisible()
  await expect(page.getByText('Belum ada soal atau paket diarsipkan maupun dihapus.')).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Hapus soal', exact: true }).click()
  await expect(page.getByText('Soal “Bacaan tentang lingkungan” dipindahkan ke Trash.')).toBeVisible()
  await expect(page.getByText(/Soal: Bacaan tentang lingkungan/)).toBeVisible()
  await page.getByRole('button', { name: 'Pulihkan', exact: true }).click()
  await expect(page.getByText('Bacaan tentang lingkungan', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Arsipkan', exact: true }).click()
  await expect(page.getByText('Soal diarsipkan dan tidak akan dihapus dari riwayat paket.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keluarkan dari arsip', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Keluarkan dari arsip', exact: true }).click()
  await expect(page.getByText('Bacaan tentang lingkungan', { exact: true })).toBeVisible()
})

test('tutor dapat mengarsipkan dan memindahkan paket ke Trash, lalu memulihkannya', async ({ page }) => {
  let archived = false
  let trashed = false
  const assessment = { id: 'assessment-1', title: 'Ujian Paket A', kind: 'ujian_online', durationMinute: 60, status: 'draft', revision: 1 }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/assessments' && method === 'GET') return json(trashed ? [] : [{ ...assessment, status: archived ? 'archived' : 'draft' }])
    if (path === '/staff/master/classes' && method === 'GET') return json([])
    if (path === '/staff/master/students' && method === 'GET') return json([])
    if (path === '/staff/assessments/assessment-1/archive' && method === 'POST') { archived = true; return json({ ...assessment, status: 'archived' }) }
    if (path === '/staff/assessments/assessment-1/unarchive' && method === 'POST') { archived = false; return json({ ...assessment, status: 'draft' }) }
    if (path === '/staff/assessments/assessment-1/trash' && method === 'POST') { trashed = true; return route.fulfill({ status: 204 }) }
    if (path === '/staff/assessments/assessment-1/restore' && method === 'POST') { trashed = false; return route.fulfill({ status: 204 }) }
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: trashed ? [assessment] : [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: archived ? [{ ...assessment, status: 'archived' }] : [] })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  page.on('dialog', (dialog) => dialog.accept())
  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
  await expect(page.getByText('Ujian Paket A', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Arsipkan', exact: true }).click()
  await expect(page.getByText('Paket “Ujian Paket A” diarsipkan.')).toBeVisible()
  await page.getByRole('button', { name: 'Pulihkan arsip', exact: true }).click()
  await expect(page.getByText('Paket “Ujian Paket A” dikeluarkan dari arsip.')).toBeVisible()
  await page.getByRole('button', { name: 'Hapus', exact: true }).click()
  await expect(page.getByText('Paket “Ujian Paket A” dipindahkan ke Trash.')).toBeVisible()
  await page.getByRole('button', { name: 'Bank Soal' }).click()
  await page.getByRole('link', { name: 'Pustaka soal lepas' }).click()
  await page.getByText('Arsip & Trash').click()
  await expect(page.getByText(/Paket: Ujian Paket A/)).toBeVisible()
  await page.getByRole('button', { name: 'Pulihkan', exact: true }).click()
  await expect(page.getByText('Data berhasil dipulihkan dari Trash.')).toBeVisible()
})

test('soal yang dihapus dari kanvas builder masuk Trash bank soal', async ({ page }) => {
  let trashed = false
  const question = { id: 'question-1', title: 'Soal dari kanvas', type: 'pg_tunggal', prompt: 'Berapa hasil 2 + 2?', points: 1, status: 'draft', configJson: JSON.stringify({ choices: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }], correctIds: ['a'] }) }
  const assessment = { id: 'draft-1', title: 'Paket tanpa judul', kind: 'ujian_online', status: 'draft', durationMinute: 60, revision: 1 }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json(trashed ? [] : [question])
    if (path === '/staff/assessments' && method === 'GET') return json([])
    if (path === '/staff/master/classes' && method === 'GET') return json([])
    if (path === '/staff/master/students' && method === 'GET') return json([])
    if (path === '/staff/assessments/drafts' && method === 'POST') return json({ assessment }, 201)
    if (path === '/staff/assessments/draft-1/draft' && method === 'PUT') return json({ assessment: { ...assessment, revision: 2 } })
    if (path === '/staff/questions/question-1/trash' && method === 'POST') { trashed = true; return route.fulfill({ status: 204 }) }
    if (path === '/staff/trash' && method === 'GET') return json({ questions: trashed ? [question] : [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
  await page.getByRole('button', { name: 'Buat formulir baru' }).click()
  await page.getByRole('button', { name: /Soal dari kanvas/ }).click()
  await page.getByRole('button', { name: 'Hapus soal Soal dari kanvas ke Trash' }).click()
  await expect(page.getByText('Soal “Soal dari kanvas” dipindahkan ke Trash dan dikeluarkan dari draf ini.')).toBeVisible()
  await expect(page.getByText('Urutan soal').locator('..').getByText('Soal dari kanvas')).toHaveCount(0)
})
