/**
 * `PUT /api/marketplace/loja-integrada/pedidos/[pedidoId]/rota-etiqueta` — route one Loja
 * Integrada pedido's label (master plan step 15, #1825): re-point a pedido that still names its
 * conta's Loja Integrada `int_frete` doc at the label target the conta's `mapa`, a stored override
 * or the operator's choice (`escolha`) resolves. Requires `PERM.frete.write` — the Melhor Envio
 * buy's own permission: whoever can buy a label can route one, and nobody needs pedido write.
 *
 * The wire contract is `packages/schemas/src/rotaEtiquetaLojaIntegrada.ts`, shared with the web
 * client: the body `corpoRotaEtiquetaLiSchema` (strict), the answer `respostaRotaEtiquetaLiSchema`.
 * Every answer is built through that schema, so the target document never rides along.
 *
 * - 200 `roteado` / `ja-roteado` / `recusado`. A refusal is a decision, not an error.
 * - 400 `LI_ID_INVALIDO` (before the body), 400 `LI_CORPO_INVALIDO` (paths only), 401/403 (the
 *   caller), 404 `LI_PEDIDO_NAO_ENCONTRADO`, 503 `LI_ROTA_EM_CONFLITO` (three lost races; retry).
 * - The work is `lib/lojaIntegrada/pedidos/rotaEtiqueta.ts`: raw Admin reads by id and ONE
 *   tier-1 pedido write per attempt (its header has the rule-7 classification).
 * - No call outside the ERP, no Loja Integrada client, no credential, no read switch (D17):
 *   routing works while the switch is off. `estrutura.test.ts` walks this file's run-time import
 *   closure to keep it so.
 * - A refusal or a conflict logs ONE line with ids only — the pedido, the motivo, the attempts —
 *   never an endereço, a name or a document. A success logs nothing.
 * - Anything else (a Firestore outage, a bug) is rethrown, so it surfaces as a 500 instead of
 *   being swallowed (root rule 6).
 */
import { NextResponse } from 'next/server';
import {
  TIPO_RESPOSTA_ROTA_ETIQUETA_LI,
  corpoRotaEtiquetaLiSchema,
  naoDocId,
  respostaRotaEtiquetaLiSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  lerCorpoLi,
  respostaIdDePedidoInvalido,
  respostaPedidoNaoEncontrado,
  respostaRotaEmConflito,
} from '@/lib/lojaIntegrada/core/respond';
import {
  LiRotaEtiquetaEmConflitoError,
  rotearEtiquetaLi,
} from '@/lib/lojaIntegrada/pedidos/rotaEtiqueta';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG = '[loja-integrada/rota-etiqueta]';

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ pedidoId: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.write);
  if ('error' in auth) return auth.error;
  const { pedidoId } = await params;
  if (naoDocId(pedidoId)) return respostaIdDePedidoInvalido();

  const corpo = await lerCorpoLi(req, corpoRotaEtiquetaLiSchema);
  if (!corpo.ok) return corpo.resposta;

  try {
    const r = await rotearEtiquetaLi({ db: getAdminFirestore() }, pedidoId, corpo.dados.escolha);
    if (r.tipo === 'pedido-nao-encontrado') return respostaPedidoNaoEncontrado();
    if (r.resposta.tipo === TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado) {
      console.warn(`${LOG} rota recusada`, {
        pedidoId,
        motivo: r.resposta.motivo,
        tentativas: r.tentativas,
      });
    }
    return NextResponse.json(respostaRotaEtiquetaLiSchema.parse(r.resposta));
  } catch (err) {
    if (!(err instanceof LiRotaEtiquetaEmConflitoError)) throw err;
    console.warn(`${LOG} a escrita perdeu a precondição em todas as tentativas`, {
      pedidoId,
      tentativas: err.tentativas,
    });
    return respostaRotaEmConflito();
  }
}
