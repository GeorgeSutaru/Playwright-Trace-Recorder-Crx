# Playwright Trace Recorder Extension Tests

This directory contains E2E tests for the Playwright Trace Recorder Chrome extension.

## Test Structure

```
tests/
├── e2e/                    # End-to-end tests
│   ├── fixtures.ts         # Test fixtures and setup
│   ├── playwright.config.ts # Playwright configuration
│   ├── github-playwright-tracing.spec.ts    # Test with Playwright tracing
│   └── github-extension-tracing.spec.ts     # Test starting from extension UI
├── user-data/              # Chrome user data directory (created at runtime)
└── playwright-report/      # HTML test report (generated on failure)
```

## Test Types

### 1. Playwright Tracing (`github-playwright-tracing.spec.ts`)
Uses Playwright's built-in tracing to capture the recording session. This is useful for debugging test failures.

```bash
npx playwright test github-playwright-tracing.spec.ts --trace on
```

### 2. Extension Tracing (`github-extension-tracing.spec.ts`)
Starts recording directly from the extension UI without Playwright tracing. This tests the full extension workflow.

```bash
npx playwright test github-extension-tracing.spec.ts
```

## Running Tests

### Prerequisites
1. Build the extension first:
```bash
cd /Users/georgesutaru/Git/Ventriloquist/extension/Playwright-Trace-Recorder-Crx
bash build.sh
```

### Run All Tests
```bash
cd /Users/georgesutaru/Git/Ventriloquist/extension/Playwright-Trace-Recorder-Crx
npx playwright test
```

### Run Specific Test
```bash
npx playwright test tests/e2e/github-playwright-tracing.spec.ts
```

### Run with Trace
```bash
npx playwright test --trace on-first-retry
```

## Test Setup

The tests use a persistent browser context with the extension loaded:

1. Extension is loaded from `build/` directory
2. User data is stored in `tests/user-data/`
3. Tests open the side panel to interact with the extension

## Writing New Tests

1. Create a new `.spec.ts` file in `tests/e2e/`
2. Import from fixtures: `import { test, expect } from './fixtures';`
3. Use the provided fixtures: `page`, `context`, `extensionId`

Example:
```typescript
import { test, expect } from './fixtures';

test('should do something', async ({ page, context, extensionId }) => {
  await page.goto('https://example.com');
  // Your test code here
});
```
