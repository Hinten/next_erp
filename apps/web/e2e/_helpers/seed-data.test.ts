import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { e2ePrefix } from './seed-data';

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
