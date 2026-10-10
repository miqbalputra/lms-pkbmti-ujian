import { expect, test } from './fixtures'

test('admin mendapat pusat operasional dan dapat membuat akun CBT lokal tanpa mengambil alih akun LMS', async ({ page }) => {
  const accounts: Array<Record<string, unknown>> = [{ id: 'lms-user-1', sourceUserId: 'lms-1', username: 'tutor.lms', nama: 'Tutor LMS', role: 'guru', active: true }]
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api', '')
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/public/config') return json({ formsEnabled: true })
    if (path === '/auth/login' && request.method() === 'POST') return json({ accessToken: 'admin-session', user: { id: 'admin-1', username: 'admin', nama: 'Admin CBT', role: 'admin' } })
    if (path === '/staff/dashboard/summary') return json({ asOf: new Date().toISOString(), range: url.searchParams.get('range') || '7d', role: 'admin', periodStart: new Date().toISOString(), metrics: { activeStudents: 18, activeClasses: 3, activeAccounts: 5, activeAttempts: 2, pendingGrading: 1, undeliveredResults: 0, studentsMissingClass: 0, assessmentsDraft: 2, assessmentsPublished: 4 }, trends: [], operations: { syncStatus: 'success', syncAt: new Date().toISOString() }, actions: [] })
    if (path === '/admin/accounts' && request.method() === 'GET') return json(accounts)
    if (path === '/staff/master/students') return json([{ id: 'student-1', nama: 'Siswa Aktif', nisn: '0012345678', kelas: 'Paket A · Kelas 1', active: true }])
    if (path === '/admin/accounts' && request.method() === 'POST') {
      const input = request.postDataJSON() as Record<string, unknown>
      const account = { ...input, id: 'local-tutor-1', createdAt: new Date().toISOString() }
      accounts.push(account)
      return json(account, 201)
    }
    return json({ error: `Unmocked request: ${request.method()} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByRole('link', { name: 'Masuk tutor melalui LMS' }).click()
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('admin')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await expect(page.getByText('Pusat operasional', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Ringkasan angka' }).getByText('Siswa aktif', { exact: true })).toBeVisible()
  await expect(page.getByText('Status sinkronisasi LMS: Berhasil')).toBeVisible()

  await page.goto('/akun')
  await expect(page.getByRole('heading', { name: 'Manajemen akun' })).toBeVisible()
  await expect(page.getByText('Dikelola LMS', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Atur ulang sandi/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Buat akun' }).click()
  const form = page.locator('form').filter({ has: page.getByLabel('Nama lengkap') })
  await form.getByLabel('Nama lengkap').fill('Tutor Lokal')
  await form.getByLabel('Username').fill('tutor-lokal')
  await form.getByLabel('Peran').selectOption('guru')
  await form.getByLabel(/Kata sandi awal/).fill('password-kuat-123')
  await form.getByRole('button', { name: 'Simpan akun' }).click()
  await expect(page.getByRole('alert')).toContainText('berhasil dibuat')
  await expect(page.getByText('tutor-lokal', { exact: true })).toBeVisible()
})

test('kepala sekolah hanya melihat ringkasan dan tidak dapat membuka editor edit langsung', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/public/config') return json({ formsEnabled: true })
    if (path === '/auth/login' && request.method() === 'POST') return json({ accessToken: 'head-session', user: { id: 'head-1', username: 'kepala', nama: 'Kepala Sekolah', role: 'kepala_sekolah' } })
    if (path === '/staff/dashboard/summary') return json({ asOf: new Date().toISOString(), range: '7d', role: 'kepala_sekolah', periodStart: new Date().toISOString(), metrics: { assessmentsPublished: 4, activeAttempts: 2, submissionsInPeriod: 12, activeStudents: 18, activeClasses: 3 }, trends: [], operations: { syncStatus: 'success' }, actions: [] })
    return json({ error: `Unmocked request: ${request.method()} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByRole('link', { name: 'Masuk tutor melalui LMS' }).click()
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('kepala')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await expect(page.getByText('Ringkasan sekolah · baca-saja')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Buat Ujian Online' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sinkronisasi', exact: true })).toHaveCount(0)
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport)
    const metrics = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }))
    expect(metrics.scrollWidth, `dashboard overflows at ${viewport.width}px`).toBeLessThanOrEqual(metrics.width)
  }
  await page.goto('/editor/assessment/assessment-readonly')
  await expect(page.getByRole('heading', { name: 'Editor hanya untuk tutor' })).toBeVisible()
})
