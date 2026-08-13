import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #812 acceptance box 2 — "the cold-start decision is recorded with its cost".
 *
 * `minInstances: 0` on this backend is a DECISION, not a default: Mercado Livre
 * wants a 200 within roughly 500 ms and disables a topic after repeated
 * failures, and a cold instance has to boot Next.js, init firebase-admin, mint
 * an ADC token and issue a Cloud Tasks enqueue RPC inside that window. Keeping
 * the zero is only defensible because the daily `missed_feeds` backstop recovers
 * what a blown ack drops — at up to ~24 h of latency.
 *
 * This test's job is to make the number un-flippable in silence: anyone changing
 * it has to walk past the recorded rationale in `apphosting.yaml`. It
 * deliberately does NOT assert the prose or the currency figure — that would
 * grade writing and would rot the moment regional pricing moves. It asserts the
 * VALUE and the issue anchor.
 *
 * ⚠️ `apphosting.yaml` lives inside this package, so it IS part of this
 * workspace's turbo input set — unlike the `.env.example` guards in
 * `packages/config-eslint`, this one cannot replay a cached green after the YAML
 * changes.
 */
describe('apps/mercado-livre cold-start policy (#812)', () => {
  const yaml = readFileSync(join(__dirname, '../../apphosting.yaml'), 'utf8');
  const match = /^\s*minInstances:\s*(\d+)/m.exec(yaml);

  it('finds the minInstances declaration (detector self-pin)', () => {
    // Without this, a YAML reformat that moves or renames the key would make
    // every assertion below pass VACUOUSLY on a null match.
    expect(match).not.toBeNull();
  });

  it('is still 0 — raising it is a deliberate, costed decision', () => {
    expect(Number(match![1])).toBe(0);
  });

  it('records the decision against #812 so the cost cannot be skipped', () => {
    // Non-vacuous: `#812` appears nowhere else in apphosting.yaml. If this fails
    // the rationale block was deleted, and the next reader would see a bare
    // `minInstances: 0` with no way to know it was ever weighed.
    expect(yaml).toContain('#812');
  });

  it('names the backstop that makes the zero defensible', () => {
    // The zero is only acceptable BECAUSE something recovers a blown ack. If the
    // sweep is ever removed, this is the line that should send someone back here.
    expect(yaml).toContain('sweepMercadoLivreMissedFeeds');
  });
});
