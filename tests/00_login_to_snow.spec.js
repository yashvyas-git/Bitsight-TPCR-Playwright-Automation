import { test, expect } from '@playwright/test';
import 'dotenv/config';

// All config comes from environment variables.
// Run with:
//   SN_URL='https://dev411280.service-now.com/' SN_USER='yash' SN_PASS='your-password' \
//   npx playwright test servicenow-login.spec.js --headed
const { SN_URL, SN_USER, SN_PASS } = process.env;

const authFile = 'playwright/.auth/user.json';

test('ServiceNow login', async ({ page }) => {
  test.setTimeout(300_000);
  //test.skip(!SN_URL || !SN_USER || !SN_PASS, 'Set SN_URL, SN_USER and SN_PASS environment variables');

  // Open the instance
  await page.goto(SN_URL);

  // Enter credentials
  await page.getByRole('textbox', { name: 'User name' }).fill(SN_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(SN_PASS);

  // Click Log in
  await page.getByRole('button', { name: 'Log in' }).click();

  // Login is successful if the "All" menu is visible
  const allMenu = page
            .getByRole('menuitem', { name: 'All', exact: true })
            .or(page.getByText('All', { exact: true }))
            .first();
  await expect(allMenu).toBeVisible({ timeout: 60000 });

  console.log('Login successful: "All" menu is visible');
  await page.context().storageState({ path: authFile});
});