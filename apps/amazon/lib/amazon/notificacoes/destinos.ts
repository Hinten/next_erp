/**
 * The importer SEAM of the reads queue (master plan step 5, PR 5-e; plan §3
 * decision 32): task `tipo` → the importer that serves it. `pedido` is the
 * step-5 order import (`pedidos/importarPedido.ts`).
 *
 * ⚠️ Imported ONLY by the functions codebase's two composition roots —
 * `functions/src/depsLeitura.ts` (the reads queue and the reprocess sweep) and
 * `functions/src/pollPedidos.ts` (the backstop poll's importer gate) —
 * `estrutura.test.ts` pins both lists. The App Hosting receiver imports
 * `./notificacao.ts`, never this module, so no app file of its closure reaches
 * the importer (the one app file that imports the cliente resolver), names the
 * ViaCEP module or builds a CEP client: the importer imports its dependency and
 * result types FROM `./notificacao.ts` (plan §3 decision 48), and nothing there
 * imports the importer back. (The guard walks APP files and leaves packages
 * external: the ViaCEP module itself still loads there, inert, through the
 * `@delfrance/schemas` barrel.)
 *
 * Filling `pedido` opens the poll's first gate for good; the read switch
 * (`AMAZON_CHAMADAS`, unset until the window) is the only gate left, and the
 * context loader the importer calls Amazon through refuses unless it is exactly
 * `on` (D11).
 */
import { TIPO_TAREFA_AMAZON, type TipoTarefaAmazon } from '@delfrance/schemas';

import { importarPedidoAmazon } from '../pedidos/importarPedido';
import type { ImportadorPedidoAmazon } from './notificacao';

/**
 * The seam, keyed by task `tipo`.
 *
 * ⚠️ A typed TABLE whose entries may be `null`, never `const X: T = …`: a later
 * `tipo` (step 9's link job) joins it before its importer exists, and the
 * pipeline defers such a run as `importador-ausente` instead of failing to
 * compile.
 */
export const DESTINO_TIPO_AMAZON: Readonly<
  Record<TipoTarefaAmazon, ImportadorPedidoAmazon | null>
> = {
  [TIPO_TAREFA_AMAZON.pedido]: importarPedidoAmazon,
};

/** The pedido importer from the table, read per call (never cached by a root). */
export function importadorPedidoAmazon(): ImportadorPedidoAmazon | null {
  return DESTINO_TIPO_AMAZON[TIPO_TAREFA_AMAZON.pedido];
}
