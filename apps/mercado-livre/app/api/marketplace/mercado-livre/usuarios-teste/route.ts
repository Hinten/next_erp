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
 *    (`PERM.integracao.write`). With a `role` in the body it instead mints ONE
 *    fresh account of that role — #1087's case, where Mercado Pago stopped
 *    accepting purchases from the buyer and it must be replaced without
 *    re-minting the seller that still works.
 *
 * ⚠️ **A successful POST leaves this conta unable to POST again.** The mint's
 * last step deletes every `tokenDuravel` doc, and `resolveChannelContext()`
 * below runs BEFORE any guard — so the next call dies at `ML_REAUTH_REQUIRED`
 * even when it would have minted nothing. Reconnecting the real
 * application-owner account is therefore a PRECONDITION of an additional mint,
 * not an error; `manterCredencial` is the deliberate opt-out.
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
 * POST body (all optional; `{}` is the pair bootstrap and stays byte-compatible
 * with the client that sends it today):
 *  - `role` — `vendedor` | `comprador`, validated against the schema enum.
 *  - `manterCredencial` — skip the revocation. Only valid alongside a `role`.
 *
 * Responses:
 *  - 200 `{ usuarios, criados, reaproveitados, credenciaisRemovidas,
 *    credencialRevogada, conta }` (POST) / `{ usuarios }` (GET). Each `usuario`
 *    carries its `password` and the e-mail verification codes derived from its
 *    id.
 *  - 400 on a malformed body, an unknown `role`, or `manterCredencial` without
 *    a `role`.
 *  - 404 when the flag is off — indistinguishable from "route does not exist".
 *  - 409 `ML_CONTA_JA_E_TESTE` / `ML_LIMITE_USUARIOS_TESTE` /
 *    `ML_USUARIO_TESTE_DUPLICADO`.
 *  - ML/context errors map through `mercadoLivreErrorResponse`.
 *
 * ⚠️ Nothing here may log the response. `mercadoLivreErrorResponse` writes a
 * `MercadoLivreValidationError`'s `issues` straight to the log stream, which is
 * why `criarUsuarioTeste` puts field NAMES there rather than the body it parsed.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { usuarioTesteRoleSchema, type UsuarioTesteMercadoLivre } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import { createTestUserStore } from '@/lib/marketplace/conta/testUserStore';
import {
  TestUserGuardError,
  codigosVerificacaoEmail,
  criarUsuariosTeste,
} from '@/lib/marketplace/conta/testUsers';

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

/**
 * The POST body. Every field optional, so the historical `{}` (and an empty
 * body) still means "mint the pair" — this route ignored its body entirely
 * until #1087 needed a single-role mint.
 */
const bodySchema = z.strictObject({
  /**
   * Absent ⇒ the pair bootstrap. Present ⇒ mint ONE fresh account of that role.
   * Validated against the schema enum, never taken as a raw string: this value
   * becomes a Firestore doc-id prefix and picks which side of the run is spent.
   */
  role: usuarioTesteRoleSchema.optional(),
  /**
   * Skip the credential revocation and leave the conta connected.
   *
   * ⚠️ Defaults to FALSE — i.e. revoke. Absent, misspelt (`.strictObject` 400s
   * on an unknown key) and wrong-typed values must all fail CLOSED: a security
   * step that a missing field can switch off is #1059's shape, and here it
   * would leave a real seller account wired to the ERP.
   */
  manterCredencial: z.boolean().default(false),
});

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

  // Read as TEXT first: an empty body is legal on a POST and used to be the
  // whole contract here, so it must keep meaning `{}` rather than becoming a
  // 400 the day someone stops sending the placeholder object.
  const raw = (await req.text()).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw === '' ? '{}' : raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }
  // `JSON.parse` legally yields null/arrays/scalars — those are 400s, not the
  // 500 a `.safeParse` on a non-object would eventually turn into downstream.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
  }
  const body = bodySchema.safeParse(parsed);
  if (!body.success) {
    return NextResponse.json(
      {
        error:
          'Body inválido: `role` deve ser "vendedor" ou "comprador" e `manterCredencial` é ' +
          'booleano — ambos opcionais, e nenhum outro campo é aceito.',
      },
      { status: 400 },
    );
  }
  const { role, manterCredencial } = body.data;
  // Refused, never ignored. The pair bootstrap's revocation is unconditional by
  // design, so honouring the flag there would silently weaken it — and dropping
  // the flag silently would tell the caller it applied when it did not.
  if (manterCredencial && role === undefined) {
    return NextResponse.json(
      {
        error:
          '`manterCredencial` só vale para a criação avulsa: informe também o `role`. ' +
          'A criação do par sempre revoga a credencial da conta usada.',
      },
      { status: 400 },
    );
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
      ...(role === undefined
        ? {}
        : { roles: [role], modo: 'novo' as const, revogarCredencial: !manterCredencial }),
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
