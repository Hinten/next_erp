import { z } from 'zod';

/**
 * Path-context object used to fill `{name}` placeholders in collection paths
 * (e.g. `clientes/{clienteId}/enderecos`). Apps pass whatever IDs they need
 * for the path being resolved.
 */
export type PathContext = Record<string, string | undefined>;

/**
 * Resolve `{name}` placeholders in a Firestore collection-path template from a
 * context object. Shared by the client (`defineCollection`) and admin
 * (`defineAdminCollection`) handles so both resolve paths identically.
 */
export function resolvePath(template: string, ctx: PathContext): string {
  return template.replaceAll(/\{(\w+)\}/g, (_match, key: string) => {
    const v = ctx[key];
    if (!v) {
      throw new Error(`Path "${template}" requires "${key}" in context.`);
    }
    return v;
  });
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a document on write. Throws on a missing/invalid field AND on any
 * unknown top-level field (a typo or wrong field name), so bad data never lands
 * in Firestore. This is the single enforcement point both the client converter
 * and the admin handle delegate to.
 *
 * Schemas that deliberately opt into `.passthrough()` (legacy Flutter /
 * marketplace coexistence) are respected automatically: they never strip a key,
 * so the strict re-check below never fires and their unknown fields pass through
 * as before. Plain `z.object` (strip-policy) schemas reject unknown keys.
 */
export function parseForWrite<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> {
  const parsed = schema.parse(data);
  if (
    schema instanceof z.ZodObject &&
    isPlainRecord(data) &&
    isPlainRecord(parsed)
  ) {
    // If the (strip-policy) schema dropped a key the caller supplied, re-parse
    // strictly so they get a proper ZodError (`unrecognized_keys`) naming it.
    // `Object.hasOwn` (not `in`) so prototype keys like `toString`/`__proto__`
    // can't masquerade as known and slip past the strict re-check.
    const dropped = Object.keys(data).filter((k) => !Object.hasOwn(parsed, k));
    if (dropped.length > 0) {
      return (
        schema as unknown as { strict(): { parse(d: unknown): unknown } }
      ).strict().parse(data) as z.infer<T>;
    }
  }
  return parsed as z.infer<T>;
}

/**
 * Validate a partial patch for a merge write (`set(..., { merge: true })`).
 *
 * `.partial()` makes every field optional, so only the fields actually present
 * are validated. Unknown keys (typos) throw a ZodError on strip-policy schemas;
 * `.passthrough()` schemas keep them, so the strict re-check never fires. We
 * then keep ONLY the keys the caller supplied and drop any that validated to
 * `undefined` (Firestore rejects `undefined`); a schema default can never leak
 * into a merge patch (which would silently overwrite a stored field — e.g.
 * NFe's `tpEmis`/`estado`).
 */
export function parseMergePatch<T extends z.ZodTypeAny>(
  schema: T,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) {
    throw new TypeError('parseMergePatch requires a ZodObject schema.');
  }
  // Cast through a minimal structural type to avoid fighting Zod's generic
  // signatures; the runtime `instanceof` guard above proves it's a ZodObject.
  const partialSchema = (
    schema as unknown as {
      partial(): {
        parse(data: unknown): unknown;
        strict(): { parse(d: unknown): unknown };
      };
    }
  ).partial();
  const validated = partialSchema.parse(patch) as Record<string, unknown>;
  // If the (strip-policy) schema dropped a supplied key, re-parse strictly so
  // the caller gets a ZodError naming the unknown key(s). Passthrough schemas
  // keep unknown keys, so nothing is dropped and this never fires. Use
  // `Object.hasOwn` (not `in`) so prototype keys can't bypass the check.
  const dropped = Object.keys(patch).filter((k) => !Object.hasOwn(validated, k));
  if (dropped.length > 0) {
    partialSchema.strict().parse(patch);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    // Drop keys that validated to `undefined`: Firestore rejects `undefined`
    // in write payloads (unless `ignoreUndefinedProperties` is set), and a
    // merge patch never means to write one. `null` is kept — it stores fine.
    // `Object.hasOwn` (not `in`) so an inherited prototype value (e.g. a
    // function) can never be copied into the Firestore payload.
    if (Object.hasOwn(validated, key) && validated[key] !== undefined) {
      out[key] = validated[key];
    }
  }
  return out;
}

/**
 * Soft-parse on read: log instead of throw, returning the raw data on mismatch
 * so fields can be migrated without bricking the UI when old documents don't
 * yet match the schema.
 */
export function parseSoftRead<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  path: string,
): z.infer<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data as z.infer<T>;
  // eslint-disable-next-line no-console
  console.warn(`[data] schema mismatch on ${path}`, result.error.issues);
  return raw as z.infer<T>;
}
