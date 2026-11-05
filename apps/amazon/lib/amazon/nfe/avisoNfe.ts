/**
 * The Amazon producer of the SHARED `nfeUploadRejeitado` aviso (step 14, PR
 * 14-c), and the resolvers that tipo owes (`packages/schemas/src/aviso.ts`,
 * its docblock: `nfe-validada`, `pedido-cancelado`, `frete-despachado`).
 *
 * ## The row
 *
 * - **Key** `chaveDeAviso({ tipo: nfeUploadRejeitado, conta: integracaoId,
 *   entidade: pedidoId })` — ONE row per PEDIDO, never per NF-e document and no
 *   `janela`: a substitute note must close the row the cancelled one opened,
 *   and a second refusal refreshes it ({@link chaveAvisoNfeAmazon}).
 * - `atencao` (nothing is down; `critico` escalates out of the app), canal
 *   `amazon`, the PEDIDO's route through `ROTAS_AVISO.pedido.build`.
 * - `params` exactly `pedido` (the order number the operator recognises) and
 *   `erro` (`motivosNfe.ts`'s fragment: remedy first, no provider text — X =
 *   ∅); `motivo` is the kebab reason.
 * - Which reasons raise it is `motivosNfe.ts`'s set A ALONE:
 *   {@link avisarNfeAmazon} refuses any other with a `RangeError`, writing
 *   nothing — a caller that reaches here with a log-only reason is a bug.
 *
 * ## The clock — EVERY producer clocks, on the Firestore timeline
 *
 * Unlike Shopee's unclocked rows (step-14 plan §3 decision 13): the order
 * import resolves this row too, and `escreverAviso` / `resolverAviso` drop a
 * stale effect only when BOTH sides carry a clock. So every raise and every
 * resolve here carries the µs of a Firestore commit or read time — the task's
 * P3 pedido snapshot `readTime`, the trigger's T2 pedido `readTime`, the
 * importer's batch `writeTime` — converted by `avisos/avisos.ts`'s
 * {@link relogioDoDocumentoUs} (this module converts NOTHING: `avisos.test.ts`
 * counts the conversion sites as raw text). Commit and read times share one
 * server timeline, so a raise derived from an older read than a resolve that
 * already landed is dropped, and an EQUAL clock is dropped by both seams.
 *
 * ## Two resolvers, and why they differ on an ABSENT row
 *
 * - {@link resolverNfeAmazon} — the NF-e task's own (`nfe-validada` on
 *   Amazon's acceptance, `pedido-cancelado` at its pre-read). It READS the row
 *   first and writes NOTHING when there is none: the task's happy path writes no
 *   document (step-14 plan §2.1), and a resolved row seeded for every accepted
 *   NF-e would be one write per upload. A row that exists is resolved clocked
 *   (an open one closed, a resolved one's watermark advanced when newer — the
 *   shared resolver's rule).
 * - {@link resolverNfeDoPedidoAmazon} — the order import's TRANSITION resolve
 *   (INTO a cancelled sale — `cancelado` or `estornadoIntegralmente`:
 *   `pedido-cancelado`; freight INTO the stock-removal set:
 *   `frete-despachado`). It ALWAYS passes the resolver's options, so on an
 *   absent row it CREATES the resolved tombstone that drops a later stale raise
 *   — a task that read the pedido before the import and raises after it. It
 *   runs only on those two transitions (and, on a redelivery, on the same two
 *   conditions: the attempt that wrote the transition may have died after its
 *   commit), never on a first attempt's hot path.
 *
 * ⚠️ On the NF-e trigger's import closure (`estrutura.test.ts`, pinned file by
 * file, D11 by construction): no context, conta read, valve or SP-API value.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type ResolverAvisoOpts,
  type ResultadoAviso,
  escreverAviso,
  resolverAviso,
} from '@delfrance/data/admin/avisos';
import { avisoCollection } from '@delfrance/data/admin/collections';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import {
  type AvisoDepsAmazon,
  type CommitDoDocumento,
  type MOTIVO_AVISO_AMAZON,
  agoraUsDe,
  depsDeEscrita,
  relogioDoDocumentoUs,
} from '../avisos/avisos';
import { type MotivoNfeAmazon, fraseDoErroNfeAmazon, motivoNfeAvisa } from './motivosNfe';

/**
 * The row's key — and its document id — for one pedido (module header). The
 * producer and every resolver derive it here, so none computes its own.
 */
export function chaveAvisoNfeAmazon(integracaoId: string, pedidoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.nfeUploadRejeitado,
    conta: integracaoId,
    entidade: pedidoId,
  });
}

/** The pedido a row names. */
export interface PedidoDoAvisoNfeAmazon {
  /** The integração document id — the key's `conta`. */
  readonly integracaoId: string;
  /** The pedido document id — the key's `entidade` and the route. */
  readonly pedidoId: string;
  /** Amazon's order id: `params.pedido`, the one value the wording prints. */
  readonly numero: string;
}

/** One raise. */
export interface AvisoNfeAmazon extends PedidoDoAvisoNfeAmazon {
  /** A member of `motivosNfe.ts`'s set A; anything else is refused. */
  readonly motivo: MotivoNfeAmazon;
  /** The Firestore commit or read time the observation was true at (module header). */
  readonly relogio: CommitDoDocumento;
}

/** The pedido's edit route, never a literal (the route freezes at write time). */
function urlDoPedido(pedidoId: string): { rota: string; campo: null } {
  return { rota: ROTAS_AVISO.pedido.build(pedidoId), campo: null };
}

/**
 * Raise (or refresh) "the NF-e of this pedido did not get through to Amazon",
 * clocked (module header). Answers the shared writer's verdict: `ignorado` is a
 * raise older than what the row already holds, dropped on purpose.
 *
 * @throws {RangeError} a motivo outside set A — nothing is written.
 */
export async function avisarNfeAmazon(
  db: Firestore,
  deps: AvisoDepsAmazon,
  e: AvisoNfeAmazon,
): Promise<ResultadoAviso> {
  if (!motivoNfeAvisa(e.motivo)) {
    throw new RangeError(
      'avisoNfe.ts: este motivo não gera aviso — só os do conjunto A (motivosNfe.ts); o resto é log',
    );
  }
  const { resultado } = await escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.nfeUploadRejeitado,
      conta: e.integracaoId,
      entidade: e.pedidoId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.amazon,
      // Structured params, exactly these two (the wording lives in apps/web).
      params: { pedido: e.numero, erro: fraseDoErroNfeAmazon(e.motivo) },
      motivo: e.motivo,
      urlInterna: urlDoPedido(e.pedidoId),
      relogioEvento: relogioDoDocumentoUs(e.relogio),
    },
    depsDeEscrita(deps),
  );
  return resultado;
}

/** The task's two resolutions (module header). */
export type ResolucaoNfeDaTarefaAmazon =
  | typeof MOTIVO_AVISO_AMAZON.nfeValidada
  | typeof MOTIVO_AVISO_AMAZON.pedidoCancelado;

/** The order import's two transition resolutions (module header). */
export type ResolucaoNfeDoPedidoAmazon =
  | typeof MOTIVO_AVISO_AMAZON.pedidoCancelado
  | typeof MOTIVO_AVISO_AMAZON.freteDespachado;

/**
 * The complete seed of a RESOLVED row, for a clocked resolve that finds none:
 * the raise's metadata minus what a resolve does not know (the `erro`, the
 * motivo of a refusal that never happened).
 */
function sementeNfe(p: PedidoDoAvisoNfeAmazon, relogioUs: number): ResolverAvisoOpts {
  return {
    tipo: TIPO_AVISO.nfeUploadRejeitado,
    conta: p.integracaoId,
    entidade: p.pedidoId,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.amazon,
    params: { pedido: p.numero },
    urlInterna: urlDoPedido(p.pedidoId),
    relogioEvento: relogioUs,
  };
}

/**
 * The NF-e task's resolve (module header): no row ⇒ `false`, ZERO writes; a row
 * ⇒ the shared resolver, clocked by `relogio`. `true` only on a real open →
 * resolved transition.
 */
export async function resolverNfeAmazon(
  db: Firestore,
  deps: { readonly nowMs: number },
  e: PedidoDoAvisoNfeAmazon & {
    readonly motivo: ResolucaoNfeDaTarefaAmazon;
    readonly relogio: CommitDoDocumento;
  },
): Promise<boolean> {
  const chave = chaveAvisoNfeAmazon(e.integracaoId, e.pedidoId);
  const snap = await avisoCollection.docRef(db, {}, chave).get();
  if (!snap.exists) return false;
  return resolverAviso(
    db,
    chave,
    e.motivo,
    { agoraUs: agoraUsDe(deps) },
    sementeNfe(e, relogioDoDocumentoUs(e.relogio)),
  );
}

/**
 * The order import's TRANSITION resolve (module header): ALWAYS clocked, ALWAYS
 * with the seed, so an absent row becomes a resolved tombstone that drops a
 * later stale raise. `true` only on a real open → resolved transition.
 */
export function resolverNfeDoPedidoAmazon(
  db: Firestore,
  deps: { readonly nowMs: number },
  e: PedidoDoAvisoNfeAmazon & {
    readonly motivo: ResolucaoNfeDoPedidoAmazon;
    readonly relogio: CommitDoDocumento;
  },
): Promise<boolean> {
  return resolverAviso(
    db,
    chaveAvisoNfeAmazon(e.integracaoId, e.pedidoId),
    e.motivo,
    { agoraUs: agoraUsDe(deps) },
    sementeNfe(e, relogioDoDocumentoUs(e.relogio)),
  );
}
