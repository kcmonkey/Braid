import { defineConfig } from 'vitest/config';

// Run test files serially. vitest v4's default multi-worker pool crashes on this machine with an
// internal "Cannot read properties of undefined (reading 'config')" when loading several suites in
// parallel (each suite passes in isolation). Serial execution is plenty fast for this project's unit
// suite and sidesteps the worker-pool bug. (equivalent to `vitest run --no-file-parallelism`)
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
