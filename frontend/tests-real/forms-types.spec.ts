import {test,expect,installSession} from './fixtures';
import {questionTypes} from '../src/questionTypes';

const fixturePassword='CBT-E2E-password-ONLY-2026';
test('real builder and student renderer: all 15 types, type/option dragging, snapshots, manual marking and reports',async({page,request,browser,watchUI})=>{
  test.setTimeout(180000);
  const login=await request.post('/api/auth/login',{data:{username:'e2e-owner',password:fixturePassword}});
  expect(login.ok()).toBeTruthy();const owner=await login.json();
  const headers={Authorization:`Bearer ${owner.accessToken}`};
  const created=await request.post('/api/staff/forms/assessment',{headers,data:{kind:'ujian_online'}});
  expect(created.status()).toBe(201);const form=await created.json();
  await installSession(page.context(),owner);
  await page.goto(`/editor/assessment/${form.resourceId}`);
  await page.getByLabel('Judul paket',{exact:true}).fill('Lima belas tipe - browser nyata');
  for(const [type,label] of questionTypes){
    await page.getByRole('button',{name:'Pilih jenis soal',exact:true}).click();
    if(type==='pg_tunggal'){
      await page.getByRole('button',{name:`Seret jenis ${label}`,exact:true}).dragTo(page.locator('[aria-label="Area tambah pertanyaan"]'));
    }else await page.getByRole('dialog').getByRole('button',{name:label,exact:true}).click();
    const card=page.locator('.form-question').last();
    await expect(card.getByLabel('Pertanyaan',{exact:true})).toHaveText('');
    await card.getByRole('button',{name:'Gunakan template untuk jenis ini'}).click();
    await card.getByLabel('Pertanyaan',{exact:true}).fill(`Pertanyaan ${type}`);
  }
  await expect(page.locator('.form-question')).toHaveCount(15);
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  const first=page.locator('.form-question').first();
  // Actual drag plus keyboard-operated alternative must both preserve IDs/keys.
  await first.getByRole('button',{name:/Seret item 1;/}).dragTo(first.getByRole('button',{name:/Seret item 2;/}));
  await expect.poll(()=>first.getByLabel('Teks pilihan 1',{exact:true}).count()).toBe(1);
  await expect(first.getByLabel('Teks pilihan 1',{exact:true})).toHaveValue('40');
  await first.getByRole('button',{name:'Pindahkan item 1 ke bawah',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(first.getByLabel('Teks pilihan 1',{exact:true})).toHaveValue('42');
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  await page.reload();
  await expect(page.locator('.form-question')).toHaveCount(15);
  await page.getByRole('button',{name:'Setelan',exact:true}).click();
  const code=`TYPE${form.resourceId.slice(0,6)}`;
  await page.getByLabel('Kode akses peserta',{exact:true}).fill(code);
  await page.getByRole('button',{name:'Atur peserta dari LMS'}).click();
  await page.getByRole('button',{name:'Pilih semua kelas',exact:true}).click();
  await page.getByRole('button',{name:'Tutup panel'}).click();
  await page.getByRole('checkbox',{name:'Tampilkan nilai setelah penilaian'}).check();
  await page.getByLabel('Rilis nilai',{exact:true}).selectOption('immediate');
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  await page.getByRole('button',{name:'Terbitkan',exact:true}).click();
  await page.getByRole('button',{name:'Terbitkan versi ini',exact:true}).click();
  await expect(page.getByText('Baca-saja',{exact:true})).toBeVisible({timeout:20000});

  const context=await browser.newContext();watchUI(context);const pupil=await context.newPage();
  try{
    await pupil.goto('/');await pupil.getByLabel('Kode dari tutor').fill(code);await pupil.getByRole('button',{name:'Lihat asesmen',exact:true}).click();await pupil.getByRole('button',{name:'Mulai Simulasi / Ujian',exact:true}).click();await pupil.getByLabel('NISN siswa').fill('9090909002');await pupil.getByRole('button',{name:'Login',exact:true}).click();await pupil.getByRole('button',{name:'Verifikasi & lanjutkan',exact:true}).click();await pupil.getByRole('checkbox').check();await pupil.getByRole('button',{name:'Mulai tes',exact:true}).click();
    const attemptId=await expect.poll(()=>new URL(pupil.url()).pathname).toMatch(/\/siswa\/upaya\//).then(()=>new URL(pupil.url()).pathname.split('/').at(-1)!);
    const account=await pupil.evaluate(()=>JSON.parse(localStorage.getItem('pkbm-cbt-session')||'{}'));
    const auth={Authorization:`Bearer ${account.accessToken}`};
    const payload=await (await request.get(`/api/student/attempts/${attemptId}`,{headers:auth})).json();
    expect(JSON.stringify(payload)).not.toMatch(/correctIds|acceptedAnswers|rubrik|correctOrder|gridCorrect|gridMultiCorrect|answerJson/);
    for(let i=0;i<questionTypes.length;i++){
      const [type]=questionTypes[i];await expect(pupil.getByRole('heading',{name:`Soal nomor ${i+1}`,exact:true})).toBeVisible();
      if(type==='pg_tunggal')await pupil.getByRole('radio',{name:/42/}).check();
      if(type==='pg_kompleks'){await pupil.getByRole('checkbox',{name:'2/4',exact:true}).check();await pupil.getByRole('checkbox',{name:'4/8',exact:true}).check();}
      if(type==='dropdown')await pupil.getByLabel('Pilih satu jawaban').selectOption({label:'sayur'});
      if(type==='benar_salah'){await pupil.getByRole('radio',{name:'Matahari terbit dari arah timur.: Benar',exact:true}).check();await pupil.getByRole('radio',{name:'Air laut rasanya tawar.: Salah',exact:true}).check();}
      if(type==='menjodohkan'){await pupil.getByLabel('Pilih pasangan untuk Kucing').selectOption({label:'Ikan'});await pupil.getByLabel('Pilih pasangan untuk Sapi').selectOption({label:'Rumput'});}
      if(type==='isian_singkat')await pupil.getByLabel('Jawaban singkat',{exact:true}).fill('42');
      if(type==='uraian')await pupil.getByLabel('Jawaban uraian',{exact:true}).fill('Penjelasan siswa dari browser nyata.');
      if(type==='susun_urutan')await pupil.getByRole('button',{name:'Gunakan urutan yang tampil'}).click();
      if(type==='kisi_pg'){await pupil.getByRole('radio',{name:'Memiliki tiga sisi: Segitiga',exact:true}).check();await pupil.getByRole('radio',{name:'Memiliki empat sisi sama panjang: Persegi',exact:true}).check();}
      if(type==='kisi_checkbox'){await pupil.getByRole('checkbox',{name:'Matahari: Terbarukan',exact:true}).check();await pupil.getByRole('checkbox',{name:'Batu bara: Tidak terbarukan',exact:true}).check();}
      if(type==='skala_linear')await pupil.getByRole('radio',{name:'Nilai 5',exact:true}).click();
      if(type==='rating')await pupil.getByRole('radio',{name:'Nilai 4',exact:true}).click();
      if(type==='tanggal')await pupil.getByLabel('Pilih tanggal',{exact:true}).fill('1945-11-10');
      if(type==='waktu')await pupil.getByLabel('Pilih waktu',{exact:true}).fill('07:30');
      if(type==='unggah_berkas')await pupil.locator('input[type=file]').setInputFiles({name:'jawaban.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=','base64')});
      await expect(pupil.getByRole('status').filter({hasText:'Tersimpan'})).toBeVisible({timeout:15000});
      for(const size of [{width:375,height:812},{width:768,height:1024},{width:1440,height:900}]){
        await pupil.setViewportSize(size);expect(await pupil.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
        await pupil.screenshot({path:`test-results/answer-${type}-${size.width}.png`,fullPage:true});
      }
      if(i<14)await pupil.getByRole('button',{name:'Soal berikutnya',exact:true}).click();
    }
    await pupil.getByRole('button',{name:'Periksa & kirim',exact:true}).click();await pupil.getByRole('checkbox',{name:'Saya sudah memeriksa jawaban dan mengerjakan asesmen ini sendiri.'}).check();await pupil.getByRole('button',{name:'Kirim jawaban sekarang',exact:true}).click();
    await expect.poll(async()=> (await (await request.get(`/api/staff/attempts/${attemptId}`,{headers})).json()).attempt.status).toBe('pending_grade');
    const detail=await (await request.get(`/api/staff/attempts/${attemptId}`,{headers})).json();
    // Grade through the actual Respons > Individu UI, not an API shortcut.
    await page.getByRole('button',{name:'Respons',exact:true}).click();
    await page.getByRole('button',{name:'Individu',exact:true}).click();
    await page.getByLabel('Pilih respons siswa',{exact:true}).selectOption(attemptId);
    for(const item of detail.items.filter((v:any)=>['uraian','unggah_berkas'].includes(v.question.type))){
      await page.getByLabel(`Nilai soal ${item.position}`,{exact:true}).fill(String(item.weight));
      await page.getByLabel(`Komentar soal ${item.position}`,{exact:true}).fill('Dinilai sesuai rubrik');
      await page.getByRole('button',{name:`Simpan penilaian soal ${item.position}`,exact:true}).click();
      await expect.poll(async()=> (await (await request.get(`/api/staff/attempts/${attemptId}`,{headers})).json()).items.find((v:any)=>v.itemId===item.itemId).manualScore).toBe(item.weight);
    }
    const fileDownload=page.waitForEvent('download');
    await page.getByRole('button',{name:'Unduh jawaban: jawaban.png',exact:true}).click();
    expect((await fileDownload).suggestedFilename()).toBe('jawaban.png');
    const result=await (await request.get(`/api/student/attempts/${attemptId}/results`,{headers:auth})).json();expect(result.available).toBe(true);expect(result.score).toBe(detail.items.reduce((sum:number,item:any)=>sum+item.weight,0));
    for(const format of ['csv','xlsx','pdf']){const r=await request.get(`/api/staff/assessments/${form.resourceId}/results/export.${format}`,{headers});expect(r.ok()).toBeTruthy();expect((await r.body()).length).toBeGreaterThan(100);}
  }finally{await context.close();}
});
