import { expect, test } from './fixtures'

test('riwayat soal menampilkan versi dan rollback membuat revisi baru', async ({ page }) => {
  const question = { id: 'question-1', revision: 2, title: 'Soal draf', type: 'pg_tunggal', prompt: 'Versi saat ini', description: '', configJson: JSON.stringify({ choices: [{ id: 'a', text: 'Benar' }, { id: 'b', text: 'Salah' }], correctIds: ['a'] }), answerJson: '"a"', rubricJson: '[]', points: 2, status: 'draft' }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([question])
    if (path === '/staff/questions/question-1/history' && method === 'GET') return json({ currentRevision: 2, versions: [{ id: 'version-1', revision: 1, changedBy: 'teacher-1', createdAt: '2026-10-03T08:00:00Z' }] })
    if (path === '/staff/questions/question-1/restore/version-1' && method === 'POST') {
      const body = request.postDataJSON() as { revision: number }
      if (body.revision !== 2) return json({ error: 'revision tidak cocok' }, 409)
      return json({ ...question, revision: 3, prompt: 'Versi sebelumnya' })
    }
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
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
  await page.getByRole('button', { name: 'Riwayat versi' }).click()
  await expect(page.getByRole('dialog')).toContainText('Versi aktif 2')
  await expect(page.getByRole('dialog')).toContainText('Versi 1')
  await page.getByRole('button', { name: 'Pulihkan versi 1' }).click()
  await expect(page.getByRole('alert')).toContainText('revisi baru 3 tercatat')
  await expect(page.getByLabel('Pertanyaan')).toHaveValue('Versi sebelumnya')
})
