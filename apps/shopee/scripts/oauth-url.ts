/**
 * Mint a Shopee consent URL from the command line.
 *
 *   pnpm --filter @delfrance/shopee-app oauth:url -- --project <id> --integracao <integracaoId>
 *
 * ## Why this exists at all
 *
 * An "ERP System" Shopee application has **no console "Authorize" button** — the
 * only way to reach the consent page is a URL the partner builds. `apps/web`
 * grows a Connect button in step 21; until then this script is the connect flow,
 * and it deliberately reuses the same four pieces the real route does
 * (`loadShopeeContext` for its guards, `signState`, `shopeeOauthState.put`,
 * `buildAuthorizeUrl`) so a divergence between them cannot hide here.
 *
 * ⚠️ **Dev-only, and never run by an agent** (root CLAUDE.md rule 8). It writes
 * ONE Firestore document — the pending OAuth attempt, replacing any previous one
 * for that integração — and is not part of any deploy artifact.
 *
 * ⚠️ `--project` is REQUIRED and never inferred: minting an attempt against the
 * wrong project would invalidate a legitimate pending connect in the right one.
 *
 * ⚠️ The printed URL embeds a live single-use `state`. Do not paste it into an
 * issue, a PR or a chat log.
 */
import { signState } from '@delfrance/data/admin/oauth-state';
import { buildAuthorizeUrl } from '@delfrance/integrations-shopee';

import { getAdminFirestore } from '../lib/firebase/admin';
import { shopeeStateSecret } from '../lib/shopee/env';
import { shopeeOauthState } from '../lib/shopee/conta/oauthState';
import { loadShopeeContext } from '../lib/shopee/core/shopee';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

interface Args {
  projectId: string;
  integracaoId: string;
}

function valueOf(name: string, inline: string | undefined, next: string | undefined): string {
  const raw = inline ?? next;
  if (raw == null || raw.startsWith('--')) {
    throw new ArgError(`--${name} exige um valor.`);
  }
  return raw;
}

function parseArgs(argv: readonly string[]): Args {
  let projectId: string | undefined;
  let integracaoId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    switch (flag) {
      case '--project':
        projectId = valueOf('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--integracao':
        integracaoId = valueOf('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      default:
        throw new ArgError(`argumento desconhecido: ${arg}`);
    }
  }

  if (projectId == null) throw new ArgError('--project <id> é obrigatório e nunca é inferido.');
  if (integracaoId == null) throw new ArgError('--integracao <integracaoId> é obrigatório.');
  return { projectId, integracaoId };
}

async function main(): Promise<void> {
  const { projectId, integracaoId } = parseArgs(process.argv.slice(2));
  // ⚠️ BEFORE the first `getAdminFirestore()` — the admin app is a singleton and
  // resolves its project id once, at first use.
  process.env.FIREBASE_PROJECT_ID = projectId;

  const secret = shopeeStateSecret();
  if (secret === null) {
    throw new ArgError('SHOPEE_STATE_SECRET não configurado no ambiente (veja o CLAUDE.md).');
  }

  const db = getAdminFirestore();
  // For its GUARDS, exactly as the route does: a missing or non-Shopee conta,
  // or a missing partner id/key, fails HERE instead of at Shopee.
  const ctx = await loadShopeeContext(db, integracaoId);

  const { state, nonce } = signState(integracaoId, secret);
  await shopeeOauthState.put(db, integracaoId, { nonce, codeVerifier: null });

  const authorizeUrl = buildAuthorizeUrl({
    partnerId: ctx.config.partnerId,
    redirectUri: ctx.config.redirectUri,
    state,
    hosts: ctx.config.hosts,
  });

  log(`[shopee/oauth:url] project=${projectId} integracao=${integracaoId}`);
  log(`  ambiente:    ${ctx.config.sandbox ? 'SANDBOX' : 'PRODUÇÃO'}`);
  log(`  redirectUri: ${ctx.config.redirectUri}`);
  log('');
  log(`  ${authorizeUrl}`);
  log('');
  log(
    '  A tentativa foi registrada e é de USO ÚNICO — abrir o link duas vezes leva a ' +
      'reason=bad_state na segunda.',
  );
  log(
    '  O domínio do redirect precisa estar registrado no app Shopee; no sandbox, ' +
      'deixar o campo VAZIO faz o Shopee não validar nada (aí localhost funciona).',
  );
}

await main();
