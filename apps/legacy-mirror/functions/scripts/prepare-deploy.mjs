import { bundle } from '../build.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { copyDeployEnv } from '../../../../tools/deploy-env/env-files.mjs';

// Builds the deploy artifact for the `legacy-mirror` codebase. Runs as the
// `predeploy` hook of firebase.legacy-mirror.deploy.json, from the repo root.
// Same mechanics as apps/whatsapp/functions: esbuild bundle + minimal
// package.json + the optional `.env.deploy*` copy + a node_modules junction.

// apps/legacy-mirror/functions (this script lives in .../functions/scripts/).
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(pkgDir, '..', '..', '..');

// Artifact at <root>/.deploy/legacy-mirror-functions — the SAME directory depth
// as <root>/apps/legacy-mirror, whose node_modules the junction below points at.
// pnpm's RELATIVE symlinks resolve through the junction only at that depth.
const deployDir = join(repoRoot, '.deploy', 'legacy-mirror-functions');

rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

// 1. Bundle the functions (single self-contained ESM file).
const region = await bundle(join(deployDir, 'index.js'));

// 2. Minimal, workspace-free package.json — the 2 runtime deps only.
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

// 2b. Copy the runtime env file into the artifact. This is where the operator
//     supplies LEGACY_MIRROR_TARGET_PROJECT_ID (functions/.env.deploy.<legacy-id>),
//     so the `defineString` param resolves without an interactive prompt. The
//     allowlist is anchored and a `.env.secrets*` fails the hook outright.
const copiedEnv = copyDeployEnv(pkgDir, deployDir);

// 3. Junction the app's node_modules so firebase-tools' LOCAL trigger analysis
//    can spawn the Functions SDK; kept OUT of the upload by
//    `ignore: ["node_modules"]`.
const realNodeModules = join(pkgDir, '..', 'node_modules');
if (existsSync(realNodeModules)) {
  symlinkSync(realNodeModules, join(deployDir, 'node_modules'), 'junction');
} else {
  console.warn(
    'warning: apps/legacy-mirror/node_modules not found — run `pnpm install` before deploying',
  );
}

// eslint-disable-next-line no-console -- deploy script progress output
console.log(
  `prepared .deploy/legacy-mirror-functions — region=${region}, ` +
    `deps=${Object.keys(realPkg.dependencies).join(', ')}, ` +
    `env=${copiedEnv.length ? copiedEnv.join(' + ') : 'none'}`,
);
