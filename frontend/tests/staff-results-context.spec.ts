import { expect, test } from './fixtures'

test('halaman Hasil menyediakan filter siswa/kelas/status/tanggal dan mengunduh laporan sesuai filter', async ({ page }) => {
  let exportedURL = ''
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown) => route.fulfill({ status: 200, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/assessments' && method === 'GET') return json([{ id: 'assessment-1', title: 'Kuis kelas', kind: 'ujian_online', status: 'published', durationMinute: 30 }])
    if (path === '/staff/master/classes' && method === 'GET') return json([{ id: 'class-a', nama: 'Paket A', jenjang: 1 }, { id: 'class-b', nama: 'Paket B', jenjang: 2 }])
    if (path === '/staff/assessments/assessment-1/results' && method === 'GET') return json([
      { id: 'attempt-1', assessmentId: 'assessment-1', studentId: 'student-1', studentName: 'Siswa Satu', classIdAtAttempt: 'class-a', number: 1, status: 'completed', score: 90, startedAt: '2026-10-03T01:00:00Z', submittedAt: '2026-10-03T01:30:00Z' },
      { id: 'attempt-2', assessmentId: 'assessment-1', studentId: 'student-2', studentName: 'Siswa Dua', classIdAtAttempt: 'class-b', number: 1, status: 'pending_grade', score: 40, needsManual: true, startedAt: '2026-10-02T01:00:00Z' },
    ])
    if (path.startsWith('/staff/assessments/assessment-1/results/export.')) {
      exportedURL = request.url()
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="hasil.xlsx"' }, body: 'report' })
    }
    if (path === '/staff/assessments/assessment-1/item-analysis' && method === 'GET') return json({ attemptCount: 2, completedAttemptCount: 1, items: [] })
    if (path === '/staff/recoveries' && method === 'GET') return json([])
    return json({ error: `Unmocked request: ${method} ${path}` })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Hasil' }).click()
  await expect(page.getByRole('heading', { name: 'Hasil asesmen' })).toBeVisible()
  await expect(page.getByText(/Lengkapi judul, kelas, soal, peserta, dan kode akses sebelum menerbitkan/)).toHaveCount(0)
  await page.getByLabel('Pilih asesmen').selectOption('assessment-1')
  await page.getByRole('combobox').nth(1).selectOption('class-a')
  await page.getByRole('combobox').nth(2).selectOption('student-1')
  await page.getByRole('combobox').nth(3).selectOption('completed')
  await page.getByLabel('Dari tanggal').fill('2026-10-03')
  await expect(page.getByText('Menampilkan 1 dari 2 percobaan.')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Siswa Satu' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Siswa Dua' })).toHaveCount(0)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Unduh XLSX' }).click()
  await download
  expect(exportedURL).toContain('classId=class-a')
  expect(exportedURL).toContain('studentId=student-1')
  expect(exportedURL).toContain('status=completed')
  expect(exportedURL).toContain('from=2026-10-02T17%3A00%3A00.000Z')
})
