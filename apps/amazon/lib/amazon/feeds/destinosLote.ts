/**
 * The feed core's PROVIDER SEAM table (step 12a, PR 12-c; the factory shape
 * since step 12, PR 12-e1): batch fluxo → the FACTORY of the provider that
 * builds, writes back and recovers its feeds (`ProvedorLoteAmazon`,
 * `./provedorLote`). The `notificacoes/destinos.ts` shape: a typed table whose
 * rows may be `null`.
 *
 * ## Why factories
 *
 * A provider must enqueue — a window batch handed to the per-SKU path is one
 * patch task per SKU on the stock queue, a recovery may send ONE `feed-enviar`
 * onto the jobs queue — and `lib/amazon` may neither read the process
 * environment nor import a functions root, which is where the producers are
 * bound. So a row is a function of {@link RaizLoteAmazon}, the root-bound
 * producers, and the jobs root (`functions/src/filaLotes.ts`) calls
 * {@link vincularDestinosLoteAmazon} ONCE per process: each factory runs once,
 * and every dispatch reads the bound providers ({@link ProvedoresLoteAmazon}).
 * The producers stay THUNKS, built only when an enqueue is due, so binding
 * reads no environment and touches no SDK.
 *
 * Stock fills `estoque` since step 12, PR 12-f (`criarProvedorLoteEstoqueAmazon`,
 * `estoque/provedorLoteEstoque.ts`); price fills `preco` since step 13, PR
 * 13-f (`criarProvedorLotePrecoAmazon`, `preco/provedorLotePreco.ts`). With a
 * `null` row (a test's table) the handlers do nothing a provider would have
 * done: a send ends `sem-provedor` before the lease is read (it takes and
 * releases nothing), a result still advances its record and logs that the
 * write-back was skipped, a recovery logs and ends.
 *
 * ⚠️ This table is the ONLY binding between the feed core and a fluxo: no
 * other module of `feeds/` imports a fluxo's own module (this one names the
 * two providers' factories, and the stock and price producers' TYPES for
 * {@link RaizLoteAmazon}), and the jobs root is the only reader of this one.
 * Tests that need a provider hand a fake one to the handler directly, or a
 * fake table to {@link vincularDestinosLoteAmazon}; they never edit this table.
 */
import { FLUXO_AMAZON, type FluxoComLoteAmazon } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import type { ProdutorEstoqueAmazon } from '../estoque/produtorEstoque';
import { criarProvedorLoteEstoqueAmazon } from '../estoque/provedorLoteEstoque';
import type { ProdutorPrecoAmazon } from '../preco/produtorPreco';
import { criarProvedorLotePrecoAmazon } from '../preco/provedorLotePreco';
import type { AgendadorLotesAmazon } from './agendadorLotes';
import type { ProvedorLoteAmazon } from './provedorLote';

/**
 * What a provider factory receives, bound ONCE by the jobs root: the producers,
 * each a thunk the provider calls only when it enqueues, and the runtime pieces
 * a provider's own reads and requests need.
 */
export interface RaizLoteAmazon {
  /** The jobs queue's producer (a recovery's `feed-enviar`, a reconcile hand-off). */
  readonly agendadorLotes: () => AgendadorLotesAmazon;
  /** The stock queue's producer (one patch task per SKU handed to the per-SKU path). */
  readonly produtorEstoque: () => ProdutorEstoqueAmazon;
  /**
   * The price task's producer, onto the jobs queue's path (step 13, PR 13-f):
   * the price provider hands a batch's canary members to `preco-sku` tasks
   * through it, because the jobs producer's typed transport carries the feed
   * core's payloads only. Optional, so a root built for the stock flow alone
   * still binds the whole table; the price provider refuses a hand-off when it
   * is missing, never the binding.
   */
  readonly produtorPreco?: () => ProdutorPrecoAmazon;
  /** A sleep of `ms` milliseconds: the pacing between two Amazon reads of a build. */
  readonly esperar: (ms: number) => Promise<void>;
  /** `(by) => FieldValue.increment(by)`: the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** A fresh run id, for the reconcile run a provider's request may start. */
  readonly gerarExecucaoId: () => string;
  /**
   * The process environment, read when called (never at bind time): a
   * provider's own producers read the fluxo's valve from it before they
   * enqueue — a recovery under `off` does nothing, and a recovery's batch takes
   * the form the valve gives it (`decidirLote`), as every producer's does.
   */
  readonly ambiente: () => AmbienteAmazon;
}

/**
 * The factory of one fluxo's provider, typed by ITS fluxo, so a price provider
 * can never sit in the stock row. The provider's own build data (`D`) is erased
 * here: the handler hands `membros`' answer back to the SAME provider's
 * `montar`, and to nothing else.
 */
export type FabricaProvedorLoteAmazon<F extends FluxoComLoteAmazon> = (
  raiz: RaizLoteAmazon,
) => ProvedorLoteAmazon<F, unknown>;

/** One row per batch fluxo: its provider's factory, or `null`. */
export type DestinoLoteAmazon = {
  readonly [F in FluxoComLoteAmazon]: FabricaProvedorLoteAmazon<F> | null;
};

/** The table BOUND: one row per batch fluxo, its provider, or `null`. */
export type ProvedoresLoteAmazon = {
  readonly [F in FluxoComLoteAmazon]: ProvedorLoteAmazon<F, unknown> | null;
};

/** The seam (module header). */
export const DESTINO_LOTE_AMAZON: DestinoLoteAmazon = {
  estoque: criarProvedorLoteEstoqueAmazon,
  preco: criarProvedorLotePrecoAmazon,
};

/**
 * The table bound to `raiz`: each non-null factory called EXACTLY once, a
 * `null` row kept `null`. The jobs root passes {@link DESTINO_LOTE_AMAZON}
 * itself; a test passes its own table.
 *
 * @throws {TypeError} a factory whose provider names another fluxo — a row
 *   wired to the wrong module, refused at bind time instead of at the first
 *   dispatch.
 */
export function vincularDestinosLoteAmazon(
  raiz: RaizLoteAmazon,
  destinos: DestinoLoteAmazon,
): ProvedoresLoteAmazon {
  return {
    [FLUXO_AMAZON.estoque]: vincular(FLUXO_AMAZON.estoque, destinos.estoque, raiz),
    [FLUXO_AMAZON.preco]: vincular(FLUXO_AMAZON.preco, destinos.preco, raiz),
  };
}

function vincular<F extends FluxoComLoteAmazon>(
  fluxo: F,
  fabrica: FabricaProvedorLoteAmazon<F> | null,
  raiz: RaizLoteAmazon,
): ProvedorLoteAmazon<F, unknown> | null {
  if (fabrica === null) return null;
  const provedor = fabrica(raiz);
  if (provedor.fluxo !== fluxo) {
    throw new TypeError(`destinosLote.ts: a linha ${fluxo} produziu um provedor de outro fluxo`);
  }
  return provedor;
}
