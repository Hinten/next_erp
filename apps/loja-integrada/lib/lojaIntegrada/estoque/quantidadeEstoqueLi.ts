/**
 * **Loja Integrada's BINDING of the shared quantity core** — how many units one store child
 * advertises at the conta's depósito, and the four-field body that says so (master plan step 12,
 * PR 12-c). ONE function, shared with publish (step 11, which computes no stock of its own and
 * enqueues a send run instead).
 *
 * ## No kit arithmetic here
 *
 * The kit fold, the floor and the lower clamp live once, in `@delfrance/data/admin/estoque`
 * (`quantidades.ts`), the core Mercado Livre and Shopee already share. It is called, never
 * forked, and its suites stay byte-unedited: a second copy of that fold drifts toward plausible
 * while reading correct (root `CLAUDE.md`, #1369). What this channel owns is the three
 * PARAMETERS ({@link opcoesEstoqueLi}), how its rows become the core's member
 * ({@link membroEstoqueLi}) and the reservation rule of its wire ({@link alvoEstoqueLi},
 * {@link corpoEstoqueLi}).
 *
 * ## The three parameters
 *
 *  - `incluirEstoqueProprioDoKit: false` — a constrained kit is the minimum over its components,
 *    never that plus the kit's own record (ERP kits hold no stock, ADR 0014);
 *  - `pularKitVirtual: false` — "send no quantity" is not a body this wire has: the stock PUT
 *    always carries `quantidade`, so a virtual kit takes the ordinary kit branch (#1087), as on
 *    Shopee;
 *  - `estoqueMax: +∞` — ⚠️ never `0`, which is a legal quantity and would zero every row it
 *    touched. The configured cap (`LOJA_INTEGRADA_ESTOQUE_MAX`) is read at an entry point and
 *    applied by the CALLER at diff and send time (`planoEstoqueLi.ts`), never baked in here: the
 *    reconcile's snapshot stores the uncapped number, so a cap change needs no ERP read.
 *
 * ## The owner comes from the PATH (#932)
 *
 * The core keys a component's availability on the row's `parentId`; a row the join could not key
 * reads as missing, and a missing component counts 0. A record located by its path already names
 * its owner, so {@link membroEstoqueLi} takes it from there and never trusts the stored denorm
 * (absent on legacy rows, and nothing guarantees it agrees).
 *
 * ## Model A (decided 2026-11-12)
 *
 * The store subtracts its own pending reservations from `quantidade`, so what the ERP can sell
 * (S) is sent as `quantidade = S + max(0, quantidade_reservada)`, read from the store's row just
 * before the PUT. `quantidade_disponivel` is never the input: it is the store's own derived
 * figure, and nothing guarantees it agrees with the two fields it derives from.
 *
 * PURE: no clock, no network, no Firestore, no environment read.
 */
import type { ComponentesKit } from '@delfrance/schemas';
import {
  type MembroDaFamilia,
  type OpcoesDeQuantidade,
  type RawEstoqueRow,
  quantidadeDoMembroCore,
} from '@delfrance/data/admin/estoque';

/**
 * The channel's three parameters for the shared fold (module header). Frozen: every caller in
 * a run must hand the core the SAME object, and none may adjust it.
 */
export const opcoesEstoqueLi: OpcoesDeQuantidade = Object.freeze({
  incluirEstoqueProprioDoKit: false,
  pularKitVirtual: false,
  estoqueMax: Number.POSITIVE_INFINITY,
});

/** The fields of a produto the quantity reads, as a masked read hands them over. */
export interface ProdutoEstoqueLi {
  readonly ehKit?: unknown;
  readonly ehKitVirtual?: unknown;
  readonly componentesKit?: ComponentesKit | null;
  readonly statusProdutosMarketplace?: unknown;
}

/**
 * One stock record as a read hands it over: its full document path
 * (`produtos/{produtoId}/estoques/{estoqueId}`) and its raw data.
 */
export interface DocEstoqueLi {
  readonly caminho: string;
  readonly dados: Readonly<Record<string, unknown>>;
}

/** A stock record's path, split. */
export interface CaminhoEstoqueLi {
  readonly produtoId: string;
  readonly estoqueId: string;
}

const CAMINHO_ESTOQUE = /^produtos\/([^/]+)\/estoques\/([^/]+)$/;

/**
 * The owner and the id of a stock record from its path, or `null` when the text is not exactly
 * `produtos/{produtoId}/estoques/{estoqueId}` (a leading slash, a `documents/` prefix, another
 * collection, an empty segment — an Admin SDK path is never any of those).
 */
export function caminhoEstoqueLi(caminho: string): CaminhoEstoqueLi | null {
  const m = CAMINHO_ESTOQUE.exec(caminho);
  if (m === null) return null;
  const [, produtoId, estoqueId] = m;
  if (produtoId === undefined || estoqueId === undefined) return null;
  return { produtoId, estoqueId };
}

/** {@link caminhoEstoqueLi}, for a path that came from a read: anything else is a bug. */
function caminhoLido(doc: DocEstoqueLi): CaminhoEstoqueLi {
  const partes = caminhoEstoqueLi(doc.caminho);
  if (partes === null) {
    throw new RangeError('membroEstoqueLi: caminho de estoque inválido');
  }
  return partes;
}

/**
 * The shared core's member for one produto at the conta's depósito.
 *
 *  - `estoque`: the produto's OWN record there (chosen by the caller, a canonical record winning
 *    over a legacy one), or `null` when it has none — the core then reads 0;
 *  - `componentes`: one record per kit component at the same depósito; each row's `parentId` is
 *    the owner in its PATH (module header). A component with no record is simply absent: the
 *    core counts it 0 (#238), the safe direction;
 *  - the kit flags are read exactly (`=== true`): a stored `'true'` or `1` is not a kit.
 *
 * `publicado` and `timestampMs` are the member type's fields for another channel's sweep; the
 * quantity never reads them.
 *
 * Throws `RangeError` when a path does not parse, or the own record belongs to another produto:
 * both come from a read, so either is a bug, never data.
 */
export function membroEstoqueLi(args: {
  readonly produtoId: string;
  readonly produto: ProdutoEstoqueLi;
  readonly estoque: DocEstoqueLi | null;
  readonly componentes: readonly DocEstoqueLi[];
}): MembroDaFamilia {
  let estoque: RawEstoqueRow | null = null;
  if (args.estoque !== null) {
    const proprio = caminhoLido(args.estoque);
    if (proprio.produtoId !== args.produtoId) {
      throw new RangeError('membroEstoqueLi: o estoque próprio é de outro produto');
    }
    estoque = { ...args.estoque.dados, estoqueDocId: proprio.estoqueId };
  }
  const componentEstoques = args.componentes.map((doc): RawEstoqueRow => {
    const dono = caminhoLido(doc);
    return { ...doc.dados, estoqueDocId: dono.estoqueId, parentId: dono.produtoId };
  });
  return {
    produtoId: args.produtoId,
    ehKit: args.produto.ehKit === true,
    ehKitVirtual: args.produto.ehKitVirtual === true,
    publicado: true,
    componentesKit: args.produto.componentesKit ?? null,
    timestampMs: null,
    estoque,
    componentEstoques,
  };
}

/**
 * S — what the ERP can sell of this produto at the conta's depósito: a non-negative integer,
 * UNCAPPED (the caller applies the configured cap). The shared core with
 * {@link opcoesEstoqueLi}: a kit — `ehKit` OR `ehKitVirtual`, the core's own branch — is the
 * minimum over its constraining components of ⌊available / quantity in the kit⌋; a kit no
 * component constrains falls back to its own record; anything else is its own available
 * quantity, floored and clamped at 0.
 *
 * The `?? 0` is the TYPE's: the core answers `null` only for a virtual kit while
 * `pularKitVirtual` is on, and this channel pins it off.
 */
export function quantidadeEstoqueLi(membro: MembroDaFamilia): number {
  return quantidadeDoMembroCore(membro, opcoesEstoqueLi) ?? 0;
}

/** A non-negative safe integer: what a quantity on this wire is. */
function inteiroNaoNegativo(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0;
}

/**
 * Model A's target: `S + max(0, R)`, where `R` is the store row's `quantidade_reservada`
 * exactly as read. A negative reservation is no reservation (it would otherwise SUBTRACT from
 * what the ERP can sell), and anything that is not a safe integer — `1.5`, `NaN`, `'2'`, `null`,
 * absent — REFUSES (`null`): a quantity derived from a figure we cannot read is never sent.
 * `null` as well when the sum leaves the safe integers.
 *
 * Throws `RangeError` when `S` is not a non-negative safe integer: S is ours, already floored,
 * clamped and capped, so anything else is a bug.
 */
export function alvoEstoqueLi(S: number, R: unknown): number | null {
  if (!inteiroNaoNegativo(S)) throw new RangeError('alvoEstoqueLi: S inválido');
  if (typeof R !== 'number' || !Number.isSafeInteger(R)) return null;
  const alvo = S + Math.max(0, R);
  return Number.isSafeInteger(alvo) ? alvo : null;
}

/** The stock PUT's body: the four fields, nothing else. */
export interface CorpoEstoqueLi {
  readonly gerenciado: true;
  readonly quantidade: number;
  readonly situacao_em_estoque: 0;
  readonly situacao_sem_estoque: -1;
}

/**
 * The master plan's binding four-field body for S and the store's reservation `R`:
 * `{ gerenciado: true, quantidade: S + max(0, R), situacao_em_estoque: 0,
 * situacao_sem_estoque: -1 }`. Per the provider's stock tag (`spec tag Estoque`): stock managed
 * by the store, shipped at once while in stock, and the product UNAVAILABLE once it runs out
 * (`0` or a positive number there would keep it purchasable, with a lead time, past zero).
 * `null` exactly when {@link alvoEstoqueLi} refuses `R`; throws as it does on a bad S.
 */
export function corpoEstoqueLi(S: number, R: unknown): CorpoEstoqueLi | null {
  const quantidade = alvoEstoqueLi(S, R);
  if (quantidade === null) return null;
  return { gerenciado: true, quantidade, situacao_em_estoque: 0, situacao_sem_estoque: -1 };
}
