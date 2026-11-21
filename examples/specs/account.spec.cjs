const { test } = require('@playwright/test');

test.describe('Synthetic account fixture', () => {
  test.describe('sessions', () => {
    test('lists sessions', () => { throw new Error('This fixture is for --list collection only.'); });
  });
});
