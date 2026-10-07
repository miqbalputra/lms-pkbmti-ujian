import { expect, test } from './fixtures'

const teacher = { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' }
const templatePackage = { id: 'template-draft-1', ownerId: teacher.id, kind: 'ujian_online', title: 'Draf — Ujian Semester', description: '40 pilihan ganda + 5 esai · 90 menit', classId: '', subjectId: '', status: 'draft', durationMinute: 90, revision: 1 }

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
}

test('tutor membuat draf semester dari template dengan semua placeholder aman dalam kurang dari dua menit', async ({ page }) => {
  let created: typeof templatePackage | null = null
  const questions = Array.from({ length: 45 }, (_, index) => ({
    id: `template-question-${index + 1}`, revision: 1,
    title: `Contoh soal ${index + 1} — ganti sebelum digunakan`,
    type: index < 40 ? 'pg_tunggal' : 'uraian',
    prompt: `Tulis pertanyaan ${index < 40 ? 'pilihan ganda' : 'uraian'} ke-${index + 1} di sini.`,
    description: 'Soal contoh dari template. Ganti dengan materi dan pertanyaan yang sesuai sebelum asesmen diterbitkan.',
    configJson: JSON.stringify(index < 40 ? { choices: [{ id: 'pilihan-a', text: 'Pilihan A (ubah)' }, { id: 'pilihan-b', text: 'Pilihan B (ubah)' }], correctIds: [] } : { rubrik: [], textMinLength: 0, textMaxLength: 5000 }),
    answerJson: '[]', rubricJson: '[]', points: index < 40 ? 1 : 10,
    status: 'draft', templatePlaceholder: true,
  }))
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: teacher })
    if (path === '/staff/questions' && method === 'GET') return json(questions)
    if (path === '/staff/assessments' && method === 'GET') return json(created ? [created] : [])
    if (path === '/staff/master/classes' && method === 'GET') return json([])
    if (path === '/staff/master/students' && method === 'GET') return json([])
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/assessment-templates/semester-40-pg-5-esai/draft' && method === 'POST') {
      created = templatePackage
      return json({ assessment: created, questionCount: 45 }, 201)
    }
    if (path === `/staff/questions/${questions[0].id}` && method === 'PUT') {
      const body = request.postDataJSON() as { prompt: string }
      return json({ ...questions[0], prompt: body.prompt, templatePlaceholder: false, revision: 2 })
    }
    if (path === `/staff/assessments/${templatePackage.id}` && method === 'GET') return json({ assessment: created, items: questions.map((question, index) => ({ questionId: question.id, position: index + 1, weight: question.points })), assignments: [] })
    if (path === `/staff/assessments/${templatePackage.id}/draft` && method === 'PUT') return json({ assessment: { ...created, revision: 2 } })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  const startedAt = Date.now()
  await signIn(page)
  await page.getByText('Mulai lebih cepat dengan template (opsional)').click()
  const templateCard = page.getByRole('article').filter({ hasText: 'Ujian Semester' })
  await expect(templateCard).toContainText('40 pilihan ganda + 5 esai · 90 menit')
  await templateCard.getByRole('button', { name: 'Buat draf' }).click()
  await expect(page.getByText('Draf — Ujian Semester', { exact: true })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'template' })).toContainText('45')
  await expect(page.getByText('45 soal', { exact: true })).toBeVisible()
  await expect(page.getByText('Contoh', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Edit soal' }).first().click()
  await page.getByRole('textbox', { name: 'Pertanyaan', exact: true }).fill('Tuliskan soal yang sesuai dengan pelajaran hari ini.')
  await page.getByRole('button', { name: 'Simpan perubahan' }).click()
  await expect(page.getByRole('alert')).toContainText('Soal contoh diperbarui')
  await expect(page.getByRole('listitem').filter({ hasText: 'template' })).toContainText('44')
  expect(Date.now() - startedAt).toBeLessThan(120_000)
})

test('tutor menduplikasi asesmen menjadi draf aman yang meminta kelas dan kode baru', async ({ page }) => {
  const source = { id: 'published-1', title: 'Ujian Matematika', kind: 'ujian_online', classId: 'class-old', subjectId: 'Matematika', status: 'published', durationMinute: 60, revision: 2, accessCodeConfigured: true }
  const duplicate = { ...source, id: 'duplicate-1', title: 'Salinan draf — Ujian Matematika', classId: '', status: 'draft', revision: 1, accessCodeConfigured: false }
  const question = { id: 'copy-q1', title: 'Soal salinan', type: 'pg_tunggal', prompt: 'Berapa 2 + 2?', description: '', configJson: JSON.stringify({ choices: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }], correctIds: ['a'] }), answerJson: '"a"', rubricJson: '[]', points: 1, status: 'draft' }
  let copied = false
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: teacher })
    if (path === '/staff/questions' && method === 'GET') return json(copied ? [question] : [])
    if (path === '/staff/assessments' && method === 'GET') return json(copied ? [duplicate] : [source])
    if (path === '/staff/master/classes' && method === 'GET') return json([{ id: 'class-new', nama: 'Paket B - Kelas 7', jenjang: 2 }])
    if (path === '/staff/master/students' && method === 'GET') return json([])
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/assessments/published-1/duplicate' && method === 'POST') { copied = true; return json({ assessment: duplicate }, 201) }
    if (path === '/staff/assessments/duplicate-1' && method === 'GET') return json({ assessment: duplicate, items: [{ questionId: question.id, position: 1, weight: 1 }], assignments: [] })
    if (path === '/staff/assessments/duplicate-1/draft' && method === 'PUT') return json({ assessment: { ...duplicate, revision: 2 } })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await signIn(page)
  await page.getByRole('button', { name: 'Duplikasi' }).click()
  await expect(page.getByText('Salinan draf — Ujian Matematika', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Kelas peserta')).toHaveValue('')
  await expect(page.getByLabel('Kode akses siswa')).toHaveValue('')
  await expect(page.getByRole('button', { name: /^Soal salinan/ })).toBeVisible()
})
