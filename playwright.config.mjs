// Config Playwright — tests E2E navigateur contre un serveur statique local, Supabase SIMULÉ
// (page.route) pour rester deterministe et independant de la prod.
import { defineConfig, devices } from '@playwright/test';

const PORT = 8765;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'e2e', testMatch: 'e2e/**/*.spec.mjs', use: { ...devices['Desktop Chrome'] } },
    { name: 'a11y', testMatch: 'a11y/**/*.spec.mjs', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
