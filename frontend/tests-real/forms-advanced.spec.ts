import {test,expect,installSession,type APIRequestContext} from './fixtures';

async function owner(request:APIRequestContext){const r=await request.post('/api/auth/login',{data:{username:'e2e-owner',password:'CBT-E2E-password-ONLY-2026'}});expect(r.ok()).toBeTruthy();return r.json()}
test('real revision conflict: preserve offline draft, load server, recover as independent copy',async({page,request})=>{
  const account=await owner(request),headers={Authorization:`Bearer ${account.accessToken}`};
  const created=await request.post('/api/staff/forms/package',{headers,data:{}});expect(created.status()).toBe(201);const form=await created.json();
  await installSession(page.context(),account);
  await page.goto(`/editor/package/${form.resourceId}`);
  await page.getByLabel('Judul paket',{exact:true}).fill('Draf awal');
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  await page.context().setOffline(true);
  await page.getByLabel('Judul paket',{exact:true}).fill('Pekerjaan lokal yang dipertahankan');
  await expect(page.getByText('Offline — tersimpan lokal',{exact:true})).toBeVisible();
  const server=await (await request.get(`/api/staff/forms/package/${form.resourceId}`,{headers})).json();
  const replaced=await request.put(`/api/staff/forms/package/${form.resourceId}`,{headers,data:{revision:server.revision,content:{...server.content,title:'Versi server terbaru'}}});expect(replaced.ok()).toBeTruthy();
  await page.context().setOffline(false);
  await expect(page.getByText('Konflik versi',{exact:true})).toBeVisible({timeout:20000});
  await page.getByRole('button',{name:'Muat versi server (lokal dicadangkan)',exact:true}).click();
  await expect(page.getByLabel('Judul paket',{exact:true})).toHaveValue('Versi server terbaru',{timeout:20000});
  await page.reload();
  await expect(page.getByLabel('Judul paket',{exact:true})).toHaveValue('Versi server terbaru');
  await page.getByRole('button',{name:'Pulihkan sebagai salinan terpisah',exact:true}).click();
  await expect(page.getByLabel('Judul paket',{exact:true})).toHaveValue('Salinan Pekerjaan lokal yang dipertahankan');
  expect(new URL(page.url()).pathname).not.toContain(form.resourceId);
  expect((await (await request.get(`/api/staff/forms/package/${form.resourceId}`,{headers})).json()).content.title).toBe('Versi server terbaru');
});

test('real branching + prefilled link: account identity, skipped questions, held release and audited response edit',async({page,request,browser,watchUI})=>{
  const account=await owner(request),headers={Authorization:`Bearer ${account.accessToken}`};
  const form=await (await request.post('/api/staff/forms/assessment',{headers,data:{kind:'simulasi'}})).json();
  const classes=await (await request.get('/api/staff/master/classes',{headers})).json();
  const card=crypto.randomUUID(),skipped=crypto.randomUUID(),section=crypto.randomUUID();
  const code=`BRANCH${form.resourceId.slice(0,6)}`;
  const content={...form.content,title:'Jalur, isian awal dan revisi',settings:{...form.content.settings,classIds:classes.map((c:any)=>c.id),accessCode:code,showResult:true,resultsPolicy:'after_review',allowResponseEdit:true},sections:{[section]:{id:section,title:'Bagian yang dapat dilewati',description:'',position:1,deleted:false,next:''}},cards:{
    [card]:{id:card,type:'pg_tunggal',position:1,deleted:false,prompt:'Pilih jalur selesai',description:'',points:1,required:true,sectionId:'',stimulusGroupId:'',explanation:'',config:{choices:[{id:'done',text:'Selesai di sini'},{id:'next',text:'Ke bagian berikutnya'}],correctIds:['done'],branchToByAnswer:{done:'submit'}}},
    [skipped]:{id:skipped,type:'isian_singkat',position:2,deleted:false,prompt:'Soal wajib yang dilewati tidak dianggap kosong',description:'',points:20,required:true,sectionId:section,stimulusGroupId:'',explanation:'',config:{acceptedAnswers:['42']}}
  }};
  const saved=await request.put(`/api/staff/forms/assessment/${form.resourceId}`,{headers,data:{revision:form.revision,content}});expect(saved.ok()).toBeTruthy();
  await installSession(page.context(),account);
  await page.goto(`/editor/assessment/${form.resourceId}`);await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
  await page.getByRole('button',{name:'Terbitkan',exact:true}).click();await page.getByRole('button',{name:'Terbitkan versi ini',exact:true}).click();await expect(page.getByText('Baca-saja',{exact:true})).toBeVisible({timeout:20000});
  const link=await request.post(`/api/staff/forms/assessment/${form.resourceId}/links`,{headers,data:{prefill:{[card]:'done'}}});expect(link.status()).toBe(201);const access=await link.json();
  const context=await browser.newContext();watchUI(context);const pupil=await context.newPage();
  try{
    await pupil.goto(new URL(access.url).pathname);await pupil.getByRole('button',{name:'Mulai Simulasi / Ujian',exact:true}).click();await pupil.getByLabel('NISN siswa').fill('9090909001');await pupil.getByLabel('Kode akses').fill(code);await pupil.getByRole('button',{name:'Login',exact:true}).click();await pupil.getByRole('button',{name:'Verifikasi & lanjutkan',exact:true}).click();await pupil.getByRole('checkbox').check();await pupil.getByRole('button',{name:'Mulai tes',exact:true}).click();
    await expect(pupil.getByRole('radio',{name:/Selesai di sini/})).toBeChecked();
    await expect(pupil.getByRole('button',{name:'Soal berikutnya',exact:true})).toHaveCount(0);
    await expect(pupil.getByText('1 dari 1 soal terjawab',{exact:true})).toBeVisible();
    const attemptId=new URL(pupil.url()).pathname.split('/').at(-1)!;
    await pupil.getByRole('button',{name:'Periksa & kirim',exact:true}).click();await expect(pupil.getByRole('dialog')).not.toContainText('Soal wajib yang dilewati');await pupil.getByRole('checkbox',{name:'Saya sudah memeriksa jawaban dan mengerjakan asesmen ini sendiri.'}).check();await pupil.getByRole('button',{name:'Kirim jawaban sekarang',exact:true}).click();
    await expect(pupil.getByText(/Nilai:/)).toHaveCount(0);
    await expect(pupil).toHaveURL(new RegExp(`/siswa/hasil/${attemptId}$`));
    await expect(pupil.getByRole('button',{name:/Edit respons/})).toBeVisible();
    const result=await request.post(`/api/staff/forms/assessment/${form.resourceId}/result-release`,{headers,data:{}});expect(result.ok()).toBeTruthy();
    await pupil.reload();await expect(pupil.getByText(/Nilai:/)).toBeVisible();
    await pupil.getByRole('button',{name:/Edit respons/}).click();await expect(pupil.getByRole('heading',{name:'Soal nomor 1',exact:true})).toBeVisible();
    await pupil.getByRole('radio',{name:/Selesai di sini/}).check();
    await pupil.getByRole('button',{name:'Periksa & kirim',exact:true}).click();await pupil.getByRole('checkbox',{name:'Saya sudah memeriksa jawaban dan mengerjakan asesmen ini sendiri.'}).check();await pupil.getByRole('button',{name:'Kirim jawaban sekarang',exact:true}).click();
    await expect(pupil).toHaveURL(new RegExp(`/siswa/hasil/${attemptId}$`));
    await expect(pupil.getByText('Hasil belum dirilis oleh tutor.',{exact:true})).toBeVisible();
    await expect(pupil.getByText(/Nilai:/)).toHaveCount(0);
    const analysis=await (await request.get(`/api/staff/assessments/${form.resourceId}/item-analysis`,{headers})).json();expect(analysis.items.find((r:any)=>r.position===2).attemptCount).toBe(0);
  }finally{await context.close()}
});
