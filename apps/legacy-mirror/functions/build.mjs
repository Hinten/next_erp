import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBuildEnv, requireBuildRegion } from '../../../tools/deploy-env/build-env.mjs';

// Bundle the `legacy-mirror` Cloud Functions into one self-contained ESM file.
// Externals: firebase-admin / firebase-functions, provided by the runtime.
//
// Only the REGION is inlined. It must be the LEGACY database's location — a
// Firestore trigger is created in the database's region — and, like every other
// codebase here, it has no default (#1108): an unset FUNCTIONS_REGION stops the
// build. The two database ids are facts, not configuration (`(default)` on the
// legacy Standard database, `default` on the new Enterprise one), so they are
// constants in src/admin.ts rather than defines. The TARGET project id is a
// runtime param (`defineString`) because a build-time env must never name a
// deploy target — see BUILD_ENV_KEYS in tools/deploy-env/build-env.mjs.
const pkgDir = dirname(fileURLToPath(import.meta.url));

export async function bundle(outfile) {
  loadBuildEnv();
  const region = requireBuildRegion('FUNCTIONS_REGION');
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
      js: "import { createRequire as __lmCreateRequire } from 'node:module';\nconst require = __lmCreateRequire(import.meta.url);",
    },
  });
  return region;
}

// Run directly (`node build.mjs`): write dist/index.js for local inspection. The
// deploy does NOT use dist/ — it uses scripts/prepare-deploy.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle(join(pkgDir, 'dist/index.js'));
}
