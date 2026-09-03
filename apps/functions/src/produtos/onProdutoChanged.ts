import type {
  DocumentData,
  DocumentReference,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { millisToMicros, nowMicros } from '@delfrance/core/datetime';
import {
  camposEspelhadosQueMudaram,
  planejarSincronizacaoDoMembroUnico,
  produtoMeta,
  reapontarComponentesKit,
  type ComponentesKit,
  samePrecos,
  type PrecosMap,
} from '@delfrance/schemas';
import { isFailedPrecondition } from '@delfrance/data/admin';

import { getDb } from '../lib/admin';
import { resolveUsuarioOuterRef } from '../lib/authContext';
import { PRODUTO_HISTORY_ROOT } from '../lib/historyRoots';
import { buildModificationEntry, recordModification } from '../lib/modificationHistory';
import { CAMPOS_ROLLUP_KIT, planejarRollupKit, type KitRollupPayload } from './kitRollupPayload';
import {
  createKitRollupScheduler,
  isFalhaDeEnfileiramentoContivel,
  type KitRollupScheduler,
} from './kitRollupTasks';

/**
 * Unified produto modification history
 * (`produtos/{produtoId}/historicoDeModificacoes`) + the price propagation
 * this trigger has always owned. Replaces `onProdutoPrecoCustoChanged.ts`
 * (this PR): that trigger's `historicoDePrecos`/`historicoDeCusto` writes are
 * GONE — every produto write now gets one changed-fields entry in the new
 * subcollection instead — while parent→children precos propagation stays
 * byte-identical (owner decision, 2026-07-21). The deployed function's
 * identity is preserved via the aliased export in `index.ts`.
 */

/**
 * Fields whose churn is server/denormalization noise, never a meaningful edit
 * worth a history entry: embeddings, marketplace sync state, and the
 * `ultimaModificacao`/`timestamp` stamps every write already touches.
 */
export const PRODUTO_HISTORY_IGNORE_FIELDS: ReadonlyArray<string> = [
  'componentesKitKeys',
  'fotosArquivosIds',
  'integracoesComProduto',
  'marketplace',
  // Sibling of `marketplace` above and written by the same five stamps, but it
  // was missing here — so the one array generated history rows while the other
  // did not (#961). Both are legacy denorms with no query consumers; their churn
  // is never an operator edit.
  'marketplaceIds',
  'nome_embedding',
  'statusProdutosMarketplace',
  'timestamp',
  'ultimaModificacao',
];

/**
 * A variation child's `precos` is server-PROPAGATED from its parent (the
 * write below) — recording it here would echo that write back as a spurious
 * "child changed" entry, and on the child's own re-fire of this trigger would
 * make `campos` non-empty for a change nobody made by hand. `after` carries
 * `paiId` on every write except a delete, where only `before` is left.
 */
export function produtoExtraIgnores(
  before: DocumentData | undefined,
  after: DocumentData | undefined,
): ReadonlyArray<string> {
  const doc = after ?? before;
  const ignores: string[] = [];
  if (doc?.paiId != null) ignores.push('precos');
  // On a KIT the weight and box are server-DERIVED — rolled up from the
  // components by `dimensoesDoKit`, pushed in by `KitManager` on save and
  // rewritten by `recalcularDimensoesKit` whenever a component changes (#1152).
  // The produto form makes all five read-only for a kit, so a row here would
  // attribute a machine's arithmetic to whoever last touched a component.
  //
  // ⚠️ Conditional on `ehKit`, NOT added to `PRODUTO_HISTORY_IGNORE_FIELDS`: on
  // an ordinary produto these are exactly the operator edits most worth
  // auditing, since they decide what the freight quote and the NF-e declare.
  if (doc?.ehKit === true) ignores.push(...CAMPOS_ROLLUP_KIT);
  return ignores;
}

/* -------------------------------------------------------------------------- */
/*                                  I/O core                                  */
/* -------------------------------------------------------------------------- */

/** Firestore's `WriteBatch` caps at 500 ops; stay under it (mirrors
 *  `onProdutoDeleted`'s `KIT_CLEANUP_BATCH_SIZE`). */
const WRITE_CHUNK_SIZE = 450;

interface PendingWrite {
  ref: DocumentReference;
  data: DocumentData;
  mode: 'set' | 'update';
}

async function commitChunked(db: Firestore, writes: PendingWrite[]): Promise<void> {
  for (let i = 0; i < writes.length; i += WRITE_CHUNK_SIZE) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + WRITE_CHUNK_SIZE)) {
      if (write.mode === 'set') {
        batch.set(write.ref, write.data);
      } else {
        batch.update(write.ref, write.data);
      }
    }
    await batch.commit();
  }
}

/**
 * Every EXISTING variation child (`paiId == parentId`) whose `precos` map
 * differs from the parent's — server-side mirror of the removed client
 * `propagatePrecosToChildren` (`packages/data/src/produto/usecases.ts`). One
 * query, no transaction: a child edit racing this update loses (last write
 * wins), same as the client version it replaces.
 */
async function findChildrenToPropagate(
  db: Firestore,
  parentId: string,
  parentPrecos: PrecosMap,
): Promise<PendingWrite[]> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', parentId).get();
  const writes: PendingWrite[] = [];
  for (const doc of snap.docs) {
    if (doc.id === parentId) continue; // defensive: a produto can't be its own child
    const childPrecos = (doc.data().precos as PrecosMap) ?? null;
    if (!samePrecos(childPrecos, parentPrecos)) {
      writes.push({ ref: doc.ref, data: { precos: parentPrecos ?? null }, mode: 'update' });
    }
  }
  return writes;
}

/**
 * Keep a family-of-one's SOLE MEMBER in step with its parent (#1398).
 *
 * After #1398 a produto with no variations is a parent plus one child, and the
 * CHILD is the sellable unit: it owns the stock rows, it is what a pedido line
 * binds, and it is what the Mercado Livre family publishes. Its `nome`, `sku`,
 * kit composition, dimensions and categoria are a MIRROR of the parent's, copied
 * once at creation (`montarMembroUnico`). Nothing refreshed that copy — so
 * renaming a produto, changing its SKU, or editing the components of a kit left
 * the sellable half holding the old values, invisibly: the member has no screen
 * of its own, so the two could disagree indefinitely with nothing to look at.
 *
 * ⚠️ `componentesKit` is the one that costs money rather than confusion. A kit's
 * availability is `min` over its components (ADR 0014), computed from the produto
 * the surface reads — the member. An edited kit whose member kept the old map
 * advertises stock it cannot assemble, and the ML sweep sends that number.
 *
 * ## Four properties, in the order they matter
 *
 * 1. **Zero extra reads on the common path.** `camposEspelhadosQueMudaram` is
 *    pure, so a save that moved nothing mirrored — a stock edit, a photo, a
 *    price — never touches the member. Same trade `planejarRollupKit` makes
 *    above.
 * 2. **A three-way merge, never a copy.** The member is an ordinary produto and
 *    appears as a row in the Variações tab, so an operator can diverge it. A
 *    field moves only when the member still holds the parent's PREVIOUS value.
 *
 *    ⚠️ **The merge alone is NOT the ordering guard**, and an earlier version of
 *    this comment claimed it was. Value equality cannot tell "the member still
 *    holds MY before" from "the member holds a NEWER value that happens to equal
 *    my before" — and for the four mirrored BOOLEANS the value space is two, so
 *    an A→B→A sequence of parent saves delivered out of order lands the older
 *    run's value on the member and then FREEZES it there: every later toggle
 *    finds the member diverged and declines. A produto the operator had just
 *    hidden would stay `publicado` on the half that is actually sold.
 * 3. **The patch is derived from the parent as it is NOW, not from `after`.**
 *    That is what actually makes it converge. `after` is this delivery's
 *    snapshot and may already be stale; re-reading makes every concurrent run
 *    compute the SAME target, so a late-arriving older delivery agrees with the
 *    newest state instead of reverting it (rule 7 tier 0 — the race is made
 *    impossible, not detected).
 *
 *    ⚠️ `before` still comes from the delivery, and must: it is what says whether
 *    THIS write moved the field, which is how an operator's own divergence is
 *    told apart from a value the mirror itself set.
 * 4. **A `lastUpdateTime` precondition** closes the remaining window — a write
 *    landing between the member read and the member update. That is rule 7 tier
 *    1, and it is the reason this can stay plain reads + an update rather than a
 *    transaction. A losing write is CORRECT to lose: whoever won wrote either a
 *    newer parent state or an operator's own edit, and both outrank this one, so
 *    it is logged and dropped rather than retried.
 *
 * ⚠️ `precos` is deliberately NOT in the mirror — it has its own propagation
 * above, with an operator opt-out (`propagatePriceToChildren`) that folding it in
 * here would silently defeat. See `espelhoDoMembroUnico`.
 *
 * Exported for the tests: the emulator suite drives the three write outcomes,
 * and the unit suite drives the two error branches with a stub `db` — a losing
 * precondition needs a write to land BETWEEN this read and this update, which no
 * emulator test can interleave.
 *
 * @returns the member id when it was written, else `null`.
 */
export async function sincronizarMembroUnico(
  db: Firestore,
  parentId: string,
  before: DocumentData | undefined,
  after: DocumentData,
): Promise<string | null> {
  if (after.paiId != null) return null; // a child never has a sole member
  const membroId = after.filhoUnicoId;
  if (typeof membroId !== 'string' || membroId === '') return null;
  // ⚠️ Pure, and it runs BEFORE any read: this is what keeps an ordinary produto
  // save at zero extra reads.
  if (camposEspelhadosQueMudaram(before, after).length === 0) return null;

  // ⚠️ The parent as it is NOW, not `after` — see property 3. Two out-of-order
  // deliveries have to compute the same target, or the older one reverts the
  // newer. Read only after the pure gate above said something moved, so an
  // ordinary produto save still costs nothing.
  const paiSnap = await produtoCollection.ref(db, {}).doc(parentId).get();
  const paiAgora = (paiSnap.data() ?? after) as DocumentData;

  const ref = produtoCollection.ref(db, {}).doc(membroId);
  const snap = await ref.get();
  if (!snap.exists) {
    // A pointer naming a document that is gone. Loud, because every stock reader
    // resolves through it — but not thrown: this trigger does not retry, and the
    // parent's own write is already durable.
    logger.error(
      `onProdutoChanged: ${parentId}.filhoUnicoId aponta para ${membroId}, que não existe — ` +
        `o espelho do membro único não foi atualizado`,
    );
    return null;
  }

  const patch = planejarSincronizacaoDoMembroUnico(before, paiAgora, snap.data() ?? {});
  if (patch === null) return null;

  try {
    await ref.update(patch, { lastUpdateTime: snap.updateTime });
  } catch (err: unknown) {
    if (isFailedPrecondition(err)) {
      // Someone wrote the member between the read and the write. They hold a
      // newer state by definition, so losing is the right outcome — retrying
      // with the same stale precondition could only fail again.
      logger.info(`onProdutoChanged: espelho de ${membroId} ignorado — escrita concorrente venceu`);
      return null;
    }
    throw err;
  }
  return membroId;
}

/**
 * How many referencing kits one pointer move may repoint inline.
 *
 * ⚠️ Not a round number picked for tidiness. ADR 0014 measured **~2 000 kits
 * sharing one component** on the printed-shirt catalogue (`kitRollup.ts`), and
 * this sweep is tier 1 — one RPC per document, because a 400-doc `WriteBatch`
 * commits atomically and a single stale kit would fail the other 399. So the
 * fan-out is bounded rather than assumed small: past the cap the trigger stops,
 * says so loudly, and leaves the rest to the migration's re-runnable
 * `--target kits` phase, which is built for exactly this shape of work.
 *
 * The census (`audit:produto-sem-variacoes`) reports the corpus's real worst
 * fan-out. If it comes back near the ADR's number, the fix is the queued
 * `recalcularDimensoesKit` shape — the paged index
 * (`componentesKitKeys CONTAINS, __name__ ASC`) already exists — not a bigger cap.
 */
const LIMITE_DE_KITS_INLINE = 200;

/**
 * Repoint every kit that names `produtoId` (or the sole member it just stopped
 * naming) at the produto that now holds the stock.
 *
 * ## ⚠️ Why this exists at all
 *
 * The #1402 migration fixes the corpus once, and deliberately SKIPS produtos
 * that sell on Mercado Livre — publish owns those. Publish's `'adotar'` arm then
 * converts one whenever a seller publishes it, moving its available stock onto a
 * new sole member. A kit naming that produto was correct the day the migration
 * ran and breaks the day the listing goes up, with no migration left to catch it:
 * `kitEstoqueDisponivel` scores the parent 0, and the stock sweep pushes that 0
 * to ML, so the kit stops selling.
 *
 * ## ⚠️ It fires on any pointer MOVE, not just null → set
 *
 * `VariationManager` re-derives `filhoUnicoId` from the surviving child set on
 * every save, so adding a row and delete-marking the old sole member in ONE save
 * moves the pointer A → B. Gating on `before == null` misses that, and then
 * `onProdutoDeleted`'s cascade runs for A instead — whose empty-kit rule forces
 * `ehKit: false` on any kit whose only component was A. **A kit silently stops
 * being a kit.** So the outgoing member is swept too.
 *
 * ## ⚠️ `cleanupInboundKitReferences` is NOT the precedent it looks like
 *
 * That sweep runs the same `array-contains` query with an unguarded 400-doc
 * batch, and gets away with it because `findProdutoReferences` BLOCKS deleting a
 * referenced produto — so it almost always matches zero rows. This one fires
 * precisely when references exist. Hence tier 1 per document and the cap above.
 *
 * ## ⚠️ No re-entry loop
 *
 * The sweep writes other produtos' `componentesKit`; it never writes
 * `filhoUnicoId`. So the trigger re-fired by each of those writes sees no pointer
 * move and exits on the pure gate. Redelivery is idempotent for the same reason
 * the migration's phase is: `unidadeVendavel` is a fixpoint, so a second pass
 * finds `mudou: false` and writes nothing.
 *
 * @returns how many kits were repointed, and how many lost their precondition.
 */
export async function reapontarKitsQueReferenciam(
  db: Firestore,
  produtoId: string,
  before: DocumentData | undefined,
  after: DocumentData,
): Promise<{ reapontados: number; conflitos: number } | null> {
  // A child never has a sole member of its own, whatever it stores.
  if (after.paiId != null) return null;
  const novo = typeof after.filhoUnicoId === 'string' ? after.filhoUnicoId : '';
  if (novo === '') return null;
  const anterior = typeof before?.filhoUnicoId === 'string' ? before.filhoUnicoId : null;
  if (anterior === novo) return null;

  // Both ids: the parent (whose stock has just moved to `novo`) and the member it
  // stopped naming, which `onProdutoDeleted` may be about to strip out of every
  // kit rather than repoint.
  const alvos = [produtoId, ...(anterior !== null && anterior !== '' ? [anterior] : [])];
  const resolver = (id: string): string => (alvos.includes(id) ? novo : id);

  const porId = new Map<string, DocumentReference>();
  const dados = new Map<string, DocumentData>();
  const versoes = new Map<string, Timestamp>();
  for (const alvo of alvos) {
    const snap = await produtoCollection
      .ref(db, {})
      .where('componentesKitKeys', 'array-contains', alvo)
      // ⚠️ `.select()`, because Enterprise bills DATA SCANNED (root rule 1) and
      // this is the only field the rewrite reads. Unprojected, each match pulls
      // the whole produto — the `nome_embedding` vector, `fotos`, the marketplace
      // denorms — and the cap below fires AFTER the query, so the ADR 0014 ~2 000
      // case would read 2 000 full documents just to log that it wrote nothing.
      // `recalcularDimensoesKit` projects for exactly this reason.
      .select('componentesKit')
      // ⚠️ Bounds the SCAN, not just the writes. `+ 1` is what lets the cap tell
      // "exactly at the limit" from "over it" without reading the whole tail.
      .limit(LIMITE_DE_KITS_INLINE + 1)
      .get();
    for (const doc of snap.docs) {
      // A kit cannot list itself, but be defensive — `cleanupInboundKitReferences`
      // filters the same id for the same reason.
      if (doc.id === produtoId) continue;
      // ⚠️ A pointer move queries TWO ids and one kit can reference both. Keying
      // by doc id is what makes it read and written once; a plain array here would
      // write the same document twice and the second write would lose its own
      // precondition against the first.
      porId.set(doc.id, doc.ref);
      dados.set(doc.id, doc.data() ?? {});
      if (doc.updateTime) versoes.set(doc.id, doc.updateTime);
    }
  }

  if (porId.size > LIMITE_DE_KITS_INLINE) {
    logger.error(
      `onProdutoChanged: ${produtoId} é componente de mais de ${LIMITE_DE_KITS_INLINE} kit(s) — ` +
        `acima do limite para reaponte inline. NENHUM foi reapontado; rode ` +
        `\`migrate:produto-sem-variacoes --target kits\` para esse produto`,
    );
    // ⚠️ The count is a FLOOR, not a total: the query stops at the cap + 1, so
    // saying how many there really are would need the scan the cap exists to
    // avoid. The census reports the true fan-out.
    return { reapontados: 0, conflitos: porId.size };
  }

  let reapontados = 0;
  let conflitos = 0;
  for (const [id, ref] of porId) {
    const plano = reapontarComponentesKit(
      (dados.get(id) ?? {}).componentesKit as ComponentesKit | null,
      resolver,
    );
    if (!plano.mudou) continue;
    for (const colisao of plano.colisoes) {
      if (colisao.quantidadeSomada !== null) continue;
      // ⛔ `limitarEstoque` disagrees between the two entries, so there is no
      // correct sum — see `reapontarComponentesKit`. Both were left alone; a human
      // has to choose, and this is the only place that will ever say so.
      logger.error(
        `onProdutoChanged: kit ${id} tem componentes que colidem em ${colisao.alvo} com ` +
          `limitarEstoque divergente (${colisao.de.join(', ')}) — ficaram como estavam`,
      );
    }
    const versao = versoes.get(id);
    const patch = {
      componentesKit: plano.componentesKit,
      componentesKitKeys: plano.componentesKitKeys,
    };
    try {
      // ⚠️ Tier 1. The patch is derived from the document just read, and the Kit
      // tab is a live editor surface — a blind write would silently drop an
      // operator's whole component list.
      await (versao ? ref.update(patch, { lastUpdateTime: versao }) : ref.update(patch));
      reapontados += 1;
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
      conflitos += 1;
      // Losing is safe but NOT silent: the rewrite is idempotent and
      // `--target kits` is the reconciler, so the kit is recoverable — but nothing
      // else would ever mention it.
      logger.warn(
        `onProdutoChanged: kit ${id} não reapontado (escrita concorrente venceu) — ` +
          `ainda aponta para ${produtoId}`,
      );
    }
  }
  return { reapontados, conflitos };
}

/**
 * Fan the kit weight/box rollup out to a queue when — and only when — this write
 * actually moved one of the five derived fields on a produto that can be a kit
 * component. One enqueue, no Firestore reads: a component can sit in thousands
 * of kits (ADR 0014), which is work for `recalcularDimensoesKit`, not for a
 * trigger with a 60s timeout and no checkpoint.
 *
 * A failed enqueue is logged, not thrown: this trigger does not retry and there
 * is no document to park. The kits then wait for the next edit to any of their
 * components — or for the one-time backfill script.
 *
 * ⚠️ The payload is DECIDED early (from the raw before/after) but DISPATCHED
 * last, after the history row has landed. An earlier revision enqueued first,
 * which made a failed enqueue also cost the operator's audit row on a trigger
 * that never retries — so `TASKS_INVOKER_SA` missing the functions runtime SA
 * would have turned "the kits stay stale" into "the edit is also unaudited".
 */
async function enfileirarRollupDeKit(
  scheduler: KitRollupScheduler,
  produtoId: string,
  payload: KitRollupPayload | null,
): Promise<void> {
  if (payload === null) return;
  try {
    await scheduler.enqueue(payload);
  } catch (err: unknown) {
    if (isFalhaDeEnfileiramentoContivel(err)) {
      logger.error(
        `onProdutoChanged: falha ao enfileirar o rollup de kits de ${produtoId} — os kits que o ` +
          `contêm ficam desatualizados até a próxima edição de um componente: ${String(err)}`,
      );
      return;
    }
    throw err;
  }
}

/**
 * Record one modification-history entry for this produto write, then —
 * parent writes only, and only when `precos` actually changed and the parent
 * didn't opt out — propagate the new map to every existing variation child.
 * Exported (I/O core) for the emulator suite; the trigger below wraps it.
 *
 * A produto DELETE (`after === undefined`) writes NO entry:
 * `onProdutoDeleted`'s subtree walk sweeps everything below the produto — including
 * `historicoDeModificacoes` — so a delete-time entry would be either swept a
 * moment later or orphaned outright (owner decision, 2026-07-21).
 */
export async function recordProdutoModificationAndPropagate(
  db: Firestore,
  produtoId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  eventId: string,
  /**
   * MICROSECONDS since epoch (`microsSinceEpoch` convention) to stamp on the
   * entry — derived from the CloudEvent's `event.time`, NOT `Date.now()`: a
   * redelivered event must rewrite its deterministic doc id with IDENTICAL
   * content, and a wall-clock timestamp would differ per delivery (Copilot
   * review, PR #609).
   */
  eventTimeMicros: number,
  /**
   * Resolved acting user (`documents/usuarios/<uid>`) or `null` for an
   * Admin-SDK write. Threaded in rather than resolved here so this core stays
   * pure and drivable from the emulator suite.
   */
  usuarioOuterRef: string | null = null,
  /**
   * Enqueue seam for the kit weight/box rollup (#1152) — threaded in so the
   * emulator suite and the unit tests can record enqueues instead of reaching
   * Cloud Tasks.
   */
  kitScheduler: KitRollupScheduler = createKitRollupScheduler(),
): Promise<void> {
  if (after === undefined) return; // produto delete — no entry (see doc comment)

  // ⚠️ DECIDED here, from the RAW before/after rather than from `entry.campos`.
  // A produto whose weight or box changed must fan out to the kits containing
  // it even if some future ignore-list edit made that change invisible to the
  // history — the two decisions are deliberately decoupled. `planejarRollupKit`
  // is pure, so an ordinary produto save still costs ZERO extra reads here.
  // The DISPATCH waits until the bottom: see `enfileirarRollupDeKit`.
  const rollup = planejarRollupKit(produtoId, before, after);

  const entry = buildModificationEntry({
    before,
    after,
    ignore: [...PRODUTO_HISTORY_IGNORE_FIELDS, ...produtoExtraIgnores(before, after)],
    path: `produtos/${produtoId}`,
    subcolecao: null,
    docId: produtoId,
    eventId,
    eventTimeMicros,
    usuarioOuterRef,
  });

  // An empty diff writes no entry and propagates nothing — but it must NOT skip
  // the rollup below, which is decided independently.
  if (entry !== null) {
    await recordModification(db, PRODUTO_HISTORY_ROOT, produtoId, entry);

    // Propagation is gated on the entry's `campos` — never on custo alone, a
    // custo edit never touches a child's precos — AND on the opt-out field.
    // `!== false` treats a missing field (every produto written before this
    // field existed) the same as the schema default `true`. Variation children
    // never reach here on their own write (their `precos` diff is suppressed by
    // `produtoExtraIgnores`, so `entry.campos` never contains it), but the
    // `paiId == null` check stays as defense-in-depth.
    const shouldPropagate =
      after.paiId == null &&
      entry.campos.includes('precos') &&
      after.propagatePriceToChildren !== false;
    const childWrites = shouldPropagate
      ? await findChildrenToPropagate(db, produtoId, (after.precos as PrecosMap) ?? null)
      : [];
    if (childWrites.length > 0) {
      await commitChunked(db, childWrites);
    }

    logger.info(
      `onProdutoChanged: ${produtoId} → entry ${entry.eventId} (${entry.campos.join(', ')}), ` +
        `${childWrites.length} filho(s) propagado(s)`,
    );
  }

  // Dispatched before the mirror below, and that order is the point: a failed
  // enqueue must not cost the history row above, and the mirror must not cost the
  // enqueue. See the mirror's own note.
  await enfileirarRollupDeKit(kitScheduler, produtoId, rollup);

  // ⚠️ LAST, and OUTSIDE the `entry !== null` block.
  //
  // Outside, because the mirror is decided from the raw before/after exactly as
  // the rollup is — an ignore-list edit that hides a field from the history must
  // not stop the sellable half of the produto from following it.
  //
  // ⛔ Last, because `sincronizarMembroUnico` RETHROWS everything that is not
  // `FAILED_PRECONDITION` (rule 6). Placed above the enqueue, a transient
  // `UNAVAILABLE` from either read, or a `NOT_FOUND` from a member deleted between
  // the read and the update, would propagate out of a handler that does not
  // retry — and the kit rollup enqueue would simply be lost, leaving every kit
  // containing this produto with a stale weight and box until someone edits
  // another component. A wrong freight quote is exactly the harm #1152 was filed
  // on, and `enfileirarRollupDeKit` was moved last once already for the mirror
  // image of this reason.
  //
  // ⚠️ Still below the precos propagation, which is what it needs: that write is
  // inside the `entry !== null` block above either way, so the member read here
  // sees it rather than racing it.
  const membroSincronizado = await sincronizarMembroUnico(db, produtoId, before, after);
  if (membroSincronizado !== null) {
    logger.info(`onProdutoChanged: ${produtoId} → espelho do membro único ${membroSincronizado}`);
  }

  // ⚠️ LAST, below the mirror, and for the same reason the mirror sits below the
  // enqueue: this one rethrows anything that is not `FAILED_PRECONDITION` (rule
  // 6), and a handler that does not retry must not lose the work above to a
  // transient `UNAVAILABLE` from a query this sweep makes.
  //
  // It is also the only piece here that writes OTHER produtos, so running it last
  // means every effect on THIS produto has already landed.
  const kitsReapontados = await reapontarKitsQueReferenciam(db, produtoId, before, after);
  if (kitsReapontados !== null && kitsReapontados.reapontados > 0) {
    logger.info(
      `onProdutoChanged: ${produtoId} → ${kitsReapontados.reapontados} kit(s) reapontado(s) ` +
        `para o membro único`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                Entry point                                 */
/* -------------------------------------------------------------------------- */

/**
 * The produto modification-history + propagation trigger. Fires on EVERY
 * produto write (create/update/delete); the guards above make a delete or a
 * write that changes nothing outside the ignore list a zero-write no-op —
 * only a real change writes the entry, and only a precos change (never custo
 * alone) performs the one extra read that finds children to propagate to.
 * Targets the NAMED `default` database (gotcha #8).
 */
export const onProdutoChanged = onDocumentWrittenWithAuthContext(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { produtoId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    // `event.time` is the CloudEvent occurrence time — stable across
    // redeliveries of the SAME event, so the deterministic entry doc stays
    // content-identical on retries. Stored as MICROSECONDS since epoch
    // (`microsSinceEpoch`, the repo's datetime standard).
    const eventTimeMillis = Date.parse(event.time);
    await recordProdutoModificationAndPropagate(
      getDb(),
      produtoId,
      before,
      after,
      event.id,
      Number.isNaN(eventTimeMillis) ? nowMicros() : millisToMicros(eventTimeMillis),
      resolveUsuarioOuterRef(event.authType, event.authId),
    );
  },
);
