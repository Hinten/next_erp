/**
 * The stock plan of the Amazon stock sync (step 12, PR 12-d), pure: whether
 * ONE SKU's ERP quantity is sent, given Amazon's live listing and what this
 * repo last sent; and which form a batch of SKUs takes. The patch task
 * (`processarEstoque.ts`, PR 12-e1) calls it; the feed's build does from PR 12-f.
 *
 * ## The plan ({@link planejarEstoqueAmazon})
 *
 * The write engine's plan (`PlanoEscritaAmazon`): a refused listing (the gate's
 * answer) never writes. An enviável one writes when ANY of these holds, each
 * named by its {@link RegraEscritaEstoqueAmazon} in the diff:
 *
 *  1. `forcado` — the caller FORCES the send (a catch-up after a feed: the
 *     feed's message may still land after this live read, and the feed's own
 *     sends are invisible to the rules below). Forcing drops ONLY the equality
 *     shortcut: every gate still applies;
 *  2. `diferente` — Amazon's quantity is not the ERP's (an absent one counts as
 *     different);
 *  3. `envio-recente` — the link's last outcome is a PATCH (`via: 'patch'`, an
 *     `incerto` one included: its answer was lost, not its write) younger than
 *     {@link JANELA_VISIBILIDADE_MS} that carried a quantity other than the
 *     ERP's. Amazon documents up to 15 minutes before a backend update shows,
 *     so a live read inside that lag may still show the value from before our
 *     PATCH. A `via: 'feed'` outcome is IGNORED here: it stores no quantity
 *     (the conta-level rule 4 covers what a feed changed);
 *  4. `feed-recente` — the live read equals the ERP, and it was taken less than
 *     {@link JANELA_VISIBILIDADE_MS} after the conta's last stock feed ended
 *     (`feedRecenteEmMs`): a feed writes back only its problem SKUs, so an
 *     accepted member has no link outcome, and a feed's end does not end that
 *     lag.
 *
 * Rules 3 and 4 distrust an EQUAL read only inside the lag; past it, the
 * shortcut holds again, so neither can loop. The body is an absolute quantity,
 * so a send they cause is redundant at worst.
 *
 * ## The diff
 *
 * Primitives and closed tokens only: `quantidadeErp`, `quantidadeAmazon`
 * (`null` when the gate refused or Amazon shows none), `direcao` (the live
 * comparison: `sobe`, `desce`, `zera` — the ERP is 0 and Amazon shows anything
 * else —, `igual`; `null` when the gate refused), `motivo` (`enviado`, `igual`,
 * or the gate's refusal) and `regra` (why it writes, `null` when it does not).
 *
 * ## The batch form ({@link caminhoDoLote}, {@link destinoDoLoteDelta})
 *
 * The switch counts a batch's distinct SKUs as its producer sees them, BEFORE
 * any live read, so a batch never moves between forms: at most
 * `LIMIAR_FEED_ESTOQUE_AMAZON` (30) go as one patch task per SKU, more as one
 * feed. A window batch (the tick's, a recovery's) above
 * `MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON` (3,000) is catalogue-scale movement and
 * goes to a reconcile run instead.
 *
 * ## Units
 *
 * Every instant is MILLISECONDS since epoch (`agoraMs`, `feedRecenteEmMs`, the
 * outcome's `emMs`); a value outside a non-negative safe integer is a wiring
 * bug, thrown as a `RangeError` naming the field, never the value.
 *
 * PURE: no Firestore, no clock, no network.
 */
import {
  type EnvioEstoqueAmazon,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
} from '@delfrance/schemas';

import type { PlanoEscritaAmazon } from '../core/escrita';
import type { VeredictoListingEstoqueAmazon } from './gateListing';
import {
  MOTIVO_ESTOQUE_AMAZON,
  type MotivoEstoqueAmazon,
  type RecusaListingEstoqueAmazon,
} from './motivosEstoque';

/**
 * Amazon's DOCUMENTED visibility lag for a backend update, 15 minutes (the
 * typical `getListingsItem` lag is shorter, 1 to 5 minutes; the rules use the
 * documented bound, not the typical one).
 */
export const JANELA_VISIBILIDADE_MS = 900_000;

/* ---------------------------------- tokens ---------------------------------- */

/** The live comparison of the ERP's quantity with Amazon's (module header). */
export type DirecaoEstoqueAmazon = 'sobe' | 'desce' | 'zera' | 'igual';

export const DIRECAO_ESTOQUE_AMAZON = {
  sobe: 'sobe',
  desce: 'desce',
  zera: 'zera',
  igual: 'igual',
} as const satisfies Record<string, DirecaoEstoqueAmazon>;

/** Why a plan writes (module header, rules 1 to 4). */
export type RegraEscritaEstoqueAmazon = 'forcado' | 'diferente' | 'envio-recente' | 'feed-recente';

export const REGRA_ESCRITA_ESTOQUE_AMAZON = {
  forcado: 'forcado',
  diferente: 'diferente',
  envioRecente: 'envio-recente',
  feedRecente: 'feed-recente',
} as const satisfies Record<string, RegraEscritaEstoqueAmazon>;

/** The form a batch of a reconcile's drift takes. */
export type CaminhoLoteEstoqueAmazon = 'patches' | 'feed';

export const CAMINHO_LOTE_ESTOQUE_AMAZON = {
  patches: 'patches',
  feed: 'feed',
} as const satisfies Record<string, CaminhoLoteEstoqueAmazon>;

/** Where a WINDOW batch goes: nothing to send, patches, one feed, or a reconcile run. */
export type DestinoLoteDeltaEstoqueAmazon = 'nada' | 'patches' | 'feed' | 'reconciliacao';

export const DESTINO_LOTE_DELTA_ESTOQUE_AMAZON = {
  nada: 'nada',
  patches: 'patches',
  feed: 'feed',
  reconciliacao: 'reconciliacao',
} as const satisfies Record<string, DestinoLoteDeltaEstoqueAmazon>;

/* ----------------------------------- plan ----------------------------------- */

/** The plan's diff (module header): a type, so it is assignable to the engine's log campos. */
export type DiffEstoqueAmazon = {
  readonly quantidadeErp: number;
  readonly quantidadeAmazon: number | null;
  readonly direcao: DirecaoEstoqueAmazon | null;
  readonly motivo: MotivoEstoqueAmazon;
  readonly regra: RegraEscritaEstoqueAmazon | null;
};

/** The engine's plan for one SKU: whether to write, the quantity to write, and the diff. */
export interface PlanoEstoqueAmazon extends PlanoEscritaAmazon {
  /** The quantity a PATCH or a feed message carries: always the ERP's. */
  readonly quantidade: number;
  readonly diff: DiffEstoqueAmazon;
}

/** The plan's options: the catch-up flag, and the conta's last stock feed end. */
export interface OpcoesPlanoEstoqueAmazon {
  /** A catch-up: drop the equality shortcut, keep every gate. */
  readonly forcar: boolean;
  /** ms — when the conta's last stock feed that may have applied ended; `null` when none is on record. */
  readonly feedRecenteEmMs: number | null;
}

/** A ms instant or quantity: a non-negative safe integer, or a `RangeError` naming the field. */
function exigirInteiro(valor: number, campo: string): number {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`planoEstoque.ts: ${campo} deve ser um inteiro seguro não negativo`);
  }
  return valor;
}

/** The live comparison (module header). */
function direcaoDe(quantidadeErp: number, quantidadeAmazon: number | null): DirecaoEstoqueAmazon {
  if (quantidadeAmazon === quantidadeErp) return DIRECAO_ESTOQUE_AMAZON.igual;
  if (quantidadeErp === 0) return DIRECAO_ESTOQUE_AMAZON.zera;
  if (quantidadeAmazon === null || quantidadeErp > quantidadeAmazon) {
    return DIRECAO_ESTOQUE_AMAZON.sobe;
  }
  return DIRECAO_ESTOQUE_AMAZON.desce;
}

/** Rule 3: our own PATCH of another quantity, still inside the visibility lag. */
function envioRecenteDiverge(
  envio: EnvioEstoqueAmazon | null,
  quantidadeErp: number,
  agoraMs: number,
): boolean {
  if (envio === null || envio.via !== VIA_ENVIO_ESTOQUE_AMAZON.patch) return false;
  return agoraMs - envio.emMs < JANELA_VISIBILIDADE_MS && envio.quantidade !== quantidadeErp;
}

/** Rule 4: an equal read taken inside the lag after the conta's last stock feed ended. */
function feedRecente(feedRecenteEmMs: number | null, agoraMs: number): boolean {
  return feedRecenteEmMs !== null && agoraMs - feedRecenteEmMs < JANELA_VISIBILIDADE_MS;
}

/** The rule a write rests on, in the module header's order, or `null`. */
function regraDaEscrita(
  quantidadeErp: number,
  quantidadeAmazon: number | null,
  envioRecente: EnvioEstoqueAmazon | null,
  agoraMs: number,
  opcoes: OpcoesPlanoEstoqueAmazon,
): RegraEscritaEstoqueAmazon | null {
  if (opcoes.forcar) return REGRA_ESCRITA_ESTOQUE_AMAZON.forcado;
  if (quantidadeAmazon !== quantidadeErp) return REGRA_ESCRITA_ESTOQUE_AMAZON.diferente;
  if (envioRecenteDiverge(envioRecente, quantidadeErp, agoraMs)) {
    return REGRA_ESCRITA_ESTOQUE_AMAZON.envioRecente;
  }
  if (feedRecente(opcoes.feedRecenteEmMs, agoraMs)) return REGRA_ESCRITA_ESTOQUE_AMAZON.feedRecente;
  return null;
}

/**
 * The plan for ONE SKU (module header).
 *
 * @param quantidadeErp the quantity the ERP publishes now (the shared core's).
 * @param gate the listing gate's answer over Amazon's live read.
 * @param envioRecente the SKU's latest stored stock outcome (the link verdict's), or `null`.
 * @param agoraMs ms — the instant of the live read.
 * @throws {RangeError} a quantity or an instant outside a non-negative safe integer.
 */
export function planejarEstoqueAmazon(
  quantidadeErp: number,
  gate: VeredictoListingEstoqueAmazon,
  envioRecente: EnvioEstoqueAmazon | null,
  agoraMs: number,
  opcoes: OpcoesPlanoEstoqueAmazon,
): PlanoEstoqueAmazon {
  exigirInteiro(quantidadeErp, 'quantidadeErp');
  exigirInteiro(agoraMs, 'agoraMs');
  if (opcoes.feedRecenteEmMs !== null) exigirInteiro(opcoes.feedRecenteEmMs, 'feedRecenteEmMs');

  if (!gate.enviavel) {
    const motivo: RecusaListingEstoqueAmazon = gate.motivo;
    return {
      escrever: false,
      quantidade: quantidadeErp,
      diff: { quantidadeErp, quantidadeAmazon: null, direcao: null, motivo, regra: null },
    };
  }

  const { quantidadeAmazon } = gate;
  const regra = regraDaEscrita(quantidadeErp, quantidadeAmazon, envioRecente, agoraMs, opcoes);
  return {
    escrever: regra !== null,
    quantidade: quantidadeErp,
    diff: {
      quantidadeErp,
      quantidadeAmazon,
      direcao: direcaoDe(quantidadeErp, quantidadeAmazon),
      motivo: regra === null ? MOTIVO_ESTOQUE_AMAZON.igual : MOTIVO_ESTOQUE_AMAZON.enviado,
      regra,
    },
  };
}

/* ---------------------------------- batches --------------------------------- */

/**
 * The form of a reconcile's drift of `n` SKUs (n ≥ 1): at most the switch as
 * patches, above it as one feed.
 *
 * @throws {RangeError} `n` not a positive safe integer.
 */
export function caminhoDoLote(n: number): CaminhoLoteEstoqueAmazon {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError('planoEstoque.ts: o lote deve ter ao menos um SKU');
  }
  return n <= LIMIAR_FEED_ESTOQUE_AMAZON
    ? CAMINHO_LOTE_ESTOQUE_AMAZON.patches
    : CAMINHO_LOTE_ESTOQUE_AMAZON.feed;
}

/**
 * Where a WINDOW batch of `n` distinct SKUs goes (the tick's, a recovery's):
 * 0 ⇒ `nada`; 1 to the switch ⇒ `patches`; up to the delta bound ⇒ `feed`;
 * above it ⇒ `reconciliacao`.
 *
 * @throws {RangeError} `n` not a non-negative safe integer.
 */
export function destinoDoLoteDelta(n: number): DestinoLoteDeltaEstoqueAmazon {
  exigirInteiro(n, 'n');
  if (n === 0) return DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.nada;
  if (n <= LIMIAR_FEED_ESTOQUE_AMAZON) return DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.patches;
  if (n <= MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON) return DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.feed;
  return DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.reconciliacao;
}
