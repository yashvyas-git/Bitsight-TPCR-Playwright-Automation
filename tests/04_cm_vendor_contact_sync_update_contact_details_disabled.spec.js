import { test, expect } from '@playwright/test';

const SN_URL = process.env.SN_URL; // loaded from .env by playwright.config.js

// Same filter as your GET script (encoded automatically by Playwright's `params`)
const COMPANY_QUERY =
    'x_bisit_bitsight_s_vendor_guidISNOTEMPTY' +
    '^x_bisit_bitsight_s_subscription_typeLIKEContinuous Monitoring' +
    '^ORx_bisit_bitsight_s_subscription_typeLIKERisk Monitoring';

// TODO: confirm these two field names against your instance (GET one vm_vdr_contact record
// without sysparm_fields and read the JSON keys). They are guesses following the
// x_bisit_bitsight_s_... pattern used on core_company.
const GUID_FIELD = 'x_bisit_bitsight_s_vendor_contact_guid';
const PUSHED_FIELD = 'x_bisit_bitsight_s_vendor_contact_pushed';

// How long to give the (disabled) sync to do something before we check that it did nothing
const SYNC_WAIT_MS = 10000;

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

test('disable vendor contact sync, update a vendor contact, verify it is NOT synced', async ({ page }) => {
    test.setTimeout(300_000);

    // ---------- 1. Disable the property in the UI ----------
    await test.step('disable vendor contact sync', async () => {
        await page.goto('/');

        const filter = page.getByRole('textbox', { name: 'Enter search term to filter' });
        const allMenu = page
            .getByRole('menuitem', { name: 'All', exact: true })
            .or(page.getByText('All', { exact: true }))
            .first();

        // Works whether "All" is pinned (filter already open) or not (need to click "All"):
        // wait until EITHER the filter box or the "All" menu shows up.
        await filter.or(allMenu).first().waitFor({ timeout: 30000 });

        if (!(await filter.isVisible())) {
            await allMenu.click();
        }
        await expect(filter).toBeVisible({ timeout: 10000 });
        await filter.fill('Bitsight Third-Party Cyber Risk');

        // Let the navigator's search actually run before we look for results
        await page.waitForTimeout(1500);

        // Match either how the nav exposes the item: as a link role OR via aria-label
        const links = page
            .getByRole('link', { name: /^Application Configuration/ })
            .or(page.getByLabel(/^Application Configuration/));
        const linkCount = await links.count();
        if (linkCount === 0) {
            // Nothing matched - dump whatever the nav is showing so we can see why
            console.log('No "Application Configuration" match. Filter value was:', await filter.inputValue());
            const navText = await page.locator('body').innerText().catch(() => 'n/a');
            console.log('Visible page text (first 2000 chars):', navText.slice(0, 2000));
        }
        await expect(links.first()).toBeVisible({ timeout: 15000 });
        console.log('Application Configuration links found:', await links.allInnerTexts());
        await links.first().click();

        // Give gsft_main time to actually navigate before we look inside it
        const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
        await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

        const gsft = page.frame({ name: 'gsft_main' });
        console.log('gsft_main URL after click:', gsft?.url());
        console.log('gsft_main title snippet:', (await gsft?.title().catch(() => 'n/a')));

        const frame = page.frameLocator('iframe[name="gsft_main"]');
        const syncCheckbox = frame.locator('#vendor_contact_sync_n'); // "No" option = sync disabled
        const saveButton = frame.locator('#property_save_btn');
        await expect(syncCheckbox).toBeVisible({ timeout: 15000 });
        await expect(saveButton).toBeVisible({ timeout: 15000 });

        await expect(async () => {
            await syncCheckbox.check();

            await Promise.all([
                page.waitForResponse((res) => res.request().method() === 'POST' && res.ok(), { timeout: 15000 }),
                saveButton.click(),
            ]);

            const gsft = page.frame({ name: 'gsft_main' });
            await gsft.goto(gsft.url());
            await expect(syncCheckbox).toBeChecked({ timeout: 5000 });
        }).toPass({ timeout: 60000 });
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

    // Declared up-front so every step can share them
    let companySysId;
    let companyName;
    let contactSysId;
    let existingLastName;
    let newLastName;
    let before = {}; // GUID / pushed state of the contact BEFORE we update it (for diagnosis)

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
        companyName = result[0].name;
        console.log(`Using company: ${companyName} (${companySysId})`);
    });

    await test.step('GET first vm_vdr_contact of that company -> take sys_id + last_name', async () => {
        const res = await page.request.get(`${SN_URL}/api/now/table/vm_vdr_contact`, {
            headers,
            params: {
                sysparm_query: `company=${companySysId}`,
                sysparm_fields: `sys_id,name,last_name,${GUID_FIELD},${PUSHED_FIELD}`,
                sysparm_limit: 1,
            },
        });
        expect(res.status(), await res.text()).toBe(200);

        const { result } = await res.json();
        expect(result.length, `No vm_vdr_contact found for company ${companySysId}`).toBeGreaterThan(0);

        contactSysId = result[0].sys_id;
        existingLastName = result[0].last_name ?? '';
        before = { guid: result[0][GUID_FIELD], pushed: result[0][PUSHED_FIELD] };
        console.log(
            `Using vm_vdr_contact ${contactSysId} (name: "${result[0].name}", last_name: "${existingLastName}")`,
            `| BEFORE update -> guid: "${before.guid}", pushed: "${before.pushed}"`
        );
    });

    await test.step('PATCH vm_vdr_contact last_name = existing + "-1"', async () => {
        newLastName = `${existingLastName}-1`;

        const res = await page.request.patch(`${SN_URL}/api/now/table/vm_vdr_contact/${contactSysId}`, {
            headers,
            data: { last_name: newLastName },
        });
        expect(res.status(), await res.text()).toBe(200);

        const { result } = await res.json();
        expect(result.last_name, 'last_name should be updated').toBe(newLastName);
        console.log(`Updated vm_vdr_contact ${contactSysId}: last_name "${existingLastName}" -> "${result.last_name}"`);
    });

    await test.step('GET the same vm_vdr_contact and verify GUID is empty + pushed is false', async () => {
        // Give the (disabled) sync a chance to run, so "nothing happened" actually means something
        await page.waitForTimeout(SYNC_WAIT_MS);

        const res = await page.request.get(`${SN_URL}/api/now/table/vm_vdr_contact/${contactSysId}`, {
            headers,
        });
        expect(res.status(), await res.text()).toBe(200);

        const { result } = await res.json();

        // Guard against a wrong field name: a misspelled key reads as undefined and would make
        // the "GUID is empty" check pass for the wrong reason.
        expect(result, `${GUID_FIELD} not found on record - check the field name`).toHaveProperty(GUID_FIELD);
        expect(result, `${PUSHED_FIELD} not found on record - check the field name`).toHaveProperty(PUSHED_FIELD);

        const guid = result[GUID_FIELD];
        const pushed = result[PUSHED_FIELD];
        console.log(`AFTER update -> guid: "${guid}", pushed: "${pushed}"`);

        // Sync is disabled, so the contact must NOT have been sent to Bitsight
        expect(
            guid,
            `Vendor contact GUID should be empty (it was "${before.guid}" before the update)`
        ).toBeFalsy();
        expect(
            String(pushed),
            `Vendor contact pushed should be false (it was "${before.pushed}" before the update)`
        ).toBe('false');
    });
});