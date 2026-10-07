import { expect, test } from './fixtures'

test('paket soal menyimpan butir dan target serta membuka URL detail, edit, dan penugasan langsung', async ({ page }) => {
  const reactInputWarnings: string[] = []
  page.on('console', (message) => { if (message.type() === 'error' && /controlled input to be uncontrolled/.test(message.text())) reactInputWarnings.push(message.text()) })
  const questionRows: Array<{ id: string; title: string; type: string; prompt: string; description: string; configJson: string; points: number; status: string; subject: string; revision: number; packageId?: string; packagePosition?: number }> = [
    { id: 'question-1', title: 'Operasi pecahan', type: 'pg_tunggal', prompt: 'Hitung 1/2 + 1/4', description: '', configJson: JSON.stringify({ choices: [{ id: 'a', text: 'Pilihan A' }, { id: 'b', text: 'Pilihan B' }] }), points: 2, status: 'draft', subject: 'Matematika', revision: 1 },
    { id: 'question-2', title: 'Panjang sisi', type: 'isian_singkat', prompt: 'Berapa cm?', description: '', configJson: '{}', points: 1, status: 'draft', subject: 'Matematika', revision: 1 },
  ]
  let questions = questionRows.map((row) => ({ ...row }))
  let packageRow = { id: 'package-1', ownerId: 'teacher-1', title: 'Paket Matematika', description: 'Latihan pecahan', subject: 'Matematika', status: 'draft', createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-01T08:00:00Z' }
  let assignments: Array<{ id: string; packageId: string; targetType: 'class' | 'student'; targetId: string; classId?: string; studentId?: string }> = []
  let listQuery = ''
  let draftPayload: Record<string, unknown> | null = null
  const detail = () => ({ ...packageRow, questions: questions.filter((row) => row.packageId === packageRow.id).sort((a, b) => (a.packagePosition || 0) - (b.packagePosition || 0)), assignments })
  const summary = () => ({ ...packageRow, questionCount: questions.filter((row) => row.packageId === packageRow.id).length, assignmentCount: assignments.length, classIds: assignments.filter((row) => row.targetType === 'class').map((row) => row.targetId), studentIds: assignments.filter((row) => row.targetType === 'student').map((row) => row.targetId) })

  await page.context().route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/master/classes' && method === 'GET') return json([{ id: 'class-10', nama: 'Kelas 10-A', jenjang: 10 }])
    if (path === '/staff/master/students' && method === 'GET') return json([{ id: 'student-1', nama: 'Siswa Satu', nisn: '001', kelasId: 'class-10' }])
    if (path === '/staff/assessments' && method === 'GET') return json([])
    if (path === '/staff/assessments/drafts' && method === 'POST') {
      draftPayload = request.postDataJSON() as Record<string, unknown>
      const body = draftPayload as { title: string; kind: string; classId: string }
      return json({ assessment: { id: 'assessment-from-package', title: body.title, kind: body.kind, classId: body.classId, status: 'draft', revision: 1, durationMinute: 60 } }, 201)
    }
    if (path === '/staff/assessments/assessment-from-package' && method === 'GET') {
      const payload = draftPayload as { title: string; kind: string; classId: string }
      return json({ assessment: { id: 'assessment-from-package', title: payload.title, kind: payload.kind, classId: payload.classId, status: 'draft', revision: 1, durationMinute: 60 }, items: [{ questionId: 'question-1', position: 1 }, { questionId: 'question-2', position: 2 }], assignments: [] })
    }
    if (path === '/staff/question-packages' && method === 'GET') { listQuery = url.search; return json([summary()]) }
    if (path === '/staff/question-packages' && method === 'POST') {
      packageRow = { ...packageRow, id: 'package-2', title: 'Paket soal tanpa judul', description: '', subject: '', status: 'draft' }
      assignments = []
      return json(packageRow, 201)
    }
    if (path === `/staff/question-packages/${packageRow.id}` && method === 'GET') return json(detail())
    if (path === `/staff/question-packages/${packageRow.id}` && method === 'PUT') {
      const body = request.postDataJSON() as { title: string; description: string; subject: string; questionIds: string[] }
      packageRow = { ...packageRow, ...body, updatedAt: new Date().toISOString() }
      questions = questions.map((row) => body.questionIds.includes(row.id) ? { ...row, packageId: packageRow.id, packagePosition: body.questionIds.indexOf(row.id) + 1 } : row.packageId === packageRow.id ? { ...row, packageId: undefined, packagePosition: 0 } : row)
      return json(packageRow)
    }
    if (path === `/staff/question-packages/${packageRow.id}/assignments` && method === 'PUT') {
      const body = request.postDataJSON() as { classIds: string[]; studentIds: string[] }
      assignments = [...body.classIds.map((id) => ({ id: `assign-${id}`, packageId: packageRow.id, targetType: 'class' as const, targetId: id, classId: id })), ...body.studentIds.map((id) => ({ id: `assign-${id}`, packageId: packageRow.id, targetType: 'student' as const, targetId: id, studentId: id }))]
      return json(detail())
    }
    if (path === '/staff/questions' && method === 'GET') return json(questions)
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/soal?tab=published&kelas=class-10&mapel=Matematika&dari=2026-10-01&sampai=2026-10-31')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()

  await expect(page.getByRole('heading', { name: 'Paket Soal' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Paket Matematika' })).toBeVisible()
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport)
    const metrics = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }))
    expect(metrics.scrollWidth, `package list overflows at ${viewport.width}px`).toBeLessThanOrEqual(metrics.width)
  }
  expect(listQuery).toContain('tab=published')
  const parsedQuery = new URLSearchParams(listQuery)
  expect(parsedQuery.get('classId')).toBe('class-10')
  expect(parsedQuery.get('subject')).toBe('Matematika')
  expect(parsedQuery.get('createdFrom')).toBe('2026-10-01')

  await page.getByRole('link', { name: 'Paket Matematika' }).click()
  await expect(page).toHaveURL(/\/soal\/paket\/package-1$/)
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport)
    const metrics = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }))
    expect(metrics.scrollWidth, `package detail overflows at ${viewport.width}px`).toBeLessThanOrEqual(metrics.width)
  }
  await page.getByRole('link', { name: 'Edit' }).click()
  await expect(page).toHaveURL(/\/soal\/paket\/package-1\/edit$/)
  await page.getByRole('button', { name: /Operasi pecahan/ }).click()
  await page.getByRole('button', { name: /Panjang sisi/ }).click()
  await page.getByRole('button', { name: 'Simpan paket dan urutan' }).click()
  await expect(page).toHaveURL(/\/soal\/paket\/package-1$/)
  await expect(page.getByText('2 butir')).toBeVisible()

  await page.goto('/soal/paket/package-1/penugasan')
  await expect(page.getByRole('heading', { name: 'Atur kelas atau siswa' })).toBeVisible()
  await page.getByRole('checkbox', { name: /Kelas 10-A/ }).check()
  await page.getByRole('button', { name: 'Simpan target penugasan' }).click()
  await expect(page.getByText('Target penugasan paket berhasil disimpan.')).toBeVisible()
  await page.goto('/soal/paket/package-1')
  await expect(page.getByText('Kelas 10-A')).toBeVisible()
  await expect(page.getByText('2 butir')).toBeVisible()

  const previewTabPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Pratinjau di tab baru' }).first().click()
  const previewTab = await previewTabPromise
  await expect(previewTab).toHaveURL(/\/soal\/paket\/package-1\/preview\/question-1$/)
  await expect(previewTab.getByText('Pratinjau tampilan siswa')).toBeVisible()
  await expect(previewTab.getByText('Pilihan A')).toBeVisible()
  await previewTab.close()

  await page.evaluate(() => {
    localStorage.setItem('cbt-builder-draft-teacher-1', 'assessment-old')
    localStorage.setItem('cbt-builder-draft-teacher-1-local', JSON.stringify({ title: 'Draf lama belum sinkron', classId: 'class-10', items: [], studentIds: [] }))
  })

  await page.getByRole('link', { name: 'Buat Ujian Online' }).click()
  await expect(page).toHaveURL(/\/ujian$/)
  await expect(page.getByLabel('Judul asesmen')).toHaveValue('Paket Matematika')
  await expect(page.locator('body')).not.toContainText('Ada perubahan lokal yang belum tersinkron pada draf sebelumnya')
  expect(((draftPayload?.items || []) as Array<{ questionId: string }>).map((item) => item.questionId)).toEqual(['question-1', 'question-2'])
  expect(draftPayload?.classId).toBe('class-10')
  const localDrafts = await page.evaluate(() => ({
    active: localStorage.getItem('cbt-builder-draft-teacher-1'),
    previous: localStorage.getItem('cbt-builder-draft-teacher-1-local-assessment-old'),
    legacy: localStorage.getItem('cbt-builder-draft-teacher-1-local'),
  }))
  expect(localDrafts.active).toBe('assessment-from-package')
  expect(localDrafts.previous).toContain('Draf lama belum sinkron')
  expect(localDrafts.legacy).toBeNull()
  expect(reactInputWarnings, 'draft restoration must keep every form field controlled').toEqual([])

  await page.goto('/soal?tab=all')
  await page.getByRole('button', { name: 'Buat paket soal' }).click()
  await expect(page).toHaveURL(/\/soal\/paket\/package-2\/edit$/)
  await expect(page.getByLabel('Judul paket')).toHaveValue('Paket soal tanpa judul')
})
