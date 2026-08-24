import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBuildEnv, requireBuildRegion } from '../../../tools/deploy-env/build-env.mjs';

// Bundle the Mercado Pago Cloud Functions (codebase `mercado-pago`) into a
// single self-contained ESM file, inlining the function region (Firebase reads
// no env during codebase analysis). Externals:
//   - firebase-admin / firebase-functions — provided by the runtime.
// Everything else (@delfrance/*) is inlined. Mirrors
// apps/mercado-livre/functions/build.mjs — no on-disk data assets, so
// prepare-deploy.mjs is just bundle + minimal package.json + node_modules junction.
const pkgDir = dirname(fileURLToPath(import.meta.url));

export async function bundle(outfile) {
  // Optional repo-root `.env.functions` supplies the build-time vars below when
  // they are not exported in the deploy shell. A real export still wins, and a
  // missing file is a no-op — see tools/deploy-env/build-env.mjs.
  loadBuildEnv();
  // Must match the enqueuer's region (mpTasks.ts) or tasks target a queue that
  // does not exist and are silently dropped. No default: an unset variable stops
  // the build rather than inlining a region nobody chose — see requireBuildRegion.
  const region = requireBuildRegion('FUNCTIONS_REGION');
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
      'process.env.TASKS_INVOKER_SA': JSON.stringify(tasksInvoker),
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
