import { test, expect } from '@playwright/test';

const SN_URL = process.env.SN_URL; // loaded from .env by playwright.config.js

// Same filter as your GET script (encoded automatically by Playwright's `params`)
const COMPANY_QUERY =
    'x_bisit_bitsight_s_vendor_guidISNOTEMPTY' +
    '^x_bisit_bitsight_s_subscription_typeLIKEContinuous Monitoring' +
    '^ORx_bisit_bitsight_s_subscription_typeLIKERisk Monitoring';

// TODO: confirm these two field names against your instance
const GUID_FIELD = 'x_bisit_bitsight_s_vendor_contact_guid';
const PUSHED_FIELD = 'x_bisit_bitsight_s_vendor_contact_pushed';

const OPT_IN_JOB_NAME = 'Bitsight Vendor Contact Sync Opt-In';

/**
 * ServiceNow REST calls made with a browser session need the CSRF token (g_ck)
 * in the X-UserToken header. It is NOT stored in user.json (that file only has cookies),
 * so we read it from the logged-in page.
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
 * Opens a module of the "Bitsight Third-Party Cyber Risk" app from the navigator
 * (e.g. "Application Configuration", "Scheduled Jobs"). Works whether "All" is pinned or not.
 */
async function openBitsightModule(page, moduleName) {
    await page.goto('/');

    const filter = page.getByRole('textbox', { name: 'Enter search term to filter' });
    const allMenu = page
        .getByRole('menuitem', { name: 'All', exact: true })
        .or(page.getByText('All', { exact: true }))
        .first();

    // Wait until EITHER the filter box (pinned) or the "All" menu (not pinned) shows up
    await filter.or(allMenu).first().waitFor({ timeout: 30000 });
    if (!(await filter.isVisible())) {
        await allMenu.click();
    }
    await expect(filter).toBeVisible({ timeout: 10000 });
    await filter.fill('Bitsight Third-Party Cyber Risk');

    // Let the navigator's search actually run before we look for results
    await page.waitForTimeout(1500);

    // Match either how the nav exposes the item: as a link role OR via aria-label
    // (the label carries a "N of M" counter, so match on the start only)
    const startsWith = new RegExp(`^${moduleName}`);
    const links = page.getByRole('link', { name: startsWith }).or(page.getByLabel(startsWith));

    if ((await links.count()) === 0) {
        console.log(`No "${moduleName}" match. Filter value was:`, await filter.inputValue());
        const navText = await page.locator('body').innerText().catch(() => 'n/a');
        console.log('Visible page text (first 2000 chars):', navText.slice(0, 2000));
    }
    await expect(links.first()).toBeVisible({ timeout: 15000 });
    console.log(`"${moduleName}" links found:`, await links.allInnerTexts());
    await links.first().click();

    // Give gsft_main time to actually navigate before we look inside it
    const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
    await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));
    console.log(`gsft_main URL after opening "${moduleName}":`, page.frame({ name: 'gsft_main' })?.url());
}

/** Sets the "vendor contact sync" property to Yes (enabled) or No (disabled) and saves it. */
async function setVendorContactSync(page, enabled) {
    await openBitsightModule(page, 'Application Configuration');

    const frame = page.frameLocator('iframe[name="gsft_main"]');
    const syncCheckbox = frame.locator(enabled ? '#vendor_contact_sync_y' : '#vendor_contact_sync_n');
    const saveButton = frame.locator('#property_save_btn');
    await expect(syncCheckbox).toBeVisible({ timeout: 15000 });
    await expect(saveButton).toBeVisible({ timeout: 15000 });

    await expect(async () => {
        await syncCheckbox.check(); // no-op if already checked

        await Promise.all([
            page.waitForResponse((res) => res.request().method() === 'POST' && res.ok(), { timeout: 15000 }),
            saveButton.click(),
        ]);

        // Reload only the iframe so we read the saved value, not the stale DOM
        const gsft = page.frame({ name: 'gsft_main' });
        await gsft.goto(gsft.url());
        await expect(syncCheckbox).toBeChecked({ timeout: 5000 });
    }).toPass({ timeout: 60000 });

    console.log(`Vendor contact sync is now ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

/** Opens Scheduled Jobs, finds the opt-in job and clicks "Execute Now". */
async function executeOptInJob(page) {
    await openBitsightModule(page, 'Scheduled Jobs');

    const frame = page.frameLocator('iframe[name="gsft_main"]');

    const nameSearch = frame.getByRole('searchbox', { name: 'Search column: name' });
    await expect(nameSearch).toBeVisible({ timeout: 30000 });
    await nameSearch.fill(OPT_IN_JOB_NAME);
    await nameSearch.press('Enter');

    const jobLink = frame.getByRole('link', { name: `Open record: ${OPT_IN_JOB_NAME}` }).first();
    await expect(jobLink, `Scheduled job "${OPT_IN_JOB_NAME}" not found`).toBeVisible({ timeout: 15000 });
    await jobLink.click();

    const executeButton = frame.getByRole('button', { name: 'Execute Now' }).first();
    await expect(executeButton).toBeVisible({ timeout: 15000 });
    await executeButton.click();

    // Let the click register before we leave; the result is checked by polling the contact record
    await page.waitForTimeout(3000);
    console.log(`Executed job "${OPT_IN_JOB_NAME}"`);
}

test('contact is NOT pushed while sync is disabled, and IS pushed after enabling sync + running the opt-in job', async ({ page }) => {
    test.setTimeout(600_000);

    // ---------- 1. Disable the property in the UI ----------
    await test.step('disable vendor contact sync', async () => {
        await setVendorContactSync(page, false);
    });

    // ---------- 2. REST API calls using the saved session ----------
    // page.request shares cookies with the page's browser context, which was
    // loaded from playwright/.auth/user.json - so no username/password needed.
    const token = await getUserToken(page);
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-UserToken': token,
    };

    let companySysId;
    let contactSysId;

    await test.step('GET core_company -> take first sys_id', async () => {
        const res = await page.request.get(`${SN_URL}/api/now/table/core_company`, {
            headers,
            params: {
                sysparm_query: COMPANY_QUERY,
                sysparm_fields: 'sys_id,name',
                sysparm_limit: 1, // only the first company is needed
            },
        });
        expect(res.status(), await res.text()).toBe(200);

        const { result } = await res.json();
        expect(result.length, 'No core_company record matched the filter').toBeGreaterThan(0);

        companySysId = result[0].sys_id;
        console.log(`Using company: ${result[0].name} (${companySysId})`);
    });

    await test.step('POST vm_vdr_contact with that company', async () => {
        const res = await page.request.post(`${SN_URL}/api/now/table/vm_vdr_contact`, {
            headers,
            data: {
                first_name: 'John',
                last_name: 'Doe',
                company: companySysId,
                email: `johndoe+${Date.now()}@gmail.com`, // unique so re-runs don't collide
            },
        });
        expect(res.status(), await res.text()).toBe(201);

        const { result } = await res.json();
        expect(result.company?.value ?? result.company).toBe(companySysId);
        console.log(`Created vm_vdr_contact ${result.sys_id}`);

        contactSysId = result.sys_id;
    });

    await test.step('wait, then GET vm_vdr_contact and verify it was NOT pushed', async () => {
        await page.waitForTimeout(5000);

        const res = await page.request.get(`${SN_URL}/api/now/table/vm_vdr_contact/${contactSysId}`, {
            headers,
        });
        expect(res.status(), await res.text()).toBe(200);

        const { result } = await res.json();

        // Guard against a wrong field name: a misspelled key would read as undefined
        // and make the "empty GUID" check pass for the wrong reason.
        expect(result, `${GUID_FIELD} not found on record - check the field name`).toHaveProperty(GUID_FIELD);
        expect(result, `${PUSHED_FIELD} not found on record - check the field name`).toHaveProperty(PUSHED_FIELD);

        console.log(`Sync disabled -> guid: "${result[GUID_FIELD]}", pushed: "${result[PUSHED_FIELD]}"`);

        // Sync is disabled, so the contact should NOT have been sent to Bitsight
        expect(result[GUID_FIELD], 'GUID should be empty while sync is disabled').toBeFalsy();
        expect(String(result[PUSHED_FIELD]), 'pushed flag should be false while sync is disabled').toBe('false');
    });

    // ---------- 3. Enable sync again and run the opt-in job ----------
    await test.step('enable vendor contact sync', async () => {
        await setVendorContactSync(page, true);
    });

    await test.step('run the opt-in scheduled job', async () => {
        await executeOptInJob(page);
    });

    // ---------- 4. The contact must now be pushed ----------
    await test.step('poll vm_vdr_contact until GUID is populated and pushed is true', async () => {
        // The job runs asynchronously, so poll instead of using one fixed wait
        await expect(async () => {
            const res = await page.request.get(`${SN_URL}/api/now/table/vm_vdr_contact/${contactSysId}`, {
                headers,
            });
            expect(res.status(), await res.text()).toBe(200);

            const { result } = await res.json();
            const guid = result[GUID_FIELD];
            const pushed = result[PUSHED_FIELD];
            console.log(`After opt-in job -> guid: "${guid}", pushed: "${pushed}"`);

            expect(guid, 'GUID should be populated after the opt-in job').toBeTruthy();
            expect(String(pushed), 'pushed flag should be true after the opt-in job').toBe('true');
        }).toPass({ timeout: 180000, intervals: [5000, 10000, 15000] });
    });
});