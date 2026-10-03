import { expect, test } from '@playwright/test'

test('soal terbit dibuat revisinya sebagai draf tanpa mengubah sumber', async ({ page }) => {
  const published = { id: 'question-published', title: 'Soal terbit', type: 'pg_tunggal', prompt: 'Pertanyaan asli yang sudah dipakai.', points: 2, status: 'published', revision: 4, ownerId: 'teacher-1', configJson: JSON.stringify({ choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctIds: ['a'] }), answerJson: '"a"', rubricJson: '[]' }
  let questions = [published]
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json(questions)
    if (path === '/staff/questions/question-published/revision' && method === 'POST') {
      const revision = { ...published, id: 'question-revision', title: 'Soal terbit (revisi)', status: 'draft', revision: 1 }
      questions = [published, revision]
      return json(revision, 201)
    }
    if (path === '/staff/questions/question-revision' && method === 'PUT') {
      const body = request.postDataJSON() as Record<string, unknown>
      const revision = { ...questions[1], ...body, id: 'question-revision', status: 'draft' }
      questions = [published, revision]
      return json(revision)
    }
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
  await expect(page.getByText('Soal terbit', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Buat revisi', exact: true }).click()
  await expect(page.getByLabel('Judul soal (opsional)')).toHaveValue('Soal terbit (revisi)')
  await page.getByLabel('Pertanyaan').fill('Pertanyaan baru khusus untuk paket mendatang.')
  await page.getByRole('button', { name: 'Simpan perubahan' }).click()
  await expect(page.getByText('Perubahan soal tersimpan.')).toBeVisible()
  await expect(page.getByText('Pertanyaan asli yang sudah dipakai.')).toBeVisible()
  await expect(page.getByText('Pertanyaan baru khusus untuk paket mendatang.')).toBeVisible()
})
