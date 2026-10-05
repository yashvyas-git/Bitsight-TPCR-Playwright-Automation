import { test, expect } from '@playwright/test';

const SN_URL = process.env.SN_URL; // Loaded from .env file
const STATIC_BITSIGHT_VENDOR_GUID = 'ea4ec2d7-951a-4e0b-a7d9-317301c0aa61';

/**
 * Extracts ServiceNow CSRF token (g_ck) from active browser session.
 */
async function getUserToken(page) {
    let token = await page.evaluate(() => window.g_ck);
    if (!token) {
        const gsft = page.frame({ name: 'gsft_main' });
        token = gsft ? await gsft.evaluate(() => window.g_ck) : undefined;
    }
    if (!token) throw new Error('Could not read g_ck (X-UserToken) from the ServiceNow page');
    return token;
}

/**
 * Helper to locate field locator reliably by label or form-group container.
 */
async function getFormFieldLocator(frame, labelTextRegex) {
    const formFieldLabel = frame
        .locator('.label-text, label, span.sn-tooltip-basic')
        .filter({ hasText: labelTextRegex })
        .first();

    await expect(formFieldLabel).toBeVisible({ timeout: 15000 });

    const fieldId = await formFieldLabel.getAttribute('for');
    if (fieldId) {
        return frame.locator(`#${CSS.escape(fieldId)}`);
    }

    return frame
        .locator('div.form-group')
        .filter({ has: formFieldLabel })
        .locator('input, select, textarea, span.form-control, div.form-control-static')
        .first();
}

/**
 * Reads field value safely whether rendered as input value or static element text.
 */
async function getFieldValue(fieldLocator) {
    return await fieldLocator.evaluate((el) => {
        if ('value' in el && el.value !== undefined) {
            return el.value;
        }
        return el.textContent || '';
    });
}

test('verify Bitsight Tier Recommendation behavior upon setting vendor GUID', async ({ page, request }) => {
    test.setTimeout(300_000);

    let companySysId = '';
    let apiHeaders = {};

    try {
        // Step 1: Enable the Tier Recommendation property in Application Configuration
        await test.step('1. Enable Tier Recommendation property in Application Configuration', async () => {
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

        // Step 2: Query a REAL existing record from core_company
        await test.step('2. Fetch core_company with empty Bitsight Vendor GUID via REST API', async () => {
            const token = await getUserToken(page);
            apiHeaders = {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': token,
            };

            const response = await page.request.get(`${SN_URL}/api/now/table/core_company`, {
                headers: apiHeaders,
                params: {
                    sysparm_query: 'x_bisit_bitsight_s_vendor_guidISEMPTY^nameISNOTEMPTY',
                    sysparm_fields: 'sys_id,name,x_bisit_bitsight_s_vendor_guid',
                    sysparm_limit: 5,
                },
            });

            expect(response.status(), await response.text()).toBe(200);
            const { result } = await response.json();
            expect(result.length, 'No core_company record found with empty vendor GUID').toBeGreaterThan(0);

            // Filter out any record with invalid/missing sys_id
            const validCompany = result.find((rec) => rec.sys_id && rec.sys_id.length === 32);
            expect(validCompany, 'No valid 32-character sys_id found in result').toBeTruthy();

            companySysId = validCompany.sys_id;
            console.log(`Target company sys_id: ${companySysId} (${validCompany.name})`);
        });

        // Step 3: Open record in portfolio view and verify initial value
        await test.step('3. Navigate to portfolio record and verify "Vendor missing on Bitsight platform"', async () => {
            const recordUrl = `${SN_URL}/now/nav/ui/classic/params/target/core_company.do%3Fsys_id%3D${companySysId}%26sysparm_view%3Dbitsight`;
            await page.goto(recordUrl);

            const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
            await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

            const frame = page.frameLocator('iframe[name="gsft_main"]');
            const recommenderField = await getFormFieldLocator(frame, /^Bitsight Tier Recommender$/);

            const initialValue = await getFieldValue(recommenderField);
            expect(initialValue.trim()).toBe('Vendor missing on Bitsight platform');
        });

        // Step 4: Update Bitsight Vendor GUID using REST API
        await test.step('4. Update Bitsight Vendor GUID via REST API', async () => {
            const updateResponse = await page.request.patch(`${SN_URL}/api/now/table/core_company/${companySysId}`, {
                headers: apiHeaders,
                data: {
                    x_bisit_bitsight_s_vendor_guid: STATIC_BITSIGHT_VENDOR_GUID,
                },
            });

            expect(updateResponse.status(), await updateResponse.text()).toBe(200);
            const { result } = await updateResponse.json();
            expect(result.x_bisit_bitsight_s_vendor_guid).toBe(STATIC_BITSIGHT_VENDOR_GUID);
            console.log(`Successfully updated vendor GUID for ${companySysId} to ${STATIC_BITSIGHT_VENDOR_GUID}`);
        });

        // Steps 5, 6 & 7: Re-open record and verify field updated value (polling with page reload if needed)
        await test.step('5-7. Re-open record and verify Bitsight Tier Recommender updated value', async () => {
            const recordUrl = `${SN_URL}/now/nav/ui/classic/params/target/core_company.do%3Fsys_id%3D${companySysId}%26sysparm_view%3Dbitsight`;

            await expect(async () => {
                await page.goto(recordUrl);

                const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
                await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

                const frame = page.frameLocator('iframe[name="gsft_main"]');
                const recommenderField = await getFormFieldLocator(frame, /^Bitsight Tier Recommender$/);

                const updatedVal = (await getFieldValue(recommenderField)).trim();
                console.log(`Current Bitsight Tier Recommender value on form: "${updatedVal}"`);

                expect(updatedVal, 'Value should no longer be "Vendor missing on Bitsight platform"').not.toBe('Vendor missing on Bitsight platform');
            }).toPass({ timeout: 60000, intervals: [3000, 5000] });
        });
    } finally {
        // Step 8: Reset Vendor GUID back to empty in cleanup
        if (companySysId && apiHeaders['X-UserToken']) {
            await test.step('8. Restore original state (Clear Bitsight Vendor GUID)', async () => {
                console.log(`[Teardown] Resetting Bitsight vendor GUID to empty for sys_id: ${companySysId}`);
                const resetResponse = await request.patch(`${SN_URL}/api/now/table/core_company/${companySysId}`, {
                    headers: apiHeaders,
                    data: {
                        x_bisit_bitsight_s_vendor_guid: '',
                    },
                });

                expect(resetResponse.status(), await resetResponse.text()).toBe(200);
                const { result } = await resetResponse.json();
                expect(result.x_bisit_bitsight_s_vendor_guid).toBe('');
                console.log(`Successfully reset vendor GUID for ${companySysId} to empty.`);
            });
        }
    }
});