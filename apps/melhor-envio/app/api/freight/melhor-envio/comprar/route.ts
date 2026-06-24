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
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cartInsertRequestSchema, comprarEtiqueta } from '@delfrance/integrations-freight-br';
import { pedidoCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import { isMelhorEnvioError, melhorEnvioErrorResponse } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  intFreteId: z.string().min(1),
  pedidoId: z.string().min(1),
  cartPayload: cartInsertRequestSchema,
  printLabelId: z.string().nullable().optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
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
  const { intFreteId, pedidoId, cartPayload, printLabelId } = parsed.data;

  const db = getAdminFirestore();
  const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);

  // Confirm the pedido exists BEFORE touching Melhor Envio — checkout spends
  // wallet balance, so we must never buy a label for a pedido we can't persist
  // it to. A missing pedido is the caller's mistake (404), not a 500.
  const snap = await pedidoRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: `Pedido ${pedidoId} não encontrado.` }, { status: 404 });
  }

  // The pedido doc is authoritative for the resume anchor — NOT the client body.
  // A stale browser (the table row's `pedido` prop captured before a prior buy)
  // can send `printLabelId: null` after a label was already bought; trusting it
  // would make the pipeline fresh-buy a SECOND label and spend balance twice.
  // Reading the persisted id here makes a repeat buy resume (reprint) instead.
  const persistedLabelId =
    (snap.data()?.freteInicial as { printLabelId?: string | null } | undefined)?.printLabelId ??
    null;

  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    const result = await comprarEtiqueta({
      api: ctx.api,
      printLabelId: persistedLabelId ?? printLabelId ?? null,
      buildCartPayload: () => cartPayload,
      // Anti-loss anchor: persist the label id before checkout spends balance.
      persistPrintLabelId: async (id) => {
        await pedidoRef.update({ 'freteInicial.printLabelId': id });
      },
    });

    await pedidoRef.update({
      'freteInicial.estado': 'aguardandoPostagem',
      'freteInicial.codRastreio': result.tracking,
    });

    return NextResponse.json({
      printLabelId: result.printLabelId,
      printUrl: result.printUrl,
      tracking: result.tracking,
      estado: 'aguardandoPostagem',
    });
  } catch (err) {
    if (isMelhorEnvioError(err)) return melhorEnvioErrorResponse(err);
    throw err;
  }
}
