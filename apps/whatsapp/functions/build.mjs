import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// Bundle the WhatsApp Cloud Functions (codebase `whatsapp`) into a single
// self-contained ESM file, inlining the function region (Firebase reads no env
// during codebase analysis). Externals:
//   - firebase-admin / firebase-functions — provided by the runtime.
// Everything else (@delfrance/*) is inlined. Mirrors
// apps/mercado-pago/functions/build.mjs — no on-disk data assets, so
// prepare-deploy.mjs is just bundle + minimal package.json + node_modules junction.
const pkgDir = dirname(fileURLToPath(import.meta.url));

export async function bundle(outfile) {
  // Default to us-east5 — matches the WhatsApp task scheduler's default region
  // (waTasks.ts: WHATSAPP_TASKS_REGION ?? FUNCTIONS_REGION ?? us-east5). Must
  // match or the enqueuer targets a queue that doesn't exist in this region and
  // silently drops.
  const region = process.env.FUNCTIONS_REGION || 'us-east5';
  // Default to `default` — the repo's NAMED Firestore database. Firebase reads no
  // env during codebase analysis, so `sendOutbound`'s `database:` binding
  // (sendOutbound.ts) and `getDb()` (lib/admin.ts) would see `undefined` and bind
  // to the non-existent `(default)` — the trigger then NEVER fires. Inline it like
  // FUNCTIONS_REGION so the analyzed endpoint carries the real database id.
  const databaseId = process.env.FIREBASE_DATABASE_ID || 'default';
  // Service accounts allowed to enqueue AND dispatch this codebase's task
  // functions, comma-separated. Inlined for the same reason as the region above
  // — `onTaskDispatched`'s `invoker` option is read during Firebase's codebase
  // analysis, before any env exists — and per PROJECT, so it cannot be a
  // constant. ⚠️ The list is AUTHORITATIVE: a deploy REPLACES the members of
  // both bindings it drives, so it must name every enqueuer. See DEPLOY.md.
  const tasksInvoker = process.env.TASKS_INVOKER_SA || '';
  if (!tasksInvoker) {
    console.warn(
      '[build] TASKS_INVOKER_SA is unset — `invoker` will be OMITTED from every ' +
        'onTaskDispatched, leaving roles/run.invoker + roles/cloudtasks.enqueuer to ' +
        'the manual gcloud grants in DEPLOY.md.',
    );
  }
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
      'process.env.FIREBASE_DATABASE_ID': JSON.stringify(databaseId),
      'process.env.TASKS_INVOKER_SA': JSON.stringify(tasksInvoker),
    },
    // ESM output has no `require`, but bundled CommonJS deps may call it
    // dynamically → inject a real `require` via createRequire so those resolve.
    banner: {
      js: "import { createRequire as __waCreateRequire } from 'node:module';\nconst require = __waCreateRequire(import.meta.url);",
    },
  });
  return region;
}

// Run directly (`node build.mjs`): write dist/index.js for local inspection. The
// deploy does NOT use dist/ — it uses scripts/prepare-deploy.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle(join(pkgDir, 'dist/index.js'));
}
