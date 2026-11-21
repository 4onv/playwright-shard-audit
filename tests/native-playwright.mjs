import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const native = process.argv[2] ?? join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const output = await mkdtemp(join(tmpdir(), 'playwright-shard-audit-'));
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
delete env.NODE_OPTIONS;

function run(args, allowed, overrides = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: { ...env, ...overrides }, windowsHide: true, encoding: 'utf8', timeout: 45_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, allowed, result.stdout + result.stderr);
  return result.stdout;
}

function capture(label, flags = [], status = 0) {
  const receipt = join(output, label + '.json');
  run([native, 'test', '--config=examples/playwright.config.cjs', '--list', '--no-deps',
    '--reporter=./shard_reporter.cjs', ...flags], status, { PLAYWRIGHT_SHARD_AUDIT_OUT: receipt });
  return receipt;
}

try {
  console.log('Synthetic fixture collected by real Playwright. No browsers or test bodies run.');
  const baseline = capture('baseline');
  const shards = [1, 2, 3].map(index => capture('shard-' + index, ['--shard=' + index + '/3']));
  const audit = (status, receipts) => JSON.parse(run([
    join(root, 'shard_audit.mjs'), 'audit', baseline, ...receipts, '--json',
  ], status));
  const passed = audit(0, shards);
  assert.equal(passed.expectedTests, 16);
  assert.equal(passed.observedAssignments, 16);
  assert.equal(passed.playwrightVersion, '1.65.0');
  const incomplete = audit(1, [shards[0], shards[0], shards[2]]);
  assert.deepEqual(incomplete.missingSlots, [2]);
  assert.deepEqual(incomplete.repeatedSlots, [{ slot: 1, count: 2 }]);
  assert.ok(incomplete.missing.length > 0 && incomplete.repeated.length > 0);
  const original = await readFile(baseline, 'utf8');
  capture('baseline', ['--project=desktop'], 1);
  assert.equal(await readFile(baseline, 'utf8'), original);
  console.log('16 real collected instances matched three declared slots. Reused slot and missing coverage failed as expected.');
} finally {
  await rm(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
