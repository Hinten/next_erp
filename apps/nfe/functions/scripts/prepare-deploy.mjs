import { bundle } from '../build.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  cpSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';

// Builds the deploy artifact for the `nfe` Cloud Functions codebase. Run as the
// deploy `predeploy` hook (`node apps/nfe/functions/scripts/prepare-deploy.mjs`)
// from the repo root; firebase.nfe.deploy.json points `source` at the generated
// folder. Same mechanics as apps/functions (esbuild bundle + minimal package.json
// + node_modules junction) PLUS it copies the runtime data files (SEFAZ ca/*.pem
// chains + MOC XSD schemas) into the artifact, since the bundled NF-e library
// reads them from disk (src/options.ts points NFE_CA_DIR / NFE_SCHEMA_DIR at the
// copies).

// apps/nfe/functions (this script lives in apps/nfe/functions/scripts/).
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(pkgDir, '..', '..', '..');

// Artifact at <root>/.deploy/nfe-functions — the SAME directory depth as
// <root>/apps/nfe, whose node_modules the junction below points at (apps/nfe/functions
// has no own node_modules; it is part of @delfrance/nfe-app). pnpm's RELATIVE
// symlinks resolve through the junction only at that matching depth.
const deployDir = join(repoRoot, '.deploy', 'nfe-functions');

rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

// 1. Bundle the function (single self-contained ESM file).
const region = await bundle(join(deployDir, 'index.js'));

// 2. Minimal, workspace-free package.json — the 3 runtime deps only (firebase-admin
//    / firebase-functions / xmllint-wasm). No devDependencies, no `workspace:*`,
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

// 3. Copy the runtime data files next to the bundle. The vendored SEFAZ TLS
//    chains + MOC XSD schemas are public (ICP-Brasil chains + SEFAZ XSDs), so
//    shipping them in the artifact is safe. src/options.ts sets NFE_CA_DIR=./ca
//    and NFE_SCHEMA_DIR=./schemas (bundle-relative) so the readers find them.
const nfeLib = join(repoRoot, 'packages', 'integrations', 'nfe');
cpSync(join(nfeLib, 'ca'), join(deployDir, 'ca'), { recursive: true });
cpSync(join(nfeLib, 'generated', 'moc7.0', 'schemas'), join(deployDir, 'schemas'), {
  recursive: true,
});

// 3b. Copy NON-secret env files into the artifact so the deployed function gets
//     them: firebase loads `.env` + `.env.<projectId>` from the source dir at
//     deploy. `.env.local` is emulator-only; `.env.example` is the doc template.
//     (Secrets live in Secret Manager, declared via setGlobalOptions — NOT here.)
for (const f of readdirSync(pkgDir)) {
  if (f.startsWith('.env') && f !== '.env.local' && f !== '.env.example') {
    copyFileSync(join(pkgDir, f), join(deployDir, f));
  }
}

// 4. Junction the app's installed node_modules so firebase-tools' LOCAL trigger
//    analysis can find + spawn the Functions SDK; kept OUT of the upload by
//    `ignore: ["node_modules"]`. The cloud reinstalls the 3 minimal deps.
const realNodeModules = join(pkgDir, '..', 'node_modules');
if (existsSync(realNodeModules)) {
  symlinkSync(realNodeModules, join(deployDir, 'node_modules'), 'junction');
} else {
  console.warn('warning: apps/nfe/node_modules not found — run `pnpm install` before deploying');
}

console.log(
  `prepared .deploy/nfe-functions — region=${region}, ` +
    `deps=${Object.keys(realPkg.dependencies).join(', ')}, +ca +schemas`,
);
