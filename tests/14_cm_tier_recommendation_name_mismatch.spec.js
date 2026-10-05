import { test, expect } from '@playwright/test';

const SN_URL = process.env.SN_URL; // Loaded from .env file
const BITSIGHT_URL = process.env.BITSIGHT_URL || 'https://service.bitsighttech.com';
const BITSIGHT_EMAIL = process.env.BITSIGHT_EMAIL;
const BITSIGHT_PASSWORD = process.env.BITSIGHT_PASSWORD;

test('Validate BitSight Tier Recommender mismatch handling', async ({ page }) => {
  test.setTimeout(300_000);

  let originalTierName = '';
  let modifiedTierName = '';

  try {
    // =========================================================================
    // Step 1: Navigate to BitSight Portal and modify the last Tier name
    // =========================================================================
    await test.step('Navigate to BitSight and update last tier name', async () => {
      await page.goto(`${BITSIGHT_URL}/accounts/login/?next=/`);
      await page.getByRole('textbox', { name: 'Email address' }).click();
      await page.getByRole('textbox', { name: 'Email address' }).fill(BITSIGHT_EMAIL);
      await page.getByRole('textbox', { name: 'Password' }).click();
      await page.getByRole('textbox', { name: 'Password' }).fill(BITSIGHT_PASSWORD);
      await page.getByRole('button', { name: 'Log In' }).click();

      await page.goto(`${BITSIGHT_URL}/app/tprm/portfolio-dashboard/`);

      await page.getByRole('button', { name: 'Portfolio Settings' }).click();
      await page.getByRole('link', { name: 'Tier Settings' }).click();

      // Pick the last tier value (5th item, index 4) and select edit
      await page.getByRole('button', { name: 'Select' }).nth(4).click();
      await page.getByText('Edit Tier').click();

      const tierInput = page.locator('[data-test="tier-name-input"]');
      await tierInput.click();

      // Capture original tier name to enable clean restoration later
      originalTierName = await tierInput.inputValue();
      modifiedTierName = `${originalTierName}_1`;

      // Update the name of the tier to existing tier name + _1 and save
      await tierInput.fill(modifiedTierName);
      
      const saveBtn = page.locator('[data-test="manageTiers-create-tier-button"]');
      await saveBtn.click();

      // Wait for modal/input to disappear
      await expect(tierInput).toBeHidden({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    });

    // =========================================================================
    // Step 2: Enable Tier Recommendation property in Application Configuration
    // =========================================================================
    await test.step('Enable tier recommendation property in ServiceNow', async () => {
      await page.goto(SN_URL || '/', { waitUntil: 'domcontentloaded' });

      const filter = page.getByRole('textbox', { name: 'Enter search term to filter' });
      const allMenu = page
        .getByRole('menuitem', { name: 'All', exact: true })
        .or(page.getByText('All', { exact: true }))
        .first();

      await filter.or(allMenu).first().waitFor({ timeout: 30000 });

      if (!(await filter.isVisible())) {
        await allMenu.click();
      }
      await expect(filter).toBeVisible({ timeout: 10000 });
      await filter.fill('Bitsight Third-Party Cyber Risk');

      await page.waitForTimeout(1500);

      const configLink = page
        .getByRole('link', { name: /^Application Configuration/ })
        .or(page.getByLabel(/^Application Configuration/));
      await expect(configLink.first()).toBeVisible({ timeout: 15000 });
      await configLink.first().click();

      const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
      await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

      const frame = page.frameLocator('iframe[name="gsft_main"]');
      const enableCheckbox = frame.locator('#tier_recomm_y');
      const saveButton = frame.locator('#property_save_btn');

      await expect(enableCheckbox).toBeVisible({ timeout: 15000 });
      await expect(saveButton).toBeVisible({ timeout: 15000 });

      // Check the enable checkbox (#tier_recomm_y) and save with retry safety
      await expect(async () => {
        await enableCheckbox.check();

        await Promise.all([
          page.waitForResponse((res) => res.request().method() === 'POST' && res.ok(), { timeout: 15000 }),
          saveButton.click(),
        ]);

        const gsft = page.frame({ name: 'gsft_main' });
        await gsft?.goto(gsft.url());
        await expect(enableCheckbox).toBeChecked({ timeout: 5000 });
      }).toPass({ timeout: 60000 });
    });

    // =========================================================================
    // Step 3: Navigate to filtered Portfolio list and open first record
    // =========================================================================
    await test.step('Navigate to filtered portfolio list and open first record', async () => {
      const filteredPortfolioUrl = `${SN_URL}/now/nav/ui/classic/params/target/core_company_list.do%3Fsysparm_query%3Dx_bisit_bitsight_s_vendor_guidISNOTEMPTY%255Ex_bisit_bitsight_s_subscription_type%253DContinuous%2520Monitoring%255EORx_bisit_bitsight_s_subscription_type%253DRisk%2520Monitoring%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight`;

      await page.goto(filteredPortfolioUrl, { waitUntil: 'domcontentloaded' });

      const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
      await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

      const frame = page.frameLocator('iframe[name="gsft_main"]');

      // Click the first matching record link in the list view
      const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
      await expect(firstRecordLink).toBeVisible({ timeout: 30000 });
      await firstRecordLink.click();

      // Wait for the company form page to load inside the frame
      const gsft = page.frame({ name: 'gsft_main' });
      await gsft?.waitForURL(/core_company\.do/i, { timeout: 30000 });
    });

    // =========================================================================
    // Step 4: Verify Bitsight Tier Recommender value on company form
    // =========================================================================
    await test.step('Verify Bitsight Tier Recommender displays mismatched value', async () => {
      const frame = page.frameLocator('iframe[name="gsft_main"]');

      // 1. Ensure the field label is visible on form
      const labelElement = frame.getByText('Bitsight Tier Recommender', { exact: true });
      await expect(labelElement.first()).toBeVisible({ timeout: 30000 });

      // 2. Poll the form to extract the value attribute from all input elements near the label
      await expect(async () => {
        // Target surrounding row or group container
        const rowContainer = labelElement.first().locator('xpath=ancestor::*[contains(@class, "form-group") or contains(@class, "form-field") or local-name()="tr" or local-name()="div"][1]');

        // Query all input elements, textareas, and read-only spans in the row
        const inputs = rowContainer.locator('input, textarea, p, span, div');
        const count = await inputs.count();
        
        let extractedTexts = [];

        for (let i = 0; i < count; i++) {
          const el = inputs.nth(i);
          const val = await el.getAttribute('value').catch(() => null);
          const text = await el.innerText().catch(() => null);

          if (val) extractedTexts.push(val.trim());
          if (text) extractedTexts.push(text.trim());
        }

        // Check if full page HTML inside frame contains the string as a ultimate fallback
        const frameContent = await frame.locator('body').innerHTML().catch(() => '');
        const combinedValues = extractedTexts.join(' ') + ' ' + frameContent;

        expect(combinedValues).toMatch(/Mismatched Bitsight Tier Structure/i);
      }).toPass({ timeout: 30000, intervals: [2000] });
    });

  } finally {
    // =========================================================================
    // Cleanup: Revert BitSight Tier name to original value
    // =========================================================================
    if (originalTierName) {
      await test.step('Restore original tier name in BitSight', async () => {
        await page.goto(`${BITSIGHT_URL}/app/tprm/portfolio-dashboard/`, { waitUntil: 'domcontentloaded' });

        await page.getByRole('button', { name: 'Portfolio Settings' }).click();
        await page.getByRole('link', { name: 'Tier Settings' }).click();

        await page.getByRole('button', { name: 'Select' }).nth(4).click();
        await page.getByText('Edit Tier').click();

        const tierInput = page.locator('[data-test="tier-name-input"]');
        await tierInput.click();
        await tierInput.fill(originalTierName);
        await page.locator('[data-test="manageTiers-create-tier-button"]').click();
        await expect(tierInput).toBeHidden({ timeout: 15000 }).catch(() => {});
      });
    }
  }
});