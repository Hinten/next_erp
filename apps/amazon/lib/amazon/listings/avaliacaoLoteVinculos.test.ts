/**
 * The shared batched link reader on the counting fake db: per SKU the verdict,
 * its input and the unit's parent are exactly what the per-SKU reader gives
 * alone, for the stock and the price flows; every document read once across
 * the SKUs; the unit read on its own only when no dono's read holds its
 * fields; and the deadline. The price masks with a `precos` entry run here on
 * the fake db's two-segment mask, and on the emulator
 * (`avaliacaoLoteVinculos.firestore.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_REFS_GETALL_ESTOQUE_AMAZON } from '../estoque/familiaEstoqueFirestore';
import { FakeDb, asDb } from '../testing/fakeDb';
import { FLUXO_LISTING_AMAZON, type FluxoListingAmazon } from './fluxoListing';
import {
  type AvaliacaoVinculosAmazon,
  LARGURA_CONSULTAS_VINCULOS_AMAZON,
  MAX_REFS_GETALL_VINCULOS_AMAZON,
  type OpcoesAvaliacaoVinculosAmazon,
  avaliarVinculosEmLoteAmazon,
  lerProdutosPorIdListingAmazon,
  lerVinculosDosSkusListingAmazon,
  paiDaUnidadeNoLoteListingAmazon,
  paiIdsDasUnidadesListingAmazon,
} from './avaliacaoLoteVinculos';
import {
  type CamposVinculoListingAmazon,
  camposDoResolverListingAmazon,
  lerVinculoListingAmazon,
} from './resolverVinculo';
import {
  type EnvioDoVinculoListingAmazon,
  type RegraVinculoListingAmazon,
  avaliarVinculoListingAmazon,
} from './vinculoListing';

const CONTA = 'conta-lote-vinculos';
const CANONICA = `documents/integracao/${CONTA}`;
const AGORA = 1_000_000;

const CAMPOS: Readonly<Record<FluxoListingAmazon, CamposVinculoListingAmazon>> = {
  [FLUXO_LISTING_AMAZON.estoque]: camposDoResolverListingAmazon({
    fluxo: FLUXO_LISTING_AMAZON.estoque,
  }),
  [FLUXO_LISTING_AMAZON.preco]: camposDoResolverListingAmazon({
    fluxo: FLUXO_LISTING_AMAZON.preco,
    tabelaIds: [],
  }),
};

/** Each flow's outcome, read as its bare clock. */
const regra = (
  fluxo: FluxoListingAmazon,
): RegraVinculoListingAmazon<EnvioDoVinculoListingAmazon> => ({
  fluxo,
  lerEnvio: (valor) =>
    typeof valor === 'object' &&
    valor !== null &&
    typeof (valor as { emMs?: unknown }).emMs === 'number'
      ? { emMs: (valor as { emMs: number }).emMs }
      : null,
});

let db: FakeDb;
let relogio: number;

beforeEach(() => {
  db = new FakeDb();
  relogio = AGORA;
});

function produto(id: string, dados: Record<string, unknown> = {}) {
  db.seed(`produtos/${id}`, { nome: `Produto ${id}`, ...dados });
}

function vinculo(
  produtoId: string,
  linkId: string,
  sku: string,
  dados: Record<string, unknown> = {},
) {
  db.seed(`produtos/${produtoId}/prodAmazon/${linkId}`, {
    contaAmazonOuterRef: CANONICA,
    sku,
    asin: `B0ZZ${sku
      .replace(/[^A-Z]/g, '')
      .padEnd(6, 'Z')
      .slice(0, 6)}`,
    productDataJson: { pesado: 'x'.repeat(32) },
    ...dados,
  });
}

function opcoes(
  fluxo: FluxoListingAmazon,
  over: Partial<OpcoesAvaliacaoVinculosAmazon<EnvioDoVinculoListingAmazon>> = {},
): OpcoesAvaliacaoVinculosAmazon<EnvioDoVinculoListingAmazon> {
  return {
    campos: CAMPOS[fluxo],
    regra: regra(fluxo),
    prazo: { agora: () => relogio, prazoMs: AGORA + 60_000 },
    ...over,
  };
}

const avaliar = (skus: readonly string[], fluxo: FluxoListingAmazon, over = {}) =>
  avaliarVinculosEmLoteAmazon(asDb(db), CONTA, skus, opcoes(fluxo, over));

function completa<E extends EnvioDoVinculoListingAmazon>(r: AvaliacaoVinculosAmazon<E>) {
  if (r.tipo !== 'completa') throw new Error(`esperava completa, veio ${r.tipo}`);
  return r;
}

/** Every resolver shape the verdict tells apart, plus price's parent cases. */
function semearFormas(): string[] {
  produto('S');
  vinculo('S', 'l1', 'S-SIMPLES');
  produto('W', { paiId: null, filhoUnicoId: 'M', propagatePriceToChildren: true });
  produto('M', { paiId: 'W' });
  vinculo('W', 'l1', 'S-WRAPPER');
  produto('K', { ehKit: true, paiId: null, filhoUnicoId: 'KM' });
  produto('KM', { paiId: 'K' });
  vinculo('K', 'l1', 'S-KIT');
  produto('U2');
  produto('U2a', { paiId: 'U2', nome: 'a' });
  produto('U2b', { paiId: 'U2', nome: 'b' });
  vinculo('U2', 'l1', 'S-VARIACOES');
  produto('PAI', { propagatePriceToChildren: false });
  vinculo('PAI', 'lp', 'S-PAI', { asin: 'B0ZZFILHOA' });
  produto('F', { paiId: 'PAI' });
  vinculo('F', 'l1', 'S-FILHO', {
    asin: 'B0ZZFILHOA',
    produtoAmazonPaiOuterRef: 'documents/produtos/PAI/prodAmazon/lp',
  });
  produto('F2', { paiId: 'PAI' });
  vinculo('F2', 'l1', 'S-FILHO2', { produtoAmazonPaiOuterRef: 'produtos/PAI/prodAmazon/lp' });
  produto('IL');
  vinculo('IL', 'l1', 'S-ILEGIVEL', { produtoAmazonPaiOuterRef: 'produtos/PAI' });
  produto('A1');
  produto('A2');
  vinculo('A1', 'l1', 'S-AMBIGUO');
  vinculo('A2', 'l1', 'S-AMBIGUO');
  produto('VIVO', { paiId: 'SUMIDO' });
  vinculo('VIVO', 'l1', 'S-UM-SUMIDO');
  vinculo('NAO-EXISTE', 'l1', 'S-UM-SUMIDO');
  produto('OPT', {
    statusProdutosMarketplace: { [`${CONTA}_B0ZZOPTOUT`]: { enviarEstoque: false } },
  });
  vinculo('OPT', 'l1', 'S-OPTOUT', { asin: 'B0ZZOPTOUT' });
  produto('CORR', { paiId: 'x/y' });
  vinculo('CORR', 'l1', 'S-PAI-CORROMPIDO');
  for (let i = 0; i < 10; i += 1) {
    produto(`LIM${i}`);
    vinculo(`LIM${i}`, 'l1', 'S-LIMITE');
  }
  return [
    'S-SIMPLES',
    'S-WRAPPER',
    'S-KIT',
    'S-VARIACOES',
    'S-FILHO',
    'S-FILHO2',
    'S-ILEGIVEL',
    'S-AMBIGUO',
    'S-UM-SUMIDO',
    'S-OPTOUT',
    'S-PAI-CORROMPIDO',
    'S-LIMITE',
    'S-NENHUM',
  ];
}

describe('★ parity: every SKU gets the per-SKU reader’s own verdict, input and parent', () => {
  it.each([FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco])(
    '%s: a batch of every shape',
    async (fluxo) => {
      const skus = semearFormas();
      const r = completa(await avaliar(skus, fluxo));
      expect(r.skus.map((s) => s.sku).sort()).toEqual([...skus].sort());
      const veredictos: Record<string, string> = {};
      for (const s of r.skus) {
        const sozinho = await lerVinculoListingAmazon(asDb(db), CONTA, s.sku, CAMPOS[fluxo]);
        expect(s.entrada, s.sku).toEqual(sozinho.entrada);
        expect(s.paiDaUnidade, s.sku).toEqual(sozinho.paiDaUnidade);
        expect(s.veredicto, s.sku).toEqual(
          avaliarVinculoListingAmazon(sozinho.entrada, regra(fluxo)),
        );
        veredictos[s.sku] = s.veredicto.apto ? 'apto' : s.veredicto.motivo;
      }
      // Anti-vacuity: the fixtures reach every verdict, and price's opt-out is no refusal.
      expect(veredictos).toEqual({
        'S-SIMPLES': 'apto',
        'S-WRAPPER': 'apto',
        'S-KIT': 'apto',
        'S-VARIACOES': 'unidade-com-variacoes',
        'S-FILHO': 'filho-com-sku-do-pai',
        'S-FILHO2': 'apto',
        'S-ILEGIVEL': 'pai-do-vinculo-ilegivel',
        'S-AMBIGUO': 'vinculo-ambiguo',
        'S-UM-SUMIDO': 'apto',
        'S-OPTOUT': fluxo === FLUXO_LISTING_AMAZON.estoque ? 'envio-desligado' : 'apto',
        'S-PAI-CORROMPIDO': 'apto',
        'S-LIMITE': 'vinculo-ambiguo',
        'S-NENHUM': 'produto-ausente',
      });
    },
  );

  it.each([FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco])(
    '%s: the same parity when the caller reads extras on the donos and the units',
    async (fluxo) => {
      const skus = semearFormas();
      const r = completa(
        await avaliar(skus, fluxo, { extras: { dono: ['nome'], unidade: ['nome'] } }),
      );
      for (const s of r.skus) {
        const sozinho = await lerVinculoListingAmazon(asDb(db), CONTA, s.sku, CAMPOS[fluxo]);
        expect(s.entrada, s.sku).toEqual(sozinho.entrada);
        expect(s.paiDaUnidade, s.sku).toEqual(sozinho.paiDaUnidade);
      }
      // Anti-vacuity: the extras were read — a bound unit's document carries its
      // label, which the verdict's input never does.
      const simples = r.skus.find((s) => s.sku === 'S-SIMPLES');
      expect(simples?.unidade).toMatchObject({ nome: 'Produto S' });
      expect(simples?.entrada.dono?.raw).not.toHaveProperty('nome');
    },
  );

  it('★ price reads each unit’s parent, deduplicated; stock reads none (NEAR-MISS)', async () => {
    const skus = semearFormas();
    const preco = completa(await avaliar(skus, FLUXO_LISTING_AMAZON.preco));
    const pai = (sku: string) => preco.skus.find((s) => s.sku === sku)?.paiDaUnidade;
    expect(pai('S-WRAPPER')).toEqual({ id: 'W', raw: { propagatePriceToChildren: true } });
    expect(pai('S-FILHO2')).toEqual({ id: 'PAI', raw: { propagatePriceToChildren: false } });
    expect(pai('S-UM-SUMIDO')).toEqual({ id: 'SUMIDO', raw: null });
    expect(pai('S-PAI-CORROMPIDO')).toEqual({ id: null, raw: null });
    expect(pai('S-SIMPLES')).toBeNull();
    expect(pai('S-KIT')).toBeNull();
    // S-FILHO and S-FILHO2 share PAI: ONE parent read in the batch, masked.
    const lidosDoPai = db.leiturasDetalhadas.filter(
      (l) => l.caminho === 'produtos/PAI' && l.mascara?.includes('propagatePriceToChildren'),
    );
    expect(lidosDoPai).toHaveLength(1);
    expect(preco.leituras.pais).toBe(3);

    db.leiturasDetalhadas.length = 0;
    const estoque = completa(await avaliar(skus, FLUXO_LISTING_AMAZON.estoque));
    expect(estoque.skus.every((s) => s.paiDaUnidade === null)).toBe(true);
    expect(estoque.leituras.pais).toBe(0);
    expect(db.leiturasDetalhadas.some((l) => l.mascara?.includes('propagatePriceToChildren'))).toBe(
      false,
    );
  });
});

describe('★ every read masked, each document read once across the SKUs', () => {
  it('the donos, the units and the children deduplicated; the unit taken off its dono’s read', async () => {
    db.exigirMascaraEm('produtos');
    db.exigirMascaraEm('prodAmazon');
    produto('W', { paiId: null, filhoUnicoId: 'M' });
    produto('M', { paiId: 'W' });
    vinculo('W', 'l1', 'SKU-1');
    vinculo('W', 'l2', 'SKU-2');
    vinculo('M', 'l1', 'SKU-3');
    const r = completa(await avaliar(['SKU-1', 'SKU-2', 'SKU-3'], FLUXO_LISTING_AMAZON.estoque));
    expect(r.skus.map((s) => s.veredicto.apto)).toEqual([true, true, true]);
    const produtos = db.leiturasDetalhadas.filter((l) => /^produtos\/[^/]+$/.test(l.caminho));
    expect(produtos.map((l) => l.caminho).sort()).toEqual(['produtos/M', 'produtos/W']);
    expect(r.leituras).toMatchObject({ consultas: 3, produtos: 2, filhos: 1, ponteiros: 0 });
  });

  it('★ a unit is read ON ITS OWN when no dono’s read carried its fields (NEAR-MISS: the dono read them too)', async () => {
    produto('P', { ehKitVirtual: false });
    vinculo('P', 'l1', 'SKU-P');
    const proprio = completa(
      await avaliar(['SKU-P'], FLUXO_LISTING_AMAZON.estoque, {
        extras: { dono: [], unidade: ['ehKitVirtual'] },
      }),
    );
    expect(db.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/P')).toHaveLength(2);
    expect(proprio.skus[0]?.unidade).toEqual({ ehKitVirtual: false });

    db.leiturasDetalhadas.length = 0;
    const doDono = completa(
      await avaliar(['SKU-P'], FLUXO_LISTING_AMAZON.estoque, {
        extras: { dono: ['ehKitVirtual'], unidade: ['ehKitVirtual'] },
      }),
    );
    expect(db.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/P')).toHaveLength(1);
    expect(doDono.skus[0]?.unidade).toMatchObject({ ehKitVirtual: false });
    // Either way the verdict's input is projected to the flow's own fields.
    expect(proprio.skus[0]?.entrada.unidade.raw).toEqual({});
    expect(doDono.skus[0]?.entrada.unidade.raw).toEqual({});
  });

  it('the units’ parents in getAll slices of at most 300', async () => {
    const skus: string[] = [];
    for (let i = 0; i < MAX_REFS_GETALL_VINCULOS_AMAZON + 1; i += 1) {
      const n = String(i).padStart(3, '0');
      produto(`F${n}`, { paiId: `PAI${n}` });
      vinculo(`F${n}`, 'l1', `SKU-${n}`);
      skus.push(`SKU-${n}`);
    }
    const r = completa(await avaliar(skus, FLUXO_LISTING_AMAZON.preco));
    expect(r.leituras.pais).toBe(MAX_REFS_GETALL_VINCULOS_AMAZON + 1);
    const chamadas = new Set(
      db.leiturasDetalhadas
        .filter((l) => l.caminho.startsWith('produtos/PAI'))
        .map((l) => l.chamada),
    );
    expect(chamadas.size).toBe(2);
  });
});

/**
 * `real` with every query's `get` held in flight for a tick and counted, by
 * kind: a collection-group query (the link queries) or a collection one (the
 * children seeks). Refs and `getAll` pass through untouched.
 */
function comVoo(real: FakeDb): {
  readonly db: Firestore;
  readonly pico: { grupo: number; colecao: number };
} {
  const emVoo = { grupo: 0, colecao: 0 };
  const pico = { grupo: 0, colecao: 0 };
  type Tipo = keyof typeof emVoo;
  const atrasar = async <T>(tipo: Tipo, fn: () => Promise<T>): Promise<T> => {
    emVoo[tipo] += 1;
    pico[tipo] = Math.max(pico[tipo], emVoo[tipo]);
    await new Promise((r) => setTimeout(r, 1));
    try {
      return await fn();
    } finally {
      emVoo[tipo] -= 1;
    }
  };
  const embrulhar = <Q extends object>(q: Q, tipo: Tipo): Q =>
    new Proxy(q, {
      get(alvo, chave) {
        const v = Reflect.get(alvo, chave) as unknown;
        if (typeof v !== 'function') return v;
        if (chave === 'get') {
          return () => atrasar(tipo, () => (v as () => Promise<unknown>).call(alvo));
        }
        return (...args: unknown[]) => {
          const saida = (v as (...a: unknown[]) => unknown).apply(alvo, args);
          return typeof saida === 'object' && saida !== null && 'get' in saida
            ? embrulhar(saida, tipo)
            : saida;
        };
      },
    });
  const db = new Proxy(asDb(real), {
    get(alvo, chave) {
      const v = Reflect.get(alvo, chave) as unknown;
      if (typeof v !== 'function') return v;
      if (chave === 'collectionGroup' || chave === 'collection') {
        const tipo: Tipo = chave === 'collectionGroup' ? 'grupo' : 'colecao';
        return (...args: unknown[]) =>
          embrulhar((v as (...a: unknown[]) => object).apply(alvo, args), tipo);
      }
      return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(alvo, args);
    },
  });
  return { db, pico };
}

/** `n` simple produtos, each its own dono and unit with ONE link: `n` SKUs. */
function semearSimples(n: number): string[] {
  const skus: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `P${String(i).padStart(3, '0')}`;
    produto(id);
    vinculo(id, 'l1', `SKU-${id}`);
    skus.push(`SKU-${id}`);
  }
  return skus;
}

describe('★ the in-flight bound', () => {
  it(`keeps at most ${String(LARGURA_CONSULTAS_VINCULOS_AMAZON)} link queries and as many children seeks in flight`, async () => {
    // The bound itself: a wider one reds here, a narrower one below.
    expect(LARGURA_CONSULTAS_VINCULOS_AMAZON).toBe(16);
    const skus = semearSimples(LARGURA_CONSULTAS_VINCULOS_AMAZON + 1);
    const voo = comVoo(db);
    const r = completa(
      await avaliarVinculosEmLoteAmazon(voo.db, CONTA, skus, opcoes(FLUXO_LISTING_AMAZON.estoque)),
    );
    expect(r.skus.map((s) => s.veredicto.apto)).toEqual(skus.map(() => true));
    // EXACTLY the bound: 17 of each kind arrive at once.
    expect(voo.pico).toEqual({
      grupo: LARGURA_CONSULTAS_VINCULOS_AMAZON,
      colecao: LARGURA_CONSULTAS_VINCULOS_AMAZON,
    });
    expect(r.leituras).toMatchObject({ consultas: skus.length, filhos: skus.length });
  });

  it('the deadline is read between two batches of link queries: passed after the first ⇒ prazo at vinculos, nothing counted', async () => {
    const skus = semearSimples(LARGURA_CONSULTAS_VINCULOS_AMAZON + 1);
    const prazoMs = AGORA + 60_000;
    const r = await avaliarVinculosEmLoteAmazon(asDb(db), CONTA, skus, {
      ...opcoes(FLUXO_LISTING_AMAZON.estoque),
      prazo: {
        agora: () => (db.contagem.consultas >= LARGURA_CONSULTAS_VINCULOS_AMAZON ? prazoMs : AGORA),
        prazoMs,
      },
    });
    expect(r).toEqual({
      tipo: 'prazo',
      etapa: 'vinculos',
      leituras: { consultas: 0, produtos: 0, filhos: 0, ponteiros: 0, pais: 0 },
    });
    expect(db.contagem.consultas).toBe(LARGURA_CONSULTAS_VINCULOS_AMAZON);
  });

  it('the getAll bound is the stock family read’s, so a stock batch slices its produtos as the stock reads do', () => {
    expect(MAX_REFS_GETALL_VINCULOS_AMAZON).toBe(MAX_REFS_GETALL_ESTOQUE_AMAZON);
  });
});

describe('the by-id reads, on their own', () => {
  it('produtos by id: deduplicated, in code-unit order, masked; an id that is not a document id never read, a gone one null', async () => {
    produto('B', { paiId: 'X' });
    produto('A');
    const chamadas: number[] = [];
    const r = await lerProdutosPorIdListingAmazon(
      asDb(db),
      ['B', 'A', 'B', 'a/b', 'SUMIDO'],
      ['paiId'],
      { venceu: () => false, aoLer: (n) => chamadas.push(n) },
    );
    expect(r === null ? null : [...r]).toEqual([
      ['A', {}],
      ['B', { paiId: 'X' }],
      ['SUMIDO', null],
    ]);
    expect(chamadas).toEqual([3]);
    expect(db.leiturasDetalhadas.map((l) => [l.caminho, l.mascara])).toEqual([
      ['produtos/A', ['paiId']],
      ['produtos/B', ['paiId']],
      ['produtos/SUMIDO', ['paiId']],
    ]);
  });

  it(`at most ${String(MAX_REFS_GETALL_VINCULOS_AMAZON)} a call; the deadline before a call ⇒ null, the calls made told`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_REFS_GETALL_VINCULOS_AMAZON + 1; i += 1) {
      ids.push(`P${String(i).padStart(3, '0')}`);
    }
    const chamadas: number[] = [];
    const tudo = await lerProdutosPorIdListingAmazon(asDb(db), ids, ['nome'], {
      venceu: () => false,
      aoLer: (n) => chamadas.push(n),
    });
    expect(tudo?.size).toBe(ids.length);
    expect(chamadas).toEqual([MAX_REFS_GETALL_VINCULOS_AMAZON, 1]);
    chamadas.length = 0;
    const parado = await lerProdutosPorIdListingAmazon(asDb(db), ids, ['nome'], {
      venceu: () => chamadas.length > 0,
      aoLer: (n) => chamadas.push(n),
    });
    expect(parado).toBeNull();
    expect(chamadas).toEqual([MAX_REFS_GETALL_VINCULOS_AMAZON]);
  });

  it('the parent rule’s two halves: which parents to read, and each unit’s parent from what was read', () => {
    expect(
      paiIdsDasUnidadesListingAmazon([
        { paiId: 'B' },
        { paiId: 'A' },
        { paiId: 'B' },
        null,
        { paiId: null },
        {},
        { paiId: 'a/b' },
      ]),
    ).toEqual(['A', 'B']);
    const mascara = ['propagatePriceToChildren'];
    const pais = new Map<string, Readonly<Record<string, unknown>> | null>([
      ['A', { propagatePriceToChildren: true }],
      ['SUMIDO', null],
    ]);
    expect(paiDaUnidadeNoLoteListingAmazon({ paiId: 'A' }, mascara, pais)).toEqual({
      id: 'A',
      raw: { propagatePriceToChildren: true },
    });
    expect(paiDaUnidadeNoLoteListingAmazon({ paiId: 'SUMIDO' }, mascara, pais)).toEqual({
      id: 'SUMIDO',
      raw: null,
    });
    expect(paiDaUnidadeNoLoteListingAmazon({ paiId: 'a/b' }, mascara, pais)).toEqual({
      id: null,
      raw: null,
    });
    expect(paiDaUnidadeNoLoteListingAmazon({ paiId: null }, mascara, pais)).toBeNull();
    expect(paiDaUnidadeNoLoteListingAmazon(null, mascara, pais)).toBeNull();
    // NEAR-MISS: a flow that reads no parent answers none, whatever the unit names.
    expect(paiDaUnidadeNoLoteListingAmazon({ paiId: 'A' }, null, pais)).toBeNull();
  });
});

describe('the deadline, and the links a caller read', () => {
  it('already past ⇒ prazo before the link queries, nothing read', async () => {
    produto('P');
    vinculo('P', 'l1', 'SKU-P');
    relogio = AGORA + 60_000;
    expect(await avaliar(['SKU-P'], FLUXO_LISTING_AMAZON.preco)).toEqual({
      tipo: 'prazo',
      etapa: 'vinculos',
      leituras: { consultas: 0, produtos: 0, filhos: 0, ponteiros: 0, pais: 0 },
    });
    expect(db.contagem).toMatchObject({ consultas: 0, leituras: 0 });
  });

  it('reached before the parents ⇒ prazo at the units, the counts of what was read', async () => {
    produto('F', { paiId: 'PAI' });
    vinculo('F', 'l1', 'SKU-F');
    const prazoMs = AGORA + 60_000;
    const r = await avaliarVinculosEmLoteAmazon(asDb(db), CONTA, ['SKU-F'], {
      ...opcoes(FLUXO_LISTING_AMAZON.preco),
      prazo: {
        // The clock passes the deadline once the children seek (the 2nd query) ran.
        agora: () => (db.contagem.consultas >= 2 ? prazoMs : AGORA),
        prazoMs,
      },
    });
    expect(r).toMatchObject({ tipo: 'prazo', etapa: 'unidades', leituras: { pais: 0 } });
    expect(db.leituras).not.toContain('produtos/PAI');
  });

  it('a SKU whose links the caller read is not queried again; the answer is the full run’s', async () => {
    produto('P');
    vinculo('P', 'l1', 'SKU-P');
    produto('Q');
    vinculo('Q', 'l1', 'SKU-Q');
    const campos = CAMPOS[FLUXO_LISTING_AMAZON.preco];
    const lidos = await lerVinculosDosSkusListingAmazon(
      asDb(db),
      CONTA,
      ['SKU-P'],
      campos.vinculo,
      {
        agora: () => relogio,
        prazoMs: AGORA + 60_000,
      },
    );
    if (lidos === null) throw new Error('prazo inesperado');
    const antes = db.contagem.consultas;
    const r = completa(
      await avaliar(['SKU-P', 'SKU-Q'], FLUXO_LISTING_AMAZON.preco, { vinculosLidos: lidos }),
    );
    expect(db.contagem.consultas - antes).toBe(1 + 2);
    expect(r.leituras.consultas).toBe(1);
    expect(r.skus.map((s) => s.sku)).toEqual(['SKU-P', 'SKU-Q']);
  });

  it('a conta id outside its grammar, or a deadline that is not a ms instant ⇒ RangeError, nothing read', async () => {
    await expect(
      avaliarVinculosEmLoteAmazon(asDb(db), 'a/b', ['S'], opcoes(FLUXO_LISTING_AMAZON.preco)),
    ).rejects.toThrow(RangeError);
    for (const prazoMs of [1.5, -1]) {
      await expect(
        avaliar(['S'], FLUXO_LISTING_AMAZON.preco, { prazo: { agora: () => 0, prazoMs } }),
      ).rejects.toThrow(RangeError);
    }
    expect(db.contagem).toMatchObject({ consultas: 0, leituras: 0 });
  });

  it('★ one flow’s masks with the other flow’s verdict ⇒ RangeError before any read (NEAR-MISS: a matching pair reads)', async () => {
    produto('P');
    vinculo('P', 'l1', 'SKU-P');
    for (const [mascaras, veredicto] of [
      [FLUXO_LISTING_AMAZON.preco, FLUXO_LISTING_AMAZON.estoque],
      [FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco],
    ] as const) {
      await expect(
        avaliarVinculosEmLoteAmazon(asDb(db), CONTA, ['SKU-P'], {
          ...opcoes(mascaras),
          regra: regra(veredicto),
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(db.contagem).toMatchObject({ consultas: 0, leituras: 0 });
    completa(await avaliar(['SKU-P'], FLUXO_LISTING_AMAZON.preco));
    expect(db.contagem.consultas).toBeGreaterThan(0);
  });
});

describe('★ the price masks WITH tabelas, offline (the fake db’s two-segment mask)', () => {
  /** The conta's two tabelas: the second id holds a dot, and must read as ONE key. */
  const NORMAL = 'normal';
  const PROMO = 'pro.mo';
  const COM_TABELAS = camposDoResolverListingAmazon({
    fluxo: FLUXO_LISTING_AMAZON.preco,
    tabelaIds: [NORMAL, PROMO],
  });
  /** Three tabelas' prices, the dotted one beside its NESTED look-alike. */
  const PRECOS = {
    [NORMAL]: { valor: 10 },
    [PROMO]: { valor: 8 },
    outra: { valor: 99 },
    pro: { mo: { valor: 1 } },
  };

  /** The emulator suite's shapes: a simple unit, two children of one parent, a wrapper, a kit, two donos. */
  function semearPrecos(): string[] {
    produto('S', { precos: PRECOS });
    vinculo('S', 'l1', 'P-SIMPLES');
    produto('PAI', { precos: PRECOS, propagatePriceToChildren: true });
    produto('F', { precos: PRECOS, paiId: 'PAI' });
    produto('F2', { precos: PRECOS, paiId: 'PAI' });
    vinculo('F', 'l1', 'P-FILHO');
    vinculo('F2', 'l1', 'P-FILHO2');
    produto('W', {
      precos: PRECOS,
      paiId: null,
      filhoUnicoId: 'M',
      propagatePriceToChildren: false,
    });
    produto('M', { precos: PRECOS, paiId: 'W' });
    vinculo('W', 'l1', 'P-WRAPPER');
    produto('K', { precos: PRECOS, ehKit: true, paiId: null, filhoUnicoId: 'KM' });
    produto('KM', { precos: PRECOS, paiId: 'K' });
    vinculo('K', 'l1', 'P-KIT');
    produto('A1', { precos: PRECOS });
    produto('A2', { precos: PRECOS });
    vinculo('A1', 'l1', 'P-AMBIGUO');
    vinculo('A2', 'l1', 'P-AMBIGUO');
    return ['P-SIMPLES', 'P-FILHO', 'P-FILHO2', 'P-WRAPPER', 'P-KIT', 'P-AMBIGUO'];
  }

  const avaliarComTabelas = (skus: readonly string[]) =>
    avaliar(skus, FLUXO_LISTING_AMAZON.preco, { campos: COM_TABELAS });

  it('★ parity: each SKU’s verdict, input and unit parent are the per-SKU reader’s own, at the masks with tabelas', async () => {
    db.exigirMascaraEm('produtos');
    db.exigirMascaraEm('prodAmazon');
    const skus = semearPrecos();
    const r = completa(await avaliarComTabelas(skus));
    expect(r.skus.map((s) => s.sku).sort()).toEqual([...skus].sort());
    for (const s of r.skus) {
      const sozinho = await lerVinculoListingAmazon(asDb(db), CONTA, s.sku, COM_TABELAS);
      expect(s.entrada, s.sku).toEqual(sozinho.entrada);
      expect(s.paiDaUnidade, s.sku).toEqual(sozinho.paiDaUnidade);
      expect(s.veredicto, s.sku).toEqual(
        avaliarVinculoListingAmazon(sozinho.entrada, regra(FLUXO_LISTING_AMAZON.preco)),
      );
    }
    // Anti-vacuity: the shapes reach the verdicts and the parents they name.
    const doSku = (sku: string) => r.skus.find((s) => s.sku === sku);
    expect(doSku('P-AMBIGUO')?.veredicto).toEqual({ apto: false, motivo: 'vinculo-ambiguo' });
    expect(doSku('P-WRAPPER')?.veredicto).toMatchObject({ apto: true, unidadeId: 'M' });
    expect(doSku('P-FILHO')?.paiDaUnidade).toEqual({
      id: 'PAI',
      raw: {
        precos: { [NORMAL]: { valor: 10 }, [PROMO]: { valor: 8 } },
        propagatePriceToChildren: true,
      },
    });
    expect(doSku('P-WRAPPER')?.paiDaUnidade).toMatchObject({
      id: 'W',
      raw: { propagatePriceToChildren: false },
    });
    expect(doSku('P-SIMPLES')?.paiDaUnidade).toBeNull();
    expect(doSku('P-KIT')?.paiDaUnidade).toBeNull();
  });

  it('★ the nested masks: ONLY the asked tabelas’ entries come back — a dotted tabela id is one key, never its nested look-alike', async () => {
    const skus = semearPrecos();
    const r = completa(await avaliarComTabelas(skus));
    const unidade = r.skus.find((s) => s.sku === 'P-SIMPLES')?.unidade;
    expect(unidade).toEqual({ precos: { [NORMAL]: { valor: 10 }, [PROMO]: { valor: 8 } } });
    expect(Object.keys((unidade?.precos ?? {}) as object).sort()).toEqual([NORMAL, PROMO].sort());
    expect(unidade).not.toHaveProperty('nome');
    // The reads that carried an entry named it as its two segments.
    expect(
      db.leiturasDetalhadas.some((l) =>
        (l.mascara ?? []).some((c) => Array.isArray(c) && c[0] === 'precos' && c[1] === PROMO),
      ),
    ).toBe(true);
  });

  it('★ the parent is read only for a unit with a paiId, once however many units share it; no read returns a link payload or a label', async () => {
    const skus = semearPrecos();
    const r = completa(await avaliarComTabelas(skus));
    const contar = (caminho: string) =>
      db.leiturasDetalhadas.filter((l) => l.caminho === caminho).length;
    // PAI is two units' parent: read ONCE (it is no dono or unit here).
    expect(contar('produtos/PAI')).toBe(1);
    // W is a dono AND its member's parent: one dono read, one parent read.
    expect(contar('produtos/W')).toBe(2);
    // NEAR-MISS: the kit root and the simple produto name no parent: each read
    // twice (as a dono, then as its own unit at the nested mask), never a third.
    expect(contar('produtos/K')).toBe(2);
    expect(contar('produtos/S')).toBe(2);
    expect(r.leituras.pais).toBe(2);
    for (const l of db.leiturasDetalhadas) expect(l.mascara, l.caminho).not.toBeNull();
  });
});
