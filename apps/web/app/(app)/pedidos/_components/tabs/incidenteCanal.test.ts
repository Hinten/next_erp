import { describe, expect, it } from 'vitest';
import {
  ORIGEM_INCIDENTE,
  ORIGEM_INCIDENTE_LABELS,
  ORIGENS_INCIDENTE_MARKETPLACE,
  RETURN_SN_SHOPEE_MAX,
  origemIncidenteSchema,
} from '@delfrance/schemas';

import {
  ehIncidenteImportado,
  ehOrigemDeMarketplace,
  opcoesDeOrigem,
  returnSnDoIncidente,
} from './incidenteCanal';

/**
 * Every helper here is a fold — it decides which incidentes count as "the same
 * kind" — so each one is pinned BOTH ways: a case that must match AND a
 * near-miss that must not (root `CLAUDE.md`: test the fold's scope, not just
 * that it applies).
 */

/** The doc samples are alphanumeric; a digits-only fixture would hide a digits guard. */
const RETURN_SN_ALNUM = '260910ABCDE0001';
const RETURN_SN_DIGITOS = '2609100000000001';

const SHOPEE = ORIGEM_INCIDENTE.pedidoShopee;
const ML = ORIGEM_INCIDENTE.pedidoMercadoLivre;

describe('returnSnDoIncidente — where the Shopee panel mounts', () => {
  it('⭐ accepts an ALPHANUMERIC return_sn under the Shopee origem (W1: never a digits-only test)', () => {
    expect(returnSnDoIncidente({ origem: SHOPEE, externalId: RETURN_SN_ALNUM })).toBe(
      RETURN_SN_ALNUM,
    );
  });

  it('accepts the all-digit fixture under the Shopee origem too', () => {
    expect(returnSnDoIncidente({ origem: SHOPEE, externalId: RETURN_SN_DIGITOS })).toBe(
      RETURN_SN_DIGITOS,
    );
  });

  it('⭐ NEAR MISS (W2): the same ids under any other origem are NOT a Shopee return', () => {
    // An ML claim id is a valid return_sn SHAPE — the origem half is what
    // keeps an ML card from mounting the Shopee panel.
    for (const origem of origemIncidenteSchema.options.map((o) => o.value)) {
      if (origem === SHOPEE) continue;
      expect(returnSnDoIncidente({ origem, externalId: RETURN_SN_ALNUM })).toBeNull();
      expect(returnSnDoIncidente({ origem, externalId: RETURN_SN_DIGITOS })).toBeNull();
    }
    expect(returnSnDoIncidente({ origem: null, externalId: RETURN_SN_ALNUM })).toBeNull();
    expect(returnSnDoIncidente({ externalId: RETURN_SN_ALNUM })).toBeNull();
  });

  it('trims a padded stored id before asking the shared predicate', () => {
    expect(returnSnDoIncidente({ origem: SHOPEE, externalId: `  ${RETURN_SN_ALNUM}\n` })).toBe(
      RETURN_SN_ALNUM,
    );
  });

  it('NEAR MISS: blank, absent, separators and over-long ids are refused', () => {
    for (const externalId of [
      null,
      undefined,
      '',
      '   ',
      '-',
      '2609/100',
      '2609-100',
      '2609.100',
      '2609:100',
      '2609 100',
      'x'.repeat(RETURN_SN_SHOPEE_MAX + 1),
    ]) {
      expect(returnSnDoIncidente({ origem: SHOPEE, externalId })).toBeNull();
    }
    // …and the bound itself is accepted: the shared predicate, not a copy of it.
    expect(
      returnSnDoIncidente({ origem: SHOPEE, externalId: 'A'.repeat(RETURN_SN_SHOPEE_MAX) }),
    ).toBe('A'.repeat(RETURN_SN_SHOPEE_MAX));
  });
});

describe('ehIncidenteImportado — what the editor locks', () => {
  it('a marketplace origem WITH an externalId is imported — for BOTH channels', () => {
    expect(ehIncidenteImportado({ origem: SHOPEE, externalId: RETURN_SN_ALNUM })).toBe(true);
    expect(ehIncidenteImportado({ origem: ML, externalId: '9001' })).toBe(true);
  });

  it('NEAR MISS: a marketplace origem with a BLANK or absent externalId stays editable (a person typed it)', () => {
    for (const externalId of [null, undefined, '', '  \t']) {
      expect(ehIncidenteImportado({ origem: SHOPEE, externalId })).toBe(false);
      expect(ehIncidenteImportado({ origem: ML, externalId })).toBe(false);
    }
  });

  it('⭐ NEAR MISS: `outros` (99) with an id — step 5’s produto rows — is NOT imported', () => {
    expect(ehIncidenteImportado({ origem: ORIGEM_INCIDENTE.outros, externalId: 'p-1' })).toBe(
      false,
    );
  });

  it('agrees with the overlay’s own set over EVERY origem — no second list', () => {
    for (const origem of origemIncidenteSchema.options.map((o) => o.value)) {
      expect(ehIncidenteImportado({ origem, externalId: 'id-1' })).toBe(
        ORIGENS_INCIDENTE_MARKETPLACE.has(origem),
      );
      expect(ehOrigemDeMarketplace(origem)).toBe(ORIGENS_INCIDENTE_MARKETPLACE.has(origem));
    }
    expect(ehIncidenteImportado({ origem: null, externalId: 'id-1' })).toBe(false);
    expect(ehOrigemDeMarketplace(null)).toBe(false);
    expect(ehOrigemDeMarketplace(undefined)).toBe(false);
  });
});

describe('opcoesDeOrigem — the editor’s Origem options', () => {
  const valores = (atual: number | null | undefined) => opcoesDeOrigem(atual).map((o) => o.value);

  it('⭐ a manual row is offered NO marketplace origem (W17)', () => {
    const v = valores(null);
    expect(v).not.toContain(String(ML));
    expect(v).not.toContain(String(SHOPEE));
    // …and every other origem, plus `(nenhuma)` first.
    expect(v[0]).toBe('');
    for (const origem of origemIncidenteSchema.options.map((o) => o.value)) {
      if (ORIGENS_INCIDENTE_MARKETPLACE.has(origem)) continue;
      expect(v).toContain(String(origem));
    }
  });

  it('a row that already holds a marketplace origem keeps THAT one — and only that one', () => {
    expect(valores(ML)).toContain(String(ML));
    expect(valores(ML)).not.toContain(String(SHOPEE));
    expect(valores(SHOPEE)).toContain(String(SHOPEE));
    expect(valores(SHOPEE)).not.toContain(String(ML));
  });

  it('a non-marketplace current value changes nothing', () => {
    expect(valores(ORIGEM_INCIDENTE.troca)).toEqual(valores(null));
    expect(valores(undefined)).toEqual(valores(null));
  });

  it('labels come from the schema’s own table, verbatim', () => {
    const opcoes = opcoesDeOrigem(SHOPEE);
    expect(opcoes[0]).toEqual({ value: '', label: '(nenhuma)' });
    for (const { value, label } of opcoes.slice(1)) {
      const origem = origemIncidenteSchema.parse(Number(value));
      expect(label).toBe(ORIGEM_INCIDENTE_LABELS[origem]);
    }
  });
});
