/**
 * The stock TRIGGER's work and the kit FAN-OUT (master plan step 12, PR 12-f) against the real
 * emulators (`ci-loja-integrada.yml`).
 *
 * What runs for real here:
 *
 *   tratarEventoEstoqueLi(deps, event)            the trigger's work, IN THIS PROCESS
 *     → lerMapaDepositosLi: the real `integracao` query (tipo == 3, ordered by nome) — a conta
 *       stored under the BARE depósito ref
 *     → the produto's own `produtolojaintegrada` listing (a counting child link)
 *     → the kits header (absent, inline, sharded) in ONE getAll
 *     → the siblings in ONE getAll (one stored at ANOTHER depósito: it flags its kit)
 *     → criarAgendadorEstoqueLiDoAmbiente()  the real producer root
 *       → the region-qualified `filaEstoqueLojaIntegrada` → the Cloud Tasks emulator, which
 *         ACCEPTS a task only if the deployed artifact registers that queue (a 404 otherwise)
 *
 * and, for the fan-out, one hop further:
 *
 *   the `estoque-kits` task the trigger's work enqueued
 *     → Cloud Tasks emulator → Functions emulator
 *     → filaEstoqueLojaIntegrada                   the real deployed onTaskDispatched
 *     → processarTarefaEstoqueKitsLi: the valve (`dry-run`, the job env), the conta, the
 *       sharded header and its shard, the component's own record (available 1)
 *     → the kits it holds at 0 → the global slot: `reconcileEstoqueLojaIntegrada/atual` CREATED
 *       with `proximoSlotMs` — its one write, read back raw here
 *     → one `estoque` send task per such kit (each later dispatched send run finds no kit
 *       produto: `produto-inexistente`, reads only)
 *
 * ⚠️ Why the trigger's work runs IN PROCESS and not through the deployed trigger. Its depósito map
 * is a 15-minute cache in the emulator's worker, warmed by whichever suite first writes a stock
 * record, so a deployed event at this suite's depósito could be judged against a map built before
 * this suite's conta existed — an order-dependent flake. In process, the cache is reset per case,
 * the valve is a PARAMETER (`ambiente`), and the event's payload is handed in. The DEPLOYED trigger
 * still fires on the few records this suite writes; none of them can make it enqueue anything
 * observable (below).
 *
 * The emulator ignores a task's schedule (firebase-tools#8254), so the fan-out dispatches at once
 * and nothing here asserts a dispatch time — only the slot the consumer computed, EXACTLY: with
 * the slot document wiped and no prior slot, `proximoSlotMs − n · interval − 30 s` is the floor of
 * a window the case spanned (a whole minute), with n the kits seeded at bound 0. A consumer that
 * picked another count lands off the minute grid unless it differs from n by a multiple of five
 * AND the case crossed a minute boundary; the selection itself is pinned exactly offline
 * (`processarKitsEstoque.test.ts`).
 *
 * Isolation (`vitest.tasks.config.ts`, the fifth trigger's rules):
 *  - a conta, a depósito and produto ids no other suite uses (the produtos also carry a per-run
 *    suffix, so a named-task dedup across runs against one emulator can never hide a dispatch);
 *  - the conta has `nome` (the map's query orders by it), no filial and no `dataCadastro` (the
 *    conta trigger only reads), and it is never edited (the deployed consumer's conta cache);
 *  - the ONLY component record seeded under a kits header is created AT its final value (no
 *    positive → 0 move ever happens on it, so the deployed trigger never fans out), and a sibling
 *    record sits at a depósito no Loja Integrada conta stocks from (the deployed trigger stops at
 *    its map);
 *  - every wipe deletes `sincEstoqueLojaIntegrada/{conta}` FIRST, then the slot document, then the
 *    links (awaiting the anchor), the produtos and the conta; the case whose fan-out writes the
 *    slot awaits that write before it ends.
 *
 * NOT proven here: the deployed trigger end to end, its gate order and its cost per event (pinned
 * offline by counting, `gatilhoEstoque.test.ts`), the map's TTL, named-task dedup, the declared
 * indexes (the emulator auto-creates every one; `depositosLi.test.ts` and
 * `leituraEstoqueErp.test.ts` pin each query against `firestore.indexes.json`), and any call to
 * Loja Integrada (none: the global fetch is watched, and the read switch is off in the lane).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { criarAgendadorEstoqueLiDoAmbiente } from '../../../functions/src/agendadorEstoque';
import { CHAMADAS_ENV_LI, MODO_LI, VALVULA_ENV_LI } from '../core/valvulas';
import { aguardarAncoraLi, comConta, semConta } from '../testing/ancoraLi';
import { DISPERSAO_ESTOQUE_LI_MS, JANELA_ESTOQUE_LI_MS, janelaEstoqueLi } from './agendadorEstoque';
import { type DepsGatilhoEstoqueLi, tratarEventoEstoqueLi } from './gatilhoEstoque';
import { INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS } from './slotEstoqueLi';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The enqueues and the dispatched fan-out are half of what this suite proves. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

/** Obviously fake ids, distinct from every other emulator suite's. */
const CONTA = 'conta-li-gatilho-ci';
const DEP = 'dep-li-gatilho-ci';
const DEP_ALHEIO = 'dep-li-gatilho-ci-alheio';
const RODADA = Date.now().toString(36);
const P_DIRETO = `p-li-gatilho-ci-direto-${RODADA}`;
const P_IMEDIATO = `p-li-gatilho-ci-imediato-${RODADA}`;
const P_IRMAO = `p-li-gatilho-ci-irmao-${RODADA}`;
const P_ZERADOS = `p-li-gatilho-ci-zerados-${RODADA}`;
const PRODUTOS = [P_DIRETO, P_IMEDIATO, P_IRMAO, P_ZERADOS] as const;
const EXEC = 'estoque-reconcile-20270115';
const SLOT = { colecao: 'reconcileEstoqueLojaIntegrada', id: 'atual' } as const;

const canonico = (produtoId: string, deposito = DEP) => `est-${produtoId}-${deposito}`;

function db(): Firestore {
  return getAdminFirestore();
}

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The kits map first (headers, shards), then the slot, then links → produtos, then the conta. */
async function limpar(): Promise<void> {
  await db().recursiveDelete(db().collection('sincEstoqueLojaIntegrada').doc(CONTA));
  await db().collection(SLOT.colecao).doc(SLOT.id).delete();
  for (const produtoId of PRODUTOS) {
    const ref = db().collection('produtos').doc(produtoId);
    const links = await ref.collection('produtolojaintegrada').get();
    for (const link of links.docs) await link.ref.delete();
    if (!links.empty && (await ref.get()).exists) {
      await aguardarAncoraLi(db(), produtoId, semConta(CONTA), `sem a conta (${produtoId})`);
    }
    await db().recursiveDelete(ref);
  }
  await db().recursiveDelete(db().collection('integracao').doc(CONTA));
}

/** The conta, its depósito stored under the BARE ref form. No filial: the conta trigger only reads. */
async function semearConta(): Promise<void> {
  await db()
    .collection('integracao')
    .doc(CONTA)
    .set({
      tipo: INTEGRACAO_TIPO.lojaIntegrada,
      nome: 'Loja do gatilho',
      ativo: true,
      depositoOuterRef: `depositos/${DEP}`,
    });
}

/** A stock record's payload as an event carries it, at our depósito (documents form). */
const registro = (quantidade: number) => ({
  depositoOuterRef: `documents/depositos/${DEP}`,
  quantidade,
  quantidadeReservada: 0,
});

/** `n` kits needing `q` of `componente`, ids `${prefixo}-<i>-<rodada>`. */
function kits(n: number, componente: string, q: number, prefixo: string) {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `${prefixo}-${String(i)}-${RODADA}`,
      { i: String(8000 + i), q: { [componente]: q } },
    ]),
  );
}

describe.skipIf(!EMULATED || !TASKS)(
  'the stock trigger’s work, in process → the real reads → the real producer root; the fan-out dispatched → the slot',
  () => {
    const redeGlobal: string[] = [];
    const linhas: (readonly [string, string, unknown])[] = [];

    function deps(): DepsGatilhoEstoqueLi {
      return {
        // The valve as a PARAMETER: the functions emulator reads the job env (also `dry-run`).
        ambiente: { [VALVULA_ENV_LI.estoque]: MODO_LI.dryRun },
        db,
        agendador: criarAgendadorEstoqueLiDoAmbiente,
        agoraMs: () => Date.now(),
        logger: {
          info: (m, meta) => linhas.push(['INFO', m, meta]),
          warn: (m, meta) => linhas.push(['WARNING', m, meta]),
          error: (m, meta) => linhas.push(['ERROR', m, meta]),
        },
      };
    }

    beforeAll(() => {
      // The admin app FIRST, with the project the setup pinned: the producer root reuses it.
      db();
    });

    beforeEach(async () => {
      __resetAllReadCaches();
      linhas.length = 0;
      await limpar();
      await semearConta();
      const anterior = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          redeGlobal.push(url);
          return anterior(input, init);
        },
      );
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      __resetAllReadCaches();
      // Nothing here reached the store: the trigger builds no client.
      const loja = new URL(URL_BASE_LI).hostname;
      const vazadas = redeGlobal.filter((u) => new URL(u).hostname === loja);
      redeGlobal.length = 0;
      expect(vazadas).toEqual([]);
      await limpar();
    });

    afterAll(async () => {
      await limpar();
    });

    it('a linked CHILD moving at a conta stored under the BARE depósito ref ⇒ the real map finds the conta, the real listing finds the link ⇒ ONE direct task, accepted by the queue', async () => {
      expect(process.env[CHAMADAS_ENV_LI]).not.toBe('on');
      const ref = db().collection('produtos').doc(P_DIRETO);
      await ref.set({ ehKit: false, sku: `SKU-${P_DIRETO}` });
      await ref
        .collection('produtolojaintegrada')
        .doc('l1')
        .set({
          contaLojaIntegrada: `documents/integracao/${CONTA}`,
          id: 182_904_918,
          paiProdutoIntegradaId: 900_001,
          sku: 'SKU-GATILHO-CI',
        });
      await aguardarAncoraLi(db(), P_DIRETO, comConta(CONTA), `com a conta (${P_DIRETO})`);

      const r = await tratarEventoEstoqueLi(deps(), {
        produtoId: P_DIRETO,
        estoqueId: canonico(P_DIRETO),
        antes: registro(5),
        depois: registro(4),
      });

      // `diretas: 1` only after the producer root's enqueue RESOLVED: a queue the artifact does
      // not register answers 404 and the work rethrows.
      expect(r).toEqual({
        tipo: 'processado',
        contas: [CONTA],
        diretas: 1,
        kits: 0,
        fanouts: 0,
        recusadas: 0,
        tarefasDesligadas: false,
      });
    });

    it('an inline kit whose sibling’s record sits at ANOTHER depósito ⇒ the real getAll reads it, it does not count ⇒ the kit is flagged and its send task accepted', async () => {
      const kitId = `k-li-gatilho-ci-imediato-${RODADA}`;
      // The sibling's record, at a depósito no Loja Integrada conta stocks from (the deployed
      // trigger, which fires on it, stops at its map).
      await db()
        .collection('produtos')
        .doc(P_IRMAO)
        .collection('estoques')
        .doc(canonico(P_IRMAO))
        .set({
          depositoOuterRef: `documents/depositos/${DEP_ALHEIO}`,
          quantidade: 0,
          quantidadeReservada: 0,
        });
      await db()
        .collection('sincEstoqueLojaIntegrada')
        .doc(CONTA)
        .collection('kits')
        .doc(P_IMEDIATO)
        .set({
          execucaoId: EXEC,
          F: 1,
          qMax: 1,
          comps: { [P_IMEDIATO]: canonico(P_IMEDIATO), [P_IRMAO]: canonico(P_IRMAO) },
          kits: { [kitId]: { i: '8100', q: { [P_IMEDIATO]: 1, [P_IRMAO]: 1 } } },
          fatias: 0,
        });

      const r = await tratarEventoEstoqueLi(deps(), {
        produtoId: P_IMEDIATO,
        estoqueId: canonico(P_IMEDIATO),
        antes: registro(9),
        depois: registro(8),
      });

      expect(r).toMatchObject({ tipo: 'processado', contas: [CONTA], diretas: 0, kits: 1 });
      expect(linhas).toContainEqual([
        'INFO',
        '[loja-integrada/estoque] gatilho kits',
        expect.objectContaining({ caminho: 'imediato', irmaosLidos: 1, sinalizados: 1 }),
      ]);
    });

    it('a sharded component crossing to 0 ⇒ ONE fan-out accepted; DISPATCHED, the deployed consumer reads its shard and the component’s record, and CREATES the slot for exactly the kits it holds at 0', async () => {
      const t0 = Date.now();
      // 31 kits (sharded): 3 need 2 of the component and 1 needs 3 — bound 0 at an available of
      // 1 — and 27 need 1 (bound 1, left out). The selection is the consumer's to prove.
      const zerados = { ...kits(3, P_ZERADOS, 2, 'kz'), ...kits(1, P_ZERADOS, 3, 'kt') };
      const restantes = kits(27, P_ZERADOS, 1, 'ku');
      const n = Object.keys(zerados).length;
      const conta = db().collection('sincEstoqueLojaIntegrada').doc(CONTA);
      // Shards before the header: the header is the map's commit point.
      await conta
        .collection('kitsFatias')
        .doc(`${P_ZERADOS}~0`)
        .set({ execucaoId: EXEC, kits: { ...zerados, ...restantes } });
      await conta
        .collection('kits')
        .doc(P_ZERADOS)
        .set({
          execucaoId: EXEC,
          F: n + 27,
          qMax: 3,
          comps: { [P_ZERADOS]: canonico(P_ZERADOS) },
          kits: null,
          fatias: 1,
        });
      // The component's record, CREATED at its final value: no positive → 0 move ever happens
      // on it, so the deployed trigger (which fires on this create) never fans out.
      await db()
        .collection('produtos')
        .doc(P_ZERADOS)
        .collection('estoques')
        .doc(canonico(P_ZERADOS))
        .set(registro(1));

      const r = await tratarEventoEstoqueLi(deps(), {
        produtoId: P_ZERADOS,
        estoqueId: canonico(P_ZERADOS),
        antes: registro(3),
        depois: registro(1),
      });

      expect(r).toMatchObject({ tipo: 'processado', diretas: 0, kits: 0, fanouts: 1 });

      // The dispatched consumer's ONE write: poll for it, then read it back raw.
      const prazo = Date.now() + 45_000;
      let slot: unknown;
      for (;;) {
        const snap = await db().collection(SLOT.colecao).doc(SLOT.id).get();
        slot = snap.exists ? snap.get('proximoSlotMs') : undefined;
        if (typeof slot === 'number') break;
        if (Date.now() > prazo) {
          throw new Error(
            'o fan-out despachado não gravou reconcileEstoqueLojaIntegrada/atual em 45 s. ' +
              'Confira que LOJA_INTEGRADA_MODO_ESTOQUE=dry-run está no ambiente do ' +
              'emulators:exec (com a válvula off o consumidor sai sem ler nada), que ' +
              'LOJA_INTEGRADA_TASKS_REGION é igual ao FUNCTIONS_REGION embutido no bundle ' +
              '(o descarte silencioso do #1108) e que prepare-deploy.mjs rodou antes do ' +
              'emulators:exec (.github/workflows/ci-loja-integrada.yml).',
          );
        }
        await aguardar(250);
      }
      const snap = await db().collection(SLOT.colecao).doc(SLOT.id).get();
      // ONLY proximoSlotMs: a fan-out writes no other field of the reconcile's document.
      expect(Object.keys(snap.data() ?? {})).toEqual(['proximoSlotMs']);

      // EXACT: the floor (a whole minute + the 30 s spread) + n intervals, the floor's window one
      // the consumer ran in (between this case's start and the poll that saw the slot).
      const t1 = Date.now();
      const piso = Number(slot) - n * INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS - DISPERSAO_ESTOQUE_LI_MS;
      expect(piso % JANELA_ESTOQUE_LI_MS).toBe(0);
      expect(piso).toBeGreaterThanOrEqual((janelaEstoqueLi(t0) + 3) * JANELA_ESTOQUE_LI_MS);
      expect(piso).toBeLessThanOrEqual((janelaEstoqueLi(t1) + 3) * JANELA_ESTOQUE_LI_MS);
    });
  },
);
