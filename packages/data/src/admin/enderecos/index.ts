/**
 * Shared server-side endereço IO. The endereço BUILDING (`buildEnderecoForcado`,
 * `recoverEnderecoFromCep`, the NF-e clamps) lives in `@delfrance/schemas`, so
 * the browser shares it; only the Firestore write and the content-addressed id
 * live here.
 */
export { ensureEndereco, makeEnderecoId, type EnderecoImportFields } from './ensureEndereco';
