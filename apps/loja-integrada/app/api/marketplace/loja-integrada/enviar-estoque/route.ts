/**
 * `POST /api/marketplace/loja-integrada/enviar-estoque` — the produtos table's "enviar estoque" for
 * a Loja Integrada conta (master plan step 12, PR 12-h). Body `corpoEnvioEstoqueLiSchema`
 * (`{ contaId, produtoIds[1..200] }`, strict; no `reenviarComErro`: this channel keeps no refusal
 * latch to bypass). Requires `PERM.integracao.write`, the bit the other channels' manual stock
 * pushes and this app's conta writes require. Answers 200 `respostaEnvioEstoqueLiSchema`, or the
 * `erroContaLojaIntegradaSchema` envelope.
 *
 * ENQUEUE-ONLY: no Loja Integrada call, no credential read, no Firestore write. One stock send task
 * per linked child (`origem: manual`, ids only); a queued row says `enfileirado`, never "sent" —
 * the send run reads the ERP and the store minutes later and decides. The work, its reads and its
 * bound are `lib/lojaIntegrada/estoque/envioManualEstoqueLi.ts`.
 *
 * In order, each refusal before any read where it says so:
 *
 *  1. the caller (401/403) and the strict body (400 `LI_CORPO_INVALIDO`, field paths only);
 *  2. the stock valve `LOJA_INTEGRADA_MODO_ESTOQUE`: `off` ⇒ 503 `LI_ESTOQUE_DESLIGADO` (one valve
 *     line when the value is unrecognised) — the send run would drop every task;
 *  3. the read switch `LOJA_INTEGRADA_CHAMADAS`, not exactly `on` ⇒ 503 `LI_CHAMADAS_DESLIGADAS`
 *     and one `chamada-bloqueada` line: every send run needs its deciding GET, so each task would
 *     cost its ERP reads for nothing (the catalogue routes' precedent);
 *  4. this backend's Cloud Tasks valve `LOJA_INTEGRADA_TASKS_DISABLED=1` ⇒ 503
 *     `LI_TAREFAS_DESLIGADAS`;
 *  5. the queues' region (`regiaoDasFilasLiAppHosting`): unset ⇒ `MissingRegionError`, a 500;
 *     — zero Firestore reads up to here —
 *  6. the conta, read UNCACHED (one read): missing or not `tipo` 3 ⇒ 404 `LI_CONTA_NAO_ENCONTRADA`,
 *     inactive ⇒ 409 `LI_CONTA_INATIVA`, no depósito ⇒ 409 `LI_CONTA_SEM_DEPOSITO`;
 *  7. the core: 400 `LI_SELECAO_EXCEDE_LIMITE` (with `limite` and `solicitados`) when the selection
 *     reaches more children than one push may enqueue, nothing listed or enqueued; else 200.
 *
 * A 500 from the core (a Firestore failure, a deploy-shaped enqueue refusal) may come after some
 * tasks landed: repeating within the minute collides with them harmlessly. ONE structured INFO line
 * per answer the core gave (`core/log.ts`'s writer), counts and ids only.
 */
import { NextResponse } from 'next/server';
import { corpoEnvioEstoqueLiSchema } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  agendadorEstoqueLiDoAppHosting,
  regiaoDasFilasLiAppHosting,
  tarefasLiDesligadasNoAppHosting,
} from '@/lib/firebase/filasLi';
import { escritorPadrao } from '@/lib/lojaIntegrada/core/log';
import {
  lerCorpoLi,
  respostaChamadasDesligadas,
  respostaDaContaDoEstoqueLi,
  respostaEstoqueDesligado,
  respostaSelecaoExcedeLimite,
  respostaTarefasDesligadas,
} from '@/lib/lojaIntegrada/core/respond';
import {
  FLUXO_LI,
  MODO_LI,
  lerChaveDeChamadas,
  lerValvula,
  registrarChamadaBloqueadaLi,
  registrarValvulaLi,
} from '@/lib/lojaIntegrada/core/valvulas';
import { contaDoEstoqueLi } from '@/lib/lojaIntegrada/estoque/contaDoEstoqueLi';
import { enviarEstoqueManualLi } from '@/lib/lojaIntegrada/estoque/envioManualEstoqueLi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG = '[loja-integrada/enviar-estoque]';

/** The operation the read switch's line names. */
const OPERACAO_ENVIO_ESTOQUE_LI = 'enviarEstoqueManual';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const corpo = await lerCorpoLi(req, corpoEnvioEstoqueLiSchema);
  if (!corpo.ok) return corpo.resposta;
  const { contaId, produtoIds } = corpo.dados;

  // The environment, read once, before any read.
  const ambiente = process.env;
  const valvula = lerValvula(FLUXO_LI.estoque, ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido) registrarValvulaLi(valvula, { conta: contaId });
    return respostaEstoqueDesligado();
  }
  if (!lerChaveDeChamadas(ambiente)) {
    registrarChamadaBloqueadaLi(OPERACAO_ENVIO_ESTOQUE_LI, ambiente, { conta: contaId });
    return respostaChamadasDesligadas();
  }
  if (tarefasLiDesligadasNoAppHosting()) return respostaTarefasDesligadas();
  // Resolved here once, before any read; the producer resolves it again per enqueue.
  regiaoDasFilasLiAppHosting();

  const db = getAdminFirestore();
  const conta = await contaDoEstoqueLi(db, contaId);
  if (conta.tipo !== 'ok') return respostaDaContaDoEstoqueLi(contaId, conta);

  const r = await enviarEstoqueManualLi(
    { contaId, produtoIds, modo: valvula.modo },
    { db, agendador: agendadorEstoqueLiDoAppHosting(), agoraMs: () => Date.now() },
  );
  // ONE structured INFO line (Cloud Logging severity), ids and counts only.
  escritorPadrao('INFO', `${LOG} ${r.tipo}`, {
    integracaoId: contaId,
    modo: valvula.modo,
    ...r.contagens,
  });
  if (r.tipo === 'excede-limite') return respostaSelecaoExcedeLimite(r.limite, r.alvos);
  return NextResponse.json(r.resposta, { headers: { 'Cache-Control': 'no-store' } });
}
