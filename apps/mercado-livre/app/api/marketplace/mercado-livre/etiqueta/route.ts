/**
 * `GET /api/marketplace/mercado-livre/etiqueta?pedidoId=<id>&formato=pdf|zpl2`
 * — fetch a pedido's shipment label straight from Mercado Livre
 * (`GET /shipment_labels`) and stream the bytes back as a download. `pdf`
 * passes ML's bytes through untouched; `zpl2` strips any embedded DANFE ZPL
 * blocks from ML's ZIP (the ERP prints its own DANFE — legacy parity), falling
 * back to the original bytes whenever the strip does not apply (never block
 * printing).
 *
 * Requires `PERM.frete.read` — idempotent and free (no checkout), the
 * apps/melhor-envio `imprimir` precedent. The pedido ladder mirrors the STRICT
 * half of `nfeUpload.ts`, not its optimistic-enqueue `shouldUploadForPedido`:
 * a user is waiting for bytes here, so every gap is a hard 409 instead of a
 * queue-backoff retry.
 *
 * Responses: 200 binary (Content-Type byte-sniffed `%PDF`→pdf / `PK`→zip,
 * `Content-Disposition: attachment`, `Cache-Control: no-store`) · 400
 * `QUERY_INVALIDA` · 404 `PEDIDO_NAO_ENCONTRADO` · 409
 * `FRETE_NAO_MERCADO_LIVRE` / `FRETE_SEM_EXTERNAL_ID` / `ML_CONTA_INATIVA` /
 * `ML_INVOICE_PENDING` (NF-e not uploaded to ML yet) /
 * `ML_ETIQUETA_INDISPONIVEL` (any other ML `failed_shipments` refusal) ·
 * conta/token/network errors map via `respond.ts`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INTEGRACAO_FRETE, idFromRef } from '@delfrance/schemas';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  MercadoLivreLabelUnavailableError,
  createMercadoLivreApi,
  removeZplDanfeFromZip,
} from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  pedidoId: z.string().min(1),
  formato: z.enum(['pdf', 'zpl2']),
});

/** Legacy support message for a ML frete that never received its shipment id. */
const SEM_EXTERNAL_ID_MSG =
  'Não foi possível encontrar o frete no Mercado Livre deste pedido. ' +
  'Entre em contato com o suporte para que o problema possa ser verificado.';

/**
 * Content-Type + filename extension from the leading bytes; the requested
 * formato only breaks the tie when the bytes match neither signature.
 */
function sniffLabelBytes(
  bytes: Uint8Array,
  formato: 'pdf' | 'zpl2',
): { contentType: string; extension: 'pdf' | 'zip' } {
  // '%PDF'
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return { contentType: 'application/pdf', extension: 'pdf' };
  }
  // 'PK' — a ZIP (ML ships zpl2 zipped).
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return { contentType: 'application/zip', extension: 'zip' };
  }
  return {
    contentType: 'application/octet-stream',
    extension: formato === 'pdf' ? 'pdf' : 'zip',
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.read);
  if ('error' in auth) return auth.error;

  const query = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) {
    return NextResponse.json(
      {
        error: 'Query inválida: pedidoId e formato (pdf | zpl2) são obrigatórios.',
        code: 'QUERY_INVALIDA',
      },
      { status: 400 },
    );
  }
  const { pedidoId, formato } = query.data;

  const db = getAdminFirestore();
  const snap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  if (!snap.exists) {
    return NextResponse.json(
      { error: 'Pedido não encontrado.', code: 'PEDIDO_NAO_ENCONTRADO' },
      { status: 404 },
    );
  }
  const pedido = pedidoCollection.parseRead(
    snap.data() ?? {},
    pedidoCollection.docPath({}, pedidoId),
  );

  const frete = pedido.freteInicial;
  // Covers frete == null too: only a Mercado Livre-owned frete has a label here.
  if (frete == null || frete.externalOptionIntegracao !== INTEGRACAO_FRETE.mercadoLivre) {
    return NextResponse.json(
      {
        error: 'O frete deste pedido não pertence ao Mercado Livre.',
        code: 'FRETE_NAO_MERCADO_LIVRE',
      },
      { status: 409 },
    );
  }
  const shipmentId = frete.externalId ?? '';
  if (shipmentId === '') {
    return NextResponse.json(
      { error: SEM_EXTERNAL_ID_MSG, code: 'FRETE_SEM_EXTERNAL_ID' },
      { status: 409 },
    );
  }
  // A ML frete without its integração ref cannot resolve a conta — same class
  // of inconsistency as the non-ML frete above (idFromRef('') guards a
  // malformed ref the same way as a missing one).
  const integracaoId =
    pedido.integracaoPedidoOuterRef == null ? '' : idFromRef(pedido.integracaoPedidoOuterRef);
  if (integracaoId === '') {
    return NextResponse.json(
      {
        error:
          'O pedido não tem integração de marketplace — não há como resolver a conta do Mercado Livre.',
        code: 'FRETE_NAO_MERCADO_LIVRE',
      },
      { status: 409 },
    );
  }

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    if (ctx.conta.ativo === false) {
      return NextResponse.json(
        { error: `Integração ${integracaoId} está inativa.`, code: 'ML_CONTA_INATIVA' },
        { status: 409 },
      );
    }
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    // NO shipment-status precheck (legacy parity): fire the labels GET and map
    // ML's refusal in the catch — a precheck would double the ML round-trips.
    const result = await api.getShipmentLabels(shipmentId, formato);

    let bytes = result.bytes;
    if (formato === 'zpl2') {
      // null = nothing stripped / not a valid ZIP → fail-safe to the original
      // bytes, never block printing (legacy parity).
      const stripped = removeZplDanfeFromZip(bytes);
      if (stripped != null) bytes = stripped;
    }

    const sniff = sniffLabelBytes(bytes, formato);
    // `numero` is free-form wire data — a quote / '%' / non-latin1 char would
    // make the header invalid (undici throws) or break the client-side
    // decode, so anything outside a safe set falls back to the doc id.
    const rawName = String(pedido.numero ?? pedidoId);
    const safeName = /^[\w.-]+$/.test(rawName) ? rawName : pedidoId;
    // A Uint8Array is a valid undici body; the cast only bridges the DOM lib's
    // BodyInit typing (apps/nfe danfe route precedent).
    return new NextResponse(bytes as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': sniff.contentType,
        'Content-Disposition': `attachment; filename="etiqueta-${safeName}.${sniff.extension}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    // BEFORE the generic mapper: the label refusal extends the package error
    // base, so mercadoLivreErrorResponse would bury it as a generic upstream
    // failure instead of the actionable 409.
    if (err instanceof MercadoLivreLabelUnavailableError) {
      if (err.mlMessage.includes('invoice_pending')) {
        return NextResponse.json(
          {
            error:
              'O Mercado Livre ainda aguarda a NF-e deste envio — envie a NF-e antes de imprimir a etiqueta.',
            code: 'ML_INVOICE_PENDING',
          },
          { status: 409 },
        );
      }
      // mlMessage is '' on the empty-body legacy guard — fall back to the
      // error's own PT message so the 409 never carries a blank reason.
      return NextResponse.json(
        {
          error: err.mlMessage === '' ? err.message : err.mlMessage,
          code: 'ML_ETIQUETA_INDISPONIVEL',
        },
        { status: 409 },
      );
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
