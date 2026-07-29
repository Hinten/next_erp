import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// Bundle the Mercado Livre Cloud Functions (codebase `mercado-livre`) into a
// single self-contained ESM file, inlining the function region (Firebase reads
// no env during codebase analysis). Externals:
//   - firebase-admin / firebase-functions — provided by the runtime.
//   - @google-cloud/firestore — the stock sweep imports pipeline builders from
//     `@google-cloud/firestore/pipelines`; a direct runtime dep, never bundled.
// Everything else (@delfrance/*) is inlined. Unlike the NF-e functions, there
// are no on-disk data assets (ca/*.pem, XSD) to copy — so prepare-deploy.mjs is
// just bundle + minimal package.json + node_modules junction.
const pkgDir = dirname(fileURLToPath(import.meta.url));

export async function bundle(outfile) {
  // Default to us-east5 — the ML backend's deploy region. Must match the
  // enqueuer's MERCADO_LIVRE_TASKS_REGION default (mlTasks.ts) or tasks target a
  // queue that doesn't exist in this region and silently drop.
  const region = process.env.FUNCTIONS_REGION || 'us-east5';
  // Default to `default` — the repo's NAMED Firestore database. Firebase reads no
  // env during codebase analysis, so `onNfeAprovada`'s `database:` binding
  // (onNfeAprovada.ts) and `getDb()` (lib/admin.ts) would see `undefined` and bind
  // to the non-existent `(default)` — the trigger then NEVER fires. Inline it like
  // FUNCTIONS_REGION so the analyzed endpoint carries the real database id.
  // Mirrors apps/whatsapp/functions/build.mjs.
  const databaseId = process.env.FIREBASE_DATABASE_ID || 'default';
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
      '@google-cloud/firestore',
      '@google-cloud/firestore/*',
    ],
    define: {
      'process.env.FUNCTIONS_REGION': JSON.stringify(region),
      'process.env.FIREBASE_DATABASE_ID': JSON.stringify(databaseId),
    },
    // ESM output has no `require`, but bundled CommonJS deps may call it
    // dynamically → inject a real `require` via createRequire so those resolve.
    banner: {
      js: "import { createRequire as __mlCreateRequire } from 'node:module';\nconst require = __mlCreateRequire(import.meta.url);",
    },
  });
  return region;
}

// Run directly (`node build.mjs`): write dist/index.js for local inspection. The
// deploy does NOT use dist/ — it uses scripts/prepare-deploy.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle(join(pkgDir, 'dist/index.js'));
}
