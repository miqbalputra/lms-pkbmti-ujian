import {test,expect,installSession} from './fixtures';

test('real private header: upload gate, reload, new-tab preview, frozen display and scoped student access',async({page,request,browser,watchUI})=>{
  const account=await (await request.post('/api/auth/login',{data:{username:'e2e-owner',password:'CBT-E2E-password-ONLY-2026'}})).json();
  const headers={Authorization:`Bearer ${account.accessToken}`};
  const form=await (await request.post('/api/staff/forms/assessment',{headers,data:{kind:'simulasi'}})).json();
  const code=`HDR${form.resourceId.slice(0,8)}`;
  await installSession(page.context(),account);
  await page.goto(`/editor/assessment/${form.resourceId}`);
  await page.getByLabel('Judul paket',{exact:true}).fill('Tema sekolah dengan header privat');
  await page.getByRole('button',{name:'Tambah pertanyaan',exact:true}).first().click();
  await page.getByRole('button',{name:'Gunakan template untuk jenis ini'}).click();
  await page.getByRole('button',{name:'Tema',exact:true}).click();
  await page.getByLabel('Teks alternatif header',{exact:true}).fill('Header PKBM uji browser');
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve});
  await page.route('**/api/staff/question-media',async route=>{const response=await route.fetch();await gate;await route.fulfill({response})});
  await page.getByLabel('Unggah gambar header',{exact:true}).setInputFiles({name:'header.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=','base64')});
  await expect(page.getByText('Mengunggah header… Pratinjau dan publikasi menunggu unggahan selesai.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Terbitkan',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Pratinjau di tab baru',exact:true})).toBeDisabled();
  release();
  await expect(page.getByRole('dialog').getByRole('img',{name:'Header PKBM uji browser'})).toBeVisible();
  await page.getByRole('button',{name:'Tutup panel',exact:true}).click();
  await page.getByRole('button',{name:'Pertanyaan',exact:true}).click();
  await expect(page.getByRole('img',{name:'Header PKBM uji browser'})).toBeVisible();
  await expect.poll(()=>page.getByRole('img',{name:'Header PKBM uji browser'}).evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  await page.reload();
  await expect(page.getByRole('img',{name:'Header PKBM uji browser'})).toBeVisible();
  const popup=page.waitForEvent('popup');await page.getByRole('button',{name:'Pratinjau di tab baru'}).click();const preview=await popup;
  await expect(preview.getByRole('img',{name:'Header PKBM uji browser'})).toBeVisible();
  await expect.poll(()=>preview.getByRole('img',{name:'Header PKBM uji browser'}).evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
  await preview.close();
  expect(await (await request.get(`/api/staff/assessments/${form.resourceId}/results`,{headers})).json()).toEqual([]);
  await page.getByRole('button',{name:'Setelan',exact:true}).click();
  await page.getByLabel('Kode akses peserta',{exact:true}).fill(code);
  await page.getByRole('button',{name:'Atur peserta dari LMS'}).click();
  await page.getByRole('button',{name:'Pilih semua kelas',exact:true}).click();
  await page.getByRole('button',{name:'Tutup panel'}).click();
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  await page.getByRole('button',{name:'Terbitkan',exact:true}).click();await page.getByRole('button',{name:'Terbitkan versi ini'}).click();
  await expect(page.getByText('Baca-saja',{exact:true})).toBeVisible({timeout:20000});
  const saved=await (await request.get(`/api/staff/forms/assessment/${form.resourceId}`,{headers})).json();
  const headerId=saved.content.settings.headerImage.assetId;
  expect((await request.get(`/api/question-media/${headerId}`)).status()).toBe(401);
  const student=await browser.newContext();
  watchUI(student);
  try {
    const pupil=await student.newPage();
    await pupil.goto('/');await pupil.getByLabel('Kode dari tutor').fill(code);
    await pupil.getByRole('button',{name:'Lihat asesmen',exact:true}).click();await pupil.getByRole('button',{name:'Mulai Simulasi / Ujian',exact:true}).click();
    await pupil.getByLabel('NISN siswa').fill('9090909001');await pupil.getByRole('button',{name:'Login',exact:true}).click();
    await pupil.getByRole('button',{name:'Verifikasi & lanjutkan',exact:true}).click();await pupil.getByRole('checkbox').check();await pupil.getByRole('button',{name:'Mulai tes',exact:true}).click();
    const image=pupil.getByRole('img',{name:'Header PKBM uji browser'});
    await expect(image).toBeVisible();await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
    for(const size of [{width:375,height:812},{width:768,height:1024},{width:1440,height:900}]){
      await pupil.setViewportSize(size);expect(await pupil.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
      for(const radio of await pupil.getByRole('radio').all()){
        await radio.check();await expect(radio).toBeChecked();
      }
      if(size.width>768){
        const bounds=await pupil.getByRole('navigation',{name:'Navigasi pengerjaan'}).boundingBox();
        expect(bounds).not.toBeNull();expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(size.height);
      }
      await pupil.screenshot({path:`test-results/header-student-${size.width}.png`,fullPage:true});
    }
    await pupil.reload();await expect(image).toBeVisible();
    const session=await pupil.evaluate(()=>JSON.parse(localStorage.getItem('pkbm-cbt-session')!));
    const attempts=await (await request.get('/api/student/attempts',{headers:{Authorization:`Bearer ${session.accessToken}`}})).json();
    const own=attempts.find((row:any)=>row.assessmentId===form.resourceId);
    const payload=await (await request.get(`/api/student/attempts/${own.id}`,{headers:{Authorization:`Bearer ${session.accessToken}`}})).json();
    expect(payload.display.headerImage).toEqual({assetId:headerId,alt:'Header PKBM uji browser'});
    expect(JSON.stringify(payload)).not.toMatch(/correctIds|VALID123|explanation/);
  } finally {await student.close()}
});
