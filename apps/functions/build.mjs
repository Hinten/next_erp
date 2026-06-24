import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// Bundle the Cloud Functions, inlining the function region at build time.
// Firebase can't read `process.env`/params/`.env` during codebase analysis (where
// setGlobalOptions runs), so the region is baked into the bundle here.
//
// The region is a non-secret project constant: the Storage bucket lives in
// us-east1 and the gen2 trigger must match it. It is deliberately NOT sourced
// from `.env.local` — that file holds secrets that must never be loaded into the
// deploy/build process. It defaults to the bucket region and can be overridden
// via FUNCTIONS_REGION for another environment.

// Resolve paths from THIS file's location, never the cwd: the deploy predeploy
// runs `node apps/functions/scripts/prepare-deploy.mjs` from the repo root, which
// calls bundle() below — so cwd is not the package directory.
const pkgDir = dirname(fileURLToPath(import.meta.url));

/**
 * Bundle src/index.ts into a single ESM file at `outfile`; returns the region
 * that was inlined. Only firebase-admin / firebase-functions / sharp stay
 * external — everything else, including @delfrance/data & @delfrance/schemas, is
 * bundled in, so the deployed package needs just those three runtime deps.
 */
export async function bundle(outfile) {
  const region = process.env.FUNCTIONS_REGION || 'us-east1';
  await build({
    entryPoints: [join(pkgDir, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    external: [
      'firebase-admin',
      'firebase-admin/*',
      'firebase-functions',
      'firebase-functions/*',
      // The orphan-sweep candidate scan imports pipeline expression builders from
      // `@google-cloud/firestore/pipelines`; keep the whole package external (it
      // ships transitively via firebase-admin + as a direct dep), never bundled.
      '@google-cloud/firestore',
      '@google-cloud/firestore/*',
      'sharp',
    ],
    define: {
      'process.env.FUNCTIONS_REGION': JSON.stringify(region),
    },
  });
  return region;
}

// Run directly (`node build.mjs` / `pnpm --filter @delfrance/functions build`):
// write dist/index.js for local inspection. The deploy does NOT use dist/ — it
// uses scripts/prepare-deploy.mjs, which bundles into the generated .deploy/
// artifact alongside a minimal, workspace-free package.json.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle(join(pkgDir, 'dist/index.js'));
}
