'use client';

/**
 * A leaf category's STANDARDISED variation tree, as the Shopee tab of
 * `/variacoes/[id]` reads it (#1911 P14): the React Query hook over
 * `client.variacoes`, the pure readers of one answer, the one label, and the
 * tab's copy for a failed read ({@link descreverFalhaVariacoesShopee}).
 *
 * ## The shape these readers exist for
 *
 * Three levels, variation → group → option, and every level can be empty:
 *
 * - **Nothing to bind is normal.** A category can list several variations and not
 *   one option, so "nothing to bind" is never "the list is empty"; it is
 *   {@link variacoesVinculaveisShopee} coming back empty on a leaf. ⚠️ A non-leaf
 *   answers an empty list too: read `leaf` first.
 * - **A group of `0` is a value.** A single-level variation has ONE group,
 *   `{ variationGroupId: 0, variationGroupName: '' }`, and `0` is what a link
 *   stores for it. Only `null` means "no automatic answer"
 *   ({@link grupoAutomaticoShopee}): never test the result for truthiness.
 * - **Options are scoped to their group.** `M` is 6270 in `Tamanho (INT)` and 6933
 *   in `Tamanho (BR)`, so offering options across groups would store the wrong id
 *   ({@link opcoesDoGrupoShopee}).
 * - **Ids decide, names never do.** `Preto` is both 6258 and 9585: two options.
 *   Nothing here compares, dedupes or keys by a name, so this module holds no fold
 *   and owes no `equivalence-fold-inventory` row.
 *
 * Every reader hands back Shopee's strings VERBATIM, because the publisher folds
 * when it sends. {@link rotuloShopee} trims for display and its output decides
 * nothing: a `Select`'s value is `String(id)`, never the label.
 *
 * ## When a read happens
 *
 * Once per (conta, category) for {@link VARIACOES_SHOPEE_STALE_MS}, only while the
 * caller says so (`enabled`: the tab is active), never without a client or a
 * category. Retries follow `shopeeQueryRetry`, never a 502 (`./erros.ts`).
 */
import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { ShopeeClientHttpError, useShopeeClient } from './client';
import {
  CODIGO_FALHA_SHOPEE,
  descreverFalhaShopee,
  shopeeQueryRetry,
  type FalhaShopee,
} from './erros';
import type {
  RespostaVariacoesShopee,
  VariacaoDto,
  VariacaoGrupoDto,
  VariacaoOpcaoDto,
} from './wire';

/** The backend caches the tree for 15 min (`taxonomia/cache.ts`); asking sooner learns nothing new. */
export const VARIACOES_SHOPEE_STALE_MS = 15 * 60_000;

/** `['shopee','variacoes',integracaoId,categoryId]` — one tree per conta and category. */
export function chaveVariacoesShopee(
  integracaoId: string,
  categoryId: number | null,
): readonly unknown[] {
  return ['shopee', 'variacoes', integracaoId, categoryId];
}

/**
 * One category's tree, cached under {@link chaveVariacoesShopee}. `categoryId:
 * null` (no category picked yet) reads nothing; neither does a logged-out client
 * or `enabled: false`.
 */
export function useVariacoesShopee(
  integracaoId: string,
  categoryId: number | null,
  opcoes: { readonly enabled?: boolean } = {},
): UseQueryResult<RespostaVariacoesShopee, unknown> {
  const client = useShopeeClient();
  return useQuery({
    queryKey: chaveVariacoesShopee(integracaoId, categoryId),
    queryFn:
      client === null || categoryId === null
        ? skipToken
        : () => client.variacoes({ integracaoId, categoryId }),
    enabled: opcoes.enabled ?? true,
    staleTime: VARIACOES_SHOPEE_STALE_MS,
    retry: shopeeQueryRetry,
  });
}

/** The variation's groups that hold at least one option. Group `0` is one like any other. */
export function gruposEscolhiveisShopee(variacao: VariacaoDto): VariacaoGrupoDto[] {
  return variacao.variationGroupList.filter((grupo) => grupo.variationOptionList.length > 0);
}

/**
 * The variations an operator can bind: those with an option in some group. Empty
 * on a leaf ⇒ «não é preciso vincular», however long the list is.
 */
export function variacoesVinculaveisShopee(resposta: RespostaVariacoesShopee): VariacaoDto[] {
  return resposta.standardiseVariationList.filter(
    (variacao) => gruposEscolhiveisShopee(variacao).length > 0,
  );
}

/**
 * The group nobody has to choose: the id of the ONE option-bearing group, `0` for
 * the single-level sentinel. `null` when there is no such group: with two or more
 * the choice is REQUIRED (Shopee demands it), and with none the variation was
 * never bindable.
 */
export function grupoAutomaticoShopee(variacao: VariacaoDto): number | null {
  const [primeiro, ...resto] = gruposEscolhiveisShopee(variacao);
  return primeiro !== undefined && resto.length === 0 ? primeiro.variationGroupId : null;
}

/**
 * The options of the CHOSEN group only, names verbatim. Empty when the variation
 * has no such group, which is what a stored `0` reads on a two-level variation.
 */
export function opcoesDoGrupoShopee(
  variacao: VariacaoDto,
  grupoId: number,
): readonly VariacaoOpcaoDto[] {
  const grupo = variacao.variationGroupList.find((g) => g.variationGroupId === grupoId);
  return grupo?.variationOptionList ?? [];
}

/**
 * `«<trimmed name> (<id>)»`, `«Sem nome (<id>)»` for an absent or blank one: the
 * label of a variation, a group or an option. Display only (module header).
 */
export function rotuloShopee(nome: string | null, id: number): string {
  const legivel = nome?.trim() ?? '';
  return `${legivel === '' ? 'Sem nome' : legivel} (${String(id)})`;
}

/** The tab's sentence for a backend that cannot read the tree. */
export const MENSAGEM_VARIACOES_SHOPEE_BACKEND_DESATUALIZADO =
  'A Shopee não reconheceu a consulta de variações (HTTP 404): o backend da Shopee está desatualizado. Os vínculos guardados continuam aqui e podem ser removidos; para escolher opções novas, o backend precisa ser atualizado.';
/** The tab's sentence for a category gone from the conta's tree. */
export const MENSAGEM_VARIACOES_SHOPEE_CATEGORIA_DESCONHECIDA =
  'Esta categoria não existe mais na árvore desta conta — remova o vínculo ou recrie-o em outra categoria.';
/** What a failure that is not a Shopee client error reads as. */
export const MENSAGEM_VARIACOES_SHOPEE_GENERICA =
  'Não foi possível carregar as variações da Shopee.';

/** The `apps/shopee` code of a failure talking to Shopee (`lib/shopee/core/respond.ts`). */
const CODIGO_FALHA_NA_SHOPEE = 'SHOPEE_HTTP_ERROR';
/** SHOPEE's own literal, compared exactly. See {@link descreverFalhaVariacoesShopee}. */
const CODIGO_SHOPEE_NAO_ENCONTRADO = 'error_not_found';

/**
 * The copy for a failed tree read, plus whether a manual retry is worth offering:
 * {@link descreverFalhaShopee} for everything but two answers of this read.
 *
 * - **502 `SHOPEE_HTTP_ERROR` + `shopeeCode: 'error_not_found'`:** the backend
 *   called a path Shopee does not serve, so the same call fails until a deploy.
 *   ⚠️ `error_not_found` is Shopee's literal, not ours. It is DISPLAY-ONLY and
 *   FAILS SAFE: it decides a sentence and nothing is written either way, and any
 *   other spelling falls to the generic path. It cannot tell the gateway's 404
 *   from a business refusal under the same code (the client does not carry
 *   `upstreamStatus`), and a host that never serves the path reads alike.
 * - **`SHOPEE_CATEGORIA_DESCONHECIDA`:** this tab's sentence, not the generic
 *   «escolha outra»: a stored link has no other category to pick, only a removal.
 */
export function descreverFalhaVariacoesShopee(err: unknown): FalhaShopee {
  if (err instanceof ShopeeClientHttpError) {
    if (
      err.status === 502 &&
      err.code === CODIGO_FALHA_NA_SHOPEE &&
      err.shopeeCode === CODIGO_SHOPEE_NAO_ENCONTRADO
    ) {
      return { mensagem: MENSAGEM_VARIACOES_SHOPEE_BACKEND_DESATUALIZADO, repetivel: false };
    }
    if (err.code === CODIGO_FALHA_SHOPEE.categoriaDesconhecida) {
      return { mensagem: MENSAGEM_VARIACOES_SHOPEE_CATEGORIA_DESCONHECIDA, repetivel: false };
    }
  }
  return descreverFalhaShopee(err, { desconhecido: MENSAGEM_VARIACOES_SHOPEE_GENERICA });
}
