import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Trace Recorder Extension E2E Test Configuration
 */
export default defineConfig({
  testDir: './e2e',
  
  // Run tests in files in parallel
  fullyParallel: true,
  
  // Fail the build on CI if you accidentally passed test.only
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 2 : 0,
  
  // Run tests sequentially to avoid user data conflicts
  workers: 1,
  
  // Reporter to use
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results.json' }],
  ],
  
  // Shared settings for all projects
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    baseURL: 'http://localhost:8152',
    
    // Collect trace when running retries (disabled by default)
    trace: 'off',
    
    // Screenshot on failure
    screenshot: 'only-on-failure',
  },
  
  // Projects for Chrome with extension support
  projects: [
    {
      name: 'chrome-with-extension',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
