/** On-demand carrier tracking; resolves the shipment from the persisted pedido. */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INTEGRACAO_FRETE, idFromRef, mercadoLivreRastreioResultSchema } from '@delfrance/schemas';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  MercadoLivreHttpError,
  MercadoLivreValidationError,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({ pedidoId: z.string().min(1) });
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const indisponivel = () =>
  json({ error: 'Rastreamento ainda indisponível.', code: 'ML_RASTREIO_INDISPONIVEL' }, 409);

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.read);
  if ('error' in auth) {
    auth.error.headers.set('Cache-Control', 'no-store');
    return auth.error;
  }
  const query = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) {
    return json({ error: 'pedidoId é obrigatório.', code: 'QUERY_INVALIDA' }, 400);
  }
  const db = getAdminFirestore();
  const { pedidoId } = query.data;
  const snap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  if (!snap.exists) {
    return json({ error: 'Pedido não encontrado.', code: 'PEDIDO_NAO_ENCONTRADO' }, 404);
  }
  const pedido = pedidoCollection.parseRead(
    snap.data() ?? {},
    pedidoCollection.docPath({}, pedidoId),
  );
  const frete = pedido.freteInicial;
  if (frete?.externalOptionIntegracao !== INTEGRACAO_FRETE.mercadoLivre) {
    return json(
      {
        error: 'O frete deste pedido não pertence ao Mercado Livre.',
        code: 'FRETE_NAO_MERCADO_LIVRE',
      },
      409,
    );
  }
  const shipmentId = frete.externalId ?? '';
  if (shipmentId.trim() === '') {
    return json(
      { error: 'O frete não tem ID de envio no Mercado Livre.', code: 'FRETE_SEM_EXTERNAL_ID' },
      409,
    );
  }
  const integracaoId =
    pedido.integracaoPedidoOuterRef == null ? '' : idFromRef(pedido.integracaoPedidoOuterRef);
  if (integracaoId === '') {
    return json(
      {
        error: 'O pedido não tem conta do Mercado Livre vinculada.',
        code: 'FRETE_NAO_MERCADO_LIVRE',
      },
      409,
    );
  }

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    if (ctx.conta.ativo === false) {
      return json(
        { error: `Integração ${integracaoId} está inativa.`, code: 'ML_CONTA_INATIVA' },
        409,
      );
    }
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
    // Narrow the 404 to THIS resource; an account/token lookup 404 is an error.
    const carrier = await api.getShipmentCarrier(shipmentId).catch((err: unknown) => {
      if (err instanceof MercadoLivreHttpError && err.status === 404) return null;
      throw err;
    });
    if (carrier == null || carrier.url == null || carrier.url.trim() === '') return indisponivel();
    const result = mercadoLivreRastreioResultSchema.safeParse(carrier);
    if (!result.success) {
      throw new MercadoLivreValidationError('Resposta de rastreio inválida.', result.error.issues);
    }
    return json(result.data);
  } catch (err) {
    if (isMercadoLivreError(err)) {
      const response = mercadoLivreErrorResponse(err);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    throw err;
  }
}
