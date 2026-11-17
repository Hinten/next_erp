/**
 * Amazon's BINDING of the shared quantity core (step 12, PR 12-d): the three
 * parameters that core asks every channel for, and nothing else. Every kit
 * fold, floor and clamp lives once, in that core; what a channel owns is its
 * parameters.
 *
 * All three are PINNED, never read from the environment: Amazon has no stock
 * knob, and a variable that could flip one would put a second quantity rule
 * behind a console setting.
 *
 * - **`incluirEstoqueProprioDoKit: false`** — a kit publishes what its
 *   components allow building (component-min), never that plus its own
 *   stock. Overselling across channels is unrecoverable; the lower number is
 *   the safe one.
 * - **`pularKitVirtual: false`** — "publish no quantity" is inexpressible
 *   here: the stock write is an absolute quantity, and Amazon has no virtual
 *   kit of its own on this wire. A virtual kit is computed as a kit, and the
 *   core never answers `null`.
 * - **`estoqueMax: Number.POSITIVE_INFINITY`** — no documented ceiling. Never
 *   `0`: zero is a legal quantity on this wire, so a `0` ceiling would zero
 *   every listing it touched and nothing downstream would flag it.
 *
 * PURE: no clock, no network, no environment read.
 */
import type { OpcoesDeQuantidade } from '@delfrance/data/admin/estoque';

/** The core's options for every Amazon stock quantity (module header). A fresh object per call. */
export function opcoesEstoqueAmazon(): OpcoesDeQuantidade {
  return {
    incluirEstoqueProprioDoKit: false,
    pularKitVirtual: false,
    estoqueMax: Number.POSITIVE_INFINITY,
  };
}
