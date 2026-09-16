const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: '.', testMatch: 'workflows.spec.js', workers: 1, timeout: 120000,
  reporter: [['list']],
  outputDir: '../../test-results/benchmarks',
  use: { baseURL: process.env.BASE_URL || 'http://localhost:3000' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'npx serve frontend -l 3000', cwd: '../..', port: 3000, reuseExistingServer: true }
});
