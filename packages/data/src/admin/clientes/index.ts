/**
 * Shared server-side cliente resolution. The DECISION these use lives in
 * `@delfrance/schemas` (`clienteIdentity.ts`) so the browser-side dedup screen
 * shares it; only the Firestore IO lives here.
 */
export {
  buildClienteUpdatePatch,
  findOrCreateCliente,
  type FindOrCreateClienteInput,
  type FindOrCreateClienteResult,
  type RejectedClienteCandidate,
} from './findOrCreateCliente';
