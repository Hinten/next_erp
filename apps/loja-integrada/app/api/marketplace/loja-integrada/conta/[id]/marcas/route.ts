/**
 * `GET /api/marketplace/loja-integrada/conta/[id]/marcas` — the store's brand list (master plan
 * step 10, #1821), inactive brands included and marked. Requires `PERM.integracao.read`.
 *
 * The wire contract is `packages/schemas/src/catalogoLojaIntegrada.ts`: every 200 is built through
 * `respostaMarcasLiSchema`, so nothing else from the store's rows rides along.
 *
 * - 200 `{ marcas, lidaEmMs }`; `?atualizar=1` (exactly) asks for a fresh read.
 * - 400 `LI_ID_INVALIDO`; 401/403 (the caller).
 * - The conta's own refusals: 503 `LI_CHAMADAS_DESLIGADAS` (the read switch, D17), 404/409 for the
 *   conta and its credential; a 401 parks the conta first.
 * - The read's own: 502 `LI_RECURSO_NAO_PERMITIDO` (a 403 here: only this list fails, NOTHING is
 *   parked), 502 `LI_CATALOGO_EXCEDE_LIMITE`, 502 `LI_LOJA_INDISPONIVEL`, 503
 *   `LI_LIMITE_DE_CHAMADAS`, 504 `LI_TEMPO_ESGOTADO_LOJA`.
 * - 499 with an empty body: the caller went away during the read.
 * - Anything else (a 404 on the list, a 3xx, a 400, Firestore, our own misconfiguration) is
 *   rethrown, so it surfaces as a 500 (root rule 6).
 *
 * The work is `lib/lojaIntegrada/catalogo/catalogo.ts` (the context loader and its switch first,
 * then the cache, then the paced package read).
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { respostaMarcasLiSchema } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerCatalogoLi, pedeAtualizacaoLi } from '@/lib/lojaIntegrada/catalogo/catalogo';
import { naoEhIdDeConta } from '@/lib/lojaIntegrada/core/contas';
import {
  respostaCancelada,
  respostaDeFalhaDeLeituraLi,
  respostaIdInvalido,
} from '@/lib/lojaIntegrada/core/respond';
import { ritmoDeLeituraLi } from '@/lib/lojaIntegrada/core/ritmo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The pacer's sleep. */
function esperar(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (naoEhIdDeConta(id)) return respostaIdInvalido();

  const r = await lerCatalogoLi(
    {
      db: getAdminFirestore(),
      ambiente: process.env,
      ritmo: ritmoDeLeituraLi(esperar),
      sinal: req.signal,
      agoraMs: () => Date.now(),
      increment: (by: number) => FieldValue.increment(by),
      logger: console,
    },
    id,
    { recurso: 'marcas' },
    { atualizar: pedeAtualizacaoLi(req.url) },
  );

  switch (r.tipo) {
    case 'cancelado':
      return respostaCancelada();
    case 'falha':
      return respostaDeFalhaDeLeituraLi(r.falha);
    case 'resposta':
      // The web derives its own freshness from `lidaEmMs`; the browser keeps no copy.
      return NextResponse.json(respostaMarcasLiSchema.parse(r.resposta), {
        headers: { 'Cache-Control': 'no-store' },
      });
  }
}
