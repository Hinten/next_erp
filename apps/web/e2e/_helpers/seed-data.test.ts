import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { e2ePrefix, filialSeedCnpj, fixtureClienteCnpj } from './seed-data';

/**
 * Backstop for the fixture-namespace shape (`e2e-<runId>-w<worker>-<tag>`).
 *
 * Both the worker segment and its POSITION are load-bearing, and neither has a
 * visible symptom until a suite is retried — see the doc comment on
 * `e2ePrefix`. Every case below is phrased as the question that actually
 * matters: *would this prefix's cleanup sweep delete that prefix's documents?*
 *
 * ⚠️ Every case stubs BOTH env vars. `GITHUB_RUN_ID` is set in CI and absent
 * locally, and `TEST_WORKER_INDEX` is the reverse (Playwright sets it, Vitest
 * does not) — a test reading either from the ambient environment would assert
 * something different on a laptop than on a runner.
 */
const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** High Unicode code point — mirrors `PREFIX_MAX` in `seed-data.ts`. */
const PREFIX_MAX = String.fromCharCode(0xffff);

afterEach(() => {
  vi.unstubAllEnvs();
});

function prefixFor(worker: string | undefined, tag: string): string {
  vi.stubEnv('GITHUB_RUN_ID', '999');
  vi.stubEnv('TEST_WORKER_INDEX', worker);
  return e2ePrefix(tag);
}

function cnpjFor(worker: string | undefined): string {
  vi.stubEnv('GITHUB_RUN_ID', '999');
  vi.stubEnv('TEST_WORKER_INDEX', worker);
  return fixtureClienteCnpj();
}

/**
 * Independent mod-11 CNPJ check — deliberately NOT reusing `validTestCnpj` (the
 * function under test) nor `validateCNPJ` from `@delfrance/core/documents` (the
 * implementation the seeder's consumers run). Both would make this assert that
 * an implementation agrees with itself; the point is to assert the RULE.
 *
 * ⚠️ Alphanumeric-aware, and it has to be. This used to gate on `/^\d{14}$/`
 * with `Number(digits[k])`, so it answered `false` for a perfectly VALID alfa
 * CNPJ — a backstop that would have failed a correct seed and passed an
 * incorrect one. The rule since RFB IN 2.229/2024: the first 12 positions may
 * be `[0-9A-Z]`, the two check digits stay numeric, and every character enters
 * the sum as `charCode - 48` (identical to its value for `0-9`, which is why
 * numeric CNPJs are unaffected).
 */
function isValidCnpj(cnpj: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj)) return false;
  // ⚠️ Repdigits are banned by the rule, not by the checksum. `00000000000000`
  // computes DVs of `00` and would otherwise pass here — then be rejected by
  // the schema the seeded documents are read through, which is the worst place
  // to find out. Every other repdigit (`11111111111111` and friends) fails the
  // mod-11 anyway, so this guard earns its keep on exactly one value.
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const dv = (chars: string, weights: number[]): number => {
    const sum = weights.reduce((acc, w, k) => acc + (chars.charCodeAt(k) - 48) * w, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const base = cnpj.slice(0, 12);
  return (
    String(dv(base, w1)) === cnpj[12] && String(dv(`${base}${cnpj[12]}`, [6, ...w1])) === cnpj[13]
  );
}

/**
 * Would `cleanupByFieldPrefix(_, 'nome', sweepPrefix)` delete a document seeded
 * under `otherPrefix`? Models the real query — `nome >= p && nome < p+￿` —
 * against a representative seeded name, which is always `${prefix}-<suffix>`.
 */
function sweepDeletes(sweepPrefix: string, otherPrefix: string): boolean {
  const nome = `${otherPrefix}-pro`;
  return nome >= sweepPrefix && nome < `${sweepPrefix}${PREFIX_MAX}`;
}

/** Every `e2ePrefix('<tag>')` argument used under `e2e/`, deduped. */
function readTags(): string[] {
  const tags = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.auth') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(/e2ePrefix\('([^']+)'\)/g)) {
        tags.add(m[1]!);
      }
    }
  };
  walk(E2E_DIR);
  return [...tags].sort();
}

describe('e2ePrefix', () => {
  it('is scoped by run id, then worker, then tag', () => {
    expect(prefixFor('3', 'chk')).toBe('e2e-999-w3-chk');
  });

  it('defaults the worker segment outside a Playwright worker', () => {
    expect(prefixFor(undefined, 'chk')).toBe('e2e-999-w0-chk');
  });

  it('still starts with the run-level sweep prefix', () => {
    // `sweepCurrentRunFixtures` and `reclaimPredecessorRun` match on
    // `e2e-<runId>-`; a worker that dies before `afterAll` is reclaimed only if
    // this stays true.
    expect(prefixFor('3', 'chk').startsWith('e2e-999-')).toBe(true);
  });

  it("does not let a retry's sweep reach the attempt that replaced it", () => {
    // Playwright gives every retry a fresh worker index and does NOT serialize
    // the dying worker's `afterAll` against the new worker's `beforeAll`. If
    // the two share a namespace, the late sweep deletes the freshly re-seeded
    // fixtures and the retry loads a pedido whose produto no longer exists.
    const attempt1 = prefixFor('3', 'chk');
    const attempt2 = prefixFor('5', 'chk');

    expect(sweepDeletes(attempt1, attempt2)).toBe(false);
    expect(sweepDeletes(attempt2, attempt1)).toBe(false);
  });

  it('keeps a single-digit worker clear of a double-digit one', () => {
    // THE assertion that makes the ordering load-bearing. The sweep is a
    // `>= p && < p+￿` range, i.e. a plain startsWith. Tag-LAST, worker 3's
    // prefix `e2e-999-chk-w3` is a string prefix of worker 31's
    // `e2e-999-chk-w31`, so w3's cleanup deletes w31's fixtures. Worker-FIRST,
    // the `-` before the tag bounds the range and they stay disjoint.
    //
    // Reachable in practice: the worker index counts up across retries, not
    // just to `workers: 4` — run 31718522686 was already handing out w5 and w6.
    const single = prefixFor('3', 'chk');
    const double = prefixFor('31', 'chk');

    expect(sweepDeletes(single, double)).toBe(false);
    expect(sweepDeletes(double, single)).toBe(false);
  });

  it('keeps prefix-colliding tags apart across workers', () => {
    // `ped` is a string prefix of `pedpag`, so with a run-scoped-only prefix
    // `pedidos.vendas`'s cleanup deleted `pedidos-pagamento.vendas`'s produtos
    // out from under it whenever the two ran concurrently.
    //
    // Hard-coded rather than derived: this pair is the positive control and
    // must keep failing even if every real tag is later renamed.
    const short = prefixFor('1', 'ped');
    const long = prefixFor('2', 'pedpag');

    expect(sweepDeletes(short, long)).toBe(false);
  });

  /**
   * ⚠️ Every FILIAL CNPJ the seeder writes must be checksum-valid, and the
   * reason is not tidiness. Since #1619 `filialFormSchema` carries a checksum,
   * so a filial seeded with an invalid CNPJ cannot be saved back through the
   * form — and the symptom surfaces far away from here: `filiais.cadastros`'s
   * "edits a filial and saves" went red on the CNPJ field while editing the
   * Nome Fantasia, a test that has nothing to do with CNPJs. The seeder used
   * `String(10000000000000 + i)` and three hand-written literals, none of them
   * real CNPJs.
   *
   * Checked with `isValidCnpj` above — this file's deliberately independent
   * mod-11 implementation, so this asserts against the RULE rather than
   * against `validTestCnpj` agreeing with itself.
   */
  describe('seeded filial CNPJs are checksum-valid', () => {
    it('the generated ones, across the seeded range', () => {
      const seen = new Set<string>();
      for (let i = 1; i <= 20; i += 1) {
        const cnpj = filialSeedCnpj(i);
        expect(cnpj, `filialSeedCnpj(${i})`).toHaveLength(14);
        expect(isValidCnpj(cnpj), `filialSeedCnpj(${i}) = ${cnpj}`).toBe(true);
        seen.add(cnpj);
      }
      // Distinct per filial: a 14-digit seed would collapse them all to
      // `0000000000xx`, since `validTestCnpj` keeps only the LAST 12 chars.
      expect(seen.size).toBe(20);
    });

    it('every hand-written cnpj literal in the seeder', () => {
      const src = readFileSync(join(E2E_DIR, '_helpers', 'seed-data.ts'), 'utf8');
      // ⚠️ `[0-9A-Z]`, not `\d`. The harvest used to be digits-only, which made
      // this backstop blind to exactly the case it now has to catch: an
      // alphanumeric literal was not FAILED, it was silently skipped, so an
      // invalid alfa CNPJ would have sailed through into the seeds.
      const literals = [...src.matchAll(/\bcnpj: '([0-9A-Z]+)'/g)].map((m) => m[1]!);
      // Anti-vacuity: a regex that matched nothing would assert over an empty
      // list. Three filial literals live in the seeder today.
      //
      // ⚠️ The scan is deliberately FILE-WIDE, not filial-scoped. Every `cnpj:`
      // literal here happens to be a filial today, but the checksum rule is the
      // same for any of them, and narrowing the regex to filial call sites would
      // re-open the blind spot this test exists to close. Note `cpf_cnpj:` is
      // NOT harvested — `\b` does not fire between `_` and `c` — so a CPF is
      // excluded by accident rather than by design. Do not rely on that: a
      // 14-character `cpf_cnpj:` literal would go unchecked.
      expect(literals.length).toBeGreaterThanOrEqual(3);
      for (const cnpj of literals) {
        expect(isValidCnpj(cnpj), `seed-data.ts carries an invalid CNPJ: ${cnpj}`).toBe(true);
      }
    });

    it('the harvest itself sees an alphanumeric literal', () => {
      // ⚠️ Guards the guard. The assertion above cannot distinguish "every
      // literal is valid" from "the regex matched nothing alphanumeric", and
      // that indistinguishability WAS the bug. So pin the harvest against a
      // synthetic source: an invalid alfa literal must be found, and must fail.
      const fakeSrc = "  cnpj: '12ABC678000X99',\n  cnpj: '99999999999962',\n";
      const literals = [...fakeSrc.matchAll(/\bcnpj: '([0-9A-Z]+)'/g)].map((m) => m[1]!);
      expect(literals).toEqual(['12ABC678000X99', '99999999999962']);
      expect(isValidCnpj('12ABC678000X99')).toBe(false);
    });

    it('accepts a checksum-valid ALPHANUMERIC CNPJ', () => {
      // The other half of the near-miss pair: the widened validator must not
      // just stop rejecting letters, it must compute the right DVs for them.
      //
      // ⚠️ The expected values are LITERALS, deliberately. Deriving them here
      // with a copy of the same `dv` would pin `isValidCnpj` against a
      // transcription of itself — the exact objection this file's JSDoc raises
      // about reusing `validateCNPJ`. Both literals below are checked against
      // the rule: base `12ABC6780001` weighted by ASCII-48 gives DV1 0, then
      // `12ABC67800010` gives DV2 7. `12ABC34501DE35` is RFB's own published
      // alphanumeric example from IN 2.229/2024.
      expect(isValidCnpj('12ABC678000107')).toBe(true);
      expect(isValidCnpj('12ABC34501DE35')).toBe(true);
      // A one-character near-miss on the check digits must stay rejected.
      expect(isValidCnpj('12ABC678000108')).toBe(false);
      // …and so must a near-miss in the alfa body, which changes the sum.
      expect(isValidCnpj('12ABD678000107')).toBe(false);
      // Lowercase is not a valid CNPJ character, and must not be folded in.
      expect(isValidCnpj('12abc678000107')).toBe(false);
    });

    it('rejects the all-zero CNPJ even though it satisfies the checksum', () => {
      // `00000000000000` computes DVs of `00`, so only the repdigit ban stops
      // it. Pinned separately because it is the single value where this
      // validator would otherwise disagree with `@delfrance/core`'s
      // `validateCNPJ`, and a backstop that disagrees with the schema its
      // seeds are read through is worse than no backstop.
      expect(isValidCnpj('00000000000000')).toBe(false);
    });
  });

  it('has no run-scoped-only cliente CNPJ left in the seeder', () => {
    // The identity axis does NOT go through `e2ePrefix`, so worker-scoping doc
    // ids does not worker-scope the CNPJ. Every fixture cliente must go through
    // `fixtureClienteCnpj()`; a raw `validTestCnpj(runDigits(…))` would hand all
    // ~8 vendas-lane specs the same CNPJ again.
    const src = readFileSync(join(E2E_DIR, '_helpers', 'seed-data.ts'), 'utf8');
    expect(src).toContain('fixtureClienteCnpj');
    expect(src.match(/validTestCnpj\(runDigits\(/g)).toBeNull();
  });

  it('keeps every real prefix-colliding tag pair apart across workers', () => {
    const tags = readTags();
    // Anti-vacuity: a regex that silently matched nothing would make the loop
    // below assert over an empty list.
    expect(tags.length).toBeGreaterThan(40);

    const pairs = tags.flatMap((a) =>
      tags.filter((b) => b !== a && b.startsWith(a)).map((b) => [a, b] as const),
    );
    expect(pairs.length).toBeGreaterThan(0);

    for (const [short, long] of pairs) {
      const shortPrefix = prefixFor('1', short);
      const longPrefix = prefixFor('2', long);

      expect(
        sweepDeletes(shortPrefix, longPrefix),
        `'${short}' sweep would delete '${long}' fixtures (${shortPrefix} ⊃ ${longPrefix}-pro)`,
      ).toBe(false);
    }
  });
});

describe('fixtureClienteCnpj', () => {
  it('gives each worker a distinct CNPJ', () => {
    // `checkClienteDuplicates` matches `cpf_cnpj` exactly, so two live clientes
    // sharing one CNPJ both land in the blocking list and `.first()` stops
    // being this spec's own fixture.
    const seen = ['0', '1', '2', '3', '31'].map(cnpjFor);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('is stable for a given run + worker', () => {
    // The spec asserts against the value its own seed wrote; a per-call value
    // would never match.
    expect(cnpjFor('2')).toBe(cnpjFor('2'));
  });

  it('stays a checksum-valid CNPJ, including a double-digit worker', () => {
    for (const w of ['0', '7', '31', undefined]) {
      const cnpj = cnpjFor(w);
      expect(isValidCnpj(cnpj), `${String(w)} -> ${cnpj}`).toBe(true);
    }
  });
});
