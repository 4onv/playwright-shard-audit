const { test } = require('@playwright/test');

// Synthetic collection fixture. Each body fails if accidentally executed.
test.describe('Synthetic shop fixture', () => {
  for (const title of ['checks cart', 'shows inventory', 'calculates totals']) {
    test(title, () => { throw new Error('This fixture is for --list collection only.'); });
  }
});
