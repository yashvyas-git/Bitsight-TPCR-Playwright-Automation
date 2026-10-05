// @ts-check
import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Must match the path your login script saves to via storageState({ path: ... })
const authFile = 'playwright/.auth/user.json';

// Login script that runs before everything else
const loginSpec = /00_login_to_snow\.spec\.js/;

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.SN_URL,

    /* Collect trace when retrying the failed test. */
    trace: 'on-first-retry',
  },

  projects: [
    /* Logs in to ServiceNow once and saves the session for other projects */
    {
      name: 'setup',
      testMatch: loginSpec,
    },

    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: authFile,
      },
      dependencies: ['setup'],
      testIgnore: loginSpec, // don't run the login again as a normal test
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'], storageState: authFile },
    //   dependencies: ['setup'],
    //   testIgnore: loginSpec,
    // },
  ],
});