/**
 * Shared server-side cliente resolution. The DECISION these use lives in
 * `@delfrance/schemas` (`clienteIdentity.ts`) so the browser-side dedup screen
 * shares it; only the Firestore IO lives here.
 */
export {
  buildClienteUpdatePatch,
  ClienteSemIdentidadeForteError,
  findOrCreateCliente,
  type FindOrCreateClienteInput,
  type FindOrCreateClienteResult,
  type RejectedClienteCandidate,
} from './findOrCreateCliente';
export { otherOwnerOfMlId } from './otherOwnerOfMlId';
// The side index's id and the document fold, for a READ of who owns a document
// before a write (`apps/shopee`'s test buyer mode). Exported rather than
// re-derived: a forked digest addresses a different index row and still works.
export { clienteIdentidadeId, documentoNormalizado } from './clienteIdentidade';
