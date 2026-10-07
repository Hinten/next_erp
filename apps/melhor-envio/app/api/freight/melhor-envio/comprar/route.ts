/**
 * `POST /api/freight/melhor-envio/comprar`
 *
 * Buys (and generates + prints) a Melhor Envio label for a pedido. The
 * idempotent pipeline lives in `freight-br`; this route wires it to the
 * pedido document: it persists `freteInicial.printLabelId` **before** checkout
 * (the anti-loss anchor — checkout spends wallet balance) and writes the final
 * estado/codRastreio after the label is generated. The browser supplies the
 * already-built cart payload (it holds the resolved pedido/cliente/endereço/
 * filial), mirroring how `calculate` takes a client-built request.
 *
 * ⚠️ **One buy per pedido at a time (#1677).** The anchor only made a
 * SEQUENTIAL re-click safe; two CONCURRENT requests both read "no label yet"
 * and each paid for one. The route now holds the pedido's in-flight claim
 * (`lib/freight/compraEtiqueta.ts`) for the whole run:
 *
 *  - a second request while the claim is live → **423 `ME_COMPRA_EM_ANDAMENTO`**
 *    before any Melhor Envio call;
 *  - the anchor is a compare-and-set and `checkout` / `generate` are fenced, so a
 *    run that lost the claim (a zombie the platform already abandoned) can
 *    neither anchor a second label nor pay for one;
 *  - the claim is released on every exit EXCEPT when a paid step failed in
 *    transit (`ehDesfechoPagoIncerto`: its own timeout, a dropped connection, a
 *    gateway-class status): then whether it paid is unknown, the claim holds
 *    until it expires so nobody re-buys over a payment Melhor Envio may still be
 *    settling, and the answer is the "outcome unknown" coded 504;
 *  - a label that was PAID but that the pedido no longer points at (the frete
 *    was re-pointed mid-buy) is a coded 412 naming it — never a 200.
 *
 * The anchor comes from the pedido document only. The body's `printLabelId` is
 * still accepted (older tabs send it) and ignored: a value the pedido does not
 * hold could only resume a label from a frete that was cleared or changed.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  cartInsertRequestSchema,
  comprarEtiqueta,
  type ComprarEtiquetaApi,
  MelhorEnvioTimeoutError,
} from '@delfrance/integrations-freight-br';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  adquirirCompraEtiqueta,
  ancorarEtiqueta,
  CompraEtiquetaAncoraMudouError,
  CompraEtiquetaJanelaEsgotadaError,
  CompraEtiquetaPossePerdidaError,
  ehDesfechoPagoIncerto,
  type EtapaPagaCompraEtiqueta,
  finalizarCompraEtiqueta,
  garantirPosseCompraEtiqueta,
  liberarCompraEtiqueta,
} from '@/lib/freight/compraEtiqueta';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import {
  compraEmAndamentoResponse,
  compraEtiquetaErrorResponse,
  desfechoPagoIncertoResponse,
  etiquetaDesvinculadaResponse,
  isMelhorEnvioError,
  melhorEnvioErrorResponse,
} from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  intFreteId: z.string().min(1),
  pedidoId: z.string().min(1),
  cartPayload: cartInsertRequestSchema,
  // Accepted for older tabs, IGNORED — the anchor is read from the pedido (#1677).
  printLabelId: z.string().nullable().optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  // The paid window counts from ARRIVAL: the platform's request ceiling does.
  const inicioMs = Date.now();
  const auth = await verifyCaller(req, PERM.frete.write);
  if ('error' in auth) return auth.error;

  let json: unknown;
  try {
    json = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Validação falhou: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      },
      { status: 400 },
    );
  }
  const { intFreteId, pedidoId, cartPayload } = parsed.data;

  const db = getAdminFirestore();

  // Claim the pedido BEFORE touching Melhor Envio. The same transaction confirms
  // the pedido exists — checkout spends wallet balance, so we must never buy a
  // label for a pedido we can't persist it to (a missing pedido is the caller's
  // mistake, 404) — and reads the resume anchor from the snapshot that granted
  // the claim, so a previous holder's anchor can never be missed.
  const aquisicao = await adquirirCompraEtiqueta(db, {
    pedidoId,
    inicioMs,
    uid: auth.caller.uid,
    intFreteId,
  });
  if (aquisicao.kind === 'pedido-ausente') {
    return NextResponse.json({ error: `Pedido ${pedidoId} não encontrado.` }, { status: 404 });
  }
  if (aquisicao.kind === 'ocupado') return compraEmAndamentoResponse(aquisicao.leaseExpiraEmMs);
  const { posse } = aquisicao;

  let finalizado = false;
  // Set when a paid step failed IN TRANSIT (`ehDesfechoPagoIncerto`): the money
  // outcome is unknown, so the claim is kept until it expires instead of freeing
  // an immediate re-buy, and the operator is told to check, not to retry.
  let etapaIncerta: EtapaPagaCompraEtiqueta | null = null;

  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);

    // The fence wraps the two paid steps of the injected api, so freight-br's
    // pipeline is unchanged: each one first proves this run still owns the
    // pedido, is inside the paid window, and (checkout) is paying the anchor.
    const pago =
      (etapa: EtapaPagaCompraEtiqueta, chamar: (ids: readonly string[]) => Promise<unknown>) =>
      async (orderIds: readonly string[]): Promise<unknown> => {
        await garantirPosseCompraEtiqueta(db, posse, etapa, orderIds);
        try {
          return await chamar(orderIds);
        } catch (err) {
          if (ehDesfechoPagoIncerto(err, etapa)) etapaIncerta = etapa;
          throw err;
        }
      };
    const api: ComprarEtiquetaApi = {
      addToCart: (r) => ctx.api.addToCart(r),
      getOrder: (id) => ctx.api.getOrder(id),
      print: (ids) => ctx.api.print(ids),
      checkout: pago('checkout', (ids) => ctx.api.checkout(ids)),
      generate: pago('generate', (ids) => ctx.api.generate(ids)),
    };

    const result = await comprarEtiqueta({
      api,
      printLabelId: aquisicao.printLabelIdAncorado,
      buildCartPayload: () => cartPayload,
      // Anti-loss anchor, now a compare-and-set against the claim (#1677).
      persistPrintLabelId: (id) => ancorarEtiqueta(db, posse, id),
    });

    // Persist the drop-off agency the buy carried (#377) so the operator's
    // picker choice survives onto the doc (`externalOptionData.agency`) and a
    // later re-buy/reprint sees it. Auto-resolved agencies (payload without
    // one) don't reach here — only an explicit client-set value is recorded.
    const agency = (cartPayload as { agency?: unknown }).agency;
    const finalizacao = await finalizarCompraEtiqueta(db, posse, {
      printLabelId: result.printLabelId,
      tracking: result.tracking,
      providerStatus: result.order.status ?? null,
      agency: typeof agency === 'number' ? agency : null,
    });
    finalizado = true;

    if (finalizacao.kind === 'desvinculada') {
      // PAID, and the pedido does not point at it: never answer success, or the
      // operator buys again and pays twice while this label is linked to nothing.
      console.error('[melhor-envio/comprar] etiqueta paga sem vínculo com o pedido', {
        pedidoId,
        printLabelId: result.printLabelId,
      });
      return etiquetaDesvinculadaResponse(result);
    }

    return NextResponse.json({
      printLabelId: result.printLabelId,
      printUrl: result.printUrl,
      tracking: result.tracking,
      estado: finalizacao.estado,
    });
  } catch (err) {
    if (
      err instanceof CompraEtiquetaPossePerdidaError ||
      err instanceof CompraEtiquetaJanelaEsgotadaError ||
      err instanceof CompraEtiquetaAncoraMudouError
    ) {
      return compraEtiquetaErrorResponse(err);
    }
    // A paid step that failed in transit gets the "outcome unknown" answer —
    // except a timeout of that step, whose own coded 504 already says it.
    if (etapaIncerta !== null && !(err instanceof MelhorEnvioTimeoutError)) {
      return desfechoPagoIncertoResponse(etapaIncerta);
    }
    if (isMelhorEnvioError(err)) return melhorEnvioErrorResponse(err);
    throw err;
  } finally {
    // `finalizar` already deleted the claim in its own commit.
    if (!finalizado && etapaIncerta === null) await liberarSemMascarar(db, posse);
  }
}

/**
 * Release the claim WITHOUT letting a Firestore failure replace the outcome
 * already chosen. A throw from a `finally` overrides the response in flight (a
 * 422 with Melhor Envio's field errors, a 412, a 503) or the original exception,
 * so the operator would see a generic 500 and the cause would vanish from the
 * logs. A Firestore error is logged and swallowed — the claim then simply
 * expires — and anything else (a bug) still propagates (root rule 6).
 */
async function liberarSemMascarar(
  db: Parameters<typeof liberarCompraEtiqueta>[0],
  posse: Parameters<typeof liberarCompraEtiqueta>[1],
): Promise<void> {
  try {
    await liberarCompraEtiqueta(db, posse);
  } catch (err) {
    if (!isGrpcStatusError(err)) throw err;
    console.error('[melhor-envio/comprar] não foi possível liberar o claim; ele expira sozinho', {
      pedidoId: posse.pedidoId,
      code: err.code,
    });
  }
}
