/**
 * Mercado Livre **questions → chat** import (#532) — the `questions` topic's
 * handler. Structured like `claimImport.ts`: pure digests in `questionIds.ts`,
 * pure builders in `questionMapping.ts`, orchestration here.
 *
 * ── The directive that shapes it ──────────────────────────────────────────────
 * **Import only what we can respond to.** The legacy imported every question in
 * every state, mapping each status onto an `estadoConversa`, so the inbox filled
 * with threads whose composer could never send: `POST /answers` succeeds on
 * `UNANSWERED` alone. Here a non-answerable question NEVER CREATES a conversa —
 * it acks and writes nothing at all.
 *
 * It does still PROCESS a transition on a thread that already exists, and the
 * distinction is load-bearing: the `questions` topic fires when a question is
 * ANSWERED too, and that delivery is the only thing that can close the thread we
 * opened while it was unanswered. Refusing to process it would leave the
 * conversa sitting in Pendentes forever.
 *
 * ── Identity ──────────────────────────────────────────────────────────────────
 * The contact is a **cliente**, resolved by `idMercadoLivre`; no `usuarios` doc
 * is created. A pre-sale asker has no CPF, phone or e-mail, which is exactly why
 * `findOrCreateCliente` gained that match leg — without it every notification
 * blind-created a junk row.
 *
 * ── Closing ───────────────────────────────────────────────────────────────────
 * A finished thread is closed with `respostaBloqueada` + `atendido`, NEVER
 * `estadoConversa`. That field is operator triage state and a webhook writing it
 * clobbers whoever is mid-triage — the same rule `claimImport.ts` follows when it
 * restores `estadoConversa` after every merge.
 *
 * ⚠️ UNITS: everything here is MILLISECONDS (`conversaSchema`/`mensagemSchema`),
 * unlike the incidente/pedido side, which is microseconds.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import {
  conversaCollection,
  mensagemCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import { corToEtiquetaArgb } from '@delfrance/core/cor';
import { findOrCreateCliente } from '@delfrance/data/admin/clientes';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlQuestion,
} from '@delfrance/integrations-mercado-livre';

import { refMatchesIntegracao } from '../core/linkRefs';
import { JANELA_404_TRANSIENTE_MS, ack404EhSeguro } from '../notificacoes/notificacaoFrescor';
import { ANSWER_MENSAGEM_ID, makeConversaIdQuestion, makeQuestionMensagemId } from './questionIds';
import {
  buildAnswerMensagem,
  buildConversaFromQuestion,
  buildQuestionMensagem,
  questionActionability,
  questionBuyerId,
} from './questionMapping';

export interface QuestionImportDeps {
  readonly db: Firestore;
  readonly api: MercadoLivreApi;
  readonly integracaoId: string;
  readonly conta: { userId: number | null; cor: number | null };
  /** ONE clock read for the whole import, MILLISECONDS. */
  readonly nowMs: number;
  /**
   * The notification's own `sent` timestamp (ms), when it carried one — how
   * a 404 is told apart from a race. See {@link JANELA_404_TRANSIENTE_MS}.
   */
  readonly notificacaoEnviadaMs?: number | null;
}

/**
 * Re-exported from {@link notificacaoFrescor}. `messages` needs the identical
 * policy — ML's own reference tells integrators to retry a 404 on the by-id
 * message read — so the window and its reasoning live in ONE place.
 */
export { JANELA_404_TRANSIENTE_MS };

export type QuestionImportSkip =
  | 'question-404'
  | 'outra-conta'
  | 'sem-comprador'
  | 'nao-respondivel';

export interface QuestionImportResult {
  readonly conversaId: string | null;
  readonly clienteId: string | null;
  readonly skipped: QuestionImportSkip | null;
}

function skip(reason: QuestionImportSkip): QuestionImportResult {
  return { conversaId: null, clienteId: null, skipped: reason };
}

/** `documents/<col>/<id>` — the Flutter ODM outer-ref wire format. */
function outerRef(collection: string, id: string): string {
  return `documents/${collection}/${id}`;
}

/**
 * Resolve the linked produto for an ML item id, on THIS account.
 *
 * Best-effort and index-backed: `produtoMercadoLivre` has a collection-group
 * index on `id`, so this is the same shape `itemsStatusSync` already uses. An
 * unlinked item (an anúncio this ERP never published) simply yields null.
 */
async function resolveProdutoOuterRef(
  db: Firestore,
  itemId: string | null,
  integracaoId: string,
): Promise<string | null> {
  if (itemId == null || itemId.trim() === '') return null;
  const snap = await produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('id', '==', itemId)
    .get();
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(data.contaOuterRef, integracaoId)) continue;
    const produtoId = d.ref.parent?.parent?.id;
    if (produtoId) return outerRef('produtos', produtoId);
  }
  return null;
}

/**
 * The anúncio title, for the conversa name — the operator needs to know WHICH
 * product is being asked about.
 *
 * Best-effort: any ML HTTP failure degrades to a null title (the builder then
 * falls back to the item id). A transient network error still THROWS, because
 * that is the queue's job to retry.
 */
async function resolveTituloAnuncio(
  api: MercadoLivreApi,
  itemId: string | null,
): Promise<string | null> {
  if (itemId == null || itemId.trim() === '') return null;
  try {
    const item = await api.getItem(itemId);
    const titulo = item.title;
    return typeof titulo === 'string' && titulo.trim() !== '' ? titulo : null;
  } catch (err) {
    if (err instanceof MercadoLivreHttpError) {
      console.warn('[mercado-livre] título do anúncio indisponível para a pergunta', {
        itemId,
        status: err.status,
      });
      return null;
    }
    throw err;
  }
}

/**
 * Resolve the asker as a cliente, keyed on their ML buyer id.
 *
 * The nickname is the only name a pre-sale asker has; `findOrCreateCliente`
 * will not let a lone word overwrite a fuller stored name, so passing it is safe
 * even when the cliente already exists from an order.
 */
async function resolveClienteDaPergunta(
  db: Firestore,
  question: MlQuestion,
  buyerId: number,
  nowMs: number,
): Promise<string> {
  const res = await findOrCreateCliente(db, {
    fields: {
      tipo: null,
      nome: question.from?.nickname ?? '',
      cpf_cnpj: null,
      idEstrangeiro: null,
      ie: null,
      telefone: null,
      email: null,
      idMercadoLivre: String(buyerId),
    },
    nowMs,
  });
  if (res.rejected.length > 0) {
    console.warn('[mercado-livre] candidatos a cliente rejeitados na pergunta', {
      questionId: question.id,
      rejected: res.rejected,
    });
  }
  if (res.idMercadoLivreConflito != null) {
    // ⚠️ On THIS path the refusal half is unreachable, and an earlier version of
    // this comment claimed the opposite — the mistake this repo keeps making, so
    // it is worth stating why rather than deleting the block. The fields above
    // are all null except the ML id, so `isSameCliente` has no strong key to
    // contradict on (`idCompatible` reads a null incoming side as no evidence)
    // and the leg's own `==` query guarantees the third. Every ML-leg candidate
    // is therefore ACCEPTED: the cascade never falls through, so nothing is ever
    // stamped and nothing is ever refused.
    //
    // What DOES reach here is the other half — the id already carried by two
    // clientes. The cascade silently takes the first and the second is
    // mentioned nowhere, which is precisely how that ambiguity survives every
    // later delivery. This is the only surface that reports it on the question
    // path.
    console.warn(
      res.idMercadoLivreConflito.carimboRecusado
        ? '[mercado-livre] pergunta: idMercadoLivre já pertence a outro cliente'
        : '[mercado-livre] pergunta: idMercadoLivre duplicado entre dois clientes',
      {
        questionId: question.id,
        clienteDaPergunta: res.clienteId,
        clienteExistente: res.idMercadoLivreConflito.outroCliente,
        idMercadoLivre: String(buyerId),
      },
    );
  }
  return res.clienteId;
}

/** Whether a 404 on this delivery can be trusted to mean "deleted". */
function notificacao404EhDefinitivo(deps: QuestionImportDeps): boolean {
  return ack404EhSeguro({ enviadaMs: deps.notificacaoEnviadaMs, nowMs: deps.nowMs });
}

/**
 * Import one Mercado Livre question into the chat inbox.
 *
 * THROWS on a transient failure (Firestore / ML network) so the queue and the
 * sweep retry; deterministic outcomes RETURN a skip reason. Idempotent, keyed by
 * the ML question id through `questionIds.ts`.
 */
export async function importQuestionMercadoLivre(
  deps: QuestionImportDeps,
  questionId: number,
): Promise<QuestionImportResult> {
  const { db, api, integracaoId, conta, nowMs } = deps;

  let question: MlQuestion;
  try {
    question = await api.getQuestion(questionId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      // ⚠️ NOT unconditionally deterministic. A question deleted long ago 404s
      // forever, but so does one asked seconds ago that ML has not propagated
      // yet — and acking THAT loses a real customer question with no record
      // anywhere. Only a 404 on a notification old enough to rule the race out
      // is acked; a fresh one throws so the queue and sweep retry it.
      if (!notificacao404EhDefinitivo(deps)) {
        throw err;
      }
      return skip('question-404');
    }
    throw err;
  }

  // Legacy guard (`tasks.dart:1414`): ML delivers to the application, not to one
  // seller, so a question on ANOTHER account's listing can reach this handler.
  if (
    conta.userId != null &&
    question.seller_id != null &&
    String(question.seller_id) !== String(conta.userId)
  ) {
    return skip('outra-conta');
  }

  const acao = questionActionability(question);
  const conversaId = makeConversaIdQuestion(integracaoId, question.id);
  const conversaRef = conversaCollection.docRef(db, {}, conversaId);
  const existente = await conversaRef.get();

  // The directive: a question we cannot answer never OPENS a thread. Note the
  // asymmetry — an existing thread is still updated below, because the delivery
  // that reports `ANSWERED` is the only thing that can close the one we opened.
  if (!acao.podeResponder && !existente.exists) return skip('nao-respondivel');

  const buyerId = questionBuyerId(question);
  if (buyerId == null && !existente.exists) return skip('sem-comprador');

  // Enrichment first: both are best-effort and neither should be able to leave a
  // half-written conversa behind.
  const [produtoOuterRef, tituloAnuncio] = await Promise.all([
    resolveProdutoOuterRef(db, question.item_id, integracaoId),
    resolveTituloAnuncio(api, question.item_id),
  ]);

  const clienteId =
    buyerId == null ? null : await resolveClienteDaPergunta(db, question, buyerId, nowMs);
  const clienteOuterRef = clienteId == null ? null : outerRef('clientes', clienteId);

  const fields = buildConversaFromQuestion(question, {
    clienteOuterRef,
    integracaoOuterRef: outerRef('integracao', integracaoId),
    produtoOuterRef,
    tituloAnuncio,
    // ⚠️ CONVERTED, not copied. `integracao.cor` is a 24-bit RGB int; `cor_etiqueta`
    // is a 32-bit ARGB `Color.value`, and the chat etiqueta filter matches its
    // palette with an exact `==`. A raw copy paints the right colour but is
    // selectable by no etiqueta at all. See `corToEtiquetaArgb`.
    corEtiqueta: corToEtiquetaArgb(conta.cor),
    nowMs,
    acao,
  });

  if (existente.exists) {
    // UPDATE — `data_cadastro` is create-only, and `estadoConversa` is never in
    // `fields` at all (see `buildConversaFromQuestion`).
    const { data_cadastro: _ignored, ...patch } = fields;
    await conversaCollection.merge(db, {}, conversaId, patch as DocumentData);
  } else {
    await conversaCollection.set(db, {}, conversaId, fields as DocumentData);
  }

  // The question itself, at its legacy-exact id — an overwrite-set, so a
  // redelivery updates in place instead of duplicating the bubble.
  await mensagemCollection.set(
    db,
    { conversaId },
    makeQuestionMensagemId(question.id),
    buildQuestionMensagem(question, { clienteOuterRef, nowMs }) as DocumentData,
  );

  // The answer, when ML reports one. ⚠️ Skip an EMPTY body: a BANNED answer
  // arrives with its text stripped, and writing it would blank a reply the
  // operator can still read on ML.
  const answerText = question.answer?.text ?? '';
  if (question.answer != null && answerText.trim() !== '') {
    await mensagemCollection.set(
      db,
      { conversaId },
      ANSWER_MENSAGEM_ID,
      buildAnswerMensagem(question, { nowMs }) as DocumentData,
    );
  }

  return { conversaId, clienteId, skipped: null };
}
