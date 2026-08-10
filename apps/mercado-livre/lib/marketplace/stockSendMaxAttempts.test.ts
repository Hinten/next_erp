import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { STOCK_SEND_MAX_ATTEMPTS } from './estoquePlan';

/**
 * `STOCK_SEND_MAX_ATTEMPTS` is load-bearing in TWO places that are deployed
 * separately: the queue's `retryConfig.maxAttempts` (baked into the Cloud Tasks
 * queue at deploy time) and the handler's terminal-4xx ladder, which only records
 * a listing's state once `retryCount` reaches the last attempt.
 *
 * If the two ever disagree the failure is SILENT and asymmetric:
 *  - constant HIGHER than the queue → the queue exhausts its attempts before the
 *    handler ever reaches its terminal branch, so nothing is ever recorded and
 *    the sweep re-sends the rejected payload forever — the exact regression #781
 *    exists to kill;
 *  - constant LOWER → the listing is recorded early and the remaining attempts
 *    re-send a payload we already judged terminal.
 *
 * The queue config lives in the nested functions codebase, which is not a
 * workspace member and has no test runner of its own, so this pins it by reading
 * the source. `sendStock.ts` must reference the constant BY NAME — a literal
 * would parse but reintroduce exactly the drift this guards.
 */
describe('STOCK_SEND_MAX_ATTEMPTS', () => {
  const source = readFileSync(join(__dirname, '../../functions/src/sendStock.ts'), 'utf8');

  it('is the value the handler ladder assumes', () => {
    // A cap below 2 would collapse the ladder: attempt 0 would be the last one,
    // so a single transient 4xx from ML would latch the listing immediately.
    expect(STOCK_SEND_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(STOCK_SEND_MAX_ATTEMPTS)).toBe(true);
  });

  it('is what the deployed queue retryConfig uses — by name, not a literal', () => {
    expect(source).toMatch(/maxAttempts:\s*STOCK_SEND_MAX_ATTEMPTS\b/);
    expect(source).toMatch(/STOCK_SEND_MAX_ATTEMPTS,/); // imported from estoquePlan
  });

  it('reaches the handler — the ladder is dead without req.retryCount', () => {
    expect(source).toMatch(/retryCount:\s*req\.retryCount\s*\?\?\s*0/);
  });

  /**
   * `ignoreSyncFlag` exists so the MANUAL push (#819) can run before
   * `MERCADO_LIVRE_STOCK_SYNC_ENABLED` flips. The queue handler must never set
   * it: the flag is the documented emergency stop for the unattended sweeps,
   * and a backlog that keeps hitting ML after the stop is exactly the failure
   * the re-check in `processStockSendTask` step 0.5 was added to prevent.
   *
   * Read from the source because the nested functions codebase is not a
   * workspace member and has no test runner of its own — the same technique the
   * `retryConfig` pins above use.
   */
  it('the QUEUE handler never bypasses the master flag', () => {
    expect(source).not.toMatch(/ignoreSyncFlag/);
  });
});
