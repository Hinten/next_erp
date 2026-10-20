import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import {
  type AgendadorAmazon,
  caminhoDaFilaAmazon,
  criarAgendadorAmazon,
} from '../../lib/amazon/notificacoes/agendador';
import type { PayloadNotificacaoAmazon } from '../../lib/amazon/notificacoes/notificacao';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the reads-queue producer for this functions codebase:
 * the step-4 backstop poll (PR 4-b) enqueues through it. What a rejection
 * means, the transient naming and the "payload alone" rule are the pure
 * module's (`lib/amazon/notificacoes/agendador.ts`); this file only reads the
 * environment and binds the Admin SDK's task queue. Its App Hosting twin is the
 * receiver's `lib/firebase/filaLeitura.ts`; `estrutura.test.ts` pins the two as
 * the app's ONLY `getFunctions(` callers.
 *
 * ⚠️ Nothing imports it before PR 4-b, so esbuild leaves it out of the bundle and
 * `tools/deploy-env/bundle-inlining.test.js` cannot see it yet: the source-shape
 * pin in `agendador.test.ts` stands in until the poll makes it reachable.
 */

/**
 * The region of the reads queue: `AMAZON_TASKS_REGION`, else the
 * `FUNCTIONS_REGION` inlined into the bundle. NO default — an unset value throws
 * `MissingRegionError` on the enqueue rather than producing a well-formed path
 * to a queue that does not exist, which the Admin SDK resolves to `us-central1`
 * and silently drops (#1108). Blank counts as unset (`requireRegion`), and
 * `options.ts` already defaults the first candidate to the inlined region.
 *
 * ⚠️ The argument MUST stay an object literal of STATIC `process.env.X` reads:
 * esbuild's `define` substitutes the member expression and nothing else, so a
 * computed argument leaves `FUNCTIONS_REGION` a live read that is `undefined`
 * after a deploy. `agendador.test.ts` pins the shape at the source, where the
 * failure names this file.
 */
export function regiaoDaFilaAmazon(): string {
  return requireRegion({
    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/**
 * The sweep-only valve: EXACTLY `'1'` closes it. Unset, blank, `'true'`, `'1 '`
 * and `' 1'` all leave enqueuing on — never trim or case-fold a valve.
 */
export function tarefasAmazonDesligadas(): boolean {
  return process.env.AMAZON_TASKS_DISABLED === '1';
}

/**
 * The producer, from the environment. The valve is read ONCE, here; the queue —
 * and so the region — is resolved per enqueue, and never while the valve is
 * closed. The admin app is the codebase's singleton (`getAdminApp`), which
 * initialises it when nothing has yet.
 */
export function criarAgendadorAmazonDoAmbiente(): AgendadorAmazon {
  return criarAgendadorAmazon({
    desligado: tarefasAmazonDesligadas(),
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<PayloadNotificacaoAmazon>(
        caminhoDaFilaAmazon(regiaoDaFilaAmazon()),
      ),
  });
}
