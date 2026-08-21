import { describe, expect, it } from 'vitest';
import type { MlItem } from '@delfrance/integrations-mercado-livre';
import { mlCausaSchema } from '@delfrance/schemas';

import {
  CAUSA_VARIACOES_INVALIDAS,
  type MembroFamilia,
  idsDasVariacoesVivas,
  planejarPoda,
  temCausaVariacoesInvalidas,
} from './variacoesFantasma';

const causa = (code: string | null) => mlCausaSchema.parse({ code, mensagem: 'x' });

/** A member link row, defaulting to a legacy-model one carrying a numeric id. */
function membro(raw: Record<string, unknown>, id = 'v1', produtoId = 'CHILD-1'): MembroFamilia {
  return { docId: id, produtoId, raw };
}

const item = (over: Partial<MlItem> = {}): MlItem =>
  ({ id: 'MLB111', status: 'active', ...over }) as MlItem;

describe('temCausaVariacoesInvalidas', () => {
  it('recognises the legacy cause code and nothing else', () => {
    expect(temCausaVariacoesInvalidas([causa(CAUSA_VARIACOES_INVALIDAS)])).toBe(true);
    // The neighbouring code the legacy sender handled on its OWN branch — it
    // latched the listing and never pruned, so matching it here would prune a
    // family whose variations are fine.
    expect(temCausaVariacoesInvalidas([causa('item.variations.not_updatable')])).toBe(false);
    expect(temCausaVariacoesInvalidas([causa('item.attributes.missing_required')])).toBe(false);
    expect(temCausaVariacoesInvalidas([causa(null)])).toBe(false);
    expect(temCausaVariacoesInvalidas([])).toBe(false);
  });

  it('finds the cause among others — a 400 body mixes them', () => {
    expect(
      temCausaVariacoesInvalidas([
        causa('item.attributes.invalid'),
        causa(CAUSA_VARIACOES_INVALIDAS),
      ]),
    ).toBe(true);
  });
});

describe('idsDasVariacoesVivas', () => {
  it('stringifies every id ML reports, numeric or string', () => {
    // ML has sent both over time (`itemVariationSchema`), and the stored side is
    // an int on rows this app writes — so the comparison has to be by string,
    // exactly as legacy's `variations.map((e) => e['id'].toString())` was.
    expect(idsDasVariacoesVivas(item({ variations: [{ id: 101 }, { id: '202' }] }))).toEqual(
      new Set(['101', '202']),
    );
  });

  it('an id-less entry contributes nothing (it must not make every id look live)', () => {
    expect(idsDasVariacoesVivas(item({ variations: [{ id: null }, {}] }))).toEqual(new Set());
    expect(idsDasVariacoesVivas(item({ variations: null }))).toEqual(new Set());
    expect(idsDasVariacoesVivas(item())).toEqual(new Set());
  });
});

describe('planejarPoda', () => {
  it('marks the stale id and keeps the live ones', () => {
    const alvos = planejarPoda(
      [
        membro({ id: 101 }, 'v1', 'C1'),
        membro({ id: 999 }, 'v2', 'C2'), // gone from ML
        membro({ id: 303 }, 'v3', 'C3'),
      ],
      new Set(['101', '303']),
    );
    expect(alvos).toEqual([{ docId: 'v2', produtoId: 'C2', raw: { id: 999 }, variacaoId: '999' }]);
  });

  it('tolerates a stringified stored id (Flutter-authored rows)', () => {
    expect(planejarPoda([membro({ id: '101' })], new Set(['101']))).toEqual([]);
    expect(planejarPoda([membro({ id: '999' })], new Set(['101']))).toHaveLength(1);
  });

  it('never prunes a member that names no variation — it was never published', () => {
    // Legacy's own `variationsIds.contains(externalId)` could not match a null
    // either. Marking it `closed` would latch a member yet to be sent at all.
    expect(planejarPoda([membro({ id: null })], new Set(['101']))).toEqual([]);
    expect(planejarPoda([membro({})], new Set(['101']))).toEqual([]);
    expect(planejarPoda([membro({ id: '' })], new Set(['101']))).toEqual([]);
    expect(planejarPoda([membro({ id: Number.NaN })], new Set(['101']))).toEqual([]);
  });

  it('never prunes a User-Products member, whose identity is `itemId` (#1142)', () => {
    // Unreachable behind the caller's `family_name` guard for a pure family, but
    // a listing caught mid-migration holds both shapes — and a legacy-shaped diff
    // must never speak for a UP member.
    expect(planejarPoda([membro({ id: 999, itemId: 'MLB999' })], new Set(['101']))).toEqual([]);
  });

  it('is idempotent — an already-closed member is not re-marked', () => {
    // A Cloud Tasks retry, or a second rejection before the next sweep, must
    // write nothing rather than churn every child of the family.
    const membros = [
      membro({ id: 999 }, 'v1', 'C1'),
      membro({ id: 888, status: 'closed' }, 'v2', 'C2'),
    ];
    expect(planejarPoda(membros, new Set()).map((a) => a.docId)).toEqual(['v1']);
    // ...and once the first one is marked too, a further pass plans nothing.
    const jaPodados = [membro({ id: 999, status: 'closed' }, 'v1', 'C1'), membros[1]!];
    expect(planejarPoda(jaPodados, new Set())).toEqual([]);
  });

  it('an EMPTY live set prunes every published legacy member', () => {
    // The shape ML answers with when the listing lost its variations entirely.
    expect(planejarPoda([membro({ id: 1 }, 'a'), membro({ id: 2 }, 'b')], new Set())).toHaveLength(
      2,
    );
  });
});
