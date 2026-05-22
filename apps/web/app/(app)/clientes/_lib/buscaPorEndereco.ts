import type { Firestore } from 'firebase/firestore';
// Side-effect: registers `db.pipeline()` via module augmentation. Must come
// before any use of `db.pipeline`.
import 'firebase/firestore/pipelines';
import { execute, or, regexContains } from 'firebase/firestore/pipelines';
import {
  buildSimilarityPattern,
  isPipelineSupported,
} from '@delfrance/data/pipeline-queries';

/** Address fields scanned by the "find a client by address" search. */
const ENDERECO_SEARCH_FIELDS = [
  'logradouro',
  'bairro',
  'cidade',
  'complemento',
  'cep',
];

/**
 * Max number of distinct clients returned. Bounded by Firestore's 30-value
 * cap on `where(documentId(), 'in', [...])`, which the caller uses to narrow
 * the cliente list to the matches.
 */
export const ENDERECO_SEARCH_LIMIT = 30;

/** Endereço documents scanned before de-duplicating down to clients. */
const ENDERECO_SCAN_LIMIT = 200;

/**
 * Thrown when the installed Firebase SDK does not expose the Pipelines API,
 * which the accent/case-insensitive address search depends on.
 */
export class EnderecoSearchUnsupportedError extends Error {
  constructor() {
    super('A busca por endereço requer a API de Pipelines do Firestore.');
    this.name = 'EnderecoSearchUnsupportedError';
  }
}

/**
 * Find the ids of clients that own an address matching `term`. Runs a
 * Firestore Pipelines collection-group query over every `enderecos`
 * subcollection, matching `term` (accent/case-insensitive) against the
 * address fields, then recovers each match's parent `clienteId`.
 *
 * Returns at most `ENDERECO_SEARCH_LIMIT` distinct ids. An empty/whitespace
 * term yields `[]`.
 */
export async function searchClienteIdsByEndereco(
  db: Firestore,
  term: string,
): Promise<string[]> {
  const pattern = buildSimilarityPattern(term);
  if (!pattern) return [];
  if (!isPipelineSupported(db)) throw new EnderecoSearchUnsupportedError();

  const perField = ENDERECO_SEARCH_FIELDS.map((f) => regexContains(f, pattern));
  const matchExpr =
    perField.length === 1
      ? perField[0]!
      : or(perField[0]!, perField[1]!, ...perField.slice(2));

  // Pipelines are one-shot — run via the standalone `execute()`; the
  // `Pipeline` object itself has no `.execute()` method.
  const pipeline = db
    .pipeline()
    .collectionGroup('enderecos')
    .where(matchExpr)
    .limit(ENDERECO_SCAN_LIMIT);
  const snapshot = await execute(pipeline);

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const result of snapshot.results) {
    // ref: endereco doc → parent: enderecos collection → parent: cliente doc.
    const clienteId = result.ref?.parent?.parent?.id;
    if (!clienteId || seen.has(clienteId)) continue;
    seen.add(clienteId);
    ids.push(clienteId);
    if (ids.length >= ENDERECO_SEARCH_LIMIT) break;
  }
  return ids;
}
