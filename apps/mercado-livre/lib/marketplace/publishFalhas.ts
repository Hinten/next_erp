/**
 * Parse Mercado Livre's validation `cause[]` off a rejected item write and
 * resolve each entry to the listing-form control that can fix it.
 *
 * ML answers a refused `POST`/`PUT /items` with a documented body (developers
 * site, *Guia para produtos → Validações*):
 *
 * ```json
 * { "message": "Validation error", "error": "validation_error", "status": 400,
 *   "cause": [ { "department": "moderations", "cause_id": 3250, "type": "error",
 *                "code": "moderations.seller.not_authorized",
 *                "references": ["item.seller_id", "item.category_id",
 *                               "item.attributes[0]"],
 *                "message": "Seller is not authorized for this brand and category" } ] }
 * ```
 *
 * All of that used to be discarded twice over: `api.ts` collapses the body to
 * `` `ML ${status}: ${message}` `` (so the operator read exactly
 * `ML 400: Validation error`) and `publish.ts` persisted that one string. The
 * detail survives on {@link MercadoLivreHttpError.body}, which is what this
 * module reads.
 *
 * Modelled on `sizeChartSync.ts`'s `chartValidationErrors` /
 * `resolveErrorRowIndex` — the same "tolerant schema, then join the ML error
 * back onto a control, null rather than a wrong guess" shape, already shipped
 * for the size-chart editor.
 *
 * ⚠️ Lives here and not in `packages/integrations/mercado-livre`: it needs the
 * `MlCausa` shape from `@delfrance/schemas`, and that package deliberately
 * depends on no schemas (see its `incidents.ts` / `ai/medidasReference.ts`
 * notes). `apps/mercado-livre` depends on both.
 *
 * ⚠️ Only ever fed an **item-endpoint** failure. `MercadoLivreHttpError` is
 * generic, so a caller must not hand this an OAuth failure and let the raw-body
 * tail below reach a document — #1015 is what a token response in a persisted
 * payload costs.
 */
import { z } from 'zod';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import {
  ML_CAUSA_CAMPO,
  ML_CAUSA_TIPO,
  campoAtributo,
  mlCausaSchema,
  type MlCausa,
} from '@delfrance/schemas';

/**
 * An ML body is unbounded and a Firestore document is not. A rejected publish
 * with 50 causes must not grow the link doc without limit — the operator acts
 * on the first handful and the rest are the same story.
 */
export const MAX_CAUSAS = 20;

/** How much of an unparseable body is worth keeping. Mirrors `respond.ts`. */
const MAX_RAW_BODY = 500;

/** Just enough of the sent payload to resolve a positional `attributes[N]`. */
export interface AttributeLike {
  id?: string | null;
}

/* ------------------------------- the body -------------------------------- */

/**
 * Deliberately tolerant. The documented shape is only ONE of the shapes ML
 * actually sends, and every deviation seen in this repo's fixtures is admitted
 * here rather than causing a total parse failure (which would silently put us
 * back to the single-string behaviour this module exists to end):
 *
 *  - `cause` **or** `causes` — `nfeUpload.ts` already tolerates both spellings;
 *  - entries as objects **or** bare strings (`{"causes": ["wrong_invoice_date"]}`);
 *  - `references` as an array **or** a single string;
 *  - `cause_id` as a number **or** a stringified one;
 *  - everything optional — a 403 carries `{status, error, code}` and no cause at
 *    all, which must parse to zero causas rather than throwing.
 */
const causeEntrySchema = z.union([
  z.string(),
  z
    .object({
      department: z.string().nullable().optional(),
      cause_id: z.union([z.number(), z.string()]).nullable().optional(),
      type: z.string().nullable().optional(),
      code: z.union([z.string(), z.number()]).nullable().optional(),
      references: z
        .union([z.array(z.string()), z.string()])
        .nullable()
        .optional(),
      message: z.string().nullable().optional(),
    })
    .passthrough(),
]);

export const mlValidationBodySchema = z
  .object({
    message: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    cause: z
      .union([z.array(causeEntrySchema), causeEntrySchema])
      .nullable()
      .optional(),
    causes: z
      .union([z.array(causeEntrySchema), causeEntrySchema])
      .nullable()
      .optional(),
  })
  .passthrough();

/* ---------------------------- field resolution --------------------------- */

/**
 * ML reference (minus its `item.` prefix) → listing-form control, for the
 * references that name ONE scalar field. `attributes` is positional and handled
 * separately; everything absent from this table resolves to nothing on purpose.
 */
const REFERENCE_FIELDS: Record<string, string> = {
  title: ML_CAUSA_CAMPO.title,
  // User Products names the same control `family_name` (`buildUserProductItemPayload`).
  family_name: ML_CAUSA_CAMPO.title,
  category_id: ML_CAUSA_CAMPO.categoryId,
  listing_type_id: ML_CAUSA_CAMPO.listingTypeId,
  description: ML_CAUSA_CAMPO.descricao,
};

/** `item.attributes[3]` → `3`; `item.attributes` → null; anything else → undefined. */
function attributesReference(ref: string): number | null | undefined {
  if (!ref.startsWith('attributes')) return undefined;
  const indexed = /^attributes\[(\d+)\]/.exec(ref);
  if (indexed) return Number(indexed[1]);
  return ref === 'attributes' || ref.startsWith('attributes.') ? null : undefined;
}

/**
 * ML attribute ids named IN the message.
 *
 * ML's documented message templates bracket the id — `The attributes
 * [$ATTRIBUTE_ID] are required…`, `Attribute [$ATTRIBUTE] to be modified…`,
 * `Product Identifier [GTIN] has invalid values…` — so the brackets, not a bare
 * SCREAMING_SNAKE scan, are what make this deterministic. A blind scan would
 * pick words out of a sentence; this only ever claims a bracketed token.
 *
 * The ids we sent are unioned in because an id can be bracketed differently, and
 * a `campos` entry matching no form row simply highlights nothing.
 */
function attributeIdsInMessage(message: string, sentIds: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const [, token] of message.matchAll(/\[([A-Z][A-Z0-9_]{2,})\]/g)) {
    if (token != null) found.add(token);
  }
  for (const token of message.match(/[A-Z][A-Z0-9_]{2,}/g) ?? []) {
    if (sentIds.has(token)) found.add(token);
  }
  return [...found];
}

/**
 * Which controls one cause points at. Empty is the SAFE answer — the caller
 * renders an unmapped cause above the form, which is what `resolveErrorRowIndex`
 * does when it cannot pin a chart row.
 */
export function resolveCampos(
  referencias: readonly string[],
  mensagem: string,
  attributesSent: readonly AttributeLike[] | null,
): string[] {
  const sent = attributesSent ?? [];
  const sentIds = new Set(sent.map((a) => a.id).filter((id): id is string => id != null));
  const campos = new Set<string>();

  /** Bare `item.attributes` says only "somewhere in the attributes" — read the message. */
  const scanMessage = (): void => {
    for (const id of attributeIdsInMessage(mensagem, sentIds)) campos.add(campoAtributo(id));
  };

  for (const raw of referencias) {
    // Only `item.` is stripped: `shipping.modes` and
    // `user.shipping_preferences.option` are NOT item paths and must stay unmapped.
    const ref = raw.startsWith('item.') ? raw.slice('item.'.length) : raw;

    const direct = REFERENCE_FIELDS[ref];
    if (direct != null) {
      campos.add(direct);
      continue;
    }

    const attrIndex = attributesReference(ref);
    if (attrIndex === undefined) continue;
    if (attrIndex === null) {
      scanMessage();
      continue;
    }
    // Positional — and the index counts the payload WE sent, which is why this
    // resolution cannot happen in the browser (see the `campos` docblock).
    const id = sent[attrIndex]?.id;
    if (id != null) campos.add(campoAtributo(id));
    else scanMessage();
  }

  return [...campos];
}

/* -------------------------------- parsing -------------------------------- */

/** A bare-string cause is a code only when it LOOKS like one (`nfeUpload.ts`). */
const CODE_TOKEN_REGEX = /^[a-z][a-z0-9_.-]*$/i;

/** ML `type` is free text on the wire; only the two documented values count. */
function toTipo(raw: string | null | undefined): MlCausa['tipo'] {
  const value = raw?.trim().toLowerCase();
  if (value === ML_CAUSA_TIPO.erro) return ML_CAUSA_TIPO.erro;
  if (value === ML_CAUSA_TIPO.aviso) return ML_CAUSA_TIPO.aviso;
  return null;
}

function toReferencias(raw: string[] | string | null | undefined): string[] {
  if (raw == null) return [];
  return (typeof raw === 'string' ? [raw] : raw).filter((r) => r.length > 0);
}

function toCausaId(raw: number | string | null | undefined): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Every cause on an ML rejection, resolved to controls. `[]` for anything that
 * is not an ML HTTP failure, or whose body carries no cause list — a plain
 * `{status, error, code}` 403 included.
 *
 * ⚠️ NOT gated on `status === 400`, unlike `chartValidationErrors`. That guard
 * exists there because a 429/403 carrying an `errors` key must not read as "your
 * chart is invalid" and abort a sync; here the causas are only ever DISPLAYED,
 * so a cause list on a 403 is information the operator wants, not a decision.
 *
 * Never throws: a failure to explain a failure must not become the failure.
 */
export function parseMlCausas(
  err: unknown,
  attributesSent: readonly AttributeLike[] | null = null,
): MlCausa[] {
  if (!(err instanceof MercadoLivreHttpError)) return [];
  const parsed = mlValidationBodySchema.safeParse(err.body);
  if (!parsed.success) return [];

  const raw = parsed.data.cause ?? parsed.data.causes;
  if (raw == null) return [];
  const entries = Array.isArray(raw) ? raw : [raw];

  const causas: MlCausa[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.length === 0) continue;
      // `{"causes": ["wrong_invoice_date"]}` — the string IS the code. Same
      // token test `nfeUpload.ts` uses, so prose is not mistaken for one.
      const isCode = CODE_TOKEN_REGEX.test(entry);
      causas.push(mlCausaSchema.parse({ mensagem: entry, code: isCode ? entry : null }));
      continue;
    }
    const code = entry.code == null ? null : String(entry.code);
    // `mensagem` is the one required field, so a cause carrying only a code
    // still becomes a cause instead of being dropped.
    const mensagem = entry.message ?? code ?? parsed.data.message;
    if (mensagem == null || mensagem.length === 0) continue;
    const referencias = toReferencias(entry.references);
    causas.push(
      mlCausaSchema.parse({
        code,
        causaId: toCausaId(entry.cause_id),
        tipo: toTipo(entry.type),
        departamento: entry.department ?? null,
        mensagem,
        referencias,
        campos: resolveCampos(referencias, mensagem, attributesSent),
      }),
    );
  }
  return causas.slice(0, MAX_CAUSAS);
}

/* ------------------------------- rendering ------------------------------- */

/** One `errors[]` line, so that array alone is diagnosable without the structure. */
export function formatCausaLinha(causa: MlCausa): string {
  const head = [causa.tipo, causa.code].filter((p) => p != null && p.length > 0).join(' · ');
  const tail = causa.referencias.length > 0 ? ` [${causa.referencias.join(', ')}]` : '';
  return `${head.length > 0 ? `${head} — ` : ''}${causa.mensagem}${tail}`;
}

/**
 * `JSON.stringify`, capped. Copied in spirit from `respond.ts`'s `safeJson`: its
 * only two failure modes are a circular structure and a BigInt, both
 * `TypeError`, so the narrowing is complete rather than convenient.
 */
function cappedJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    if (json == null || json === '{}') return null;
    return json.length > MAX_RAW_BODY ? `${json.slice(0, MAX_RAW_BODY)}…` : json;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/**
 * Whatever the body says that the headline does NOT already say.
 *
 * `api.ts` folds `message ?? error_description ?? error` into `err.message`, so
 * echoing those keys back would print the same sentence twice. Anything whose
 * value is already inside the headline is dropped; if nothing is left, there is
 * no tail — an unrecognised body is worth persisting, a repetition is not.
 */
function rawBodyTail(body: unknown, fallbackMessage: string): string | null {
  if (body == null) return null;
  if (typeof body === 'string') {
    if (body.length === 0 || fallbackMessage.includes(body)) return null;
    return body.slice(0, MAX_RAW_BODY);
  }
  if (typeof body !== 'object' || Array.isArray(body)) return cappedJson(body);

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const asText = typeof value === 'string' || typeof value === 'number' ? String(value) : null;
    if (asText != null && fallbackMessage.includes(asText)) continue;
    rest[key] = value;
  }
  return cappedJson(rest);
}

/**
 * What to persist in the link doc's `errors[]`.
 *
 * With causes: one readable line each. Without: the headline PLUS a capped dump
 * of whatever ML did send, because the whole complaint is that a body ML wrote
 * something in came back as a bare `ML 400: Validation error` — an unrecognised
 * shape must still leave a trace on the document, not only in the log stream.
 */
export function buildErrorLines(
  err: unknown,
  causas: readonly MlCausa[],
  fallbackMessage: string,
): string[] {
  if (causas.length > 0) return causas.map(formatCausaLinha);
  const tail = err instanceof MercadoLivreHttpError ? rawBodyTail(err.body, fallbackMessage) : null;
  return tail == null ? [fallbackMessage] : [fallbackMessage, tail];
}

/**
 * The two link-doc fields that describe a failure. Always written together.
 *
 * A `type` and not an `interface`: the link writers take a
 * `Record<string, unknown>` patch, and only a type alias gets TypeScript's
 * implicit index signature — an interface would force a spread at every site.
 */
export type FalhaPatch = {
  errors: string[];
  causas: MlCausa[];
};

/**
 * The whole failure diagnosis as a link-doc patch, so the two fields can never
 * drift apart: `errors` is the Flutter-visible `string[]` (root `CLAUDE.md`
 * dual-run) and `causas` the structure the editor highlights fields from.
 *
 * Spread it — `{ estado: 'E', ...falhaPatch(err, err.message), ultimaModificacao }`.
 * {@link CLEAR_FALHA} is its counterpart on every path that heals a listing.
 */
export function falhaPatch(
  err: unknown,
  fallbackMessage: string,
  attributesSent: readonly AttributeLike[] | null = null,
): FalhaPatch {
  const causas = parseMlCausas(err, attributesSent);
  return { errors: buildErrorLines(err, causas, fallbackMessage), causas };
}

/**
 * The healed counterpart of {@link falhaPatch}, for every path that clears a
 * listing's diagnosis — a successful publish, the stock writeback,
 * `itemsStatusSync`, `reverificarAnuncio`, an import.
 *
 * Clearing one of the two fields without the other is the failure mode this
 * exists to prevent: a `causas` entry outliving its `errors` paints a red field
 * on a healthy listing, which is indistinguishable from a fresh rejection.
 *
 * A function rather than a shared constant so each call site owns its arrays —
 * a spread copies the object but not the empty arrays inside it, and one caller
 * pushing into a plan it built would corrupt every other.
 */
export function clearFalha(): FalhaPatch {
  return { errors: [], causas: [] };
}
