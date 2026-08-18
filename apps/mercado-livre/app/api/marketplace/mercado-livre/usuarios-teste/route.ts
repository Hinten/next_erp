/**
 * `GET|POST /api/marketplace/mercado-livre/usuarios-teste?integracaoId=…`
 *
 * The dev-only helper that bootstraps an end-to-end Mercado Livre test run:
 * mint a seller test user and a buyer test user from the connected conta, store
 * both, and then **revoke that conta's OAuth credential**.
 *
 *  - `GET`  — the stored records (`PERM.integracao.read`). The subcollection is
 *    admin-only, so the browser has no other way to read them; without this the
 *    passwords would vanish on the first refresh, and ML never reissues one.
 *  - `POST` — mint/reuse the pair, then disconnect the conta
 *    (`PERM.integracao.write`).
 *
 * ⚠️ **`POST` is destructive.** It deletes every credential doc on the conta it
 * used, which is the point — the bootstrap account is a real seller account and
 * must not stay connected to the ERP — but pointed at the wrong conta it
 * disconnects a live seller. Three guards, in order of authority:
 *
 *  1. `MERCADO_LIVRE_TEST_USERS_ENABLED` must be `1`. **This is the real gate.**
 *     A `NODE_ENV` check would be worthless: `apps/web` in local dev calls the
 *     DEPLOYED channel backend, so the browser's notion of "dev" says nothing
 *     about which backend answers. And per #1059 a `NODE_ENV === 'test'` escape
 *     inside a guard is exactly how one got disabled in the one job that needed
 *     it. Unset ⇒ 404, so a production backend does not even admit the route.
 *  2. The conta must not already be a test user (`ML_CONTA_JA_E_TESTE`, 409).
 *  3. The UI confirms, naming the account about to be disconnected.
 *
 * Responses:
 *  - 200 `{ usuarios, criados, reaproveitados, credenciaisRemovidas, conta }`
 *    (POST) / `{ usuarios }` (GET). Each `usuario` carries its `password` and
 *    the e-mail verification codes derived from its id.
 *  - 404 when the flag is off — indistinguishable from "route does not exist".
 *  - 409 `ML_CONTA_JA_E_TESTE`.
 *  - ML/context errors map through `mercadoLivreErrorResponse`.
 *
 * ⚠️ Nothing here may log the response. `mercadoLivreErrorResponse` writes a
 * `MercadoLivreValidationError`'s `issues` straight to the log stream, which is
 * why `criarUsuarioTeste` puts field NAMES there rather than the body it parsed.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import type { UsuarioTesteMercadoLivre } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';
import { createTestUserStore } from '@/lib/marketplace/testUserStore';
import {
  TestUserGuardError,
  codigosVerificacaoEmail,
  criarUsuariosTeste,
} from '@/lib/marketplace/testUsers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Whether this backend may mint test users. Read per request, not module-scope:
 * a module-scope constant is baked at import and would ignore the value an
 * emulator/test run sets afterwards.
 */
export function testUsersEnabled(): boolean {
  return process.env.MERCADO_LIVRE_TEST_USERS_ENABLED === '1';
}

/** 404, not 403: a backend without the flag should not admit the route exists. */
function disabledResponse(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

function integracaoIdFrom(req: Request): string | null {
  return new URL(req.url).searchParams.get('integracaoId');
}

/** Adds what the operator needs and ML does not return: the e-mail codes. */
function toWire(u: UsuarioTesteMercadoLivre) {
  return { ...u, codigosVerificacaoEmail: codigosVerificacaoEmail(u.id) };
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!testUsersEnabled()) return disabledResponse();

  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const integracaoId = integracaoIdFrom(req);
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  // No ML call and no context load: the records are ours, and the conta is
  // deliberately disconnected by the time anyone reads them back.
  const usuarios = await createTestUserStore(getAdminFirestore(), integracaoId).list();
  return NextResponse.json({ usuarios: usuarios.map(toWire) });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!testUsersEnabled()) return disabledResponse();

  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const integracaoId = integracaoIdFrom(req);
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const result = await criarUsuariosTeste({
      api,
      store: createTestUserStore(db, integracaoId),
      tokens: ctx.store,
    });

    return NextResponse.json({
      ...result,
      usuarios: result.usuarios.map(toWire),
    });
  } catch (err) {
    if (err instanceof TestUserGuardError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...err.extra },
        { status: err.status },
      );
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
