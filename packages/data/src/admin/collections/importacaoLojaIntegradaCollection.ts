import {
  SUBCOLECOES_IMPORTACAO_LI,
  detalheProdutoLiSchema,
  evidenciaOpcaoLiSchema,
  importacaoLojaIntegradaMeta,
  importacaoLojaIntegradaSchema,
  itemImportacaoLiSchema,
  paginaListagemLiSchema,
  revisaoFiscalLiSchema,
} from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `importacoesLojaIntegrada` job document of the Loja Integrada
 * product import (master-plan step 9): one document per run, created by the authed start route,
 * driven by the reads queue one slice at a time and read back by the status route. The
 * `importacaoShopeeCollection` shape.
 *
 * ⚠️ Every stamp in the document is MILLISECONDS (`iniciadoEmMs`, `atualizadoEmMs`,
 * `concluidoEmMs`).
 *
 * ⚠️ The `(integracaoId ASC, iniciadoEmMs DESC)` composite the start guard and the web's list
 * query is hand-declared in `firestore.indexes.json` and pinned by
 * `packages/schemas/src/importacaoLojaIntegrada.indexes.test.ts`: this schema has no
 * `meta.defaultQuery`, so the lint rule cannot see it, and on Firestore Enterprise a missing
 * composite full-scans and bills instead of failing.
 *
 * Admin-only / default-deny (`importacaoLojaIntegradaMeta` is not in `ALL_DOMAINS`), so there is
 * no client access and no generated rules block — and neither for the five subcollections below,
 * which no rules block matches either.
 */
export const importacaoLojaIntegradaCollection = defineAdminCollection({
  path: importacaoLojaIntegradaMeta.collectionPath,
  schema: importacaoLojaIntegradaSchema,
});

/** `importacoesLojaIntegrada/{jobId}/<sub>` — the job's own subcollection path. */
const subcolecaoDoJob = (sub: string): string =>
  `${importacaoLojaIntegradaMeta.collectionPath}/{jobId}/${sub}`;

/*
 * The job's five subcollections. Each is written only by the job's own dispatches (one at a time:
 * the reads queue runs at concurrency 1 and every dispatch checks the job's `seq`), at
 * deterministic ids — a retry overwrites its own earlier attempt. Each is read in document-key
 * order inside ONE job, so no index is declared for them.
 *
 * ⚠️ Their leaf names (`paginas`, `detalhes`, `itens`, …) are generic, so `groupQuery()` on these
 * handles would also reach any other collection of the same name. Nothing calls it: every read
 * goes through `ref(db, { jobId })`.
 */

/** `paginas/{tipo}-{offset}` — one snapshot page of the listing or of the trash list (row views). */
export const paginaImportacaoLiCollection = defineAdminCollection({
  path: subcolecaoDoJob(SUBCOLECOES_IMPORTACAO_LI.paginas),
  schema: paginaListagemLiSchema,
});

/** `detalhes/{liId}` — one product detail read by the job (the detail VIEW, never the wire body). */
export const detalheImportacaoLiCollection = defineAdminCollection({
  path: subcolecaoDoJob(SUBCOLECOES_IMPORTACAO_LI.detalhes),
  schema: detalheProdutoLiSchema,
});

/** `evidencias/{gradeId}_{opcaoId}` — the exact-SKU claims about one store option. */
export const evidenciaImportacaoLiCollection = defineAdminCollection({
  path: subcolecaoDoJob(SUBCOLECOES_IMPORTACAO_LI.evidencias),
  schema: evidenciaOpcaoLiSchema,
});

/** `itens/{liId}` — the report row of one store parent or simple product. */
export const itemImportacaoLiCollection = defineAdminCollection({
  path: subcolecaoDoJob(SUBCOLECOES_IMPORTACAO_LI.itens),
  schema: itemImportacaoLiSchema,
});

/** `revisao/{produtoId}` — the tax-review list, carried forward from job to job. */
export const revisaoFiscalImportacaoLiCollection = defineAdminCollection({
  path: subcolecaoDoJob(SUBCOLECOES_IMPORTACAO_LI.revisao),
  schema: revisaoFiscalLiSchema,
});
