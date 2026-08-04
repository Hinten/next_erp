import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The two root env templates stay split by SENSITIVITY, and the secrets one stays
 * blank.
 *
 * `.env.example` used to be 316 lines carrying both populations — non-secret config
 * (URLs, regions, flags, the ~20 ML sync tunables) and credential material (OAuth
 * client secrets, HMAC keys, the service account, the A1 cert password and its
 * at-rest encryption key) — separated only by prose, and inconsistent prose at
 * that. The split makes the safe set enumerable; this test is what keeps it that
 * way when the next variable is added to whichever file is open at the time.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const CONFIG_TEMPLATE = '.env.example';
const SECRETS_TEMPLATE = '.env.secrets.example';

/**
 * Suffixes that mark a name as credential material. Anchored at the END of the key:
 * `NEXT_PUBLIC_FIREBASE_API_KEY` deliberately does NOT match (`_KEY` is not on the
 * list, `PRIVATE_KEY` and `ENC_KEY` are), because it is public by design — `next
 * build` inlines it into the browser bundle.
 */
const SECRET_SUFFIX_RE = /(SECRET|PASSWORD|_TOKEN|PRIVATE_KEY|CERT_BASE64|ENC_KEY)$/;

/**
 * Keys that LOOK like credentials by name but are not, and therefore stay in the
 * config template. Empty today, on purpose: every current secret-suffixed name is a
 * real secret. An entry here needs a one-line justification next to it — the bar is
 * "the value is safe in a Cloud Run env var and in a log line".
 */
const CONFIG_ALLOW_LIST = new Set([]);

/**
 * `KEY=value` lines only — comments and blanks are not declarations.
 *
 * Split on `/\r?\n/`, never on `'\n'`. A Windows checkout with `core.autocrlf=true`
 * smudges these templates to CRLF, and a `'\n'` split then leaves a trailing `\r` on
 * every line. `\r` is a JS LineTerminator, so `.` does not match it: `(.*)` cannot
 * consume it and the — non-multiline — `$` never reaches end-of-string. EVERY line
 * fails to match and this returns `[]`.
 *
 * That is worse than the one red test it produced. The other three assertions here
 * iterate what this returns, so on an empty array they passed VACUOUSLY: the backstop
 * quietly stopped biting for every local developer while staying green in CI, whose
 * checkout is LF. A guard that only runs where nobody is looking is not a guard.
 *
 * `parseEnvText` is split out from the file read so the regression test below can feed
 * CRLF directly, rather than depending on how git happened to check this file out.
 */
function parseEnvText(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) entries.push({ key: match[1], value: match[2] });
  }
  return entries;
}

function parseKeys(relPath) {
  return parseEnvText(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

describe('parseEnvText line endings', () => {
  it('parses CRLF input identically to LF input', () => {
    const lf = 'A_KEY=value\n# a comment, not a declaration\nB_KEY=\n';
    const crlf = lf.replaceAll('\n', '\r\n');
    const expected = [
      { key: 'A_KEY', value: 'value' },
      { key: 'B_KEY', value: '' },
    ];

    expect(parseEnvText(lf)).toEqual(expected);
    // Equality with `expected`, not merely with the LF result: a parser that kept the
    // `\r` in the VALUE would satisfy "found the keys" while making `SOME_KEY=x\r`
    // compare unequal to `'x'` — the same silent-mismatch class, one layer down.
    expect(parseEnvText(crlf)).toEqual(expected);
  });
});

describe('env template split', () => {
  it('both templates exist and declare something', () => {
    expect(parseKeys(CONFIG_TEMPLATE).length).toBeGreaterThan(0);
    expect(parseKeys(SECRETS_TEMPLATE).length).toBeGreaterThan(0);
  });

  it('no credential-shaped key is declared in .env.example', () => {
    const offenders = parseKeys(CONFIG_TEMPLATE)
      .map((entry) => entry.key)
      .filter((key) => SECRET_SUFFIX_RE.test(key) && !CONFIG_ALLOW_LIST.has(key));

    expect(
      offenders,
      [
        `These belong in ${SECRETS_TEMPLATE}, not ${CONFIG_TEMPLATE} — a reader uses`,
        'the config template as the menu of "what is safe to put in a plain .env",',
        'and anything in a deploy artifact is uploaded to the gcf-sources bucket and',
        'baked in plaintext into the Cloud Run revision:',
        ...offenders.map((key) => `  - ${key}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('every value in .env.secrets.example is blank', () => {
    const offenders = parseKeys(SECRETS_TEMPLATE)
      .filter((entry) => entry.value.trim() !== '')
      .map((entry) => entry.key);

    expect(
      offenders,
      [
        `${SECRETS_TEMPLATE} is COMMITTED. It must never carry a value — not a real`,
        'one, and not a plausible-looking placeholder either (the next reader cannot',
        'tell the two apart, and a fake secret that gets deployed fails in a way that',
        'looks like a real one). Blank these out:',
        ...offenders.map((key) => `  - ${key}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('no key is declared in both templates', () => {
    const configKeys = new Set(parseKeys(CONFIG_TEMPLATE).map((entry) => entry.key));
    const duplicated = parseKeys(SECRETS_TEMPLATE)
      .map((entry) => entry.key)
      .filter((key) => configKeys.has(key));

    expect(
      duplicated,
      [
        'A key declared in both templates is ambiguous — the `cat` that builds',
        '.env.local would emit it twice and the LAST one silently wins. Keep each',
        'name in exactly one file:',
        ...duplicated.map((key) => `  - ${key}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
