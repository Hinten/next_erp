import { bundle } from '../build.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { copyDeployEnv } from '../../../../tools/deploy-env/env-files.mjs';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(pkgDir, '..', '..', '..');
const deployDir = join(repoRoot, '.deploy', 'melhor-envio-functions');

rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

const region = await bundle(join(deployDir, 'index.js'));
const realPkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const deployPkg = {
  name: realPkg.name,
  version: realPkg.version,
  private: true,
  type: 'module',
  main: 'index.js',
  engines: realPkg.engines,
  dependencies: realPkg.dependencies,
};
writeFileSync(join(deployDir, 'package.json'), JSON.stringify(deployPkg, null, 2) + '\n');

const copiedEnv = copyDeployEnv(pkgDir, deployDir);
const realNodeModules = join(pkgDir, '..', 'node_modules');
if (existsSync(realNodeModules)) {
  symlinkSync(realNodeModules, join(deployDir, 'node_modules'), 'junction');
} else {
  console.warn(
    'warning: apps/melhor-envio/node_modules not found — run `pnpm install` before deploying',
  );
}

// eslint-disable-next-line no-console -- deploy script progress output
console.log(
  `prepared .deploy/melhor-envio-functions — region=${region}, ` +
    `deps=${Object.keys(realPkg.dependencies).join(', ')}, ` +
    `env=${copiedEnv.length ? copiedEnv.join(' + ') : 'none'}`,
);
