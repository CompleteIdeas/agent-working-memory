import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Stable CI mode: forks pool avoids ONNX/transformers.js thread crashes on Windows.
    // Single worker prevents race conditions in SQLite test DBs.
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
