import { expect, navigateStaff, test } from './fixtures'

test('staff can inspect class schedule and a live participant monitor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  let monitorReads = 0
  const schedule = [
    { id: 'exam-a', title: 'Ujian Paket A', kind: 'ujian_online', classId: 'class-a', room: 'Lab Komputer', status: 'published', durationMinute: 60, startsAt: '2026-10-03T02:00:00Z', endsAt: '2026-10-03T03:00:00Z' },
  ]
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && request.method() === 'POST') return json({ accessToken: 'admin-session', user: { id: 'admin-1', username: 'admin', nama: 'Admin CBT', role: 'admin' } })
    if (path === '/staff/schedule') return json(schedule)
    if (path === '/staff/master/classes') return json([{ id: 'class-a', nama: 'Paket A 6', jenjang: 1 }])
    if (path === '/staff/assessments') return json(schedule)
    if (path === '/staff/assessments/exam-a/monitor') {
      monitorReads++
      const firstStudentStatus = monitorReads > 1 ? 'selesai' : 'mengerjakan'
      return json({
        assessmentId: 'exam-a', title: 'Ujian Paket A', serverTime: '2026-10-03T02:20:00Z', refreshAfterSeconds: 15,
        counts: { belum_mulai: 1, mengerjakan: monitorReads > 1 ? 0 : 1, selesai: monitorReads > 1 ? 2 : 1 },
        participants: [
          { studentId: 'student-1', name: 'Siswa Satu', status: firstStudentStatus, attemptNumber: 1, remainingSeconds: 2400 },
          { studentId: 'student-2', name: 'Siswa Dua', status: 'selesai', attemptNumber: 1 },
          { studentId: 'student-3', name: 'Siswa Tiga', status: 'belum_mulai' },
        ],
      })
    }
    return json([])
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('admin')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()

  await navigateStaff(page, 'Jadwal')
  await expect(page.getByRole('heading', { name: 'Jadwal per kelas dan ruang' })).toBeVisible()
  await expect(page.getByText('Ujian Paket A')).toBeVisible()
  await expect(page.getByText('Paket A 6 · Lab Komputer · Ujian Online')).toBeVisible()

  await navigateStaff(page, 'Monitor live')
  await expect(page.getByRole('heading', { name: 'Monitor ujian live' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Siswa Satu', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Mengerjakan' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Selesai' })).toBeVisible()
  await expect.poll(() => monitorReads, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  await expect(page.getByRole('cell', { name: 'Selesai' })).toHaveCount(2)
  await page.getByRole('button', { name: 'Perbarui sekarang' }).click()
  await expect.poll(() => monitorReads).toBeGreaterThanOrEqual(3)
})
