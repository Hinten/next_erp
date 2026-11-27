import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

import { produtoMeta } from '@delfrance/schemas';

import {
  type DepsGatilhoPrecoLi,
  type ResultadoGatilhoPrecoLi,
  tratarEventoPrecoLi,
} from '../../lib/lojaIntegrada/preco/gatilhoPreco';
import type { DadosProdutoPrecoLi } from '../../lib/lojaIntegrada/preco/relevanciaPrecoLi';
import { criarAgendadorPrecoLiDoAmbiente } from './agendadorPreco';
import { getDb } from './lib/admin';

/**
 * The deps of ONE event, bound to the LIVE process environment, the codebase's Firestore handle
 * and the price producer's root — the handle and the producer resolved lazily, so an event that
 * stops at the relevance gate, the valve or the anchor builds neither.
 */
function depsDoGatilhoPrecoLi(): DepsGatilhoPrecoLi {
  return {
    ambiente: process.env,
    db: getDb,
    agendador: criarAgendadorPrecoLiDoAmbiente,
    agoraMs: () => Date.now(),
    logger,
  };
}

/**
 * The price TRIGGER of the Loja Integrada channel (master plan step 13, PR 13-e) — a producer of
 * the price queue (`./filaPreco`), beside the send run's own `deriva` follow-up. It turns a write
 * of an ERP produto into the send runs that write may need: ONE named task per (conta, linked
 * produto) whose price can have moved. The tasks — never this function — read the ERP and the
 * store and decide what to send. The work is `lib/lojaIntegrada/preco/gatilhoPreco.ts`; its module
 * header states the gates, their costs and the rejection contract.
 *
 * ⚠️ It fires on EVERY write of `produtos/{produtoId}`, every channel's produtos included — the
 * same path `apps/functions`' produto triggers (the storage codebase) and Mercado Livre's category
 * trigger listen on, in other codebases; all of them are independent. So the first two gates (the
 * payload's relevance, the valve `LOJA_INTEGRADA_MODO_PRECO`) cost ZERO reads and log nothing (an
 * unrecognised valve value: ONE latched WARNING per instance), the third (the payload's own
 * anchor) reads nothing either, and the fourth reads only a cached map of the Loja Integrada
 * contas' price tabelas. Past them, at most ONE masked parent read for a child or ONE family query
 * per concerned conta for a root.
 *
 * ⚠️ Targets the NAMED `default` database, inlined at build time by `build.mjs`
 * (`onIntegracaoLojaIntegradaChanged`'s docblock says why): an `onDocument*` bound to
 * `(default)` deploys fine and NEVER fires. `retry: true`: a transient failure (a read, a Cloud
 * Tasks hiccup) is retried, and the retry is safe — the trigger keeps no state and writes no
 * Firestore document, every task is NAMED by its processing window (a retry inside the window
 * meets its own task; one in a later window is one more run, never a loss), and a stale
 * redelivery only over-includes: each task re-reads the ERP and the store when it runs. No loop:
 * it writes nothing. No `region:` (options.ts), no `secrets:` (it never calls Loja Integrada), no
 * memory or timeout of its own, and no `maxInstances`: it inherits the codebase's 10 from
 * `options.ts`. The region and the sweep-only valve are read by the price producer's root
 * (`./agendadorPreco`, through `./agendador`'s readers); the valve from the live `process.env`,
 * passed whole on every event.
 *
 * LOGS: ids and counts only — never a price, a tabela id or a value of the environment.
 */
export const onPrecoLojaIntegrada = onDocumentWritten(
  {
    // The meta, never a literal: `produtos`.
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts), no `secrets:`, no memory/timeout, no `maxInstances` (the
    // codebase's 10) — see the docblock.
  },
  async (event): Promise<ResultadoGatilhoPrecoLi> => {
    // The `{produtoId}` wildcard sits after a meta-derived prefix, so its type is not inferred
    // into `event.params` — it is present at runtime. The id comes from the PATH.
    const { produtoId } = event.params as { produtoId: string };
    const antes = event.data?.before.exists
      ? (event.data.before.data() as DadosProdutoPrecoLi)
      : null;
    const depois = event.data?.after.exists
      ? (event.data.after.data() as DadosProdutoPrecoLi)
      : null;

    return tratarEventoPrecoLi(depsDoGatilhoPrecoLi(), { produtoId, antes, depois });
  },
);
