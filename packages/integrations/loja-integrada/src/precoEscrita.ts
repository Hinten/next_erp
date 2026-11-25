/**
 * The price write of master-plan step 13, over the write client (`escrita.ts`):
 *
 *  - {@link corpoPrecoProdutoLi} — the body of one price write, built from a
 *    target in integer centavos (`precoAlvoLi`, `@delfrance/schemas`), the
 *    configured clear and the store's own custo and `sob_consulta` from the
 *    deciding read. Pure;
 *  - {@link atualizarPrecoProdutoLi} — `PUT /v1/produto_preco/{produto id}`
 *    with that body. The path id is the PRODUTO's id, never a price row's own
 *    `id`. One call per product: the API has no batch.
 *
 * It only builds and sends: no read, no retry, no decision. Which price is
 * due, whether the store already shows it and whether a write may lower it are
 * the app's, from the produto detail read just before it
 * (`liProdutoComPrecoDetalheSchema`, `types.ts`); every error is the write
 * client's, rethrown as-is.
 *
 * ## A FULL write
 *
 * Every price write carries `cheio`, `promocional` and `sob_consulta`, and
 * `custo` whenever the store holds one, merged over the deciding read: whether
 * the store reads a body as full or partial is not proven, and a full body is
 * right under either reading. A body without `sob_consulta` is refused, so no
 * write can leave the store to guess it.
 *
 *  - `cheio`: the target's full price, `centavos / 100`, a JSON number above 0
 *    with at most two decimal places.
 *  - `promocional`: a positive promotion the same way, or the CLEAR in the
 *    configured shape (`FORMA_PROMO_LIMPA_LI`, `@delfrance/schemas`): `null`
 *    (the default), `0`, or the full price itself.
 *  - `custo`: the STORE's own custo, echoed from the deciding read as the JSON
 *    number the produto detail carries, never set. The ERP custo is never sent
 *    (the owner's decision). A `null` custo, the common case (about four linked
 *    children in ten in the owner's read-only price capture), OMITS the key;
 *    so does a custo the route cannot send (a string, a negative, `NaN`), which
 *    the caller logs. `0` is a custo and is sent.
 *  - `sob_consulta`: the store's own, echoed, never set.
 *
 * The two-decimal rule binds `cheio` and `promocional` only: the custo is the
 * store's value, sent back as it came.
 *
 * ## What the package refuses, for every price write it can send
 *
 * The request core checks EVERY `PUT` against the write routes
 * (`rotasEscrita.ts`) before it reads the credential, so these hold for any
 * holder of a write client, not only for the function below: a full price of 0
 * or less, a third decimal place (`274.425`, `0.1 + 0.2`), a quoted price, a
 * `null` or quoted custo, a missing or non-boolean `sob_consulta`, a stray key
 * — each `LiConfigError('corpo')`, nothing fetched; a trailing slash or a
 * non-canonical id — `LiConfigError('rota-nao-permitida')`. ⚠️ The route accepts
 * every clear spelling (`null`, `0`, a positive price), because a route is
 * looked up by its path alone; only {@link corpoPrecoProdutoLi} holds a write
 * to the CONFIGURED one.
 *
 * ## Rollback limits
 *
 * Re-sending a logged prior price through this package cannot put every row
 * back exactly: a prior value with more than two decimal places (judged in
 * centavos, never by counting the digits of the store's four-decimal text) and
 * a prior `null` or 0 full price cannot be sent, and a prior `null` or 0
 * promotion goes back as the configured clear.
 *
 * ## Unproven until the first canary write
 *
 * The PUT's path form (the no-slash document key, which GETs answered), whether
 * the store treats the body as full or partial, whether it keeps cents on
 * `promocional` (the public document types that leaf as an integer: a promotion
 * of 22.83 stored as 22 is what the read-back must catch), and which clear it
 * accepts. No write is made before the cutover.
 *
 * ## Echo
 *
 * Read through `liEcoPrecoProdutoSchema` (`types.ts`), every field optional and
 * raw: the document's echo carries the amounts as text. An echo is diagnostic,
 * and a write that landed is reported, never thrown (`escrita.ts`).
 */
import { centavosDeReais } from '@delfrance/core/money';
import {
  type EnvioPrecoLi,
  FORMA_PROMO_LIMPA_LI,
  type FormaPromoLimpaLi,
} from '@delfrance/schemas';

import type { LiEscritaClient, RespostaEscritaLi } from './escrita';
import { idOuRecusa } from './idsDeCaminho';
import type { OpcoesEscritaLi } from './pedidosEscrita';
import { CAMINHO_PRECO_LI } from './preco';
import { type CorpoPrecoProdutoLi, custoEcoavelLi, precoDeEscritaValidoLi } from './rotasEscrita';
import { type EcoPrecoProdutoLi, liEcoPrecoProdutoSchema } from './types';

export {
  type CorpoPrecoProdutoLi,
  corpoPrecoProdutoValidoLi,
  custoEcoavelLi,
  precoDeEscritaValidoLi,
} from './rotasEscrita';

/**
 * What became of the store's custo in a built body: `enviado` — echoed (a
 * sendable JSON number, `0` included); `omitido-nulo` — the store holds none,
 * so the key is omitted (the common case); `omitido-ilegivel` — the store's
 * value is not one the route can send, so the key is omitted too, and the
 * caller logs it.
 */
export type CustoNoCorpoPrecoLi = 'enviado' | 'omitido-nulo' | 'omitido-ilegivel';

/** A price write's body, and what became of the store's custo in it. */
export interface CorpoPrecoMontadoLi {
  readonly corpo: CorpoPrecoProdutoLi;
  readonly custo: CustoNoCorpoPrecoLi;
}

/**
 * The decimal `centavos` names in reais, as a JSON number prints it: no point
 * for whole reais, no trailing zero (`27442` ⇒ `274.42`, `1990` ⇒ `19.9`,
 * `500` ⇒ `5`). Integer arithmetic only. Called with a positive safe integer.
 */
function textoDosCentavos(centavos: number): string {
  const resto = centavos % 100;
  const inteiros = String((centavos - resto) / 100);
  if (resto === 0) return inteiros;
  return `${inteiros}.${String(resto).padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * `centavos` as the reais a price write sends, `centavos / 100`, which must be
 * a price the route sends AND name exactly `centavos` both ways it can be read
 * back: the JSON text sent (`String`, which is what `JSON.stringify` prints for
 * it) and the number read through the money module (`centavosDeReais`, the
 * price fold's own conversion). Otherwise a `RangeError` (a bug, or a value no
 * send may carry): a target that is not positive integer centavos, or one past
 * the exact round trip. Measured: exact on both for every centavos value up to
 * 2e15 that was sampled; above it each one fails for some values the other
 * does not.
 */
function reaisDoAlvoLi(centavos: number, folha: string): number {
  const reais = centavos / 100;
  if (
    !precoDeEscritaValidoLi(reais) ||
    centavosDeReais(reais) !== centavos ||
    String(reais) !== textoDosCentavos(centavos)
  ) {
    throw new RangeError(
      `corpoPrecoProdutoLi: ${folha} fora da forma (centavos inteiros positivos e exatos)`,
    );
  }
  return reais;
}

/** The clear, in the configured shape: `null`, `0`, or the full price. */
function promocionalLimpo(forma: FormaPromoLimpaLi, cheio: number): number | null {
  switch (forma) {
    case FORMA_PROMO_LIMPA_LI.nulo:
      return null;
    case FORMA_PROMO_LIMPA_LI.zero:
      return 0;
    case FORMA_PROMO_LIMPA_LI.igualCheio:
      return cheio;
  }
}

/**
 * The body of ONE price write (module header, "A FULL write"):
 *
 *  - `cheio` = `alvo.cheioCentavos / 100`;
 *  - `promocional` = a positive promotion's `centavos / 100`, or, for
 *    `'limpar'`, the clear in `formaPromoLimpa` — `nulo` ⇒ `null`, `zero` ⇒ `0`,
 *    `igual-cheio` ⇒ the full price;
 *  - `custo` = the store's own custo when the route can send it, else OMITTED
 *    (`null` ⇒ `omitido-nulo`; anything else — `'0.0000'`, `'10.50'`, a
 *    negative, `NaN`, `undefined` — ⇒ `omitido-ilegivel`);
 *  - `sob_consulta` = the store's own, as the caller narrowed it.
 *
 * Throws `RangeError` on a price that is not positive integer centavos, or
 * past the exact round trip ({@link reaisDoAlvoLi}): `precoAlvoLi` never builds
 * the former.
 */
export function corpoPrecoProdutoLi(args: {
  readonly alvo: EnvioPrecoLi;
  readonly formaPromoLimpa: FormaPromoLimpaLi;
  /** The deciding read's `preco_custo`, raw. */
  readonly custo: unknown;
  /** The deciding read's `preco_sob_consulta`, narrowed to a boolean by the caller. */
  readonly sobConsulta: boolean;
}): CorpoPrecoMontadoLi {
  const { alvo } = args;
  const cheio = reaisDoAlvoLi(alvo.cheioCentavos, 'cheio');
  const promocional =
    alvo.promo === 'limpar'
      ? promocionalLimpo(args.formaPromoLimpa, cheio)
      : reaisDoAlvoLi(alvo.promo.centavos, 'promocional');
  const sob_consulta = args.sobConsulta;
  if (custoEcoavelLi(args.custo)) {
    return { corpo: { cheio, custo: args.custo, promocional, sob_consulta }, custo: 'enviado' };
  }
  return {
    corpo: { cheio, promocional, sob_consulta },
    custo: args.custo === null ? 'omitido-nulo' : 'omitido-ilegivel',
  };
}

/**
 * `PUT /v1/produto_preco/{produtoId}`: write ONE product's prices as `corpo`
 * ({@link corpoPrecoProdutoLi}). `produtoId` is the PRODUTO's id; no trailing
 * slash. The route checks the body again before anything is sent.
 */
export async function atualizarPrecoProdutoLi(
  cliente: LiEscritaClient,
  produtoId: number | string,
  corpo: CorpoPrecoProdutoLi,
  opts: OpcoesEscritaLi = {},
): Promise<RespostaEscritaLi<EcoPrecoProdutoLi>> {
  const operacao = 'atualizarPrecoProduto';
  const id = idOuRecusa(produtoId, operacao);
  return cliente.enviarEscritaLi({
    operacao,
    caminho: `${CAMINHO_PRECO_LI}/${id}`,
    corpo,
    ecoSchema: liEcoPrecoProdutoSchema,
    sinal: opts.sinal,
  });
}
