import {test,expect,installSession} from './fixtures';

test('real canvas: visual stimulus upload/preview, safe delete/undo and sections interleaved with questions',async({page,request})=>{
  const account=await (await request.post('/api/auth/login',{data:{username:'e2e-owner',password:'CBT-E2E-password-ONLY-2026'}})).json();
  const headers={Authorization:`Bearer ${account.accessToken}`};
  const form=await (await request.post('/api/staff/forms/package',{headers,data:{}})).json();
  await installSession(page.context(),account);
  await page.goto(`/editor/package/${form.resourceId}`);
  await page.getByLabel('Judul paket',{exact:true}).fill('Bahan dan bagian - browser nyata');
  await page.getByRole('button',{name:'Pilih jenis soal',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Pilihan ganda',exact:true}).click();
  const first=page.locator('.form-question').first();
  await first.getByRole('button',{name:'Gunakan template untuk jenis ini'}).click();
  await first.getByLabel('Pertanyaan',{exact:true}).fill('Pertanyaan awal');
  await first.getByText('Bagian, stimulus & validasi',{exact:true}).click();
  await first.getByRole('button',{name:'Tambah bahan pendukung',exact:true}).click();
  await first.getByLabel('Judul stimulus bersama',{exact:true}).fill('Bacaan bersama');
  await first.getByRole('button',{name:'+ Teks',exact:true}).click();
  await first.getByLabel('Teks bacaan',{exact:true}).fill('Isi bacaan orisinal siswa.');
  await first.getByRole('button',{name:'+ Tabel',exact:true}).click();
  await expect(first.locator('table')).toBeVisible();
  await first.getByRole('button',{name:'+ Gambar',exact:true}).click();
  await first.getByLabel('Teks alternatif gambar (wajib)',{exact:true}).fill('Gambar bahan soal uji');

  // Keep the real upload response pending to verify the publication gate.
  let finishUpload!:()=>void;
  const uploadGate=new Promise<void>(resolve=>{finishUpload=resolve});
  await page.route('**/api/staff/question-media',async route=>{
    const response=await route.fetch();await uploadGate;await route.fulfill({response});
  });
  await first.getByLabel('Atau unggah media',{exact:true}).setInputFiles({name:'stimulus.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=','base64')});
  await expect(first.getByText('Mengunggah media… Publikasi menunggu unggahan selesai.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Terbitkan',exact:true})).toBeDisabled();
  finishUpload();
  await expect(first.getByRole('img',{name:'Gambar bahan soal uji',exact:true})).toBeVisible();
  await expect.poll(()=>first.getByRole('img',{name:'Gambar bahan soal uji',exact:true}).evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
  await first.getByRole('button',{name:'Hapus bahan bersama',exact:true}).click();
  await first.getByRole('button',{name:'Hapus bahan dari draf',exact:true}).click();
  await expect(first.getByLabel('Judul stimulus bersama',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Batalkan perubahan saya',exact:true}).click();
  await expect(first.getByLabel('Judul stimulus bersama',{exact:true})).toHaveValue('Bacaan bersama');

  await page.getByRole('button',{name:'Tambah bagian',exact:true}).click();
  await page.getByLabel('Judul bagian',{exact:true}).fill('Bagian kedua');
  await page.getByRole('button',{name:'Pilih jenis soal',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Pilihan ganda',exact:true}).click();
  await page.locator('.form-question').last().getByRole('button',{name:'Gunakan template untuk jenis ini'}).click();
  await page.locator('.form-question').last().getByLabel('Pertanyaan',{exact:true}).fill('Pertanyaan bagian kedua');
  const visibleOrder=()=>page.locator('.form-content > .grid > .form-sortable').evaluateAll(rows=>rows.map(row=>row.querySelector('.form-section input')?.getAttribute('aria-label')||row.querySelector('.form-question [aria-label="Pertanyaan"]')?.getAttribute('aria-label')));
  expect(await visibleOrder()).toEqual(['Pertanyaan','Judul bagian','Pertanyaan']);
  // Keyboard button crossing the section boundary changes membership atomically.
  await first.locator('xpath=..').locator(':scope > .form-move-bar').getByRole('button',{name:'Pindahkan item 1 ke bawah',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect.poll(visibleOrder).toEqual(['Judul bagian','Pertanyaan','Pertanyaan']);
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  const saved=await (await request.get(`/api/staff/forms/package/${form.resourceId}`,{headers})).json();
  const sectionId=Object.keys(saved.content.sections)[0];
  expect(Object.values(saved.content.cards).every((card:any)=>card.sectionId===sectionId)).toBeTruthy();
  await page.getByRole('button',{name:'Hapus bagian, pertahankan soal',exact:true}).click();
  await expect(page.locator('.form-question')).toHaveCount(2);
  await expect(page.getByLabel('Judul bagian',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  await page.reload();await expect(page.locator('.form-question')).toHaveCount(2);
  for(const size of [{width:375,height:812},{width:768,height:1024},{width:1440,height:900}]){
    await page.setViewportSize(size);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    if(size.width<=1000){
      const editor=await page.locator('.form-content').boundingBox(),toolbar=await page.getByRole('complementary',{name:'Tambah konten'}).boundingBox();
      expect(editor).not.toBeNull();expect(toolbar).not.toBeNull();
      expect(editor!.y+editor!.height).toBeLessThanOrEqual(toolbar!.y);
      await page.locator('.form-question').last().getByLabel('Pertanyaan',{exact:true}).fill('Soal terakhir nyaman diedit di layar kecil');
      await expect(page.locator('.form-question').last().getByLabel('Pertanyaan',{exact:true})).toHaveText('Soal terakhir nyaman diedit di layar kecil');
    }
    await page.screenshot({path:`test-results/canvas-stimulus-${size.width}.png`,fullPage:true});
  }
});
