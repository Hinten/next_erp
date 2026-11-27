/**
 * MIRROR (master plan step 13, PR 13-f1): a fault in the price arm never moves the stock flow.
 * Scenario A of the GOLDEN suite (`testing/reconcilePrecoLi.ts`: stock `on`, canary `*`, the read
 * switch `on`) runs twice in the same clock model — once with the price valve unset, once with it
 * set and the price arm of a walk page made to fail through its seam — and the stock side of the
 * two runs must be the same: the run's counters (less the price arm's own), every write under
 * `sincEstoqueLojaIntegrada/`, every stock enqueue, every stock aviso. The price side must show the
 * fault where it was contained, and nowhere else.
 *
 * No call to the store: the global `fetch` throws; the store is the scripted one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { entradaSnapshotPrecoLiSchema } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../core/contaCache';
import { type AmbienteLi, CANARIO_ENV_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import type { DocData, EscritaFake } from '../../testing/fakeDb';
import { AGORA_RECONCILE_MS, CAMINHO_RUN_RECONCILE_LI } from '../../testing/reconcileEstoqueLi';
import {
  AMBIENTE_ESTOQUE_LIGADO_LI,
  CONTA_PRECO_A,
  CONTA_PRECO_B,
  type FatiaRastreadaLi,
  type MundoReconcilePrecoLi,
  encadearReconcilePrecoLi,
  linhaEstavelLi,
  mundoReconcilePrecoLi,
} from '../../testing/reconcilePrecoLi';
import { avaliarPrecoDaPaginaLi } from './armaPrecoErp';
import { CONTADORES_DE_PRECO_DO_RUN_LI } from './armasReconcile';
import type { DepsReconcileEstoqueLi } from './despachoReconcile';
import { CAMPOS_PRODUTO_PRECO_LI } from '../../preco/leituraPrecoErp';

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_RECONCILE_MS);
  vi.stubGlobal('fetch', () => {
    throw new Error('reconcilePreco.espelho.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

/** The same clock model for both runs: Firestore reads cost no time, so the price arm's own reads move no slice boundary. */
const PASSOS = { porLeituraMs: 0, porChamadaMs: 9_000 } as const;

interface Rodada {
  readonly m: MundoReconcilePrecoLi;
  readonly fatias: FatiaRastreadaLi[];
}

async function rodar(
  ambiente: AmbienteLi,
  extra: Partial<DepsReconcileEstoqueLi> = {},
): Promise<Rodada> {
  __resetAllReadCaches();
  const m = mundoReconcilePrecoLi({ ambiente, passos: PASSOS });
  const fatias = await encadearReconcilePrecoLi(m, { extra });
  return { m, fatias };
}

/** The stock side of a run (module header). */
function ladoEstoque(r: Rodada) {
  const run = r.m.fake.ler(CAMINHO_RUN_RECONCILE_LI);
  const contadores = { ...((run?.contadores ?? {}) as Record<string, number>) };
  for (const nome of CONTADORES_DE_PRECO_DO_RUN_LI) delete contadores[nome];
  const sem = (e: EscritaFake) =>
    linhaEstavelLi({ verbo: e.verbo, caminho: e.caminho, dados: e.dados });
  return {
    resultados: r.fatias.map((f) => f.resultado),
    contadores,
    escritasEstoque: r.m.fake.escritas
      .filter((e) => e.caminho.startsWith('sincEstoqueLojaIntegrada/'))
      .map(sem),
    avisos: r.m.fake.escritas.filter((e) => e.caminho.startsWith('avisos/')).map(sem),
    enfileiradas: r.m.estoque.enviadas.map((t) => linhaEstavelLi(t)),
  };
}

/** The price root of a conta, as the run left it. */
function raizPreco(r: Rodada, contaId: string): DocData | undefined {
  return r.m.fake.ler(`sincPrecoLojaIntegrada/${contaId}`);
}

function contadoresDePreco(r: Rodada, contaId: string): Record<string, number> {
  const ultimo = raizPreco(r, contaId)?.ultimoReconcilePreco as
    | { readonly contadores: Record<string, number> }
    | null
    | undefined;
  return ultimo?.contadores ?? {};
}

function errosDoBraco(r: Rodada) {
  return r.m.log.linhas.filter((l) => l.nivel === 'error' && l.meta.motivo === 'arma-preco-falhou');
}

const PRECO_DRY = { ...AMBIENTE_ESTOQUE_LIGADO_LI, [VALVULA_ENV_LI.preco]: 'dry-run' };
const PRECO_ON = {
  ...AMBIENTE_ESTOQUE_LIGADO_LI,
  [VALVULA_ENV_LI.preco]: 'on',
  [CANARIO_ENV_LI.preco]: '*',
};

/** An arm that throws `erro()` for `conta` on its `pagina`-th call for that conta (`null`: every call). */
function armaQueFalha(
  erro: () => Error,
  quando: { readonly conta?: string; readonly pagina?: number } = {},
): typeof avaliarPrecoDaPaginaLi {
  const chamadas = new Map<string, number>();
  return (args) => {
    const n = (chamadas.get(args.conta.contaId) ?? 0) + 1;
    chamadas.set(args.conta.contaId, n);
    const contaCerta = quando.conta === undefined || quando.conta === args.conta.contaId;
    const paginaCerta = quando.pagina === undefined || quando.pagina === n;
    if (contaCerta && paginaCerta) throw erro();
    return avaliarPrecoDaPaginaLi(args);
  };
}

describe('MIRROR — a fault in the price arm leaves the stock flow exactly as without the price arm', () => {
  it(
    'a TypeError on EVERY page: stock equal; each conta counts armaFalhou with ONE ERROR, runs no parents unit and gets no aviso — even under `on`',
    // Three whole chains; CI runners are slower under load.
    { timeout: 30_000 },
    async () => {
      const base = await rodar(AMBIENTE_ESTOQUE_LIGADO_LI);
      for (const ambiente of [PRECO_DRY, PRECO_ON]) {
        const r = await rodar(ambiente, {
          armaPrecoDePaginaLi: armaQueFalha(() => new TypeError('falha injetada')),
        });
        expect(ladoEstoque(r)).toEqual(ladoEstoque(base));
        expect(r.fatias.at(-1)?.resultado).toEqual({ kind: 'encerrado' });
        // Contained where it was raised: once per conta (its later pages skip it).
        const erros = errosDoBraco(r);
        expect(erros.map((l) => [l.meta.contaId, l.meta.fase, l.meta.classe])).toEqual([
          [CONTA_PRECO_A, 'erp', 'TypeError'],
          [CONTA_PRECO_B, 'erp', 'TypeError'],
        ]);
        for (const conta of [CONTA_PRECO_A, CONTA_PRECO_B]) {
          const c = contadoresDePreco(r, conta);
          expect(c.armaFalhou, conta).toBe(1);
          expect(c.paisConcluido, conta).toBeUndefined();
        }
        // No parents unit: no parents read, no targets line, no price aviso.
        expect(
          r.m.getAlls.filter(
            (g) => JSON.stringify(g.mascara) === JSON.stringify(CAMPOS_PRODUTO_PRECO_LI),
          ),
        ).toEqual([]);
        expect(r.m.log.linhas.some((l) => l.msg.includes('alvos da conta calculados'))).toBe(false);
        expect(r.m.fake.escritas.some((e) => e.caminho.includes('lojaIntegradaPreco'))).toBe(false);
      }
    },
  );

  it(
    'a TypeError on page 2 for the FIRST conta only: stock equal; that conta faults once, the other is priced whole',
    { timeout: 30_000 },
    async () => {
      const base = await rodar(AMBIENTE_ESTOQUE_LIGADO_LI);
      const r = await rodar(PRECO_DRY, {
        armaPrecoDePaginaLi: armaQueFalha(() => new TypeError('falha injetada'), {
          conta: CONTA_PRECO_A,
          pagina: 2,
        }),
      });
      expect(ladoEstoque(r)).toEqual(ladoEstoque(base));
      expect(errosDoBraco(r).map((l) => l.meta.contaId)).toEqual([CONTA_PRECO_A]);
      expect(contadoresDePreco(r, CONTA_PRECO_A).armaFalhou).toBe(1);
      const b = contadoresDePreco(r, CONTA_PRECO_B);
      expect(b.armaFalhou).toBeUndefined();
      expect(b.paisConcluido).toBe(1);
      expect(b.validos).toBe(1);
      expect(
        r.m.log.linhas
          .filter((l) => l.msg.includes('alvos da conta calculados'))
          .map((l) => l.meta.contaId),
      ).toEqual([CONTA_PRECO_B]);
    },
  );

  it('a ZodError is contained the same way', { timeout: 30_000 }, async () => {
    const base = await rodar(AMBIENTE_ESTOQUE_LIGADO_LI);
    const r = await rodar(PRECO_DRY, {
      armaPrecoDePaginaLi: armaQueFalha(
        () => entradaSnapshotPrecoLiSchema.safeParse({}).error ?? new TypeError('inalcançável'),
      ),
    });
    expect(ladoEstoque(r)).toEqual(ladoEstoque(base));
    expect(errosDoBraco(r).map((l) => l.meta.classe)).toEqual(['ZodError', 'ZodError']);
  });

  it(
    '⚠️ an arm that RETURNS an entry off its schema after valid ones: refused whole BEFORE anything is applied — nothing of the page reaches the buckets',
    { timeout: 30_000 },
    async () => {
      const base = await rodar(AMBIENTE_ESTOQUE_LIGADO_LI);
      const r = await rodar(PRECO_DRY, {
        armaPrecoDePaginaLi: (args) => {
          const real = avaliarPrecoDaPaginaLi(args);
          return {
            ...real,
            entradas: [...real.entradas, ['1999', { p: '', f: 'v' } as never]],
          };
        },
      });
      expect(ladoEstoque(r)).toEqual(ladoEstoque(base));
      expect(errosDoBraco(r).map((l) => [l.meta.contaId, l.meta.classe])).toEqual([
        [CONTA_PRECO_A, 'ZodError'],
        [CONTA_PRECO_B, 'ZodError'],
      ]);
      // The real entries of the faulted page came before the bad one: none was applied.
      for (const conta of [CONTA_PRECO_A, CONTA_PRECO_B]) {
        for (let b = 0; b < 32; b += 1) {
          const balde = r.m.fake.ler(
            `sincPrecoLojaIntegrada/${conta}/snapshot/${String(b).padStart(2, '0')}`,
          );
          expect(balde?.e, `${conta}/${String(b)}`).toEqual({});
        }
      }
    },
  );

  it(
    'NEAR-MISS: with no fault, the same run prices both contas (the arm is live in this harness)',
    { timeout: 30_000 },
    async () => {
      const base = await rodar(AMBIENTE_ESTOQUE_LIGADO_LI);
      const r = await rodar(PRECO_DRY);
      expect(ladoEstoque(r)).toEqual(ladoEstoque(base));
      expect(errosDoBraco(r)).toEqual([]);
      for (const conta of [CONTA_PRECO_A, CONTA_PRECO_B]) {
        expect(contadoresDePreco(r, conta).paisConcluido, conta).toBe(1);
      }
    },
  );
});
