import { describe, expect, it } from 'vitest';
import { SKIP_DOTTED_KEY, ghostFieldPath, planGhostKeys } from './transform';

describe('planGhostKeys', () => {
  it('removes the legacy full-path key and leaves the bare-id one alone', () => {
    // The exact shape production carries: legacy wrote the path, every reader
    // (and every other writer) uses the bare id — so both keys coexist.
    const plan = planGhostKeys({
      L1: { valor: 137 },
      'listaDePrecos/L1': { valor: 119.9 },
    });
    expect(plan.deletes).toEqual(['listaDePrecos/L1']);
    expect(plan.skips).toEqual([]);
  });

  it('is a total discriminator: any key with a slash goes, whatever the prefix', () => {
    const plan = planGhostKeys({
      L1: { valor: 1 },
      'listaDePrecos/L1': { valor: 2 },
      'documents/listaDePrecos/L2': { valor: 3 },
      'tabelasDePrecos/L3': { valor: 4 },
    });
    expect(plan.deletes).toEqual([
      'listaDePrecos/L1',
      'documents/listaDePrecos/L2',
      'tabelasDePrecos/L3',
    ]);
  });

  it('never touches a bare id, even an odd-looking one', () => {
    // Firestore doc ids may contain dots, dashes, unicode — none of that makes
    // a key a ghost. Only a slash does, and a slash is illegal in a doc id.
    const plan = planGhostKeys({
      L1: { valor: 1 },
      'ab.cd': { valor: 2 },
      'com-hifen': { valor: 3 },
      preço: { valor: 4 },
    });
    expect(plan.deletes).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it('SKIPS a ghost key containing a dot instead of mis-targeting a nested field', () => {
    const plan = planGhostKeys({ 'listaDePrecos/ab.cd': { valor: 1 } });
    expect(plan.deletes).toEqual([]);
    expect(plan.skips).toEqual([{ key: 'listaDePrecos/ab.cd', reason: SKIP_DOTTED_KEY }]);
  });

  it('tolerates every legacy precos shape without throwing', () => {
    for (const junk of [undefined, null, [], 'nope', 42, {}]) {
      expect(planGhostKeys(junk)).toEqual({ deletes: [], skips: [] });
    }
  });

  it('is idempotent — a cleaned map plans nothing on a second run', () => {
    expect(planGhostKeys({ L1: { valor: 137 } })).toEqual({ deletes: [], skips: [] });
  });
});

describe('ghostFieldPath', () => {
  it('nests the key under precos so the SDK escapes the slash for us', () => {
    // The SDK splits on `.` and backtick-quotes any segment that is not
    // /^[_a-zA-Z][_a-zA-Z0-9]*$/, so the slash needs no escaping here — but that
    // only holds because planGhostKeys already excluded dotted keys.
    expect(ghostFieldPath('listaDePrecos/L1')).toBe('precos.listaDePrecos/L1');
    expect(ghostFieldPath('listaDePrecos/L1').split('.')).toEqual(['precos', 'listaDePrecos/L1']);
  });
});
