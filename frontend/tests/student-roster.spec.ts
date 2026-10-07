import { expect, test } from './fixtures'

test('direktori CBT menampilkan NIS, NISN, kelas, kelompok belajar, dan status dari LMS', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown) => route.fulfill({ status: 200, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/master/students' && method === 'GET') return json([
      { id: 'student-1', nama: 'Alya Aktif', nis: 'A-001', nisn: '0010000001', jenisKelamin: 'P', kelasId: 'class-1', kelas: 'Kelas 1', jenjang: 1, pokjarId: 'pokjar-1', kelompokBelajar: 'Pokjar Utama', tahunAjaran: '2026/2027', program: 'Paket A', active: true },
      { id: 'student-2', nama: 'Bima Nonaktif', nis: 'A-002', nisn: '0010000002', jenisKelamin: 'L', kelasId: 'class-1', kelas: 'Kelas 1', jenjang: 1, pokjarId: 'pokjar-1', kelompokBelajar: 'Pokjar Utama', tahunAjaran: '2026/2027', program: 'Paket A', active: false },
    ])
    if (path === '/staff/master/classes' && method === 'GET') return json([{ id: 'class-1', nama: 'Kelas 1', jenjang: 1, kelompokBelajar: 'Pokjar Utama', tahunAjaran: '2026/2027', active: true }])
    if (path === '/staff/master/groups' && method === 'GET') return json([{ id: 'pokjar-1', namaPokjar: 'Pokjar Utama', tipe: 'Dalam Kota' }])
    return route.fulfill({ status: 500, json: { error: `Unmocked request: ${method} ${path}` } })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Data Siswa' }).click()

  await expect(page.getByRole('heading', { name: 'Kelas & peserta didik' })).toBeVisible()
  await expect(page.getByText('Total siswa tersalin')).toBeVisible()
  await expect(page.getByText('Menampilkan 1 dari 2 siswa tersinkron.')).toBeVisible()
  await expect(page.getByText('NIS: A-001')).toBeVisible()
  await expect(page.getByText('NISN: 0010000001')).toBeVisible()
  await expect(page.getByRole('article').first().getByText('Pokjar Utama', { exact: true })).toBeVisible()

  await page.getByLabel('Status siswa').selectOption('all')
  await expect(page.getByText('Menampilkan 2 dari 2 siswa tersinkron.')).toBeVisible()
  await expect(page.getByText('NIS: A-002')).toBeVisible()
  await page.getByLabel('Kelompok belajar').selectOption('pokjar-1')
  await expect(page.getByText('Menampilkan 2 dari 2 siswa tersinkron.')).toBeVisible()
})
