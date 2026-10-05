import { expect, test } from '@playwright/test'

test('login menjadikan akun LMS jalur utama CBT dan menjelaskan opsi lama', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Mulai Simulasi' }).click()

  const ssoLink = page.getByRole('link', { name: 'Masuk dengan akun LMS' })
  await expect(ssoLink).toBeVisible()
  const simulationSSO = new URL(`http://cbt.test${await ssoLink.getAttribute('href')}`)
  expect(simulationSSO.searchParams.get('next')).toBe('/?jenis=simulasi&jenjang=1&kategori_mapel=wajib&mapel=Bahasa+Indonesia')
  await expect(page.getByText('Masukkan username dan kata sandi di halaman LMS yang aman. CBT tidak menerima atau menyimpan kata sandi LMS.')).toBeVisible()

  await page.getByRole('button', { name: 'Ubah pilihan' }).click()
  await page.getByRole('button', { name: 'Beralih ke Ujian Online' }).click()
  await page.getByRole('button', { name: 'Lanjutkan ke Ujian Online' }).click()
  const onlineSSO = new URL(`http://cbt.test${await ssoLink.getAttribute('href')}`)
  expect(onlineSSO.searchParams.get('next')).toBe('/?jenis=ujian_online')

  await page.getByRole('button', { name: 'Siswa lokal' }).click()
  await expect(page.getByText('Akun siswa dari LMS gunakan tombol Masuk dengan akun LMS. Form ini hanya untuk akun CBT siswa lokal yang belum ditautkan.')).toBeVisible()
  await expect(page.getByLabel('Username siswa')).toBeVisible()
})

test('pilihan simulasi TKA diteruskan ke CBT sesudah login', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Jenjang pendidikan').selectOption('2')
  await page.getByLabel('Mata pelajaran simulasi', { exact: true }).selectOption('Matematika')
  await page.getByRole('button', { name: 'Mulai Simulasi' }).click()
  const ssoLink = page.getByRole('link', { name: 'Masuk dengan akun LMS' })
  const loginURL = new URL(`http://cbt.test${await ssoLink.getAttribute('href')}`)
  expect(loginURL.searchParams.get('next')).toBe('/?jenis=simulasi&jenjang=2&kategori_mapel=wajib&mapel=Matematika')
})
