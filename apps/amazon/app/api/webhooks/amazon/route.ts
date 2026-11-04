/**
 * `POST /api/webhooks/amazon` — the push receiver (master plan step 3): the AWS
 * relay (SQS → EventBridge Pipe → API destination) delivers each Amazon
 * notification here, one per request, with the relay key in
 * `CABECALHO_CHAVE_RELAY_AMAZON`. The path is `CAMINHO_RECEPTOR_AMAZON`, the
 * contract the relay's `ReceiverUrl` parameter is built from
 * (`estrutura.test.ts` pins this file's path to it).
 *
 * PUBLIC: no Bearer token (a server-to-server call) and OUTSIDE the CORS
 * proxy's `/api/marketplace/:path*` matcher. The relay key is the only trust
 * anchor; no app has a `middleware.ts`.
 *
 * THIN: every decision — the 503/401/200/500 table, the bounded body, the
 * envelope, the deadlines, the failure persist — lives in
 * `lib/amazon/notificacoes/receptor.ts`. This file binds the real dependencies
 * and answers the status with an EMPTY body, `Cache-Control: no-store` and
 * `Referrer-Policy: no-referrer` (`respostaVazia`). What the receptor rethrows
 * reaches the platform as a 500, which the relay retries.
 */
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  agendadorDaFilaLeituraAmazon,
  regiaoDaFilaLeituraAmazon,
} from '@/lib/firebase/filaLeitura';
import { respostaVazia } from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';
import {
  criarEstadoDaInstanciaReceptorAmazon,
  receberNotificacaoAmazon,
} from '@/lib/amazon/notificacoes/receptor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** This instance's memory (the once-per-instance rotation WARNING). */
const INSTANCIA = criarEstadoDaInstanciaReceptorAmazon();

export async function POST(req: Request): Promise<Response> {
  const r = await receberNotificacaoAmazon(req, {
    ambiente: process.env,
    regiao: regiaoDaFilaLeituraAmazon,
    agendador: agendadorDaFilaLeituraAmazon(),
    db: getAdminFirestore,
    logger: LOGGER_STDOUT_AMAZON,
    agora: () => Date.now(),
    instancia: INSTANCIA,
  });
  return respostaVazia(r.status);
}
