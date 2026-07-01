import { bundle } from '../build.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';

// Builds the deploy artifact for the `mercado-livre` Cloud Functions codebase.
// Run as the deploy `predeploy` hook (`node
// apps/mercado-livre/functions/scripts/prepare-deploy.mjs`) from the repo root;
// firebase.mercado-livre.deploy.json points `source` at the generated folder.
// Same mechanics as apps/nfe/functions (esbuild bundle + minimal package.json +
// node_modules junction), minus the NF-e on-disk data assets.

// apps/mercado-livre/functions (this script lives in .../functions/scripts/).
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(pkgDir, '..', '..', '..');

// Artifact at <root>/.deploy/mercado-livre-functions — the SAME directory depth
// as <root>/apps/mercado-livre, whose node_modules the junction below points at
// (apps/mercado-livre/functions has no own node_modules; it is part of
// @delfrance/mercado-livre-app). pnpm's RELATIVE symlinks resolve through the
// junction only at that matching depth.
const deployDir = join(repoRoot, '.deploy', 'mercado-livre-functions');

rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

// 1. Bundle the function (single self-contained ESM file).
const region = await bundle(join(deployDir, 'index.js'));

// 2. Minimal, workspace-free package.json — the 2 runtime deps only
//    (firebase-admin / firebase-functions). No devDependencies, no `workspace:*`,
//    no build script, so the gen2 buildpack `npm install` resolves cleanly.
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

// 3. Junction the app's installed node_modules so firebase-tools' LOCAL trigger
//    analysis can find + spawn the Functions SDK; kept OUT of the upload by
//    `ignore: ["node_modules"]`. The cloud reinstalls the minimal deps.
const realNodeModules = join(pkgDir, '..', 'node_modules');
if (existsSync(realNodeModules)) {
  symlinkSync(realNodeModules, join(deployDir, 'node_modules'), 'junction');
} else {
  console.warn(
    'warning: apps/mercado-livre/node_modules not found — run `pnpm install` before deploying',
  );
}

// eslint-disable-next-line no-console -- deploy script progress output
console.log(
  `prepared .deploy/mercado-livre-functions — region=${region}, ` +
    `deps=${Object.keys(realPkg.dependencies).join(', ')}`,
);
