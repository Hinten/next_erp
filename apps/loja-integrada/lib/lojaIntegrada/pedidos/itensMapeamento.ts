/**
 * A Loja Integrada order's lines → the pedido's `ItemDoPedido`s (master plan
 * step 5, PR 5-b), plus the two things the importer needs around them: the
 * produto REFERENCE each line carries (which form, which id), and the subtotal
 * reconciliation that decides whether a residual joins `descontoTotal`.
 *
 * PURE: no Firestore, no wire call, no clock (`nowUs` is a parameter). The
 * produto resolution itself (link docs, the SKU cascade, the `id_externo` GET)
 * is the importer's; it hands the result back here per line.
 *
 * ## Money
 *
 *  - `precoDeVenda` is the wire `preco_venda` UNROUNDED (line prices carry four
 *    decimals). The NF-e takes ten decimals in `vUnCom` and rounds only the
 *    line product (`roundReais(precoDeVenda × quantidade)`), so rounding the
 *    unit price here would move the line total by up to half a centavo per unit.
 *  - `descontoUnitario = (q·pv − preco_subtotal) / q` when positive, else 0. A
 *    line whose subtotal EXCEEDS `q·pv` is not adjusted.
 *  - The residual `r = Σ roundReais(q·pv − q·du) − valor_subtotal`: `r > 0`
 *    joins `descontoTotal`, so the pedido's own total still equals the order's;
 *    `r < 0` is reported (`divergente`, the `li-totais-divergentes` incidente)
 *    and never adjusted — the NF-e's own total guard then names the mismatch.
 *    A positive `r` above one centavo PER LINE is absorbed too but ALSO
 *    reported: rounding a 4-dp line can move it by a centavo at most, so
 *    anything larger means `valor_subtotal` disagrees with the lines.
 *  - `custo` is `preco_custo` when it reads as a number (a JSON number, or a
 *    decimal string through `parseWireDecimal`), else `null`; an unreadable cost
 *    never costs the order.
 *  - A line with no `quantidade` or `preco_venda`, or a negative one, cannot be
 *    priced: the whole mapping answers `ok: false` with the field paths, and
 *    the importer refuses the order before any write. Nothing is guessed.
 *
 * ## Text that looks numeric stays text
 *
 * `sku` (14 to 17 digits) is kept as the string it arrived as; an empty one is
 * no SKU (`null`).
 *
 * ## The produto reference: two forms, narrowest first
 *
 * {@link formaDoProdutoLi} reads `itens[].produto`:
 *
 *  - `/api/v1/produto/<id>` (optionally with a trailing slash, no query) — the
 *    Loja Integrada produto id (`id-li`);
 *  - the same path with exactly `?id_externo=1` — the store's EXTERNAL id
 *    (`id-externo`), which the importer resolves by SKU first and then through
 *    the `id_externo` GET;
 *  - the object form `{ resource_uri, id_externo }`: `resource_uri` read as the
 *    string form first — the Loja Integrada id is the narrowest key, and the
 *    object then answers exactly as its bare URI would — and only without a
 *    readable one a usable `id_externo`.
 *
 * Anything else is NEITHER form (`nenhuma`) — `''`, a placeholder, a full URL,
 * an id with a leading zero, a non-positive or unsafe id — and the line falls
 * back to the SKU alone. ⚠️ An `id-externo` id is always a canonical positive
 * integer, so the importer never builds the GET out of `''`.
 */
import { roundReais } from '@delfrance/core/money';
import { parseWireDecimal } from '@delfrance/core/wire';
import type { PedidoItemLi } from '@delfrance/integrations-loja-integrada';
import { itemDoPedidoSchema, type ItemDoPedido } from '@delfrance/schemas';

import { ensureUniqueIdLi } from './orderIdsLi';

/* -------------------------------------------------------------------------- */
/*                           the produto reference                             */
/* -------------------------------------------------------------------------- */

/** Which reference a line carries (module header). */
export type FormaProdutoLi =
  | { readonly forma: 'id-li'; readonly idLi: string }
  | { readonly forma: 'id-externo'; readonly idExterno: string }
  | { readonly forma: 'nenhuma' };

const NENHUMA: FormaProdutoLi = { forma: 'nenhuma' };

const URI_PRODUTO = /^\/api\/v1\/produto\/([1-9][0-9]*)\/?$/;
const URI_PRODUTO_ID_EXTERNO = /^\/api\/v1\/produto\/([1-9][0-9]*)\/?\?id_externo=1$/;
const INTEIRO_POSITIVO = /^[1-9][0-9]*$/;

/** The canonical decimal of a positive safe integer, or `null`. */
function idCanonico(valor: unknown): string | null {
  const texto =
    typeof valor === 'number' ? String(valor) : typeof valor === 'string' ? valor : null;
  if (texto === null || !INTEIRO_POSITIVO.test(texto)) return null;
  return Number.isSafeInteger(Number(texto)) ? texto : null;
}

function formaDaUri(uri: string): FormaProdutoLi {
  const li = URI_PRODUTO.exec(uri);
  if (li !== null) {
    const idLi = idCanonico(li[1]);
    return idLi === null ? NENHUMA : { forma: 'id-li', idLi };
  }
  const externo = URI_PRODUTO_ID_EXTERNO.exec(uri);
  if (externo !== null) {
    const idExterno = idCanonico(externo[1]);
    return idExterno === null ? NENHUMA : { forma: 'id-externo', idExterno };
  }
  return NENHUMA;
}

/** The reference `itens[].produto` carries (module header). */
export function formaDoProdutoLi(produto: PedidoItemLi['produto']): FormaProdutoLi {
  if (typeof produto === 'string') return formaDaUri(produto);
  if (produto === null || produto === undefined) return NENHUMA;
  // Narrowest first: a readable resource_uri names the produto itself.
  const daUri =
    typeof produto.resource_uri === 'string' ? formaDaUri(produto.resource_uri) : NENHUMA;
  if (daUri.forma !== 'nenhuma') return daUri;
  const idExterno = idCanonico(produto.id_externo);
  return idExterno === null ? NENHUMA : { forma: 'id-externo', idExterno };
}

/** The Loja Integrada id of a variation line's parent (`produto_pai`), or `null`. */
export function idLiDoProdutoPai(produtoPai: string | null | undefined): string | null {
  if (typeof produtoPai !== 'string') return null;
  const forma = formaDaUri(produtoPai);
  return forma.forma === 'id-li' ? forma.idLi : null;
}

/** What the importer resolves one line by. */
export interface ReferenciaDeProdutoLi {
  readonly ensureUniqueId: string;
  readonly forma: FormaProdutoLi;
  /** The parent's Loja Integrada id, for a variation line. */
  readonly idLiPai: string | null;
  readonly sku: string | null;
}

/** A non-empty string kept verbatim, or `null`. */
function textoOuNulo(valor: string | null | undefined): string | null {
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/** Each line's produto reference, for the importer's resolution. Lines without an id are skipped. */
export function referenciasDeProdutoLi(
  itens: readonly PedidoItemLi[],
): readonly ReferenciaDeProdutoLi[] {
  return itens.flatMap((item) =>
    item.id == null
      ? []
      : [
          {
            ensureUniqueId: ensureUniqueIdLi(item.id),
            forma: formaDoProdutoLi(item.produto),
            idLiPai: idLiDoProdutoPai(item.produto_pai),
            sku: textoOuNulo(item.sku),
          },
        ],
  );
}

/* -------------------------------------------------------------------------- */
/*                                 the lines                                   */
/* -------------------------------------------------------------------------- */

/** How one line resolved (the importer's answer). */
export interface ResolucaoLinhaLi {
  /** The ERP produto, or `null` for an unmatched line (kept under `'NONE'`). */
  readonly produtoUid: string | null;
  /** The Loja Integrada produto id the line resolved to, when the import learned it. */
  readonly idLi?: string | null;
}

export interface EntradaItensLi {
  readonly itens: readonly PedidoItemLi[];
  /** The order's `valor_subtotal`; absent ⇒ no reconciliation. */
  readonly valorSubtotal: number | null | undefined;
  /** By `ensureUniqueId`. A line with no entry is unmatched. */
  readonly resolucoes: ReadonlyMap<string, ResolucaoLinhaLi>;
  readonly nowUs: number;
}

export type ItensMapeadosLi =
  /** A line cannot be keyed or priced: the field paths, never a value. */
  | { readonly ok: false; readonly campos: readonly string[] }
  | {
      readonly ok: true;
      readonly itens: readonly ItemDoPedido[];
      /** `Σ roundReais(q·pv − q·du) − valor_subtotal`, rounded; 0 when unreconciled. */
      readonly residuo: number;
      /** The positive residual: what joins `descontoTotal`. */
      readonly descontoExtra: number;
      /**
       * The `li-totais-divergentes` incidente: a negative residual (never
       * adjusted), or a positive one rounding cannot explain (absorbed anyway).
       */
      readonly divergente: boolean;
      /** The ids of the lines with no produto. */
      readonly semProduto: readonly string[];
    };

/** Below this, `q·pv − subtotal` is float noise, not a discount (prices have ≤ 4 dp, quantities ≤ 3). */
const RUIDO = 1e-9;

/** The most rounding one 4-dp line can move the residual by: a centavo. */
const RESIDUO_MAXIMO_POR_LINHA = 0.01;

/** `preco_custo` as a number, or `null` (module header). */
export function custoDoItemLi(precoCusto: unknown): number | null {
  if (typeof precoCusto === 'number') return Number.isFinite(precoCusto) ? precoCusto : null;
  return parseWireDecimal(precoCusto);
}

/** The unit discount of one line: positive, or 0. */
export function descontoUnitarioLi(
  quantidade: number,
  precoVenda: number,
  precoSubtotal: number | null | undefined,
): number {
  if (precoSubtotal == null || quantidade <= 0) return 0;
  const diferenca = quantidade * precoVenda - precoSubtotal;
  return diferenca > RUIDO ? diferenca / quantidade : 0;
}

/** Map every line (module header). Never reorders or drops one. */
export function mapearItensLi(entrada: EntradaItensLi): ItensMapeadosLi {
  const { itens, valorSubtotal, resolucoes, nowUs } = entrada;
  const campos = new Set<string>();
  for (const item of itens) {
    if (item.id == null) campos.add('itens[].id');
    if (item.quantidade == null || item.quantidade < 0) campos.add('itens[].quantidade');
    if (item.preco_venda == null || item.preco_venda < 0) campos.add('itens[].preco_venda');
  }
  if (campos.size > 0) return { ok: false, campos: [...campos] };

  const mapeados: ItemDoPedido[] = [];
  const semProduto: string[] = [];
  let somaDasLinhas = 0;
  itens.forEach((item, indice) => {
    // Checked above; the narrowing does not survive the closure.
    const quantidade = item.quantidade!;
    const precoDeVenda = item.preco_venda!;
    const ensureUniqueId = ensureUniqueIdLi(item.id!);
    const descontoUnitario = descontoUnitarioLi(quantidade, precoDeVenda, item.preco_subtotal);
    somaDasLinhas += roundReais(quantidade * precoDeVenda - quantidade * descontoUnitario);

    const resolucao = resolucoes.get(ensureUniqueId);
    const produtoUid = resolucao?.produtoUid ?? null;
    if (produtoUid === null) semProduto.push(ensureUniqueId);
    const forma = formaDoProdutoLi(item.produto);
    const mktplaceId = resolucao?.idLi ?? (forma.forma === 'id-li' ? forma.idLi : null);

    mapeados.push(
      itemDoPedidoSchema.parse({
        produtoUid,
        ordem: item.linha ?? indice + 1,
        ensureUniqueId,
        mktplaceId,
        sku: textoOuNulo(item.sku),
        gtin: null,
        nomeDeVenda: textoOuNulo(item.nome),
        precoDeVenda,
        descontoUnitario,
        quantidade,
        custo: custoDoItemLi(item.preco_custo),
        timestamp: nowUs,
      }),
    );
  });

  const residuo = valorSubtotal == null ? 0 : roundReais(roundReais(somaDasLinhas) - valorSubtotal);
  const limite = roundReais(RESIDUO_MAXIMO_POR_LINHA * itens.length);
  return {
    ok: true,
    itens: mapeados,
    residuo,
    descontoExtra: residuo > 0 ? residuo : 0,
    divergente: residuo < 0 || residuo > limite,
    semProduto,
  };
}
