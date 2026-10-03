import { expect, test, type Page } from '@playwright/test'

async function loginAsTutor(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
}

test('tutor dapat memberi label sementara pada kelas yang roster siswanya sudah tersinkron', async ({ page }) => {
  let manualClass: { id: string; nama: string; jenjang: number; manualFallback: boolean } | null = null
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })

    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/assessments' && method === 'GET') return json([])
    if (path === '/staff/master/classes' && method === 'GET') return json(manualClass ? [manualClass] : [])
    if (path === '/staff/master/students' && method === 'GET') return json([
      { id: 'student-1', nama: 'Ayu Uji', nisn: '123456', kelasId: 'source-class-1' },
      { id: 'student-2', nama: 'Bima Uji', nisn: '789012', kelasId: 'source-class-1' },
    ])
    if (path === '/staff/assessments/drafts' && method === 'POST') return json({ assessment: { id: 'draft-1', revision: 1, status: 'draft' } }, 201)
    if (path === '/staff/assessments/draft-1/draft' && method === 'PUT') return json({ id: 'draft-1', revision: 2, status: 'draft' })
    if (path === '/staff/master/classes/manual-label' && method === 'POST') {
      const input = request.postDataJSON() as { classId: string; name: string }
      manualClass = { id: input.classId, nama: input.name, jenjang: 0, manualFallback: true }
      return json(manualClass, 201)
    }
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await loginAsTutor(page)
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
  await page.getByRole('button', { name: /Mulai sederhana/ }).click()
  await expect(page.getByText('LMS belum mengirim data kelas aktif.')).toBeVisible()
  await page.getByLabel('Pilih kelompok peserta tersinkron').selectOption('source-class-1')
  await page.getByLabel('Nama kelas (sementara)').fill('Paket B — Kelas 7')
  await page.getByRole('button', { name: 'Buat pilihan kelas sementara' }).click()
  await expect(page.getByText('Kelas sementara “Paket B — Kelas 7” dibuat dari data peserta yang sudah tersinkron.')).toBeVisible()
  await expect(page.getByLabel('Kelas peserta')).toHaveValue('source-class-1')
  await expect(page.getByRole('option', { name: 'Paket B — Kelas 7 · Label sementara' })).toBeAttached()
})

test('tanpa roster siswa tersinkron, tutor diarahkan ke sinkronisasi dan kelas palsu tidak dapat dibuat', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/assessments' && method === 'GET') return json([])
    if (path === '/staff/master/classes' && method === 'GET') return json([])
    if (path === '/staff/master/students' && method === 'GET') return json([])
    if (path === '/staff/assessments/drafts' && method === 'POST') return json({ assessment: { id: 'draft-1', revision: 1, status: 'draft' } }, 201)
    if (path === '/staff/assessments/draft-1/draft' && method === 'PUT') return json({ id: 'draft-1', revision: 2, status: 'draft' })
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await loginAsTutor(page)
  await page.getByRole('button', { name: 'Ujian & Simulasi' }).click()
  await page.getByRole('button', { name: /Mulai sederhana/ }).click()
  await expect(page.getByText('Belum ada peserta aktif dari LMS, jadi kelas manual tidak dapat dipetakan dengan aman.')).toBeVisible()
  await page.getByRole('button', { name: 'Buka sinkronisasi LMS' }).click()
  await expect(page.getByRole('heading', { name: 'Status sinkronisasi' })).toBeVisible()
})
