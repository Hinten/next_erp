/**
 * The independent check on the committed `__wire__/` corpus.
 *
 * Two layers, because neither alone is enough and they fail differently:
 *
 * 1. **Redaction fixpoint** (`redactionResidue`). Re-run {@link redactWireBody}
 *    over an already-committed body; anything that CHANGES is a denylisted path
 *    that reached the repository unredacted. This is the strong layer — it needs
 *    no guess about what the value looked like, so it catches a real street
 *    address and a synthetic one identically, and it catches a path added to the
 *    denylist AFTER the corpus was written.
 * 2. **Free-text patterns** (`patternFindings`). A CPF typed into
 *    `message_to_seller`, an e-mail inside a cancel reason — data in a key no
 *    denylist can anticipate, because the key is not the problem, the prose is.
 *
 * ⚠️ **A finding NEVER carries the matched value.** It carries the path and the
 * kind. This module's whole population is "text we suspect is personal", and its
 * output goes to a CI log and a test failure message — #1015 is this
 * repository's worked example of a raw body reaching a log stream. Reporting
 * `response.order_list.*.recipient_address.name :: unredacted-path` is enough to
 * fix it; reporting the name is the leak the scanner exists to prevent.
 *
 * ⚠️ **A `masked` finding is INFORMATIONAL and never a failure.** Shopee's own
 * documentation sample ships `P******n` / `******64`, the SG sandbox order ships
 * `"****"`, and those strings are the evidence the masking predicate is written
 * against — `redact.ts` keeps them on purpose. The kind exists so the corpus can
 * REPORT how many masked leaves it holds, which is a fact about Shopee, not a
 * defect in the fixture.
 */
import { validateCNPJ } from '@delfrance/core/documents';

import { type WireValue, ehValorMascarado, redactWireBody } from './redact';

export interface PiiFinding {
  /** Dotted path; array indices appear as `*`. */
  readonly path: string;
  /** What tripped: a denylisted path that survived, or a free-text pattern. */
  readonly kind: 'unredacted-path' | 'email' | 'cpf' | 'cnpj' | 'phone' | 'endereco' | 'masked';
}

/** The findings that FAIL a corpus. `masked` is deliberately not among them. */
export const KINDS_QUE_REPROVAM: readonly PiiFinding['kind'][] = [
  'unredacted-path',
  'email',
  'cpf',
  'cnpj',
  'phone',
  'endereco',
];

/**
 * Placeholders {@link redactWireBody} itself produces. `patternFindings` has to
 * skip them or the scanner reports its own output as a leak — `'00000000000'` is
 * eleven digits and `'Rua Redacted, 0'` is a street address by shape.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'REDACTED',
  'Rua Redacted, 0',
  'https://redacted.invalid/imagem',
  '00000000',
  '00000000000',
  '00000000000000',
  '000000',
  '0'.repeat(44),
]);

interface Padrao {
  readonly kind: PiiFinding['kind'];
  readonly re: RegExp;
  /**
   * When present, a match counts only where this confirms it — for the one
   * shape that cannot be told from an id by its characters alone.
   */
  readonly confirma?: (casado: string) => boolean;
}

/**
 * ⚠️ **The bare-digit CPF/CNPJ patterns are the one place this scanner diverges
 * from Mercado Livre's**, which refuses them because an unpunctuated CPF is
 * indistinguishable from an ML resource id. The divergence is deliberate and
 * narrow: these patterns only ever see STRING leaves, and every Shopee id in
 * this corpus (`item_id`, `model_id`, `order_item_id`, `line_item_id`,
 * `promotion_id`, `logistics_channel_id`) arrives as a JSON **number**. The
 * residual is a Shopee page that ever QUOTES an id of exactly 11 or 14 digits:
 * that is a loud false positive on a fixture, reviewed by hand and never fixed
 * by deleting the pattern, which is the only cover an unpunctuated document has
 * in free text.
 *
 * ⚠️ **The ALPHANUMERIC CNPJ cannot ride that argument** (RFB IN 2.229/2024:
 * `[0-9A-Z]{12}[0-9]{2}`, the two check digits still numeric). `order_sn` and
 * `package_number` are STRINGS of exactly that shape — `260910KJBHUJ12` is
 * twelve `[0-9A-Z]` then two digits — so "every Shopee id arrives as a number"
 * stops being true the moment letters are allowed, and roughly one `order_sn`
 * in thirteen ends in two digits. An earlier revision of this paragraph offered
 * "naming its path here" as the remedy; there was never a mechanism for it, and
 * a path allow-list is the wrong one anyway — it would have to grow with every
 * 14-character uppercase SKU.
 *
 * So the letter-bearing rule additionally requires **valid mod-11 check
 * digits**, which is the only thing that separates a CNPJ from any other
 * 14-character id. It costs the scanner nothing real: the Receita issues no
 * CNPJ with wrong DVs, so a document that actually leaked passes it by
 * construction. ⚠️ The purely numeric rule stays UNCONDITIONAL — it is the
 * pre-alfa rule byte for byte, and putting the checksum on it too would quietly
 * stop reporting a fabricated-looking `\d{14}` this corpus used to catch.
 */
const PATTERNS: readonly Padrao[] = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'cpf', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/ },
  { kind: 'cpf', re: /(?<!\d)\d{11}(?!\d)/ },
  // Punctuated, alfa-aware: no Shopee id is ever written this way, so the shape
  // decides on its own.
  { kind: 'cnpj', re: /\b[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}\/[0-9A-Z]{4}-[0-9]{2}\b/ },
  { kind: 'cnpj', re: /(?<!\d)\d{14}(?!\d)/ },
  {
    kind: 'cnpj',
    // ⚠️ The `(?=[0-9A-Z]*[A-Z])` keeps this rule DISJOINT from the numeric one
    // above — without it a purely numeric CNPJ files the same finding twice. It
    // cannot see past the fourteenth character, because the trailing
    // `(?![0-9A-Z])` is what ends the run.
    re: /(?<![0-9A-Z])(?=[0-9A-Z]*[A-Z])[0-9A-Z]{12}[0-9]{2}(?![0-9A-Z])/,
    confirma: validateCNPJ,
  },
  { kind: 'phone', re: /\(\d{2}\)\s?\d{4,5}-\d{4}/ },
  {
    kind: 'endereco',
    re: /\b(?:rua|avenida|av\.|travessa|alameda|rodovia|estrada|pra[cç]a)\s+\p{L}[\p{L}\d\s.'-]*,\s*\d+/iu,
  },
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

/**
 * Does any occurrence of `re` in `texto` satisfy `confirma`? Not the first one:
 * a line can carry an id and a document, and testing only the leading match
 * would let the id hide the document behind it.
 *
 * ⚠️ The `g` flag is built HERE, per call, and never stored on the shared
 * `PATTERNS` entry — `RegExp.test` on a global regex advances `lastIndex`, so a
 * reused one answers differently on alternate nodes.
 */
function algumCasoConfirmado(
  re: RegExp,
  texto: string,
  confirma: (casado: string) => boolean,
): boolean {
  for (const [casado] of texto.matchAll(new RegExp(re.source, `${re.flags}g`))) {
    if (confirma(casado)) return true;
  }
  return false;
}

/** Free-text pattern hits, plus the informational `masked` count. */
export function patternFindings(value: WireValue): PiiFinding[] {
  const findings: PiiFinding[] = [];

  function walk(node: WireValue, path: readonly string[]): void {
    if (node === null) return;
    if (Array.isArray(node)) {
      node.forEach((entry) => walk(entry, [...path, '*']));
      return;
    }
    if (typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) walk(entry, [...path, key]);
      return;
    }
    if (typeof node !== 'string' || PLACEHOLDER_VALUES.has(node)) return;
    if (ehValorMascarado(node)) {
      // ⚠️ Reported, never a failure — see the module header.
      findings.push({ path: path.join('.'), kind: 'masked' });
      // ⚠️ And it does NOT return: a value can be masked AND carry something
      // else beside the stars (`'CPF 123.456.789-09 (****)'`). Stopping here
      // would make one `*` anywhere a way to hide every other pattern.
    }
    for (const { kind, re, confirma } of PATTERNS) {
      const bateu = confirma ? algumCasoConfirmado(re, node, confirma) : re.test(node);
      if (bateu) findings.push({ path: path.join('.'), kind });
    }
  }

  walk(value, []);
  return findings;
}

/** Both layers, for a single body. */
export function scanForPii(value: WireValue): PiiFinding[] {
  return [...redactionResidue(value), ...patternFindings(value)];
}

/** Only what makes a corpus UNSAFE to commit — `masked` filtered out. */
export function scanForPiiReprovavel(value: WireValue): PiiFinding[] {
  return scanForPii(value).filter((f) => KINDS_QUE_REPROVAM.includes(f.kind));
}

/** A stable one-line-per-finding report. Carries paths and kinds, never values. */
export function formatFindings(file: string, findings: readonly PiiFinding[]): string {
  return findings.map((f) => `${file}  ${f.path || '<root>'} :: ${f.kind}`).join('\n');
}
