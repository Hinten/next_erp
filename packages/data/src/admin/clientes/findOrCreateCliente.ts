/**
 * Server-side find-or-create for a `clientes` document — the promoted, shared
 * form of the legacy `Cliente.getOrCreateOrUpdate`
 * (`.old/packages/clientes/lib/src/models.dart:254-419`), minus the `userPath`
 * dedup step and the vector-embedding generation.
 *
 * It lived in `apps/mercado-livre/lib/marketplace/orderCliente.ts` until #786.
 * Every channel that imports an order needs the same resolution, and the copy
 * that existed had a defect worth never writing twice:
 *
 *   A 4-leg cascade (cpf_cnpj → idEstrangeiro → telefone → email), each taking
 *   the FIRST row it found, merged into whatever it hit and overwrote that
 *   row's `cpf_cnpj`. A genuinely new buyer whose CPF matched nobody fell
 *   through to a stranger's recycled mobile number or a shared household
 *   e-mail, the pedido linked to the stranger, and the stranger's fiscal
 *   identity was rewritten with the buyer's. The NF-e would then be emitted
 *   against a cliente carrying the wrong CPF.
 *
 * The cascade order is unchanged. What changed is that **every candidate must
 * pass `isSameCliente`** (`@delfrance/schemas`) before it may be merged into:
 * telefone and e-mail are signals, cpf_cnpj and idEstrangeiro are identity, and
 * a weak-key hit is only a match when the strong identifiers do not contradict.
 * Absence is "no evidence", never "no match", so a cliente with no document on
 * file still matches and gets its document filled in.
 *
 * The SDK is never bound here — `db` always arrives from the caller, which is
 * what keeps this subtree importable from a browser bundle's dependency graph
 * without dragging firebase-admin in (`../adminBundleSafety.test.ts`).
 *
 * Two residual behaviours, stated rather than hidden:
 *
 *  - `clienteCollection.add` is a blind create, so two concurrent imports for
 *    the same new buyer both create. The real fix is root `CLAUDE.md` rule 7
 *    tier 0 — a deterministic doc id keyed on the normalized document — but
 *    cliente doc ids are shared with the still-running Flutter app, so that is
 *    a wire-format change and out of scope here.
 *  - The legacy Flutter app runs the ORIGINAL unguarded cascade against the
 *    same collection, with telefone and e-mail populated. This module cannot
 *    fix that writer; rows it has already merged wrongly stay merged.
 */

import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import {
  CLIENTE_MATCH_KEY,
  type Cliente,
  type ClienteMatchKey,
  type ClienteResolveFields,
  emailLookupShapes,
  identityValue,
  isSameCliente,
  isSameEmail,
  isSameTelefone,
  normalizeDocumento,
  normalizeNome,
  sanitizeTelefone,
  shouldUpdateName,
  telefoneLookupShapes,
} from '@delfrance/schemas';
import { clienteCollection } from '../collections';

/**
 * Rows fetched per leg before the cascade gives up and creates. See
 * {@link findOrCreateCliente} on why this is a plain limit and not a cursor.
 */
const DEFAULT_CANDIDATE_LIMIT = 10;

export interface FindOrCreateClienteInput {
  readonly fields: ClienteResolveFields;
  /** Milliseconds since epoch — `clienteSchema`'s unit for both stamps. */
  readonly nowMs: number;
  /** Candidates examined per leg. Defaults to 10. */
  readonly candidateLimit?: number;
}

/**
 * A candidate rejected because its strong identifiers contradict the incoming
 * record. Surfaced so the caller can log the near-miss: before #786 this was
 * precisely the case that merged silently and destroyed an identity, so it is
 * worth seeing in the logs rather than inferring from a duplicate later.
 */
export interface RejectedClienteCandidate {
  readonly id: string;
  readonly matchedBy: ClienteMatchKey;
  readonly candidateCpfCnpj: string | null;
  readonly candidateIdEstrangeiro: string | null;
}

export interface FindOrCreateClienteResult {
  readonly clienteId: string;
  readonly created: boolean;
  /** Which leg resolved the hit; `null` when a cliente was created. */
  readonly matchedBy: ClienteMatchKey | null;
  readonly rejected: readonly RejectedClienteCandidate[];
  /** Fields dropped as unstorable (a masked or invalid telefone). */
  readonly dropped: readonly string[];
}

interface ClienteCandidate {
  readonly id: string;
  readonly data: Cliente;
}

/**
 * One leg of the cascade: fetch up to `limit` rows and return them sorted by
 * doc id ascending.
 *
 * **No `orderBy`, deliberately.** Firestore Enterprise omits the implicit
 * trailing `__name__` field, so an `orderBy` stacked on a `where` needs its own
 * declared composite index — and an undeclared one does not throw, it silently
 * full-scans and is billed by data scanned. A bare `.limit()` on the same
 * single-field filter rides the existing single-field indexes.
 *
 * The in-memory doc-id sort makes the pick deterministic given a page (the same
 * tie-break `apps/whatsapp/lib/whatsapp/discoverUser.ts` already uses), not
 * across pages.
 */
async function pageCandidates(
  db: Firestore,
  field: ClienteMatchKey,
  op: '==' | 'in',
  value: string | readonly string[],
  limit: number,
): Promise<ClienteCandidate[]> {
  const snap = await clienteCollection
    .ref(db, {})
    .where(field, op, Array.isArray(value) ? [...value] : value)
    .limit(limit)
    .get();

  return snap.docs
    .map((doc) => ({
      id: doc.id,
      data: clienteCollection.parseRead(doc.data(), clienteCollection.docPath({}, doc.id)),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Update-only-changed patch for a matched cliente. An empty result means no
 * write is needed at all.
 *
 * Both strong identifiers are **fill-only-when-absent**. After the
 * `isSameCliente` gate a candidate's document is either absent or
 * normalization-equal to the incoming one, so the only difference an overwrite
 * could still express is formatting — and re-canonicalizing a stored value is a
 * data migration (`tools/migrations`), not a side effect of an unrelated
 * import. Doing it here would bump `ultimaModificacao` on documents that did
 * not otherwise change, churning `clienteMeta.defaultQuery`'s sort and the
 * TableView update monitor, against a collection the Flutter app writes
 * concurrently.
 *
 * The stored form differs by field on purpose: `cpf_cnpj` HAS a canonical form
 * the schema enforces (`^[0-9A-Z]*$` rejects punctuation), so the normalized
 * value is the only writable one. `idEstrangeiro` carries no regex — free text,
 * like `ie` — so the caller's value is stored verbatim, and only the COMPARISON
 * normalizes.
 */
export function buildClienteUpdatePatch(
  old: Cliente,
  fields: ClienteResolveFields,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  // `shouldUpdateName` answers "MAY this name overwrite?", not "did it change?".
  // Both questions have to pass, or an import that changes nothing rewrites the
  // identical name and bumps `ultimaModificacao` — which is exactly what this
  // function's "update-only-changed" contract exists to prevent. The stored
  // value is the NORMALIZED one, so a padded payload cannot smuggle blanks past
  // `clienteSchema.nome`, which accepts any string.
  const nome = normalizeNome(fields.nome);
  if (nome != null && nome !== old.nome && shouldUpdateName(old.nome, fields.nome)) {
    patch.nome = nome;
  }

  if (fields.cpf_cnpj != null && identityValue(old.cpf_cnpj) == null) {
    patch.cpf_cnpj = normalizeDocumento(fields.cpf_cnpj);
  }

  if (fields.idEstrangeiro != null && identityValue(old.idEstrangeiro) == null) {
    patch.idEstrangeiro = fields.idEstrangeiro;
  }

  // `isSameTelefone` treats the legacy raw 10/11-digit BR shape and the
  // normalized `55…` shape as ONE number, so a match never triggers a rewrite.
  const telefone = sanitizeTelefone(fields.telefone);
  if (telefone != null && !isSameTelefone(old.telefone, fields.telefone)) {
    patch.telefone = telefone;
  }

  // `identityValue`, not a bare null check: `clienteSchema.email` is
  // `.email()`, which REJECTS `''` and `'   '`. Passing one straight through
  // would throw a ZodError inside `merge()` and abort the import as if
  // transient — the same crash `sanitizeTelefone` exists to prevent.
  const email = identityValue(fields.email);
  if (email != null && !isSameEmail(old.email, email)) {
    patch.email = email;
  }

  // Guarded like every other field. Without the null check a caller that does
  // not know the tipo (the WhatsApp discovery path knows only a phone number)
  // would wipe the stored one.
  if (fields.tipo != null && old.tipo !== fields.tipo) {
    patch.tipo = fields.tipo;
  }

  if (fields.ie != null && old.ie !== fields.ie) {
    patch.ie = fields.ie;
  }

  // `userCliente` is deliberately absent: it is owned by the WhatsApp/chat
  // link paths, and an order importer has no business asserting it.

  return patch;
}

interface CascadeLeg {
  readonly key: ClienteMatchKey;
  readonly op: '==' | 'in';
  readonly value: string | readonly string[] | null;
}

/**
 * Resolve the incoming record to an existing cliente, or create one.
 *
 * Dedup order — `cpf_cnpj` → `idEstrangeiro` → `telefone` (both wire shapes) →
 * `email` (typed and lowercased) — with `isSameCliente` gating EVERY leg, strong
 * ones included: one code path, one truth table. A candidate found by
 * `cpf_cnpj` is compatible on that key by construction, so the uniform gate
 * costs nothing.
 *
 * `nowMs` stamps `timestamp` + `ultimaModificacao` on create, and
 * `ultimaModificacao` only on an update that actually changes a field.
 *
 * **The bias when candidates exceed the page.** A compatible candidate sitting
 * outside the fetched page yields a duplicate cliente rather than a match. That
 * is the intended trade: a duplicate is recoverable — an operator merges it —
 * while a stranger's overwritten CPF is not. In practice more than ten rows
 * sharing one phone number means the phone is a placeholder, and merging into
 * any of them was never right.
 */
export async function findOrCreateCliente(
  db: Firestore,
  input: FindOrCreateClienteInput,
): Promise<FindOrCreateClienteResult> {
  const { fields, nowMs } = input;
  const limit = input.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;

  const telefoneShapes = telefoneLookupShapes(fields.telefone);
  const emailShapes = emailLookupShapes(fields.email);

  const legs: readonly CascadeLeg[] = [
    {
      key: CLIENTE_MATCH_KEY.cpfCnpj,
      op: '==',
      // Query the canonical form — the only one clienteSchema's regex accepts,
      // and therefore the only one this app ever writes.
      value: fields.cpf_cnpj != null ? normalizeDocumento(fields.cpf_cnpj) : null,
    },
    {
      key: CLIENTE_MATCH_KEY.idEstrangeiro,
      op: '==',
      // Queried RAW: the field has no schema regex, so there is no stored
      // canonical form to query. Normalizing here would miss every existing row.
      value: identityValue(fields.idEstrangeiro),
    },
    // The legacy `userPath` dedup step is intentionally skipped — see
    // apps/mercado-livre/lib/marketplace/orderCliente.ts's header doc.
    {
      key: CLIENTE_MATCH_KEY.telefone,
      op: 'in',
      value: telefoneShapes.length > 0 ? telefoneShapes : null,
    },
    {
      key: CLIENTE_MATCH_KEY.email,
      op: 'in',
      value: emailShapes.length > 0 ? emailShapes : null,
    },
  ];

  const rejected: RejectedClienteCandidate[] = [];
  let matched: ClienteCandidate | null = null;
  let matchedBy: ClienteMatchKey | null = null;

  for (const leg of legs) {
    if (leg.value == null) continue;
    const candidates = await pageCandidates(db, leg.key, leg.op, leg.value, limit);
    for (const candidate of candidates) {
      if (isSameCliente(candidate.data, fields)) {
        matched = candidate;
        matchedBy = leg.key;
        break;
      }
      rejected.push({
        id: candidate.id,
        matchedBy: leg.key,
        candidateCpfCnpj: identityValue(candidate.data.cpf_cnpj),
        candidateIdEstrangeiro: identityValue(candidate.data.idEstrangeiro),
      });
    }
    if (matched) break;
  }

  const telefone = sanitizeTelefone(fields.telefone);
  const dropped = fields.telefone != null && telefone == null ? ['telefone'] : [];

  if (matched) {
    const patch = buildClienteUpdatePatch(matched.data, fields);
    if (Object.keys(patch).length > 0) {
      await clienteCollection.merge(db, {}, matched.id, {
        ...patch,
        ultimaModificacao: nowMs,
      });
    }
    return { clienteId: matched.id, created: false, matchedBy, rejected, dropped };
  }

  const ref = await clienteCollection.add(db, {}, {
    tipo: fields.tipo,
    // Normalized, and `null` rather than blanks: `clienteSchema.nome` accepts
    // any string, so a whitespace-only payload would otherwise be stored as-is.
    nome: normalizeNome(fields.nome),
    // Stored canonical, matching what the cpf_cnpj leg queries. A punctuated
    // value would not round-trip clienteSchema's `^[0-9A-Z]*$` at all.
    cpf_cnpj: fields.cpf_cnpj != null ? normalizeDocumento(fields.cpf_cnpj) : null,
    idEstrangeiro: fields.idEstrangeiro,
    ie: fields.ie,
    // `sanitizeTelefone`, not `normalizeTelefone`: a masked value (`11*****8888`)
    // would otherwise be stripped to 6 digits and throw a ZodError inside
    // `add`, aborting the whole import as if it were transient.
    telefone,
    // `''` fails `clienteSchema.email`'s `.email()` check — same reason as the
    // patch path above.
    email: identityValue(fields.email),
    timestamp: nowMs,
    ultimaModificacao: nowMs,
  } satisfies DocumentData);

  return { clienteId: ref.id, created: true, matchedBy: null, rejected, dropped };
}
