import { expect, test as base } from '@playwright/test'
import type {Page} from '@playwright/test';

export { expect }
export type { Page }

export async function navigateStaff(page: Page, label: string) {
  const mobile = page.getByRole('navigation', { name: 'Navigasi cepat' }).getByRole('button', { name: label, exact: true })
  if (await mobile.isVisible().catch(() => false)) {
    await mobile.click()
    return
  }
  const desktop = page.getByRole('navigation', { name: 'Navigasi utama' }).getByRole('button', { name: label, exact: true })
  if (await desktop.isVisible().catch(() => false)) {
    await desktop.click()
    return
  }
  await page.getByRole('button', { name: 'Lainnya', exact: true }).click()
  await page.getByRole('dialog', { name: 'Menu lainnya' }).getByRole('button', { name: label, exact: true }).click()
}

// Legacy UI regression tests must not inherit flags from a live CBT API.
// Real PostgreSQL/WebSocket tests use their separate tests-real configuration.
export const test=base.extend<{legacyConfiguration:void}>({
  legacyConfiguration:[async({context},use)=>{
    await context.route('**/api/public/config',route=>route.fulfill({json:{formsEnabled:false}}));
    await use();
  },{auto:true}],
});
