import { bundle } from '../build.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';

// Builds the deploy artifact for the `storage` Cloud Functions codebase. Run as
// the deploy `predeploy` hook (`node apps/functions/scripts/prepare-deploy.mjs`)
// from the repo root; `firebase.functions.deploy.json` points `source` at the
// generated folder.
//
// Why a generated folder instead of deploying apps/functions directly: the cloud
// `npm install` run by Firebase's gen2 buildpack cannot resolve pnpm `workspace:*`
// specs (npm error EUNSUPPORTEDPROTOCOL) — and it parses devDependencies' specs
// even with `--omit=dev`, so the real package.json's workspace devDeps
// (@delfrance/config-tsconfig / data / schemas) break the build no matter what.
// esbuild already bundles data & schemas into index.js, so the cloud only needs
// the 3 real runtime deps. We emit a minimal package.json carrying exactly those —
// no devDependencies, no `workspace:*`, no build script.

// apps/functions (this script lives in apps/functions/scripts/).
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(pkgDir, '..', '..');

// The artifact lives at <root>/.deploy/functions — deliberately the SAME directory
// depth as <root>/apps/functions. The node_modules junction created below points
// at apps/functions/node_modules, whose pnpm symlinks are RELATIVE; they only
// resolve correctly when referenced from a path at the same depth (a deeper path
// makes `../../..` overshoot). `.deploy` is not matched by the pnpm-workspace
// globs (apps/* etc.), so it is never treated as a workspace package.
const deployDir = join(repoRoot, '.deploy', 'functions');

// Fresh artifact every run. rmSync does NOT follow the node_modules junction
// (it unlinks the junction, never the real node_modules) — verified.
rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

// 1. Bundle the function (single self-contained ESM file) into the deploy folder.
const region = await bundle(join(deployDir, 'index.js'));

// 2. Emit the minimal, workspace-free package.json. `dependencies` is copied
//    verbatim from the real package.json — it is already exactly the 3 runtime
//    externals (firebase-admin / firebase-functions / sharp), none of them
//    `workspace:*`. devDependencies and scripts are deliberately omitted so the
//    buildpack only `npm install`s those three and never runs a build.
const realPkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const deployPkg = {
  name: realPkg.name,
  version: realPkg.version,
  private: true,
  type: 'module',
  main: 'index.js',
  engines: realPkg.engines,
  dependencies: realPkg.dependencies,
};
writeFileSync(join(deployDir, 'package.json'), JSON.stringify(deployPkg, null, 2) + '\n');

// 2b. The cloud buildpack runs a STRICT `npm install` (npm 7+ peer resolution).
//     `firebase-functions` (incl. the latest 7.x) still pins its peer to
//     `firebase-admin@^11 || ^12 || ^13`, so admin 14 — which we need for the
//     `@google-cloud/firestore` v8 Pipelines API (the arquivo orphan sweep) —
//     trips ERESOLVE in the cloud even though the combo is runtime-fine (the
//     ci-storage emulator suite passes on admin 14 + functions 6.x). Ship an
//     `.npmrc` that relaxes ONLY the cloud peer check; the repo + CI installs are
//     unaffected (this file lives only in the generated artifact). Drop this once
//     firebase-functions adds `^14` to its peer range.
writeFileSync(join(deployDir, '.npmrc'), 'legacy-peer-deps=true\n');

// 3. Junction the workspace's installed node_modules into the artifact, so
//    firebase-tools' LOCAL trigger analysis can find and spawn the Functions SDK
//    from `<source>/node_modules/.bin` (it does not walk up to parent
//    node_modules). The same-depth artifact path (above) is what makes the pnpm
//    relative symlinks inside resolve through the junction. Kept OUT of the upload
//    by `ignore: ["node_modules"]` in firebase.functions.deploy.json — the cloud
//    reinstalls the 3 deps from the minimal package.json above.
const realNodeModules = join(pkgDir, 'node_modules');
if (existsSync(realNodeModules)) {
  // 'junction' needs an absolute target on Windows and is ignored (→ dir symlink)
  // on POSIX, so it is the portable choice here.
  symlinkSync(realNodeModules, join(deployDir, 'node_modules'), 'junction');
} else {
  console.warn(
    'warning: apps/functions/node_modules not found — run `pnpm install` before deploying',
  );
}

console.log(
  `prepared .deploy/functions — region=${region}, deps=${Object.keys(realPkg.dependencies).join(', ')}`,
);
