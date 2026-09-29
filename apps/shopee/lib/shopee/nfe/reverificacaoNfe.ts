/**
 * The NF-e RECHECK (#1522, step 14): the read-only second look at what Shopee
 * holds for the order, ~15 minutes after an accepted upload (and once more ~30
 * minutes later while the note reads pending without a reason).
 *
 * ## ⚠️ It never uploads, and it makes no Shopee call of its own
 *
 * The common prefix of both phases (the handler module) already did the ONE
 * `get_order_detail` of this execution and hands its row in as `linha`; this
 * module only JUDGES that row against our key. It never names the client's
 * methods, never enqueues the upload phase — every re-enqueue it makes is
 * pinned to {@link FASE_NFE_SHOPEE.reverificacao} — and it never imports the
 * handler module, so the two cannot form a cycle. The only thing it may do
 * besides reading the row is the aviso, the frete stamp, the aviso's resolve
 * and one delayed self re-enqueue.
 *
 * ## The verdict table (reconcile §2.8 "Recheck", R-c, R-g, R-k)
 *
 * | Shopee holds…                       | outcome · motivo                             | effect            |
 * |-------------------------------------|----------------------------------------------|-------------------|
 * | our key, `valid`                    | `validada` · `nfe-validada`                  | resolve the aviso |
 * | our key, `pending` + a reason       | `recusado` · `sefaz-pendente`                | the sets          |
 * | our key, `pending`, no reason       | `reverificacao-agendada` / `descartado` · `validacao-pendente` | one more look, then log |
 * | our key, no status / an unknown one | `descartado` · `status-desconhecido`         | log — NEVER resolve |
 * | no key, status `valid`              | `descartado` · `nota-dispensada`             | log               |
 * | no key, any other status            | `recusado` · `nao-anexada`                   | the sets          |
 * | another legible key                 | `recusado` · `outra-nfe-anexada`             | the sets          |
 * | a value that is not a key           | `recusado` · `chave-ilegivel`                | the sets          |
 * | a foreign order                     | `descartado` · `pedido-nao-br`               | log               |
 *
 * - **Resolve only on an OBSERVATION of validity.** An absent or unknown status
 *   is not one: an unknown token may be a rejection spelled in a way we do not
 *   know, and closing the operator's row on it would hide exactly the note that
 *   needs them.
 * - **"No key" never stamps** (R-g): it is the absence of evidence, not a
 *   refusal, and a stamp is not revocable by this step. The aviso is enough —
 *   and it is the re-drive worklist.
 * - **Pending without a reason** is ambiguous (still validating, or simply not
 *   shipment-ready — Shopee documents the field as possibly empty), so it earns
 *   ONE more look and then a log line, never an aviso: nothing would ever
 *   resolve it. Step 15's shipment call is the backstop. A blank reason is no
 *   reason — the reader has already folded it to `null`.
 *
 * ## Effects come from the sets, and only from them
 *
 * Whether an outcome raises the aviso is {@link MOTIVOS_QUE_AVISAM}; whether it
 * also stamps the frete is {@link MOTIVOS_QUE_CARIMBAM}; whether the aviso
 * carries Shopee's sanitized text is {@link MOTIVOS_COM_EXCERTO}. This module
 * never compares a motivo to decide an effect — each set is consulted in
 * exactly one place ({@link aplicarEfeitos}). Write order: the aviso FIRST,
 * then the stamp; a stamp failure PROPAGATES (the aviso already stands, and the
 * queue's retry meets the stamp's own zero-write replay).
 *
 * ## Rule 7, write by write
 *
 * - aviso raise / resolve — tier 0 (deterministic id) + tier 1 inside the shared
 *   writer (`escreverAviso` / `resolverAviso`);
 * - frete stamp — class C, every guard re-derived from the transaction's own
 *   read (`carimboFreteNfe.ts`);
 * - the self re-enqueue — no document at all; a duplicate recheck is one more
 *   read-only look and converges on the same verdict.
 *
 * ## Units
 *
 * "Now" arrives as MILLISECONDS (`deps.nowMs`, the dispatcher's one clock read)
 * and crosses into microseconds ONCE, through the aviso module's seam
 * ({@link agoraUsDe}); the same instant stamps the frete and the aviso. This
 * module reads no clock.
 *
 * ⚠️ PII: the context holds the order number and our key; neither reaches a log
 * line, a payload or a returned field. The one line this module writes itself
 * (the closed valve) names the pedido and NF-e document ids only.
 */
import type { ShopeeClient, ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';
import type { Firestore } from 'firebase-admin/firestore';

import { type AvisoDeps, agoraUsDe } from '../avisos/autorizacao';
import { RESOLUCAO_AVISO_NFE_SHOPEE, avisarNfeShopee, resolverAvisoNfeShopee } from './avisoNfe';
import { carimbarFreteNfeShopee, type MotivoCarimbo } from './carimboFreteNfe';
import { ATRASOS_REVERIFICACAO_S, SHOPEE_NFE_UPLOAD_QUEUE } from './constantesNfe';
import {
  DESFECHO_NFE_SHOPEE,
  MOTIVO_NFE_SHOPEE,
  MOTIVOS_COM_EXCERTO,
  MOTIVOS_QUE_AVISAM,
  MOTIVOS_QUE_CARIMBAM,
  ShopeeNfeUploadTasksDisabledError,
  type DesfechoNfeShopee,
  type MotivoNfeShopee,
} from './errosNfe';
import { lerNotaNaShopee } from './notaNaShopee';
import {
  FASE_NFE_SHOPEE,
  type AgendadorNfeShopee,
  type ContextoNfeShopee,
  type FaseNfeShopee,
  type TarefaNfeShopee,
} from './tarefaNfe';

/* -------------------------------------------------------------------------- */
/*                         the seam (structural, W3-1)                          */
/* -------------------------------------------------------------------------- */

/**
 * The handler's dependencies, STRUCTURALLY — exactly the fields the handler's
 * own deps type declares (orchestrator amendment W3-1), restated here rather
 * than imported so this module never imports the handler module. The recheck
 * uses `db`, `scheduler`, `nowMs` and `increment`; the rest is listed so the
 * two types stay one shape.
 */
interface DepsDaReverificacao {
  readonly db: Firestore;
  readonly scheduler: AgendadorNfeShopee;
  /** The dispatcher's ONE clock read, in MILLISECONDS. */
  readonly nowMs: number;
  /** `(by) => FieldValue.increment(by)` — the aviso writer needs the sentinel. */
  readonly increment: AvisoDeps['increment'];
  jitterSec(maxS: number): number;
  readonly resolveClient?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
}

/**
 * What one recheck ended in — structurally the handler's result type (reconcile
 * §2.8). `substituicao` is always `false` here: a substitution is an UPLOAD
 * decision, and this phase never uploads.
 */
interface ResultadoDaReverificacao {
  readonly desfecho: DesfechoNfeShopee;
  readonly motivo: MotivoNfeShopee | null;
  readonly fase: FaseNfeShopee;
  readonly substituicao: boolean;
  readonly carimbo: MotivoCarimbo | null;
  readonly avisado: boolean;
  readonly resolvido: boolean;
}

/** The two fields of the order row the verdict reads. */
type LinhaDoPedido = Pick<ShopeeOrderDetailRow, 'region' | 'invoice_data'>;

const TAG_LOG = '[shopee/nfe] reverificação';

/* -------------------------------------------------------------------------- */
/*                                  the recheck                                */
/* -------------------------------------------------------------------------- */

/**
 * Judge ONE recheck: `linha` is the row the common prefix already read (with
 * `SHOPEE_NFE_DETALHE_CAMPOS`), `ctx.nossaChave` the key inside our own XML.
 * See the module docblock for the table.
 *
 * @throws whatever the aviso writer, the stamp transaction or the scheduler
 * throws — EXCEPT the NF-e queue's own closed-valve error, which ends the
 * recheck as `descartado tasks-desabilitadas`. Everything else is the queue's
 * to retry (rule 6: nothing is swallowed by class `Error`).
 */
export async function reverificarNfeShopee(
  ctx: ContextoNfeShopee,
  deps: DepsDaReverificacao,
  payload: TarefaNfeShopee,
  linha: LinhaDoPedido,
): Promise<ResultadoDaReverificacao> {
  const nota = lerNotaNaShopee(linha, ctx.nossaChave);

  switch (nota.veredito) {
    case 'nao-br':
      return semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.pedidoNaoBr);

    case 'outra':
      return comEfeitos(
        ctx,
        deps,
        nota.legivel ? MOTIVO_NFE_SHOPEE.outraNfeAnexada : MOTIVO_NFE_SHOPEE.chaveIlegivel,
        null,
      );

    case 'sem-nota':
      // `valid` with no key: Shopee says the order needs no note (unverified on
      // the wire) — logged, never an aviso and never a resolve.
      return nota.status === 'valida'
        ? semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.notaDispensada)
        : comEfeitos(ctx, deps, MOTIVO_NFE_SHOPEE.naoAnexada, null);

    case 'nossa':
      if (nota.status === 'valida') return validar(ctx, deps);
      if (nota.status === 'pendente') {
        return nota.motivoPendente !== null
          ? comEfeitos(ctx, deps, MOTIVO_NFE_SHOPEE.sefazPendente, nota.motivoPendente)
          : olharDeNovo(ctx, deps, payload);
      }
      // `ausente` / `desconhecido`: no observation of validity ⇒ never resolve.
      return semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.statusDesconhecido);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   the arms                                  */
/* -------------------------------------------------------------------------- */

/** Our note, read valid: close the pedido's aviso if one is open. */
async function validar(
  ctx: ContextoNfeShopee,
  deps: DepsDaReverificacao,
): Promise<ResultadoDaReverificacao> {
  // An absent or already-resolved row answers `false` and writes nothing.
  const resolvido = await resolverAvisoNfeShopee(
    deps.db,
    ctx.integracaoId,
    ctx.pedidoId,
    RESOLUCAO_AVISO_NFE_SHOPEE.nfeValidada,
    { nowMs: deps.nowMs },
  );
  return {
    ...semEfeito(DESFECHO_NFE_SHOPEE.validada, MOTIVO_NFE_SHOPEE.nfeValidada),
    resolvido,
  };
}

/**
 * Our note, pending WITHOUT a reason: one more look while the ladder has a rung
 * left (`reverificacoes + 1 < ATRASOS_REVERIFICACAO_S.length`), with that rung's
 * delay; past the ceiling, a log line.
 *
 * The ceiling is the rung LOOKUP itself: the counter is a whole number ≥ 0 (the
 * payload schema), so "index `reverificacoes + 1` is past the end" and "no rung
 * at that index" are one test — a separate length comparison would be a second
 * spelling of the same bound, and a mutation of either alone would change
 * nothing a test could see.
 */
async function olharDeNovo(
  ctx: ContextoNfeShopee,
  deps: DepsDaReverificacao,
  payload: TarefaNfeShopee,
): Promise<ResultadoDaReverificacao> {
  const proxima = payload.reverificacoes + 1;
  const atraso: number | undefined = ATRASOS_REVERIFICACAO_S[proxima];
  if (atraso === undefined) {
    return semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.validacaoPendente);
  }

  try {
    // ⚠️ The phase is PINNED, never carried from the payload: whatever arrived,
    // a recheck can only ever schedule another recheck.
    await deps.scheduler.enqueue(
      { ...payload, fase: FASE_NFE_SHOPEE.reverificacao, reverificacoes: proxima },
      { scheduleDelaySeconds: atraso },
    );
  } catch (err) {
    if (err instanceof ShopeeNfeUploadTasksDisabledError) {
      console.warn(TAG_LOG, {
        evento: 'reverificacao-nao-agendada',
        fila: SHOPEE_NFE_UPLOAD_QUEUE,
        pedidoId: ctx.pedidoId,
        nfeId: ctx.nfeId,
        reverificacoes: payload.reverificacoes,
      });
      return comEfeitos(ctx, deps, MOTIVO_NFE_SHOPEE.tasksDesabilitadas, null, {
        desfecho: DESFECHO_NFE_SHOPEE.descartado,
      });
    }
    throw err;
  }
  return semEfeito(DESFECHO_NFE_SHOPEE.reverificacaoAgendada, MOTIVO_NFE_SHOPEE.validacaoPendente);
}

/* -------------------------------------------------------------------------- */
/*                         the effects — from the sets only                     */
/* -------------------------------------------------------------------------- */

/**
 * Apply what the SETS say `motivo` owes, and report the outcome. The default
 * outcome is `recusado` (every aviso-raising verdict of the table); the closed
 * valve overrides it with `descartado`.
 */
async function comEfeitos(
  ctx: ContextoNfeShopee,
  deps: DepsDaReverificacao,
  motivo: MotivoNfeShopee,
  excerto: string | null,
  opcoes: { readonly desfecho: DesfechoNfeShopee } = { desfecho: DESFECHO_NFE_SHOPEE.recusado },
): Promise<ResultadoDaReverificacao> {
  const { avisado, carimbo } = await aplicarEfeitos(ctx, deps, motivo, excerto);
  return { ...semEfeito(opcoes.desfecho, motivo), avisado, carimbo };
}

/**
 * The ONE place each set is consulted. Aviso first, then the stamp; `nowUs` is
 * derived once and is the same instant the aviso writer derives from `nowMs`.
 * No catch: a Firestore failure of either write propagates to the queue.
 */
async function aplicarEfeitos(
  ctx: ContextoNfeShopee,
  deps: DepsDaReverificacao,
  motivo: MotivoNfeShopee,
  excerto: string | null,
): Promise<{ readonly avisado: boolean; readonly carimbo: MotivoCarimbo | null }> {
  const avisado = MOTIVOS_QUE_AVISAM.has(motivo);
  if (avisado) {
    await avisarNfeShopee(
      deps.db,
      {
        integracaoId: ctx.integracaoId,
        pedidoId: ctx.pedidoId,
        numero: ctx.numero,
        motivo,
        excerto: MOTIVOS_COM_EXCERTO.has(motivo) ? excerto : null,
      },
      { increment: deps.increment, nowMs: deps.nowMs },
    );
  }
  const carimbo = MOTIVOS_QUE_CARIMBAM.has(motivo)
    ? await carimbarFreteNfeShopee(deps.db, ctx.pedidoId, agoraUsDe({ nowMs: deps.nowMs }))
    : null;
  return { avisado, carimbo };
}

/** An outcome with no write: no aviso, no stamp, no resolve. */
function semEfeito(desfecho: DesfechoNfeShopee, motivo: MotivoNfeShopee): ResultadoDaReverificacao {
  return {
    desfecho,
    motivo,
    fase: FASE_NFE_SHOPEE.reverificacao,
    substituicao: false,
    carimbo: null,
    avisado: false,
    resolvido: false,
  };
}
