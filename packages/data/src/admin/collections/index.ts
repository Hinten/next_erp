/**
 * Canonical registry of Admin-SDK collection handles. Every
 * `defineAdminCollection()` instance lives here (one file per collection) so
 * server apps import a ready-made, schema-validated handle instead of
 * re-declaring one. Add a new handle by dropping a `<domain>Collection.ts`
 * file alongside these and re-exporting it below.
 *
 * Defining a handle in app code instead is flagged by the
 * `delfrance/no-inline-admin-collection` ESLint rule (warn).
 */
export { nfev4Collection } from './nfev4Collection';
export { enviNfeMsgCollection } from './enviNfeMsgCollection';
export { nfeConfigCollection } from './nfeConfigCollection';
export { certificadoSecretoCollection } from './certificadoSecretoCollection';
export { filialCollection } from './filialCollection';
export { inutNumeracaoCollection } from './inutNumeracaoCollection';
export { cartaCorrecaoCollection } from './cartaCorrecaoCollection';
export { cargoCollection } from './cargoCollection';
export { usuarioCollection } from './usuarioCollection';
export { arquivoCollection } from './arquivoCollection';
export { produtoCollection } from './produtoCollection';
export { estoqueCollection } from './estoqueCollection';
export { historicoEstoqueCollection } from './historicoEstoqueCollection';
export { tabelaDeMedidasCollection } from './tabelaDeMedidasCollection';
export { intFreteCollection } from './intFreteCollection';
export { tokenMelEnvCollection } from './tokenMelEnvCollection';
export { integracaoCollection } from './integracaoCollection';
export { credenciaisIntegracaoCollection } from './credenciaisIntegracaoCollection';
export { tokenDuravelCollection } from './tokenDuravelCollection';
export { pedidoCollection } from './pedidoCollection';
