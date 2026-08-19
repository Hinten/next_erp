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
  // Default to us-east1 — where this whole codebase is deployed. It is NOT the
  // ML backend's own region (us-east5): Cloud Tasks and Cloud Scheduler do not
  // exist there, and eleven of the fifteen functions here need one or the other,
  // so the region that can hold the codebase is the one that has both. The four
  // Firestore triggers follow the rest rather than the database — Firebase
  // imposes no hard region match for them, and one region for one codebase beats
  // saving a cross-region hop on four triggers.
  const region = process.env.FUNCTIONS_REGION || 'us-east1';
  // Default to `default` — the repo's NAMED Firestore database. Firebase reads no
  // env during codebase analysis, so `onNfeAprovada`'s `database:` binding
  // (onNfeAprovada.ts) and `getDb()` (lib/admin.ts) would see `undefined` and bind
  // to the non-existent `(default)` — the trigger then NEVER fires. Inline it like
  // FUNCTIONS_REGION so the analyzed endpoint carries the real database id.
  // Mirrors apps/whatsapp/functions/build.mjs.
  const databaseId = process.env.FIREBASE_DATABASE_ID || 'default';
  // The eleven onTaskDispatched/onSchedule functions. Same default as `region`
  // above and normally the same value — it stays a SEPARATE variable because it
  // is the one the App Hosting backend must also be told: apps/mercado-livre/
  // lib/marketplace/mlTasksRegion.ts builds the region-qualified queue name from
  // it, and a mismatch makes the Admin SDK target us-central1 and SILENTLY DROP
  // the task. Inlined for the same reason as FUNCTIONS_REGION: the `region:`
  // option is read during codebase analysis, before any env is available.
  // ⚠️ Whatever this resolves to must be a region that HAS Cloud Tasks and Cloud
  // Scheduler. us-east5 has neither — pointing either variable there fails all
  // eleven at deploy while the four Firestore triggers succeed, which is the
  // asymmetric failure list #1108 diagnosed.
  const tasksRegion = process.env.MERCADO_LIVRE_TASKS_REGION || 'us-east1';
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
      'process.env.MERCADO_LIVRE_TASKS_REGION': JSON.stringify(tasksRegion),
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
