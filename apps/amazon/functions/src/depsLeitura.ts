import { FieldValue } from 'firebase-admin/firestore';
import { createViaCepClient } from '@delfrance/core/cep';

import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import { LWA_CLIENT_SECRET_ENV } from '../../lib/amazon/env';
import { importadorPedidoAmazon } from '../../lib/amazon/notificacoes/destinos';
import type { DepsLeituraAmazon } from '../../lib/amazon/notificacoes/notificacao';

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
 * The process-wide CEP client the order import recovers an unknown UF with —
 * ONE per instance, so its memo (and its in-flight dedup) spans every import
 * the instance serves. ⚠️ This is the ONLY file of the app that names the
 * ViaCEP module (`estrutura.test.ts`): `lib/` takes it through the structural
 * port `BuscadorCepAmazon`, so no app file of the App Hosting receiver's
 * closure names that module or builds a client. (The module itself still loads
 * there, inert, through the `@delfrance/schemas` barrel, which the guard leaves
 * external.) It is only ever called after an Amazon read, so it sits behind the
 * read switch too.
 */
const VIA_CEP = createViaCepClient();

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
 * - `importador`: the step-5 seam (`lib/amazon/notificacoes/destinos.ts`), read
 *   from the table HERE, per run — never cached at module load and never
 *   hard-coded. Step 5 filled `DESTINO_TIPO_AMAZON.pedido` with the order
 *   import; the read switch still stops every run before it (the pipeline
 *   checks it first, the context loader again), so nothing calls Amazon until
 *   the window sets it.
 * - `viaCep`: {@link VIA_CEP}, the importer's CEP recovery.
 * - `increment`: a tier-0 `FieldValue`, for every aviso counter a run bumps —
 *   the park's and the importer's — so two producers landing together cannot
 *   lose each other's bump.
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
    viaCep: VIA_CEP,
    increment: (by: number) => FieldValue.increment(by),
  };
}
