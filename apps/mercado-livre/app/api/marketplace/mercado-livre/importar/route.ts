/**
 * `POST /api/marketplace/mercado-livre/importar` — import (or re-sync) a Mercado
 * Livre listing into an ERP produto. Body: `{ integracaoId, itemId }` (`itemId` =
 * the `MLB…` id). Requires `PERM.integracao.write`.
 *
 * 7a imports SIMPLE listings only — a listing with variations / `family_name`
 * returns 422 `ML_IMPORT_BLOCKED` (variation/User-Products import is tracked in
 * #438). Responses: 200 `{ produtoId, estado, nome, created }`; 422 with the
 * blocking issues; ML/API errors map through `mercadoLivreErrorResponse`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminBucket, getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';
import { importProduto } from '@/lib/marketplace/import';
import { MercadoLivreImportError } from '@/lib/marketplace/importCore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
  }
  const body = parsed as { integracaoId?: string; itemId?: string; options?: unknown };
  if (!body.integracaoId || !body.itemId) {
    return NextResponse.json({ error: 'integracaoId e itemId são obrigatórios.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, body.integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const result = await importProduto(
      {
        db,
        api,
        bucket: getAdminBucket(),
        integracaoId: body.integracaoId,
        sellerUserId: asNumberOrNull(ctx.conta.user_id),
        tabelaNormalOuterRef: asStringOrNull(ctx.conta.tabelaNormalOuterRef),
        tabelaPromocionalOuterRef: asStringOrNull(ctx.conta.tabelaPromocionalOuterRef),
        depositoOuterRef: asStringOrNull(ctx.conta.depositoOuterRef),
        options: sanitizeOptions(body.options),
      },
      body.itemId,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MercadoLivreImportError) {
      return NextResponse.json(
        { error: err.message, issues: err.issues, code: 'ML_IMPORT_BLOCKED' },
        { status: 422 },
      );
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Accept only the known boolean import flags from the body; ignore the rest. */
function sanitizeOptions(v: unknown): Record<string, boolean> | undefined {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const keys = [
    'importarEstoque',
    'sobrescreverEstoque',
    'importarPreco',
    'sobrescreverPreco',
    'importarFotos',
    'importarCategorias',
  ];
  const out: Record<string, boolean> = {};
  for (const k of keys) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  return Object.keys(out).length > 0 ? out : undefined;
}
