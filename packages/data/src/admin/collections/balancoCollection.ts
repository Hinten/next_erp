import {
  balancoMeta,
  balancoSchema,
  movimentoBalancoMeta,
  movimentoBalancoSchema,
  relatorioBalancoMeta,
  relatorioBalancoSchema,
} from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `balanco` — the stock-count header. Read by the
 * `finalizarBalanco` callable (which takes the workflow lock inside a
 * transaction) and written by it and its task worker; those three fields
 * (`estado`, `dataFinalizado`, `finalizacao`) are server-owned, so this handle
 * is the ONLY writer of them.
 */
export const balancoCollection = defineAdminCollection({
  path: balancoMeta.collectionPath,
  schema: balancoSchema,
});

/**
 * Admin-SDK handle for `balanco/{balancoId}/movimentos` — the lançamento
 * tally. The clients write it; the finalize job only reads it, aggregating
 * `quantidade` grouped by `produtoId` over the non-error, non-removed rows.
 */
export const movimentoBalancoCollection = defineAdminCollection({
  path: movimentoBalancoMeta.collectionPath,
  schema: movimentoBalancoSchema,
});

/**
 * Admin-SDK handle for `balanco/{balancoId}/relatorios` — the sharded finalize
 * snapshot. `serverOwned`, so this handle is its only writer; the web app has a
 * read-only client handle for the report view.
 */
export const relatorioBalancoCollection = defineAdminCollection({
  path: relatorioBalancoMeta.collectionPath,
  schema: relatorioBalancoSchema,
});
