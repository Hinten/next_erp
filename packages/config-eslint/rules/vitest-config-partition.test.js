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
// still reaches `functions/**` would put the file in two configs.
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
// vitest's at all: they must sit in a pnpm workspace whose `test` script is
// `node --test`, or they too run nowhere.

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
 * real config or committing a stray file.
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

/**
 * Why a test file OUTSIDE every vitest workspace runs nowhere — or `null` when
 * its nearest `package.json` is a pnpm workspace whose `test` is `node --test`.
 * @param {ReadonlySet<string>} pacotes tracked `package.json` paths
 * @param {readonly string[]} globs
 */
function foraDoVitestReal(pacotes, globs) {
  return (/** @type {string} */ file) => {
    let dir = path.posix.dirname(file);
    for (;;) {
      const pj = dir === '.' ? 'package.json' : `${dir}/package.json`;
      if (pacotes.has(pj)) {
        const test = JSON.parse(readFileSync(path.join(REPO_ROOT, pj), 'utf8')).scripts?.test;
        const membro = globs.some((g) =>
          g.endsWith('/*') ? path.posix.dirname(dir) === g.slice(0, -2) : dir === g,
        );
        if (!membro)
          return `${pj} is not a pnpm workspace (pnpm-workspace.yaml), so turbo never runs it`;
        if (typeof test !== 'string' || !/^node --test(\s|$)/.test(test)) {
          return `no vitest config, and ${pj}'s test script is ${JSON.stringify(test ?? null)}, not \`node --test\``;
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
    for (const c of configs) {
      const d = dirDe(c);
      const sob = (/** @type {string} */ f) => d === '.' || f.startsWith(`${d}/`);
      const alvo = [...membros.keys(), ...canarios.keys()].filter(sob);
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

  it('runs every test file OUTSIDE a vitest workspace under `node --test` in a pnpm workspace', () => {
    const pacotes = new Set(gitLsFiles(['package.json', '*/package.json']));
    const dirs = [...new Set(configs.map(dirDe))];
    const fora = testes.filter((f) => ancestrais(f, dirs).length === 0);
    const { semVitest } = classificar({
      testes: fora,
      configs,
      membros,
      rotas: ROTAS,
      foraDoVitest: foraDoVitestReal(pacotes, globsDoWorkspace()),
    });
    expect(semVitest, 'A test file outside every vitest config runs in NO job.').toEqual([]);
    // Anti-vacuity: today these are `.claude/hooks` and `.codex`.
    expect(fora.length).toBeGreaterThan(0);
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
