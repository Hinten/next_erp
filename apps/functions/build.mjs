import { build } from 'esbuild';

// Bundle the Cloud Functions, inlining the function region at build time.
// Firebase can't read `process.env`/params/`.env` during codebase analysis (where
// setGlobalOptions runs), so the region is baked into the bundle here.
//
// The region is a non-secret project constant: the Storage bucket lives in
// us-east1 and the gen2 trigger must match it. It is deliberately NOT sourced
// from `.env.local` — that file holds secrets that must never be loaded into the
// deploy/build process. It defaults to the bucket region and can be overridden
// via FUNCTIONS_REGION for another environment.
const region = process.env.FUNCTIONS_REGION || 'us-east1';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/index.js',
  external: [
    'firebase-admin',
    'firebase-admin/*',
    'firebase-functions',
    'firebase-functions/*',
    'sharp',
  ],
  define: {
    'process.env.FUNCTIONS_REGION': JSON.stringify(region),
  },
});
