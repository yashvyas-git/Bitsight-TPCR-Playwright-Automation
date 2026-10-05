import { test, expect } from '@playwright/test';

const SN_URL = process.env.SN_URL; // Loaded from .env file

test('enable tier recommendation property and verify field visible on company form', async ({ page }) => {
    test.setTimeout(300_000);

    // Step 1: Enable the Tier Recommendation property in Application Configuration
    await test.step('enable tier recommendation property', async () => {
        await page.goto('/');

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

    // Step 2: Navigate directly to the filtered Portfolio view and open record
    await test.step('navigate to filtered portfolio list and open first record', async () => {
        const filteredPortfolioUrl = `${SN_URL}/now/nav/ui/classic/params/target/core_company_list.do%3Fsysparm_query%3Dx_bisit_bitsight_s_vendor_guidISNOTEMPTY%255Ex_bisit_bitsight_s_subscription_type%253DContinuous%2520Monitoring%255EORx_bisit_bitsight_s_subscription_type%253DRisk%2520Monitoring%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight`;

        await page.goto(filteredPortfolioUrl);

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
        await gsft?.waitForLoadState('domcontentloaded');
    });

    // Step 3: Verify the Bitsight Tier Recommender field is visible on the form layout
    await test.step('verify Bitsight Tier Recommender field is visible on form', async () => {
        const frame = page.frameLocator('iframe[name="gsft_main"]');

        // Target ServiceNow form field labels specifically (.label-text or label elements)
        const formFieldLabel = frame
            .locator('.label-text, label, span.sn-tooltip-basic')
            .filter({ hasText: /^Bitsight Tier Recommender$/ });

        // Assert that the field label IS visible on the form layout
        await expect(formFieldLabel.first()).toBeVisible({ timeout: 15000 });
    });
});