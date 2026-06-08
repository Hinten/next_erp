import { build } from 'esbuild';

// Bundle the Cloud Functions, inlining FUNCTIONS_REGION at build time. Firebase
// can't read `process.env`/params/`.env` during codebase analysis (where
// setGlobalOptions runs), so the region is baked into the bundle here instead.
//
// Source the value from the env: dev loads the root `.env.local` via the shared
// `dotenv -e ../../.env.local --` loader; CI sets it on the job. Fail the build
// if it's unset so an unconfigured/mismatched region can never ship.
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION is not set.\n' +
      '  dev: dotenv -e ../../.env.local -- pnpm --filter @delfrance/functions build\n' +
      '  CI : set FUNCTIONS_REGION on the job\n' +
      'It must match the Storage bucket region.',
  );
}

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
