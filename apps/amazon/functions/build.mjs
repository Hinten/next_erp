import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBuildEnv, requireBuildRegion } from '../../../tools/deploy-env/build-env.mjs';

// Bundle the Amazon Cloud Functions (codebase `amazon`) into a single
// self-contained ESM file, inlining the function region (Firebase reads no env
// during codebase analysis). Externals:
//   - firebase-admin / firebase-functions — provided by the runtime.
// Everything else (@delfrance/*, zod, the SP-API package) is inlined. Mirrors
// apps/loja-integrada/functions/build.mjs — no on-disk data assets, so
// prepare-deploy.mjs is just bundle + minimal package.json + node_modules junction.
//
// Three values are defined: FUNCTIONS_REGION, FIREBASE_DATABASE_ID and
// TASKS_INVOKER_SA. The define AND the `inlined` list of this codebase's row in
// tools/deploy-env/preflight.mjs move together — preflight.test.js fails a
// one-sided edit in either direction.
const pkgDir = dirname(fileURLToPath(import.meta.url));

export async function bundle(outfile) {
  // Optional repo-root `.env.functions` supplies the build-time vars below when
  // they are not exported in the deploy shell. A real export still wins, and a
  // missing file is a no-op — see tools/deploy-env/build-env.mjs.
  loadBuildEnv();
  // Must match the enqueuers' region (the App Hosting receiver's
  // `lib/firebase/filaLeitura.ts`, and `src/agendador.ts` here) or tasks target
  // a queue that does not exist and are silently dropped. No default: an unset
  // variable stops the build rather than inlining a region nobody chose — see
  // requireBuildRegion.
  const region = requireBuildRegion('FUNCTIONS_REGION');
  // The Firestore database `getDb()` (src/lib/admin.ts) opens AND the conta
  // trigger binds to (src/onIntegracaoAmazonChanged.ts, master-plan step 20, the
  // codebase's first Firestore trigger) — the repo's NAMED `default` database,
  // never the `(default)` sentinel, which fails every operation with
  // `5 NOT_FOUND` (and a trigger bound to it deploys fine and never fires).
  //
  // ⚠️ What this define does NOT do: change the answer for an UNSET variable.
  // The trigger's own `?? 'default'` already resolves that to `default`, the
  // same way `admin.ts` reads the variable for `getDb()`. What it does: `||`
  // also turns a BLANK export into `default` — under `??` a blank reaches
  // firebase-functions as `''`, which it binds as `(default)` (its
  // `database || '(default)'`), the never-fires case — and it makes the
  // preflight table print the value the build baked. And it replaces EVERY read
  // of the variable in the bundle, `admin.ts`'s included: unbundled (the tests)
  // both read the environment, but deployed, the trigger's binding and `getDb()`
  // share this one build-time value, and a runtime override reaches neither.
  // The binding itself is pinned offline by src/index.test.ts (exactly
  // `'default'` on the analysed endpoint, plus a source assertion over this
  // line).
  //
  // ⚠️ `|| 'default'`, not `requireBuildRegion` — an unset value has a correct
  // answer here, where an unset region does not.
  const databaseId = process.env.FIREBASE_DATABASE_ID || 'default';
  // Service accounts allowed to enqueue AND dispatch this codebase's task
  // function, comma-separated. Inlined for the same reason as the region above
  // — `onTaskDispatched`'s `invoker` option is read during Firebase's codebase
  // analysis, before any env exists — and per PROJECT, so it cannot be a
  // constant. ⚠️ The list is AUTHORITATIVE: a deploy REPLACES the members of
  // both bindings it drives, so it must name every enqueuer (the App Hosting
  // runtime SA of the receiver AND the functions runtime SA of the step-4 poll).
  // See DEPLOY.md.
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
      js: "import { createRequire as __amzCreateRequire } from 'node:module';\nconst require = __amzCreateRequire(import.meta.url);",
    },
  });
  return region;
}

// Run directly (`node build.mjs`): write dist/index.js for local inspection. The
// deploy does NOT use dist/ — it uses scripts/prepare-deploy.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle(join(pkgDir, 'dist/index.js'));
}
