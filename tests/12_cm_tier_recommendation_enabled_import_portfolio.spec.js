import { test, expect } from '@playwright/test';

const SN_URL = process.env.SN_URL; // Loaded from .env file
const COMPLETE_MESSAGE = 'Bitsight Portfolios Import complete';

/**
 * Parses ServiceNow GlideDateTime string ("YYYY-MM-DD HH:mm:ss") into epoch milliseconds.
 * Treats inputs as UTC to ensure relative epoch comparisons remain accurate.
 */
function toEpoch(dateStr) {
    if (!dateStr) return null;
    const isoStr = dateStr.replace(' ', 'T') + 'Z';
    const epoch = Date.parse(isoStr);
    return isNaN(epoch) ? null : epoch;
}

/**
 * ServiceNow REST fetch helper using browser page context to pass dynamic X-UserToken header
 */
async function snFetch(page, endpointUrl) {
    let token = await page.evaluate(() => window.g_ck);
    if (!token) {
        const gsft = page.frame({ name: 'gsft_main' });
        token = gsft ? await gsft.evaluate(() => window.g_ck) : undefined;
    }

    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };
    if (token) {
        headers['X-UserToken'] = token;
    }

    const fullUrl = endpointUrl.startsWith('http') ? endpointUrl : `${SN_URL}${endpointUrl}`;
    const response = await page.request.get(fullUrl, { headers });

    let body = null;
    try {
        body = await response.json();
    } catch (e) {
        body = await response.text();
    }

    return {
        ok: response.ok(),
        status: response.status(),
        body,
    };
}

/**
 * Polls syslog for a new import completion entry created strictly after baselineTimestamp
 */
async function waitForNewImportLog(page, baselineTimestamp, timeoutMs = 900_000, pollMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    const baselineEpoch = toEpoch(baselineTimestamp);
    let attempt = 0;

    const url = `/api/now/table/syslog?sysparm_query=` +
        `sourceSTARTSWITHx_bisit^sys_created_onONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)^messageLIKE${encodeURIComponent(COMPLETE_MESSAGE)}` +
        `^ORDERBYDESCsys_created_on` +
        `&sysparm_fields=message,sys_created_on&sysparm_limit=1`;

    while (Date.now() < deadline) {
        attempt++;
        console.log(`[waitForNewImportLog] Attempt ${attempt}: checking syslog for a new completion entry (polling every 2 mins)...`);

        const { ok, status, body } = await snFetch(page, url);

        if (ok && body?.result?.length > 0) {
            const entry = body.result[0];
            const entryEpoch = toEpoch(entry.sys_created_on);

            if (baselineEpoch === null || entryEpoch > baselineEpoch) {
                console.log(`[waitForNewImportLog] Found NEW completion log: "${entry.message}" at ${entry.sys_created_on}`);
                return true;
            } else {
                console.log(`[waitForNewImportLog] Latest log (${entry.sys_created_on}) is not newer than baseline (${baselineTimestamp}) yet.`);
            }
        } else if (ok) {
            console.log('[waitForNewImportLog] No matching log entry found yet.');
        } else {
            console.log(`[waitForNewImportLog] syslog query failed with status ${status}: ${JSON.stringify(body)}`);
        }

        // Wait 2 minutes (120,000 ms) before next poll
        await new Promise((r) => setTimeout(r, pollMs));
    }

    console.log('[waitForNewImportLog] Timed out waiting for a new import completion log.');
    return false;
}

test('enable tier recommendation, run portfolio import, poll logs every 2 mins, and verify field in list view', async ({ page }) => {
    test.setTimeout(900_000);

    // Step 1: Enable Tier Recommendation property in Application Configuration
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

    // Step 2: Record baseline log timestamp and run the import job
    let baselineTimestamp = null;
    await test.step('record baseline timestamp and execute scheduled portfolio import job', async () => {
        const initialQuery = `/api/now/table/syslog?sysparm_query=sourceSTARTSWITHx_bisit^messageLIKE${encodeURIComponent(COMPLETE_MESSAGE)}^ORDERBYDESCsys_created_on&sysparm_fields=sys_created_on&sysparm_limit=1`;
        const { ok, body } = await snFetch(page, initialQuery);

        if (ok && body?.result?.length > 0) {
            baselineTimestamp = body.result[0].sys_created_on;
            console.log(`Baseline log timestamp recorded: ${baselineTimestamp}`);
        } else {
            console.log('No prior completion log found today; proceeding with baselineTimestamp = null');
        }

        const importJobUrl = `${SN_URL}/now/nav/ui/classic/params/target/scheduled_import_set.do%3Fsys_id%3D3f813172c3712210c9281275e4013138`;
        await page.goto(importJobUrl);

        const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
        await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

        const frame = page.frameLocator('iframe[name="gsft_main"]');
        const executeBtn = frame.locator('#execute');

        await expect(executeBtn).toBeVisible({ timeout: 20000 });
        await executeBtn.click();
        console.log('Execute Now button clicked successfully.');
    });

    // Step 3: Poll syslog every 2 minutes
    await test.step('poll syslog API every 2 minutes for new import completion log', async () => {
        const logFound = await waitForNewImportLog(page, baselineTimestamp, 900_000, 120_000);
        expect(logFound, 'Timed out waiting for new "Bitsight Portfolios Import complete" log entry').toBe(true);
    });

    // Step 4: Verify visibility and population of Bitsight Tier Recommender in list view
    await test.step('verify Bitsight Tier Recommender column visibility and value population in list view', async () => {
        const filteredPortfolioUrl = `${SN_URL}/now/nav/ui/classic/params/target/core_company_list.do%3Fsysparm_query%3Dx_bisit_bitsight_s_vendor_guidISNOTEMPTY%255Ex_bisit_bitsight_s_subscription_type%253DContinuous%2520Monitoring%255EORx_bisit_bitsight_s_subscription_type%253DRisk%2520Monitoring%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight`;

        await page.goto(filteredPortfolioUrl);

        const gsftHandle = await page.waitForSelector('iframe[name="gsft_main"]');
        await gsftHandle.contentFrame().then((f) => f?.waitForLoadState('domcontentloaded'));

        const frame = page.frameLocator('iframe[name="gsft_main"]');

        await expect(frame.locator('table#core_company_table, .list_nav, div.list_div').first()).toBeVisible({ timeout: 30000 });

        const columnHeader = frame.locator('th, td.list_header_cell').filter({ hasText: /^Bitsight Tier Recommender$/i });

        let isColumnVisible = (await columnHeader.count()) > 0 && (await columnHeader.first().isVisible());

        if (!isColumnVisible) {
            console.log('"Bitsight Tier Recommender" column is not in list view. Opening Personalize List gear...');

            // Open Personalize List modal
            await frame.getByRole('button', { name: 'Update Personalized List' }).click();

            // Select field from Available slushbucket
            const availableSelect = frame.getByLabel('Available');
            await expect(availableSelect).toBeVisible({ timeout: 20000 });
            await availableSelect.selectOption('x_bisit_bitsight_s_tier_recommender');

            // Move to Selected slushbucket
            const addButton = frame.locator('button#add_to_selected, button[title*="Add"], #add_to_selected_list');
            if (await addButton.isVisible()) {
                await addButton.click();
            }

            // Click OK to apply and save personalization
            await frame.getByRole('button', { name: 'OK' }).click();

            // Wait for list reload
            await expect(frame.locator('table#core_company_table, div.list_div').first()).toBeVisible({ timeout: 30000 });
        } else {
            console.log('"Bitsight Tier Recommender" column is already present in list view.');
        }

        // Verify column header exists
        await expect(columnHeader.first()).toBeVisible({ timeout: 15000 });

        // Find table column index
        const headers = frame.locator('th.list_header_cell, th[data-column-name]');
        const headerCount = await headers.count();
        let columnIndex = -1;

        for (let i = 0; i < headerCount; i++) {
            const headerText = await headers.nth(i).innerText();
            if (headerText.trim().includes('Bitsight Tier Recommender')) {
                columnIndex = i;
                break;
            }
        }

        console.log(`"Bitsight Tier Recommender" column index in table: ${columnIndex}`);

        // Verify company data rows exist and at least one record has populated Tier Recommender data
        const rows = frame.locator('table#core_company_table tbody tr.list_row, table#core_company_table tr[sys_id]');
        await expect(rows.first()).toBeVisible({ timeout: 15000 });

        const rowCount = await rows.count();
        console.log(`Found ${rowCount} company records in list view.`);

        let populatedCount = 0;
        for (let i = 0; i < Math.min(rowCount, 10); i++) {
            const cells = rows.nth(i).locator('td');
            const cellText = columnIndex >= 0 ? (await cells.nth(columnIndex).innerText()).trim() : '';

            if (cellText && cellText !== '--' && cellText !== '(empty)') {
                populatedCount++;
                console.log(`Row ${i + 1}: Bitsight Tier Recommender = "${cellText}"`);
            }
        }

        expect(populatedCount, 'Expected at least one vendor record to have populated Tier Recommender value in list view').toBeGreaterThan(0);
        console.log(`Successfully verified ${populatedCount} vendor record(s) have populated Bitsight Tier Recommender values.`);
    });
});