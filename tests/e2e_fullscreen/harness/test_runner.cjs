'use strict';

class TestRunner {
  constructor() {
    this.suites = [];
    this.currentSuite = null;
    this.results = {
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      tests: [],
      startTime: 0,
      endTime: 0,
    };
  }

  suite(name, fn) {
    const suiteObj = {
      name,
      tests: [],
      beforeEach: [],
      afterEach: [],
      beforeAll: [],
      afterAll: [],
    };
    this.suites.push(suiteObj);
    const prevSuite = this.currentSuite;
    this.currentSuite = suiteObj;
    try {
      fn();
    } finally {
      this.currentSuite = prevSuite;
    }
  }

  beforeEach(fn) {
    if (this.currentSuite) this.currentSuite.beforeEach.push(fn);
  }

  afterEach(fn) {
    if (this.currentSuite) this.currentSuite.afterEach.push(fn);
  }

  beforeAll(fn) {
    if (this.currentSuite) this.currentSuite.beforeAll.push(fn);
  }

  afterAll(fn) {
    if (this.currentSuite) this.currentSuite.afterAll.push(fn);
  }

  test(metaOrDesc, fn) {
    if (!this.currentSuite) {
      throw new Error(`Test registered outside of a suite: ${JSON.stringify(metaOrDesc)}`);
    }

    let meta;
    if (typeof metaOrDesc === 'string') {
      meta = { id: '', description: metaOrDesc, tier: 1, feature: '' };
    } else {
      meta = {
        id: metaOrDesc.id || '',
        description: metaOrDesc.description || metaOrDesc.name || '',
        tier: metaOrDesc.tier || 1,
        feature: metaOrDesc.feature || '',
      };
    }

    this.currentSuite.tests.push({
      ...meta,
      fn,
    });
  }

  async run(options = {}) {
    const {
      tierFilter = null,
      featureFilter = null,
      grepFilter = null,
      bail = false,
      silent = false,
    } = options;

    this.results.startTime = Date.now();
    const log = (...args) => {
      if (!silent) console.log(...args);
    };

    log('\n================================================================');
    log('  One Launcher Universal Fullscreen & HiDPI E2E Test Suite');
    log('================================================================\n');

    for (const suite of this.suites) {
      const activeTests = suite.tests.filter(t => {
        if (tierFilter && Number(t.tier) !== Number(tierFilter)) return false;
        if (featureFilter && t.feature.toUpperCase() !== featureFilter.toUpperCase()) return false;
        if (grepFilter && !`${t.id} ${t.description}`.toLowerCase().includes(grepFilter.toLowerCase())) return false;
        return true;
      });

      if (activeTests.length === 0) continue;

      log(`Suite: ${suite.name}`);

      for (const beforeAllFn of suite.beforeAll) {
        await beforeAllFn();
      }

      for (const t of activeTests) {
        this.results.total += 1;
        const testId = t.id ? `[${t.id}]` : '';
        const featureTag = t.feature ? `[${t.feature}]` : '';
        const tierTag = `[T${t.tier}]`;
        const label = `${tierTag}${featureTag}${testId} ${t.description}`;

        for (const beforeEachFn of suite.beforeEach) {
          await beforeEachFn();
        }

        const tStart = Date.now();
        let pass = false;
        let err = null;

        try {
          const timeoutMs = t.timeout || 15000;
          let timer;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Test timed out after ${timeoutMs}ms`)), timeoutMs);
          });
          await Promise.race([
            Promise.resolve(t.fn()),
            timeoutPromise,
          ]);
          clearTimeout(timer);
          pass = true;
          this.results.passed += 1;
          const elapsed = Date.now() - tStart;
          log(`  \x1b[32m✓\x1b[0m ${label} (${elapsed}ms)`);
        } catch (e) {
          err = e;
          this.results.failed += 1;
          const elapsed = Date.now() - tStart;
          log(`  \x1b[31m✗\x1b[0m ${label} (${elapsed}ms)`);
          log(`    \x1b[31mError:\x1b[0m ${e.message}`);
          if (e.expected !== undefined && e.actual !== undefined) {
            log(`    Expected: ${JSON.stringify(e.expected)}`);
            log(`    Actual:   ${JSON.stringify(e.actual)}`);
          }
          if (e.stack && !silent) {
            const shortStack = e.stack.split('\n').slice(1, 4).join('\n');
            log(`    ${shortStack}`);
          }
        } finally {
          for (const afterEachFn of suite.afterEach) {
            try {
              await afterEachFn();
            } catch (cleanupErr) {
              log(`    \x1b[33mWarning in afterEach:\x1b[0m ${cleanupErr.message}`);
            }
          }
        }

        this.results.tests.push({
          id: t.id,
          feature: t.feature,
          tier: t.tier,
          description: t.description,
          passed: pass,
          durationMs: Date.now() - tStart,
          error: err ? { message: err.message, stack: err.stack, expected: err.expected, actual: err.actual } : null,
        });

        if (bail && !pass) {
          log('\n\x1b[31mBail on first failure requested. Aborting remaining tests.\x1b[0m\n');
          break;
        }
      }

      for (const afterAllFn of suite.afterAll) {
        try {
          await afterAllFn();
        } catch (cleanupErr) {
          log(`  \x1b[33mWarning in afterAll:\x1b[0m ${cleanupErr.message}`);
        }
      }

      log('');
    }

    this.results.endTime = Date.now();
    const duration = ((this.results.endTime - this.results.startTime) / 1000).toFixed(2);

    log('----------------------------------------------------------------');
    log(`Test Run Complete in ${duration}s`);
    log(`Total Tests:  ${this.results.total}`);
    log(`  Passed:     \x1b[32m${this.results.passed}\x1b[0m`);
    log(`  Failed:     \x1b[${this.results.failed > 0 ? '31' : '32'}m${this.results.failed}\x1b[0m`);
    log('----------------------------------------------------------------\n');

    return this.results;
  }
}

const defaultRunner = new TestRunner();

module.exports = {
  TestRunner,
  defaultRunner,
  suite: defaultRunner.suite.bind(defaultRunner),
  describe: defaultRunner.suite.bind(defaultRunner),
  test: defaultRunner.test.bind(defaultRunner),
  it: defaultRunner.test.bind(defaultRunner),
  beforeEach: defaultRunner.beforeEach.bind(defaultRunner),
  afterEach: defaultRunner.afterEach.bind(defaultRunner),
  beforeAll: defaultRunner.beforeAll.bind(defaultRunner),
  afterAll: defaultRunner.afterAll.bind(defaultRunner),
  run: defaultRunner.run.bind(defaultRunner),
};
