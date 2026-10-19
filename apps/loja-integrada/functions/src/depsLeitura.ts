import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { createViaCepClient } from '@delfrance/core/cep';

import {
  type DepsTarefaLi,
  type RegistroTarefaLi,
  importadorPedidoLi,
} from '../../lib/lojaIntegrada/notificacoes/notificacao';

/**
 * The dependencies of one READ run — a reads-queue dispatch, or one tick of the
 * reprocess sweep — bound to the runtime. The ONE place in this codebase that
 * binds them, so the queue and the sweep can never disagree about the
 * environment, the importer or the clock.
 *
 * - `ambiente`: the process environment, passed whole and read by the context
 *   loader ONCE, as its first statement, for the read switch only. `lib/` never
 *   names the process environment itself (`estrutura.test.ts`).
 * - `importador`: the step-5 seam, read from the table HERE, per run — never
 *   cached at module load and never hard-coded. Step 5 filled
 *   `DESTINO_TIPO_LI.pedido` with the order import and both roots picked it up
 *   with no edit of their own. The read switch still stops every run before it
 *   (the context refuses first), so nothing calls Loja Integrada until the
 *   window sets it.
 * - `increment`: a tier-0 `FieldValue`, for the reconexão aviso's counter, so two
 *   producers landing together cannot lose each other's bump.
 * - `esperar`: the pacer's sleep (2 000 ms before every Loja Integrada call).
 * - `arrayUnion`: a tier-1 `FieldValue`, for the step-5 importer's freight `mapa`
 *   registration (step 20's helper), so the stored rows are never rewritten.
 * - `viaCep`: the importer's CEP recovery, ONE process-wide client so its memo
 *   (and its in-flight dedup) spans every import this instance serves. It is
 *   only ever called after a Loja Integrada read, so it sits behind the same
 *   read switch.
 *
 * No `fetch` seam: the package's client uses the runtime's own.
 */
/** The process-wide CEP client (header). */
const VIA_CEP = createViaCepClient();

export function depsDeLeituraLi(registro: RegistroTarefaLi): DepsTarefaLi {
  return {
    ambiente: process.env,
    importador: importadorPedidoLi(),
    increment: (by: number) => FieldValue.increment(by),
    arrayUnion: (...elementos: unknown[]) => FieldValue.arrayUnion(...elementos),
    viaCep: VIA_CEP,
    agoraMs: () => Date.now(),
    esperar: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    logger,
    registro,
  };
}
