const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './specs',
  fullyParallel: true,
  repeatEach: 2,
  projects: [{ name: 'desktop' }, { name: 'mobile' }],
});
