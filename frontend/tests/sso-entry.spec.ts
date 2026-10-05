import { expect, test } from '@playwright/test'

test('login menjadikan akun LMS jalur utama CBT dan menjelaskan opsi lama', async ({ page }) => {
  await page.goto('/')

  const ssoLink = page.getByRole('link', { name: 'Masuk melalui akun LMS' })
  await expect(ssoLink).toBeVisible()
  await expect(ssoLink).toHaveAttribute('href', '/sso/start?next=%2F%3Fjenis%3Dsimulasi')
  await expect(page.getByText('Gunakan akun sekolah yang sama. LMS memverifikasi identitas dan peran Anda.')).toBeVisible()

  await page.getByRole('button', { name: 'Ujian Online' }).click()
  await expect(ssoLink).toHaveAttribute('href', '/sso/start?next=%2F%3Fjenis%3Dujian_online')

  await page.getByRole('button', { name: 'Siswa lokal' }).click()
  await expect(page.getByText('Akun siswa dari LMS gunakan tombol Masuk melalui akun LMS. Form ini hanya untuk akun CBT siswa lokal yang belum ditautkan.')).toBeVisible()
  await expect(page.getByLabel('Username siswa')).toBeVisible()
})
