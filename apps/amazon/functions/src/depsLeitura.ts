import { FieldValue } from 'firebase-admin/firestore';

import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import { LWA_CLIENT_SECRET_ENV } from '../../lib/amazon/env';
import {
  type DepsLeituraAmazon,
  importadorPedidoAmazon,
} from '../../lib/amazon/notificacoes/notificacao';

/**
 * The Secret Manager names a READ run binds (`secrets:`): the LWA client
 * secret, read by the context loader for the refresh once the read switch is
 * on. The name is the env reader's own constant, so the binding and the read
 * cannot drift apart. Bound on the reads queue and the reprocess sweep; NOT on
 * the expiry sweep, which makes no Amazon call.
 *
 * ⚠️ A declared secret missing from Secret Manager fails the WHOLE deploy
 * (window item W1 creates it before the functions deploy, W9).
 */
export const SEGREDOS_DE_LEITURA_AMAZON: readonly string[] = [LWA_CLIENT_SECRET_ENV];

/**
 * The dependencies of one READ run — a reads-queue dispatch, or one tick of the
 * reprocess sweep — bound to the runtime. The ONE place in this codebase that
 * binds them, so the queue and the sweep can never disagree about the
 * environment, the importer, the clock or the logger. The `registro` (flow,
 * attempt, task id) is added per entry point.
 *
 * - `ambiente`: the process environment, passed WHOLE and live: the read switch
 *   (`AMAZON_CHAMADAS`) and the LWA pair are read from it per run, never cached
 *   at module load. `lib/` never names the process environment itself
 *   (`estrutura.test.ts`).
 * - `importador`: the step-5 seam, read from the table HERE, per run — never
 *   cached at module load and never hard-coded. Step 5 fills
 *   `DESTINO_TIPO_AMAZON.pedido` and both roots pick it up with no edit of their
 *   own; until then it is `null`, and a run DEFERS as `importador-ausente`.
 * - `increment`: a tier-0 `FieldValue`, for the park's avisos, so two producers
 *   landing together cannot lose each other's bump.
 * - `logger`: the app's ONE logger (`LOGGER_STDOUT_AMAZON`, one JSON line on
 *   stdout). Never `firebase-functions`' logger and never `console.*`
 *   (`estrutura.test.ts`).
 *
 * No `fetch` seam: the package's client uses the runtime's own, behind the read
 * switch.
 */
export function depsDeLeituraAmazon(): DepsLeituraAmazon {
  return {
    ambiente: process.env,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    importador: importadorPedidoAmazon(),
    increment: (by: number) => FieldValue.increment(by),
  };
}
