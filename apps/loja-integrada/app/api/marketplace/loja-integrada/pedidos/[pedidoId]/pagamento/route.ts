/**
 * `GET /api/marketplace/loja-integrada/pedidos/[pedidoId]/pagamento` — the paid re-check of one
 * Loja Integrada pedido (master plan step 15, #1825): what the order's CURRENT Loja Integrada
 * situação says, before the web lets it be dispatched. Requires `PERM.pedido.read`.
 *
 * The wire contract is `packages/schemas/src/conferenciaPagamentoLojaIntegrada.ts`, shared with the
 * web's gates (`apps/web/lib/loja-integrada/conferenciaPagamento.ts`): every 200 is built through
 * `respostaConferenciaPagamentoLiSchema`, so nothing else from Loja Integrada's order body (which
 * carries the buyer's personal data) can ride along.
 *
 * - 200 `{aplicavel: false, motivo}` — not an imported order (no conta ref, no canonical numero,
 *   or an id that is not the import's digest): only the ERP's own gates apply. No call was made.
 * - 200 `{aplicavel: true, fonte: 'loja', veredito, codigo, …}` — the live verdict.
 * - 200 `{aplicavel: true, fonte: 'erp', veredito: 'contestado', …}` — the live read could not
 *   run, and the ERP's contested mirror is open.
 * - 400 `LI_ID_INVALIDO`; 401/403 (the caller); 404 `LI_PEDIDO_NAO_ENCONTRADO`.
 * - The conta's own refusals through the shared mapper (`respond.ts`): 503
 *   `LI_CHAMADAS_DESLIGADAS` (the read switch, D17), 404/409 for the conta and its credential (a
 *   401 parks the conta first), 503 `LI_ESTACIONAMENTO_EM_CONFLITO`.
 * - This route's own: 503 `LI_LIMITE_DE_CHAMADAS`, 504 `LI_TEMPO_ESGOTADO_LOJA`, 502
 *   `LI_LOJA_INDISPONIVEL`, 409 `LI_PEDIDO_AUSENTE_NA_LOJA`, 502 `LI_PEDIDO_DIVERGENTE`.
 * - 499 with an empty body: the caller went away during the read.
 * - Anything else (a Firestore outage, our own misconfiguration) is rethrown, so it surfaces as a
 *   500 instead of being swallowed (root rule 6).
 *
 * The work is `lib/lojaIntegrada/pedidos/conferenciaPagamento.ts`: ERP reads first, then the
 * context loader — whose first act is the read switch, so while it is off nothing reaches Loja
 * Integrada — then ONE paced `buscarPedidoLi`, never a raw `fetch` (`prazos.test.ts` counts it).
 *
 * Every answer that is not a verdict (an error envelope, or the mirror standing in for the live
 * read) logs ONE line: the pedido, the conta, the caller's uid, the cause and what the mirror
 * said — never a name, an endereço or anything from the order body.
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { naoDocId, respostaConferenciaPagamentoLiSchema } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  respostaCancelada,
  respostaDeErroLi,
  respostaIdDePedidoInvalido,
  respostaLi,
  respostaPedidoNaoEncontrado,
} from '@/lib/lojaIntegrada/core/respond';
import { ritmoDeLeituraLi } from '@/lib/lojaIntegrada/core/ritmo';
import {
  type FalhaConferenciaLi,
  conferirPagamentoLi,
} from '@/lib/lojaIntegrada/pedidos/conferenciaPagamento';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG = '[loja-integrada/conferencia-pagamento]';

/** The pacer's sleep. */
function esperar(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What a log line names as the cause: the app error's class, or this route's code. */
function causaDe(falha: FalhaConferenciaLi): string {
  return falha.tipo === 'conta' ? falha.erro.name : falha.code;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ pedidoId: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.pedido.read);
  if ('error' in auth) return auth.error;
  const { pedidoId } = await params;
  if (naoDocId(pedidoId)) return respostaIdDePedidoInvalido();

  const r = await conferirPagamentoLi(
    {
      db: getAdminFirestore(),
      ambiente: process.env,
      ritmo: ritmoDeLeituraLi(esperar),
      sinal: req.signal,
      agoraMs: () => Date.now(),
      increment: (by: number) => FieldValue.increment(by),
      logger: console,
    },
    pedidoId,
  );
  const uid = auth.caller.uid;

  switch (r.tipo) {
    case 'pedido-nao-encontrado':
      return respostaPedidoNaoEncontrado();
    case 'cancelado':
      return respostaCancelada();
    case 'resposta':
      if (r.naoVerificavel !== null) {
        console.warn(`${LOG} conferência não verificável; o espelho do ERP respondeu`, {
          pedidoId,
          conta: r.contaId,
          uid,
          causa: causaDe(r.naoVerificavel),
          espelho: r.resposta.aplicavel ? r.resposta.veredito : null,
        });
      }
      return NextResponse.json(respostaConferenciaPagamentoLiSchema.parse(r.resposta));
    case 'falha':
      console.warn(`${LOG} conferência sem veredito`, {
        pedidoId,
        conta: r.contaId,
        uid,
        causa: causaDe(r.falha),
        espelho: r.espelhoLido ? 'sem-contestacao' : null,
      });
      return r.falha.tipo === 'conta'
        ? respostaDeErroLi(r.falha.erro)
        : respostaLi(r.falha.status, r.falha.code, r.falha.mensagem);
  }
}
