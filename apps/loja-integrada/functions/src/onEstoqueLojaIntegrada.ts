import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

import { estoqueProdutoMeta } from '@delfrance/schemas';

import {
  type DepsGatilhoEstoqueLi,
  type ResultadoGatilhoEstoqueLi,
  tratarEventoEstoqueLi,
} from '../../lib/lojaIntegrada/estoque/gatilhoEstoque';
import type { DadosEstoqueLi } from '../../lib/lojaIntegrada/estoque/planoEstoqueLi';
import { criarAgendadorEstoqueLiDoAmbiente } from './agendadorEstoque';
import { getDb } from './lib/admin';

/**
 * The deps of ONE event, bound to the LIVE process environment, the codebase's Firestore handle
 * and the stock producer's root — the handle and the producer resolved lazily, so an event that
 * stops at the first two gates builds neither.
 */
function depsDoGatilhoEstoqueLi(): DepsGatilhoEstoqueLi {
  return {
    ambiente: process.env,
    db: getDb,
    agendador: criarAgendadorEstoqueLiDoAmbiente,
    agoraMs: () => Date.now(),
    logger,
  };
}

/**
 * The stock TRIGGER of the Loja Integrada channel (master plan step 12, PR 12-f) — a producer of
 * the stock queue (`./filaEstoque`). It turns a write of an ERP stock record into the send runs
 * that write may need: ONE named task per (conta, linked child) whose own published quantity can
 * have moved, one per store kit the eager filter flags, or ONE fan-out task for a component with
 * more store kits than the eager ceiling. The tasks — never this function — read the ERP and the
 * store and decide what to send. The work is `lib/lojaIntegrada/estoque/gatilhoEstoque.ts`; its
 * module header states the gates, their costs and the rejection contract.
 *
 * ⚠️ It fires on EVERY write of `produtos/{produtoId}/estoques/{estoqueId}`, every depósito and
 * every channel's produtos included — so the first two gates (the payload's relevance, the valve
 * `LOJA_INTEGRADA_MODO_ESTOQUE`) cost ZERO reads and log NOTHING, and the third reads only a
 * cached map of the Loja Integrada contas' depósitos. `apps/functions`' `onEstoqueDeleted` (the
 * storage codebase) listens on the same path, for deletes; the two are independent.
 *
 * ⚠️ Targets the NAMED `default` database, inlined at build time by `build.mjs`
 * (`onIntegracaoLojaIntegradaChanged`'s docblock says why): an `onDocument*` bound to
 * `(default)` deploys fine and NEVER fires. `retry: true`: a transient failure (a read, a Cloud
 * Tasks hiccup) is retried, and the retry is safe — the trigger keeps no state and writes no
 * Firestore document, every task is NAMED by its processing window (a retry inside the window
 * meets its own task; one in a later window is one more run, never a loss), and a stale
 * redelivery only over-includes: each task re-reads the current stock when it runs. No loop: it
 * writes nothing. No `region:` (options.ts), no `secrets:` (it never calls Loja Integrada), no
 * memory or timeout of its own.
 *
 * LOGS: ids and counts only — never a quantity, a stored ref or a value of the environment.
 */
export const onEstoqueLojaIntegrada = onDocumentWritten(
  {
    // The meta, never a literal: `produtos/{produtoId}/estoques`.
    document: `${estoqueProdutoMeta.collectionPath}/{estoqueId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts), no `secrets:`, no memory/timeout — see the docblock.
  },
  async (event): Promise<ResultadoGatilhoEstoqueLi> => {
    // The `{produtoId}` wildcard sits inside the meta-derived prefix, so its type is not inferred
    // into `event.params` — both are present at runtime. The ids come from the PATH.
    const { produtoId, estoqueId } = event.params as { produtoId: string; estoqueId: string };
    const antes = event.data?.before.exists ? (event.data.before.data() as DadosEstoqueLi) : null;
    const depois = event.data?.after.exists ? (event.data.after.data() as DadosEstoqueLi) : null;

    return tratarEventoEstoqueLi(depsDoGatilhoEstoqueLi(), {
      produtoId,
      estoqueId,
      antes,
      depois,
    });
  },
);
