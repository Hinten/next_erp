/**
 * Server-side find-or-create for a `clientes` document — the promoted, shared
 * form of the legacy `Cliente.getOrCreateOrUpdate`
 * (`.old/packages/clientes/lib/src/models.dart:254-419`), minus the `userPath`
 * dedup step and the vector-embedding generation.
 *
 * It lived in `apps/mercado-livre/lib/marketplace/pedidos/orderCliente.ts` until #786.
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
 * A fifth leg, `idMercadoLivre`, was added for the ML chat import. A pre-sale
 * question carries none of the original four — no CPF, no phone, no e-mail — so
 * every leg skipped and the cascade fell through to the blind create below,
 * producing one junk cliente per question notification whose telefone/email
 * legs then poisoned later order imports. The ML buyer id is the only identity
 * such a contact has, and it is a STRONG key: a marketplace account, not a
 * recycled phone number.
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
 *    cliente doc ids are shared with the migrated corpus, so that is a
 *    wire-format change and out of scope here.
 *  - The legacy app ran the ORIGINAL unguarded cascade, with telefone and
 *    e-mail populated, and the rows it merged wrongly arrive that way in the
 *    corpus. This module cannot unpick them — a wrong merge is not detectable
 *    after the fact — so they stay merged. (This once read as a live competing
 *    writer. Void: there is no dual run, root `CLAUDE.md` rule 8. The damage is
 *    historical, which makes it a migration question, never a race.)
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
import { otherOwnerOfMlId } from './otherOwnerOfMlId';

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
  /**
   * The third strong key. Present because `isSameCliente` gates on it, so a
   * candidate can be rejected purely because its ML buyer id contradicts — and
   * with only the two fiscal identifiers printed, that rejection logs as
   * `{ candidateCpfCnpj: null, candidateIdEstrangeiro: null }`, which reads as a
   * bug in the gate rather than the correct verdict it is.
   *
   * It is also becoming the COMMON rejection: an ML contact created from a
   * pre-sale question has an ML id and a name and nothing else, so a later
   * telefone or email hit on a different buyer contradicts here and nowhere
   * else.
   */
  readonly candidateIdMercadoLivre: string | null;
}

export interface FindOrCreateClienteResult {
  readonly clienteId: string;
  readonly created: boolean;
  /** Which leg resolved the hit; `null` when a cliente was created. */
  readonly matchedBy: ClienteMatchKey | null;
  readonly rejected: readonly RejectedClienteCandidate[];
  /** Fields dropped as unstorable (a masked or invalid telefone). */
  readonly dropped: readonly string[];
  /**
   * Another cliente carrying the incoming `idMercadoLivre`, or `null` when the
   * id has at most one owner. Mirrors `VincularClienteResult.clienteConflitante`
   * on the claim path.
   */
  readonly idMercadoLivreConflito: ClienteIdMercadoLivreConflito | null;
}

/**
 * Two clientes, one ML account — reported rather than resolved. Merging them
 * moves pedidos, conversas and endereços; that is a migration, not an import's
 * job.
 */
export interface ClienteIdMercadoLivreConflito {
  /** The OTHER cliente carrying this ML id. */
  readonly outroCliente: string;
  /**
   * `true` — this run WANTED to stamp the id and was refused, so only that key
   * was dropped and the rest of the patch still applied. `false` — nothing was
   * going to be written; the duplicate already existed and is merely being
   * surfaced.
   *
   * The distinction exists so a caller's log can be true. Both are worth
   * seeing, but only one of them is something this run declined to do, and a
   * message saying "não carimbado" about a pre-existing duplicate sends an
   * operator looking for a write that was never attempted.
   */
  readonly carimboRecusado: boolean;
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
 * TableView update monitor — both OURS, and both index-MANDATORY under root
 * `CLAUDE.md` rule 1, so on Enterprise every needless bump is re-sorted, re-read
 * and BILLED as data scanned. The concurrency on this collection is ours too:
 * the importers, the channel webhooks and two operators in two tabs — not the
 * Flutter app, which writes no document this app writes (rule 8).
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

  // Fill-only-when-absent, like the two above. `isSameCliente` has already
  // established the stored value is either absent or exactly equal, so the only
  // write left to make is the one that ADDS the id — which is how a cliente
  // first created from an order (cpf_cnpj, no ML id) gains one the next time
  // that buyer asks a question.
  //
  // ⚠️ That guard is ONE-SIDED and this function cannot fix it: being pure, it
  // can ask whether THIS doc holds an id but not whether ANOTHER doc already
  // owns the incoming one. `findOrCreateCliente` re-checks that before the merge
  // and drops this key when it collides — do not read the presence of
  // `patch.idMercadoLivre` here as "safe to write".
  //
  // Stored TRIMMED, unlike `idEstrangeiro` above. That field is documented free
  // text; this one is the key the next delivery looks itself up by, and the
  // cascade leg queries `identityValue(...)`. Storing `' 301110805 '` raw while
  // querying `'301110805'` means every later lookup misses — one junk cliente
  // per question notification, which is the exact failure this key exists to
  // prevent, reintroduced by whitespace.
  const idMl = identityValue(fields.idMercadoLivre);
  if (idMl != null && identityValue(old.idMercadoLivre) == null) {
    patch.idMercadoLivre = idMl;
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
 * Dedup order — `cpf_cnpj` → `idEstrangeiro` → `idMercadoLivre` → `telefone`
 * (both wire shapes) → `email` (typed and lowercased) — with `isSameCliente`
 * gating EVERY leg, strong ones included: one code path, one truth table. A
 * candidate found by `cpf_cnpj` is compatible on that key by construction, so
 * the uniform gate costs nothing.
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
    {
      key: CLIENTE_MATCH_KEY.idMercadoLivre,
      op: '==',
      // Also raw — an opaque marketplace account number, stored verbatim.
      //
      // Placed AFTER the two fiscal identifiers on purpose. For a pre-sale
      // question this is the only leg with a value, so the order is moot; for an
      // ML order both are present, and `cpf_cnpj` is the identity the NF-e is
      // emitted against, so it stays the first thing we trust. Sitting here also
      // means callers that never pass an ML id see byte-identical behaviour.
      //
      // ⚠️ "for an ML order both are present" was ASPIRATIONAL until #1087:
      // `orderImport.ts` never supplied an ML id, so on the order path this leg
      // was always null and every order fell through to telefone/email. Live on
      // 2026-09-01 that matched a real buyer onto an e2e seed fixture whose
      // placeholder phone they happened to share. True as of that fix.
      //
      // ⚠️ **Supplying it also makes it a REJECTION key on the legs ABOVE, and
      // that is a deliberate trade — see the test named for it.** `isSameCliente`
      // gates every leg on all three strong keys, so a `cpf_cnpj` hit whose
      // stored ML id CONTRADICTS the incoming one is now refused, and a SECOND
      // cliente carrying the same cpf_cnpj is created. One CPF ordering from two
      // ML accounts is the trigger (a replacement account, a household or company
      // login) — uncommon, and permanent once it happens.
      //
      // Kept, for three reasons. The fork is SELF-CONSISTENT going forward: this
      // very gate makes each account resolve to its own row deterministically,
      // rather than to whichever the page returns first. Both rows carry the
      // SAME correct cpf_cnpj, so the NF-e is fiscally right against either —
      // what splits is the pedido history, which an operator can merge. And the
      // alternative is worse: letting the cpf hit win would put two marketplace
      // accounts on one cliente, which is exactly what CLIENTE_STRONG_KEYS
      // exists to prevent, and the second id would never be stored anyway
      // (fill-only-when-absent), so the two would not converge either.
      // Consistent with this module's own bias — "a duplicate is recoverable,
      // an overwritten cpf_cnpj is not".
      //
      // It is also ANNOUNCED, not silent: the refused candidate lands in
      // `rejected` carrying `candidateIdMercadoLivre`, which
      // `applyClienteStep` already logs.
      value: identityValue(fields.idMercadoLivre),
    },
    // The legacy `userPath` dedup step is intentionally skipped — see
    // apps/mercado-livre/lib/marketplace/pedidos/orderCliente.ts's header doc.
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
  /**
   * Every doc the `idMercadoLivre` leg saw, or `null` when that leg never ran
   * (no incoming id, or a higher leg matched first and broke the loop).
   *
   * It is the collision answer for free: the leg is an `==` query on the exact
   * value about to be stamped, so its rows ARE the current owners — and an
   * EMPTY page proves nobody owns it. Only when the leg never ran does the
   * guard below have to pay for a query.
   */
  let mlLegOwners: string[] | null = null;

  for (const leg of legs) {
    if (leg.value == null) continue;
    const candidates = await pageCandidates(db, leg.key, leg.op, leg.value, limit);
    if (leg.key === CLIENTE_MATCH_KEY.idMercadoLivre) {
      mlLegOwners = candidates.map((c) => c.id);
    }
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
        candidateIdMercadoLivre: identityValue(candidate.data.idMercadoLivre),
      });
    }
    if (matched) break;
  }

  const telefone = sanitizeTelefone(fields.telefone);
  const dropped = fields.telefone != null && telefone == null ? ['telefone'] : [];

  if (matched) {
    const alvo = matched;
    const patch = buildClienteUpdatePatch(alvo.data, fields);

    // ⚠️ The one write in this patch that can manufacture an ambiguity rather
    // than resolve one. `buildClienteUpdatePatch` is pure, so it can only ask
    // "does THIS doc already have an id?" — it cannot ask "does ANOTHER doc
    // already own this one?", and stamping over that leaves two strong owners
    // of one identity for the third leg to pick between at random.
    //
    // Two windows reach here with an id to stamp and no proof it is free:
    //  (A) `cpf_cnpj`/`idEstrangeiro` matched first, so the ML leg never ran;
    //  (B) the ML leg ran and `isSameCliente` rejected everything it found —
    //      those rejects being, precisely, the other owners.
    //
    // Refusing drops ONLY this key: the rest of the patch is unrelated and
    // still correct, so the cliente is enriched and the split is reported.
    // Merging the two docs moves pedidos, conversas and endereços — a
    // migration, never an import's job.
    const idMlPatch = patch.idMercadoLivre;
    const vaiCarimbar = typeof idMlPatch === 'string';
    let outroDono: string | null = null;
    if (vaiCarimbar) {
      outroDono =
        mlLegOwners != null
          ? // Case B, free: no row the leg returned can BE `alvo` — an accepted
            // row ends the cascade at that leg, and `isSameCliente` is
            // deterministic, so a rejected one cannot be accepted lower down.
            (mlLegOwners.find((id) => id !== alvo.id) ?? null)
          : // Case A: the leg never ran, so nobody has asked yet.
            await otherOwnerOfMlId(db, idMlPatch as string, alvo.id);
    } else if (mlLegOwners != null) {
      // Nothing to stamp — but the leg's page is already in hand, so a
      // PRE-EXISTING duplicate costs nothing to notice and is otherwise
      // invisible: the cascade takes the first compatible row and the second
      // owner is never mentioned anywhere. That silence is what makes the
      // ambiguity survive, since every later delivery makes the same silent
      // pick. Reported, never repaired.
      outroDono = mlLegOwners.find((id) => id !== alvo.id) ?? null;
    }

    const idMercadoLivreConflito =
      outroDono == null ? null : { outroCliente: outroDono, carimboRecusado: vaiCarimbar };
    if (outroDono != null && vaiCarimbar) delete patch.idMercadoLivre;

    if (Object.keys(patch).length > 0) {
      await clienteCollection.merge(db, {}, alvo.id, {
        ...patch,
        ultimaModificacao: nowMs,
      });
    }
    return {
      clienteId: alvo.id,
      created: false,
      matchedBy,
      rejected,
      dropped,
      idMercadoLivreConflito,
    };
  }

  // The same ambiguity, on the create path — and it is the SHARPER half. Every
  // leg with a value has run by now (nothing matched, so the loop never broke),
  // which means `mlLegOwners` is non-null whenever an id came in: any row it
  // holds is a doc that carries this id and that `isSameCliente` REFUSED to
  // merge with. Stamping the id onto a brand-new document anyway would mint the
  // second owner outright.
  //
  // So the cliente is still created — the pedido needs one — but without the
  // key, and the conflict is reported. That the two rows disagree on a fiscal
  // document while sharing an ML account is a human's call: one buyer who
  // changed their CPF, or one account used by two people.
  //
  // Free, like case B above: no query, just the page the leg already fetched.
  const idMlNovo = identityValue(fields.idMercadoLivre);
  const outroDonoNoCreate = idMlNovo == null ? null : (mlLegOwners?.[0] ?? null);
  const conflitoNoCreate =
    outroDonoNoCreate == null ? null : { outroCliente: outroDonoNoCreate, carimboRecusado: true };

  const ref = await clienteCollection.add(db, {}, {
    tipo: fields.tipo,
    // Normalized, and `null` rather than blanks: `clienteSchema.nome` accepts
    // any string, so a whitespace-only payload would otherwise be stored as-is.
    nome: normalizeNome(fields.nome),
    // Stored canonical, matching what the cpf_cnpj leg queries. A punctuated
    // value would not round-trip clienteSchema's `^[0-9A-Z]*$` at all.
    cpf_cnpj: fields.cpf_cnpj != null ? normalizeDocumento(fields.cpf_cnpj) : null,
    idEstrangeiro: fields.idEstrangeiro,
    // `identityValue`, not a bare `?? null`: it trims (so the value round-trips
    // the cascade leg, which queries the trimmed form) AND it collapses both
    // `undefined` — the field is optional on `ClienteResolveFields` — and a
    // blank string to `null`, which is what the Firebase SDK requires, since it
    // rejects `undefined` in addDoc/setDoc.
    idMercadoLivre: outroDonoNoCreate == null ? idMlNovo : null,
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

  return {
    clienteId: ref.id,
    created: true,
    matchedBy: null,
    rejected,
    dropped,
    idMercadoLivreConflito: conflitoNoCreate,
  };
}
