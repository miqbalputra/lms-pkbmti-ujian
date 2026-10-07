import { expect, test } from './fixtures'

test('kartu soal dan kontrol aksinya tetap rapi pada desktop, tablet, dan mobile', async ({ page }) => {
  const questions = Array.from({ length: 8 }, (_, index) => ({
    id: `question-${index + 1}`,
    title: `Soal uji kesejajaran ${index + 1}`,
    type: 'pilihan_ganda',
    prompt: `Pertanyaan ${index + 1}`,
    description: '',
    configJson: '{}',
    points: 1,
    status: 'draft',
  }))

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    if (path === '/public/config') return route.fulfill({ json: { formsEnabled: false } })
    const method = request.method()
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path === '/auth/login' && method === 'POST') return json({ accessToken: 'staff-session', user: { id: 'teacher-1', username: 'tutor', nama: 'Tutor Uji', role: 'guru' } })
    if (path === '/staff/questions' && method === 'GET') return json(questions)
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
  await page.getByRole('button', { name: 'Buat formulir baru' }).click()

  for (const question of questions) {
    await page.getByRole('button', { name: new RegExp(question.title) }).click()
  }
  const cards = page.getByTestId('assessment-question-row')
  await expect(cards).toHaveCount(questions.length)

  for (const viewport of [{ width: 1280, height: 900 }, { width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="assessment-question-row"]')]
      const outsideControls = rows.flatMap((row) => {
        const rowBounds = row.getBoundingClientRect()
        return [...row.querySelectorAll<HTMLElement>('button')].filter((button) => {
          const bounds = button.getBoundingClientRect()
          return bounds.left < rowBounds.left - 1 || bounds.right > rowBounds.right + 1
        }).map((button) => button.getAttribute('aria-label') || button.textContent?.trim() || 'button')
      })
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        outsideControls,
        rowWidths: rows.map((row) => Math.round(row.getBoundingClientRect().width)),
      }
    })
    expect(layout.scrollWidth, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(layout.clientWidth)
    expect(layout.outsideControls, `controls escaped cards at ${viewport.width}px`).toEqual([])
    expect(layout.rowWidths.every((width) => width > 0), `missing cards at ${viewport.width}px`).toBe(true)
  }
})
