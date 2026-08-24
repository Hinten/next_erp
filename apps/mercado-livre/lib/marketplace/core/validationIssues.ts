/**
 * Turning a Zod failure into a log line that names the culprit, without leaking
 * what failed to parse.
 *
 * ## Why this module exists at all
 *
 * Two separate problems, both worked examples in this repo.
 *
 * **1. The value under inspection is often a secret.** `parseOk` in the plugin
 * puts the RAW RESPONSE BODY on `MercadoLivreValidationError` for a non-JSON
 * response, and a Zod issue can carry the offending input. #1015 is the worked
 * example: a validation failure on the OAuth exchange turned out to be carrying
 * the token response into Cloud Logging. Paths and codes are the whole
 * diagnostic value and carry nothing sensitive.
 *
 * **2. The path is what identifies the field, and it is the first thing lost.**
 * Node's `util.inspect` defaults to depth 2, and an issue's `path` sits at depth
 * 3 (error → `issues[]` → issue → `path`). So the one field that names the
 * culprit prints as `path: [Array]`. That is exactly how the #1087 payment
 * failure reached the log: `expected: 'number'` with no way to tell WHICH of
 * `mlPaymentSchema`'s numeric fields ML had quoted. The information existed and
 * was thrown away at print time. Serialize with `JSON.stringify`, never inspect.
 *
 * ⚠️ **Next-free on purpose.** `./respond.ts` would be the natural home — it
 * already had the only copy of this logic — but it imports `next/server`, and the
 * nested Cloud Functions codebase (`functions/src/processNotification.ts`) is the
 * surface where the #1087 error actually surfaced. A shared helper both can reach
 * must not drag Next into the functions bundle.
 */

import { MercadoLivreValidationError } from '@delfrance/integrations-mercado-livre';
import { z } from 'zod';

/**
 * Zod issue PATHS and codes — never the issue objects themselves, and never the
 * input.
 *
 * `refresh_token: invalid_type` or `order_id: invalid_type` is the whole
 * diagnostic: it names the field, which is what turns "formato inesperado" from
 * true-and-useless into actionable.
 */
export function validationPaths(issues: unknown): readonly string[] {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    // ⚠️ Guard the ELEMENT, not just the array. `issues` is typed `unknown` on
    // `MercadoLivreValidationError` (it also holds a raw body string, and in
    // `parseTestUser` a plain `string[]`), and destructuring a `null` entry
    // throws a TypeError — from inside a catch block, where it would replace a
    // handled failure with a worse one. A helper whose whole job is to make a
    // failure legible must not be able to cause a bigger failure.
    if (typeof issue !== 'object' || issue === null) return '(desconhecido)';
    const { path, code } = issue as { path?: unknown; code?: unknown };
    const caminho = Array.isArray(path) && path.length > 0 ? path.join('.') : '(raiz)';
    return `${caminho}: ${typeof code === 'string' ? code : 'desconhecido'}`;
  });
}

/**
 * The field names behind a schema failure, or `null` when `err` is not one.
 *
 * Covers both classes that can carry Zod issues on this channel: the plugin's
 * `MercadoLivreValidationError` (raised by `parseOk` when an ML RESPONSE does not
 * match its schema) and a bare `ZodError` (raised by a `collection.parse` on the
 * way INTO Firestore). Returning `null` rather than `[]` lets a caller tell "not a
 * validation failure" from "a validation failure with no legible path".
 */
export function describeValidationFailure(err: unknown): readonly string[] | null {
  if (err instanceof MercadoLivreValidationError) return validationPaths(err.issues);
  if (err instanceof z.ZodError) return validationPaths(err.issues);
  return null;
}
