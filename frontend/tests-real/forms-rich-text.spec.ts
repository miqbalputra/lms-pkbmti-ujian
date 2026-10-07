import {test,expect,installSession} from './fixtures';

test('real in-place rich text: keyboard, safe paste, peer formatting, caret preservation and private undo',async({page,request,browser,watchUI})=>{
  const login=async(username:string)=>(await (await request.post('/api/auth/login',{data:{username,password:'CBT-E2E-password-ONLY-2026'}})).json());
  const owner=await login('e2e-owner'),editor=await login('e2e-editor'),headers={Authorization:`Bearer ${owner.accessToken}`};
  const form=await (await request.post('/api/staff/forms/package',{headers,data:{}})).json();
  expect((await request.put(`/api/staff/forms/package/${form.resourceId}/collaborators`,{headers,data:{username:'e2e-editor',role:'editor'}})).ok()).toBeTruthy();
  await installSession(page.context(),owner);
  await page.goto(`/editor/package/${form.resourceId}`);
  await page.getByLabel('Judul paket',{exact:true}).fill('Editor langsung - uji nyata');
  await page.getByRole('button',{name:'Tambah pertanyaan',exact:true}).first().click();
  const question=page.getByRole('textbox',{name:'Pertanyaan',exact:true});
  await question.fill('Bacaan bersama');
  const select=async(start:number,end:number)=>question.evaluate((host,{start,end})=>{
    host.focus();const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);const point=(index:number):[Node,number]=>{walker.currentNode=host;let node:Node|null;while((node=walker.nextNode())){if(index<=node.textContent!.length)return [node,index];index-=node.textContent!.length;}return [host,host.childNodes.length]};
    window.getSelection()!.setBaseAndExtent(...point(start),...point(end));host.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  },{start,end});
  await select(0,6);await page.getByRole('button',{name:'Tebal',exact:true}).click();
  await expect(question.locator('span').first()).toHaveCSS('font-weight','700');
  await question.press('Control+i');await expect(question.locator('span').first()).toHaveCSS('font-style','italic');
  await page.getByRole('button',{name:'Batalkan perubahan saya',exact:true}).click();
  await expect(question.locator('span').first()).toHaveCSS('font-style','normal');
  await expect(question.locator('span').first()).toHaveCSS('font-weight','700');
  await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});

  const context=await browser.newContext();
  watchUI(context);
  try{
    await installSession(context,editor);
    const peer=await context.newPage();await peer.goto(`/editor/package/${form.resourceId}`);
    const peerQuestion=peer.getByRole('textbox',{name:'Pertanyaan',exact:true});
    await expect(peerQuestion).toHaveText('Bacaan bersama');await expect(peerQuestion.locator('span').first()).toHaveCSS('font-weight','700');
    await select(14,14);
    await peerQuestion.focus();await peerQuestion.press('Control+Home');await peerQuestion.pressSequentially('Baru ');
    await expect(question).toHaveText('Baru Bacaan bersama');
    expect(await question.evaluate(host=>{const s=window.getSelection()!;const range=document.createRange();range.selectNodeContents(host);range.setEnd(s.focusNode!,s.focusOffset);return range.toString().length;})).toBe(19);
    await question.press('End');await question.press('Enter');await question.pressSequentially('Baris kedua');
    await expect(question).toHaveText('Baru Bacaan bersama\nBaris kedua');
    await question.evaluate(host=>{const data=new DataTransfer();data.setData('text/html','<img src="x" onerror="alert(1)">');data.setData('text/plain',' <img> literal');host.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
    await expect(question).toHaveText('Baru Bacaan bersama\nBaris kedua <img> literal');
    await expect(question.locator('img')).toHaveCount(0);
    await page.getByRole('checkbox',{name:'Gunakan teks sederhana',exact:true}).check();
    await expect(page.getByRole('textbox',{name:'Pertanyaan',exact:true})).toHaveValue('Baru Bacaan bersama\nBaris kedua <img> literal');
    await page.getByRole('checkbox',{name:'Gunakan teks sederhana',exact:true}).uncheck();
    await expect(question).toHaveText('Baru Bacaan bersama\nBaris kedua <img> literal');
    await expect(page.getByText('Tersimpan',{exact:true})).toBeVisible({timeout:20000});
    await page.reload();await expect(question).toContainText('<img> literal');await expect(question.locator('img')).toHaveCount(0);
    const saved=await (await request.get(`/api/staff/forms/package/${form.resourceId}`,{headers})).json();
    expect(Object.values(saved.content.cards).some((card:any)=>card.promptRich.some((p:any)=>p.attributes?.bold))).toBeTruthy();
  }finally{await context.close()}
});
