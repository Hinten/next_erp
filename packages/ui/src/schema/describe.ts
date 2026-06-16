import type { ZodTypeAny } from 'zod';

/**
 * Structured form of `z.describe()`. A schema can describe itself with
 * either a plain string (treated as the label) or a JSON object encoding
 * richer hints — collection references, kind overrides, etc.
 */
export interface ParsedDescription {
  label?: string;
  hint?: string;
  kind?: string;
  /** Collection name for `kind: 'reference'`. */
  collection?: string;
  /** Epoch unit for `kind: 'datetime'` (set by the schema datetime builders). */
  unit?: 'ms' | 'us';
}

/**
 * Parse a Zod `.describe()` string. Accepts either a plain label or a JSON
 * object. Invalid JSON is treated as a plain label string (so consumers can
 * still attach human notes without worrying about quoting).
 */
export function parseZodDescription(zodType: ZodTypeAny): ParsedDescription {
  // Zod 4 exposes `description` as a public getter on the schema instance.
  const raw = (zodType as { description?: string }).description;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  // Convention: anything starting with `{` is JSON, otherwise plain label.
  if (raw.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as ParsedDescription;
      }
    } catch {
      // Fall through to plain-string handling — describe() may legitimately
      // contain a curly brace in prose.
    }
  }
  return { label: raw };
}
