import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import { MAX_AMOSTRA_AVISO_PRECO_LI, motivoPrecoParadoLiSchema } from './aviso';
import { assinaturaEnvioPrecoLi } from './precoErpLojaIntegrada';
import { ALL_DOMAINS } from './registry';
import { ID_PAIS_SNAPSHOT_ESTOQUE_LI, baldeSnapshotEstoqueLi } from './sincEstoqueLojaIntegrada';
import * as modulo from './sincPrecoLojaIntegrada';
import {
  COLECAO_SINC_PRECO_LI,
  FLAG_ENTRADA_PRECO_LI,
  ID_PAIS_ERP_SNAPSHOT_PRECO_LI,
  MAX_LIMITE_PAGINA_PRECO_LI,
  MOTIVO_AMOSTRA_PRECO_LI,
  SUBCOLECOES_SINC_PRECO_LI,
  entradaSnapshotPrecoLiSchema,
  execucaoContaPrecoLiSchema,
  flagEntradaPrecoLiSchema,
  motivoAmostraPrecoLiSchema,
  paisErpSnapshotPrecoLiSchema,
  sincPrecoLojaIntegradaSchema,
  snapshotPrecoLiSchema,
} from './sincPrecoLojaIntegrada';

const AGORA_MS = 1_800_000_000_000;
const RUN = 'estoque-reconcile-20271115';
const TABELAS = { normal: 'tab-normal', promocional: 'tab-promo' };

describe('sincPrecoLojaIntegradaSchema (the per-conta root)', () => {
  it('an empty document parses to the defaults: no list read, no run, no memory', () => {
    expect(sincPrecoLojaIntegradaSchema.parse({})).toEqual({
      reconcilePreco: null,
      ultimoReconcilePreco: null,
      execucaoPreco: null,
      enviadosPreco: [],
    });
  });

  it('a full document round-trips, every stamp in ms and every price in centavos', () => {
    const doc = {
      reconcilePreco: { offset: 600, limite: 100, iniciadoEmMs: AGORA_MS },
      ultimoReconcilePreco: {
        execucaoId: RUN,
        iniciadoEmMs: AGORA_MS - 3_600_000,
        concluidoEmMs: AGORA_MS - 60_000,
        tabelas: TABELAS,
        contadores: { linhasLi: 7103, candidatos: 41, retidos: 12 },
      },
      execucaoPreco: {
        execucaoId: RUN,
        tabelas: { normal: 'tab-normal', promocional: null },
        vistos: ['7', '123456789'],
        amostras: { retido: ['p1'], 'nao-baixado': ['p2'] },
        contadores: { naoBaixados: 1 },
        candidatos: [{ i: '123456789', p: 'p3', d: 250 }],
      },
      enviadosPreco: [
        {
          i: '123456789',
          h: assinaturaEnvioPrecoLi(
            { cheioCentavos: 5000, promo: 'limpar' },
            { cheio: 49.9, promocional: null },
          ),
          n: 2,
        },
      ],
    };
    expect(sincPrecoLojaIntegradaSchema.parse(doc)).toEqual(doc);
  });

  it('⚠️ NO custo field survives a write: unknown keys are STRIPPED', () => {
    const lido = sincPrecoLojaIntegradaSchema.parse({
      custo: 12.5,
      custos: { p1: 1250 },
      candidatosPreco: [{ i: '1', p: 'p1', d: 0 }],
    }) as Record<string, unknown>;
    expect(Object.keys(lido).sort()).toEqual([
      'enviadosPreco',
      'execucaoPreco',
      'reconcilePreco',
      'ultimoReconcilePreco',
    ]);
    const execucao = execucaoContaPrecoLiSchema.parse({
      execucaoId: RUN,
      tabelas: TABELAS,
      custo: 3,
    }) as Record<string, unknown>;
    expect(Object.hasOwn(execucao, 'custo')).toBe(false);
  });

  it('⚠️ NO custo survives at the NESTED levels either: a candidate, a target, a parent', () => {
    const semCusto = (v: unknown, onde: string) => {
      expect(typeof v === 'object' && v !== null, onde).toBe(true);
      expect(Object.hasOwn(v as object, 'custo'), onde).toBe(false);
    };
    const execucao = execucaoContaPrecoLiSchema.parse({
      execucaoId: RUN,
      tabelas: TABELAS,
      candidatos: [{ i: '1', p: 'p1', d: 0, custo: 5 }],
    });
    semCusto(execucao.candidatos[0], 'candidato');
    const entrada = entradaSnapshotPrecoLiSchema.parse({
      p: 'p1',
      f: 'v',
      a: { c: 5000, q: null, custo: 1250 },
      ap: { c: 5100, q: 3999, custo: 1250 },
    });
    semCusto(entrada.a, 'a');
    semCusto(entrada.ap, 'ap');
    semCusto(entrada, 'entrada');
    const pais = paisErpSnapshotPrecoLiSchema.parse({
      execucaoId: RUN,
      pais: { pai1: { pp: true, custo: 3 } },
    });
    semCusto(pais.pais.pai1, 'pai');
  });

  it('a run state stored with only its id and tabelas reads with an EMPTY walk, never a crash', () => {
    const vazio = { execucaoId: RUN, tabelas: TABELAS };
    const esperado = { ...vazio, vistos: [], amostras: {}, contadores: {}, candidatos: [] };
    expect(execucaoContaPrecoLiSchema.parse(vazio)).toEqual(esperado);
    expect(sincPrecoLojaIntegradaSchema.parse({ execucaoPreco: vazio }).execucaoPreco).toEqual(
      esperado,
    );
  });

  it('⚠️ NEAR-MISS: a run id is the stock run grammar on EVERY price document', () => {
    const ok = {
      execucaoPreco: (execucaoId: unknown) =>
        execucaoContaPrecoLiSchema.safeParse({ execucaoId, tabelas: TABELAS }).success,
      ultimoReconcilePreco: (execucaoId: unknown) =>
        sincPrecoLojaIntegradaSchema.safeParse({
          ultimoReconcilePreco: { execucaoId, iniciadoEmMs: AGORA_MS, concluidoEmMs: AGORA_MS },
        }).success,
      balde: (execucaoId: unknown) => snapshotPrecoLiSchema.safeParse({ execucaoId }).success,
      paisErp: (execucaoId: unknown) =>
        paisErpSnapshotPrecoLiSchema.safeParse({ execucaoId }).success,
    };
    for (const [onde, aceita] of Object.entries(ok)) {
      expect(aceita(RUN), onde).toBe(true);
      for (const ruim of ['', 'a b', 'a/b', 'x'.repeat(101), 7, null]) {
        expect(aceita(ruim), `${onde}: ${String(ruim)}`).toBe(false);
      }
    }
  });

  it('a last run stored without tabelas or counters reads with none, never as a refusal', () => {
    const ultimoReconcilePreco = {
      execucaoId: RUN,
      iniciadoEmMs: AGORA_MS,
      concluidoEmMs: AGORA_MS,
    };
    expect(
      sincPrecoLojaIntegradaSchema.parse({ ultimoReconcilePreco }).ultimoReconcilePreco,
    ).toEqual({ ...ultimoReconcilePreco, tabelas: null, contadores: {} });
  });

  it('the page size is held to the ONE bound: 100 is a page, 101 is not', () => {
    expect(MAX_LIMITE_PAGINA_PRECO_LI).toBe(100);
    const ok = (limite: number) =>
      sincPrecoLojaIntegradaSchema.safeParse({
        reconcilePreco: { offset: 0, limite, iniciadoEmMs: AGORA_MS },
      }).success;
    expect(ok(1)).toBe(true);
    expect(ok(100)).toBe(true);
    expect(ok(101)).toBe(false);
    expect(ok(0)).toBe(false);
    expect(ok(20.5)).toBe(false);
  });

  it('⚠️ NEAR-MISS: the run’s tabelas are bare ids — the normal one always, a promo one or null', () => {
    const ok = (tabelas: unknown) =>
      execucaoContaPrecoLiSchema.safeParse({ execucaoId: RUN, tabelas }).success;
    expect(ok(TABELAS)).toBe(true);
    expect(ok({ normal: 'tab-normal', promocional: null })).toBe(true);
    expect(ok({ normal: null, promocional: 'tab-promo' })).toBe(false);
    expect(ok({ normal: 'documents/listaDePrecos/tab-normal', promocional: null })).toBe(false);
    expect(ok({ normal: 'tab-normal' })).toBe(false);
    expect(ok(null)).toBe(false);
  });

  it('the sample reasons are the held one, the refused lowering and every Parado motivo', () => {
    expect(motivoAmostraPrecoLiSchema.options).toEqual([
      'retido',
      'nao-baixado',
      ...motivoPrecoParadoLiSchema.options,
    ]);
    expect(Object.values(MOTIVO_AMOSTRA_PRECO_LI)).toEqual(motivoAmostraPrecoLiSchema.options);
  });

  it(`⚠️ NEAR-MISS: a sample holds at most ${String(MAX_AMOSTRA_AVISO_PRECO_LI)} ids, of an unknown reason none`, () => {
    const amostra = (n: number) => Array.from({ length: n }, (_, k) => `p${String(k)}`);
    const ok = (amostras: unknown) =>
      execucaoContaPrecoLiSchema.safeParse({ execucaoId: RUN, tabelas: TABELAS, amostras }).success;
    expect(ok({ retido: amostra(MAX_AMOSTRA_AVISO_PRECO_LI) })).toBe(true);
    expect(ok({ retido: amostra(MAX_AMOSTRA_AVISO_PRECO_LI + 1) })).toBe(false);
    expect(ok({ 'sem-erp': ['p1'] })).toBe(false);
    expect(ok({ ilegivel: ['p1'] })).toBe(false);
  });

  it('a candidate is short: store id, produto, an INTEGER delta that may be negative', () => {
    const ok = (candidato: unknown) =>
      execucaoContaPrecoLiSchema.safeParse({
        execucaoId: RUN,
        tabelas: TABELAS,
        candidatos: [candidato],
      }).success;
    expect(ok({ i: '1', p: 'p1', d: -5 })).toBe(true);
    expect(ok({ i: '01', p: 'p1', d: 0 })).toBe(false);
    expect(ok({ i: '1', p: 'a/b', d: 0 })).toBe(false);
    expect(ok({ i: '1', p: 'p1', d: 0.5 })).toBe(false);
    expect(ok({ i: '1', p: 'p1' })).toBe(false);
  });

  it('⚠️ NEAR-MISS: a memory row’s key is the exact signature grammar; n counts runs from 1', () => {
    const ok = (linha: unknown) =>
      sincPrecoLojaIntegradaSchema.safeParse({ enviadosPreco: [linha] }).success;
    expect(ok({ i: '7', h: '5000:0:4990:0', n: 1 })).toBe(true);
    for (const ruim of [
      { i: '7', h: '5000:0:4990', n: 1 },
      { i: '7', h: '50.00:0:49.90:0', n: 1 },
      { i: '7', h: 'abc', n: 1 },
      { i: '7', h: '5000:0:4990:0', n: 0 },
      { i: '7', h: '5000:0:4990:0', n: 1.5 },
      { i: '07', h: '5000:0:4990:0', n: 1 },
    ]) {
      expect(ok(ruim), JSON.stringify(ruim)).toBe(false);
    }
  });

  it('is NOT registered in ALL_DOMAINS, and the module exports nothing combined { schema, meta }', () => {
    expect(COLECAO_SINC_PRECO_LI).toBe('sincPrecoLojaIntegrada');
    expect(ALL_DOMAINS.map((d) => d.schema)).not.toContain(sincPrecoLojaIntegradaSchema);
    expect(ALL_DOMAINS.map((d) => d.meta.collectionPath)).not.toContain(COLECAO_SINC_PRECO_LI);
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });
});

describe('the snapshot (the stock’s buckets, the price entries)', () => {
  it('one bucketing rule for both flows: the stock’s own function, and its subcollection name', () => {
    expect(SUBCOLECOES_SINC_PRECO_LI.snapshot).toBe('snapshot');
    expect(baldeSnapshotEstoqueLi('33')).toBe('01');
    // The parents unit's doc sits beside the buckets and is neither a bucket nor the stock's `pais`.
    expect(ID_PAIS_ERP_SNAPSHOT_PRECO_LI).toBe('paisErp');
    expect(ID_PAIS_ERP_SNAPSHOT_PRECO_LI).not.toBe(ID_PAIS_SNAPSHOT_ESTOQUE_LI);
    expect(/^(?:[0-2][0-9]|3[01])$/.test(ID_PAIS_ERP_SNAPSHOT_PRECO_LI)).toBe(false);
  });

  it('the flags are exactly the six, named', () => {
    expect(flagEntradaPrecoLiSchema.options).toEqual(['v', 'pai', 'amb', 'dup', 'ns', 'x']);
    expect(Object.values(FLAG_ENTRADA_PRECO_LI)).toEqual(flagEntradaPrecoLiSchema.options);
    // NEAR-MISS: the stock-only flags are not price flags.
    for (const estoque of ['r', 'par', 'V', '']) {
      expect(flagEntradaPrecoLiSchema.safeParse(estoque).success, estoque).toBe(false);
    }
  });

  it('round-trips a bucket with every flag, a full valid entry and a held one', () => {
    const balde = {
      execucaoId: RUN,
      e: {
        '7': {
          p: 'f1',
          f: FLAG_ENTRADA_PRECO_LI.valido,
          pai: 'pai1',
          n: 5000,
          pr: 'il',
          a: { c: 5000, q: null },
          ap: { c: 5100, q: 3999 },
          t: true,
          tp: true,
        },
        '8': { p: 'f2', f: FLAG_ENTRADA_PRECO_LI.valido, a: { r: 'sem-preco' } },
        '9': { p: 'pai1', f: FLAG_ENTRADA_PRECO_LI.pai },
        '10': { p: 'p3', f: FLAG_ENTRADA_PRECO_LI.ambiguo },
        '11': { p: 'p4', f: FLAG_ENTRADA_PRECO_LI.duplicado },
        '12': { p: 'p5', f: FLAG_ENTRADA_PRECO_LI.naoSuportado },
        '13': { p: null, f: FLAG_ENTRADA_PRECO_LI.semVinculo },
      },
    };
    expect(snapshotPrecoLiSchema.parse(balde)).toEqual(balde);
    expect(snapshotPrecoLiSchema.parse({ execucaoId: RUN })).toEqual({ execucaoId: RUN, e: {} });
  });

  it('⚠️ NEAR-MISS: the produto exactly off a no-link entry, and prices ONLY on a valid one', () => {
    const ok = (entrada: unknown) => entradaSnapshotPrecoLiSchema.safeParse(entrada).success;
    expect(ok({ p: null, f: 'v' })).toBe(false);
    expect(ok({ p: 'p1', f: 'x' })).toBe(false);
    for (const campo of [
      { pai: 'pai1' },
      { n: 5000 },
      { pr: 'il' },
      { a: { c: 5000, q: null } },
      { ap: { r: 'ilegivel' } },
      { t: true },
      { tp: true },
    ]) {
      expect(ok({ p: 'p1', f: 'dup', ...campo }), JSON.stringify(campo)).toBe(false);
      expect(ok({ p: 'p1', f: 'v', ...campo }), JSON.stringify(campo)).toBe(true);
    }
  });

  it('⚠️ NEAR-MISS: an entry’s produto and parent name ONE document — never a path or a reserved id', () => {
    const ok = (entrada: unknown) => entradaSnapshotPrecoLiSchema.safeParse(entrada).success;
    expect(ok({ p: 'p1', f: 'v', pai: 'pai1' })).toBe(true);
    for (const ruim of ['a/b', '..', '.', '', '__x__', 'x'.repeat(1501)]) {
      expect(ok({ p: 'p1', f: 'v', pai: ruim }), `pai ${ruim.slice(0, 8)}`).toBe(false);
      expect(ok({ p: ruim, f: 'v' }), `p ${ruim.slice(0, 8)}`).toBe(false);
    }
    // Such a child is stored already HELD by the walk — no `pai`, so never mistaken for a root.
    expect(ok({ p: 'f1', f: 'v', a: { r: 'pai-ausente' } })).toBe(true);
  });

  it('⚠️ NEAR-MISS: a reading is positive integer centavos or `il` — never reais, 0 or a word', () => {
    const ok = (n: unknown) =>
      entradaSnapshotPrecoLiSchema.safeParse({ p: 'p1', f: 'v', n }).success;
    expect(ok(5000)).toBe(true);
    expect(ok('il')).toBe(true);
    expect(ok(null)).toBe(true);
    for (const ruim of [50.0001, 49.9, 0, -1, 'ilegivel', 'ausente', '5000']) {
      expect(ok(ruim), String(ruim)).toBe(false);
    }
  });

  it('⚠️ NEAR-MISS: a target is { c, q } in centavos or { r } with a hold motivo', () => {
    const ok = (a: unknown) =>
      entradaSnapshotPrecoLiSchema.safeParse({ p: 'p1', f: 'v', a }).success;
    expect(ok({ c: 1, q: null })).toBe(true);
    expect(ok({ c: 5000, q: 3999 })).toBe(true);
    expect(ok({ r: 'pai-ausente' })).toBe(true);
    for (const ruim of [
      { c: 0, q: null },
      { c: 50.5, q: null },
      { c: 5000, q: 0 },
      { c: 5000 },
      { r: 'outro' },
      { r: 'retido' },
      {},
    ]) {
      expect(ok(ruim), JSON.stringify(ruim)).toBe(false);
    }
  });

  it('`t` and `tp` are `true` or absent — never `false`, which would only cost bytes', () => {
    const ok = (t: unknown) =>
      entradaSnapshotPrecoLiSchema.safeParse({ p: 'p1', f: 'v', t }).success;
    expect(ok(true)).toBe(true);
    expect(ok(false)).toBe(false);
    expect(ok('true')).toBe(false);
  });

  it('⚠️ NEAR-MISS: a key that is not the canonical store id is refused', () => {
    for (const chave of ['01', '0', '1.0', ' 1', '']) {
      expect(
        snapshotPrecoLiSchema.safeParse({ execucaoId: RUN, e: { [chave]: { p: 'p1', f: 'v' } } })
          .success,
        chave,
      ).toBe(false);
    }
  });
});

describe('snapshot/paisErp (the parents unit)', () => {
  it('a read parent keeps its folded flag and its own two readings; a missing one is null', () => {
    const doc = {
      execucaoId: RUN,
      pais: {
        pai1: { pp: true, n: 5000, pr: null },
        pai2: { pp: false, n: 'il', pr: 3999 },
        pai3: null,
      },
    };
    expect(paisErpSnapshotPrecoLiSchema.parse(doc)).toEqual(doc);
    expect(
      paisErpSnapshotPrecoLiSchema.parse({ execucaoId: RUN, pais: { pai1: { pp: true } } }),
    ).toEqual({ execucaoId: RUN, pais: { pai1: { pp: true, n: null, pr: null } } });
  });

  it('⚠️ NEAR-MISS: the flag is a boolean (never the raw stored junk), and a parent id is a document id', () => {
    for (const pais of [
      { pai1: { pp: 'false' } },
      { pai1: { pp: null } },
      { pai1: {} },
      { 'a/b': { pp: true } },
      { '..': null },
    ]) {
      expect(
        paisErpSnapshotPrecoLiSchema.safeParse({ execucaoId: RUN, pais }).success,
        JSON.stringify(pais),
      ).toBe(false);
    }
  });
});
