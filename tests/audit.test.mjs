import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditInventories } from '../shard_audit.mjs';

const cli = fileURLToPath(new URL('../shard_audit.mjs', import.meta.url));
const testCase = (title, project = 'chromium', repeat = 0) => ({
  project, file: 'fixtures/shop.spec.ts', titles: ['cart', title], repeat,
});
const capture = (tests, shard = null, version = '1.65.0') => ({
  kind: 'playwright-shard-inventory', schemaVersion: 1, playwrightVersion: version, shard, tests,
});
const shard = (current, total, tests) => capture(tests, { current, total });

test('same title in two projects and repeat indices are separate assignments', () => {
  const a = testCase('list items');
  const b = testCase('list items', 'chromium', 1);
  const c = testCase('list items', 'firefox');
  const result = auditInventories(capture([a, b, c]), [shard(2, 2, [c, b]), shard(1, 2, [a])]);
  assert.equal(result.status, 'pass');
  assert.equal(result.observedAssignments, 3);
});

test('equal totals can hide a missing test and a repeated assignment', () => {
  const a = testCase('A');
  const b = testCase('B');
  const result = auditInventories(capture([a, b]), [shard(1, 2, [a]), shard(2, 2, [a])]);
  assert.equal(result.status, 'fail');
  assert.equal(result.expectedTests, result.observedAssignments);
  assert.deepEqual(result.missing, [b]);
  assert.deepEqual(result.repeated, [{ ...a, slots: [1, 2] }]);
});

test('missing and repeated slot receipts fail independently of the inventory union', () => {
  const a = testCase('A');
  const result = auditInventories(capture([a]), [shard(1, 2, [a]), shard(1, 2, [])]);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.repeated, []);
  assert.deepEqual(result.missingSlots, [2]);
  assert.deepEqual(result.repeatedSlots, [{ slot: 1, count: 2 }]);
});

test('empty shards are legal and unexpected tests are still reported', () => {
  const a = testCase('A');
  const b = testCase('B');
  assert.equal(auditInventories(capture([a]), [shard(1, 2, [a]), shard(2, 2, [])]).status, 'pass');
  const result = auditInventories(capture([a]), [shard(1, 2, [a]), shard(2, 2, [b])]);
  assert.deepEqual(result.unexpected, [{ ...b, slots: [2] }]);
});

test('key boundaries and title-path arrays do not collide', () => {
  const a = { ...testCase('A'), titles: ['x', 'y > z'] };
  const b = { ...testCase('A'), titles: ['x > y', 'z'] };
  const result = auditInventories(capture([a, b]), [shard(1, 2, [a]), shard(2, 2, [b])]);
  assert.equal(result.status, 'pass');
});

test('rejects mixed shard totals, version changes, and a sharded or empty baseline', () => {
  const a = testCase('A');
  assert.throws(() => auditInventories(capture([a]), [shard(1, 2, [a]), shard(2, 3, [])]), /shard total/u);
  assert.throws(() => auditInventories(capture([a]), [capture([a], { current: 1, total: 1 }, '1.64.0')]), /same Playwright version/u);
  assert.throws(() => auditInventories(shard(1, 1, [a]), [shard(1, 1, [a])]), /baseline must be unsharded/u);
  assert.throws(() => auditInventories(capture([]), [shard(1, 1, [a])]), /at least one test/u);
});

test('rejects duplicate identities inside a receipt and paths outside the root', () => {
  const a = testCase('A');
  assert.throws(() => auditInventories(capture([a, a]), [shard(1, 1, [a])]), /same test identity/u);
  for (const file of ['../fixture.ts', 'C:/fixture.ts', '/fixture.ts']) {
    assert.throws(() => auditInventories(capture([{ ...a, file }]), [shard(1, 1, [a])]), /Invalid test identity/u);
  }
});

test('CLI returns exact-coverage and invalid-input statuses with real files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shard-audit-cli-'));
  try {
    const a = testCase('A');
    const before = join(directory, 'baseline.json');
    const after = join(directory, 'shard one.json');
    await writeFile(before, JSON.stringify(capture([a])));
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    await writeFile(after, JSON.stringify(shard(1, 1, [a])));
    assert.equal(run('audit', before, after).status, 0);
    await writeFile(after, JSON.stringify(shard(1, 1, [])));
    const failed = run('audit', before, after, '--json');
    assert.equal(failed.status, 1, failed.stderr);
    assert.deepEqual(JSON.parse(failed.stdout).missing, [a]);
    await writeFile(after, Buffer.from([0xff]));
    assert.equal(run('audit', before, after).status, 2);
    assert.equal(run('audit', before).status, 2);
    assert.equal(JSON.parse(run('demo', '--json').stdout).synthetic, true);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
