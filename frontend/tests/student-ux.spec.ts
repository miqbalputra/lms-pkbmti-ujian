import { test, expect, type Page } from '@playwright/test'
import { defaultQuestionConfig, questionTypes, type QuestionType } from '../src/questionTypes'

const session={accessToken:'student-ux-test',user:{id:'pupil',pesertaDidikId:'pupil',username:'0000000010',nama:'Siswa Paket A',role:'siswa'}}
const shapes=[{width:1600,height:600},{width:600,height:1400},{width:600,height:600}]
async function setup(page:Page,{authenticated=true,available=true,manual=false,expires=false,formsEnabled=true,kind='ujian_online',resume=false}={}) {
  const images:Buffer[]=[], saved=new Map<string,{answer:string;revision:number}>(), mediaCalls=new Map<string,number>()
  let submittedAt:string|undefined
  const deadline=new Date(Date.now()+(expires?5000:40*60000)).toISOString()
  const attachment=(id:string)=>({assetId:id,url:`/api/question-media/${id}`,kind:'image' as const,contentType:'image/png',alt:`Diagram ${id}`})
  const items=questionTypes.map(([type],index)=>{
    const config=defaultQuestionConfig(type)
    for(const key of ['correctIds','pairs','correctOrder','gridCorrect','gridMultiCorrect','correctNumber','acceptedAnswers','rubrik'])delete config[key]
    for(const row of config.statements||[])delete row.correct
    if(type==='pg_tunggal'||type==='pg_kompleks')config.choices[0].media=attachment('square')
    if(type==='menjodohkan'){config.left[0].media=attachment('square');config.right[0].media=attachment('portrait')}
    const stimulus=index<2?[{type:'text',title:'Bacaan bersama',content:'Baca gambar berikut sebelum menjawab. '.repeat(12)},{type:'image',...attachment('wide'),title:'Diagram lebar'},{type:'image',...attachment('portrait'),title:'Diagram vertikal'},{type:'table',content:JSON.stringify([['Hari','Nilai'],['Senin','10'],['Selasa','20']])}]:[]
    return {id:`i${index}`,position:index+1,flagged:false,answer:'',revision:0,question:{id:`q${index}`,title:`Soal ${index+1}`,prompt:`Pertanyaan ${type}`,type,points:1,config:{...config,stimulusGroupId:index<2?'shared':undefined},stimulus}}
  })
  const assessment={id:'assessment',title:'Asesmen matematika dengan gambar dan bacaan pendukung',kind,subjectName:'Matematika',className:'Paket A',durationMinute:40,accessCodeRequired:true,instructions:'Baca bahan, lalu jawab. Gunakan perbesar gambar jika perlu.'}
  const attempt=()=>({id:'attempt',assessmentId:'assessment',status:submittedAt?'completed':'started',deadlineAt:deadline})
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.slice(4),method=request.method()
    const json=(data:unknown)=>route.fulfill({json:data})
    if(path==='/public/config')return json({formsEnabled,studentUxEnabled:true})
    if(path==='/public/assessments/resolve')return json({assessments:[assessment]})
    if(path==='/public/assessments/login')return json(session)
    if(path==='/student/identity')return json({id:'pupil',name:'Siswa Paket A',nis:'10',nisn:'0000000010',className:'Paket A',learningGroup:'Kelompok pagi',gender:'P'})
    if(path==='/student/assessments')return json([assessment])
    if(path==='/student/attempts')return json(submittedAt||resume?[{...attempt(),title:assessment.title,kind:assessment.kind,resultAvailable:available,number:1}]:[])
    if(path.endsWith('/verify'))return json({verified:true,student:{id:'pupil',name:'Siswa Paket A',nisn:'0000000010',className:'Paket A'}})
    if(path.endsWith('/start'))return json(attempt())
    if(path==='/student/attempts/attempt')return json({attempt:attempt(),items:items.map(row=>({...row,...saved.get(row.id)})),serverTime:new Date().toISOString(),display:{title:assessment.title}})
    if(path.startsWith('/question-media/')){const id=path.split('/').pop()!;mediaCalls.set(id,(mediaCalls.get(id)||0)+1);const index=id==='portrait'?1:id==='square'?2:0;return route.fulfill({body:images[index],contentType:'image/png'})}
    if(path.endsWith('/answer')&&method==='PUT'){const id=path.split('/')[5],input=request.postDataJSON();saved.set(id,{answer:JSON.stringify(input.value),revision:input.revision+1});return json({revision:input.revision+1})}
    if(path.endsWith('/flag'))return json({ok:true})
    if(path.endsWith('/files')&&method==='POST')return json({id:'file',name:'jawaban.png',size:100,contentType:'image/png'})
    if(path.endsWith('/submit')){submittedAt='2026-10-10T04:00:00.000Z';return json({status:manual?'pending_grade':'completed',showResult:available,score:available?80:undefined})}
    if(path.endsWith('/results'))return json({attemptId:'attempt',title:assessment.title,kind:assessment.kind,submittedAt,available,pendingManual:manual,status:manual?'pending_grade':'completed',score:available?80:undefined,showReview:available,items:available?items.map(row=>({position:row.position,question:row.question,answer:saved.get(row.id)?.answer||'""',score:1,weight:1})):undefined})
    return route.fulfill({status:500,json:{error:`Unexpected ${method} ${path}`}})
  })
  await page.goto('/?masuk=staf')
  for(const shape of shapes){const base64=await page.evaluate(({width,height})=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#edf5fc';ctx.fillRect(0,0,width,height);ctx.strokeStyle='#256198';ctx.lineWidth=8;ctx.strokeRect(12,12,width-24,height-24);ctx.fillStyle='#172c43';ctx.font='32px sans-serif';ctx.fillText('Diagram pembelajaran',32,70);for(let n=1;n<5;n++){ctx.fillStyle=['#256198','#719cc4','#175483','#43647b'][n-1];ctx.fillRect(40*n+50,height/3,30,Math.min(height/2,n*50))}return canvas.toDataURL('image/png').split(',')[1]},shape);images.push(Buffer.from(base64,'base64'))}
  if(authenticated)await page.evaluate(s=>localStorage.setItem('pkbm-cbt-session',JSON.stringify(s)),session)
  return {saved,mediaCalls,items,images}
}

const viewports=[{width:375,height:812},{width:768,height:1024},{width:1440,height:900},{width:812,height:375},{width:320,height:812}]
async function dimensions(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();expect(await page.locator('.student-ux button,.student-image-dialog button').evaluateAll(nodes=>nodes.filter(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&(r.width<47.9||r.height<47.9)}).map(node=>node.textContent?.trim()))).toEqual([])}
async function shot(page:Page,name:string){
  const options={mask:[page.locator('.tka-time')],animations:'disabled' as const}
  if(process.platform==='win32')await expect(page).toHaveScreenshot(name,{...options,maxDiffPixelRatio:.001})
  else await test.info().attach(name,{body:await page.screenshot(options),contentType:'image/png'})
}
async function number(page:Page,n:number){await page.getByRole('button',{name:'Daftar Soal',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:new RegExp(`^Soal ${n},`)}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('heading',{name:`Soal nomor ${n} dari 15`,exact:true})).toBeVisible();await expect(page).toHaveURL(new RegExp(`soal=${n}(?:&|$)`))}

for(const viewport of viewports)test(`media, navigasi, palet dan zoom ${viewport.width}x${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport)
  const fixture=await setup(page)
  await page.goto('/siswa/upaya/attempt?soal=1')
  await expect(page.getByRole('heading',{name:'Soal nomor 1 dari 15'})).toBeVisible()
  await expect(page.getByAltText('Diagram wide')).toBeVisible()
  await expect(page.locator('.tka-stimulus')).toHaveAttribute('tabindex','0')
  await expect(page.locator('.tka-answer')).toHaveAttribute('tabindex','0')
  expect(await page.getByAltText('Diagram wide').evaluate(img=>{const image=img as HTMLImageElement;const r=image.getBoundingClientRect();return image.complete&&image.naturalWidth>0&&Math.abs(r.width/r.height-image.naturalWidth/image.naturalHeight)<.02})).toBeTruthy()
  await dimensions(page)
  await shot(page,`player-${viewport.width}-${viewport.height}.png`)
  if(viewport.width<1024){await page.getByRole('button',{name:'Ke pertanyaan ↓'}).click();await expect(page.locator('.tka-answer')).toBeFocused();await page.getByRole('button',{name:'↑ Kembali ke bahan'}).click();await expect(page.getByLabel('Bahan bacaan atau stimulus')).toBeFocused()}
  const expand=page.getByRole('button',{name:'Perbesar gambar: Diagram square'}).first()
  await expand.click()
  await expect(page.getByRole('dialog',{name:'Diagram square'})).toBeVisible()
  await page.getByRole('button',{name:'Perbesar lagi',exact:true}).click()
  await expect(page.getByText('150%',{exact:true})).toBeVisible()
  await shot(page,`zoom-${viewport.width}-${viewport.height}.png`)
  await page.getByRole('region',{name:'Detail gambar, dapat digeser'}).focus();await page.keyboard.press('ArrowRight');expect(await page.locator('.student-image-viewport').evaluate(node=>node.scrollLeft)).toBeGreaterThan(0)
  await page.getByRole('button',{name:'Sesuaikan layar'}).click()
  await page.keyboard.press('Escape')
  await expect(expand).toBeFocused()
  await expect(page.getByRole('radio',{name:/42/})).not.toBeChecked()
  await page.getByRole('radio',{name:/42/}).check()
  await expect.poll(()=>fixture.saved.size).toBe(1)
  await page.getByRole('button',{name:'Ukuran teks 22 piksel'}).click()
  await expect(page.locator('.tka-question-grid')).toHaveCSS('font-size','22px')
  if(viewport.width>=1024)await page.getByLabel('Bahan bacaan atau stimulus').evaluate(node=>{node.scrollTop=230})
  await page.getByRole('button',{name:'Daftar Soal',exact:true}).click()
  await shot(page,`palette-${viewport.width}-${viewport.height}.png`)
  await page.getByRole('dialog').getByRole('button',{name:'Soal 2, kosong'}).click()
  expect(fixture.mediaCalls.get('wide')).toBe(1)
  if(viewport.width>=1024)expect(await page.getByLabel('Bahan bacaan atau stimulus').evaluate(node=>node.scrollTop)).toBe(230)
  await page.reload()
  await expect(page.getByRole('heading',{name:'Soal nomor 2 dari 15'})).toBeVisible()
  await expect(page.getByRole('button',{name:'Ukuran teks 22 piksel'})).toHaveAttribute('aria-pressed','true')
  await number(page,1)
  await expect(page.getByRole('radio',{name:/42/})).toBeChecked()
})

for(const viewport of viewports.slice(0,3))test(`alur masuk sampai bukti dan hasil ${viewport.width}`,async({page})=>{
  await page.setViewportSize(viewport);await setup(page,{authenticated:false});await page.goto('/')
  await expect(page.getByRole('button',{name:'Lihat asesmen',exact:true})).toBeDisabled();await shot(page,`entry-${viewport.width}.png`)
  await page.getByLabel('Kode dari tutor').fill('KODE');await page.getByRole('button',{name:'Lihat asesmen',exact:true}).click();await shot(page,`choose-${viewport.width}.png`)
  await page.getByRole('button',{name:'Mulai Simulasi / Ujian'}).click();await page.getByLabel('NISN siswa').fill('0000000010');await shot(page,`login-${viewport.width}.png`);await page.getByRole('button',{name:'Login',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Konfirmasi data Peserta'})).toBeVisible();await shot(page,`identity-${viewport.width}.png`)
  await page.getByRole('button',{name:'Verifikasi & lanjutkan'}).click();await expect(page.getByRole('heading',{name:'Konfirmasi Tes'})).toBeVisible();await shot(page,`confirm-${viewport.width}.png`)
  await page.getByLabel(/Identitas saya benar/).check();await page.getByRole('button',{name:'Mulai tes',exact:true}).click();await expect(page.getByRole('heading',{name:'Soal nomor 1 dari 15'})).toBeVisible()
  await page.getByRole('button',{name:'Ragu-ragu',exact:true}).click()
  await page.getByRole('button',{name:'Daftar Soal',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Periksa & kirim',exact:true}).click()
  await expect(page.getByText('Ditandai ragu-ragu',{exact:true})).toBeVisible();await page.getByLabel(/Saya sudah memeriksa/).check();await page.getByRole('button',{name:'Kirim jawaban sekarang'}).click()
  await expect(page.getByRole('heading',{name:'Jawaban berhasil dikumpulkan'})).toBeVisible();await shot(page,`receipt-${viewport.width}.png`)
  await page.getByRole('button',{name:'Lihat hasil',exact:true}).click();await expect(page.getByText('80',{exact:true})).toBeVisible();await shot(page,`result-${viewport.width}.png`)
  await expect(page.locator('input[type=radio]').first()).toBeDisabled();await dimensions(page)
})

for(const viewport of viewports.slice(0,3))test(`semua 15 tipe, offline/resume dan gambar gagal ${viewport.width}`,async({page,context})=>{
  test.setTimeout(90000)
  await page.setViewportSize(viewport)
  const fixture=await setup(page);await page.goto('/siswa/upaya/attempt?soal=1')
  for(let index=0;index<questionTypes.length;index++){
    if(index)await number(page,index+1)
    const type=questionTypes[index][0] as QuestionType
    if(type==='pg_tunggal')await page.getByRole('radio',{name:/42/}).check()
    if(type==='pg_kompleks')await page.getByRole('checkbox',{name:/2\/4/}).check()
    if(type==='dropdown')await page.getByLabel('Pilih satu jawaban',{exact:true}).selectOption('opsi-1')
    if(type==='isian_singkat')await page.getByLabel('Jawaban singkat',{exact:true}).fill('42')
    if(type==='uraian')await page.getByLabel('Jawaban uraian',{exact:true}).fill('Jawaban dengan penjelasan siswa.')
    if(type==='benar_salah')await page.getByRole('radio',{name:'Matahari terbit dari arah timur.: Benar',exact:true}).check()
    if(type==='menjodohkan')await page.getByLabel('Pilih pasangan untuk Kucing').selectOption('kanan-2')
    if(type==='susun_urutan')await page.getByRole('button',{name:'Gunakan urutan yang tampil'}).click()
    if(type==='kisi_pg')await page.getByRole('radio',{name:'Memiliki tiga sisi: Segitiga',exact:true}).check()
    if(type==='kisi_checkbox')await page.getByRole('checkbox',{name:'Matahari: Terbarukan',exact:true}).check()
    if(type==='skala_linear'||type==='rating')await page.getByRole('radio',{name:'Nilai 4',exact:true}).click()
    if(type==='tanggal')await page.getByLabel('Pilih tanggal',{exact:true}).fill('2026-10-10')
    if(type==='waktu')await page.getByLabel('Pilih waktu',{exact:true}).fill('07:30')
    if(type==='unggah_berkas')await page.locator('input[type=file]').setInputFiles({name:'jawaban.png',mimeType:'image/png',buffer:fixture.images[2]})
    await expect.poll(()=>fixture.saved.has(`i${index}`)).toBeTruthy()
    await dimensions(page);await shot(page,`answer-${type}-${viewport.width}.png`)
  }
  await number(page,6);await context.setOffline(true);await page.getByLabel('Jawaban singkat',{exact:true}).fill('43');await expect(page.getByText(/Offline · 1 perubahan/)).toBeVisible();await context.setOffline(false);await expect.poll(()=>fixture.saved.get('i5')?.answer).toBe('"43"')
  await page.reload();await expect(page.getByLabel('Jawaban singkat',{exact:true})).toHaveValue('43')
  await page.route('**/api/question-media/wide',route=>route.fulfill({status:403,json:{error:'Forbidden'}}));await number(page,1)
  await expect(page.getByText('Media tidak tersedia untuk akun ini. Hubungi tutor.')).toBeVisible();await page.getByText('Media tidak tersedia untuk akun ini. Hubungi tutor.').scrollIntoViewIfNeeded();await shot(page,`media-forbidden-${viewport.width}.png`);await page.unroute('**/api/question-media/wide');await page.getByRole('button',{name:'Coba lagi',exact:true}).click();await expect(page.getByAltText('Diagram wide')).toBeVisible()
})

test('Simulasi menggunakan flag siswa tanpa mengaktifkan editor Forms, serta melanjutkan upaya aktif',async({page})=>{
  await setup(page,{formsEnabled:false,kind:'simulasi',resume:true})
  await page.goto('/siswa/asesmen/assessment?tahap=data')
  await expect(page.getByText('Simulasi latihan',{exact:true})).toBeVisible()
  await expect(page.getByLabel('Token asesmen')).toHaveValue('')
  await page.getByRole('button',{name:'Lanjutkan percobaan'}).click()
  await expect(page.getByRole('heading',{name:'Soal nomor 1 dari 15'})).toBeVisible()
  await expect(page.locator('.student-ux.tka-shell')).toBeVisible()
})

test('upaya aktif dapat dilanjutkan dari riwayat ketika paket tidak lagi tampil sebagai akses baru',async({page})=>{
  await setup(page,{resume:true})
  await page.route('**/api/student/assessments',route=>route.fulfill({json:[]}))
  await page.goto('/')
  await expect(page.getByRole('heading',{name:'Belum ada asesmen yang ditugaskan'})).toBeVisible()
  await page.getByRole('button',{name:'Lanjutkan pengerjaan',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Soal nomor 1 dari 15'})).toBeVisible()
  await expect(page).toHaveURL(/\/siswa\/upaya\/attempt/)
})

test('waktu habis menampilkan bukti tanpa membocorkan nilai yang belum dirilis',async({page})=>{
  await setup(page,{available:false,manual:true,expires:true});await page.goto('/siswa/upaya/attempt?soal=1')
  await expect(page.getByRole('heading',{name:'Jawaban berhasil dikumpulkan'})).toBeVisible({timeout:15000})
  await expect(page.getByText(/Sedang dinilai/)).toBeVisible();await page.getByRole('button',{name:'Lihat status hasil'}).click();await expect(page.locator('.student-result-score')).toHaveCount(0);await expect(page.locator('.student-result article')).toHaveCount(0)
})

test('hasil yang belum dirilis dan hasil gagal tidak menampilkan jawaban atau nilai',async({page})=>{
  await setup(page,{available:false});await page.goto('/siswa/hasil/attempt')
  await expect(page.getByText(/Hasil belum dirilis/)).toBeVisible();await expect(page.locator('.student-result-score')).toHaveCount(0);await expect(page.locator('.student-result article')).toHaveCount(0)
  await page.route('**/api/student/attempts/missing/results',route=>route.fulfill({status:404,json:{error:'Hasil tidak ditemukan'}}))
  await page.goto('/siswa/hasil/missing');await expect(page.getByRole('heading',{name:'Hasil belum dapat dibuka'})).toBeVisible();await expect(page.getByRole('button',{name:'Coba lagi',exact:true})).toBeVisible();await expect(page.locator('.student-result-score')).toHaveCount(0)
})

test('pengiriman berhasil tetap keluar dari pengerjaan ketika bukti gagal dimuat, retry tidak mengirim ulang',async({page})=>{
  await setup(page)
  let resultCalls=0,submitCalls=0
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/submit'))submitCalls++})
  await page.route('**/api/student/attempts/attempt/results',async route=>{
    resultCalls++
    if(resultCalls===1)return route.fulfill({status:503,json:{error:'Bukti belum dapat dimuat. Coba lagi.'}})
    return route.fulfill({json:{attemptId:'attempt',title:'Asesmen matematika',kind:'ujian_online',submittedAt:'2026-10-10T04:00:00.000Z',available:false,pendingManual:false,status:'completed'}})
  })
  await page.goto('/siswa/upaya/attempt?soal=15')
  await page.getByRole('button',{name:'Periksa & kirim',exact:true}).click()
  await page.getByLabel(/Saya sudah memeriksa/).check()
  await page.getByRole('button',{name:'Kirim jawaban sekarang'}).click()
  await expect(page).toHaveURL(/\/siswa\/hasil\/attempt\?tampilan=bukti/)
  await expect(page.getByRole('heading',{name:'Hasil belum dapat dibuka'})).toBeVisible()
  await expect(page.locator('.tka-answer')).toHaveCount(0)
  await page.getByRole('button',{name:'Coba lagi',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Jawaban berhasil dikumpulkan'})).toBeVisible()
  await expect(page.getByText(/Hasil belum dirilis/)).toBeVisible()
  expect(submitCalls).toBe(1);expect(resultCalls).toBe(2)
})

test('media lambat memiliki placeholder dan gambar header/opsi/stimulus tampil utuh',async({page})=>{
  const fixture=await setup(page);let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/student/attempts/attempt',route=>route.fulfill({json:{attempt:{id:'attempt',assessmentId:'assessment',status:'started',deadlineAt:new Date(Date.now()+3600000).toISOString()},items:fixture.items,serverTime:new Date().toISOString(),display:{title:'Asesmen',headerImage:{assetId:'square',alt:'Header asesmen'}}}}))
  await page.route('**/api/question-media/wide',async route=>{await waiting;await route.fulfill({body:fixture.images[0],contentType:'image/png'})})
  await page.goto('/siswa/upaya/attempt?soal=1');await expect(page.getByText('Memuat media…',{exact:true})).toBeVisible();await page.getByText('Memuat media…',{exact:true}).scrollIntoViewIfNeeded();await shot(page,'media-loading.png');release();await expect(page.getByAltText('Diagram wide')).toBeVisible()
  for(const alt of ['Diagram wide','Diagram portrait','Diagram square','Header asesmen'])expect(await page.getByAltText(alt,{exact:true}).first().evaluate(node=>{const image=node as HTMLImageElement,r=image.getBoundingClientRect();return image.complete&&image.naturalWidth>0&&getComputedStyle(image).objectFit==='contain'&&Math.abs(r.width/r.height-image.naturalWidth/image.naturalHeight)<.02})).toBeTruthy()
  await expect(page.getByRole('button',{name:'Perbesar gambar: Header asesmen'})).toBeVisible()
})

test('pratinjau tutor memakai renderer dan gambar yang sama tanpa membuat upaya siswa',async({page})=>{
  const fixture=await setup(page),mutations:string[]=[]
  await page.evaluate(s=>localStorage.setItem('pkbm-cbt-session',JSON.stringify({...s,user:{...s.user,role:'guru'}})),session)
  page.on('request',r=>{if(r.method()!=='GET'&&r.url().includes('/student/attempts'))mutations.push(r.url())})
  await page.route('**/api/staff/forms/package/package/preview',route=>route.fulfill({json:{title:'Pratinjau paket',items:fixture.items.map(item=>item.question),activeItemIds:fixture.items.map(item=>item.question.id),themeColor:'#326698',font:'sans-serif',progressBar:true,confirmationMessage:'Pratinjau selesai'}}))
  await page.goto('/editor/package/package/preview');await expect(page.getByText('Pratinjau — tidak direkam',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Perbesar gambar: Diagram square'}).click();await page.keyboard.press('Escape');await expect(page.getByRole('radio',{name:/42/})).not.toBeChecked();await page.getByRole('radio',{name:/42/}).check()
  await number(page,2);await expect(page.getByRole('heading',{name:'Soal nomor 2 dari 15'})).toBeVisible();expect(mutations).toEqual([])
})

test('pratinjau paket lama menggunakan gambar baru walaupun editor Forms nonaktif',async({page})=>{
  const fixture=await setup(page,{formsEnabled:false}),mutations:string[]=[]
  await page.evaluate(s=>localStorage.setItem('pkbm-cbt-session',JSON.stringify({...s,user:{...s.user,role:'guru'}})),session)
  page.on('request',request=>{if(request.method()!=='GET'&&request.url().includes('/api/'))mutations.push(request.url())})
  await page.route('**/api/staff/master/*',route=>route.fulfill({json:[]}))
  const question=fixture.items[0].question
  await page.route('**/api/staff/question-packages/package',route=>route.fulfill({json:{id:'package',title:'Paket soal lama',ownerId:'pupil',status:'draft',assignments:[],questions:[{...question,configJson:JSON.stringify(question.config),stimulusJson:JSON.stringify(question.stimulus)}]}}))
  await page.goto('/soal/paket/package/preview/q0')
  await expect(page.getByRole('heading',{name:'Soal 1',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Perbesar gambar: Diagram square'}).click()
  await expect(page.getByRole('dialog',{name:'Diagram square'})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('radio',{name:/42/})).not.toBeChecked()
  await page.getByRole('radio',{name:/42/}).check()
  expect(mutations).toEqual([])
})
