import { test, expect } from '@playwright/test';

const SN_URL = process.env.SN_URL; // loaded from .env by playwright.config.js
const BITSIGHT_URL = process.env.BITSIGHT_URL || 'https://service.bitsighttech.com';
const BITSIGHT_EMAIL = process.env.BITSIGHT_EMAIL;
const BITSIGHT_PASSWORD = process.env.BITSIGHT_PASSWORD;

// Same filter as your GET script (encoded automatically by Playwright's `params`)
const COMPANY_QUERY =
    'x_bisit_bitsight_s_vendor_guidISNOTEMPTY' +
    '^x_bisit_bitsight_s_subscription_typeLIKEContinuous Monitoring' +
    '^ORx_bisit_bitsight_s_subscription_typeLIKERisk Monitoring';

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

test('enable vendor contact sync, update a vendor contact, verify the name in Bitsight', async ({ page, browser }) => {
    test.setTimeout(300_000);

    // ---------- 1. Enable the property in the UI ----------
    await test.step('enable vendor contact sync', async () => {
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
        const syncCheckbox = frame.locator('#vendor_contact_sync_y'); // "Yes" option = sync enabled
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
    let updatedContactName; // the record's `name` (full name) after the update

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

    await test.step('GET first vm_vdr_contact of that company -> take sys_id + name', async () => {
        const res = await page.request.get(`${SN_URL}/api/now/table/vm_vdr_contact`, {
            headers,
            params: {
                sysparm_query: `company=${companySysId}`,
                sysparm_fields: 'sys_id,name,last_name',
                sysparm_limit: 1,
            },
        });
        expect(res.status(), await res.text()).toBe(200);

        const { result } = await res.json();
        expect(result.length, `No vm_vdr_contact found for company ${companySysId}`).toBeGreaterThan(0);

        contactSysId = result[0].sys_id;
        existingLastName = result[0].last_name ?? '';
        console.log(`Using vm_vdr_contact ${contactSysId} (name: "${result[0].name}", last_name: "${existingLastName}")`);
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

        // Full name as ServiceNow stores it - this is what Bitsight should show
        updatedContactName = (result.name ?? '').trim();
        expect(updatedContactName, 'name field should be populated').toBeTruthy();
        expect(updatedContactName, 'name should reflect the updated last name').toContain(newLastName);
        console.log(`Updated vm_vdr_contact ${contactSysId}: last_name "${existingLastName}" -> "${result.last_name}", name = "${updatedContactName}"`);
    });

    // ---------- 3. Verify the updated name in Bitsight ----------
    await test.step('verify updated contact name in Bitsight', async () => {
        if (!BITSIGHT_EMAIL || !BITSIGHT_PASSWORD) {
            throw new Error('Set BITSIGHT_EMAIL and BITSIGHT_PASSWORD in .env');
        }

        const expectedFullName = updatedContactName; // ServiceNow `name` field
        console.log(`Expecting Bitsight contact: "${expectedFullName}" under company "${companyName}"`);

        // Separate browser context so the ServiceNow session/cookies are not mixed in
        const bsContext = await browser.newContext();
        const bs = await bsContext.newPage();

        try {
            // --- Login ---
            await bs.goto(`${BITSIGHT_URL}/accounts/login/?next=/`);
            await bs.getByRole('textbox', { name: 'Email address' }).fill(BITSIGHT_EMAIL);
            await bs.getByRole('textbox', { name: 'Password' }).fill(BITSIGHT_PASSWORD);
            await bs.getByRole('button', { name: 'Log In' }).click();
            await bs.waitForURL((url) => !url.pathname.includes('/accounts/login'), { timeout: 60000 });

            // --- Navigate to Vendor Contacts ---
            await bs.goto(`${BITSIGHT_URL}/app/tprm/portfolio-dashboard/`);
            await bs.getByRole('button', { name: 'Collaboration' }).click();
            await bs.getByRole('link', { name: 'Vendor Contacts' }).click();

            // --- Company filter: pass the company name from ServiceNow ---
            await bs.locator('[data-test="filter-company_guid"]').getByRole('button', { name: 'Company' }).click();
            await bs.getByRole('button', { name: 'Selected' }).click(); // as recorded

            const menu = bs.locator('[data-test="dropdownMenu-menu"]');
            await menu.getByRole('searchbox', { name: 'search' }).fill(companyName);

            // Bitsight hides the real <input type="checkbox"> behind a styled <span>, so calling
            // .check() on the input is blocked ("span intercepts pointer events"). Click the visible
            // span instead - its data-test is "<company name>-checkbox-field".
            const companyCheckbox = menu.locator(
                `[data-test=${JSON.stringify(`${companyName}-checkbox-field`)}]`
            );
            await companyCheckbox.waitFor({ state: 'visible', timeout: 15000 });

            // A click toggles, so only click when it is not already checked
            const isChecked = async () => /\bchecked\b/.test((await companyCheckbox.getAttribute('class')) ?? '');
            if (!(await isChecked())) {
                await companyCheckbox.click({ timeout: 15000 });
            }
            await expect(companyCheckbox).toHaveClass(/\bchecked\b/, { timeout: 10000 });

            await bs.keyboard.press('Escape'); // close the dropdown so the table is usable

            // --- Contact search: retry, because the ServiceNow -> Bitsight sync is not instant ---
            const searchToggle = bs.locator('[data-test="bitsight-datatables-search-toggle"]');
            const searchBar = bs.locator('[data-test="bitsight-datatables-searchbar"]');
            const nameCell = bs.getByRole('cell', { name: expectedFullName, exact: true });

            await expect(async () => {
                // The search bar is hidden until the toggle is clicked. Only click when it is
                // closed, because clicking again while it is open could collapse it.
                if (!(await searchBar.isVisible())) {
                    await searchToggle.click({ timeout: 10000 });
                }
                await searchBar.fill('', { timeout: 10000 });
                await searchBar.fill(expectedFullName, { timeout: 10000 });
                await expect(
                    nameCell.first(),
                    `Contact "${expectedFullName}" not found in Bitsight yet`
                ).toBeVisible({ timeout: 5000 });
            }).toPass({ timeout: 180000, intervals: [5000, 10000, 15000] });

            // --- Compare: name shown in Bitsight must equal the name we set in ServiceNow ---
            const shownName = (await nameCell.first().innerText()).trim();
            console.log(`Bitsight shows: "${shownName}" | ServiceNow name: "${expectedFullName}"`);
            expect(shownName, 'Contact name in Bitsight should match ServiceNow').toBe(expectedFullName);
        } finally {
            await bsContext.close();
        }
    });
});