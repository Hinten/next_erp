/**
 * `POST /api/marketplace/amazon/atualizar-precos` — start the conta's price
 * RUN (master plan step 13, PR 13-g): one operator-started job over every link
 * of the conta, whose pages ride the jobs queue `processAmazonListingsJob`
 * (`tipo: 'preco-pagina'`). Body: `{ integracaoId, baixarPreco?,
 * confirmarReducaoEmMassa? }`, strict (both absent ⇒ `false`). Answers 202
 * `respostaInicioExecucaoPrecoAmazonSchema` (`{ execucaoId, retomada }`: a run
 * this request claimed, or a stalled live one re-kicked under its same id),
 * or the `erroPrecoAmazonSchema` envelope: 409
 * `AMAZON_PRECO_EXECUCAO_EM_CURSO` with the live run's `execucaoId`, 503
 * `AMAZON_PRECO_ENFILEIRAMENTO_FALHOU` with a `motivo` (`fila-desligada`:
 * nothing claimed; `enfileiramento-incerto`: a claimed run's page 0 failed to
 * enqueue and the run was closed `falhou`, or a re-kick's page failed and the
 * run stays stalled), the body, conta and read-switch refusals. ⚠️ A re-kick
 * (`retomada: true`) continues the run under its STORED `baixarPreco`,
 * `confirmarReducaoEmMassa` and `solicitadaPor`: this request's flags and
 * caller are not applied. To change them, cancel, then start a new run.
 *
 * THIN: the strict body, the read switch, the queue's region and the conta
 * live in `lib/amazon/preco/envioManualPreco.ts`; the claim, the re-kick and
 * page 0's named enqueue in `lib/amazon/preco/inicioExecucaoPreco.ts`, whose
 * typed answer this route only maps. No Amazon call, and no price write valve,
 * canary list or preview flag read here: the run's pages and its decision step
 * read them on the functions surface.
 *
 * `PERM.integracao.write`: the run is conta-scoped. The caller's uid is the
 * run's `solicitadaPor`. What the bodies rethrow reaches the platform as a 500.
 * Every answer built here carries `Cache-Control: no-store` and
 * `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  filaLotesDesligadaAmazon,
  produtorDaExecucaoPrecoAmazon,
  regiaoDaFilaLeituraAmazon,
} from '@/lib/firebase/filaLeitura';
import { comCabecalhosAmazon, respostaJson } from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';
import { iniciarAtualizacaoPrecosAmazon } from '@/lib/amazon/preco/envioManualPreco';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);

  const r = await iniciarAtualizacaoPrecosAmazon(req, auth.caller.uid, {
    ambiente: process.env,
    db: getAdminFirestore,
    filaDesligada: filaLotesDesligadaAmazon(),
    regiao: regiaoDaFilaLeituraAmazon,
    produtor: produtorDaExecucaoPrecoAmazon,
    agora: () => Date.now(),
    // The Web Crypto global: a fresh run id, inside the feed core's id grammar.
    gerarExecucaoId: () => crypto.randomUUID(),
    logger: LOGGER_STDOUT_AMAZON,
  });
  return respostaJson(r.status, r.corpo);
}
