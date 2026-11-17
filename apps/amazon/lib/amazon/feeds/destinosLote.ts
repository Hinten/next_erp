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
 * Both rows are `null` in this PR: no provider exists yet. Stock (step 12)
 * fills `estoque`, price (step 13) fills `preco`. With a `null` row the
 * handlers do nothing a provider would have done: a send ends `sem-provedor`
 * before the lease is read (it takes and releases nothing), a result still
 * advances its record and logs that the write-back was skipped, a recovery
 * logs and ends.
 *
 * ⚠️ This table is the ONLY binding between the feed core and a fluxo: no
 * other module of `feeds/` imports a fluxo's own module (this one names the
 * stock producer's TYPE only, for {@link RaizLoteAmazon}), and the jobs root is
 * the only reader of this one. Tests that need a provider hand a fake one to
 * the handler directly, or a fake table to {@link vincularDestinosLoteAmazon};
 * they never edit this table.
 */
import { FLUXO_AMAZON, type FluxoComLoteAmazon } from '../core/valvulas';
import type { ProdutorEstoqueAmazon } from '../estoque/produtorEstoque';
import type { AgendadorLotesAmazon } from './agendadorLotes';
import type { ProvedorLoteAmazon } from './provedorLote';

/**
 * What a provider factory receives: the producers the jobs root binds ONCE,
 * each a thunk the provider calls only when it enqueues.
 */
export interface RaizLoteAmazon {
  /** The jobs queue's producer (a recovery's `feed-enviar`, a reconcile hand-off). */
  readonly agendadorLotes: () => AgendadorLotesAmazon;
  /** The stock queue's producer (one patch task per SKU handed to the per-SKU path). */
  readonly produtorEstoque: () => ProdutorEstoqueAmazon;
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
  estoque: null,
  preco: null,
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
