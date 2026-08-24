/**
 * `POST /api/marketplace/mercado-livre/reclamacao/acao` — run one resolution
 * verb on a Mercado Livre claim: refund, partial refund, allow-return, open
 * mediation (#364, #768).
 *
 * Body: `{ integracaoId, claimId, acao, valorReembolsoMinor?, percentualExibido? }`.
 *
 * ⚠️ Gated on **`PERM.incidenteResolucao.write`**, a dedicated bit — not
 * `pedido.write`. These verbs move money and are irreversible on ML's side,
 * while an incidente is otherwise ordinary pedido history; sharing the bit would
 * hand a refund button to everyone who can fix a shipping address. Same reasoning
 * that put `pergunta-acao` on `mensagem.delete` rather than `.write`.
 *
 * ⚠️ **Writes NOTHING locally on success.** The `claims` importer is the single
 * writer of incidente state — it re-derives `resolucao` from `claim.resolution`
 * on every run. Writing here would either be clobbered by the next notification
 * or win a race and permanently disagree with ML. The operator sees the result
 * because the panel refetches the LIVE claim, which is ML's own word rather than
 * our guess.
 */
import { NextResponse } from 'next/server';
import {
  ClaimActionUnavailableError,
  ClaimPartialRefundOfferError,
  MercadoLivreHttpError,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  ACOES_RECLAMACAO,
  type AcaoReclamacao,
  ClaimResolveRefusedError,
  resolverReclamacaoMercadoLivre,
  validarAcaoReclamacao,
} from '@/lib/marketplace/claimResolve';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** ⚠️ An ALLOW-LIST. An unrecognised verb never reaches a destructive endpoint. */
const ACOES: ReadonlySet<string> = new Set<AcaoReclamacao>(ACOES_RECLAMACAO);

function numeroOuIndefinido(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.incidenteResolucao.write);
  if ('error' in auth) return auth.error;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Body JSON inválido.', code: 'ML_BODY_INVALIDO' },
        { status: 400 },
      );
    }
    throw err;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json(
      { error: 'Body JSON inválido.', code: 'ML_BODY_INVALIDO' },
      { status: 400 },
    );
  }

  const body = parsed as Record<string, unknown>;
  const integracaoId = typeof body.integracaoId === 'string' ? body.integracaoId.trim() : '';
  const claimId = typeof body.claimId === 'number' ? body.claimId : NaN;
  const acao = typeof body.acao === 'string' ? body.acao : '';
  if (integracaoId === '' || !Number.isSafeInteger(claimId) || claimId <= 0 || !ACOES.has(acao)) {
    return NextResponse.json(
      {
        error: 'integracaoId, um claimId numérico e uma ação válida são obrigatórios.',
        code: 'ML_BODY_INVALIDO',
      },
      { status: 400 },
    );
  }

  const pedido = {
    claimId,
    acao: acao as AcaoReclamacao,
    valorReembolsoMinor: numeroOuIndefinido(body.valorReembolsoMinor),
    percentualExibido: numeroOuIndefinido(body.percentualExibido),
  };

  const db = getAdminFirestore();
  try {
    // ⚠️ Validate BEFORE loading the account, so an under-specified partial
    // refund never even resolves a credential — let alone reaches ML, where a
    // missing percentage means 50%.

    validarAcaoReclamacao(pedido);

    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    return NextResponse.json(await resolverReclamacaoMercadoLivre({ api }, pedido));
  } catch (err) {
    // ⚠️ Specific classes BEFORE the generic mapper, and every arm logs. A route
    // that returns its own 409 and skips `mercadoLivreErrorResponse` leaves the
    // server terminal silent — the exact failure that function exists to end.
    if (err instanceof ClaimResolveRefusedError) {
      console.warn('[mercado-livre] ação de reclamação recusada', {
        claimId,
        acao,
        codigo: err.codigo,
      });
      return NextResponse.json({ error: err.motivo, code: err.codigo }, { status: 409 });
    }
    if (err instanceof ClaimActionUnavailableError) {
      // ⚠️ It `extends Error`, NOT MercadoLivreError, so `isMercadoLivreError`
      // does not match it — without this arm every "ML no longer offers that"
      // refusal would surface as an unhandled 500. `disponiveis` lets the UI
      // refresh its buttons in place instead of guessing.
      console.warn('[mercado-livre] ação indisponível nesta reclamação', {
        claimId,
        acao,
        disponiveis: err.disponiveis,
      });
      return NextResponse.json(
        {
          error: err.message,
          code: 'ML_ACAO_INDISPONIVEL',
          acoesDisponiveis: err.disponiveis,
        },
        { status: 409 },
      );
    }
    if (err instanceof ClaimPartialRefundOfferError) {
      // The operator's amount moved between the offers read and the commit.
      console.warn('[mercado-livre] oferta de reembolso parcial indisponível', { claimId });
      return NextResponse.json(
        { error: err.message, code: 'ML_OFERTA_INDISPONIVEL', ofertas: err.ofertas },
        { status: 409 },
      );
    }
    if (err instanceof MercadoLivreHttpError) {
      // ⚠️ ML reads 403/404 SWAPPED against intuition on this surface: 404 is
      // "user not authorized", 403 is "claim does not exist". Copy that says
      // "não encontrada" for a 404 would send the operator hunting for a claim
      // that is right there.
      const mapa: Record<number, { code: string; error: string }> = {
        422: {
          code: 'ML_ACAO_NAO_ELEGIVEL',
          error:
            'O Mercado Livre não permite esta resolução nesta reclamação (por exemplo compra internacional, ou sem etiqueta de devolução).',
        },
        404: {
          code: 'ML_CLAIM_SEM_ACESSO',
          error: 'Esta conta do Mercado Livre não tem acesso a esta reclamação.',
        },
        403: {
          code: 'ML_CLAIM_INEXISTENTE',
          error: 'Reclamação não encontrada no Mercado Livre.',
        },
      };
      const mapped = mapa[err.status];
      if (mapped) {
        console.warn('[mercado-livre] reclamação recusada pelo ML', {
          claimId,
          acao,
          status: err.status,
          code: mapped.code,
        });
        return NextResponse.json(mapped, { status: 409 });
      }
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
