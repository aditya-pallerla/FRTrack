/** Runs every test suite in sequence; exit code is non-zero if any test failed. */
const suites = ['./engine.test.ts', './routing.test.ts', './allocation.test.ts', './store.test.ts'];
for (const s of suites) await import(s);
