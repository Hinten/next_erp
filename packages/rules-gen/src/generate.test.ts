import { describe, expect, it } from 'vitest';
import { generateRulesSource } from './generate';
import { sizeGate } from './size-gate';

describe('generateRulesSource', () => {
  it('is deterministic', () => {
    expect(generateRulesSource()).toBe(generateRulesSource());
  });

  it('passes the size gate without warnings', () => {
    const warnings: string[] = [];
    sizeGate(generateRulesSource(), (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
  });

  it('matches the committed full-output snapshot (the review artifact)', async () => {
    // A schema/PERM PR shows its exact rules impact as this snapshot's diff.
    // Refresh with: pnpm --filter @delfrance/rules-gen test -- -u
    await expect(generateRulesSource()).toMatchFileSnapshot('__snapshots__/firestore.rules.snap');
  });
});
