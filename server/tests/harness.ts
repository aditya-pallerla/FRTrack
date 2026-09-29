/** Minimal test runner (no framework): `test(name, fn)` then `await run()`. Exits non-zero on failure. */

type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn }[] = [];

export function test(name: string, fn: Fn) { tests.push({ name, fn }); }

export class AssertionError extends Error {}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}
export function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new AssertionError(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

export async function run(suite: string): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  console.log(`\n${suite}`);
  for (const t of tests.splice(0)) {
    try {
      await t.fn();
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${(err as Error).message}`);
    }
  }
  console.log(`  ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

export async function runStandalone(suite: string) {
  const r = await run(suite);
  if (r.failed) process.exitCode = 1;
}
