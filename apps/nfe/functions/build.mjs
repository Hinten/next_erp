import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBuildEnv, requireBuildRegion } from '../../../tools/deploy-env/build-env.mjs';

// Bundle the NF-e Cloud Functions (codebase `nfe`) into a single self-contained
// ESM file, inlining the function region (Firebase reads no env during codebase
// analysis). Externals:
//   - firebase-admin / firebase-functions — provided by the runtime.
//   - xmllint-wasm — ships a ~3 MB WASM asset loaded at runtime relative to its
//     own dir; bundling it breaks that lookup, so it stays an installed dep (the
//     minimal deploy package.json lists it).
// Everything else — @delfrance/* + soap / node-forge / xml-crypto / @xmldom/xmldom
// — is inlined. The SEFAZ ca/*.pem chains + MOC XSD schemas are NOT bundled (they
// are read from disk); prepare-deploy.mjs copies them next to the bundle and
// src/options.ts points NFE_CA_DIR / NFE_SCHEMA_DIR at them.
const pkgDir = dirname(fileURLToPath(import.meta.url));

export async function bundle(outfile) {
  // Optional repo-root `.env.functions` supplies the build-time vars below when
  // they are not exported in the deploy shell. A real export still wins, and a
  // missing file is a no-op — see tools/deploy-env/build-env.mjs.
  loadBuildEnv();
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
    external: [
      'firebase-admin',
      'firebase-admin/*',
      'firebase-functions',
      'firebase-functions/*',
      'xmllint-wasm',
    ],
    define: {
      'process.env.FUNCTIONS_REGION': JSON.stringify(region),
      'process.env.TASKS_INVOKER_SA': JSON.stringify(tasksInvoker),
    },
    // ESM output has no `require`, but bundled CommonJS deps (node-forge's
    // `require('crypto')`, xml-crypto, …) call it dynamically → esbuild's
    // `__require` shim throws "Dynamic require of X is not supported" unless a
    // real `require` exists. Inject one via createRequire so those resolve.
    banner: {
      js: "import { createRequire as __nfeCreateRequire } from 'node:module';\nconst require = __nfeCreateRequire(import.meta.url);",
    },
  });
  return region;
}

// Run directly (`node build.mjs`): write dist/index.js for local inspection. The
// deploy does NOT use dist/ — it uses scripts/prepare-deploy.mjs (.deploy/nfe-functions).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle(join(pkgDir, 'dist/index.js'));
}
