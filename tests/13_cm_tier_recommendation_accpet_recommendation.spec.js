// import { test, expect } from '@playwright/test';

// const SN_URL = process.env.SN_URL; // Loaded from .env file

// /**
//  * Reads value from a ServiceNow field element regardless of whether it renders as <select>, <input>, or <span>/<div>
//  */
// async function getFieldValue(locator) {
//     if ((await locator.count()) === 0) return '';
//     return await locator.first().evaluate((el) => {
//         const tag = el.tagName.toLowerCase();
//         if (tag === 'select') {
//             return el.options[el.selectedIndex]?.text || el.value;
//         }
//         if (tag === 'input' || tag === 'textarea') {
//             return el.value;
//         }
//         return el.innerText || el.textContent || '';
//     });
// }

// test('enable tier recommendation property, handle missing recommender field, accept recommendation, and verify', async ({ page }) => {
//     test.setTimeout(300_000);

//     // Step 1: Enable the Tier Recommendation property in Application Configuration
//     await test.step('enable tier recommendation property', async () => {
//         await page.goto('/', { waitUntil: 'domcontentloaded' });

//         const filter = page.getByRole('textbox', { name: 'Enter search term to filter' });
//         const allMenu = page
//             .getByRole('menuitem', { name: 'All', exact: true })
//             .or(page.getByText('All', { exact: true }))
//             .first();

//         await filter.or(allMenu).first().waitFor({ timeout: 30000 });

//         if (!(await filter.isVisible())) {
//             await allMenu.click();
//         }
//         await expect(filter).toBeVisible({ timeout: 10000 });
//         await filter.fill('Bitsight Third-Party Cyber Risk');

//         await page.waitForLoadState('networkidle');

//         const configLink = page
//             .getByRole('link', { name: /^Application Configuration/ })
//             .or(page.getByLabel(/^Application Configuration/));
//         await expect(configLink.first()).toBeVisible({ timeout: 15000 });
//         await configLink.first().click();

//         const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
//         await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

//         const frame = page.frameLocator('iframe[name="gsft_main"]');
//         const enableCheckbox = frame.locator('#tier_recomm_y');
//         const saveButton = frame.locator('#property_save_btn');

//         await expect(enableCheckbox).toBeVisible({ timeout: 15000 });
//         await expect(saveButton).toBeVisible({ timeout: 15000 });

//         // Check the enable checkbox (#tier_recomm_y) and save with retry safety
//         await expect(async () => {
//             await enableCheckbox.check();

//             await Promise.all([
//                 page.waitForResponse((res) => res.request().method() === 'POST' && res.ok(), { timeout: 15000 }),
//                 saveButton.click(),
//             ]);

//             const gsft = page.frame({ name: 'gsft_main' });
//             await gsft?.goto(gsft.url());
//             await gsft?.waitForLoadState('networkidle');
//             await expect(enableCheckbox).toBeChecked({ timeout: 5000 });
//         }).toPass({ timeout: 60000 });
//     });

//     // Step 2: Navigate directly to the filtered Portfolio view and open record
//     await test.step('navigate to filtered portfolio list and open first record', async () => {
//         const filteredPortfolioUrl = `${SN_URL}/now/nav/ui/classic/params/target/core_company_list.do%3Fsysparm_query%3Dx_bisit_bitsight_s_vendor_guidISNOTEMPTY%255Ex_bisit_bitsight_s_subscription_type%253DContinuous%2520Monitoring%255EORx_bisit_bitsight_s_subscription_type%253DRisk%2520Monitoring%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight`;

//         await page.goto(filteredPortfolioUrl);

//         const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
//         await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

//         const frame = page.frameLocator('iframe[name="gsft_main"]');

//         // Click the first matching record link in the list view
//         const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
//         await expect(firstRecordLink).toBeVisible({ timeout: 30000 });
//         await firstRecordLink.click();

//         // Wait for the company form page to load inside the frame and idle network
//         const gsft = page.frame({ name: 'gsft_main' });
//         await gsft?.waitForURL(/core_company\.do/i, { timeout: 30000 });
//         await gsft?.waitForLoadState('networkidle');
//     });

//     // Step 3: Check visibility of Bitsight Tier Recommender field, clear Third-party tier if hidden, and grab recommended value
//     let recommendedTierValue = '';
//     await test.step('ensure Bitsight Tier Recommender field is visible (resetting tier if needed)', async () => {
//         const frame = page.frameLocator('iframe[name="gsft_main"]');

//         const recommenderLabel = frame
//             .locator('.label-text, label, span.sn-tooltip-basic')
//             .filter({ hasText: /^Bitsight Tier Recommender$/ });

//         await page.frame({ name: 'gsft_main' })?.waitForLoadState('networkidle').catch(() => {});

//         // Check if Bitsight Tier Recommender field is visible initially
//         const isRecommenderVisible = await recommenderLabel.first().isVisible().catch(() => false);

//         if (!isRecommenderVisible) {
//             console.log('Bitsight Tier Recommender is not visible. Resetting Third-party tier to None...');

//             // Select 'None' ('') for Third-party tier
//             const thirdPartyTierSelect = frame.getByLabel('Third-party tier', { exact: true });
//             await expect(thirdPartyTierSelect).toBeVisible({ timeout: 15000 });
//             await thirdPartyTierSelect.selectOption('');

//             // Right-click form header to reveal ServiceNow context menu and click 'Save'
//             const formHeader = frame.locator('.form_header, .navbar-header, div.header-banner').first();
//             await formHeader.click({ button: 'right' });

//             const saveMenuItem = frame.getByRole('menuitem', { name: 'Save' });
//             await expect(saveMenuItem).toBeVisible({ timeout: 10000 });

//             await Promise.all([
//                 page.frame({ name: 'gsft_main' })?.waitForNavigation({ waitUntil: 'networkidle' }),
//                 saveMenuItem.click(),
//             ]);

//             // Re-wait for form to fully load after save
//             await page.frame({ name: 'gsft_main' })?.waitForLoadState('networkidle').catch(() => {});
//         }

//         // Assert that the Bitsight Tier Recommender field is now visible
//         await expect(recommenderLabel.first()).toBeVisible({ timeout: 20000 });

//         // Target the specific field/element for Bitsight Tier Recommender
//         const recommenderField = frame
//             .locator('select[name*="bitsight_s_tier_recommender"], input[name*="bitsight_s_tier_recommender"], [id*="bitsight_s_tier_recommender"]')
//             .filter({ hasNotText: /^$/ })
//             .first();

//         recommendedTierValue = await getFieldValue(recommenderField);

//         // Fallback: search label sibling element if element value is still empty
//         if (!recommendedTierValue) {
//             const formGroup = recommenderLabel.first().locator('xpath=ancestor::div[contains(@class,"form-group") or contains(@class,"row")][1]');
//             const valueElement = formGroup.locator('.form-control, span.readonly, div.form-control-static').first();
//             recommendedTierValue = await getFieldValue(valueElement);
//         }

//         console.log(`Recommended Tier Value captured: "${recommendedTierValue}"`);
//     });

//     // Step 4: Accept recommendation and confirm dialog
//     await test.step('click Accept recommendation and confirm modal', async () => {
//         const frame = page.frameLocator('iframe[name="gsft_main"]');

//         // Click "Accept recommendation" button
//         const acceptBtn = frame.getByRole('button', { name: 'Accept recommendation' });
//         await expect(acceptBtn.first()).toBeVisible({ timeout: 15000 });
//         await acceptBtn.first().click();

//         // Click "Yes" in confirmation popup
//         const yesBtn = frame.getByRole('button', { name: 'Yes' });
//         await expect(yesBtn.first()).toBeVisible({ timeout: 10000 });
//         await yesBtn.first().click();

//         await page.frame({ name: 'gsft_main' })?.waitForLoadState('networkidle').catch(() => {});
//     });

//     // Step 5: Verify Third-party tier populated and Bitsight Tier Recommender field is hidden
//     await test.step('verify Third-party tier matches recommendation and Bitsight Tier Recommender field is hidden', async () => {
//         const frame = page.frameLocator('iframe[name="gsft_main"]');

//         // 1. Verify Bitsight Tier Recommender field is NOT visible on the form layout anymore
//         const recommenderLabel = frame
//             .locator('.label-text, label, span.sn-tooltip-basic')
//             .filter({ hasText: /^Bitsight Tier Recommender$/ });

//         await expect(recommenderLabel.first()).toBeHidden({ timeout: 15000 });

//         // 2. Target the exact Third-party tier field element using explicit ServiceNow selectors
//         const tierField = frame.getByLabel('Third-party tier', { exact: true })
//             .or(frame.locator('select#core_company\\.vendor_tier'))
//             .or(frame.locator('select[name="core_company.vendor_tier"]'))
//             .first();

//         await expect(tierField).toBeVisible({ timeout: 15000 });

//         const populatedTier = await getFieldValue(tierField);

//         if (recommendedTierValue) {
//             expect(populatedTier.trim().toLowerCase()).toContain(recommendedTierValue.trim().toLowerCase());
//         } else {
//             expect(populatedTier.trim()).not.toBe('');
//             expect(populatedTier.trim().toLowerCase()).not.toBe('none');
//         }
//         console.log(`Third-party tier successfully updated to: "${populatedTier}"`);
//     });
// });


import { test, expect } from '@playwright/test';

const SN_URL = process.env.SN_URL;
const BITSIGHT_URL = process.env.BITSIGHT_URL || 'https://service.bitsighttech.com';
const BITSIGHT_EMAIL = process.env.BITSIGHT_EMAIL;
const BITSIGHT_PASSWORD = process.env.BITSIGHT_PASSWORD;

/**
 * Reads field value from a ServiceNow element regardless of tag type (<select>, <input>, or <span>/<div>)
 */
async function getFieldValue(locator) {
    if ((await locator.count()) === 0) return '';
    return await locator.first().evaluate((el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') {
            return el.options[el.selectedIndex]?.text || el.value;
        }
        if (tag === 'input' || tag === 'textarea') {
            return el.value;
        }
        return el.innerText || el.textContent || '';
    });
}

test('reorder BitSight tier settings and verify Mismatched Bitsight Tier Structure in ServiceNow', async ({ page }) => {
    test.setTimeout(360_000);

    // Step 1: Log in to BitSight Portal, navigate to Tier Settings, and reorder last tier to 2nd-to-last
    await test.step('reorder tier settings in BitSight portal', async () => {
        await page.goto(`${BITSIGHT_URL}/accounts/login/?next=/`);

        const emailInput = page.getByRole('textbox', { name: 'Email address' });
        await expect(emailInput).toBeVisible({ timeout: 20000 });
        await emailInput.fill(BITSIGHT_EMAIL);

        const passwordInput = page.getByRole('textbox', { name: 'Password' });
        await passwordInput.fill(BITSIGHT_PASSWORD);

        await page.getByRole('button', { name: 'Log In' }).click();

        // Wait for login redirection
        await page.waitForURL(/\/(tprm|app|dashboard|home|portfolio|tiers)/i, { timeout: 45000 });

        // Direct navigation to Tier Settings page
        await page.goto(`${BITSIGHT_URL}/app/tprm/tiers/`);

        // Target tier rows using container locator
        const tierContainer = page.locator('div > div:nth-child(5) > div');
        await tierContainer.first().waitFor({ state: 'visible', timeout: 30000 });

        let tierRows = tierContainer;
        let count = await tierRows.count();

        if (count === 1) {
            tierRows = tierContainer.locator('> div, > ul > li, > card');
            count = await tierRows.count();
        }

        expect(count, 'Expected at least 2 tier items in BitSight Tier Settings to reorder').toBeGreaterThanOrEqual(2);

        const lastTier = tierRows.nth(count - 1);
        const secondLastTier = tierRows.nth(count - 2);

        await expect(lastTier).toBeVisible({ timeout: 10000 });
        await expect(secondLastTier).toBeVisible({ timeout: 10000 });

        // Execute Drag and Drop via Mouse actions
        const lastBox = await lastTier.boundingBox();
        const secondLastBox = await secondLastTier.boundingBox();

        if (lastBox && secondLastBox) {
            const startX = lastBox.x + lastBox.width / 2;
            const startY = lastBox.y + lastBox.height / 2;
            const targetX = secondLastBox.x + secondLastBox.width / 2;
            const targetY = secondLastBox.y + secondLastBox.height / 2;

            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(targetX, targetY, { steps: 20 });
            await page.mouse.up();
        } else {
            await lastTier.dragTo(secondLastTier);
        }

        console.log('Successfully executed drag operations on BitSight Tier Settings.');
        await page.waitForTimeout(2000);
    });

    // Step 2: Enable Tier Recommendation property in ServiceNow Application Configuration
    await test.step('enable tier recommendation property in ServiceNow', async () => {
        // Direct module navigation to bypass Polaris Next Experience Shadow DOM menu tree issues
        const configPropertiesUrl = `${SN_URL}/now/nav/ui/classic/params/target/x_bisit_bitsight_s_bitsight_tpcr_properties.do`;
        
        await page.goto(configPropertiesUrl, { waitUntil: 'networkidle' });

        // Fallback UI Navigation if direct URL returns 404 or fails
        const gsftExists = await page.locator('iframe[name="gsft_main"]').count();
        if (gsftExists === 0) {
            await page.goto(SN_URL, { waitUntil: 'networkidle' });

            const filter = page.getByRole('textbox', { name: 'Enter search term to filter' })
                .or(page.locator('input[id*="filter"]'))
                .or(page.locator('input[placeholder*="Filter"]'));

            const allMenu = page.getByRole('menuitem', { name: 'All', exact: true })
                .or(page.getByText('All', { exact: true }))
                .first();

            if (await allMenu.isVisible()) {
                await allMenu.click();
            }

            await filter.first().waitFor({ state: 'visible', timeout: 20000 });
            await filter.first().fill('Bitsight Third-Party Cyber Risk');
            await page.waitForTimeout(1500); // Allow filter list to settle

            // Use direct text search locator to penetrate Shadow DOM structures
            const configLink = page.locator('a:has-text("Application Configuration"), div:has-text("Application Configuration")')
                .filter({ hasText: /^Application Configuration$/ });

            await configLink.first().waitFor({ state: 'visible', timeout: 20000 });
            await configLink.first().click();
        }

        const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]', { timeout: 30000 });
        const frameContent = await gsftHandle.contentFrame();
        await frameContent?.waitForLoadState('networkidle').catch(() => {});

        const frame = page.frameLocator('iframe[name="gsft_main"]');
        const enableCheckbox = frame.locator('#tier_recomm_y').or(frame.locator('input[name*="tier_recomm"]'));
        const saveButton = frame.locator('#property_save_btn').or(frame.locator('button:has-text("Save")'));

        await expect(enableCheckbox.first()).toBeVisible({ timeout: 20000 });
        await expect(saveButton.first()).toBeVisible({ timeout: 20000 });

        // Enable property and save
        await expect(async () => {
            await enableCheckbox.first().check();

            await Promise.all([
                page.waitForResponse((res) => res.request().method() === 'POST' && res.ok(), { timeout: 20000 }),
                saveButton.first().click(),
            ]);

            const gsft = page.frame({ name: 'gsft_main' });
            await gsft?.waitForLoadState('networkidle');
            await expect(enableCheckbox.first()).toBeChecked({ timeout: 5000 });
        }).toPass({ timeout: 60000 });
    });

    // Step 3: Open first record in Portfolio list and verify "Mismatched Bitsight Tier Structure"
    await test.step('navigate to portfolio list, open record, and verify tier structure mismatch', async () => {
        const filteredPortfolioUrl = `${SN_URL}/now/nav/ui/classic/params/target/core_company_list.do%3Fsysparm_query%3Dx_bisit_bitsight_s_vendor_guidISNOTEMPTY%255Ex_bisit_bitsight_s_subscription_type%253DContinuous%2520Monitoring%255EORx_bisit_bitsight_s_subscription_type%253DRisk%2520Monitoring%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight`;

        await page.goto(filteredPortfolioUrl, { waitUntil: 'networkidle' });

        const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]', { timeout: 30000 });
        const frameContent = await gsftHandle.contentFrame();
        await frameContent?.waitForLoadState('networkidle').catch(() => {});

        const frame = page.frameLocator('iframe[name="gsft_main"]');

        // Click first matching record link
        const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).or(frame.locator('a.linked')).first();
        await expect(firstRecordLink).toBeVisible({ timeout: 30000 });
        await firstRecordLink.click();

        // Wait for company form load
        const gsft = page.frame({ name: 'gsft_main' });
        await gsft?.waitForURL(/core_company\.do/i, { timeout: 30000 });
        await gsft?.waitForLoadState('networkidle');

        // Target Bitsight Tier Recommender field label
        const recommenderLabel = frame
            .locator('.label-text, label, span.sn-tooltip-basic')
            .filter({ hasText: /^Bitsight Tier Recommender$/ });

        await expect(
            recommenderLabel.first(),
            'FAIL: Bitsight Tier Recommender field is NOT visible on the form layout'
        ).toBeVisible({ timeout: 20000 });

        // Target field element
        const recommenderField = frame
            .locator('select[name*="bitsight_s_tier_recommender"], input[name*="bitsight_s_tier_recommender"], [id*="bitsight_s_tier_recommender"]')
            .first();

        let recommenderValue = await getFieldValue(recommenderField);

        if (!recommenderValue) {
            const formGroup = recommenderLabel.first().locator('xpath=ancestor::div[contains(@class,"form-group") or contains(@class,"row")][1]');
            const valueElement = formGroup.locator('.form-control, span.readonly, div.form-control-static').first();
            recommenderValue = await getFieldValue(valueElement);
        }

        console.log(`Bitsight Tier Recommender value found: "${recommenderValue}"`);

        const expectedMismatchText = 'Mismatched Bitsight Tier Structure';
        expect(
            recommenderValue,
            `FAIL: Expected field value to contain "${expectedMismatchText}", but got "${recommenderValue}"`
        ).toContain(expectedMismatchText);
    });
});
