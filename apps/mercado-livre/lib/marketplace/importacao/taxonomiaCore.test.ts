import { describe, expect, it } from 'vitest';
import type { MlItemAttribute } from '@delfrance/integrations-mercado-livre';
import type { GrupoComId } from '@delfrance/schemas';

import {
  comboAttrKey,
  normalizeForSlug,
  planTaxonomia,
  swapGenderVowel,
  swapSpaceHyphen,
} from './taxonomiaCore';

const NOW = 1_700_000_000_000;
const INTEGRACAO_ID = 'i1';

function combo(over: Partial<MlItemAttribute>): MlItemAttribute {
  return { id: null, name: null, value_id: null, value_name: null, ...over };
}

function grupo(id: string, over: Partial<GrupoComId['data']> = {}): GrupoComId {
  return {
    id,
    data: {
      nome: over.nome ?? id,
      codigo: null,
      ordem: 1,
      tipo: null,
      permiteFotos: false,
      ultimaModificacao: null,
      timestamp: 1,
      variacoesIds: [],
      variacoes: [],
      ...over,
    },
  };
}

/* ------------------------------ pure helpers ----------------------------- */

describe('normalizeForSlug', () => {
  it('lowercases, trims, collapses whitespace runs to a single hyphen, strips other chars', () => {
    expect(normalizeForSlug('  Azul  Marinho!! ')).toBe('azul-marinho');
    expect(normalizeForSlug('42')).toBe('42');
    expect(normalizeForSlug('Tam. Único')).toBe('tam-nico'); // diacritic + '.' stripped
  });
});

describe('swapGenderVowel', () => {
  it('swaps a trailing a/o (both cases) and returns null otherwise', () => {
    expect(swapGenderVowel('Vermelha')).toBe('Vermelho');
    expect(swapGenderVowel('Vermelho')).toBe('Vermelha');
    expect(swapGenderVowel('AMARELA')).toBe('AMARELO');
    expect(swapGenderVowel('Azul')).toBeNull();
    expect(swapGenderVowel('')).toBeNull();
  });
});

describe('swapSpaceHyphen', () => {
  it('swaps spaces to hyphens or hyphens to spaces; unchanged otherwise', () => {
    expect(swapSpaceHyphen('Azul Marinho')).toBe('Azul-Marinho');
    expect(swapSpaceHyphen('Azul-Marinho')).toBe('Azul Marinho');
    expect(swapSpaceHyphen('Azul')).toBe('Azul');
  });
});

describe('comboAttrKey', () => {
  it('keys by (id ?? name) + value (id ?? name)', () => {
    expect(comboAttrKey(combo({ id: 'SIZE', value_id: '170' }))).toBe('SIZE|170');
    expect(comboAttrKey(combo({ name: 'Tamanho', value_name: 'M' }))).toBe('Tamanho|M');
  });

  it('is the raw `??` formula (never null) — an empty-string id/value is NOT treated as absent, unlike the separate usability gate in planTaxonomia', () => {
    expect(comboAttrKey(combo({ value_id: '170' }))).toBe('|170');
    expect(comboAttrKey(combo({ id: 'SIZE' }))).toBe('SIZE|');
  });
});

/* -------------------------------- planTaxonomia grupo cascade ------------ */

describe('planTaxonomia — grupo matching cascade', () => {
  it('matches by doc id', () => {
    const grupos = [grupo('SIZE', { nome: 'Tamanho ERP' })];
    const plan = planTaxonomia(
      grupos,
      [combo({ id: 'SIZE', name: 'Talle', value_id: '170', value_name: 'M' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.grupoId).toBe('SIZE');
    expect(plan.gruposToCreate).toHaveLength(0);
  });

  it('falls back to exact nome match when doc id differs', () => {
    const grupos = [grupo('abc123', { nome: 'COLOR' })];
    const plan = planTaxonomia(
      grupos,
      [combo({ id: 'COLOR', name: 'COLOR', value_id: '1', value_name: 'Azul' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.grupoId).toBe('abc123');
    expect(plan.gruposToCreate).toHaveLength(0);
  });

  it('falls back to a tipo match for exactly SIZE/COLOR when doc id and nome both miss', () => {
    const grupos = [grupo('meu-tamanho', { nome: 'Tamanhos da Loja', tipo: 1 })];
    const plan = planTaxonomia(
      grupos,
      [combo({ id: 'SIZE', name: 'Talle', value_id: '170', value_name: 'M' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.grupoId).toBe('meu-tamanho');
    expect(plan.gruposToCreate).toHaveLength(0);
  });

  it('the tipo fallback only triggers for attribute id exactly SIZE/COLOR — a non-standard id creates instead', () => {
    const grupos = [grupo('meu-tamanho', { nome: 'Tamanhos da Loja', tipo: 1 })];
    const plan = planTaxonomia(
      grupos,
      [combo({ id: 'CUSTOM_SIZE', name: 'Outro nome', value_id: '1', value_name: 'X' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.gruposToCreate).toHaveLength(1);
    expect(plan.gruposToCreate[0]!.id).toBe('CUSTOM_SIZE');
  });

  it('creates a new grupo when nothing matches: id = attribute id, tipo/permiteFotos derived', () => {
    const planSize = planTaxonomia(
      [],
      [combo({ id: 'SIZE', name: 'Talle', value_id: '170', value_name: 'M' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(planSize.gruposToCreate).toEqual([
      {
        id: 'SIZE',
        data: expect.objectContaining({
          nome: 'Talle',
          tipo: 1,
          permiteFotos: false,
          timestamp: NOW,
        }),
      },
    ]);

    const planColor = planTaxonomia(
      [],
      [combo({ id: 'COLOR', name: 'Cor', value_id: '1', value_name: 'Azul' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(planColor.gruposToCreate[0]!.data).toMatchObject({ tipo: 2, permiteFotos: true });

    const planOther = planTaxonomia(
      [],
      [combo({ id: 'MATERIAL', name: 'Material', value_id: '1', value_name: 'Algodão' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(planOther.gruposToCreate[0]!.data).toMatchObject({ tipo: 0, permiteFotos: false });
  });

  it('falls back to a slug id when the combo has no attribute id, only a name', () => {
    const plan = planTaxonomia(
      [],
      [combo({ name: 'Tecido Especial', value_id: '1', value_name: 'Seda' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.gruposToCreate[0]!.id).toBe('n-tecido-especial');
  });
});

/* ------------------------------ variante cascade -------------------------- */

describe('planTaxonomia — variante matching cascade', () => {
  const grupoSize: GrupoComId = grupo('SIZE', {
    nome: 'Talle',
    tipo: 1,
    variacoes: [{ id: '170', nome: 'M', timestamp: 1 }],
    variacoesIds: ['170'],
  });

  it('matches by value_id', () => {
    const plan = planTaxonomia(
      [grupoSize],
      [combo({ id: 'SIZE', value_id: '170', value_name: 'Medium' })], // name differs — id still wins
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.varianteId).toBe('170');
    expect(plan.variantesToAppend).toHaveLength(0);
  });

  it('matches by exact nome when there is no value_id', () => {
    const plan = planTaxonomia(
      [grupoSize],
      [combo({ id: 'SIZE', value_name: 'M' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.varianteId).toBe('170');
  });

  it('matches by trailing gender-vowel swap', () => {
    const grupoCor = grupo('COLOR', {
      nome: 'Cor',
      tipo: 2,
      variacoes: [{ id: 'c1', nome: 'Vermelho', timestamp: 1 }],
      variacoesIds: ['c1'],
    });
    const plan = planTaxonomia(
      [grupoCor],
      [combo({ id: 'COLOR', value_id: 'c2', value_name: 'Vermelha' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.varianteId).toBe('c1'); // matched existing, NOT created as c2
    expect(plan.variantesToAppend).toHaveLength(0);
  });

  it('matches by space<->hyphen swap', () => {
    const grupoCor = grupo('COLOR', {
      nome: 'Cor',
      tipo: 2,
      variacoes: [{ id: 'c1', nome: 'Azul Marinho', timestamp: 1 }],
      variacoesIds: ['c1'],
    });
    const plan = planTaxonomia(
      [grupoCor],
      [combo({ id: 'COLOR', value_id: 'c2', value_name: 'Azul-Marinho' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.varianteId).toBe('c1');
  });

  it('creates a new variante (id = value_id) when nothing matches, appended to an EXISTING grupo', () => {
    const plan = planTaxonomia(
      [grupoSize],
      [combo({ id: 'SIZE', value_id: '190', value_name: 'G' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.varianteId).toBe('190');
    expect(plan.variantesToAppend).toEqual([
      { grupoId: 'SIZE', variante: expect.objectContaining({ id: '190', nome: 'G' }) },
    ]);
    expect(plan.gruposToCreate).toHaveLength(0);
  });

  it('falls back to a slug id when the value has no value_id', () => {
    const plan = planTaxonomia(
      [grupoSize],
      [combo({ id: 'SIZE', value_name: 'Extra Grande' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]!.varianteId).toBe('n-extra-grande');
  });

  it('variacoesIds stays in sync with variacoes after an append', () => {
    const plan = planTaxonomia(
      [grupoSize],
      [combo({ id: 'SIZE', value_id: '190', value_name: 'G' })],
      INTEGRACAO_ID,
      NOW,
    );
    const created = plan.variantesToAppend[0]!.variante;
    expect(created.id).toBe('190');
    // the create-vs-append delta is what's returned; variacoesIds sync itself
    // is exercised end-to-end in importTaxonomia.test.ts (it lives on the doc).
  });
});

/* --------------------------- externalVariacaoLinks stamping -------------- */

describe('planTaxonomia — externalVariacaoLinks stamping', () => {
  it('stamps a matched variante that is missing the link for this integracao', () => {
    const grupoSize = grupo('SIZE', {
      tipo: 1,
      variacoes: [{ id: '170', nome: 'M', timestamp: 1, externalVariacaoLinks: [] }],
      variacoesIds: ['170'],
    });
    const plan = planTaxonomia(
      [grupoSize],
      [combo({ id: 'SIZE', value_id: '170', value_name: 'M' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.linksToStamp).toEqual([
      {
        grupoId: 'SIZE',
        varianteId: '170',
        link: {
          tipo: 1,
          integracaoId: INTEGRACAO_ID,
          externalId: '170',
          externalName: 'M',
          timestamp: NOW,
        },
      },
    ]);
  });

  it('does not duplicate a stamp already present for the same integracaoId+externalId', () => {
    const grupoSize = grupo('SIZE', {
      tipo: 1,
      variacoes: [
        {
          id: '170',
          nome: 'M',
          timestamp: 1,
          externalVariacaoLinks: [
            {
              tipo: 1,
              integracaoId: INTEGRACAO_ID,
              externalId: '170',
              externalName: 'M',
              timestamp: 1,
            },
          ],
        },
      ],
      variacoesIds: ['170'],
    });
    const plan = planTaxonomia(
      [grupoSize],
      [combo({ id: 'SIZE', value_id: '170', value_name: 'M' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.linksToStamp).toHaveLength(0);
  });

  it('a freshly created variante carries its stamp inline (no separate linksToStamp entry)', () => {
    const plan = planTaxonomia(
      [],
      [combo({ id: 'SIZE', value_id: '170', value_name: 'M' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.linksToStamp).toHaveLength(0);
    const created = plan.gruposToCreate[0]!.data.variacoes![0]!;
    expect(created.externalVariacaoLinks).toEqual([
      {
        tipo: 1,
        integracaoId: INTEGRACAO_ID,
        externalId: '170',
        externalName: 'M',
        timestamp: NOW,
      },
    ]);
  });
});

/* -------------------------- multi-combo / skip rules ---------------------- */

describe('planTaxonomia — multiple combos onto one brand-new grupo', () => {
  it('folds both variantes into the single gruposToCreate entry, not variantesToAppend', () => {
    const plan = planTaxonomia(
      [],
      [
        combo({ id: 'SIZE', value_id: '170', value_name: 'M' }),
        combo({ id: 'SIZE', value_id: '190', value_name: 'G' }),
      ],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.gruposToCreate).toHaveLength(1);
    expect(plan.gruposToCreate[0]!.data.variacoes).toHaveLength(2);
    expect(plan.variantesToAppend).toHaveLength(0);
    expect(plan.resolutions.map((r) => r.varianteId)).toEqual(['170', '190']);
    expect(plan.resolutions.every((r) => r.grupoId === 'SIZE')).toBe(true);
  });
});

describe('planTaxonomia — skip rules', () => {
  it('skips a combo missing both attribute id and name', () => {
    const plan = planTaxonomia([], [combo({ value_id: '1', value_name: 'X' })], INTEGRACAO_ID, NOW);
    expect(plan.resolutions).toHaveLength(0);
    expect(plan.gruposToCreate).toHaveLength(0);
  });

  it('skips a combo missing both value_id and value_name', () => {
    const plan = planTaxonomia([], [combo({ id: 'SIZE', name: 'Talle' })], INTEGRACAO_ID, NOW);
    expect(plan.resolutions).toHaveLength(0);
    expect(plan.gruposToCreate).toHaveLength(0);
  });

  it('processes the same combo (shared across variations) only once', () => {
    const c = combo({ id: 'SIZE', value_id: '170', value_name: 'M' });
    const plan = planTaxonomia([], [c, { ...c }], INTEGRACAO_ID, NOW);
    expect(plan.resolutions).toHaveLength(1);
    expect(plan.gruposToCreate[0]!.data.variacoes).toHaveLength(1);
  });
});

/* --------------------------------- wire shapes ---------------------------- */

describe('planTaxonomia — resolution wire shapes', () => {
  it('grupoUid is the bare grupo id; varianteFake is the canonical fake path', () => {
    const plan = planTaxonomia(
      [],
      [combo({ id: 'SIZE', value_id: '170', value_name: 'M' })],
      INTEGRACAO_ID,
      NOW,
    );
    expect(plan.resolutions[0]).toMatchObject({
      grupoUid: 'SIZE',
      varianteFake: 'documents/grupoDeVariacoes/SIZE/variacoes/170',
    });
  });
});
