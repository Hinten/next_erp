import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore';
import { millisToMicros, nowMicros } from '@delfrance/core/datetime';
import { operacaoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { resolveUsuarioOuterRef } from '../lib/authContext';
import { OPERACAO_HISTORY_ROOT } from '../lib/historyRoots';
import { buildModificationEntry, recordModification } from '../lib/modificationHistory';

/**
 * Fields whose churn is a stamp, never an operator edit — same rule as every
 * other root (`PRODUTO_HISTORY_IGNORE_FIELDS` / `PEDIDO_HISTORY_IGNORE_FIELDS`):
 * a field is ignored iff no interactive editor in this app can author it.
 * `operacaoSchema` has no denormalization/sync fields of the
 * `CAMPOS_ESTOQUE_SYNC` kind to guard against.
 */
export const OPERACAO_HISTORY_IGNORE_FIELDS: ReadonlyArray<string> = [
  'timestamp',
  'ultimaModificacao',
];

/**
 * I/O core behind {@link onOperacaoChanged} — split out (same shape as
 * produto's `recordProdutoModificationAndPropagate`) so the emulator suite can
 * drive it directly without waiting on a real trigger delivery.
 *
 * Like produto (and unlike pedido/cliente), an operação delete is NOT
 * recorded: `onOperacaoDeleted` sweeps the operação's WHOLE subtree via
 * `deleteDocumentSubtree`'s `listCollections()` discovery, so a row written for
 * the operação's own delete would be swept a moment later (or orphaned, if the
 * two triggers race). Returning early on delete — before even building the
 * diff — is the same guard `onProdutoChanged` uses for the same reason, and it
 * costs nothing extra on the far more common create/update path (no
 * parent-exists read, unlike the sibling `regras` source, which genuinely needs
 * one because it observes a DIFFERENT document than the one the cascade race is
 * about).
 */
export async function recordOperacaoModification(
  db: Firestore,
  operacaoId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  eventId: string,
  /** MICROSECONDS since epoch (`microsSinceEpoch` convention). */
  eventTimeMicros: number,
  usuarioOuterRef: string | null = null,
): Promise<void> {
  if (after === undefined) return; // operação delete — swept by onOperacaoDeleted, no entry

  const entry = buildModificationEntry({
    before,
    after,
    ignore: OPERACAO_HISTORY_IGNORE_FIELDS,
    path: `operacao/${operacaoId}`,
    subcolecao: null,
    docId: operacaoId,
    eventId,
    eventTimeMicros,
    usuarioOuterRef,
  });
  if (entry === null) return;

  await recordModification(db, OPERACAO_HISTORY_ROOT, operacaoId, entry);
}

/**
 * `operacao/{operacaoId}` modification-history trigger — the operação
 * DOCUMENT's own entry. Rows land in
 * `operacao/{operacaoId}/historicoDeModificacoes` (`subcolecao: null`); the
 * covered `regras` subcollection rides its own trigger
 * (`onRegraImpostoChanged`), tagging its rows `subcolecao: 'regras'`, so the
 * whole operação reads as ONE chronological feed — the same shape produto and
 * pedido already use.
 *
 * Exported for the offline + emulator suites; targets the NAMED `default`
 * database (gotcha #8).
 */
export const onOperacaoChanged = onDocumentWrittenWithAuthContext(
  {
    document: `${operacaoMeta.collectionPath}/{operacaoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { operacaoId } = event.params as { operacaoId: string };
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // `event.time` is the CloudEvent occurrence time — stable across
    // redeliveries of the SAME event, so the deterministic entry doc stays
    // content-identical on retries. Stored as MICROSECONDS since epoch
    // (`microsSinceEpoch`, the repo's datetime standard).
    const eventTimeMillis = Date.parse(event.time);
    await recordOperacaoModification(
      getDb(),
      operacaoId,
      before,
      after,
      event.id,
      Number.isNaN(eventTimeMillis) ? nowMicros() : millisToMicros(eventTimeMillis),
      resolveUsuarioOuterRef(event.authType, event.authId),
    );
  },
);
