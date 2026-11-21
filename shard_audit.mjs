#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_SHARDS = 128;
const MAX_TESTS = 50_000;
const KIND = 'playwright-shard-inventory';
const VERSION = '0.1.0';

const usage = [
  'Usage: node shard_audit.mjs audit BASELINE.json SHARD.json [SHARD.json ...] [--json]',
  '       node shard_audit.mjs demo [--json]',
  'Exit 0 for exact coverage, 1 for gaps or overlaps, 2 for invalid or incompatible inputs.',
].join('\n');

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function text(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0');
}

async function readReceipt(file, remaining) {
  try {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
      if (stat.size > remaining) throw new Error();
      const bytes = Buffer.allocUnsafe(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) throw new Error();
      const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
      return { document: JSON.parse(json), size: offset };
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error('Expected a readable, stable UTF-8 JSON receipt. Limits are 16 MiB per receipt and 64 MiB total.');
  }
}

function receipt(input) {
  if (input?.kind !== KIND || input.schemaVersion !== 1 ||
      !text(input.playwrightVersion, 1, 80) || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(input.playwrightVersion) ||
      !Array.isArray(input.tests) || input.tests.length > MAX_TESTS) {
    throw new Error('This is not a supported Playwright shard inventory.');
  }
  let shard = null;
  if (input.shard !== null) {
    const current = input.shard?.current;
    const total = input.shard?.total;
    if (!integer(total, 1, MAX_SHARDS) || !integer(current, 1, total)) {
      throw new Error('Invalid Playwright shard slot or total.');
    }
    shard = { current, total };
  }
  const tests = new Map();
  for (const row of input.tests) {
    if (!text(row?.project, 0, 200) || !text(row.file, 1, 1024) || /[\\:\u0000-\u001f]/u.test(row.file) ||
        row.file.split('/').some(part => part === '' || part === '.' || part === '..') ||
        !Array.isArray(row.titles) || !integer(row.titles.length, 1, 64) ||
        row.titles.some(title => !text(title, 0, 1024)) ||
        !integer(row.repeat, 0, Number.MAX_SAFE_INTEGER)) {
      throw new Error('Invalid test identity in shard inventory.');
    }
    const test = { project: row.project, file: row.file, titles: row.titles, repeat: row.repeat };
    const key = JSON.stringify([test.project, test.file, test.titles, test.repeat]);
    if (tests.has(key)) throw new Error('One receipt contains the same test identity more than once.');
    tests.set(key, test);
  }
  return { shard, tests, playwrightVersion: input.playwrightVersion };
}

export function auditInventories(baselineInput, shardInputs) {
  if (!Array.isArray(shardInputs) || !integer(shardInputs.length, 1, MAX_SHARDS)) {
    throw new Error('Supply between 1 and 128 shard inventories.');
  }
  const baseline = receipt(baselineInput);
  if (baseline.shard !== null || baseline.tests.size === 0) {
    throw new Error('The baseline must be unsharded and contain at least one test.');
  }
  const slots = new Map();
  const hits = new Map();
  let shardTotal;
  let observed = 0;
  for (const input of shardInputs) {
    const current = receipt(input);
    if (!current.shard || current.playwrightVersion !== baseline.playwrightVersion) {
      throw new Error('Use sharded receipts captured with the same Playwright version as the baseline.');
    }
    const slot = current.shard.current;
    shardTotal ??= current.shard.total;
    if (shardTotal !== current.shard.total) {
      throw new Error('Shard receipts disagree on the configured shard total.');
    }
    observed += current.tests.size;
    if (observed > 200_000) throw new Error('Shard inventories exceed 200,000 test assignments.');
    slots.set(slot, (slots.get(slot) ?? 0) + 1);
    for (const [key, test] of current.tests) {
      if (!hits.has(key)) hits.set(key, { test, slots: [] });
      hits.get(key).slots.push(slot);
    }
  }
  const missingSlots = [];
  const repeatedSlots = [];
  for (let slot = 1; slot <= shardTotal; slot++) {
    const count = slots.get(slot) ?? 0;
    if (count === 0) missingSlots.push(slot);
    if (count > 1) repeatedSlots.push({ slot, count });
  }
  const missing = [];
  const unexpected = [];
  const repeated = [];
  for (const key of [...baseline.tests.keys()].sort()) {
    if (!hits.has(key)) missing.push(baseline.tests.get(key));
  }
  for (const key of [...hits.keys()].sort()) {
    const row = hits.get(key);
    const evidence = { ...row.test, slots: row.slots.sort((a, b) => a - b) };
    if (!baseline.tests.has(key)) unexpected.push(evidence);
    if (evidence.slots.length > 1) repeated.push(evidence);
  }
  const failed = [missingSlots, repeatedSlots, missing, unexpected, repeated].some(rows => rows.length > 0);
  return {
    schemaVersion: 1, status: failed ? 'fail' : 'pass', playwrightVersion: baseline.playwrightVersion,
    shardTotal, receivedReceipts: shardInputs.length, expectedTests: baseline.tests.size,
    observedAssignments: observed, missingSlots, repeatedSlots, missing, unexpected, repeated,
  };
}

function demo() {
  const test = title => ({ project: 'chromium', file: 'synthetic.spec.ts', titles: [title], repeat: 0 });
  const baseline = {
    schemaVersion: 1, kind: KIND, playwrightVersion: '1.65.0',
    shard: null, tests: [test('sign in'), test('empty cart'), test('apply discount')],
  };
  const first = { ...baseline, shard: { current: 1, total: 2 }, tests: baseline.tests.slice(0, 2) };
  const second = { ...baseline, shard: { current: 2, total: 2 }, tests: [test('sign in')] };
  return { synthetic: true, ...auditInventories(baseline, [first, second]) };
}

function printReport(result) {
  if (result.synthetic) console.log('SYNTHETIC DEMO - invented test inventory');
  console.log(result.status.toUpperCase() + ' ' + result.expectedTests + ' expected tests, ' +
    result.observedAssignments + ' observed assignments across ' + result.receivedReceipts +
    ' receipt(s) for ' + result.shardTotal + ' shard slots');
  for (const slot of result.missingSlots) console.log('MISSING SLOT  ' + slot);
  for (const { slot, count } of result.repeatedSlots) console.log('REPEATED SLOT  ' + slot + ' (' + count + ' receipts)');
  for (const category of ['missing', 'unexpected', 'repeated']) {
    for (const row of result[category]) console.log(category.toUpperCase() + '  ' + JSON.stringify(row));
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.version) { console.log(VERSION); return; }
  if (values.help || !positionals.length) { console.log(usage); return; }
  const [command, baseline, ...paths] = positionals;
  let result;
  if (command === 'demo' && positionals.length === 1) result = demo();
  else if (command === 'audit' && baseline && integer(paths.length, 1, MAX_SHARDS)) {
    const baselineInput = await readReceipt(baseline, MAX_BATCH_BYTES);
    const inputs = [];
    let size = 0;
    let remaining = MAX_BATCH_BYTES - baselineInput.size;
    for (const file of paths) {
      const { document: input, size: bytes } = await readReceipt(file, remaining);
      remaining -= bytes;
      size += Array.isArray(input?.tests) ? input.tests.length : 0;
      if (size > 200_000) throw new Error('Shard inventories exceed 200,000 test assignments.');
      inputs.push(input);
    }
    result = auditInventories(baselineInput.document, inputs);
    process.exitCode = Number(result.status === 'fail');
  } else throw new Error(usage);
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('playwright-shard-audit: ' + (error.code?.startsWith('ERR_PARSE_ARGS') ? usage : error.message));
    process.exitCode = 2;
  });
}
