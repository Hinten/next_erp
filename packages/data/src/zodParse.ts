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

/**
 * Validate a document on write. Throws on a missing/invalid field; unknown
 * extra fields are stripped (Zod's default object behavior), so bad data never
 * lands in Firestore. This is the single enforcement point both the client
 * converter and the admin handle delegate to.
 */
export function parseForWrite<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> {
  return schema.parse(data) as z.infer<T>;
}

/**
 * Validate a partial patch for a merge write (`set(..., { merge: true })`).
 *
 * `.partial()` makes every field optional, so only the fields actually present
 * are validated. We then keep ONLY the keys the caller supplied: the optional
 * wrapper already short-circuits absent keys before any `.default()` fires, and
 * this guarantees a schema default can never leak into a merge patch (which
 * would silently overwrite a stored field — e.g. NFe's `tpEmis`/`estado`).
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
    schema as unknown as { partial(): { parse(data: unknown): unknown } }
  ).partial();
  const validated = partialSchema.parse(patch) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    // Drop keys that validated to `undefined`: Firestore rejects `undefined`
    // in write payloads (unless `ignoreUndefinedProperties` is set), and a
    // merge patch never means to write one. `null` is kept — it stores fine.
    if (key in validated && validated[key] !== undefined) {
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
