import { describe, expect, it } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { describeRemoval, planTokenLegado, TOKEN_FIELD, tallyByTipo } from './transform';
import { buildPatch } from './migrate';

// Token-shaped sentinel: if it ever shows up in a plan, a log row or a patch
// description, the migration is leaking the credential it exists to remove.
const SECRET = 'li-static-api-key-SENTINEL-0123456789';

describe('planTokenLegado', () => {
  it('plans a delete for a document carrying token_id, with its tipo', () => {
    expect(planTokenLegado({ tipo: 3, nome: 'x', [TOKEN_FIELD]: SECRET })).toEqual({
      action: 'delete',
      tipo: 3,
    });
  });

  it('skips a document without the field', () => {
    expect(planTokenLegado({ tipo: 3, nome: 'x' })).toEqual({ action: 'skip' });
  });

  it('plans a delete whatever the tipo — the field is an exposed credential on any document', () => {
    for (const tipo of [0, 1, 2, 3, 4, 7]) {
      expect(planTokenLegado({ tipo, [TOKEN_FIELD]: SECRET })).toEqual({ action: 'delete', tipo });
    }
  });

  it('reports a null tipo when the stored tipo is missing or not a finite number', () => {
    expect(planTokenLegado({ [TOKEN_FIELD]: SECRET })).toEqual({ action: 'delete', tipo: null });
    expect(planTokenLegado({ tipo: 'li', [TOKEN_FIELD]: SECRET })).toEqual({
      action: 'delete',
      tipo: null,
    });
    expect(planTokenLegado({ tipo: Number.NaN, [TOKEN_FIELD]: SECRET })).toEqual({
      action: 'delete',
      tipo: null,
    });
  });

  it('counts presence, not truthiness — null and empty values still carry the field', () => {
    expect(planTokenLegado({ tipo: 3, [TOKEN_FIELD]: null }).action).toBe('delete');
    expect(planTokenLegado({ tipo: 3, [TOKEN_FIELD]: '' }).action).toBe('delete');
  });

  it('near-miss: sibling and nested names are NOT the field', () => {
    expect(planTokenLegado({ tipo: 3, token: SECRET })).toEqual({ action: 'skip' });
    expect(planTokenLegado({ tipo: 3, tokenId: SECRET })).toEqual({ action: 'skip' });
    expect(planTokenLegado({ tipo: 3, token_id_2: SECRET })).toEqual({ action: 'skip' });
    expect(planTokenLegado({ tipo: 3, config: { token_id: SECRET } })).toEqual({ action: 'skip' });
  });

  it('skips anything that is not a plain map', () => {
    expect(planTokenLegado(undefined)).toEqual({ action: 'skip' });
    expect(planTokenLegado(null)).toEqual({ action: 'skip' });
    expect(planTokenLegado('token_id')).toEqual({ action: 'skip' });
    expect(planTokenLegado([TOKEN_FIELD])).toEqual({ action: 'skip' });
  });

  it('is IDEMPOTENT — applying the plan and re-planning is always a skip', () => {
    const doc: Record<string, unknown> = { tipo: 3, nome: 'x', [TOKEN_FIELD]: SECRET };
    expect(planTokenLegado(doc).action).toBe('delete');
    delete doc[TOKEN_FIELD]; // what the FieldValue.delete() leaves behind
    expect(planTokenLegado(doc)).toEqual({ action: 'skip' });
  });

  it('never carries the value, in the plan or in the log description', () => {
    const plan = planTokenLegado({ tipo: 3, [TOKEN_FIELD]: SECRET });
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    if (plan.action !== 'delete') throw new Error('expected a delete plan');
    const row = describeRemoval(plan);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row).toEqual({ from: { present: true, tipo: 3 }, to: 'removed' });
  });
});

describe('buildPatch', () => {
  it('touches token_id and nothing else, as a delete sentinel', () => {
    const patch = buildPatch();
    expect(Object.keys(patch)).toEqual([TOKEN_FIELD]);
    expect(patch[TOKEN_FIELD]).toEqual(FieldValue.delete());
  });

  it('carries no credential text', () => {
    expect(JSON.stringify(buildPatch())).not.toContain(SECRET);
  });
});

describe('tallyByTipo', () => {
  it('counts only deletes, per tipo, with unknown tipos grouped apart', () => {
    const tally = tallyByTipo([
      { action: 'delete', tipo: 3 },
      { action: 'delete', tipo: 3 },
      { action: 'delete', tipo: 1 },
      { action: 'delete', tipo: null },
      { action: 'skip' },
    ]);
    expect(Object.fromEntries(tally)).toEqual({ '3': 2, '1': 1, desconhecido: 1 });
  });

  it('is empty when nothing carries the field — the post-apply census', () => {
    expect(tallyByTipo([{ action: 'skip' }, { action: 'skip' }]).size).toBe(0);
  });
});
