import { DocumentReference } from 'firebase-admin/firestore';

/**
 * Rebind every `DocumentReference` in a source document to the TARGET database.
 *
 * A reference is the one Firestore value bound to a database instance: the Admin
 * SDK serialises it as `projects/<p>/databases/<d>/documents/<path>`, so a legacy
 * reference written verbatim into the new project would keep pointing at the
 * legacy database. Every other value — Timestamp, GeoPoint, Bytes, VectorValue,
 * primitives — is database-agnostic and passes through untouched.
 *
 * ⚠️ Confirm on the seed import what the MANAGED import does with reference
 * values (functions/DEPLOY.md, rehearsal checks). The mirror must end in the same
 * shape the import produces, or documents changed after T0 would differ from the
 * ones that were not.
 *
 * Known, accepted drift: the Admin SDK writes an integer-valued JS number as an
 * integer, so a legacy double such as `5.0` comes back as integer `5`. Firestore
 * compares numbers numerically across the two, and the schemas read both as
 * `number`.
 */
export function rebindReferences(value: unknown, toTargetRef: (path: string) => unknown): unknown {
  if (value instanceof DocumentReference) return toTargetRef(value.path);
  if (Array.isArray(value)) return value.map((v) => rebindReferences(v, toTargetRef));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = rebindReferences(v, toTargetRef);
    return out;
  }
  return value;
}

/** A map value as the SDK returns it — never a class instance such as Timestamp. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
