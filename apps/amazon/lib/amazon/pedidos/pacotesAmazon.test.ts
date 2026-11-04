import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DETAILED_STATUS_REVERSAO, ehDetailedStatusReversao } from './pacotesAmazon';

const AQUI = dirname(fileURLToPath(import.meta.url));

describe('DETAILED_STATUS_REVERSAO — the ONE reversal token set', () => {
  it('holds exactly the six reversal tokens, frozen', () => {
    expect(Object.keys(DETAILED_STATUS_REVERSAO).sort()).toEqual([
      'DAMAGED',
      'LOST',
      'REJECTED_BY_BUYER',
      'RETURNED_TO_SELLER',
      'RETURNING_TO_SELLER',
      'UNDELIVERABLE',
    ]);
    expect(Object.isFrozen(DETAILED_STATUS_REVERSAO)).toBe(true);
  });

  it('matches EXACTLY: no trim, no case fold, no inherited name', () => {
    for (const token of Object.keys(DETAILED_STATUS_REVERSAO))
      expect(ehDetailedStatusReversao(token)).toBe(true);
    for (const quase of [
      'LOST ',
      'lost',
      'Lost',
      'RETURNED',
      'DELIVERED',
      'constructor',
      'toString',
      '',
      null,
      7,
    ]) {
      expect(ehDetailedStatusReversao(quase), String(quase)).toBe(false);
    }
  });

  it('the sale-state classifier imports it and spells no reversal token of its own (no second list)', () => {
    const fonte = readFileSync(join(AQUI, 'vendaAmazon.ts'), 'utf8');
    expect(fonte).toMatch(/from '\.\/pacotesAmazon'/);
    for (const token of Object.keys(DETAILED_STATUS_REVERSAO)) {
      expect(fonte.includes(token), token).toBe(false);
    }
  });
});
