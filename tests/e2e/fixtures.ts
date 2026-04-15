import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({ context }, use) => {
    const pathToExtension = path.resolve(__dirname, '../../build');
    console.log(`Launching Chromium with extension from: ${pathToExtension}`);
    const userDataDir = path.resolve(__dirname, '../user-data');
    
    // Clean up user data directory if it exists
    if (fs.existsSync(userDataDir)) {
      console.log(`Cleaning up user data directory: ${userDataDir}`);
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`Could not clean user data directory: ${err}`);
      }
    }
    
    const newContext = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });
    await use(newContext);
  },
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background)
      background = await context.waitForEvent('serviceworker');
    const extensionId = background.url().split('/')[2];
    console.log(`Detected extension ID: ${extensionId}`);
    await use(extensionId);
  },
});
export const expect = test.expect;
