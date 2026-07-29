import { defineConfig, devices } from '@playwright/test';

// Deliberately minimal. These tests hit a deployed page and a live testnet, so
// there is no server to start, no fixtures to build and nothing to seed.
export default defineConfig({
  testDir: './e2e',
  // Chain reads go through a public RPC that rate-limits, and parallel workers
  // multiply that by the worker count for no benefit — the tests are read-only
  // and fast. One worker, one browser.
  workers: 1,
  fullyParallel: false,
  // Sepolia + a public RPC is slower than a local fixture and occasionally
  // retries; a tight default timeout turns that into a flake rather than a fact.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // No wallet is injected, which is the point: everything asserted is what a
    // visitor sees before connecting one.
    trace: 'retain-on-failure',
  },
});
