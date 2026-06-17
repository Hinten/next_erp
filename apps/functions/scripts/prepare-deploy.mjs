import { bundle } from '../build.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';

// Builds the deploy artifact for the `storage` Cloud Functions codebase into
// apps/functions/.deploy/ — the directory `firebase.functions.deploy.json` points
// `source` at. Run as the deploy `predeploy` hook (`node
// apps/functions/scripts/prepare-deploy.mjs`) from the repo root.
//
// Why a generated folder instead of deploying apps/functions directly: the cloud
// `npm install` run by Firebase's gen2 buildpack cannot resolve pnpm `workspace:*`
// specs (npm error EUNSUPPORTEDPROTOCOL), and it installs devDependencies too — so
// the real package.json's workspace devDeps (@delfrance/config-tsconfig / data /
// schemas) break the build. esbuild already bundles data & schemas into index.js,
// so the cloud only needs the 3 real runtime deps. We emit a minimal package.json
// carrying exactly those — no devDependencies, no `workspace:*`, no build script.

// apps/functions (this script lives in apps/functions/scripts/).
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const deployDir = join(pkgDir, '.deploy');

// Fresh artifact every run. rmSync does NOT follow the node_modules junction
// created below (it unlinks the junction, never the real node_modules) — verified.
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

// 3. Link the workspace's installed deps into the artifact as node_modules.
//    firebase-tools' LOCAL trigger analysis locates the Functions SDK by looking
//    for `<source>/node_modules/.bin/firebase-functions` (it does not walk up),
//    so the generated folder needs a node_modules with that shim. A junction to
//    the package's real node_modules exposes it without copying. This is kept OUT
//    of the upload by `ignore: ["node_modules"]` in firebase.functions.deploy.json
//    — the cloud installs the 3 deps from the minimal package.json above.
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
  `prepared .deploy/ — region=${region}, deps=${Object.keys(realPkg.dependencies).join(', ')}`,
);
