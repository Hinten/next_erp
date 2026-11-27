/**
 * `despachoReconcile.ts` with the price arm (master plan step 13, PR 13-f1), slice by slice: the
 * both-valve gate at zero reads, the arms a run carries and drops, a price-only run, the take's
 * price fields and lines, the parents phase's containment, and the end pair that never splits.
 * Against `testing/fakeDb.ts` and the scripted store (`testing/reconcilePrecoLi.ts`).
 *
 * No call to the store: the global `fetch` throws in every test of this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import { FASE_RECONCILE_ESTOQUE_LI, TIPO_TAREFA_RECONCILE_ESTOQUE_LI } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../core/contaCache';
import { CHAMADAS_ENV_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import { FORMA_PROMO_LIMPA_ENV_LI } from '../../preco/configPrecoLi';
import { FakeDb, asDb, grpc, increment } from '../../testing/fakeDb';
import { espiarStdout } from '../../testing/fixtures';
import {
  AGORA_RECONCILE_MS,
  CAMINHO_RUN_RECONCILE_LI,
  INICIO_RUN_RECONCILE_MS,
  RUN_A,
  agendadorGravador,
  filaEstoqueGravadora,
  loggerGravador,
  refDeposito,
  seedContaComDeposito,
} from '../../testing/reconcileEstoqueLi';
import {
  AMBIENTE_ESTOQUE_LIGADO_LI,
  CONTA_PRECO_A,
  CONTA_PRECO_B,
  type MundoReconcilePrecoLi,
  encadearReconcilePrecoLi,
  mundoReconcilePrecoLi,
} from '../../testing/reconcilePrecoLi';
import { TETO_ESTOQUE_ENV_LI } from '../configEstoqueLi';
import {
  type DepsReconcileEstoqueLi,
  type ResultadoReconcileLi,
  camposDoRegistroDoReconcileLi,
  despacharReconcileEstoqueLi,
} from './despachoReconcile';
import { FimPrecoReconcileLi } from './fimPrecoReconcile';
import { PaisPrecoReconcileLi } from './paisPrecoReconcile';

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_RECONCILE_MS);
  vi.stubGlobal('fetch', () => {
    throw new Error('despachoReconcile.preco.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const E = VALVULA_ENV_LI.estoque;
const P = VALVULA_ENV_LI.preco;
const tarefa = (seq: number, extra: Record<string, unknown> = {}) => ({
  tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  execucaoId: RUN_A,
  seq,
  ...extra,
});

const SO_PRECO = { [CHAMADAS_ENV_LI]: 'on', [P]: 'dry-run' };

/** Every price root, stock root and their sub-documents a run wrote. */
function caminhosEscritos(m: MundoReconcilePrecoLi, prefixo: string): string[] {
  return m.fake.escritas.filter((e) => e.caminho.startsWith(prefixo)).map((e) => e.caminho);
}

function ultimoReconcilePreco(m: MundoReconcilePrecoLi, conta: string) {
  return m.fake.ler(`sincPrecoLojaIntegrada/${conta}`)?.ultimoReconcilePreco as
    | { readonly contadores: Record<string, number> }
    | null
    | undefined;
}

/** A chain from `seq` 0 whose environment `ambienteDe(n)` gives for its n-th slice. */
async function cadeiaComAmbientes(
  m: MundoReconcilePrecoLi,
  ambienteDe: (n: number) => Readonly<Record<string, string | undefined>>,
  primeira: Record<string, unknown> = {},
): Promise<ResultadoReconcileLi[]> {
  const resultados: ResultadoReconcileLi[] = [];
  let seq = 0;
  for (let n = 0; n < 80; n += 1) {
    const r = await despacharReconcileEstoqueLi(
      m.db,
      tarefa(seq, n === 0 ? primeira : {}),
      m.deps({ inicioMs: m.relogio.agora, ambiente: ambienteDe(n) }),
    );
    resultados.push(r);
    if (r.kind !== 'continua') return resultados;
    seq = r.seq;
    m.relogio.agora += m.entreFatiasMs;
  }
  throw new Error('a cadeia não terminou');
}

describe('the both-valve gate — every return before the run document has ZERO reads', () => {
  function semLeitura(ambiente: Readonly<Record<string, string | undefined>>) {
    const db = new FakeDb();
    const log = loggerGravador();
    const deps: DepsReconcileEstoqueLi = {
      ambiente,
      agoraMs: () => AGORA_RECONCILE_MS,
      inicioMs: AGORA_RECONCILE_MS,
      tentativa: 0,
      idTarefa: null,
      esperar: () => Promise.resolve(),
      increment,
      agendador: () => agendadorGravador().agendador,
      agendadorEstoque: () => filaEstoqueGravadora().agendador,
      logger: log.logger,
      escrever: () => undefined,
    };
    return { db, log, deps };
  }

  it.each([
    ['both valves unset', {}, 'desligado', []],
    ['both off, spelled `off`', { [E]: 'off', [P]: 'off' }, 'desligado', []],
    [
      'the cap unreadable, price unset',
      { [E]: 'on', [TETO_ESTOQUE_ENV_LI]: 'abc' },
      'teto-invalido',
      ['teto-invalido'],
    ],
    [
      'the forma unreadable, stock off',
      { [P]: 'on', [FORMA_PROMO_LIMPA_ENV_LI]: 'NULO' },
      'forma-invalida',
      ['forma-promo-invalida'],
    ],
    [
      'both settings unreadable, both valves set',
      { [E]: 'on', [TETO_ESTOQUE_ENV_LI]: 'abc', [P]: 'dry-run', [FORMA_PROMO_LIMPA_ENV_LI]: 'x' },
      'teto-invalido',
      ['forma-promo-invalida', 'teto-invalido'],
    ],
  ] as const)('%s ⇒ %s', async (_caso, ambiente, kind, motivos) => {
    const { db, log, deps } = semLeitura(ambiente);
    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(0), deps)).toEqual({ kind });
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(db.escritas).toEqual([]);
    expect(log.linhas.map((l) => [l.nivel, l.meta.motivo])).toEqual(
      motivos.map((m) => ['error', m]),
    );
  });

  it('an unrecognised value is ONE valve WARNING per flow per slice; NEAR-MISS: the stock valve set ⇒ the slice reads on', async () => {
    const espiao = espiarStdout();
    try {
      const { db, deps } = semLeitura({ [E]: 'ON', [P]: 'OFF' });
      expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(0), deps)).toEqual({
        kind: 'desligado',
      });
      const valvulas = espiao
        .escritas()
        .map((linha) => JSON.parse(linha) as Record<string, unknown>)
        .filter((l) => l.evento === 'valvula')
        .map((l) => l.fluxo);
      expect(valvulas.sort()).toEqual(['estoque', 'preco']);
      expect(db.leituras).toEqual([]);
    } finally {
      espiao.restaurar();
    }
  });
});

describe('F — an unrecognised price value beside a running stock flow', () => {
  it(
    'ONE price valve WARNING per slice, on stdout; the slices otherwise as scenario A',
    { timeout: 30_000 },
    async () => {
      const espiao = espiarStdout();
      try {
        const m = mundoReconcilePrecoLi({
          ambiente: { ...AMBIENTE_ESTOQUE_LIGADO_LI, [P]: 'OFF' },
        });
        const fatias = await encadearReconcilePrecoLi(m);
        const doPreco = espiao
          .escritas()
          .flatMap((linha) => {
            try {
              return [JSON.parse(linha) as Record<string, unknown>];
            } catch (err) {
              if (err instanceof SyntaxError) return [];
              throw err;
            }
          })
          .filter((l) => l.evento === 'valvula' && l.fluxo === 'preco');
        expect(doPreco).toHaveLength(fatias.length);
        expect(m.fake.escritas.some((e) => e.caminho.startsWith('sincPreco'))).toBe(false);
      } finally {
        espiao.restaurar();
      }
    },
  );
});

describe('a price-only run (stock off, price dry-run)', () => {
  it(
    'reaches the release: no stock document, no kits map, no store call — `erp` → `fila`/`pais-preco` → `fim`',
    { timeout: 30_000 },
    async () => {
      const m = mundoReconcilePrecoLi({ ambiente: SO_PRECO });
      const fatias = await encadearReconcilePrecoLi(m);
      expect(fatias.at(-1)?.resultado).toEqual({ kind: 'encerrado' });
      expect(caminhosEscritos(m, 'sincEstoqueLojaIntegrada/')).toEqual([]);
      expect(m.plataforma.requisicoes).toEqual([]);
      expect(m.estoque.enviadas).toEqual([]);
      const fases = fatias.map((f) =>
        f.resultado.kind === 'continua'
          ? `${f.resultado.fase}${f.resultado.fasePreco === undefined ? '' : `/${f.resultado.fasePreco}`}`
          : f.resultado.kind,
      );
      // Never the stock phases; the parents phase ran between the walk and the end.
      expect(fases.every((f) => ['erp', 'fila/pais-preco', 'fim', 'encerrado'].includes(f))).toBe(
        true,
      );
      expect(fases.at(-1)).toBe('encerrado');
      const ordem = m.log.linhas.map((l) => l.msg);
      const primeiroAlvo = ordem.findIndex((msg) => msg.includes('alvos da conta calculados'));
      expect(primeiroAlvo).toBeGreaterThan(-1);
      expect(
        ordem.slice(primeiroAlvo).some((msg) => msg.includes('alvos da conta calculados')),
      ).toBe(true);
      expect(
        fatias.findIndex(
          (f) =>
            f.resultado.kind === 'continua' && f.resultado.fase === FASE_RECONCILE_ESTOQUE_LI.fim,
        ),
      ).not.toBe(0);
      const run = m.fake.ler(CAMINHO_RUN_RECONCILE_LI);
      expect(run).toMatchObject({ fase: 'fim', fasePreco: null, emExecucaoAteMs: 0 });
      expect(run?.contadores).toMatchObject({ precoNoRun: 1, estoqueForaDoRun: 1 });
      // The price-only read: the price mask alone, never the stock fields.
      for (const g of m.getAlls.filter((x) =>
        x.caminhos.every((c) => /^produtos\/[^/]+$/.test(c)),
      )) {
        expect(g.mascara).toEqual(['paiId', 'precos', 'propagatePriceToChildren']);
      }
      for (const conta of [CONTA_PRECO_A, CONTA_PRECO_B]) {
        expect(ultimoReconcilePreco(m, conta)?.contadores.paisConcluido, conta).toBe(1);
      }
      expect(ultimoReconcilePreco(m, CONTA_PRECO_A)?.contadores).toMatchObject({
        validos: 9,
        retidos: 3,
        paiInvalido: 1,
        duplicados: 1,
      });
      expect(run?.contadores).toMatchObject({ erpProdutosLidos: 11 });
    },
  );

  it(
    '⚠️ the cap unreadable with the stock valve ON: the price arm still completes, and the cap ERROR is logged ONCE for the run',
    { timeout: 30_000 },
    async () => {
      const m = mundoReconcilePrecoLi({
        ambiente: { ...SO_PRECO, [E]: 'on', [TETO_ESTOQUE_ENV_LI]: 'abc' },
      });
      const fatias = await encadearReconcilePrecoLi(m);
      expect(fatias.length).toBeGreaterThan(1);
      expect(fatias.at(-1)?.resultado).toEqual({ kind: 'encerrado' });
      expect(
        m.log.linhas.filter((l) => l.nivel === 'error' && l.meta.motivo === 'teto-invalido'),
      ).toHaveLength(1);
      expect(caminhosEscritos(m, 'sincEstoqueLojaIntegrada/')).toEqual([]);
      expect(ultimoReconcilePreco(m, CONTA_PRECO_A)?.contadores.paisConcluido).toBe(1);
    },
  );
});

describe('the arms a run carries can only be dropped', () => {
  it(
    'price DROPPED mid-run (its valve off from slice 2): `precoAbandonado`, ONE WARNING, no price read after it — stock goes on',
    { timeout: 30_000 },
    async () => {
      const m = mundoReconcilePrecoLi({ ambiente: AMBIENTE_ESTOQUE_LIGADO_LI });
      const leiturasDePreco: number[] = [];
      const resultados = await cadeiaComAmbientes(m, (n) => {
        leiturasDePreco.push(m.fake.leituras.filter((l) => l.startsWith('sincPreco')).length);
        return n < 2
          ? { ...AMBIENTE_ESTOQUE_LIGADO_LI, [P]: 'dry-run' }
          : AMBIENTE_ESTOQUE_LIGADO_LI;
      });
      expect(resultados.at(-1)).toEqual({ kind: 'encerrado' });
      const final = m.fake.leituras.filter((l) => l.startsWith('sincPreco')).length;
      expect(leiturasDePreco[2]).toBeGreaterThan(0);
      expect(final).toBe(leiturasDePreco[2]);
      expect(m.fake.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
        precoNoRun: 1,
        precoAbandonado: 1,
      });
      expect(m.log.linhas.filter((l) => l.meta.motivo === 'arma-parada').map((l) => l.msg)).toEqual(
        [expect.stringContaining('[loja-integrada/preco]')],
      );
      // Stock reached its end as usual.
      expect(m.fake.ler(`sincEstoqueLojaIntegrada/${CONTA_PRECO_A}`)?.ultimoReconcile).toBeTruthy();
    },
  );

  it(
    'stock DROPPED mid-run (its valve off from slice 2, price on): `estoqueForaDoRun`; the store list and the stock queue are never entered',
    { timeout: 30_000 },
    async () => {
      const m = mundoReconcilePrecoLi({ ambiente: AMBIENTE_ESTOQUE_LIGADO_LI });
      const com = { ...AMBIENTE_ESTOQUE_LIGADO_LI, [P]: 'dry-run' };
      const resultados = await cadeiaComAmbientes(m, (n) =>
        n < 2 ? com : { ...com, [E]: undefined },
      );
      expect(resultados.at(-1)).toEqual({ kind: 'encerrado' });
      expect(
        resultados
          .slice(2)
          .some((r) => r.kind === 'continua' && r.fase === FASE_RECONCILE_ESTOQUE_LI.li),
      ).toBe(false);
      expect(m.plataforma.requisicoes).toEqual([]);
      expect(m.estoque.enviadas).toEqual([]);
      expect(m.fake.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
        precoNoRun: 1,
        estoqueForaDoRun: 1,
      });
      expect(
        m.fake.ler(`sincEstoqueLojaIntegrada/${CONTA_PRECO_A}`)?.ultimoReconcile ?? null,
      ).toBeNull();
      expect(ultimoReconcilePreco(m, CONTA_PRECO_A)?.contadores.paisConcluido).toBe(1);
    },
  );

  it(
    'NEAR-MISS: an arm off at the take is never ADDED by a later slice',
    { timeout: 30_000 },
    async () => {
      const m = mundoReconcilePrecoLi({ ambiente: AMBIENTE_ESTOQUE_LIGADO_LI });
      const resultados = await cadeiaComAmbientes(m, (n) =>
        n === 0 ? AMBIENTE_ESTOQUE_LIGADO_LI : { ...AMBIENTE_ESTOQUE_LIGADO_LI, [P]: 'dry-run' },
      );
      expect(resultados.at(-1)).toEqual({ kind: 'encerrado' });
      expect(m.fake.escritas.some((e) => e.caminho.startsWith('sincPreco'))).toBe(false);
      expect(m.fake.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).not.toHaveProperty('precoNoRun');
    },
  );
});

describe('the take', () => {
  it('its price lines: a conta with no normal tabela (INFO), a promo equal to the normal one (WARNING), a request for a conta outside the run (WARNING)', async () => {
    const m = mundoReconcilePrecoLi({ ambiente: SO_PRECO });
    seedContaComDeposito(m.fake, 'C3', refDeposito('dep-3'), { nome: 'Loja C' });
    m.fake.seed('integracao/C2', {
      ...(m.fake.ler('integracao/C2') ?? {}),
      tabelaPromocionalOuterRef: 'listaDePrecos/tab-c2',
    });
    const r = await despacharReconcileEstoqueLi(
      m.db,
      tarefa(0, { precoSolicitado: { contaId: 'C9', permitirBaixar: false } }),
      m.deps(),
    );
    expect(r.kind).toBe('continua');
    const linhas = m.log.linhas.filter((l) => l.msg.startsWith('[loja-integrada/preco]'));
    expect(linhas.map((l) => [l.nivel, l.meta.contaId, l.msg.split(' — ')[0]])).toEqual([
      [
        'warn',
        'C9',
        '[loja-integrada/preco] reconcile pedido de atualização para conta fora da execução',
      ],
      ['info', 'C3', '[loja-integrada/preco] reconcile conta sem tabela normal'],
      ['warn', 'C2', '[loja-integrada/preco] reconcile tabela promocional igual à normal'],
    ]);
    expect(m.fake.ler('sincPrecoLojaIntegrada/C2')?.execucaoPreco).toMatchObject({
      tabelas: { normal: 'tab-c2', promocional: null },
      contadores: { promoIgualNormal: 1 },
    });
    expect(m.fake.ler('sincPrecoLojaIntegrada/C3')).toBeUndefined();
    expect(m.fake.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({
      contas: ['C1', 'C2', 'C3'],
      precoSolicitado: { execucaoId: RUN_A, contaId: 'C9', permitirBaixar: false },
      fasePreco: null,
    });
  });

  it('price UNSET but the task carries a request: the request is stored (and the phase nulled) — nothing else of price', async () => {
    const m = mundoReconcilePrecoLi({ ambiente: AMBIENTE_ESTOQUE_LIGADO_LI });
    await despacharReconcileEstoqueLi(
      m.db,
      tarefa(0, { precoSolicitado: { contaId: CONTA_PRECO_A, permitirBaixar: true } }),
      m.deps(),
    );
    const run = m.fake.ler(CAMINHO_RUN_RECONCILE_LI);
    expect(run).toMatchObject({
      fasePreco: null,
      precoSolicitado: { execucaoId: RUN_A, contaId: CONTA_PRECO_A, permitirBaixar: true },
      contadores: expect.not.objectContaining({ precoNoRun: 1 }) as unknown,
    });
    expect(m.fake.escritas.some((e) => e.caminho.startsWith('sincPreco'))).toBe(false);
  });

  it('⚠️ price unset over a dead run that held a price phase: the take erases both fields and the new run parses and runs', async () => {
    const m = mundoReconcilePrecoLi({ ambiente: AMBIENTE_ESTOQUE_LIGADO_LI });
    m.fake.seed(CAMINHO_RUN_RECONCILE_LI, {
      execucaoId: 'estoque-reconcile-20270110',
      iniciadoEmMs: AGORA_RECONCILE_MS - 5 * 86_400_000,
      emExecucaoAteMs: AGORA_RECONCILE_MS - 86_400_000,
      seq: 4,
      fase: 'fila',
      fasePreco: 'pais-preco',
      precoSolicitado: {
        execucaoId: 'estoque-reconcile-20270110',
        contaId: 'C1',
        permitirBaixar: true,
      },
      contas: ['C1'],
      idxConta: 0,
      walk: null,
      candidatos: [],
      contadores: { precoNoRun: 1 },
    });
    const r = await despacharReconcileEstoqueLi(m.db, tarefa(0), m.deps());
    expect(r.kind).toBe('continua');
    expect(m.fake.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({
      execucaoId: RUN_A,
      fasePreco: null,
      precoSolicitado: null,
    });
    // The new run carries no price: its counters are the take's {}, then the stock walk's.
    expect(m.fake.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).not.toHaveProperty('precoNoRun');
  });
});

describe('the price phases’ failures never touch the stock flow or the lease', () => {
  it(
    'a coding bug in the parents unit is CONTAINED: ONE ERROR, the conta counts armaFalhou, the run releases with stock intact',
    { timeout: 30_000 },
    async () => {
      vi.spyOn(PaisPrecoReconcileLi.prototype, 'unidade').mockRejectedValueOnce(
        new TypeError('falha injetada'),
      );
      const m = mundoReconcilePrecoLi({
        ambiente: { ...AMBIENTE_ESTOQUE_LIGADO_LI, [P]: 'dry-run' },
      });
      const fatias = await encadearReconcilePrecoLi(m);
      expect(fatias.at(-1)?.resultado).toEqual({ kind: 'encerrado' });
      const erros = m.log.linhas.filter((l) => l.meta.motivo === 'arma-preco-falhou');
      expect(erros.map((l) => [l.meta.contaId, l.meta.fase])).toEqual([
        [CONTA_PRECO_A, 'pais-preco'],
      ]);
      expect(ultimoReconcilePreco(m, CONTA_PRECO_A)?.contadores.armaFalhou).toBe(1);
      expect(ultimoReconcilePreco(m, CONTA_PRECO_B)?.contadores.paisConcluido).toBe(1);
      expect(m.fake.ler(`sincEstoqueLojaIntegrada/${CONTA_PRECO_A}`)?.ultimoReconcile).toBeTruthy();
    },
  );

  it(
    'a Firestore failure in the parents unit: before the last attempt checkpointed at the SAME seq and RETHROWN; on the last one contained (`tentativas-esgotadas`) — the run goes on and releases',
    { timeout: 30_000 },
    async () => {
      const m = mundoReconcilePrecoLi({ ambiente: SO_PRECO });
      m.fake.falharLeitura('produtos/pai-a', grpc(14, 'UNAVAILABLE'));
      const fatia = (seq: number, tentativa: number) =>
        despacharReconcileEstoqueLi(
          m.db,
          tarefa(seq),
          m.deps({ inicioMs: m.relogio.agora, tentativa }),
        );
      let seq = 0;
      let erro: unknown = null;
      for (let n = 0; n < 40 && erro === null; n += 1) {
        try {
          const r = await fatia(seq, 0);
          if (r.kind !== 'continua') throw new Error(`a cadeia acabou antes da falha: ${r.kind}`);
          seq = r.seq;
          m.relogio.agora += 2_000;
        } catch (err) {
          if (!isGrpcStatusError(err)) throw err;
          erro = err;
        }
      }
      expect(erro).toMatchObject({ code: 14 });
      expect(m.fake.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({
        seq,
        fase: 'fila',
        fasePreco: 'pais-preco',
      });
      expect(m.log.linhas.some((l) => l.meta.motivo === 'tentativas-esgotadas')).toBe(false);

      // The queue's LAST attempt of the same task: contained, and the chain goes on.
      let r = await fatia(seq, TASK_MAX_ATTEMPTS - 1);
      while (r.kind === 'continua') {
        m.relogio.agora += 2_000;
        r = await fatia(r.seq, 0);
      }
      expect(r).toEqual({ kind: 'encerrado' });
      expect(
        m.log.linhas
          .filter((l) => l.meta.motivo === 'tentativas-esgotadas')
          .map((l) => [l.nivel, l.meta.contaId, l.meta.fase]),
      ).toEqual([['error', CONTA_PRECO_A, 'pais-preco']]);
      expect(ultimoReconcilePreco(m, CONTA_PRECO_A)?.contadores).toMatchObject({
        tentativasEsgotadas: 1,
      });
      expect(ultimoReconcilePreco(m, CONTA_PRECO_A)?.contadores.paisConcluido).toBeUndefined();
      expect(ultimoReconcilePreco(m, CONTA_PRECO_B)?.contadores.paisConcluido).toBe(1);
      expect(m.fake.ler(CAMINHO_RUN_RECONCILE_LI)?.emExecucaoAteMs).toBe(0);
    },
  );
});

describe('a Firestore failure of the price STATE load is no price-arm fault', () => {
  it('⚠️ it is rethrown as the stock flow’s would be (the queue retries the slice) — never counted as a contained fault', async () => {
    const m = mundoReconcilePrecoLi({
      ambiente: { ...AMBIENTE_ESTOQUE_LIGADO_LI, [P]: 'dry-run' },
    });
    // The take lands; the first ERP slice's price-state load then fails.
    const r0 = await despacharReconcileEstoqueLi(m.db, tarefa(0), m.deps());
    expect(r0.kind).toBe('continua');
    const seq = r0.kind === 'continua' ? r0.seq : -1;
    m.fake.falharLeitura(`sincPrecoLojaIntegrada/${CONTA_PRECO_A}`, grpc(14, 'UNAVAILABLE'));
    await expect(
      despacharReconcileEstoqueLi(m.db, tarefa(seq), m.deps({ inicioMs: m.relogio.agora })),
    ).rejects.toMatchObject({ code: 14 });
    expect(m.log.linhas.some((l) => l.meta.motivo === 'arma-preco-falhou')).toBe(false);
  });
});

describe('the end pair never splits', () => {
  /** A run at `fim` that carries both arms, its contas' roots of this run. */
  function noFim(): MundoReconcilePrecoLi {
    const m = mundoReconcilePrecoLi({
      ambiente: { ...AMBIENTE_ESTOQUE_LIGADO_LI, [P]: 'dry-run' },
    });
    m.fake.seed(CAMINHO_RUN_RECONCILE_LI, {
      execucaoId: RUN_A,
      iniciadoEmMs: INICIO_RUN_RECONCILE_MS,
      emExecucaoAteMs: AGORA_RECONCILE_MS + 3_600_000,
      seq: 7,
      fase: 'fim',
      fasePreco: null,
      contas: [CONTA_PRECO_A, CONTA_PRECO_B],
      idxConta: 0,
      walk: { ultimoDocPath: 'produtos/x/produtolojaintegrada/l1', concluida: true },
      candidatos: [],
      contadores: { precoNoRun: 1 },
    });
    for (const conta of [CONTA_PRECO_A, CONTA_PRECO_B]) {
      m.fake.seed(`sincEstoqueLojaIntegrada/${conta}`, {
        execucao: {
          execucaoId: RUN_A,
          depositoId: conta === CONTA_PRECO_A ? 'dep-1' : 'dep-2',
          vistos: [],
          amostras: {},
          mapa: { etapa: 'feito', ultimoComponenteId: null },
        },
      });
      m.fake.seed(`sincPrecoLojaIntegrada/${conta}`, {
        execucaoPreco: {
          execucaoId: RUN_A,
          tabelas: { normal: 'tab-n', promocional: null },
          amostras: {},
          contadores: { paisConcluido: 1 },
          candidatos: [],
          mantidos: [],
        },
      });
    }
    return m;
  }

  it('35 s already spent: the pair (40 s) does not fit ⇒ the slice hands off with NEITHER end written', async () => {
    const m = noFim();
    const r = await despacharReconcileEstoqueLi(
      m.db,
      tarefa(7),
      m.deps({ inicioMs: AGORA_RECONCILE_MS - 35_000, agoraMs: () => AGORA_RECONCILE_MS }),
    );
    expect(r).toEqual({ kind: 'continua', fase: 'fim', seq: 8 });
    expect(
      m.fake.ler(`sincEstoqueLojaIntegrada/${CONTA_PRECO_A}`)?.ultimoReconcile,
    ).toBeUndefined();
    expect(ultimoReconcilePreco(m, CONTA_PRECO_A)).toBeUndefined();
  });

  it('NEAR-MISS: 25 s spent ⇒ the pair fits, and BOTH ends land in the same batch', async () => {
    const m = noFim();
    const r = await despacharReconcileEstoqueLi(
      m.db,
      tarefa(7),
      m.deps({ inicioMs: AGORA_RECONCILE_MS - 25_000, agoraMs: () => AGORA_RECONCILE_MS }),
    );
    expect(r).toEqual({ kind: 'encerrado' });
    for (const conta of [CONTA_PRECO_A, CONTA_PRECO_B]) {
      const estoque = m.fake.escritasEm(`sincEstoqueLojaIntegrada/${conta}`).at(-1);
      const preco = m.fake.escritasEm(`sincPrecoLojaIntegrada/${conta}`).at(-1);
      expect(estoque?.dados?.ultimoReconcile, conta).toBeTruthy();
      expect(preco?.dados?.ultimoReconcilePreco, conta).toBeTruthy();
      expect(preco?.lote, conta).toBe(estoque?.lote);
    }
  });

  it('a coding bug in the price end is contained: the stock end of the conta still lands, the run releases', async () => {
    vi.spyOn(FimPrecoReconcileLi.prototype, 'unidade').mockRejectedValueOnce(
      new RangeError('falha injetada'),
    );
    const m = noFim();
    const r = await despacharReconcileEstoqueLi(
      m.db,
      tarefa(7),
      m.deps({ agoraMs: () => AGORA_RECONCILE_MS, inicioMs: AGORA_RECONCILE_MS }),
    );
    expect(r).toEqual({ kind: 'encerrado' });
    expect(
      m.log.linhas.filter((l) => l.meta.motivo === 'arma-preco-falhou').map((l) => l.meta.fase),
    ).toEqual(['fim']);
    expect(m.fake.ler(`sincEstoqueLojaIntegrada/${CONTA_PRECO_A}`)?.ultimoReconcile).toBeTruthy();
    expect(ultimoReconcilePreco(m, CONTA_PRECO_B)).toBeTruthy();
  });
});

describe('the queue line', () => {
  it('carries `fasePreco` only while the run is in a price phase', () => {
    expect(
      camposDoRegistroDoReconcileLi(
        { kind: 'continua', fase: 'fila', seq: 3, fasePreco: 'pais-preco' },
        tarefa(2),
      ),
    ).toMatchObject({ fase: 'fila', fasePreco: 'pais-preco' });
    expect(
      Object.keys(
        camposDoRegistroDoReconcileLi({ kind: 'continua', fase: 'li', seq: 3 }, tarefa(2)),
      ),
    ).not.toContain('fasePreco');
  });
});
