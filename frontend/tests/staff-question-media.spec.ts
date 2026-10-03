import { expect, test } from '@playwright/test'
import { questionMediaMaxBytes } from '../src/questionMedia'

test('tutor mengunggah gambar stimulus besar, menyimpan versi aman, dan melihat pratinjau siswa', async ({ page }) => {
  let uploadBytes = 0
  let savedStimulus: Array<{ assetId: string; alt: string; contentType: string }> | undefined
  const previewPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=', 'base64')

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json([])
    if (path === '/staff/trash' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/archive' && method === 'GET') return json({ questions: [], assessments: [] })
    if (path === '/staff/question-media' && method === 'POST') {
      const requestBody = request.postDataBuffer() || Buffer.alloc(0)
      uploadBytes = requestBody.byteLength
      expect(requestBody.byteLength).toBeLessThan(questionMediaMaxBytes + 20_000)
      return json({ id: 'a24b7bc3-612c-4be6-bcda-b374ccedee1c', url: '/api/question-media/a24b7bc3-612c-4be6-bcda-b374ccedee1c', kind: 'image', contentType: 'image/webp', size: 123_456, originalName: 'peta.webp' }, 201)
    }
    if (path === '/question-media/a24b7bc3-612c-4be6-bcda-b374ccedee1c' && method === 'GET') return route.fulfill({ status: 200, body: previewPNG, headers: { 'Content-Type': 'image/png' } })
    if (path === '/staff/questions' && method === 'POST') {
      const body = request.postDataJSON() as { stimulusJson: string }
      savedStimulus = JSON.parse(body.stimulusJson) as typeof savedStimulus
      return json({ id: 'q-1', revision: 1, title: 'Peta wilayah', prompt: 'Amati peta berikut', status: 'draft' }, 201)
    }
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1400; canvas.height = 1200
    const context = canvas.getContext('2d')!
    const image = context.createImageData(canvas.width, canvas.height)
    let seed = 123456789
    for (let index = 0; index < image.data.length; index += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      image.data[index] = seed & 255
      image.data[index + 1] = (seed >>> 8) & 255
      image.data[index + 2] = (seed >>> 16) & 255
      image.data[index + 3] = 255
    }
    context.putImageData(image, 0, 0)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const buffer = Buffer.from(png, 'base64')
  expect(buffer.byteLength).toBeGreaterThan(questionMediaMaxBytes)

  await page.goto('/')
  await page.getByRole('button', { name: 'Tutor / Admin' }).click()
  await page.getByLabel('Username CBT').fill('tutor')
  await page.getByLabel('Kata sandi').fill('secret')
  await page.getByRole('button', { name: 'Masuk ke workspace' }).click()
  await page.getByRole('button', { name: 'Bank Soal' }).click()
  await page.getByRole('link', { name: 'Pustaka soal lepas' }).click()
  await page.getByRole('button', { name: 'Buat soal' }).click()
  await page.getByRole('button', { name: 'Mulai sederhana' }).click()
  await page.getByLabel('Pertanyaan').fill('Amati peta berikut')
  await page.getByLabel('Jenis bahan').selectOption('image_upload')
  await page.getByLabel('Seret gambar ke sini atau pilih dari perangkat').setInputFiles({ name: 'peta.png', mimeType: 'image/png', buffer })
  await expect(page.getByLabel('Teks alternatif untuk pembaca layar')).toBeVisible()
  await page.getByLabel('Teks alternatif untuk pembaca layar').fill('Peta sederhana wilayah pesisir')
  await expect(page.getByRole('status').filter({ hasText: /Gambar dioptimalkan/ })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Bahan pendukung' }).getByRole('img', { name: 'Peta sederhana wilayah pesisir' })).toBeVisible()
  await page.getByRole('button', { name: 'Simpan soal' }).click()
  await expect(page.getByRole('alert')).toContainText('Soal tersimpan sebagai draf')
  expect(uploadBytes).toBeLessThan(questionMediaMaxBytes + 20_000)
  expect(savedStimulus?.[0]).toMatchObject({ assetId: 'a24b7bc3-612c-4be6-bcda-b374ccedee1c', alt: 'Peta sederhana wilayah pesisir', contentType: 'image/webp' })
})
