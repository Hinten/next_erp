/**
 * `execucaoReconcile.ts`'s take of the lease with the price arm (master plan step 13, PR 13-f1):
 * the price fields and counters merged into the take's patch, each priced conta's price root in the
 * SAME batch (create when absent, update under its read), no stock root for a run that does not
 * carry stock — and, with neither option, exactly the stock-only take. Against `testing/fakeDb.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  sincEstoqueLojaIntegradaCollection,
  sincPrecoLojaIntegradaCollection,
} from '@delfrance/data/admin/collections';
import { camposPrecoDaTomadaReconcileLi } from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../../testing/fakeDb';
import {
  AGORA_RECONCILE_MS,
  CAMINHO_RUN_RECONCILE_LI,
  RUN_A,
  RUN_B,
} from '../../testing/reconcileEstoqueLi';
import {
  type RaizParaAssumirLi,
  type RaizPrecoParaAssumirLi,
  assumirLeaseReconcileLi,
  lerRunReconcileLi,
} from './execucaoReconcile';

const TAREFA = { execucaoId: RUN_A, seq: 0 };
const TABELAS = { normal: 'tab-n', promocional: null };

function raizEstoque(db: FakeDb, contaId: string): RaizParaAssumirLi {
  return {
    contaId,
    depositoId: 'dep-1',
    ref: sincEstoqueLojaIntegradaCollection.docRef(asDb(db), {}, contaId),
    versao: null,
  };
}

function raizPreco(
  db: FakeDb,
  contaId: string,
  contadores: Record<string, number> = {},
): RaizPrecoParaAssumirLi {
  const caminho = `sincPrecoLojaIntegrada/${contaId}`;
  return {
    contaId,
    tabelas: TABELAS,
    contadores,
    ref: sincPrecoLojaIntegradaCollection.docRef(asDb(db), {}, contaId),
    versao: (db.carimboDe(caminho) ?? null) as never,
  };
}

/** The keys of the take's patch, from the run document's one write. */
function patchDaTomada(db: FakeDb): Record<string, unknown> | null {
  return db.escritasEm(CAMINHO_RUN_RECONCILE_LI)[0]?.dados ?? null;
}

describe('the take with the price arm', () => {
  it('price carried: `precoNoRun`, `fasePreco: null`, the request stamped with the run, and every priced root in ONE batch', async () => {
    const db = new FakeDb();
    // C2's root holds another run's state: updated under its read, its last run left as it is.
    db.seed('sincPrecoLojaIntegrada/C2', {
      ultimoReconcilePreco: null,
      execucaoPreco: { execucaoId: RUN_B, tabelas: TABELAS },
    });
    const tarefa = { ...TAREFA, precoSolicitado: { contaId: 'C1', permitirBaixar: true } };
    const r = await assumirLeaseReconcileLi(asDb(db), {
      lido: await lerRunReconcileLi(asDb(db)),
      tarefa,
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [raizEstoque(db, 'C1'), raizEstoque(db, 'C2')],
      preco: {
        contadores: { precoNoRun: 1 },
        campos: { ...camposPrecoDaTomadaReconcileLi(tarefa) },
        raizes: [raizPreco(db, 'C1', { promoIgualNormal: 1 }), raizPreco(db, 'C2')],
      },
    });
    expect(r.tipo).toBe('assumido');
    expect(patchDaTomada(db)).toMatchObject({
      fase: 'erp',
      contadores: { precoNoRun: 1 },
      fasePreco: null,
      precoSolicitado: { execucaoId: RUN_A, contaId: 'C1', permitirBaixar: true },
    });
    const lotes = new Set(db.escritas.map((e) => e.lote));
    expect(lotes.size).toBe(1);
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([
      ['create', CAMINHO_RUN_RECONCILE_LI],
      ['create', 'sincEstoqueLojaIntegrada/C1'],
      ['create', 'sincEstoqueLojaIntegrada/C2'],
      ['create', 'sincPrecoLojaIntegrada/C1'],
      ['update', 'sincPrecoLojaIntegrada/C2'],
    ]);
    expect(db.ler('sincPrecoLojaIntegrada/C1')?.execucaoPreco).toEqual({
      execucaoId: RUN_A,
      tabelas: TABELAS,
      amostras: {},
      contadores: { promoIgualNormal: 1 },
      candidatos: [],
      mantidos: [],
    });
    expect(db.ler('sincPrecoLojaIntegrada/C2')).toMatchObject({
      ultimoReconcilePreco: null,
      execucaoPreco: { execucaoId: RUN_A },
    });
    expect((await lerRunReconcileLi(asDb(db))).run).not.toBeNull();
  });

  it('GOLDEN in miniature: with neither option the patch holds exactly the stock fields', async () => {
    const db = new FakeDb();
    await assumirLeaseReconcileLi(asDb(db), {
      lido: await lerRunReconcileLi(asDb(db)),
      tarefa: TAREFA,
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [raizEstoque(db, 'C1')],
    });
    expect(Object.keys(patchDaTomada(db) ?? {}).sort()).toEqual([
      'candidatos',
      'contadores',
      'contas',
      'emExecucaoAteMs',
      'execucaoId',
      'fase',
      'idxConta',
      'iniciadoEmMs',
      'seq',
      'walk',
    ]);
    expect(patchDaTomada(db)?.contadores).toEqual({});
  });

  it('⚠️ a DEAD run’s `fasePreco` stored: with the price fields the take writes both nulls and the document parses; NEAR-MISS: without them it would not', async () => {
    const morto = {
      execucaoId: RUN_B,
      iniciadoEmMs: AGORA_RECONCILE_MS - 50 * 3_600_000,
      emExecucaoAteMs: 0,
      seq: 9,
      fase: 'fila',
      fasePreco: 'li-preco',
      precoSolicitado: { execucaoId: RUN_B, contaId: 'C1', permitirBaixar: true },
      contas: ['C1'],
      idxConta: 0,
      walk: null,
      candidatos: [],
      contadores: {},
    };
    for (const comCampos of [true, false]) {
      const db = new FakeDb();
      db.seed(CAMINHO_RUN_RECONCILE_LI, morto);
      await assumirLeaseReconcileLi(asDb(db), {
        lido: await lerRunReconcileLi(asDb(db)),
        tarefa: TAREFA,
        agoraMs: AGORA_RECONCILE_MS,
        raizes: [raizEstoque(db, 'C1')],
        ...(comCampos
          ? {
              preco: {
                contadores: {},
                campos: { ...camposPrecoDaTomadaReconcileLi(TAREFA) },
                raizes: [],
              },
            }
          : {}),
      });
      const relido = await lerRunReconcileLi(asDb(db));
      if (comCampos) {
        expect(db.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({
          fasePreco: null,
          precoSolicitado: null,
        });
        expect(relido.run?.execucaoId).toBe(RUN_A);
      } else {
        expect(relido.run).toBeNull();
      }
    }
  });

  it('`escreverRaizesEstoque: false` (a run without the stock arm) writes no stock root', async () => {
    const db = new FakeDb();
    await assumirLeaseReconcileLi(asDb(db), {
      lido: await lerRunReconcileLi(asDb(db)),
      tarefa: TAREFA,
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [raizEstoque(db, 'C1')],
      escreverRaizesEstoque: false,
      preco: {
        contadores: { precoNoRun: 1, estoqueForaDoRun: 1 },
        campos: { ...camposPrecoDaTomadaReconcileLi(TAREFA) },
        raizes: [raizPreco(db, 'C1')],
      },
    });
    expect(db.escritas.map((e) => e.caminho)).toEqual([
      CAMINHO_RUN_RECONCILE_LI,
      'sincPrecoLojaIntegrada/C1',
    ]);
    expect(patchDaTomada(db)?.contas).toEqual(['C1']);
  });

  it('a lost race ⇒ `perdido`; a commit that LANDED with its reply lost ⇒ `assumido`', async () => {
    const opcoes = (db: FakeDb) => ({
      tarefa: TAREFA,
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [raizEstoque(db, 'C1')],
      preco: {
        contadores: { precoNoRun: 1 },
        campos: { ...camposPrecoDaTomadaReconcileLi(TAREFA) },
        raizes: [raizPreco(db, 'C1')],
      },
    });
    const perdeu = new FakeDb();
    perdeu.seed(CAMINHO_RUN_RECONCILE_LI, { proximoSlotMs: 1 });
    const lido = await lerRunReconcileLi(asDb(perdeu));
    perdeu.seed(CAMINHO_RUN_RECONCILE_LI, { proximoSlotMs: 2 });
    expect((await assumirLeaseReconcileLi(asDb(perdeu), { lido, ...opcoes(perdeu) })).tipo).toBe(
      'perdido',
    );
    expect(perdeu.ler('sincPrecoLojaIntegrada/C1')).toBeUndefined();

    const ganhou = new FakeDb();
    ganhou.seed(CAMINHO_RUN_RECONCILE_LI, { proximoSlotMs: 1 });
    const lidoG = await lerRunReconcileLi(asDb(ganhou));
    ganhou.respostaPerdidaNaProximaEscrita(
      CAMINHO_RUN_RECONCILE_LI,
      grpc(9, 'FAILED_PRECONDITION'),
    );
    const r = await assumirLeaseReconcileLi(asDb(ganhou), { lido: lidoG, ...opcoes(ganhou) });
    expect(r.tipo).toBe('assumido');
    expect(ganhou.ler('sincPrecoLojaIntegrada/C1')?.execucaoPreco).toMatchObject({
      execucaoId: RUN_A,
    });
  });
});
