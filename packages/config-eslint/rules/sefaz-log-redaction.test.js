import { describe, expect, it } from 'vitest';

import { gitGrep } from './lib/repo-scan.js';

/**
 * Every live SEFAZ suite must print through `logSefaz` / `descreverSefaz`, never
 * a raw `console.*` carrying `xMotivo`.
 *
 * ## Why this guard exists
 *
 * **This repository is PUBLIC, so every Actions log is public.** SEFAZ writes
 * fiscal identifiers into the free-text `xMotivo`: the rejection behind #1471
 * reads *"CNPJ <do emitente> do Emitente não cadastrado na Receita Federal"*.
 * Twelve hand-rolled `console.log`s across five files printed `xMotivo`
 * verbatim, so the emitente's CNPJ was published on every failing run.
 *
 * ⚠️ Nothing failed. Not lint, not a test, not review — the leak is in the
 * log's CONTENT, not its shape, and no gate reads a log. That is exactly the
 * class of convention this directory exists to enforce.
 *
 * ## Why a repo scan and not an ESLint rule
 *
 * The files span TWO workspaces (`packages/integrations/nfe/test` and
 * `apps/nfe/test`), so an ESLint rule would have to be enabled in both configs
 * — and flat config REPLACES a rule by name rather than merging, so a workspace
 * that later redeclares the same key silently drops it (root `CLAUDE.md` rule
 * 6 records that exact footgun). One scan, one file, no config drift.
 *
 * ## What it does NOT catch
 *
 * A log that interpolates some OTHER provider text carrying an identifier —
 * `err.message` from a rejected SOAP call, say. The mitigation is convention:
 * provider text goes through `redigirIdentificadores`. Widening the pattern to
 * every `console.*` in a test file was rejected: the live suites legitimately
 * log TLS bundle paths, cStats and protocol numbers, and a guard with that many
 * false positives trains people to add exemptions without reading them.
 */

/**
 * The live suites, plus the shared test helpers they call — `resolve-protocol.ts`
 * polls `consultarLote` and logs each attempt, so it holds a real SEFAZ response
 * exactly like a suite does and was missed by a suites-only pathspec.
 *
 * `sefaz-log.ts` is excluded because it DEFINES the redaction; it is the one
 * place a `console.log` of `xMotivo` is correct.
 */
const PATHSPECS = [
  '*.homologacao.test.ts',
  '*.staging.test.ts',
  'packages/integrations/nfe/test/helpers/*.ts',
  // Symmetric with the glob above. Nothing in apps/nfe's helper directory logs
  // a SEFAZ response today, but the reasoning that pulled `resolve-protocol.ts`
  // in applies identically to the other workspace, and an asymmetric guard is
  // one someone has to notice.
  'apps/nfe/test/helpers/*.ts',
  ':(exclude)packages/integrations/nfe/test/helpers/sefaz-log.ts',
  ':(exclude)packages/config-eslint/rules/*',
];

/**
 * A `console.*` call and a redacted SEFAZ free-text field on the SAME line.
 *
 * ⚠️ BOTH fields, not just `xMotivo`. `descreverSefaz` redacts `xMsg` too, and
 * correctly — it is SEFAZ's supplementary free text and carries the same class
 * of content. A guard naming only `xMotivo` left the `xMsg`-only half of the
 * shape re-introducible, and that half is not hypothetical: it is almost
 * exactly the `detalhe` string this PR deletes from `svc.homologacao.test.ts`.
 * `cMsg` is deliberately absent — it is a bare numeric code with nothing to
 * redact, so requiring it here would only add false positives.
 *
 * ⚠️ Line-scoped on purpose. `git grep` has no multi-line mode here, and every
 * offending site in the repo was a single-line template literal — the shape
 * this bans. A multi-line `console.log(\n  \`…xMotivo…\`\n)` slips through;
 * `descreverSefaz` being the ergonomic option is what keeps that theoretical.
 */
const PATTERN = 'console\\.[a-z]+\\(.*(xMotivo|xMsg)';

/**
 * Files allowed to print a raw `xMotivo`.
 *
 * Empty, and it should stay that way: `logSefaz` covers every shape the suites
 * need, including `prot.cStat` and `cMsg`/`xMsg`. An entry here is a claim that
 * some site cannot redact — write down why.
 */
const ISENTOS = new Set([]);

describe('live SEFAZ logs redact fiscal identifiers', () => {
  it('has no live suite printing a raw xMotivo through console.*', () => {
    const ofensores = gitGrep({
      patterns: PATTERN,
      pathspecs: PATHSPECS,
      mode: 'extended',
    }).filter((f) => !ISENTOS.has(f));

    expect(
      ofensores,
      [
        'These live suites print a raw `xMotivo` to a PUBLIC Actions log.',
        '',
        'SEFAZ embeds fiscal identifiers in that free text — the #1471 rejection',
        'reads "CNPJ <do emitente> do Emitente não cadastrado na Receita Federal",',
        'and printing it verbatim published the emitente CNPJ on every failing run.',
        '',
        'Use the helper instead:',
        '',
        "  import { logSefaz } from '../helpers/sefaz-log';",
        "  logSefaz('SVC-AN protNFe', { cStat, xMotivo });",
        '',
        '⚠️ The ASSERTION MESSAGE needs it too — a vitest message lands in the CI',
        'annotation, which is the same public surface:',
        '',
        "  expect(cStat, descreverSefaz('SVC-AN protNFe', { cStat, xMotivo })).toBe('100');",
        '',
        '⚠️ Do NOT drop `xMotivo` to satisfy this. A bare cStat is what dead-ended',
        'the 999 (#1247) and the 178 (#1471); the RULE is the diagnostic, the digits',
        'are not. `redigirIdentificadores` keeps every explaining word.',
        '',
        'Offending files:',
        ...ofensores.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('lists no STALE exemption', () => {
    const comXMotivo = new Set(
      gitGrep({ patterns: PATTERN, pathspecs: PATHSPECS, mode: 'extended' }),
    );
    const obsoletos = [...ISENTOS].filter((f) => !comXMotivo.has(f));
    expect(
      obsoletos,
      `These files no longer print a raw xMotivo — drop them from ISENTOS:\n${obsoletos
        .map((f) => `  - ${f}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('CONTROL — the pattern actually matches the shape it bans', () => {
    // Guards against the guard silently matching nothing (a regex typo, a
    // pathspec that stopped matching). If this ever fails, the scan above is
    // vacuous and the whole file is decoration.
    expect(PATTERN).toMatch(/console/);
    expect('  console.log(`[svc] cStat=${a} xMotivo="${b}"`);').toMatch(new RegExp(PATTERN));
    // The `xMsg`-only half — the shape a guard naming just `xMotivo` missed.
    expect('  console.log(`cMsg=${a} xMsg="${b}"`);').toMatch(new RegExp(PATTERN));
    expect("  logSefaz('svc', { cStat, xMotivo });").not.toMatch(new RegExp(PATTERN));
    expect("  logSefaz('svc', { cStat, xMotivo, cMsg, xMsg });").not.toMatch(new RegExp(PATTERN));
  });
});
