import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

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
  const region = process.env.FUNCTIONS_REGION || 'us-east1';
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
    },
  });
  return region;
}

// Run directly (`node build.mjs`): write dist/index.js for local inspection. The
// deploy does NOT use dist/ — it uses scripts/prepare-deploy.mjs (.deploy/nfe-functions).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundle(join(pkgDir, 'dist/index.js'));
}
