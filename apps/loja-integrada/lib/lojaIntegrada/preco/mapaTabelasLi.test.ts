/**
 * `mapaTabelasLi.ts` (master plan step 13, PR 13-e): which contas a produto write concerns for the
 * price. The anchor is matched EXACTLY, so every "same conta" decision is pinned with an EQUAL
 * pair and a NEAR-MISS that must stay distinct (root `CLAUDE.md`, the fold rule). The map is cached
 * per instance: the query count, the TTL and the empty-map answer are pinned on a counting fake,
 * and the one query is pinned against `firestore.indexes.json` (Enterprise full-scans an
 * undeclared one). Every id is invented.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_TTL, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  __setRelogioDoMapaTabelasParaTestes,
  contasDaAncoraLi,
  contasDoEventoPrecoLi,
  lerMapaTabelasLi,
  mapaTabelasLi,
} from './mapaTabelasLi';

const T0 = 1_790_000_000_000;
let agora = T0;

beforeEach(() => {
  __resetAllReadCaches();
  agora = T0;
  __setRelogioDoMapaTabelasParaTestes(() => agora);
  vi.stubGlobal('fetch', () => {
    throw new Error('mapaTabelasLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoMapaTabelasParaTestes();
  vi.unstubAllGlobals();
});

const TN = 'tab-normal';
const TP = 'tab-promo';

const resumo = (
  integracaoId: string,
  over: Partial<{
    ativo: boolean;
    tabelaNormalId: string | null;
    tabelaPromocionalId: string | null;
  }> = {},
) => ({
  integracaoId,
  ativo: true,
  tabelaNormalId: TN,
  tabelaPromocionalId: TP,
  ...over,
});

const ancora = (...contas: unknown[]): DocData => ({ integracoesComProduto: contas });

describe('mapaTabelasLi — ACTIVE contas that name a normal tabela, only', () => {
  it('an active conta with a normal tabela is in, its promo kept AS STORED', () => {
    const mapa = mapaTabelasLi([
      resumo('a'),
      resumo('b', { tabelaPromocionalId: TN }),
      resumo('c', { tabelaPromocionalId: null }),
    ]);
    expect([...mapa.values()]).toEqual([
      { contaId: 'a', tabelaNormalId: TN, tabelaPromocionalId: TP },
      // A promo equal to the normal one stays as stored: the price function reads it.
      { contaId: 'b', tabelaNormalId: TN, tabelaPromocionalId: TN },
      { contaId: 'c', tabelaNormalId: TN, tabelaPromocionalId: null },
    ]);
  });

  it('⚠️ an INACTIVE conta is out | near-miss: the same conta active is in', () => {
    expect(mapaTabelasLi([resumo('a', { ativo: false })]).size).toBe(0);
    expect(mapaTabelasLi([resumo('a', { ativo: true })]).get('a')).toEqual({
      contaId: 'a',
      tabelaNormalId: TN,
      tabelaPromocionalId: TP,
    });
  });

  it('⚠️ a conta naming NO normal tabela is out, even with a promotional one (inert)', () => {
    expect(mapaTabelasLi([resumo('a', { tabelaNormalId: null })]).size).toBe(0);
  });
});

describe('contasDaAncoraLi — the payload anchor, zero reads', () => {
  it('before ∪ after, deduplicated and sorted', () => {
    expect(contasDaAncoraLi(ancora('c2', 'c1'), ancora('c1', 'c3', 'c3'))).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });

  it('a conta only on the BEFORE side (a link removed in the same write) is in; a create and a delete read the side that exists', () => {
    expect(contasDaAncoraLi(ancora('c1'), ancora())).toEqual(['c1']);
    expect(contasDaAncoraLi(null, ancora('c1'))).toEqual(['c1']);
    expect(contasDaAncoraLi(ancora('c1'), null)).toEqual(['c1']);
    expect(contasDaAncoraLi(null, null)).toEqual([]);
  });

  it.each([
    ['absent', {}],
    ['null', { integracoesComProduto: null }],
    ['a string', { integracoesComProduto: 'c1' }],
    ['an object', { integracoesComProduto: { c1: true } }],
  ])('a side whose anchor is %s contributes nothing', (_r, lado) => {
    expect(contasDaAncoraLi(lado, lado)).toEqual([]);
  });

  it('non-string elements are ignored', () => {
    expect(contasDaAncoraLi(ancora(1, null, { id: 'c1' }, 'c2'), null)).toEqual(['c2']);
  });

  it('an INHERITED anchor is not stored data', () => {
    const herdado = Object.create({ integracoesComProduto: ['c1'] }) as DocData;
    expect(contasDaAncoraLi(herdado, herdado)).toEqual([]);
  });
});

describe('contasDoEventoPrecoLi — the anchor ∩ the map, EXACT', () => {
  const mapa = mapaTabelasLi([resumo('c2'), resumo('c1'), resumo('c3')]);

  it('EQUAL: the anchor’s bare ids select their contas, sorted by conta id', () => {
    expect(contasDoEventoPrecoLi(mapa, ['c3', 'c1']).map((c) => c.contaId)).toEqual(['c1', 'c3']);
  });

  it.each([
    ['a leading space', ' c1'],
    ['a case change', 'C1'],
    ['the canonical ref form', 'documents/integracao/c1'],
    ['the bare ref form', 'integracao/c1'],
  ])('⚠️ NEAR-MISS: %s never matches the conta c1', (_r, id) => {
    expect(contasDoEventoPrecoLi(mapa, [id])).toEqual([]);
  });

  it('a map conta the anchor does not list is out; an anchor conta the map lacks is out', () => {
    expect(contasDoEventoPrecoLi(mapa, ['c2', 'c-fora']).map((c) => c.contaId)).toEqual(['c2']);
    expect(contasDoEventoPrecoLi(mapa, [])).toEqual([]);
  });

  it('a repeated anchor id yields its conta ONCE', () => {
    expect(contasDoEventoPrecoLi(mapa, ['c1', 'c1'])).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                              The cached read                                */
/* -------------------------------------------------------------------------- */

function seedConta(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(`integracao/${id}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: `Loja ${id}`,
    ativo: true,
    tabelaNormalOuterRef: `documents/listaDePrecos/${TN}`,
    tabelaPromocionalOuterRef: `documents/listaDePrecos/${TP}`,
    ...over,
  });
}

interface Indice {
  readonly collectionGroup: string;
  readonly queryScope: string;
  readonly fields: readonly { readonly fieldPath: string; readonly order?: string }[];
}

function indices(): readonly Indice[] {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
  return (
    JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
      indexes: Indice[];
    }
  ).indexes;
}

describe('lerMapaTabelasLi — one enumeration per TTL per instance', () => {
  it('⚠️ INDEX PIN: reads the conta enumeration ONCE, on the declared COLLECTION integracao (tipo ASC, nome ASC) index', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedConta(db, 'b', { ativo: false });
    seedConta(db, 's', { tipo: 5 });
    seedConta(db, 'sem-tabela', { tabelaNormalOuterRef: null });

    const mapa = await lerMapaTabelasLi(asDb(db));

    // Only the active Loja Integrada conta naming a normal tabela.
    expect([...mapa.keys()]).toEqual(['a']);
    expect(db.consultas).toEqual([
      {
        colecao: 'integracao',
        filtros: [['tipo', '==', INTEGRACAO_TIPO.lojaIntegrada]],
        ordens: [['nome', 'asc']],
        limite: null,
        apos: null,
      },
    ]);
    expect(db.leituras).toEqual([]);
    const declarado = indices().filter(
      (i) =>
        i.collectionGroup === 'integracao' &&
        i.queryScope === 'COLLECTION' &&
        JSON.stringify(i.fields.map((f) => [f.fieldPath, f.order])) ===
          JSON.stringify([
            ['tipo', 'ASCENDING'],
            ['nome', 'ASCENDING'],
          ]),
    );
    expect(declarado).toHaveLength(1);
  });

  it('a conta storing the normal tabela BARE and the promo CANONICAL reads the same bare ids', async () => {
    const db = new FakeDb();
    seedConta(db, 'a', {
      tabelaNormalOuterRef: `listaDePrecos/${TN}`,
      tabelaPromocionalOuterRef: `documents/listaDePrecos/${TP}`,
    });
    expect((await lerMapaTabelasLi(asDb(db))).get('a')).toEqual({
      contaId: 'a',
      tabelaNormalId: TN,
      tabelaPromocionalId: TP,
    });
  });

  it('within the TTL: a second and a third event cost NO query; after it, one more', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');

    await lerMapaTabelasLi(asDb(db));
    agora = T0 + READ_CACHE_TTL.config - 1;
    await lerMapaTabelasLi(asDb(db));
    await lerMapaTabelasLi(asDb(db));
    expect(db.consultas).toHaveLength(1);

    agora = T0 + READ_CACHE_TTL.config + 1;
    await lerMapaTabelasLi(asDb(db));
    expect(db.consultas).toHaveLength(2);
    expect(READ_CACHE_TTL.config).toBe(900_000);
  });

  it('an EMPTY map is an answer and is cached (a project with no priced conta pays one query per TTL)', async () => {
    const db = new FakeDb();
    seedConta(db, 's', { tipo: 5 });
    seedConta(db, 'inativa', { ativo: false });

    expect((await lerMapaTabelasLi(asDb(db))).size).toBe(0);
    // Past the NEGATIVE TTL too: an empty map is never cached as "absent".
    agora = T0 + READ_CACHE_TTL.negative + 1;
    expect((await lerMapaTabelasLi(asDb(db))).size).toBe(0);
    expect(db.consultas).toHaveLength(1);
  });

  it('concurrent misses share ONE load; a failed load is not cached', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    await Promise.all([lerMapaTabelasLi(asDb(db)), lerMapaTabelasLi(asDb(db))]);
    expect(db.consultas).toHaveLength(1);

    __resetAllReadCaches();
    const falha = new Error('teste: consulta falhou');
    db.falharConsulta('integracao', falha);
    await expect(lerMapaTabelasLi(asDb(db))).rejects.toBe(falha);
    db.falharConsulta('integracao', null);
    expect((await lerMapaTabelasLi(asDb(db))).size).toBe(1);
    expect(db.consultas).toHaveLength(2);
  });

  it('__resetAllReadCaches resets it: the next event reads again', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    await lerMapaTabelasLi(asDb(db));
    __resetAllReadCaches();
    await lerMapaTabelasLi(asDb(db));
    expect(db.consultas).toHaveLength(2);
  });

  it('the shared cache’s stats sampler is OFF: 600 warm reads write no console line (it would log at the wrong severity, on every ERP produto write past it)', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The shared sampler's default fires on every 500th get of a cache instance.
      for (let i = 0; i < 600; i += 1) await lerMapaTabelasLi(asDb(db));
      expect(aviso).not.toHaveBeenCalled();
    } finally {
      aviso.mockRestore();
    }
    expect(db.consultas).toHaveLength(1);
  });

  it('it is its OWN cache: the stock trigger’s depósito map and this one never share an entry', async () => {
    const { lerMapaDepositosLi } = await import('../estoque/depositosLi');
    const db = new FakeDb();
    seedConta(db, 'a', { depositoOuterRef: 'documents/depositos/dep-1' });
    await lerMapaDepositosLi(asDb(db));
    await lerMapaTabelasLi(asDb(db));
    expect(db.consultas).toHaveLength(2);
  });
});
