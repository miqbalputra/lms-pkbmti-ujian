import { expect, test } from './fixtures'

test('tutor melihat analisis tingkat keberhasilan, daya beda, dan pengecoh per soal', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown) => route.fulfill({ status: 200, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/assessments' && method === 'GET') return json([{ id: 'assessment-1', title: 'Uji literasi', status: 'published', kind: 'ujian_online' }])
    if (path === '/staff/assessments/assessment-1/results' && method === 'GET') return json([])
    if (path === '/staff/assessments/assessment-1/item-analysis' && method === 'GET') return json({
      assessmentId: 'assessment-1', attemptCount: 12, completedAttemptCount: 12,
      items: [{
        questionId: 'q-1', position: 1, title: 'Informasi jadwal', prompt: 'Pukul berapa kegiatan dimulai?', type: 'pg_tunggal', weight: 2,
        attemptCount: 12, answeredCount: 12, correctRate: 0.75, difficultyIndex: 0.75, difficultyBand: 'mudah', meanScore: 1.5,
        discrimination: 0.35, needsRevision: true, reason: 'terdapat pengecoh yang jarang dipilih', manual: false,
        distractors: [{ id: 'b', text: '07.00', selectedCount: 1, selectionRate: 0.083, nonFunctioning: false }, { id: 'c', text: '10.00', selectedCount: 0, selectionRate: 0, nonFunctioning: true }],
      }],
    })
    if (path === '/staff/recoveries' && method === 'GET') return json([])
    return route.fulfill({ status: 500, json: { error: `Unmocked request: ${method} ${path}` } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Hasil' }).click()
  await page.getByLabel('Pilih asesmen').selectOption('assessment-1')
  await expect(page.getByRole('heading', { name: 'Tingkat keberhasilan dan daya beda' })).toBeVisible()
  await expect(page.getByText('Perlu ditelaah')).toBeVisible()
  await expect(page.getByText('0.35')).toBeVisible()
  await page.getByText('Lihat pemakaian opsi pengecoh').click()
  await expect(page.getByText('10.00')).toBeVisible()
  await expect(page.getByText('Pengecoh jarang dipilih')).toBeVisible()
})
