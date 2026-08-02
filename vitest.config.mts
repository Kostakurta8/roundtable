import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `e2e/*.spec.ts` matches vitest's default glob but is Playwright's; running it here would
    // fail on the missing `@playwright/test` runner rather than on anything real.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
