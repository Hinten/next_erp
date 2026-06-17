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
  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    const result = await comprarEtiqueta({
      api: ctx.api,
      printLabelId: printLabelId ?? null,
      buildCartPayload: () => cartPayload,
      // Anti-loss anchor: persist the label id before checkout spends balance.
      persistPrintLabelId: async (id) => {
        await pedidoCollection.docRef(db, {}, pedidoId).update({ 'freteInicial.printLabelId': id });
      },
    });

    await pedidoCollection.docRef(db, {}, pedidoId).update({
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
