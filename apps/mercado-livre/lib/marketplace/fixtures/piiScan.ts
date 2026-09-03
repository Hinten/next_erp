/**
 * The independent check on the committed `__wire__/` corpus.
 *
 * Two layers, because neither alone is enough and they fail differently:
 *
 * 1. **Redaction fixpoint** (`redactionResidue`). Re-run {@link redactWireBody}
 *    over an already-committed body; if anything changes, a denylisted path
 *    reached the repository unredacted. This is the strong layer — it needs no
 *    guess about what the value looked like, so it catches a real street address
 *    and a synthetic one identically.
 * 2. **Free-text patterns** (`patternFindings`). A CPF typed into a
 *    `comment`, a buyer email inside a claim message — data in a key no
 *    denylist can anticipate, because the key is not the problem, the prose is.
 *
 * ⚠️ **A finding NEVER carries the matched value.** It carries the path and the
 * kind. This module's whole population is "text we suspect is personal", and its
 * output goes to a CI log and a test failure message — #1015 is this repository's
 * worked example of a raw body reaching a log stream. Reporting
 * `buyer.email :: email` is enough to fix it; reporting the address is the leak
 * the scanner exists to prevent.
 *
 * ⚠️ **There is deliberately no bare-11-digit CPF pattern.** An unpunctuated CPF
 * is indistinguishable from an ML resource id (`2000018143664980`,
 * `47868202073`), which appear in every fixture — the rule would fire on
 * hundreds of correct values and be switched off within a day. Unpunctuated
 * documents are covered by PATH instead, via `['identification', 'number']` in
 * the denylist, which is exact where a regex can only be lucky.
 */
import { type WireValue, redactWireBody } from './redact';

export interface PiiFinding {
  /** Dotted path; array indices appear as `*`. */
  readonly path: string;
  /** What tripped: a denylisted path that survived, or a free-text pattern. */
  readonly kind: 'unredacted-path' | 'email' | 'cpf' | 'cnpj' | 'phone';
}

/**
 * Placeholders {@link redactWireBody} itself produces. `patternFindings` has to
 * skip them or the scanner reports its own output as a leak.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'redacted@example.invalid',
  'REDACTED',
  'Rua Redacted',
  'Rua Redacted, 0',
]);

const PATTERNS: readonly { readonly kind: PiiFinding['kind']; readonly re: RegExp }[] = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'cpf', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/ },
  { kind: 'cnpj', re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/ },
  { kind: 'phone', re: /\(\d{2}\)\s?\d{4,5}-\d{4}/ },
];

function deepEqual(a: WireValue, b: WireValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i] as WireValue));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    // ⚠️ Both arms are already known non-array (the check above returns), but TS
    // does not narrow two operands jointly — hence the explicit records.
    const ao = a as Record<string, WireValue>;
    const bo = b as Record<string, WireValue>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(ao[k] as WireValue, bo[k] as WireValue));
  }
  return false;
}

/**
 * Every path where re-redacting an already-committed body would still change
 * something — i.e. a denylisted leaf that was never redacted.
 */
export function redactionResidue(value: WireValue): PiiFinding[] {
  const findings: PiiFinding[] = [];
  const redacted = redactWireBody(value);

  function compare(before: WireValue, after: WireValue, path: readonly string[]): void {
    if (Array.isArray(before) && Array.isArray(after)) {
      before.forEach((entry, i) => compare(entry, after[i] as WireValue, [...path, '*']));
      return;
    }
    if (
      before !== null &&
      after !== null &&
      typeof before === 'object' &&
      typeof after === 'object'
    ) {
      const antes = before as Record<string, WireValue>;
      const depois = after as Record<string, WireValue>;
      for (const key of Object.keys(antes)) {
        compare(antes[key] as WireValue, depois[key] as WireValue, [...path, key]);
      }
      return;
    }
    if (!deepEqual(before, after)) findings.push({ path: path.join('.'), kind: 'unredacted-path' });
  }

  compare(value, redacted, []);
  return findings;
}

/** Free-text pattern hits, skipping this module's own placeholders. */
export function patternFindings(value: WireValue): PiiFinding[] {
  const findings: PiiFinding[] = [];

  function walk(node: WireValue, path: readonly string[]): void {
    if (node === null) return;
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, [...path, '*']));
      return;
    }
    if (typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) walk(entry, [...path, key]);
      return;
    }
    if (typeof node !== 'string' || PLACEHOLDER_VALUES.has(node)) return;
    for (const { kind, re } of PATTERNS) {
      if (re.test(node)) findings.push({ path: path.join('.'), kind });
    }
  }

  walk(value, []);
  return findings;
}

/** Both layers, for a single body. Empty means the body is safe to commit. */
export function scanForPii(value: WireValue): PiiFinding[] {
  return [...redactionResidue(value), ...patternFindings(value)];
}

/** A stable one-line-per-finding report. Carries paths and kinds, never values. */
export function formatFindings(file: string, findings: readonly PiiFinding[]): string {
  return findings.map((f) => `${file}  ${f.path || '<root>'} :: ${f.kind}`).join('\n');
}
