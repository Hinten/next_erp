/**
 * Cliente identity resolution — the shared DECISION behind "is this row the
 * same person as the record I am importing?".
 *
 * Four places resolve or link a cliente, and until #786 they disagreed about
 * what counts as identity:
 *
 *  - `apps/web/lib/clientes/dedup.ts` — the screen a human uses. Exact
 *    `cpf_cnpj`/`idEstrangeiro` BLOCKS creation; a matching telefone or e-mail
 *    is a warning that never blocks.
 *  - `apps/mercado-livre/lib/marketplace/orderCliente.ts` — the unattended
 *    importer. It treated a telefone/e-mail hit as identity, merged into it,
 *    and overwrote the row's `cpf_cnpj`. A new buyer landing on a stranger's
 *    recycled mobile number rewrote that stranger's fiscal identity, and the
 *    NF-e would then be emitted against the wrong CPF.
 *  - `apps/whatsapp/lib/whatsapp/discoverUser.ts` and
 *    `apps/web/app/(app)/chat/_hooks/useClienteLink.ts` — link-only paths.
 *
 * The rule this module encodes: **telefone and e-mail are SIGNALS, cpf_cnpj and
 * idEstrangeiro are IDENTITY.** A weak-key hit is a valid match only when the
 * strong identifiers do not CONTRADICT — and absence is "no evidence", never
 * "no match" (a cliente with no document on file is the common pre-billing_info
 * case and must still match, so its document can be filled in).
 *
 * Everything here is pure so both SDK worlds can share it: `apps/web` runs the
 * client SDK, the importers run firebase-admin, and `packages/data/src/admin/**`
 * is bundle-guarded against apps/web. Only the decision can be shared — the IO
 * around it cannot.
 *
 * Every input is typed `unknown` on purpose. Reads go through `parseSoftRead`,
 * which returns the RAW document when it fails the schema, so a value reaching
 * these predicates may be punctuated, empty, or not a string at all.
 */

import { normalizeDocumento } from '@delfrance/core/documents';
import { isValidTelefone, normalizeTelefone, telefoneQueryShapes } from '@delfrance/core/phone';
import type { TipoCliente } from './cliente';

/**
 * Re-exported so `packages/data` — which depends on schemas, not on
 * `@delfrance/core` directly — can canonicalize a document without gaining a
 * new dependency edge. Same rationale as `valuesEqual` in `./index`.
 */
export { normalizeDocumento };

/* ------------------------------- match keys -------------------------------- */

/**
 * The fields a cliente lookup may key on. STRONG keys identify a person; WEAK
 * keys only suggest one. Both are queried, but a weak-key candidate has to pass
 * {@link isSameCliente} before it may be merged into.
 */
export const CLIENTE_MATCH_KEY = {
  cpfCnpj: 'cpf_cnpj',
  idEstrangeiro: 'idEstrangeiro',
  idMercadoLivre: 'idMercadoLivre',
  telefone: 'telefone',
  email: 'email',
} as const satisfies Record<string, string>;

export type ClienteMatchKey = (typeof CLIENTE_MATCH_KEY)[keyof typeof CLIENTE_MATCH_KEY];

/**
 * Keys that constitute identity — a contradiction here means a different person.
 *
 * `idMercadoLivre` is STRONG: it is a marketplace account, not a recycled phone
 * number or a shared household mailbox. Two rows carrying different ML buyer ids
 * are two different accounts, and merging them would attribute one buyer's
 * questions and orders to another.
 */
export const CLIENTE_STRONG_KEYS: readonly ClienteMatchKey[] = [
  CLIENTE_MATCH_KEY.cpfCnpj,
  CLIENTE_MATCH_KEY.idEstrangeiro,
  CLIENTE_MATCH_KEY.idMercadoLivre,
];

/** Keys that only suggest identity — recycled mobile numbers and shared
 *  household e-mails are routine, so a hit here needs corroboration. */
export const CLIENTE_WEAK_KEYS: readonly ClienteMatchKey[] = [
  CLIENTE_MATCH_KEY.telefone,
  CLIENTE_MATCH_KEY.email,
];

/* -------------------------------- predicates -------------------------------- */

/**
 * The two strong identifiers, structurally typed so `Cliente`, the web dedup
 * screen's `DedupCandidate` and any importer's field shape all satisfy it
 * without a conversion step.
 */
export interface ClienteIdentityKeys {
  readonly cpf_cnpj?: string | null;
  readonly idEstrangeiro?: string | null;
  readonly idMercadoLivre?: string | null;
}

/**
 * A usable identity value, or `null`. Anything that is not a non-empty string
 * is absence: `clienteSchema` permits `''` for both strong keys, and a
 * soft-parsed read can hand back a number or an object.
 */
export function identityValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Two identifier values are compatible when either is absent, or equal after
 * normalization. **Absence is "no evidence", never "no match"** — a cliente
 * with no document on file still matches, which is how the document gets
 * filled in on the next import.
 *
 * Normalizing both sides is load-bearing: the live Flutter app writes
 * punctuated documents, `parseSoftRead` hands them through raw, and comparing
 * a stored `529.982.247-25` against an incoming `52998224725` as strings makes
 * two spellings of ONE person look like two people.
 */
export function idCompatible(a: unknown, b: unknown): boolean {
  const left = identityValue(a);
  const right = identityValue(b);
  if (left == null || right == null) return true;
  return normalizeDocumento(left) === normalizeDocumento(right);
}

/**
 * Whether a candidate row may be treated as the incoming record's cliente: no
 * strong identifier contradicts.
 *
 *  | candidate | incoming  | verdict                                    |
 *  |-----------|-----------|--------------------------------------------|
 *  | absent    | absent    | match — no contradicting evidence           |
 *  | absent    | value     | match — we are adding information           |
 *  | value     | absent    | match                                       |
 *  | value     | different | REJECT — a different person                 |
 *
 * Applied to strong-key hits too, not just weak ones: one code path, one truth
 * table. A candidate found BY `cpf_cnpj` is compatible on that key by
 * construction, so the uniform gate costs nothing.
 */
export function isSameCliente(
  candidate: ClienteIdentityKeys,
  incoming: ClienteIdentityKeys,
): boolean {
  return (
    idCompatible(candidate.cpf_cnpj, incoming.cpf_cnpj) &&
    idCompatible(candidate.idEstrangeiro, incoming.idEstrangeiro) &&
    idMercadoLivreCompatible(candidate.idMercadoLivre, incoming.idMercadoLivre)
  );
}

/**
 * Same "absence is no evidence" rule as {@link idCompatible}, but compared as an
 * exact trimmed string rather than through `normalizeDocumento`.
 *
 * An ML buyer id is an opaque account number, not a Brazilian fiscal document.
 * `normalizeDocumento` happens to be the identity function on a digit string
 * today, so routing this through {@link idCompatible} would pass every test —
 * and would silently start folding two distinct ML accounts together the day
 * that normalizer learns a new rule. Comparing what ML actually gave us keeps
 * that coupling from ever existing.
 */
export function idMercadoLivreCompatible(a: unknown, b: unknown): boolean {
  const left = identityValue(a);
  const right = identityValue(b);
  if (left == null || right == null) return true;
  return left === right;
}

/**
 * Trimmed, whitespace-collapsed name, or `null` when there is nothing to
 * store. Providers send padded and double-spaced values routinely, and
 * `clienteSchema.nome` is only `z.string().max(255)` — it accepts `'   '`
 * happily, so without this a whitespace-only payload silently overwrites a
 * real name with blanks. Collapsing also makes the word count below mean what
 * it says: `'Ana  '.split(' ')` is 3 "words".
 */
export function normalizeNome(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  return collapsed === '' ? null : collapsed;
}

/**
 * A lone-word new name never overwrites an existing multi-word name — guards
 * against a webhook payload's first-name-only field clobbering a fuller name
 * already on file. An absent or whitespace-only new name never updates.
 *
 * Ported from the legacy `_shouldUpdateName`
 * (`.old/packages/clientes/lib/src/models.dart:117-129`), with both sides run
 * through {@link normalizeNome} first — the Dart original compared raw strings
 * and split on a literal space, so padded input defeated both checks.
 */
export function shouldUpdateName(oldName: unknown, newName: string): boolean {
  const incoming = normalizeNome(newName);
  if (incoming == null) return false;
  const old = normalizeNome(oldName);
  if (incoming.split(' ').length === 1 && old != null && old.split(' ').length > 1) {
    return false;
  }
  return true;
}

/* --------------------------------- telefone -------------------------------- */

/**
 * The telefone value that may be STORED, or `null` when there is nothing
 * storable. Two inputs collapse to `null`:
 *
 *  - a MASKED value (contains `*`). Providers redact digits; `normalizeTelefone`
 *    would strip the `*` and turn `11*****8888` into a 6-digit string that fails
 *    `clienteSchema.telefone`'s refine — a `ZodError` thrown mid-import, which
 *    reads as a transient failure and gets retried forever.
 *  - anything that still fails `isValidTelefone` after normalization.
 *
 * Degrade, never crash: a phone number is not worth failing an order import
 * over. The caller reports what it dropped.
 */
export function sanitizeTelefone(raw: unknown): string | null {
  const value = identityValue(raw);
  if (value == null) return null;
  if (value.includes('*')) return null;
  const normalized = normalizeTelefone(value);
  return isValidTelefone(normalized) ? normalized : null;
}

/**
 * Every wire shape a stored `telefone` may take, for an `in` lookup. Thin
 * wrapper over `@delfrance/core/phone` so `packages/data` reaches it through
 * schemas. Empty input yields an empty array — the caller must skip the query.
 */
export function telefoneLookupShapes(raw: unknown): string[] {
  const value = identityValue(raw);
  if (value == null || value.includes('*')) return [];
  return telefoneQueryShapes(value);
}

/**
 * Two stored telefone values are the same number when either is one of the
 * other's wire shapes — the normalized `55…` this app writes and the raw
 * 10/11-digit BR shape the migrated corpus is full of are the SAME phone.
 *
 * Used to suppress a pointless rewrite on merge. Re-canonicalizing a stored
 * value is a migration (`tools/migrations`), not a side effect of an unrelated
 * import: it would bump `ultimaModificacao` on a doc that did not otherwise
 * change, churning `clienteMeta.defaultQuery`'s sort and the TableView update
 * monitor, against a collection the Flutter app writes concurrently.
 */
export function isSameTelefone(stored: unknown, incoming: unknown): boolean {
  const storedValue = identityValue(stored);
  if (storedValue == null) return false;
  return telefoneLookupShapes(incoming).includes(storedValue);
}

/* ---------------------------------- e-mail --------------------------------- */

/**
 * The forms an e-mail lookup should try: as typed and lowercased. Firestore has
 * no case-insensitive operator, so a stored mixed-case variant the caller did
 * not type is still missed — acceptable because e-mail is a weak key that never
 * decides identity on its own.
 */
export function emailLookupShapes(raw: unknown): string[] {
  const value = identityValue(raw);
  if (value == null) return [];
  return [...new Set([value, value.toLowerCase()])];
}

/** Case-insensitive e-mail equality, mirroring {@link emailLookupShapes}. */
export function isSameEmail(stored: unknown, incoming: unknown): boolean {
  const storedValue = identityValue(stored);
  const incomingValue = identityValue(incoming);
  if (storedValue == null || incomingValue == null) return false;
  return storedValue.toLowerCase() === incomingValue.toLowerCase();
}

/* ------------------------------- import fields ------------------------------ */

/**
 * The cliente fields an importer resolves a record from.
 *
 * `tipo` is NULLABLE on purpose: a caller that does not know the tipo (the
 * WhatsApp discovery path knows only a phone number) must be able to say so
 * rather than assert a guess over a stored value.
 */
export interface ClienteResolveFields {
  readonly tipo: TipoCliente | null;
  readonly nome: string;
  readonly cpf_cnpj: string | null;
  readonly idEstrangeiro: string | null;
  readonly ie: string | null;
  readonly telefone: string | null;
  readonly email: string | null;
  /**
   * The ML buyer id, when the caller knows it.
   *
   * OPTIONAL, unlike every field above, and that is the point: most callers
   * genuinely do not know it. `billingInfoToClienteFields` sees only ML's
   * billing block, which carries no buyer id; the WhatsApp discovery path knows
   * a phone number and nothing else. Omitting the key says "no evidence", which
   * is what the cascade already does with a null leg — whereas making it
   * required would force those callers to write `idMercadoLivre: null`, an
   * assertion they are in no position to make.
   */
  readonly idMercadoLivre?: string | null;
}
