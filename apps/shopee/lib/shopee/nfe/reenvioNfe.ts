/**
 * The NF-e re-drive of ONE Shopee pedido (#1522, step 14): re-run the upload's
 * pre-network gates and ENQUEUE one task on the NF-e queue.
 *
 * It was the body of `POST /api/marketplace/shopee/enviar-nfe` after the route's
 * clock read, until step 15 (#1523) needed the SAME re-drive from the label
 * route when Shopee answers "the package is waiting for its invoice". Moved
 * verbatim, and answering a union instead of an HTTP response: each caller maps
 * it to its own answer, and there is ONE ladder behind both (root `CLAUDE.md`,
 * "extract it"). The route's unedited `route.test.ts` is the proof the move
 * changed nothing.
 *
 * ## ⚠️ Enqueue-only: zero writes, zero Shopee calls, no client, no token
 *
 * Every Shopee decision — what the order already holds, the upload, the
 * read-back, the recheck — is the TASK's (`processarNfe.ts`). This reads three
 * things (the pedido, the conta through the cached reader, the NF-e slot) and
 * never `loadShopeeContext`: that reads the partner configuration, and a later
 * refactor would build a client from it. An eligible document ALWAYS answers
 * `enfileirado`, even when Shopee already holds our key — the task's pre-read
 * answers `ja-enviado` and closes any open aviso, the clean no-op a repeated
 * re-drive needs.
 *
 * ## The gates, in the handler's own order (ownership BEFORE the NF-e)
 *
 * Each runs the SAME pure predicate the trigger and the handler run, and a
 * refusal is `nao-elegivel` with the motivo:
 *
 * 1. the pedido, raw, and `avaliarPedidoParaNfeShopee` — the id must recompute
 *    from `(conta, order_sn)`; `emissao-bloqueada` refuses too;
 * 2. the conta through `readConta` + `avaliarContaParaNfeShopee` (missing or of
 *    another tipo, or `ativo !== true`);
 * 3. the slot. An explicit `nfeId` is read (absent ⇒ `nfe-nao-encontrada`: the
 *    caller words it, because nothing was scheduled and the handler's P1 phrase
 *    would mislead) and judged by the shared LEVEL predicate — never the
 *    transition one: a re-drive is for a document that is ALREADY ready, exactly
 *    the population a transition gate would refuse — and then by the sale gate.
 *    Without one, the pedido's NF-e documents are LISTED and
 *    `escolherNfeParaEnvioShopee` picks the slot (the same rule the CLI runs). A
 *    proc ILLEGIBLE TO THE SALE GATE passes on purpose: the handler answers it
 *    with an aviso and the frete stamp the operator sees, and a refusal here
 *    would hide both. That is the sale gate only: an unreadable `<tpAmb>` is
 *    refused one rung earlier by the shared level predicate, as
 *    `tpamb-homologacao`.
 *
 * ## The SERPRO wait — only when the authorization instant is KNOWN
 *
 * Shopee checks the note against the federal record, which lags SEFAZ by
 * minutes. A re-drive of a note whose authorization instant is RECORDED and
 * seconds old is held for what is left of the window (`atrasoSerproS`); an
 * older one is dispatched now. The migrated corpus records it (the legacy app
 * wrote `data_autorizacao`), and since #1743 so does every note this ERP's
 * NF-e app authorizes: the approval write stamps the protocol's `dhRecbto`
 * with the proc. A note without one — approved before that deploy, or with no
 * readable `dhRecbto` — is an UNKNOWN instant. An
 * unknown instant (null, absent or unreadable) is dispatched now, and never
 * refused: the helper would read it as "just authorized" and hold every re-drive
 * of it six minutes. A zero wait OMITS the option.
 *
 * ⚠️ `nowMs` is the CALLER's one clock read — this folder reads no clock.
 *
 * ## Errors
 *
 * `ShopeeNfeUploadTasksDisabledError` (the NF-e queue's OWN valve class) ⇒
 * `desligado` — there is no sweep behind the queue, so the caller must surface
 * the outage. Anything else rethrows (rule 6): a Firestore failure on a read, a
 * missing region, a payload the schema refuses — and the channel's SHARED valve
 * class, which a per-conta containment would swallow.
 *
 * ⚠️ PII: the union carries a document id, a motivo and a delay — never the
 * access key, the XML or the order number. This never reads the key.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { coerceToMillis } from '@delfrance/core/datetime';
import { nfev4Collection, pedidoCollection } from '@delfrance/data/admin/collections';
import { decideNfeUploadDispatch } from '@delfrance/schemas';

import { readConta } from '../core/contaCache';
import { atrasoSerproS } from './constantesNfe';
import {
  MOTIVO_NFE_SHOPEE,
  ShopeeNfeUploadTasksDisabledError,
  type MotivoNfeShopee,
} from './errosNfe';
import { finalidadeDoProc } from './notaNaShopee';
import {
  avaliarContaParaNfeShopee,
  avaliarPedidoParaNfeShopee,
  escolherNfeParaEnvioShopee,
} from './pedidoNfe';
import { createShopeeNfeUploadScheduler } from './shopeeNfeUploadTasks';
import { FASE_NFE_SHOPEE, type OpcoesDeEnfileiramentoNfe, type TarefaNfeShopee } from './tarefaNfe';

/** What one re-drive came to; each caller maps it to its own answer. */
export type ResultadoReenvioNfe =
  | { tipo: 'enfileirado'; nfeId: string; atrasoSegundos: number }
  | { tipo: 'nao-elegivel'; motivo: MotivoNfeShopee }
  | { tipo: 'nfe-nao-encontrada' }
  | { tipo: 'desligado' };

/** The slot the re-drive enqueues: the document id and its raw data. */
interface SlotNfe {
  readonly nfeId: string;
  readonly raw: Record<string, unknown>;
}

/**
 * Re-drive the NF-e upload of one pedido (see the module docblock).
 *
 * @param p `pedidoId` and `nfeId` already validated as document ids by the
 *   caller (`nfeId: null` ⇒ the slot rule picks); `nowMs` is the caller's one
 *   clock read, the SERPRO wait's "now".
 */
export async function reenviarNfeDoPedidoShopee(
  db: Firestore,
  p: { pedidoId: string; nfeId: string | null; nowMs: number },
): Promise<ResultadoReenvioNfe> {
  const { pedidoId, nowMs } = p;

  // ---- the pedido, raw, and the ownership proof (before any NF-e read). ----
  const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const pedido = pedidoSnap.exists ? ((pedidoSnap.data() ?? {}) as Record<string, unknown>) : null;
  const dono = avaliarPedidoParaNfeShopee(pedidoId, pedido);
  if (dono.acao === 'ignorar') return { tipo: 'nao-elegivel', motivo: dono.motivo };

  // ---- the conta — the cached reader, never the context loader. ----
  const conta = avaliarContaParaNfeShopee(await readConta(db, dono.contaId));
  if (!conta.ok) return { tipo: 'nao-elegivel', motivo: conta.motivo };

  // ---- the slot. ----
  let slot: SlotNfe;
  if (p.nfeId !== null) {
    const nfeSnap = await nfev4Collection.docRef(db, { pedidoId }, p.nfeId).get();
    if (!nfeSnap.exists) return { tipo: 'nfe-nao-encontrada' };
    const raw = (nfeSnap.data() ?? {}) as Record<string, unknown>;
    // The LEVEL predicate, its reason verbatim — never the transition helper.
    const pronta = decideNfeUploadDispatch(undefined, raw);
    if (pronta.action === 'skip') return { tipo: 'nao-elegivel', motivo: pronta.reason };
    // The sale gate. A proc the predicate calls ready is a string; an
    // ILLEGIBLE one goes on, for the handler's aviso.
    const xml = typeof raw.xml_nfe_proc === 'string' ? raw.xml_nfe_proc : '';
    if (finalidadeDoProc(xml) === 'outra') {
      return { tipo: 'nao-elegivel', motivo: MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda };
    }
    slot = { nfeId: p.nfeId, raw };
  } else {
    const lista = await nfev4Collection.ref(db, { pedidoId }).get();
    const docs = lista.docs.map((doc) => ({
      id: doc.id,
      raw: (doc.data() ?? {}) as Record<string, unknown>,
    }));
    const escolha = escolherNfeParaEnvioShopee(docs);
    if (!('nfeId' in escolha)) return { tipo: 'nao-elegivel', motivo: escolha.motivo };
    const escolhido = docs.find((d) => d.id === escolha.nfeId);
    // Unreachable: the rule only answers ids it was handed. A refusal here would
    // dress a defect up as an eligibility answer, so it throws (a 500).
    if (escolhido === undefined) {
      throw new Error('invariante: a regra de escolha devolveu uma NF-e fora da listagem.');
    }
    slot = { nfeId: escolhido.id, raw: escolhido.raw };
  }

  // ---- the SERPRO wait: a KNOWN instant only; zero ⇒ no option at all. ----
  const autorizadaMs = coerceToMillis(slot.raw.data_autorizacao);
  const atrasoSegundos = autorizadaMs === null ? 0 : atrasoSerproS(autorizadaMs, nowMs);
  const opcoes: OpcoesDeEnfileiramentoNfe | undefined =
    atrasoSegundos > 0 ? { scheduleDelaySeconds: atrasoSegundos } : undefined;

  // BUILT BY NAME: the upload phase, every ledger at zero.
  const tarefa: TarefaNfeShopee = {
    pedidoId,
    nfeId: slot.nfeId,
    fase: FASE_NFE_SHOPEE.envio,
    adiamentosSerpro: 0,
    pausas: 0,
    reverificacoes: 0,
  };

  try {
    const agendador = createShopeeNfeUploadScheduler();
    await (opcoes === undefined ? agendador.enqueue(tarefa) : agendador.enqueue(tarefa, opcoes));
  } catch (err) {
    // The NF-e queue's OWN valve class — never the channel's shared one, which
    // a per-conta containment would swallow. No sweep stands behind this queue.
    if (err instanceof ShopeeNfeUploadTasksDisabledError) return { tipo: 'desligado' };
    throw err;
  }

  return { tipo: 'enfileirado', nfeId: slot.nfeId, atrasoSegundos };
}
