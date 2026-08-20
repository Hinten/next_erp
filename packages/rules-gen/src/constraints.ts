import { z } from 'zod';

/**
 * Zod schema → per-field rules clauses, via the public `z.toJSONSchema`
 * bridge (`io: 'output'` — the output type IS the wire shape, since
 * `parseForWrite` applies no transforms).
 *
 * Every clause uses the `d.get('<field>', null)` form so the old project's
 * bypass lessons fall out structurally:
 *   - required field removed via deleteField(): the after-image lacks the
 *     key, affectedKeys() contains it, `get(..., null)` yields null and the
 *     type check denies;
 *   - nullable field removed: the `== null ||` arm passes;
 *   - legacy doc updating an unrelated field: `!c.hasAny([...])`
 *     short-circuits, so docs predating a schema keep updating.
 *
 * Presence-on-create is deliberately NOT enforced. ⚠️ The stated reason — a
 * coexisting Flutter app creating docs in these collections — is VOID (no dual
 * run; root `CLAUDE.md` rule 8). It still holds for the migrated corpus, whose
 * docs omit fields Zod fills via `.default()`; whether CREATE should now be
 * tightened is an open question, not a settled design.
 */
export interface FieldClause {
  field: string;
  /** Parenthesized rules expression, already guarded by `!c.hasAny([...]) ||`. */
  expr: string;
}

type JsonSchema = Record<string, unknown>;

const NOISE_INT_BOUND = 9007199254740991; // Number.MAX_SAFE_INTEGER, added by z.int()

export function clausesForSchema(schema: z.ZodTypeAny): FieldClause[] {
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as JsonSchema;
  const properties = json.properties as Record<string, JsonSchema> | undefined;
  if (json.type !== 'object' || !properties) {
    throw new Error('validator whitelist entries must be object schemas');
  }
  const clauses: FieldClause[] = [];
  for (const field of Object.keys(properties).sort()) {
    const prop = properties[field];
    if (!prop) continue;
    const ref = `d.get('${field}', null)`;
    const expr = exprForProperty(ref, prop);
    if (expr === null) continue;
    clauses.push({ field, expr: `(!c.hasAny(['${field}']) || ${expr})` });
  }
  return clauses;
}

/**
 * Constraint expression for one JSON-schema property, or null to skip the
 * field (unconstrained/unsupported shapes — skipping is always safe, it just
 * validates less).
 */
function exprForProperty(ref: string, prop: JsonSchema): string | null {
  // `.nullable()` emits `anyOf: [inner, { type: 'null' }]`.
  const anyOf = prop.anyOf as JsonSchema[] | undefined;
  if (anyOf) {
    const nonNull = anyOf.filter((m) => m.type !== 'null');
    if (nonNull.length === anyOf.length) return null; // not a nullable wrapper — skip unions
    if (nonNull.length !== 1 || !nonNull[0]) return null;
    const inner = exprForProperty(ref, nonNull[0]);
    if (inner === null) return null;
    return `(${ref} == null || ${inner})`;
  }

  // Datetime fields are skipped entirely. ⚠️ The stated reason — a coexisting
  // Flutter app writing real Timestamps to the same documents, which `is string`
  // would brick — is VOID (no dual run; root `CLAUDE.md` rule 8). This app writes
  // ISO strings, so nothing validates datetimes today for a reason that no longer
  // applies. Tightening it changes the generated ruleset, so it is its own change,
  // not a drive-by edit here.
  if (prop.format === 'date-time') return null;

  if (Array.isArray(prop.enum)) {
    const values = (prop.enum as unknown[]).map(literal).join(', ');
    return `${ref} in [${values}]`;
  }
  if (prop.const !== undefined) return `${ref} == ${literal(prop.const)}`;

  switch (prop.type) {
    case 'string': {
      const parts = [`${ref} is string`];
      // maxLength only — regex `pattern`s are dropped (expression budget) and
      // minLength adds little once the type+size shape is enforced.
      if (typeof prop.maxLength === 'number') parts.push(`${ref}.size() <= ${prop.maxLength}`);
      return parts.join(' && ');
    }
    case 'integer': {
      const parts = [`${ref} is int`];
      if (typeof prop.minimum === 'number' && Math.abs(prop.minimum) < NOISE_INT_BOUND) {
        parts.push(`${ref} >= ${prop.minimum}`);
      }
      if (typeof prop.maximum === 'number' && Math.abs(prop.maximum) < NOISE_INT_BOUND) {
        parts.push(`${ref} <= ${prop.maximum}`);
      }
      return parts.length > 1 ? `(${parts.join(' && ')})` : parts[0]!;
    }
    case 'number': {
      const parts = [`${ref} is number`];
      if (typeof prop.minimum === 'number') parts.push(`${ref} >= ${prop.minimum}`);
      if (typeof prop.exclusiveMinimum === 'number') {
        parts.push(`${ref} > ${prop.exclusiveMinimum}`);
      }
      if (typeof prop.maximum === 'number') parts.push(`${ref} <= ${prop.maximum}`);
      return parts.length > 1 ? `(${parts.join(' && ')})` : parts[0]!;
    }
    case 'boolean':
      return `${ref} is bool`;
    case 'array':
      // No recursion into items — list-shape only (expression budget).
      return `${ref} is list`;
    case 'object':
      return `${ref} is map`;
    default:
      // `{}` (z.unknown/z.any via unrepresentable:'any') and anything else.
      return null;
  }
}

function literal(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`unsupported literal in enum/const: ${JSON.stringify(value)}`);
}
