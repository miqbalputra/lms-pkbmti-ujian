import { expect, test } from '@playwright/test'

test('tutor baru mengikuti alur beranda → formulir baru tanpa mencari menu', async ({ page }) => {
  let draft: Record<string, unknown> | null = null
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/assessments' && method === 'GET') return json(draft ? [draft] : [])
    if (path === '/staff/master/classes' && method === 'GET') return json([{ id: 'class-1', nama: 'Paket A Kelas 1', jenjang: 1 }])
    if (path === '/staff/master/students' && method === 'GET') return json([])
    if (path === '/staff/assessments/drafts' && method === 'POST') {
      draft = { id: 'draft-1', revision: 1, status: 'draft', kind: 'ujian_online', title: '', classId: 'class-1', durationMinute: 60 }
      return json({ assessment: draft }, 201)
    }
    if (path === '/staff/assessments/draft-1/draft' && method === 'PUT') return json({ assessment: { ...draft, revision: 2 } })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()

  await expect(page.getByRole('heading', { name: 'Buat formulir asesmen' })).toBeVisible()
  await expect(page.getByText('Susun pertanyaan', { exact: true })).toBeVisible()
  await expect(page.getByText('Pilih peserta', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Buat asesmen' }).click()
  await expect(page.getByText('Formulir dan asesmen', { exact: true })).toBeVisible()
  await expect(page.getByText('Cara paling mudah')).toBeVisible()

  await page.getByRole('button', { name: 'Buat formulir baru' }).click()
  await expect(page.getByRole('heading', { name: 'Identitas paket' })).toBeVisible()
  await expect(page.getByLabel('Judul asesmen')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Peserta · Satu kelas' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pratinjau siswa' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Siapkan & terbitkan' })).toBeVisible()
})
