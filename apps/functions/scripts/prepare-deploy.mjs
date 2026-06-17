import { bundle } from '../build.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

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

// Fresh artifact every run.
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

console.log(
  `prepared .deploy/ — region=${region}, deps=${Object.keys(realPkg.dependencies).join(', ')}`,
);
