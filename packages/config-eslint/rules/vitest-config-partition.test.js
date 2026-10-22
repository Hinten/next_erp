// Every test file in the repo is collected by EXACTLY ONE vitest config — and,
// where a workspace splits its suites across several configs, by the RIGHT one.
//
// ## The trap this closes
//
// A workspace with an emulator (or staging) suite carries two or more vitest
// configs, disjoint BY GLOB: the offline `vitest.config.ts` EXCLUDES a suffix
// (`*.tasks.test.ts`, `*.firestore.test.ts`, …) that another config INCLUDES.
// Nothing checked that the globs actually partition the files, and every way they
// stop doing it is silent:
//
//  - ZERO configs: the file runs in no job. Shopee's offline config excluded
//    `*.firestore.test.ts` for months while no config included it, so the first
//    token-store suite (step 22, #1530) would have been collected by nobody and
//    every lane would still have reported green.
//  - TWO configs: the emulator suite is ALSO collected offline, where it skips
//    for lack of an emulator — and vitest exits 0, because its success check
//    counts COLLECTED files, not executed tests.
//  - The WRONG one: drop the offline exclude AND revert the emulator include,
//    and the file lands in exactly one config — the offline one, skip-green. Only
//    the per-workspace routing table below can tell that apart from correct.
//
// ## How
//
// Membership comes from VITEST'S OWN MATCHER — `createVitest(...)` loads each
// config exactly as `vitest run --config` would, and `TestProject.matchesTestGlob`
// applies its resolved include/exclude. No glob is re-implemented here, so this
// test cannot disagree with vitest about a pattern. Nothing RUNS: `setupFiles` are
// never loaded, so the emulator lanes' fail-loud gates stay silent even with `CI`
// set. Configs and test files are discovered with `git ls-files`, never listed by
// hand, so the next channel app is covered the moment its config exists.
//
// ⚠️ Every ANCESTOR workspace's configs are matched, not just the nearest: a
// future `apps/x/functions/vitest.config.ts` beside a parent config whose include
// still reaches `functions/**` would put the file in two configs. No config
// directory nests inside another today, so only `alvosDoConfig`'s synthetic case
// can tell that apart from a nearest-only scan.
//
// ⚠️ ENV ISOLATION. Loading a config runs its code. `loadRepoRootEnv`
// (`@delfrance/config-vitest/env`) would read the repo-root `.env` and
// `.env.local`, Vite would read each app's own `.env*`, and vitest copies MODE /
// DEV / PROD / BASE_URL / SSR into `process.env`. So the scan sets the loader's
// opt-out (`DELFRANCE_VITEST_CONFIG_SCAN=1`), points Vite at an EMPTY `envDir`,
// and restores `process.env` after every config. A test below pins the opt-out
// and the restore; the empty `envDir` leaves nothing observable to pin.
//
// Test files OUTSIDE every vitest workspace (`.claude/hooks`, `.codex`) are not
// vitest's at all: they must sit in a pnpm workspace whose `test` script is a
// `node --test` whose OWN patterns reach them, or they too run nowhere —
// `node --test *.test.mjs` never runs `lib/x.test.mjs` or `x.test.ts`.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';

import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * A vitest config file, by basename. The pathspec below is loose on purpose
 * (`*` crosses `/` in a git pathspec, so it also matches
 * `packages/config-vitest/eslint.config.mjs`); this anchors it.
 */
const CONFIG_RE = /(?:^|\/)vitest(?:\.[a-z0-9-]+)?\.config\.[cm]?[jt]s$/;

/** The default (offline) config of a workspace, by basename. */
const PADRAO_RE = /^vitest\.config\.[cm]?[jt]s$/;

/** The test-file universe. `*.spec.*` is Playwright's (`apps/web/e2e`), not vitest's. */
const TESTES = [
  '*.test.ts',
  '*.test.tsx',
  '*.test.mts',
  '*.test.cts',
  '*.test.js',
  '*.test.jsx',
  '*.test.mjs',
  '*.test.cjs',
];

/** `foo.tasks.test.ts` → `tasks`; `foo.test.ts` → no suffix. */
const SUFIXO_RE = /\.([a-z0-9-]+)\.test\.[cm]?[jt]sx?$/;

/**
 * Suffix → config, for EVERY workspace with two or more configs. A file whose
 * suffix is not a key belongs to that workspace's default `vitest.config.*`.
 *
 * ⚠️ Per workspace, never global: `apps/web/lib/reports/productLocation.firestore.test.ts`
 * and `apps/melhor-envio/lib/freight/notificacao.firestore.test.ts` are MOCK suites
 * whose name only says `.firestore.`, correctly collected offline in single-config
 * workspaces. A new multi-config workspace must add its row (a test below reds
 * until it does), which is exactly the moment someone has to say how it splits.
 */
const ROTAS = {
  'apps/amazon': { tasks: 'vitest.tasks.config.ts', firestore: 'vitest.tasks.config.ts' },
  'apps/functions': { storage: 'vitest.storage.config.ts' },
  'apps/loja-integrada': { tasks: 'vitest.tasks.config.ts', firestore: 'vitest.tasks.config.ts' },
  'apps/mercado-livre': {
    firestore: 'vitest.firestore.config.ts',
    tasks: 'vitest.tasks.config.ts',
    staging: 'vitest.staging.config.ts',
  },
  'apps/shopee': { tasks: 'vitest.tasks.config.ts', firestore: 'vitest.tasks.config.ts' },
  'apps/whatsapp': { firestore: 'vitest.firestore.config.ts' },
  'packages/rules-gen': { rules: 'vitest.rules.config.ts' },
};

/** The `loadRepoRootEnv` opt-out. `packages/config-vitest/env.js` must test this exact string. */
const OPT_OUT = 'DELFRANCE_VITEST_CONFIG_SCAN';

/**
 * What a bare `node --test` (no file argument) runs: Node's own default
 * patterns, the JavaScript half ONLY. From Node 22.18 / 23.6 type stripping is on
 * by default and the defaults also take `*.test.{cts,mts,ts}` and friends — but
 * `engines.node` is `>=22`, and a pattern that some supported Node does NOT run
 * is a silent pass, so a `.ts` file under a bare `node --test` reds here instead.
 */
const NODE_TEST_PADRAO = [
  '**/*.test.{cjs,mjs,js}',
  '**/*-test.{cjs,mjs,js}',
  '**/*_test.{cjs,mjs,js}',
  '**/test-*.{cjs,mjs,js}',
  '**/test.{cjs,mjs,js}',
  '**/test/**/*.{cjs,mjs,js}',
];

/**
 * Synthetic paths matched through the SAME matcher, beside the real files. Each
 * pins a verdict a vacuous matcher could not produce: one that answered "true"
 * for everything fails the first, one that answered "false" fails the other two.
 */
const CANARIOS = {
  'apps/shopee/scripts/__canario__.test.ts': [],
  'apps/shopee/lib/__canario__.firestore.test.ts': ['apps/shopee/vitest.tasks.config.ts'],
  'apps/mercado-livre/lib/__canario__.firestore.test.ts': [
    'apps/mercado-livre/vitest.firestore.config.ts',
  ],
};

/* -------------------------------------------------------------------------- */
/*                        The pure core (unit-tested below)                    */
/* -------------------------------------------------------------------------- */

/** `apps/x/vitest.config.ts` → `apps/x`; a root config → `.`. */
const dirDe = (/** @type {string} */ config) => path.posix.dirname(config);

/**
 * Every config DIRECTORY that is an ancestor of `file`, nearest first. Git paths
 * are POSIX on every platform, and they are compared as raw strings.
 * @param {string} file
 * @param {readonly string[]} dirs
 */
export function ancestrais(file, dirs) {
  return dirs
    .filter((d) => d === '.' || file.startsWith(`${d}/`))
    .sort((a, b) => b.length - a.length);
}

/**
 * Each config → the files the scan must ASK it about: every file under its
 * directory, so a file is matched against EVERY ancestor workspace's configs,
 * never only the nearest one's (the header's ⚠️).
 * @param {readonly string[]} configs
 * @param {readonly string[]} files
 * @returns {Map<string, string[]>}
 */
export function alvosDoConfig(configs, files) {
  return new Map(
    configs.map((c) => {
      const d = dirDe(c);
      return [c, files.filter((f) => d === '.' || f.startsWith(`${d}/`))];
    }),
  );
}

/** `a{b,c}d` → `abd`, `acd` — innermost first, so nesting expands too. */
function expandirChaves(/** @type {string} */ glob) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (m === null) return [glob];
  const [antes, depois] = [glob.slice(0, m.index), glob.slice(m.index + m[0].length)];
  return m[1].split(',').flatMap((alt) => expandirChaves(`${antes}${alt}${depois}`));
}

/**
 * One brace-free glob → an anchored RegExp, or `null` when it uses syntax this
 * reader does not model (`[…]`, `!`, extglob `(…)`), which then reaches NOTHING
 * — a false refusal is loud, a false "it runs" is the silent pass. NODE's glob
 * semantics: `*` and `?` never cross `/` nor match a leading `.` (the shell's
 * agree), and a whole `**` segment crosses any number of non-hidden
 * directories, none included. ⚠️ That `**` is Node's ONLY — POSIX `sh` has no
 * globstar, so {@link nodeTestCobre} rewrites an UNQUOTED pattern's `**` to `*`
 * before it gets here. (A trailing `**` is read as `*`: stricter, so loud.)
 */
function globParaRe(/** @type {string} */ glob) {
  if (/[[\]()!{}]/.test(glob)) return null;
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const oculto = i === 0 || glob[i - 1] === '/' ? '(?!\\.)' : '';
    if (oculto !== '' && glob.startsWith('**/', i)) {
      re += '(?:(?!\\.)[^/]+/)*';
      i += 2;
    } else if (glob[i] === '*') re += `${oculto}[^/]*`;
    else if (glob[i] === '?') re += `${oculto}[^/]`;
    else re += glob[i].replace(/[.+^$|\\]/, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does the `test` script `script` — run, as pnpm runs it, from the package
 * directory — reach the file at package-relative `rel`? Only a PLAIN
 * `node --test [--flags] [patterns]` is read: its patterns, or Node's defaults
 * ({@link NODE_TEST_PADRAO}) when it names none. Anything else — another
 * command, a shell operator, a glob syntax {@link globParaRe} does not model —
 * answers `false`, so the check refuses what it cannot read rather than waving
 * it through. ⚠️ A flag's SEPARATE value (`--test-reporter spec`) reads as a
 * pattern that matches nothing; write `--flag=value`.
 *
 * ⚠️ QUOTING decides whose glob a pattern is. pnpm runs the script through
 * `sh -c` on the ubuntu runner, so an UNQUOTED pattern is the shell's glob
 * first, and POSIX `sh` has no globstar: its `**` is a plain `*`, ONE directory.
 * Measured (the pinning test spells the commands — a block comment cannot):
 * unquoted, it ran `sub/x.test.mjs` and neither `a.test.mjs` nor
 * `sub/deep/a.test.mjs`; QUOTED, the pattern reaches Node intact and Node's `**`
 * ran all three. So an unquoted `**` reads as `*` — never
 * wider: when the shell's glob matches NOTHING it passes the pattern through
 * literally and Node globs it fully after all (also measured), so the real run
 * is a superset of this reading, which can therefore only refuse loudly. That
 * fallback is why the reading must not follow it: one file landing one
 * directory down flips the run from "every depth" to "that depth only".
 * @param {string} script
 * @param {string} rel
 */
export function nodeTestCobre(script, rel) {
  const m = /^node --test(?:\s+(.*))?$/s.exec(script);
  if (m === null || /[;&|<>`$]/.test(script)) return false;
  const padroes = (m[1] ?? '')
    .split(/\s+/)
    .filter((t) => t !== '' && !t.startsWith('-'))
    .map((t) => {
      const aspas = /^(['"])(.*)\1$/.exec(t);
      const glob = aspas === null ? t.replace(/\*{2,}/g, '*') : aspas[2];
      return glob.replace(/^\.\//, '');
    });
  return (padroes.length > 0 ? padroes : NODE_TEST_PADRAO)
    .flatMap(expandirChaves)
    .some((g) => globParaRe(g)?.test(rel) === true);
}

/**
 * The config a file in a ROUTED workspace must land in, or `null` when the
 * workspace has no row (single-config workspaces are checked by count alone).
 * @param {string} file
 * @param {string} dono the file's nearest config directory
 * @param {readonly string[]} configs
 * @param {Record<string, Record<string, string>>} rotas
 */
export function configEsperado(file, dono, configs, rotas) {
  const rota = rotas[dono];
  if (rota === undefined) return null;
  const sufixo = SUFIXO_RE.exec(path.posix.basename(file))?.[1];
  const roteado = sufixo !== undefined ? rota[sufixo] : undefined;
  if (roteado !== undefined) return `${dono}/${roteado}`;
  return (
    configs.find((c) => dirDe(c) === dono && PADRAO_RE.test(path.posix.basename(c))) ??
    `${dono}/vitest.config.ts`
  );
}

/**
 * Every partition violation, grouped. PURE: membership and the `node --test`
 * lookup arrive as arguments, so the near misses are tested without mutating a
 * real config or committing a stray file. These tests cover THIS function's
 * side of them; the lookup's own refusal arms ({@link foraDoVitestReal},
 * {@link nodeTestCobre}) are tested beside it.
 *
 * @param {{
 *   testes: readonly string[],
 *   configs: readonly string[],
 *   membros: ReadonlyMap<string, readonly string[]>,
 *   rotas: Record<string, Record<string, string>>,
 *   foraDoVitest: (file: string) => string | null,
 * }} entrada `foraDoVitest` answers why a file OUTSIDE every vitest workspace
 *   runs nowhere, or `null` when a `node --test` workspace runs it.
 */
export function classificar({ testes, configs, membros, rotas, foraDoVitest }) {
  const dirs = [...new Set(configs.map(dirDe))];
  /** @type {{ zero: string[], varios: string[], errado: string[], semVitest: string[] }} */
  const out = { zero: [], varios: [], errado: [], semVitest: [] };
  for (const file of testes) {
    const anc = ancestrais(file, dirs);
    if (anc.length === 0) {
      const motivo = foraDoVitest(file);
      if (motivo !== null) out.semVitest.push(`${file} -> ${motivo}`);
      continue;
    }
    const got = membros.get(file) ?? [];
    if (got.length === 0) out.zero.push(`${file} -> []`);
    else if (got.length > 1) out.varios.push(`${file} -> [${got.join(', ')}]`);
    else {
      const want = configEsperado(file, anc[0], configs, rotas);
      if (want !== null && got[0] !== want) out.errado.push(`${file} -> ${got[0]} (want ${want})`);
    }
  }
  return out;
}

/**
 * The ROUTING TABLE against the config inventory: every multi-config workspace
 * has a row, no row outlives its workspace's split, every routed config exists.
 * @param {readonly string[]} configs
 * @param {Record<string, Record<string, string>>} rotas
 */
export function rotasDivergentes(configs, rotas) {
  /** @type {Map<string, string[]>} */
  const porDir = new Map();
  for (const c of configs) porDir.set(dirDe(c), [...(porDir.get(dirDe(c)) ?? []), c]);
  const problemas = [];
  for (const [dir, cs] of porDir) {
    if (cs.length >= 2 && rotas[dir] === undefined) {
      problemas.push(`${dir}: ${cs.length} configs and no ROTAS row — say how it splits`);
    }
  }
  for (const [dir, rota] of Object.entries(rotas)) {
    const cs = porDir.get(dir) ?? [];
    if (cs.length < 2) problemas.push(`${dir}: ROTAS row is stale (${cs.length} config(s))`);
    if (!cs.some((c) => PADRAO_RE.test(path.posix.basename(c)))) {
      problemas.push(`${dir}: no default vitest.config.* for the unrouted files`);
    }
    for (const cfg of new Set(Object.values(rota))) {
      if (!cs.includes(`${dir}/${cfg}`))
        problemas.push(`${dir}: routed config ${cfg} does not exist`);
    }
  }
  return problemas;
}

/* -------------------------------------------------------------------------- */
/*                                  The scan                                  */
/* -------------------------------------------------------------------------- */

/** Put `process.env` back EXACTLY as it was: drop added keys, restore the rest. */
function restaurarEnv(/** @type {Record<string, string | undefined>} */ antes) {
  for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
  for (const [k, v] of Object.entries(antes)) if (v !== undefined) process.env[k] = v;
}

/**
 * Load ONE config through vitest and match `files` against every project it
 * declares. Returns the files it collects.
 * @param {string} config repo-relative
 * @param {readonly string[]} files repo-relative
 * @param {string} envDir an EMPTY directory
 */
async function coletadosPor(config, files, envDir) {
  const antes = { ...process.env };
  process.env[OPT_OUT] = '1';
  /** @type {Awaited<ReturnType<typeof createVitest>> | undefined} */
  let v;
  try {
    v = await createVitest(
      'test',
      {
        root: path.join(REPO_ROOT, dirDe(config)),
        config: path.join(REPO_ROOT, config),
        watch: false,
      },
      { envDir },
      {},
    );
    const projetos = v.projects;
    // ⚠️ `path.join` only HERE, at vitest's boundary: everything else compares
    // raw POSIX git paths, which a back-slashed Windows path would never equal.
    return files.filter((f) => projetos.some((p) => p.matchesTestGlob(path.join(REPO_ROOT, f))));
  } finally {
    await v?.close();
    restaurarEnv(antes);
  }
}

/** `pnpm-workspace.yaml`'s `packages:` globs (`apps/*`, `.codex`, …). */
function globsDoWorkspace() {
  const yaml = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const bloco = /^packages:\n((?:[ \t]+-[^\n]*\n)+)/m.exec(yaml)?.[1] ?? '';
  return [...bloco.matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1]);
}

/** @typedef {{ scripts?: { test?: unknown } }} Pacote */

/** The disk reader {@link foraDoVitestReal} uses unless a test injects one. */
const lerPacoteDoDisco = (/** @type {string} */ pj) =>
  /** @type {Pacote} */ (JSON.parse(readFileSync(path.join(REPO_ROOT, pj), 'utf8')));

/**
 * Why a test file OUTSIDE every vitest workspace runs nowhere — or `null` when
 * its nearest `package.json` is a pnpm workspace whose `test` is a `node --test`
 * that reaches it ({@link nodeTestCobre}). The reader is injectable so every
 * refusal arm is tested against its accepted near miss without touching disk.
 * @param {ReadonlySet<string>} pacotes tracked `package.json` paths
 * @param {readonly string[]} globs `pnpm-workspace.yaml`'s `packages:`
 * @param {(pj: string) => Pacote} [lerPacote]
 */
export function foraDoVitestReal(pacotes, globs, lerPacote = lerPacoteDoDisco) {
  return (/** @type {string} */ file) => {
    let dir = path.posix.dirname(file);
    for (;;) {
      const pj = dir === '.' ? 'package.json' : `${dir}/package.json`;
      if (pacotes.has(pj)) {
        const test = lerPacote(pj).scripts?.test;
        const membro = globs.some((g) =>
          g.endsWith('/*') ? path.posix.dirname(dir) === g.slice(0, -2) : dir === g,
        );
        if (!membro)
          return `${pj} is not a pnpm workspace (pnpm-workspace.yaml), so turbo never runs it`;
        if (typeof test !== 'string' || !/^node --test(\s|$)/.test(test)) {
          return `no vitest config, and ${pj}'s test script is ${JSON.stringify(test ?? null)}, not \`node --test\``;
        }
        const rel = dir === '.' ? file : file.slice(dir.length + 1);
        if (!nodeTestCobre(test, rel)) {
          return `${pj}'s test script ${JSON.stringify(test)} does not reach ${rel}: \`node --test\` runs only what its own patterns match`;
        }
        return null;
      }
      if (dir === '.') return 'no vitest config and no package.json above it';
      dir = path.posix.dirname(dir);
    }
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Tests                                    */
/* -------------------------------------------------------------------------- */

describe('the pure partition core — near misses with synthetic inputs', () => {
  const configs = [
    'apps/a/vitest.config.ts',
    'apps/a/vitest.tasks.config.ts',
    'apps/b/vitest.config.ts',
    'apps/b/sub/vitest.config.ts',
  ];
  const rotas = { 'apps/a': { tasks: 'vitest.tasks.config.ts' } };
  const nodeTest = () => null;

  it('is clean when every file is in exactly its routed config — the pair to the cases below', () => {
    const membros = new Map([
      ['apps/a/x.test.ts', ['apps/a/vitest.config.ts']],
      ['apps/a/y.tasks.test.ts', ['apps/a/vitest.tasks.config.ts']],
      ['apps/b/z.test.ts', ['apps/b/vitest.config.ts']],
    ]);
    expect(
      classificar({ testes: [...membros.keys()], configs, membros, rotas, foraDoVitest: nodeTest }),
    ).toEqual({ zero: [], varios: [], errado: [], semVitest: [] });
  });

  it('reds a file collected by ZERO configs', () => {
    const r = classificar({
      testes: ['apps/a/scripts/x.test.ts'],
      configs,
      membros: new Map([['apps/a/scripts/x.test.ts', []]]),
      rotas,
      foraDoVitest: nodeTest,
    });
    expect(r.zero).toEqual(['apps/a/scripts/x.test.ts -> []']);
  });

  it('reds a file collected by TWO configs — an ANCESTOR workspace’s config included', () => {
    const membros = new Map([
      ['apps/b/sub/q.test.ts', ['apps/b/vitest.config.ts', 'apps/b/sub/vitest.config.ts']],
    ]);
    const r = classificar({
      testes: [...membros.keys()],
      configs,
      membros,
      rotas,
      foraDoVitest: nodeTest,
    });
    expect(r.varios).toEqual([
      'apps/b/sub/q.test.ts -> [apps/b/vitest.config.ts, apps/b/sub/vitest.config.ts]',
    ]);
  });

  it('reds a routed suffix that landed, alone, in the offline config (skip-green)', () => {
    const membros = new Map([['apps/a/y.tasks.test.ts', ['apps/a/vitest.config.ts']]]);
    const r = classificar({
      testes: [...membros.keys()],
      configs,
      membros,
      rotas,
      foraDoVitest: nodeTest,
    });
    expect(r.errado).toEqual([
      'apps/a/y.tasks.test.ts -> apps/a/vitest.config.ts (want apps/a/vitest.tasks.config.ts)',
    ]);
    // NEAR MISS: an unrouted suffix in the same workspace belongs offline.
    const offline = new Map([['apps/a/w.retry.test.ts', ['apps/a/vitest.config.ts']]]);
    expect(
      classificar({
        testes: [...offline.keys()],
        configs,
        membros: offline,
        rotas,
        foraDoVitest: nodeTest,
      }).errado,
    ).toEqual([]);
  });

  it('reds a test file in a workspace with NO vitest config unless `node --test` runs it', () => {
    const motivos = {
      'tools/novo/x.test.ts': 'test script is "vitest run"',
      '.codex/y.test.mjs': null,
    };
    const r = classificar({
      testes: Object.keys(motivos),
      configs,
      membros: new Map(),
      rotas,
      foraDoVitest: (f) => motivos[/** @type {keyof typeof motivos} */ (f)],
    });
    expect(r.semVitest).toEqual(['tools/novo/x.test.ts -> test script is "vitest run"']);
    expect(r.zero).toEqual([]);
  });

  it('asks EVERY ancestor workspace’s config about a file, never only the nearest', () => {
    // The real tree cannot pin this: no config directory nests inside another
    // there, so a nearest-only scan would leave every real verdict unchanged.
    const alvos = alvosDoConfig(
      ['vitest.config.ts', 'apps/b/vitest.config.ts', 'apps/b/sub/vitest.config.ts'],
      ['apps/b/sub/q.test.ts', 'apps/b/z.test.ts', 'apps/bb/w.test.ts'],
    );
    expect(Object.fromEntries(alvos)).toEqual({
      // A root config reaches everything…
      'vitest.config.ts': ['apps/b/sub/q.test.ts', 'apps/b/z.test.ts', 'apps/bb/w.test.ts'],
      // …the PAIR: the nested file is asked of its parent AND of its own config…
      'apps/b/vitest.config.ts': ['apps/b/sub/q.test.ts', 'apps/b/z.test.ts'],
      // …NEAR MISSES: the parent's own file is not the child's, and `apps/bb`
      // shares `apps/b`'s prefix without being under it.
      'apps/b/sub/vitest.config.ts': ['apps/b/sub/q.test.ts'],
    });
  });

  it('refuses each outside-vitest file for its OWN reason, beside the near miss it accepts', () => {
    /** @type {Record<string, Pacote>} */
    const disco = {
      '.codex/package.json': { scripts: { test: 'node --test *.test.mjs' } },
      'tools/novo/package.json': { scripts: { test: 'node --test' } },
      'tools/novo/aninhado/package.json': { scripts: { test: 'node --test' } },
      'tools/velho/package.json': { scripts: { test: 'vitest run' } },
      'tools/quase/package.json': { scripts: { test: 'node --testx' } },
      'tools/sem/package.json': {},
      'scratch/package.json': { scripts: { test: 'node --test' } },
    };
    const fora = foraDoVitestReal(new Set(Object.keys(disco)), ['.codex', 'tools/*'], (pj) => {
      const p = disco[pj];
      if (p === undefined) throw new Error(`read ${pj}, which pacotes does not list`);
      return p;
    });
    const naoNode = (/** @type {string} */ pj, /** @type {string} */ test) =>
      `no vitest config, and ${pj}'s test script is ${test}, not \`node --test\``;

    // Accepted: a member whose `node --test` patterns reach the file — and a
    // file two levels down walks up to ITS package (the bare defaults reach it).
    expect(fora('.codex/a.test.mjs')).toBeNull();
    expect(fora('tools/novo/a.test.mjs')).toBeNull();
    expect(fora('tools/novo/fundo/a.test.mjs')).toBeNull();

    // Not a workspace: same script as the accepted `tools/novo`, but outside the
    // globs — and `tools/*` is ONE level, so a package nested in a member is not one.
    expect(fora('scratch/a.test.mjs')).toBe(
      'scratch/package.json is not a pnpm workspace (pnpm-workspace.yaml), so turbo never runs it',
    );
    expect(fora('tools/novo/aninhado/a.test.mjs')).toBe(
      'tools/novo/aninhado/package.json is not a pnpm workspace (pnpm-workspace.yaml), so turbo never runs it',
    );

    // Not `node --test`: another runner, a lookalike prefix, no script at all.
    expect(fora('tools/velho/a.test.mjs')).toBe(
      naoNode('tools/velho/package.json', '"vitest run"'),
    );
    expect(fora('tools/quase/a.test.mjs')).toBe(
      naoNode('tools/quase/package.json', '"node --testx"'),
    );
    expect(fora('tools/sem/a.test.mjs')).toBe(naoNode('tools/sem/package.json', 'null'));

    // `node --test` that does not reach it: the accepted `.codex/a.test.mjs`
    // one directory down, and with another extension.
    const naoAlcanca = (/** @type {string} */ rel) =>
      `.codex/package.json's test script "node --test *.test.mjs" does not reach ${rel}: \`node --test\` runs only what its own patterns match`;
    expect(fora('.codex/lib/a.test.mjs')).toBe(naoAlcanca('lib/a.test.mjs'));
    expect(fora('.codex/a.test.ts')).toBe(naoAlcanca('a.test.ts'));

    // No package.json anywhere above (`pacotes` lists no root one here).
    expect(fora('orfao/a.test.mjs')).toBe('no vitest config and no package.json above it');
  });

  it('reads a `node --test` script’s own patterns, and refuses what it cannot read', () => {
    const cobre = (/** @type {string} */ script, /** @type {readonly string[]} */ rels) =>
      rels.map((rel) => nodeTestCobre(script, rel));
    // `*` stays in its directory, keeps its extension and skips hidden files.
    expect(
      cobre('node --test *.test.mjs', ['a.test.mjs', 'sub/a.test.mjs', 'a.test.ts', '.a.test.mjs']),
    ).toEqual([true, false, false, false]);
    // Quoted (Node globs it itself) and `./`-prefixed patterns read the same.
    expect(cobre('node --test "*.test.mjs"', ['a.test.mjs', 'sub/a.test.mjs'])).toEqual([
      true,
      false,
    ]);
    expect(cobre("node --test './*.test.mjs'", ['a.test.mjs'])).toEqual([true]);
    // `**` is Node's globstar only when QUOTED. Measured from a package holding
    // all five files below: `sh -c "node --test '**/*.test.mjs'"` ran the first
    // three (any depth, none included, never a hidden directory), while
    // `sh -c 'node --test **/*.test.mjs'` ran `sub/x.test.mjs` alone — POSIX sh
    // has no globstar, so the unquoted `**` is `*`, exactly one directory.
    const rels = [
      'a.test.mjs',
      'sub/x.test.mjs',
      'sub/deep/a.test.mjs',
      '.oculto/a.test.mjs',
      'sub/.h/a.test.mjs',
    ];
    expect(cobre("node --test '**/*.test.mjs'", rels)).toEqual([true, true, true, false, false]);
    expect(cobre('node --test "**/*.test.mjs"', rels)).toEqual([true, true, true, false, false]);
    expect(cobre('node --test **/*.test.mjs', rels)).toEqual([false, true, false, false, false]);
    // A literal names one file; braces expand.
    expect(cobre('node --test a.test.mjs', ['a.test.mjs', 'b.test.mjs'])).toEqual([true, false]);
    expect(cobre('node --test *.test.{mjs,cjs}', ['a.test.cjs', 'a.test.js'])).toEqual([
      true,
      false,
    ]);
    // No pattern (flags do not count) → Node's defaults, the JS half only.
    expect(
      cobre('node --test --test-reporter=spec', [
        'lib/a.test.mjs',
        'lib/a-test.js',
        'lib/a_test.cjs',
        'lib/test-a.mjs',
        'lib/test.js',
        'test/helper.js',
        'lib/a.test.ts',
        'lib/helper.js',
        '.hid/a.test.mjs',
      ]),
    ).toEqual([true, true, true, true, true, true, false, false, false]);
    // Refused: another command, a lookalike, a shell operator, unmodelled syntax.
    expect(
      [
        'vitest run',
        'node --testx',
        'node --test *.test.mjs && echo ok',
        'node --test [ab].test.mjs',
      ].map((s) => nodeTestCobre(s, 'a.test.mjs')),
    ).toEqual([false, false, false, false]);
  });

  it('reds a multi-config workspace with no ROTAS row, a stale row and a routed config that is gone', () => {
    // NEAR MISS: `apps/b` and `apps/b/sub` are two DIRECTORIES of one config
    // each — nested workspaces, not a split — so they need no row.
    expect(rotasDivergentes(configs, rotas)).toEqual([]);
    expect(
      rotasDivergentes(
        ['apps/c/vitest.config.ts', 'apps/c/vitest.x.config.ts', 'apps/d/vitest.config.ts'],
        { 'apps/d': { y: 'vitest.y.config.ts' } },
      ),
    ).toEqual([
      'apps/c: 2 configs and no ROTAS row — say how it splits',
      'apps/d: ROTAS row is stale (1 config(s))',
      'apps/d: routed config vitest.y.config.ts does not exist',
    ]);
  });
});

describe('the real tree, through vitest’s own matcher', () => {
  /** @type {string[]} */
  let configs = [];
  /** @type {string[]} */
  let testes = [];
  /** @type {Map<string, string[]>} */
  const membros = new Map();
  /** @type {Map<string, string[]>} */
  const canarios = new Map();
  /** @type {Record<string, string | undefined>} */
  let envAntes = {};
  /** @type {Record<string, string | undefined>} */
  let envDepois = {};
  let envDir = '';

  beforeAll(async () => {
    configs = gitLsFiles(['*vitest*.config.*'])
      .filter((f) => CONFIG_RE.test(f))
      .sort();
    testes = gitLsFiles(TESTES).sort();
    const dirs = [...new Set(configs.map(dirDe))];
    for (const f of testes) if (ancestrais(f, dirs).length > 0) membros.set(f, []);
    for (const f of Object.keys(CANARIOS)) canarios.set(f, []);

    envAntes = { ...process.env };
    envDir = mkdtempSync(path.join(tmpdir(), 'vitest-partition-env-'));
    for (const [c, alvo] of alvosDoConfig(configs, [...membros.keys(), ...canarios.keys()])) {
      for (const f of await coletadosPor(c, alvo, envDir)) {
        (membros.get(f) ?? canarios.get(f))?.push(c);
      }
    }
    envDepois = { ...process.env };
  }, 180_000);

  afterAll(() => {
    if (envDir) rmSync(envDir, { recursive: true, force: true });
  });

  it('discovers enough configs and files to be checking anything at all', () => {
    expect(configs.length).toBeGreaterThan(30);
    expect(membros.size).toBeGreaterThan(1500);
    // The loose pathspec's one false friend is filtered out, not counted.
    expect(configs).not.toContain('packages/config-vitest/eslint.config.mjs');
  });

  it('collects every test file in a vitest workspace in EXACTLY one config', () => {
    const { zero, varios } = classificar({
      testes: [...membros.keys()],
      configs,
      membros,
      rotas: ROTAS,
      foraDoVitest: () => null,
    });
    expect(
      { zero, varios },
      [
        'A test file is collected by zero vitest configs (it runs in NO job) or by two',
        '(an emulator suite also collected offline skips there and exits 0 — vitest',
        "counts COLLECTED files). Fix the include/exclude, or rename the file's suffix.",
      ].join('\n'),
    ).toEqual({ zero: [], varios: [] });
  });

  it('routes each suffix of a multi-config workspace to ITS config', () => {
    const { errado } = classificar({
      testes: [...membros.keys()],
      configs,
      membros,
      rotas: ROTAS,
      foraDoVitest: () => null,
    });
    expect(
      errado,
      'A suffix landed in the wrong config of its workspace (the ROTAS table above).',
    ).toEqual([]);
  });

  it('keeps ROTAS in step with the configs: every split has a row, no row is stale', () => {
    expect(rotasDivergentes(configs, ROTAS)).toEqual([]);
  });

  it('runs every test file OUTSIDE a vitest workspace under a pnpm workspace’s `node --test` that reaches it', () => {
    const pacotes = new Set(gitLsFiles(['package.json', '*/package.json']));
    const dirs = [...new Set(configs.map(dirDe))];
    const fora = testes.filter((f) => ancestrais(f, dirs).length === 0);
    const foraDoVitest = foraDoVitestReal(pacotes, globsDoWorkspace());
    const { semVitest } = classificar({
      testes: fora,
      configs,
      membros,
      rotas: ROTAS,
      foraDoVitest,
    });
    expect(semVitest, 'A test file outside every vitest config runs in NO job.').toEqual([]);
    // Anti-vacuity: today these are `.claude/hooks` and `.codex`.
    expect(fora.length).toBeGreaterThan(0);
    // …and every one of them is ACCEPTED, so the same lookup must be seen to
    // refuse on this tree too — real `package.json`s, the real workspace globs.
    expect(foraDoVitest('.codex/__canario__.test.mjs')).toBeNull();
    expect(foraDoVitest('.claude/hooks/lib/__canario__.test.mjs')).toMatch(
      /^\.claude\/hooks\/package\.json's test script .* does not reach lib\/__canario__\.test\.mjs:/,
    );
    expect(foraDoVitest('tools/__canario__/x.test.ts')).toMatch(
      /^package\.json is not a pnpm workspace/,
    );
  });

  it('answers the canaries — the same matcher, synthetic paths', () => {
    expect(Object.fromEntries(canarios)).toEqual(CANARIOS);
  });

  it('collects the Shopee Firestore-only suites in the tasks config (the LI fold, #1530)', () => {
    const tarefas = [...membros]
      .filter(([, cs]) => cs.includes('apps/shopee/vitest.tasks.config.ts'))
      .map(([f]) => f);
    expect(tarefas.length).toBeGreaterThanOrEqual(9);
    expect(tarefas).toContain('apps/shopee/lib/shopee/core/tokenStore.firestore.test.ts');
  });

  it('loads every config with the env isolated, and leaves `process.env` as it found it', async () => {
    expect(envDepois).toEqual(envAntes);
    expect(envAntes[OPT_OUT]).toBeUndefined();
    // The opt-out is a contract with ANOTHER package: pin its exact spelling…
    const arquivo = path.join(REPO_ROOT, 'packages/config-vitest/env.js');
    expect(readFileSync(arquivo, 'utf8')).toContain(`process.env.${OPT_OUT} === '1'`);
    // …and its behaviour, called the way a config calls it — only ever WITH the
    // opt-out set, so this test itself never reads a `.env` file either. By URL,
    // not by package name: config-eslint declares no edge to config-vitest.
    const antes = { ...process.env };
    process.env[OPT_OUT] = '1';
    try {
      const { loadRepoRootEnv } = await import(pathToFileURL(arquivo).href);
      const lido = loadRepoRootEnv({
        configFileUrl: pathToFileURL(path.join(REPO_ROOT, 'apps/nfe/vitest.config.ts')).href,
      });
      // ⚠️ A COUNT, never the record: were the opt-out ever lost, a `toEqual({})`
      // diff would print a developer's `.env.local` values into the reporter.
      expect(Object.keys(lido).length, 'loadRepoRootEnv read env files despite the opt-out').toBe(
        0,
      );
    } finally {
      restaurarEnv(antes);
    }
  });
});
