/**
 * Plain shape of a `lixeira` entry. Mirrors `lixeiraSchema` from
 * `@delfrance/schemas` — kept as a local interface so the runtime bundle
 * carries no workspace dependency. The unit test asserts that what
 * `buildLixeiraEntry` produces still parses against the real schema.
 */
export interface LixeiraEntry {
  collectionPath: string;
  docId: string;
  label: string | null;
  data: Record<string, unknown>;
  deletedAt: string;
  deletedBy: string | null;
}

export interface BuildLixeiraEntryParams {
  collectionPath: string;
  docId: string;
  /** Snapshot of the document as it was right before deletion. */
  data: Record<string, unknown>;
  /** Uid of the user who deleted it, or null when unattributed. */
  deletedBy: string | null;
  /** ISO timestamp; defaults to now. Injectable so the unit test is stable. */
  deletedAt?: string;
}

/**
 * Build the `lixeira` document for a deleted record. Pure — no Firestore I/O —
 * so it can be unit tested without a deployed trigger or emulator.
 *
 * `label` is the deleted document's `nome` when it is a string (the
 * human-friendly name shown in the recovery list); otherwise null.
 */
export function buildLixeiraEntry(params: BuildLixeiraEntryParams): LixeiraEntry {
  const nome = params.data.nome;
  return {
    collectionPath: params.collectionPath,
    docId: params.docId,
    label: typeof nome === 'string' ? nome : null,
    data: params.data,
    deletedAt: params.deletedAt ?? new Date().toISOString(),
    deletedBy: params.deletedBy,
  };
}
