import {test as base} from '@playwright/test';
export {expect} from '@playwright/test';
export type {Page} from '@playwright/test';

// Legacy UI regression tests must not inherit flags from a live CBT API.
// Real PostgreSQL/WebSocket tests use their separate tests-real configuration.
export const test=base.extend<{legacyConfiguration:void}>({
  legacyConfiguration:[async({context},use)=>{
    await context.route('**/api/public/config',route=>route.fulfill({json:{formsEnabled:false}}));
    await use();
  },{auto:true}],
});
