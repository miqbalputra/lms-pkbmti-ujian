import { expect, test } from './fixtures'

test('builder tidak menutupi identitas paket dan kontrol jadwal dapat dioperasikan pada desktop serta mobile', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/assessments' && method === 'GET') return json([])
    if (path === '/staff/master/classes' && method === 'GET') return json([{ id: 'class-1', nama: 'Paket A Kelas 1', jenjang: 1 }])
    if (path === '/staff/master/students' && method === 'GET') return json([])
    if (path === '/staff/assessments/drafts' && method === 'POST') return json({ assessment: { id: 'draft-1', revision: 1, status: 'draft' } }, 201)
    if (path === '/staff/assessments/draft-1/draft' && method === 'PUT') return json({ id: 'draft-1', revision: 2, status: 'draft' })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
  await page.getByText('Saya ingin mengatur semua detail dari awal').click()
  await page.getByRole('button', { name: /pengaturan lengkap/ }).click()
  await expect(page.getByRole('heading', { name: 'Identitas paket' })).toBeVisible()
  await page.getByRole('button', { name: 'Terbitkan asesmen' }).click()
  await expect(page.getByRole('alert')).toContainText('Belum dapat diterbitkan. Lengkapi dulu: judul asesmen, minimal satu soal, kode akses siswa.')

  const startDate = page.getByLabel('Tanggal mulai (opsional)')
  const startTime = page.getByLabel('Jam mulai (opsional)')
  const endDate = page.getByLabel('Tanggal selesai (opsional)')
  const endTime = page.getByLabel('Jam selesai (opsional)')
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => {
      const identity = [...document.querySelectorAll('h3')].find((node) => node.textContent?.trim() === 'Identitas paket')?.closest('section')
      const checklist = [...document.querySelectorAll('h3')].find((node) => node.textContent?.trim() === 'Checklist kesiapan')?.closest('section')
      if (!identity || !checklist) return null
      const a = identity.getBoundingClientRect()
      const b = checklist.getBoundingClientRect()
      const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, overlaps }
    })
    expect(layout).not.toBeNull()
    expect(layout?.scrollWidth).toBeLessThanOrEqual(layout?.clientWidth ?? 0)
    expect(layout?.overlaps).toBe(false)

    await startDate.click()
    await startDate.fill('2026-10-15')
    await startTime.fill('09:00')
    await endDate.click()
    await endDate.fill('2026-10-15')
    await endTime.fill('10:30')
    await expect(startDate).toHaveValue('2026-10-15')
    await expect(startTime).toHaveValue('09:00')
    await expect(endDate).toHaveValue('2026-10-15')
    await expect(endTime).toHaveValue('10:30')
    const scheduleBounds = await page.evaluate(() => [...document.querySelectorAll('input[type="date"], input[type="time"]')].map((input) => {
      const bounds = input.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth
    }))
    expect(scheduleBounds.length).toBe(4)
    expect(scheduleBounds.every(Boolean)).toBe(true)
  }

  await expect(page.getByText('Tanggal selesai harus setelah tanggal mulai.')).toHaveCount(0)
  await expect(page.getByText('Kode akses siswa', { exact: true })).toBeVisible()
  await page.getByLabel('Jenis asesmen').selectOption('simulasi')
  await expect(page.getByText('Kode akses siswa', { exact: true })).toHaveCount(0)
  await page.getByLabel('Jenis asesmen').selectOption('ujian_online')
  await endDate.fill('2026-10-05')
  await endTime.fill('08:00')
  await expect(page.getByText(/Tanggal selesai harus setelah tanggal mulai/)).toBeVisible()
  await page.getByRole('button', { name: 'Terbitkan asesmen' }).click()
  await expect(page.getByRole('alert')).toContainText('Tanggal selesai harus setelah tanggal mulai.')
  await page.getByRole('button', { name: '← Kembali' }).click()
  await expect(page.getByRole('heading', { name: 'Ujian Online', exact: true })).toBeVisible()
})
