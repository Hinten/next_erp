import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import type { TarefaImportacaoLi } from '@delfrance/schemas';

import {
  type AgendadorImportacaoLi,
  criarAgendadorImportacaoLi,
} from '../../lib/lojaIntegrada/importacao/agendadorImportacao';
import { type AgendadorLi, criarAgendadorLi } from '../../lib/lojaIntegrada/notificacoes/agendador';
import {
  FILA_LEITURA_LI,
  type PayloadNotificacaoLi,
} from '../../lib/lojaIntegrada/notificacoes/notificacao';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the reads-queue producers for this functions codebase:
 * the order poller (step 3) enqueues through {@link criarAgendadorLiDoAmbiente},
 * and the product import (step 9) — its job-creation trigger and each dispatch's
 * named continuation — through {@link criarAgendadorImportacaoLiDoAmbiente}.
 * What a rejection means, the transient naming, the "payload alone" rule and the
 * import's task names are the pure modules'
 * (`lib/lojaIntegrada/notificacoes/agendador.ts`,
 * `lib/lojaIntegrada/importacao/agendadorImportacao.ts`); this file only reads
 * the environment and binds the Admin SDK's task queue. Step 4 adds an App
 * Hosting root of its own beside the inbound webhook.
 */

/**
 * The region of the reads queue: `LOJA_INTEGRADA_TASKS_REGION`, else the
 * `FUNCTIONS_REGION` inlined into the bundle. NO default — an unset value throws
 * `MissingRegionError` on the enqueue rather than producing a well-formed path
 * to a queue that does not exist, which the Admin SDK resolves to `us-central1`
 * and silently drops (#1108). Blank counts as unset (`requireRegion`), and
 * `options.ts` already defaults the first candidate to the inlined region.
 *
 * ⚠️ The argument MUST stay an object literal of STATIC `process.env.X` reads:
 * esbuild's `define` substitutes the member expression and nothing else, so a
 * computed argument leaves `FUNCTIONS_REGION` a live read that is `undefined`
 * after a deploy. The bundle contains this root since the order poller imports
 * it, so `tools/deploy-env/bundle-inlining.test.js` proves the inlining on the
 * BUILT bundle; `agendador.test.ts` pins the same shape at the source, where the
 * failure names this file.
 */
export function regiaoDaFilaLi(): string {
  return requireRegion({
    LOJA_INTEGRADA_TASKS_REGION: process.env.LOJA_INTEGRADA_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/**
 * The sweep-only valve: EXACTLY `'1'` closes it. Unset, blank, `'true'`, `'1 '`
 * and `' 1'` all leave enqueuing on — never trim or case-fold a valve.
 */
export function tarefasLiDesligadas(): boolean {
  return process.env.LOJA_INTEGRADA_TASKS_DISABLED === '1';
}

/**
 * The producer, from the environment. The valve is read ONCE, here; the queue —
 * and so the region — is resolved per enqueue, and never while the valve is
 * closed. The admin app is the codebase's singleton (`getAdminApp`), which
 * initialises it when nothing has yet.
 */
export function criarAgendadorLiDoAmbiente(): AgendadorLi {
  return criarAgendadorLi({
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<PayloadNotificacaoLi>(
        `locations/${regiaoDaFilaLi()}/functions/${FILA_LEITURA_LI}`,
      ),
    desligado: tarefasLiDesligadas(),
  });
}

/**
 * The product import's producer (master plan step 9), on the SAME reads queue,
 * through the SAME region and valve readers as the order poller's — one queue,
 * one region, one sweep-only valve. The valve is read ONCE, here, when a caller
 * builds it (the trigger and a dispatch build it only when a hand-off is due);
 * the queue is resolved per enqueue, and never while the valve is closed.
 */
export function criarAgendadorImportacaoLiDoAmbiente(): AgendadorImportacaoLi {
  return criarAgendadorImportacaoLi({
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<TarefaImportacaoLi>(
        `locations/${regiaoDaFilaLi()}/functions/${FILA_LEITURA_LI}`,
      ),
    desligado: tarefasLiDesligadas(),
  });
}
