import { build } from 'esbuild';

// Bundle the trigger source into a single ESM file so the deployed Cloud
// Function carries no module-resolution surprises. firebase-admin and
// firebase-functions stay external — they are real runtime dependencies and
// the Cloud Build install step provides them.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['firebase-admin', 'firebase-functions'],
});
