import { expect, test } from '@playwright/test'

test('siswa membaca instruksi, autosave, menandai, memeriksa, mengirim, dan melihat hasil', async ({ page }) => {
  let submitted = false
  const deadlineAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })

    if (path === '/public/ujian-online/cek' && method === 'POST') {
      return json({ accessToken: 'playwright-session', student: { id: 'student-1', nama: 'Siswa Uji' } })
    }
    if (path === '/student/assessments' && method === 'GET') {
      return json([{
        id: 'assessment-1', kind: 'ujian_online', title: 'Latihan Literasi', description: 'Latihan contoh',
        instructions: 'Kerjakan dengan teliti.', durationMinute: 60,
      }])
    }
    if (path === '/student/attempts' && method === 'GET') {
      return json(submitted ? [{ id: 'attempt-1', assessmentId: 'assessment-1', title: 'Latihan Literasi', kind: 'ujian_online', status: 'completed', number: 1, resultAvailable: true, score: 1 }] : [])
    }
    if (path === '/student/assessments/assessment-1/start' && method === 'POST') {
      return json({ id: 'attempt-1', assessmentId: 'assessment-1', status: 'started', deadlineAt })
    }
    if (path === '/student/attempts/attempt-1' && method === 'GET') {
      return json({
        attempt: { id: 'attempt-1', assessmentId: 'assessment-1', status: 'started', deadlineAt },
        serverTime: new Date().toISOString(),
        items: [{
          id: 'item-1', position: 1, flagged: false, answer: null, revision: 0,
          question: { id: 'question-1', title: 'Jadwal kegiatan', type: 'pg_tunggal', prompt: 'Pukul berapa kegiatan dimulai?', points: 1, config: { choices: [{ id: 'a', text: '08.00' }, { id: 'b', text: '09.00' }] } },
        }],
      })
    }
    if (path === '/student/attempts/attempt-1/items/item-1/answer' && method === 'PUT') {
      return json({ id: 'answer-1', revision: 1, saved: true })
    }
    if (path === '/student/attempts/attempt-1/items/item-1/flag' && method === 'PUT') return json({ flagged: true })
    if (path === '/student/attempts/attempt-1/submit' && method === 'POST') {
      submitted = true
      return json({ status: 'completed', score: 1, showResult: true })
    }
    if (path === '/student/attempts/attempt-1/results' && method === 'GET') {
      return json({ available: true, status: 'completed', pendingManual: false, title: 'Latihan Literasi', score: 1, showReview: false })
    }
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByLabel('NISN').fill('0000000001')
  await page.getByLabel('Kode akses ujian').fill('123456')
  await page.getByRole('button', { name: 'Lihat ujian' }).click()
  await page.getByRole('button', { name: 'Baca instruksi' }).click()
  await expect(page.getByText('Sebelum mulai', { exact: true })).toBeVisible()
  await expect(page.getByText('Nama: Siswa Uji')).toBeVisible()
  await page.getByRole('button', { name: 'Saya siap, mulai' }).click()

  await expect(page.getByText('Pukul berapa kegiatan dimulai?')).toBeVisible()
  const savedRequest = page.waitForRequest((request) => request.url().includes('/student/attempts/attempt-1/items/item-1/answer') && request.method() === 'PUT')
  await page.getByRole('radio', { name: /08\.00/ }).check()
  await savedRequest
  await page.getByRole('button', { name: 'Ragu-ragu' }).click()
  await page.getByRole('button', { name: 'Periksa & kirim' }).click()
  await expect(page.getByRole('dialog').getByText('Ditandai', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Konfirmasi & kirim' }).click()

  await expect(page.getByText('Hasil asesmen', { exact: true })).toBeVisible()
  await expect(page.getByText('Nilai: 1')).toBeVisible()
})

test('jawaban lokal yang bentrok dengan perangkat lain meminta pilihan dan menyimpan revisi secara sadar', async ({ page }) => {
  let attemptStarted = false
  let savedRevision = 0
  let simulateOffline = false
  const submittedRevisions: number[] = []
  const deadlineAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })

    if (path === '/public/ujian-online/cek' && method === 'POST') return json({ accessToken: 'conflict-session', student: { id: 'student-conflict', nama: 'Siswa Konflik' } })
    if (path === '/student/assessments' && method === 'GET') return json([{ id: 'assessment-conflict', kind: 'ujian_online', title: 'Latihan Konflik', durationMinute: 60 }])
    if (path === '/student/attempts' && method === 'GET') return json(attemptStarted ? [{ id: 'attempt-conflict', assessmentId: 'assessment-conflict', title: 'Latihan Konflik', kind: 'ujian_online', status: 'started', number: 1, resultAvailable: false }] : [])
    if (path === '/student/assessments/assessment-conflict/start' && method === 'POST') {
      attemptStarted = true
      return json({ id: 'attempt-conflict', assessmentId: 'assessment-conflict', status: 'started', deadlineAt })
    }
    if (path === '/student/attempts/attempt-conflict' && method === 'GET') return json({
      attempt: { id: 'attempt-conflict', assessmentId: 'assessment-conflict', status: 'started', deadlineAt }, serverTime: new Date().toISOString(),
      items: [{ id: 'item-conflict', position: 1, flagged: false, answer: JSON.stringify('b'), revision: savedRevision, question: { id: 'question-conflict', title: 'Pilihan jawaban', type: 'pg_tunggal', prompt: 'Pilihan dari server?', points: 1, config: { choices: [{ id: 'a', text: 'Perangkat' }, { id: 'b', text: 'Server terbaru' }] } } }],
    })
    if (path === '/student/attempts/attempt-conflict/items/item-conflict/answer' && method === 'PUT') {
      if (simulateOffline) return route.abort('internetdisconnected')
      const body = request.postDataJSON() as { revision: number }
      submittedRevisions.push(body.revision)
      if (body.revision !== savedRevision) return json({ error: 'Versi jawaban sudah berubah.' }, 409)
      savedRevision += 1
      return json({ revision: savedRevision, saved: true })
    }
    return json({ error: `Unmocked request: ${method} ${path}` }, 500)
  })

  await page.goto('/')
  await page.getByLabel('NISN').fill('0000000002')
  await page.getByLabel('Kode akses ujian').fill('123456')
  await page.getByRole('button', { name: 'Lihat ujian' }).click()
  await page.getByRole('button', { name: 'Baca instruksi' }).click()
  await page.getByRole('button', { name: 'Saya siap, mulai' }).click()
  await expect(page.getByText('Pilihan dari server')).toBeVisible()

  simulateOffline = true
  await page.context().setOffline(true)
  await page.getByRole('radio', { name: 'Perangkat' }).check()
  await expect.poll(async () => page.evaluate(() => {
    return new Promise<number>((resolve) => {
      const request = indexedDB.open('pkbm-cbt-local-answers', 1)
      request.onsuccess = () => {
        const tx = request.result.transaction('answers', 'readonly')
        const rows = tx.objectStore('answers').getAll()
        rows.onsuccess = () => resolve(rows.result.length)
      }
    })
  })).toBe(1)
  await page.waitForTimeout(750)
  expect(submittedRevisions).toEqual([])

  await page.context().setOffline(false)
  simulateOffline = false
  // Another device saves revision 1 while this browser still has a local answer based on revision 0.
  savedRevision = 1
  await page.reload()
  await page.getByRole('button', { name: 'Lanjutkan' }).click()
  await page.getByRole('button', { name: 'Lanjutkan percobaan' }).click()

  await expect(page.getByRole('heading', { name: 'Jawaban berubah di perangkat lain' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Perangkat' })).toBeChecked()
  await page.getByRole('button', { name: 'Pertahankan jawaban perangkat' }).click()
  await expect.poll(() => Promise.resolve(savedRevision)).toBe(2)
  // The stale revision is rejected; only after an explicit choice is revision 1 written.
  expect(submittedRevisions).toEqual([0, 1])
  await expect(page.getByText('Semua jawaban sudah tersimpan di server.')).toBeVisible()
})

test('portal siswa tidak melebar horizontal pada ponsel, tablet, dan desktop', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api', '')
    if (path === '/public/ujian-online/cek') return route.fulfill({ json: { accessToken: 'responsive-session', student: { id: 'student-1', nama: 'Siswa Uji' } } })
    if (path === '/student/assessments') return route.fulfill({ json: [{ id: 'assessment-1', kind: 'simulasi', title: 'Simulasi Numerasi', durationMinute: 45 }] })
    if (path === '/student/attempts') return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })

  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await page.getByLabel('NISN').fill('0000000001')
    await page.getByLabel('Kode akses ujian').fill('123456')
    await page.getByRole('button', { name: 'Lihat ujian' }).click()
    await expect(page.getByRole('heading', { name: 'Asesmen untukmu' })).toBeVisible()
    const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width)
  }
})
