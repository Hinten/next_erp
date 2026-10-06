/**
 * The ONE Firestore write of a Mercado Livre claim's incidente (#1772) — the
 * doc at `pedidos/{pedidoId}/incidentes/<makeIncidenteIdClaim>`, created or
 * refreshed in a single `db.runTransaction`. Class **C**; the inventory entry is
 * in `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 *
 * ## Why it exists
 *
 * The importer used to `get()` the incidente and then `merge()` ML's state into
 * it — outside any transaction and with no clock. ML fans one change out over
 * several deliveries (`claims` + `claims_actions` + `/actions-history`), the
 * notification sweep re-drives hours-old payloads and Cloud Tasks retries, so
 * two workers holding different snapshots of the same claim are ordinary. When
 * the OLDER one landed last it REOPENED a closed claim, and
 * `onIncidenteBloqueioSync` re-blocked despacho / NF-e / finalizar on a pedido
 * ML had already settled. Shopee step 17's `devolucaoTx.ts` is the template.
 *
 * ## The race class — **C**, and the guard
 *
 * The {@link IncidenteClaimMapeado} is built OUTSIDE the callback from the
 * claim `getClaim` returned, and more ML I/O (`getClaimReason`, possibly a whole
 * order import) sits between that read and this write — so it is re-applied
 * verbatim on an OCC retry. The named guard, ADR 0011 tier 2, in
 * **microseconds**: the incidente's top-level `relogioProvedorUs` — the claim's
 * `last_updated ?? date_created`, converted ONCE by `relogioDaClaimUs` in
 * `claimMapping.ts` (this module converts nothing). Re-derived from the
 * callback's own `tx.get`:
 *
 *  - incoming OLDER than stored ⇒ `ignorado-obsoleto`, ZERO writes — a stale
 *    snapshot neither reopens nor closes the claim;
 *  - EQUAL ⇒ write only when the content differs. ML's stamps carry `.000`
 *    milliseconds in every sample, so one change fanned out over three topics,
 *    or two changes inside one second, share a stamp — and ML does not always
 *    move `last_updated` at all (the conversa gate's `>=` exists for that). A
 *    strict `>` could never converge on the second change;
 *  - NEWER ⇒ write, and the watermark ALWAYS advances: the content patch when it
 *    differs, `{ relogioProvedorUs, ultimaModificacao }` alone when it does not
 *    (`relogio-avancado`) — which files no history row, because
 *    `onIncidenteChanged` ignores both fields;
 *  - a stored watermark that is absent or not a finite number reads as OLDER.
 *    That is every incidente the Flutter app imported. It is safe because the
 *    importer always re-fetches the LIVE claim and the Flutter app is switched
 *    off at the cutover (root `CLAUDE.md` rule 8), so a delivery is at least as
 *    new as anything legacy wrote; two first deliveries racing an absent stamp
 *    are ordered by this transaction (the loser re-reads the winner's stamp).
 *    The first delivery per claim stamps it — no backfill;
 *  - an incoming clock that is `null` (neither stamp parses — `date_created` is
 *    required on the wire, so this is near-impossible) cannot be ordered: it is
 *    dropped against a stored watermark and applied, without stamping one, when
 *    none is stored. Not a throw — a deterministic throw is a retry poison-pill.
 *
 * ⚠️ **`ultimaModificacao` is NOT the guard, and must never become it.** The
 * web editor stamps WALL-CLOCK µs there on every operator save
 * (`apps/web/lib/pedidos/saveIncidenteEdit.ts`), so it reads as permanently
 * newer than the wire — the freeze the conversa's `ultima_modificacao` gate
 * suffered before it moved to a provider clock. This module only WRITES it, for
 * display, and never reads it.
 *
 * ⚠️ The field is shared, not copied: Shopee's return importer writes the same
 * `relogioProvedorUs`, in the same unit, on the same collection — one name, one
 * meaning. It stays an undeclared passthrough key of `incidenteSchema`, read RAW
 * here: only the two importers ever stamp it, always in µs, so there is no
 * legacy unit to tolerate.
 *
 * ## What is written
 *
 *  - an absent incidente is `tx.create` of the full document — never `tx.set`,
 *    so a concurrent create aborts and the retry re-decides against the winner;
 *  - an update writes ONLY the importer-owned keys — the null-coalesced
 *    `ConteudoIncidenteClaim` (`claimMapping.ts`) plus `ultimaModificacao` / the watermark —
 *    through `tx.set(…, { merge: true })`. That is the deep-merge
 *    `incidenteCollection.merge` always did, so a stored resolução keeps any key
 *    the importer does not emit exactly as before; step 17's `tx.update` would
 *    replace the whole `resolucao` map. Operator turf — `origem`, `tipo`,
 *    `motivoDoIncidente`, `comentarios`, `timestamp` and the server-owned
 *    `overrideBloqueio` — is never written after the create.
 *
 * ⚠️ "Same content" is compared FIELD BY FIELD and strictly, with no generic
 * deep-equal (#1372): `===` on `claimStatus` / `claimStage` / `entregue`, and
 * `resolucao` over exactly the five keys `buildResolucao` emits. Only the keys
 * the delivery would WRITE are compared, so a null-coalesced key is "unchanged"
 * by construction. A difference the comparison cannot see would be dropped on an
 * equal clock — which is why it covers every key the patch carries, and why
 * `claimIncidenteTx.test.ts` pins a near-miss for each.
 *
 * There is deliberately no in-transaction PEDIDO read (step 17 has one): the
 * importer resolved the pedido moments earlier, and putting it in the read set
 * would make every concurrent pedido write abort this transaction.
 *
 * The decision AND the exact payload are the pure
 * {@link preverIncidenteClaim}; nothing in it writes, reads a clock or logs —
 * the importer's warn line for a dropped snapshot sits OUTSIDE the callback an
 * OCC retry re-runs.
 */
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import { incidenteCollection } from '@delfrance/data/admin/collections';

import type { IncidenteClaimMapeado } from './claimMapping';

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

/** What one claim delivery did to its incidente. */
export type AcaoIncidenteClaim =
  | 'criado'
  | 'atualizado'
  | 'relogio-avancado'
  | 'ignorado-obsoleto'
  | 'ignorado-sem-mudanca';

/**
 * What {@link preverIncidenteClaim} decided about ONE stored incidente.
 *
 * ⚠️ It carries the PAYLOAD itself — already through `incidenteCollection.parse`
 * (create) or `.parseMerge` (update) — so a test asserts the bytes a delivery
 * writes. `criado` ⇒ `tx.create`; every other non-null patch ⇒ a merge-set.
 */
export interface PrevisaoIncidenteClaim {
  readonly acao: AcaoIncidenteClaim;
  /** `null` on every zero-write outcome. */
  readonly patch: Record<string, unknown> | null;
  /** The watermark this transaction READ (`null` when absent) — for the log line. */
  readonly relogioArmazenadoUs: number | null;
}

export interface SalvarIncidenteClaimArgs {
  readonly pedidoId: string;
  /** `makeIncidenteIdClaim(...)`, computed by the caller. */
  readonly incidenteId: string;
  readonly mapeado: IncidenteClaimMapeado;
}

/* -------------------------------------------------------------------------- */
/*                                 raw readers                                 */
/* -------------------------------------------------------------------------- */

/** A watermark worth comparing, or `null` — anything else reads as absent. */
function relogioUtilizavel(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/** The importer-owned keys, in a FIXED list — never the patch's own key set. */
const CAMPOS_ESCALARES = ['claimStatus', 'claimStage', 'entregue'] as const;

/** Exactly what `buildResolucao` emits. A key added there must be added here. */
const CAMPOS_RESOLUCAO = ['data', 'tipo', 'comentarios', 'valor', 'frete'] as const;

/**
 * Does the stored resolução already hold what this delivery would write?
 *
 * `null` and an absent key are the same stored fact. `frete` compares by
 * identity: the importer only ever emits `null` there, so a stored frete object
 * reads as DIFFERENT — the safe direction, since the merge would overwrite it.
 */
function mesmaResolucao(armazenada: unknown, entrante: Record<string, unknown>): boolean {
  if (armazenada === null || typeof armazenada !== 'object' || Array.isArray(armazenada)) {
    return false;
  }
  const raw = armazenada as Record<string, unknown>;
  return CAMPOS_RESOLUCAO.every((campo) => (raw[campo] ?? null) === (entrante[campo] ?? null));
}

/**
 * Would writing `conteudo` change the stored incidente? Only the keys PRESENT
 * in `conteudo` are compared — a null-coalesced key is not written, so it
 * cannot differ.
 */
function mesmoConteudo(raw: Record<string, unknown>, conteudo: Record<string, unknown>): boolean {
  for (const campo of CAMPOS_ESCALARES) {
    if (!Object.hasOwn(conteudo, campo)) continue;
    if ((raw[campo] ?? null) !== conteudo[campo]) return false;
  }
  if (Object.hasOwn(conteudo, 'resolucao')) {
    const resolucao = conteudo.resolucao as Record<string, unknown>;
    if (!mesmaResolucao(raw.resolucao, resolucao)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*                          the decision AND the patch                         */
/* -------------------------------------------------------------------------- */

/**
 * The whole incidente DECISION, as a pure function of the stored document.
 *
 * `rawIncidente` is `undefined` when the incidente does not exist. The
 * transaction below runs this on its own `tx.get` snapshot; nothing here
 * writes, reads a clock or touches the network.
 */
export function preverIncidenteClaim(
  rawIncidente: Record<string, unknown> | undefined,
  mapeado: IncidenteClaimMapeado,
): PrevisaoIncidenteClaim {
  const entranteUs = relogioUtilizavel(mapeado.relogioProvedorUs);
  const comRelogio = entranteUs !== null ? { relogioProvedorUs: entranteUs } : {};
  const comUltimaModificacao =
    mapeado.ultimaModificacaoUs !== null ? { ultimaModificacao: mapeado.ultimaModificacaoUs } : {};

  /* ------------------------------ absent ⇒ create --------------------------- */
  if (rawIncidente === undefined) {
    return {
      acao: 'criado',
      patch: incidenteCollection.parse({ ...mapeado.documento, ...comRelogio }) as Record<
        string,
        unknown
      >,
      relogioArmazenadoUs: null,
    };
  }

  /* ------------------------------- the guard -------------------------------- */
  const armazenadoUs = relogioUtilizavel(rawIncidente.relogioProvedorUs);
  // A clockless delivery cannot be ordered against a stored watermark, so it
  // loses to one — exactly like an older stamp.
  if (armazenadoUs !== null && (entranteUs === null || entranteUs < armazenadoUs)) {
    return { acao: 'ignorado-obsoleto', patch: null, relogioArmazenadoUs: armazenadoUs };
  }

  // The content through the SAME parse the write uses, so the comparison and
  // the bytes written are one shape.
  const conteudo = incidenteCollection.parseMerge({ ...mapeado.conteudo }) as Record<
    string,
    unknown
  >;
  const maisNovo = entranteUs !== null && (armazenadoUs === null || entranteUs > armazenadoUs);

  if (mesmoConteudo(rawIncidente, conteudo)) {
    if (!maisNovo) {
      return { acao: 'ignorado-sem-mudanca', patch: null, relogioArmazenadoUs: armazenadoUs };
    }
    // Newer clock, same content: advance the watermark and NOTHING else, so the
    // history trigger (both fields in its `ignoreFields`) files no row.
    return {
      acao: 'relogio-avancado',
      patch: incidenteCollection.parseMerge({ ...comUltimaModificacao, ...comRelogio }) as Record<
        string,
        unknown
      >,
      relogioArmazenadoUs: armazenadoUs,
    };
  }

  /* --------------------- the content changed ⇒ the patch -------------------- */
  return {
    acao: 'atualizado',
    // ⚠️ The importer-owned keys and NOTHING else — see the module header.
    patch: incidenteCollection.parseMerge({
      ...conteudo,
      ...comUltimaModificacao,
      ...comRelogio,
    }) as Record<string, unknown>,
    relogioArmazenadoUs: armazenadoUs,
  };
}

/* -------------------------------------------------------------------------- */
/*                               the transaction                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply ONE claim delivery to ONE incidente. Class **C** — see the module
 * header and the entry in
 * `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 */
export async function salvarIncidenteClaim(
  db: Firestore,
  args: SalvarIncidenteClaimArgs,
): Promise<PrevisaoIncidenteClaim> {
  const { pedidoId, incidenteId, mapeado } = args;
  return db.runTransaction(async (tx: Transaction) => {
    const ref = incidenteCollection.docRef(db, { pedidoId }, incidenteId);
    const snap = await tx.get(ref);
    // RAW, deliberately not `parseRead`: the decision reads its own fields
    // through its own tolerant readers, and a soft parse would warn on every
    // operator-touched row while returning the raw object anyway.
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : undefined;

    // ⚠️ Every decision is re-derived from THIS attempt's own read — the
    // function is pure and the snapshot is the only input that can have moved.
    const previsao = preverIncidenteClaim(raw, mapeado);
    if (previsao.patch !== null) {
      if (previsao.acao === 'criado') tx.create(ref, previsao.patch as DocumentData);
      else tx.set(ref, previsao.patch as DocumentData, { merge: true });
    }
    return previsao;
  });
}
