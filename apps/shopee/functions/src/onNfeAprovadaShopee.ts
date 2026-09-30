import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

import { pedidoCollection } from '@delfrance/data/admin/collections';
import { decideNfeUploadTransition, nfeMeta } from '@delfrance/schemas';

import type { AvisoDeps } from '../../lib/shopee/avisos/autorizacao';
import { avisarNfeShopee } from '../../lib/shopee/nfe/avisoNfe';
import { ATRASO_SERPRO_S, SHOPEE_NFE_UPLOAD_QUEUE } from '../../lib/shopee/nfe/constantesNfe';
import {
  MOTIVO_NFE_SHOPEE,
  ShopeeNfeUploadTasksDisabledError,
  type MotivoNfeShopee,
} from '../../lib/shopee/nfe/errosNfe';
import { finalidadeDoProc } from '../../lib/shopee/nfe/notaNaShopee';
import { avaliarPedidoParaNfeShopee } from '../../lib/shopee/nfe/pedidoNfe';
import { MOTIVOS_DE_ALERTA } from '../../lib/shopee/nfe/processarNfe';
import { createShopeeNfeUploadScheduler } from '../../lib/shopee/nfe/shopeeNfeUploadTasks';
import {
  FASE_NFE_SHOPEE,
  type AgendadorNfeShopee,
  type TarefaNfeShopee,
} from '../../lib/shopee/nfe/tarefaNfe';
import { getDb } from './lib/admin';

/** Everything one fire needs — injected so the test drives the ladder with doubles. */
export interface DepsGatilhoNfeShopee {
  /** Resolved LAZILY: a write that stops at T1 or T1b never even builds the handle. */
  readonly db: () => Firestore;
  /** Built only once T3 said "enqueue" — the valve is decided at construction. */
  readonly agendador: () => AgendadorNfeShopee;
  /** Read ONLY on the valve arm, for the aviso's stamps; the enqueue path holds no clock. */
  readonly agoraMs: () => number;
  /** `(by) => FieldValue.increment(by)` — the aviso counter, tier 0. */
  readonly increment: AvisoDeps['increment'];
}

/** One `nfev4` write, as the trigger received it — the RAW snapshot bodies. */
export interface EscritaNfev4Shopee {
  readonly pedidoId: string;
  readonly nfeId: string;
  /** `undefined` on a create. */
  readonly before: Record<string, unknown> | undefined;
  /** `undefined` on a delete. */
  readonly after: Record<string, unknown> | undefined;
}

const TAG = '[shopee] onNfeAprovadaShopee';

/**
 * The ONE discard line of T1b and T3. Its LEVEL is the handler's own
 * `MOTIVOS_DE_ALERTA` — never decided here: `emissao-bloqueada` (someone set
 * the flag after emission, and this trigger is the only place the cloud path
 * meets that pedido) is a `warn`, every other discard an `info` (reconcile R-o).
 */
function registrarDescarte(pedidoId: string, nfeId: string, motivo: MotivoNfeShopee): void {
  const linha = { pedidoId, nfeId, motivo };
  if (MOTIVOS_DE_ALERTA.has(motivo)) logger.warn(`${TAG} descartado`, linha);
  else logger.info(`${TAG} descartado`, linha);
}

/**
 * T1–T5 for ONE `nfev4` write — see the module docblock. Never throws for a
 * write that is not ours; rethrows what Eventarc must retry.
 */
export async function tratarEscritaNfeShopee(
  deps: DepsGatilhoNfeShopee,
  escrita: EscritaNfev4Shopee,
): Promise<void> {
  const { pedidoId, nfeId, before, after } = escrita;

  // ---- T1: the EDGE into "ready". 0 reads, and NO log line on a skip. ----
  const transicao = decideNfeUploadTransition(before, after);
  if (transicao.action !== 'enqueue') return;

  // ---- T1b: the sale-only gate on the proc T1 just proved present. 0 reads. ----
  // T1's `enqueue` implies `after.xml_nfe_proc` is a string; the fallback keeps
  // the gate total without trusting that across a refactor of the predicate.
  const xml = typeof after?.xml_nfe_proc === 'string' ? after.xml_nfe_proc : '';
  if (finalidadeDoProc(xml) === 'outra') {
    registrarDescarte(pedidoId, nfeId, MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda);
    return;
  }

  // ---- T2: ONE raw pedido read. ----
  const db = deps.db();
  const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const pedido = pedidoSnap.exists ? ((pedidoSnap.data() ?? {}) as Record<string, unknown>) : null;

  // ---- T3: the ownership proof. ----
  const dono = avaliarPedidoParaNfeShopee(pedidoId, pedido);
  if (dono.acao === 'ignorar') {
    registrarDescarte(pedidoId, nfeId, dono.motivo);
    return;
  }

  // ---- T4: the first enqueue, held for the SERPRO window. ----
  // The payload is built BY NAME: no conta, no order number, no key (tarefaNfe.ts).
  const tarefa: TarefaNfeShopee = {
    pedidoId,
    nfeId,
    fase: FASE_NFE_SHOPEE.envio,
    adiamentosSerpro: 0,
    pausas: 0,
    reverificacoes: 0,
  };
  try {
    await deps.agendador().enqueue(tarefa, { scheduleDelaySeconds: ATRASO_SERPRO_S });
  } catch (err) {
    // ---- T5: the valve — the NF-e queue's OWN class, and nothing else. ----
    if (err instanceof ShopeeNfeUploadTasksDisabledError) {
      const aviso = await avisarNfeShopee(
        db,
        {
          integracaoId: dono.contaId,
          pedidoId,
          numero: dono.orderSn,
          motivo: MOTIVO_NFE_SHOPEE.tasksDesabilitadas,
          excerto: null,
        },
        { nowMs: deps.agoraMs(), increment: deps.increment },
      );
      logger.warn(
        `${TAG} não enfileirado — SHOPEE_TASKS_DISABLED=1; sem varredura de NF-e, o aviso é a lista de reenvio`,
        {
          pedidoId,
          nfeId,
          integracaoId: dono.contaId,
          motivo: MOTIVO_NFE_SHOPEE.tasksDesabilitadas,
          aviso,
        },
      );
      return;
    }
    throw err;
  }

  logger.info(`${TAG} enfileirado`, {
    queue: SHOPEE_NFE_UPLOAD_QUEUE,
    pedidoId,
    nfeId,
    integracaoId: dono.contaId,
    atrasoSegundos: ATRASO_SERPRO_S,
  });
}

/**
 * The NF-e approval trigger of the Shopee channel (master plan step 14, #1522)
 * — the SECOND Firestore trigger of this codebase, and the first producer of
 * the fifth queue (`processShopeeNfeUpload`, ./processNfeUpload). The design
 * is `lib/shopee/nfe/README.md` §2–§4; this file is the T1–T5 ladder of that
 * flow and nothing else.
 *
 * ⚠️ **The export is `onNfeAprovadaShopee`, never `onNfeAprovada`.** Mercado
 * Livre's codebase already deploys a function of that name into the same
 * project, and nothing in the repo stops two codebases from exporting the same
 * name (register row 201, #1707) — the collision would surface at deploy time,
 * as one codebase's function silently replacing the other's.
 *
 * ⚠️ **A THIRD function on `pedidos/{pedidoId}/nfev4/{nfeId}`** (Mercado
 * Livre's `onNfeAprovada` and `apps/functions`' `onNfeDeleted` are the other
 * two), so EVERY nfev4 write in the project fires it: the placeholder, the
 * `enviando` anchor, each SOAP retry, a cancellation, and the window's
 * `2026-09-nfe-totais` migration, which rewrites every approved document. That
 * is why the first two rungs cost ZERO reads and the first one logs NOTHING —
 * one line per fire would triple the channel's log volume for writes that were
 * never ours.
 *
 * The ladder (reconcile §2.9):
 *
 *  - **T1** `decideNfeUploadTransition(before, after)` — TRANSITION, never
 *    level: only the edge into "ready" (aprovada, a proc, tpAmb 1) enqueues, so
 *    a later write to an already-approved document (`ja-pronta`) is silent. The
 *    late-proc repair (aprovada without a proc, then with one) is still an edge.
 *  - **T1b** `finalidadeDoProc(after.xml_nfe_proc)` — a legible NON-SALE note
 *    (a devolução, an entrada, a complementar) is discarded with ONE `info`
 *    line (`nfe-nao-e-de-venda`). A proc ILLEGIBLE to the sale gate is NOT
 *    discarded here: the handler judges it `xml-invalido` with an aviso and a
 *    frete stamp, and a drop at this rung would turn that loud refusal into
 *    silence. (An unreadable `<tpAmb>` never reaches this rung: T1's predicate
 *    already skipped it.)
 *  - **T2** ONE raw pedido read, through the handle.
 *  - **T3** `avaliarPedidoParaNfeShopee` — the ownership PROOF (the pedido id
 *    recomputes from `(conta, order_sn)`); anything else is ONE line, at the
 *    level the handler's `MOTIVOS_DE_ALERTA` gives it: `emissao-bloqueada` is a
 *    `warn` (reconcile R-o — nothing else will ever say so, since this pedido is
 *    never enqueued), `pedido-nao-encontrado` and `nao-shopee` are `info`.
 *    The frete decides nothing here: Shopee attaches the note to the ORDER.
 *  - **T4** enqueue `{ pedidoId, nfeId, fase: envio }` with
 *    `scheduleDelaySeconds: ATRASO_SERPRO_S` — the CONSTANT, not
 *    `atrasoSerproS(...)`: this trigger runs AT the approval, so the whole
 *    SERPRO window is still ahead, and the enqueue path holds no clock at all
 *    (the route and the CLI, which re-drive old notes, compute the remainder).
 *    ⚠️ The emulator ignores the delay (firebase-tools#8254).
 *  - **T5** the valve (`SHOPEE_TASKS_DISABLED=1`) — ONLY the NF-e queue's own
 *    {@link ShopeeNfeUploadTasksDisabledError} is caught: a `warn` line plus the
 *    aviso `tasks-desabilitadas` on the pedido, because there is NO NF-e sweep
 *    behind this path and the aviso list IS the re-drive worklist (`/enviar-nfe`
 *    or `enviar:nfe`). Everything else — a `ZodError`, a missing region, a
 *    Firestore failure — propagates to the Eventarc retry.
 *
 * ⚠️ Targets the NAMED `default` database, inlined at build time by `build.mjs`
 * (the step-11 trigger's docblock says why a runtime read cannot cover it): an
 * `onDocument*` bound to `(default)` deploys fine and NEVER fires.
 *
 * `retry: true` → Eventarc at-least-once for the TRANSIENT failures above. A
 * redelivery replays the ORIGINAL CloudEvent — the same stale snapshots — so it
 * can enqueue a second task for an NF-e whose first one already ran. That
 * duplicate converges in the handler, never here: the queue's `{1, 1}` rate
 * limit runs the two one after the other, and when Shopee's read already shows
 * OUR key the second pre-read answers `ja-enviado`. ⚠️ A pre-read that still
 * LAGS answers "no note" and UPLOADS again; convergence then rests on how
 * Shopee answers a resend of the key it holds (the "already attached" rows N1/N2
 * of `nfe/classificarNfe.ts`, register 188) plus the read-back — and a text no
 * row matches would end as `recusa-desconhecida`, aviso and stamp. That answer
 * is OPEN until the probe (`nfe/README.md` §16).
 *
 * NO `secrets:` binding — this trigger never calls Shopee (the queue handler
 * does), and a needless binding is one more Secret Manager grant that can 403
 * the function at startup. `index.test.ts` asserts the empty set.
 *
 * ## Rule 7, write by write
 *
 * The happy path writes NO document: the enqueue is a Cloud Tasks call. The one
 * write is the valve's aviso — tier 0 (a deterministic id per `(tipo, conta,
 * pedido)`) plus tier 1 inside `escreverAviso`, with `ocorrencias` a
 * `FieldValue.increment` — so a redelivery that meets the valve again bumps the
 * same row instead of racing to create a second.
 *
 * ⚠️ PII: no log line here names the order number, the access key or the XML —
 * only the two document ids, the conta id and the motivo. The aviso carries the
 * order number as its display `params.pedido`, which is what the inbox renders.
 */
export const onNfeAprovadaShopee = onDocumentWritten(
  {
    // The meta, never a literal: `pedidos/{pedidoId}/nfev4`.
    document: `${nfeMeta.collectionPath}/{nfeId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts sets it globally) and no `secrets:` — see the
    // module docblock.
  },
  async (event) => {
    // The middle `{pedidoId}` wildcard sits inside the meta-derived prefix, so
    // its type is not inferred into `event.params` — both are present at runtime.
    const { pedidoId, nfeId } = event.params as { pedidoId: string; nfeId: string };
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : undefined;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : undefined;

    await tratarEscritaNfeShopee(
      {
        db: getDb,
        agendador: createShopeeNfeUploadScheduler,
        // The valve arm's ONE clock read — nothing else in this trigger reads one.
        agoraMs: () => Date.now(),
        increment: (by: number) => FieldValue.increment(by),
      },
      { pedidoId, nfeId, before, after },
    );
  },
);
