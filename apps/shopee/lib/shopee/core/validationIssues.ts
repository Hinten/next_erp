/**
 * Turning a schema failure into a log line that names the culprit, without
 * leaking what failed to parse. Port of
 * `apps/mercado-livre/lib/marketplace/core/validationIssues.ts`.
 *
 * ## Why it exists on this channel too
 *
 * **1. The value under inspection is often the credential itself.** Shopee's
 * token endpoint answers with `access_token`/`refresh_token` FLAT beside the
 * envelope, so a parse failure there is a failure over a live credential — the
 * exact #1015 shape, where a validation failure on an OAuth exchange carried the
 * token response into Cloud Logging. Paths and codes are the whole diagnostic
 * value and carry nothing sensitive.
 *
 * **2. The path is the first thing lost at print time.** Node's `util.inspect`
 * defaults to depth 2 and a Zod issue's `path` sits at depth 3, so the one field
 * that names the culprit prints as `path: [Array]`. Serialize with
 * `JSON.stringify`, never inspect.
 *
 * ⚠️ **Next-free on purpose.** `./respond.ts` would be the natural home, but it
 * imports `next/server`, and step 3's nested Cloud Functions codebase will need
 * this helper without dragging Next into its bundle.
 */
import { ShopeeSchemaError } from '@delfrance/integrations-shopee';
import { z } from 'zod';

/**
 * What a field path looks like once joined: `access_token`,
 * `authed_shop_list[].shop_id`, `(raiz)`. Deliberately excludes whitespace,
 * quotes and braces, so neither prose nor a JSON fragment can pass as one.
 */
const PATH_LIKE = /^[A-Za-z0-9_.[\]()-]{1,64}$/;

/**
 * Zod issue PATHS and codes — never the issue objects, and never the input.
 *
 * ⚠️ Guards the ELEMENT, not just the array. Callers pass `unknown` here from
 * inside a `catch`, and destructuring a `null` entry throws a `TypeError` that
 * would replace a handled failure with a worse one. A helper whose whole job is
 * to make a failure legible must not be able to cause a bigger failure.
 *
 * ⚠️ The path-shaped-string arm comes FIRST, because `ShopeeSchemaError.campos`
 * is already an array of computed paths (`lerRespostaJson` built them precisely
 * so nothing sensitive can ride along). Falling through to the object guard
 * would turn `['access_token']` into `['(desconhecido)']` — destroying the one
 * shape that was safe by construction. But NOT any string: an arbitrary text
 * entry is echoed nowhere, it degrades to `(desconhecido)`.
 */
export function validationPaths(issues: unknown): readonly string[] {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    if (typeof issue === 'string') return PATH_LIKE.test(issue) ? issue : '(desconhecido)';
    if (typeof issue !== 'object' || issue === null) return '(desconhecido)';
    const { path, code } = issue as { path?: unknown; code?: unknown };
    const caminho = Array.isArray(path) && path.length > 0 ? path.join('.') : '(raiz)';
    return `${caminho}: ${typeof code === 'string' ? code : 'desconhecido'}`;
  });
}

/**
 * The field names behind a schema failure, or `null` when `err` is not one.
 *
 * Covers both classes that can carry them on this channel: the package's
 * `ShopeeSchemaError` (raised when a Shopee RESPONSE does not match its schema,
 * carrying `campos` — paths already) and a bare `z.ZodError` (raised by a
 * `collection.parse` on the way INTO Firestore). `null` rather than `[]` lets a
 * caller tell "not a validation failure" from "one with no legible path".
 */
export function describeValidationFailure(err: unknown): readonly string[] | null {
  if (err instanceof ShopeeSchemaError) return validationPaths(err.campos);
  if (err instanceof z.ZodError) return validationPaths(err.issues);
  return null;
}
