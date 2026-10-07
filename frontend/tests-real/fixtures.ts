import {test as base,expect,type BrowserContext} from '@playwright/test';
export {expect} from '@playwright/test';
export type {BrowserContext,APIRequestContext} from '@playwright/test';

export async function installSession(context:BrowserContext,user:unknown){
  await context.addInitScript(value=>{
    // Init scripts also run in about:blank/opaque documents. Never access
    // storage there, or send a fixture session to a different origin.
    if(location.origin==='http://127.0.0.1:4173')localStorage.setItem('pkbm-cbt-session',JSON.stringify(value));
  },user);
}

export const test=base.extend<{watchUI:(context:BrowserContext)=>void;uiErrors:void}>({
  watchUI:async({browserName},use,testInfo)=>{
    const errors:string[]=[];
    const seen=new WeakSet();
    const watch=(target:import('@playwright/test').Page)=>{
      if(seen.has(target))return;seen.add(target);
      target.on('pageerror',error=>errors.push(error.message));
      target.on('console',message=>{
        if(['warning','error'].includes(message.type())&&/useInsertionEffect|React.*(?:error|warn)|Can't perform.*state update|Each child.*unique|Minified React error/i.test(message.text()))errors.push(message.text());
      });
    };
    await use(context=>{for(const page of context.pages())watch(page);context.on('page',watch)});
    if(errors.length)await testInfo.attach('browser-ui-errors',{body:JSON.stringify(errors,null,2),contentType:'application/json'});
    expect(errors,`No unhandled browser exceptions or React lifecycle warnings (${browserName})`).toEqual([]);
  },
  uiErrors:[async({context,watchUI},use)=>{watchUI(context);await use()},{auto:true}],
});
