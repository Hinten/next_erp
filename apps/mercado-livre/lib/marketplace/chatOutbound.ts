/**
 * Mercado Livre **outbound chat** — answering a pergunta and replying on a
 * post-sale thread from the unified inbox (#533).
 *
 * ── Why an HTTP route rather than a Firestore trigger ─────────────────────────
 * WhatsApp sends by writing a mensagem and letting `sendOutbound` transmit it.
 * That shape buys free retries, which pays when failures are TRANSIENT. Here they
 * are not: an ML reply is single-shot and its refusals are terminal and
 * operator-actionable — the question was already answered, the thread is blocked,
 * a mediation is open, the grant is dead. The operator has to see the real reason
 * with their text still on screen, so the send is synchronous and the caller gets
 * the error.
 *
 * ── Capability is re-derived from LIVE ML, every time ─────────────────────────
 * `conversa.respostaBloqueada` is a UI hint written by the importer and stale by
 * construction: a question can be answered on ML's own site, and a post-sale
 * thread can block, between the last import and the operator pressing send. This
 * module NEVER trusts it. It re-reads the question or the pack first, and that
 * read is the authority.
 *
 * ⚠️ Send FIRST, write second. A mensagem written before the ML call would leave
 * a phantom reply in the thread whenever ML refuses — which is #817 inverted:
 * instead of a message that never sends, a message that never existed.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { conversaCollection, mensagemCollection } from '@delfrance/data/admin/collections';
import {
  ESTADO_ENVIO,
  ORIGEM_CONVERSA,
  TIPO_MENSAGEM,
  type OrigemConversa,
} from '@delfrance/schemas';
import { postSaleAgentUserId, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { ANSWER_MENSAGEM_ID } from './questionIds';
import { makeMensagemProvisoriaId } from './mensagemProvisoria';
import { questionActionability } from './questionMapping';
import { orderMessageActionability } from './orderMessageMapping';
import { claimActionability, receiverRoleDaAcao } from './claimActionability';

/**
 * A refusal the OPERATOR can act on — surfaced as a 409 with its reason, never
 * as a generic 500. Distinct from `MercadoLivreHttpError`, which is ML rejecting
 * a request we thought was valid.
 */
export class ChatOutboundRefusedError extends Error {
  constructor(
    readonly motivo: string,
    readonly codigo:
      | 'ML_CONVERSA_NAO_ENCONTRADA'
      | 'ML_ORIGEM_SEM_ENVIO'
      | 'ML_NAO_RESPONDIVEL'
      | 'ML_TEXTO_VAZIO'
      | 'ML_TEXTO_LONGO'
      | 'ML_DADOS_INSUFICIENTES',
  ) {
    super(motivo);
    this.name = 'ChatOutboundRefusedError';
  }
}

export interface ChatOutboundDeps {
  readonly db: Firestore;
  readonly api: MercadoLivreApi;
  readonly conta: { userId: number | null };
  /** ONE clock read, MILLISECONDS. */
  readonly nowMs: number;
}

export interface ChatOutboundResult {
  readonly conversaId: string;
  readonly mensagemId: string;
  /** Set when the send also closed the thread (a question can only be answered once). */
  readonly respostaBloqueada: string | null;
}

/** ML's hard cap on an answer body. */
export const LIMITE_RESPOSTA_PERGUNTA = 2000;
/**
 * The claim-message cap. ⚠️ ML's claims reference states NO explicit character
 * limit, so this is the conservative legacy value rather than an invented
 * larger one — a body ML truncates silently is worse than one we refuse.
 */
export const LIMITE_MENSAGEM_RECLAMACAO = 300;

/** The fallback post-sale cap when ML did not return the live one. */
export const LIMITE_MENSAGEM_PEDIDO_PADRAO = 350;

function refuse(codigo: ChatOutboundRefusedError['codigo'], motivo: string): never {
  throw new ChatOutboundRefusedError(motivo, codigo);
}

/** The origens this module can transmit on. */
const ORIGENS_COM_ENVIO: ReadonlySet<OrigemConversa> = new Set([
  ORIGEM_CONVERSA.mercadoLivrePerguntas,
  ORIGEM_CONVERSA.mercadoLivrePedido,
  ORIGEM_CONVERSA.mercadoLivreReclamacoes,
]);

/**
 * Send a reply on an ML conversa and append it to the thread.
 *
 * Throws {@link ChatOutboundRefusedError} for anything the operator can fix, and
 * lets `MercadoLivreHttpError` / reauth errors through for the route's mapper.
 */
export async function responderConversaMercadoLivre(
  deps: ChatOutboundDeps,
  input: { conversaId: string; texto: string },
): Promise<ChatOutboundResult> {
  const { db, api, conta, nowMs } = deps;
  const texto = input.texto.trim();
  if (texto === '') refuse('ML_TEXTO_VAZIO', 'A mensagem não pode ficar vazia.');

  const snap = await conversaCollection.docRef(db, {}, input.conversaId).get();
  if (!snap.exists) {
    refuse('ML_CONVERSA_NAO_ENCONTRADA', 'Conversa não encontrada.');
  }
  const conversa = snap.data() as Record<string, unknown>;
  const origem = conversa.origem as OrigemConversa;
  if (!ORIGENS_COM_ENVIO.has(origem)) {
    refuse('ML_ORIGEM_SEM_ENVIO', 'Esta conversa não envia mensagens pelo Mercado Livre.');
  }

  if (origem === ORIGEM_CONVERSA.mercadoLivrePerguntas) {
    return responderPergunta({ db, api, nowMs }, input.conversaId, conversa, texto);
  }
  if (origem === ORIGEM_CONVERSA.mercadoLivreReclamacoes) {
    return responderReclamacao({ db, api, nowMs }, input.conversaId, conversa, texto);
  }
  return responderMensagemPedido({ db, api, conta, nowMs }, input.conversaId, conversa, texto);
}

/* ------------------------------- perguntas -------------------------------- */

async function responderPergunta(
  deps: Omit<ChatOutboundDeps, 'conta'>,
  conversaId: string,
  conversa: Record<string, unknown>,
  texto: string,
): Promise<ChatOutboundResult> {
  const { db, api, nowMs } = deps;
  const questionId = Number(conversa.id);
  if (!Number.isSafeInteger(questionId) || questionId <= 0) {
    refuse('ML_DADOS_INSUFICIENTES', 'A conversa não guarda o id da pergunta no Mercado Livre.');
  }
  if (texto.length > LIMITE_RESPOSTA_PERGUNTA) {
    refuse(
      'ML_TEXTO_LONGO',
      `A resposta excede o limite do Mercado Livre (${LIMITE_RESPOSTA_PERGUNTA} caracteres).`,
    );
  }

  // The authority. A question answered on ML's own site five seconds ago still
  // reads as answerable in our stored copy.
  const question = await api.getQuestion(questionId);
  const acao = questionActionability(question);
  if (!acao.podeResponder) {
    refuse('ML_NAO_RESPONDIVEL', acao.motivo ?? 'Pergunta não pode mais ser respondida.');
  }

  await api.answerQuestion(questionId, texto);

  // Only now does the thread learn about it. A question accepts exactly one
  // answer, so the same deterministic id the importer uses keeps a resend from
  // duplicating the bubble.
  const motivo = 'Pergunta já respondida no Mercado Livre';
  await mensagemCollection.set(db, { conversaId }, ANSWER_MENSAGEM_ID, {
    mid: ANSWER_MENSAGEM_ID,
    conteudo: texto,
    tipo: TIPO_MENSAGEM.comum,
    estadoEnvio: ESTADO_ENVIO.enviado,
    canal: 0,
    timestamp: nowMs,
    data_cadastro: nowMs,
  } as DocumentData);

  await conversaCollection.merge(db, {}, conversaId, {
    respostaBloqueada: motivo,
    atendido: true,
    ultima_modificacao: nowMs,
  });

  return { conversaId, mensagemId: ANSWER_MENSAGEM_ID, respostaBloqueada: motivo };
}

/* ---------------------------- mensagens de pedido -------------------------- */

async function responderMensagemPedido(
  deps: ChatOutboundDeps,
  conversaId: string,
  conversa: Record<string, unknown>,
  texto: string,
): Promise<ChatOutboundResult> {
  const { db, api, conta, nowMs } = deps;
  const packId = typeof conversa.id === 'string' ? conversa.id.trim() : '';
  const sellerId = conta.userId;
  if (packId === '' || sellerId == null) {
    refuse('ML_DADOS_INSUFICIENTES', 'A conversa não guarda o pack do Mercado Livre.');
  }

  // The authority, and it also carries the LIVE character cap.
  const pack = await api.getPackMessages(packId, String(sellerId));
  const acao = orderMessageActionability(pack.conversation_status, pack.seller_max_message_length);
  if (!acao.podeResponder) {
    refuse('ML_NAO_RESPONDIVEL', acao.motivo ?? 'Conversa bloqueada no Mercado Livre.');
  }
  const limite = acao.limiteCaracteres ?? LIMITE_MENSAGEM_PEDIDO_PADRAO;
  if (texto.length > limite) {
    refuse('ML_TEXTO_LONGO', `A mensagem excede o limite do Mercado Livre (${limite} caracteres).`);
  }

  // ⚠️ Addressed to the AGENT, never to the buyer (ML, 02/02/2026). The site
  // comes off the thread's own messages; `postSaleAgentUserId` defaults to MLB.
  const siteId = pack.messages.find((m) => m.site_id != null)?.site_id ?? null;
  await api.sendPackMessage(packId, String(sellerId), {
    text: texto,
    toUserId: postSaleAgentUserId(siteId),
  });

  // ML mints the message id and does not return it on the POST, so this bubble
  // is PROVISIONAL: it covers the gap until the next notification brings the
  // real message back at its ML id, and the importer deletes it then. Without
  // that cleanup the reply stayed in the thread twice, forever.
  // See `mensagemProvisoria.ts`.
  const mensagemId = makeMensagemProvisoriaId(nowMs);
  await mensagemCollection.set(db, { conversaId }, mensagemId, {
    mid: null,
    conteudo: texto,
    tipo: TIPO_MENSAGEM.comum,
    estadoEnvio: ESTADO_ENVIO.enviado,
    canal: 0,
    timestamp: nowMs,
    data_cadastro: nowMs,
  } as DocumentData);

  await conversaCollection.merge(db, {}, conversaId, { ultima_modificacao: nowMs });

  return { conversaId, mensagemId, respostaBloqueada: null };
}

/* -------------------------------- reclamações ------------------------------ */

/**
 * Reply on a claim thread.
 *
 * ⚠️ The `receiver_role` is derived from the LIVE available action, never
 * assumed: once a mediation opens ML routes the seller through the mediator and
 * refuses a message aimed at the complainant. `claimActionability` already owns
 * that precedence, so this re-reads the claim and asks it.
 */
async function responderReclamacao(
  deps: Omit<ChatOutboundDeps, 'conta'>,
  conversaId: string,
  conversa: Record<string, unknown>,
  texto: string,
): Promise<ChatOutboundResult> {
  const { db, api, nowMs } = deps;
  const claimId = Number(conversa.id);
  if (!Number.isSafeInteger(claimId) || claimId <= 0) {
    refuse('ML_DADOS_INSUFICIENTES', 'A conversa não guarda o id da reclamação no Mercado Livre.');
  }
  if (texto.length > LIMITE_MENSAGEM_RECLAMACAO) {
    refuse(
      'ML_TEXTO_LONGO',
      `A mensagem excede o limite do Mercado Livre (${LIMITE_MENSAGEM_RECLAMACAO} caracteres).`,
    );
  }

  // The authority. A claim can close, or move into mediation, between the
  // import and the operator pressing send.
  const claim = await api.getClaim(claimId);
  const acao = claimActionability(claim);
  if (!acao.podeResponder || acao.acaoMensagem == null) {
    refuse('ML_NAO_RESPONDIVEL', acao.motivo ?? 'Reclamação não aceita mais mensagens.');
  }

  await api.sendClaimMessage(claimId, {
    receiverRole: receiverRoleDaAcao(acao.acaoMensagem),
    message: texto,
  });

  // ML mints the message id and does not return it on the POST, so this bubble
  // is PROVISIONAL: it covers the gap until the next notification brings the
  // real message back at its ML id, and the importer deletes it then. Without
  // that cleanup the reply stayed in the thread twice, forever.
  // See `mensagemProvisoria.ts`.
  const mensagemId = makeMensagemProvisoriaId(nowMs);
  await mensagemCollection.set(db, { conversaId }, mensagemId, {
    mid: null,
    conteudo: texto,
    tipo: TIPO_MENSAGEM.comum,
    estadoEnvio: ESTADO_ENVIO.enviado,
    canal: 0,
    timestamp: nowMs,
    data_cadastro: nowMs,
  } as DocumentData);

  await conversaCollection.merge(db, {}, conversaId, { ultima_modificacao: nowMs });

  return { conversaId, mensagemId, respostaBloqueada: null };
}

/* ----------------------------- ações da pergunta --------------------------- */

export type AcaoPergunta = 'excluir' | 'bloquear';

/**
 * The two ML question actions from the inbox (#533): delete the question, or
 * block its author from asking again.
 *
 * Neither writes to the thread. Deleting a question is not "our message went
 * away" — ML removes it from the listing, and the next notification reports the
 * new status, which is the importer's job to reflect.
 */
export async function acaoPerguntaMercadoLivre(
  deps: ChatOutboundDeps,
  input: { conversaId: string; acao: AcaoPergunta },
): Promise<{ conversaId: string; acao: AcaoPergunta }> {
  const { db, api, conta } = deps;
  const snap = await conversaCollection.docRef(db, {}, input.conversaId).get();
  if (!snap.exists) refuse('ML_CONVERSA_NAO_ENCONTRADA', 'Conversa não encontrada.');

  const conversa = snap.data() as Record<string, unknown>;
  if (conversa.origem !== ORIGEM_CONVERSA.mercadoLivrePerguntas) {
    refuse('ML_ORIGEM_SEM_ENVIO', 'Ação disponível apenas em perguntas do Mercado Livre.');
  }

  const questionId = Number(conversa.id);
  if (!Number.isSafeInteger(questionId) || questionId <= 0) {
    refuse('ML_DADOS_INSUFICIENTES', 'A conversa não guarda o id da pergunta no Mercado Livre.');
  }

  if (input.acao === 'excluir') {
    await api.deleteQuestion(questionId);
    return { conversaId: input.conversaId, acao: input.acao };
  }

  const buyerId = Number(conversa.sender_id);
  const sellerId = conta.userId;
  if (!Number.isSafeInteger(buyerId) || buyerId <= 0 || sellerId == null) {
    refuse('ML_DADOS_INSUFICIENTES', 'A conversa não guarda o comprador do Mercado Livre.');
  }
  await api.blockUserFromQuestions(sellerId, buyerId);
  return { conversaId: input.conversaId, acao: input.acao };
}
