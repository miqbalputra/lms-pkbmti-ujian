import {
  test,
  expect,
  installSession,
  type BrowserContext,
  type APIRequestContext,
} from "./fixtures";

async function login(request: APIRequestContext, username: string) {
  const r = await request.post("/api/auth/login", {
    data: { username, password: "CBT-E2E-password-ONLY-2026" },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
async function session(context: BrowserContext, user: unknown) {
  await installSession(context,user);
}

test("real PostgreSQL + WebSocket: tutor collaboration, offline merge, preview, publication, student resume and submit", async ({
  browser,
  request,
  page,
  watchUI,
}) => {
  const owner = await login(request, "e2e-owner"),
    editor = await login(request, "e2e-editor");
  const headers = { Authorization: `Bearer ${owner.accessToken}` };
  const created = await request.post("/api/staff/forms/assessment", {
    headers,
    data: { kind: "simulasi" },
  });
  expect(created.status()).toBe(201);
  const form = await created.json();
  expect(
    (
      await request.put(
        `/api/staff/forms/assessment/${form.resourceId}/collaborators`,
        { headers, data: { username: "e2e-editor", role: "editor" } },
      )
    ).ok(),
  ).toBeTruthy();
  await session(page.context(), owner);
  await page.goto(`/editor/assessment/${form.resourceId}`);
  await expect(page.getByLabel("Judul paket", { exact: true })).toBeVisible();
  await page
    .getByLabel("Judul paket", { exact: true })
    .fill("Asesmen browser nyata");
  await page
    .getByRole("button", { name: "Tambah pertanyaan", exact: true })
    .first()
    .click();
  await page.getByLabel("Pertanyaan", { exact: true }).fill("Berapa 2 + 2?");
  await page
    .getByRole("button", { name: "Gunakan template untuk jenis ini" })
    .click();
  await expect(page.getByText("Tersimpan", { exact: true })).toBeVisible({
    timeout: 20000,
  });

  const second = await browser.newContext();
  watchUI(second);
  await session(second, editor);
  const peer = await second.newPage();
  await peer.goto(`/editor/assessment/${form.resourceId}`);
  await expect(peer.getByLabel("Pertanyaan", { exact: true })).toHaveText(
    await page.getByLabel("Pertanyaan", { exact: true }).innerText(),
  );
  await peer
    .getByLabel("Deskripsi (opsional)", { exact: true })
    .fill("Diedit tutor kedua");
  await expect(
    page.getByLabel("Deskripsi (opsional)", { exact: true }),
  ).toHaveValue("Diedit tutor kedua");
  await page.context().setOffline(true);
  await page
    .getByLabel("Judul paket", { exact: true })
    .fill("Judul ketika offline");
  await expect(
    page.getByText("Offline — tersimpan lokal", { exact: true }),
  ).toBeVisible();
  await peer
    .getByLabel("Deskripsi (opsional)", { exact: true })
    .fill("Perubahan online tetap ada");
  await page.context().setOffline(false);
  await expect(page.getByText("Tersimpan", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(peer.getByLabel("Judul paket", { exact: true })).toHaveValue(
    "Judul ketika offline",
  );
  await expect(
    page.getByLabel("Deskripsi (opsional)", { exact: true }),
  ).toHaveValue("Perubahan online tetap ada");
  await page.reload();
  await expect(page.getByLabel("Judul paket", { exact: true })).toHaveValue(
    "Judul ketika offline",
  );

  for (const size of [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `test-results/forms-${size.width}.png`,
      fullPage: true,
    });
  }
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Pratinjau di tab baru" }).click();
  const preview = await popup;
  await expect(
    preview.getByText(
      "Pratinjau — jawaban di layar ini tidak disimpan sebagai percobaan atau nilai siswa.",
    ),
  ).toBeVisible();
  await preview.close();
  await page.getByRole("button", { name: "Setelan", exact: true }).click();
  await page
    .getByLabel("Kode akses peserta", { exact: true })
    .fill(`E2E${form.resourceId.slice(0, 6)}`);
  await page.getByRole("button", { name: "Atur peserta dari LMS" }).click();
  await page
    .getByRole("button", { name: "Pilih semua kelas", exact: true })
    .click();
  await page.getByRole("button", { name: "Tutup panel" }).click();
  await page
    .getByRole("checkbox", { name: "Tampilkan nilai setelah penilaian" })
    .check();
  await page
    .getByLabel("Rilis nilai", { exact: true })
    .selectOption("immediate");
  await expect(page.getByText("Tersimpan", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Terbitkan", exact: true }).click();
  await page.getByRole("button", { name: "Terbitkan versi ini" }).click();
  await expect(page.getByText("Baca-saja", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  const stored = await (
    await request.get(`/api/staff/forms/assessment/${form.resourceId}`, {
      headers,
    })
  ).json();
  expect(stored.frozen).toBe(true);
  const key = Object.values(stored.content.cards).map(
    (c: any) => c.config.correctIds,
  )[0][0];
  const chosen = Object.values(stored.content.cards).map(
    (c: any) => c.config.choices.find((v: any) => v.id === key).text,
  )[0];
  await second.close();

  const student = await browser.newContext();
  watchUI(student);
  const pupil = await student.newPage();
  await pupil.goto("/");
  await pupil
    .getByLabel("Kode dari tutor")
    .fill(`E2E${form.resourceId.slice(0, 6)}`);
  await pupil
    .getByRole("button", { name: "Lihat asesmen", exact: true })
    .click();
  await pupil
    .getByRole("button", { name: "Mulai Simulasi / Ujian", exact: true })
    .click();
  await pupil.getByLabel("NISN siswa").fill("9090909001");
  await pupil.getByRole("button", { name: "Login", exact: true }).click();
  await pupil
    .getByRole("button", { name: "Verifikasi & lanjutkan", exact: true })
    .click();
  await expect(
    pupil.getByText("Siswa E2E 9090909001", { exact: true }).first(),
  ).toBeVisible();
  await pupil.getByRole("checkbox").check();
  await pupil.getByRole("button", { name: "Mulai tes", exact: true }).click();
  await expect(
    pupil.getByRole("heading", { name: "Soal nomor 1" }),
  ).toBeVisible();
  await pupil
    .getByRole("radio", { name: chosen as string, exact: false })
    .check();
  await expect(
    pupil.getByRole("status").filter({ hasText: "Tersimpan" }),
  ).toBeVisible();
  await pupil.getByRole("button", { name: "Ragu-ragu", exact: true }).click();
  await pupil.reload();
  await expect(
    pupil.getByRole("heading", { name: "Soal nomor 1" }),
  ).toBeVisible();
  await expect(
    pupil.getByRole("radio", { name: chosen as string, exact: false }),
  ).toBeChecked();
  await pupil
    .getByRole("button", { name: "Periksa & kirim", exact: true })
    .click();
  await pupil
    .getByRole("checkbox", {
      name: "Saya sudah memeriksa jawaban dan mengerjakan asesmen ini sendiri.",
    })
    .check();
  await pupil
    .getByRole("button", { name: "Kirim jawaban sekarang", exact: true })
    .click();
  await expect(pupil.getByText(/Nilai:/)).toBeVisible();
  await student.close();
});
