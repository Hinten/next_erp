import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// Bundle the Mercado Pago Cloud Functions (codebase `mercado-pago`) into a
// single self-contained ESM file, inlining the function region (Firebase reads
// no env during codebase analysis). Externals:
//   - firebase-admin / firebase-functions — provided by the runtime.
// Everything else (@delfrance/*) is inlined. Mirrors
// apps/mercado-livre/functions/build.mjs — no on-disk data assets, so
// prepare-deploy.mjs is just bundle + minimal package.json + node_modules junction.
const pkgDir = dirname(fileURLToPath(import.meta.url));

export async function bundle(outfile) {
  // Default to us-east5 — the MP backend's deploy region. Must match the
  // enqueuer's MERCADO_PAGO_TASKS_REGION default (mpTasks.ts) or tasks target a
  // queue that doesn't exist in this region and silently drop.
  const region = process.env.FUNCTIONS_REGION || 'us-east5';
  await build({
    entryPoints: [join(pkgDir, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*'],
    define: {
      'process.env.FUNCTIONS_REGION': JSON.stringify(region),
    },
    // ESM output has no `require`, but bundled CommonJS deps may call it
    // dynamically → inject a real `require` via createRequire so those resolve.
    banner: {
      js: "import { createRequire as __mpCreateRequire } from 'node:module';\nconst require = __mpCreateRequire(import.meta.url);",
    },
  });
  return region;
}

// Run directly (`node build.mjs`): write dist/index.js for local inspection. The
// deploy does NOT use dist/ — it uses scripts/prepare-deploy.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle(join(pkgDir, 'dist/index.js'));
}
