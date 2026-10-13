import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

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
 *   cached at module load and never hard-coded. Step 5 fills
 *   `DESTINO_TIPO_LI.pedido` and both roots pick it up with no edit of their own;
 *   until then it is `null`, and a run parks as `importador-ausente`.
 * - `increment`: a tier-0 `FieldValue`, for the reconexão aviso's counter, so two
 *   producers landing together cannot lose each other's bump.
 * - `esperar`: the pacer's sleep (2 000 ms before every Loja Integrada call).
 *
 * No `fetch` seam: the package's client uses the runtime's own.
 */
export function depsDeLeituraLi(registro: RegistroTarefaLi): DepsTarefaLi {
  return {
    ambiente: process.env,
    importador: importadorPedidoLi(),
    increment: (by: number) => FieldValue.increment(by),
    agoraMs: () => Date.now(),
    esperar: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    logger,
    registro,
  };
}
