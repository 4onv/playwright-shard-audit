# Playwright Shard Audit

**Three green jobs can still miss a browser test.** Compare an unsharded Playwright test inventory with the inventories from each CI shard. Catch missing shard slots, duplicate receipts, missing tests, and tests assigned more than once.

The example below has three expected tests and three observed assignments. The totals match because the missing test is hidden by a duplicate.

```text
SYNTHETIC DEMO - invented test inventory
FAIL 3 expected tests, 3 observed assignments across 2 receipt(s) for 2 shard slots
MISSING   apply discount
REPEATED  sign in (slots 1 and 2)
```

Download `shard_audit.mjs` and try the one-command demo with Node.js 22+. The demo exits 0 and marks its invented data. [Release downloads](https://github.com/4onv/playwright-shard-audit/releases/latest)

```sh
node shard_audit.mjs demo
```

## Audit your Playwright shards

Copy `shard_reporter.cjs` and `shard_audit.mjs` from the release into your Playwright checkout. The reporter uses Playwright's reporter interface, so you can capture receipts with your existing installed version. The commands below use Bash and new output filenames.

```sh
mkdir -p .inventory
PLAYWRIGHT_SHARD_AUDIT_OUT=.inventory/baseline.json npx playwright test --list --no-deps --reporter=./shard_reporter.cjs
PLAYWRIGHT_SHARD_AUDIT_OUT=.inventory/shard-1.json npx playwright test --list --no-deps --reporter=./shard_reporter.cjs --shard=1/2
PLAYWRIGHT_SHARD_AUDIT_OUT=.inventory/shard-2.json npx playwright test --list --no-deps --reporter=./shard_reporter.cjs --shard=2/2
node shard_audit.mjs audit .inventory/baseline.json .inventory/shard-1.json .inventory/shard-2.json --json
```

In PowerShell set `$env:PLAYWRIGHT_SHARD_AUDIT_OUT` before invoking each capture. The reporter writes only after a successful Playwright result, and refuses to overwrite an existing receipt. Collection still loads the project's configuration and test modules. Capture only from projects you trust.

In CI, capture the baseline without a shard and capture each shard using its real matrix selection flags. Upload each receipt with a unique artifact name, then pass the baseline and all downloaded shard receipts to `audit` in a downstream job. Use the same checkout, Playwright version, and intended test selection throughout. An empty shard is fine if it supplies a receipt and every baseline instance appears exactly once overall.

| Exit | Result |
| --- | --- |
| 0 | Every declared shard supplied exactly one receipt, and every expected instance appeared exactly once. |
| 1 | A shard slot or test assignment is missing, repeated, or unexpected. |
| 2 | Inputs are unreadable, invalid, or incompatible. |

## What a receipt means

Each instance is identified by project name, source file relative to Playwright's root, suite title path, test title, and repeat index. Line numbers and durations do not affect identity. Shard slots and totals come directly from Playwright configuration. A missing test and a repeated test both show up even if the aggregate counts match.

This verifies collection, including what is selected by your flags. It does not prove tests ran, passed, or covered particular source code. Use `--no-deps` consistently for this audit to leave setup/dependency projects out of the exact partition. Playwright can schedule those projects separately on multiple shards for real runs.

Reports contain relative paths and titles. They omit absolute paths, attachments, logs, timings, and test results. Keep private filenames or titles in mind before sharing a report. Inputs are limited to 16 MiB per receipt and 64 MiB total, with at most 128 shard receipts. Tested with Playwright 1.65.0. [Playwright sharding](https://playwright.dev/docs/test-sharding) · [Reporter API](https://playwright.dev/docs/api/class-reporter)

## Run the native demo

```sh
npm ci --ignore-scripts
npm test
npm run test:native
```

The native demo uses actual Playwright collection across two projects, two repeats, and three shards. It then reuses a shard receipt to demonstrate the failure. The test names and fixtures are synthetic. No browsers are installed or started, and the fixture bodies would fail if they ran. [November 20 research](docs/research-2026-11-20.md)
