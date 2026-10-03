import { expect, test } from '@playwright/test'

test('kode akses tersimpan otomatis dan muncul kembali saat draf dibuka ulang', async ({ page }) => {
  let storedDraft: Record<string, unknown> = {}
  let revision = 1
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/assessments' && method === 'GET') return json([])
    if (path === '/staff/master/classes' && method === 'GET') return json([{ id: 'class-1', nama: 'Paket A Kelas 1', jenjang: 1 }])
    if (path === '/staff/master/students' && method === 'GET') return json([])
    if (path === '/staff/assessments/drafts' && method === 'POST') {
      storedDraft = request.postDataJSON() as Record<string, unknown>
      return json({ assessment: { id: 'draft-1', revision, status: 'draft' } }, 201)
    }
    if (path === '/staff/assessments/draft-1/draft' && method === 'PUT') {
      storedDraft = request.postDataJSON() as Record<string, unknown>
      revision++
      return json({ assessment: { ...storedDraft, id: 'draft-1', revision, status: 'draft' } })
    }
    if (path === '/staff/assessments/draft-1' && method === 'GET') {
      return json({ assessment: { ...storedDraft, id: 'draft-1', revision, status: 'draft', accessCode: storedDraft.accessCode || '', accessCodeConfigured: Boolean(storedDraft.accessCode) }, items: [], assignments: [] })
    }
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
  await page.getByRole('button', { name: 'Buat formulir baru' }).click()
  const accessCode = page.getByLabel('Kode akses siswa')
  await accessCode.fill('KODE-TRYOUT-2026')
  await expect(page.getByText('Tersimpan otomatis')).toBeVisible()
  await expect.poll(() => storedDraft.accessCode).toBe('KODE-TRYOUT-2026')

  await page.reload()
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
  await expect(page.getByLabel('Kode akses siswa')).toHaveValue('KODE-TRYOUT-2026')
})
