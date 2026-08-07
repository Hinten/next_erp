import { describe, expect, it } from 'vitest';

import { OPERATOR_OWNED_KEYS, buildListingPatch, detectConflict } from './listingPatch';

describe('buildListingPatch', () => {
  it('writes only dirty, operator-owned keys', () => {
    const patch = buildListingPatch(
      { title: 'Novo título', descricao: 'nova', condition: 'used' },
      { title: true, descricao: false },
      1_700_000_000_000,
    );
    expect(patch).toEqual({ title: 'Novo título', ultimaModificacao: 1_700_000_000_000 });
  });

  it('never writes a server-owned key, even when the form holds one', () => {
    const patch = buildListingPatch(
      { title: 'x', estado: 'p', id: 'MLB1', isUserProductModel: true } as never,
      { title: true, estado: true, id: true, isUserProductModel: true },
      1,
    );
    expect(Object.keys(patch).sort()).toEqual(['title', 'ultimaModificacao']);
  });

  it('treats an edited array/object field as dirty', () => {
    // react-hook-form reports `attributes` as an array of per-entry flag maps,
    // so a plain truthiness test would miss it.
    const patch = buildListingPatch(
      { attributes: [{ id: 'BRAND', value_name: 'Acme' }] },
      { attributes: [{ value_name: true }] },
      1,
    );
    expect(patch.attributes).toEqual([{ id: 'BRAND', value_name: 'Acme' }]);
  });

  it('stamps ultimaModificacao in MILLISECONDS', () => {
    // µs elsewhere in the repo; a cross-unit comparison is a guard that never
    // fires (root CLAUDE.md rule 7).
    const nowMs = Date.UTC(2026, 7, 7);
    expect(buildListingPatch({}, {}, nowMs).ultimaModificacao).toBe(nowMs);
  });

  it('keeps isUserProductModel out of the allow-list entirely', () => {
    expect(OPERATOR_OWNED_KEYS).not.toContain('isUserProductModel');
    expect(OPERATOR_OWNED_KEYS).not.toContain('estado');
    expect(OPERATOR_OWNED_KEYS).not.toContain('errors');
  });
});

describe('detectConflict', () => {
  const baseline = { title: 'Antigo', descricao: 'Desc', ultimaModificacao: 1000 };

  it('is not a conflict when nothing moved', () => {
    expect(detectConflict(baseline, baseline, { title: 'x', ultimaModificacao: 2 }, 1000)).toEqual({
      conflict: false,
      fields: [],
      nextBaselineMs: 1000,
    });
  });

  it('flags a remote change to a key this save also writes', () => {
    const live = { ...baseline, title: 'Alterado por outro', ultimaModificacao: 2000 };
    const result = detectConflict(baseline, live, { title: 'Meu', ultimaModificacao: 3000 }, 1000);
    expect(result.conflict).toBe(true);
    expect(result.fields).toEqual(['title']);
    expect(result.nextBaselineMs).toBe(2000);
  });

  it('is NOT a conflict when the doc advanced on keys this save does not write', () => {
    // The publish flow stamping `estado`, or the price sync refreshing
    // `precoPublicado`, must not block an unrelated descricao edit — otherwise
    // the editor is unusable on any actively-syncing listing.
    const live = { ...baseline, ultimaModificacao: 2000 };
    const result = detectConflict(baseline, live, { title: 'Meu', ultimaModificacao: 3000 }, 1000);
    expect(result.conflict).toBe(false);
    expect(result.nextBaselineMs).toBe(2000); // baseline still refreshes
  });

  it('ignores a remote change to a key this save leaves alone', () => {
    const live = { ...baseline, descricao: 'Outro', ultimaModificacao: 2000 };
    const result = detectConflict(baseline, live, { title: 'Meu', ultimaModificacao: 3000 }, 1000);
    expect(result.conflict).toBe(false);
  });

  it('compares composite values structurally', () => {
    const withAttrs = { attributes: [{ id: 'BRAND' }], ultimaModificacao: 1000 };
    const same = { attributes: [{ id: 'BRAND' }], ultimaModificacao: 2000 };
    const different = { attributes: [{ id: 'MODEL' }], ultimaModificacao: 2000 };
    const patch = { attributes: [], ultimaModificacao: 3000 } as never;
    expect(detectConflict(withAttrs, same, patch, 1000).conflict).toBe(false);
    expect(detectConflict(withAttrs, different, patch, 1000).conflict).toBe(true);
  });

  it('does not block when there is no baseline stamp to compare', () => {
    expect(detectConflict(baseline, baseline, { ultimaModificacao: 1 }, null).conflict).toBe(false);
  });
});
