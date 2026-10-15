import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as prettier from 'prettier';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const paths = [
  "apps/mercado-livre/functions/DEPLOY.md",
  "apps/mercado-livre/functions/src/index.test.ts",
  "apps/mercado-livre/lib/marketplace/notificacoes/missedFeedsAccess.ts",
  "apps/mercado-livre/lib/marketplace/notificacoes/missedFeedsProbe.test.ts",
  "apps/mercado-livre/lib/marketplace/notificacoes/missedFeedsProbe.ts",
  "apps/mercado-livre/lib/marketplace/notificacoes/missedFeedsSweep.firestore.test.ts",
  "apps/mercado-livre/lib/marketplace/notificacoes/missedFeedsSweep.test.ts",
  "apps/mercado-livre/lib/marketplace/notificacoes/missedFeedsSweep.ts",
  "apps/mercado-livre/scripts/probe-missed-feeds.ts",
  "packages/integrations/mercado-livre/test/missedFeedsApi.test.ts",
  "packages/schemas/src/missedFeedsMercadoLivre.test.ts"
];
for (const path of paths) {
  const absolute = resolve(root, path);
  const options = await prettier.resolveConfig(absolute);
  const content = await prettier.format(await readFile(absolute, 'utf8'), { ...options, filepath: absolute });
  process.stdout.write('CODEX_FORMAT_1292 ' + path + ' ' + Buffer.from(content).toString('base64') + '\n');
}
