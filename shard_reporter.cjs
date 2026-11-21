const { writeFile } = require('node:fs/promises');
const path = require('node:path');

class ShardAuditReporter {
  printsToStdio() {
    return false;
  }

  onBegin(config, suite) {
    try {
      const tests = suite.allTests().map(test => {
        const file = path.relative(config.rootDir, test.location.file).split(path.sep).join('/');
        if (!file || file === '..' || file.startsWith('../') || path.isAbsolute(file)) {
          throw new Error('A test file is outside Playwright rootDir.');
        }
        const titles = [test.title];
        for (let parent = test.parent; parent?.type === 'describe'; parent = parent.parent) {
          titles.unshift(parent.title);
        }
        const project = test.parent.project();
        if (!project) throw new Error('A collected test has no project.');
        return { project: project.name, file, titles, repeat: test.repeatEachIndex };
      });
      this.receipt = {
        schemaVersion: 1,
        kind: 'playwright-shard-inventory',
        playwrightVersion: config.version,
        shard: config.shard ?? null,
        tests,
      };
    } catch {
      this.captureFailed = true;
    }
  }

  async onEnd(result) {
    if (result.status !== 'passed') return;
    const output = process.env.PLAYWRIGHT_SHARD_AUDIT_OUT;
    if (!output || this.captureFailed || !this.receipt) {
      console.error('Shard inventory was not captured. Set PLAYWRIGHT_SHARD_AUDIT_OUT and keep all test files inside Playwright rootDir.');
      return { status: 'failed' };
    }
    try {
      await writeFile(output, JSON.stringify(this.receipt, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      const message = error.code === 'EEXIST'
        ? 'Choose a new output file. The existing receipt was preserved.'
        : 'Could not write the shard inventory. Check the output directory.';
      console.error('Shard audit reporter: ' + message);
      return { status: 'failed' };
    }
  }
}

module.exports = ShardAuditReporter;
