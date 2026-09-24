import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `e2e/*.spec.ts` matches vitest's default glob but is Playwright's; running it here would
    // fail on the missing `@playwright/test` runner rather than on anything real.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // vitest's default of five seconds is a budget per test *while every other file runs beside it*.
    // A dozen tests here paint the room or encode a clip and take two to four and a half seconds
    // on their own; on a four-core runner they starve whatever shares the cores. On windows-latest
    // / node 22 that tripped the default twice: a three-second ceiling paint, and then a DOM test
    // that takes milliseconds alone, on a commit that changed nothing but the version number.
    // A test that hangs still fails; one that waited its turn for a core no longer does.
    testTimeout: 20_000,
  },
});
