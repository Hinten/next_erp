/**
 * A category's size-chart TEMPLATES, named (step 18, #1526): the cursor walk
 * over `get_size_chart_list` and the bounded fan-out over
 * `get_size_chart_detail` that gives each id its name.
 *
 * Shopee's list answers ids only — names exist only on the detail — so a list
 * the operator can read costs one detail call per id. Both halves live here, in
 * one pure orchestration over a client: no Firestore, no clock, no environment.
 * The route owns the leaf gate, the context and the HTTP answer.
 *
 * ## The walk
 *
 * - Page 1 sends NO `cursor` key; every later page sends the previous
 *   `next_cursor` VERBATIM — a whitespace cursor goes back byte-identical. The
 *   cursor never crosses our HTTP boundary.
 * - Each page is read by the package's ONE reader, `lerPaginaDeTabelasDeMedidas`
 *   (three-valued continuation, `null` rows counted). Ids are deduplicated by
 *   NUMBER across pages, the first sighting keeping its position.
 * - `fim` (`next_cursor === ''`) ⇒ stop, complete.
 * - `sem-cursor` (absent / `null`) ⇒ stop; ⚠️ an absent cursor is NOT a proof of
 *   exhaustion (register 249), so the answer is `truncado` unless the FIRST
 *   page's `total_count` is known and the distinct ids reach it.
 * - `seguinte` with the very cursor just sent ⇒ stop, `truncado`, one warn — a
 *   non-advancing cursor would otherwise spend the cap on one page twice.
 * - After {@link MAX_PAGINAS_TABELAS} pages still `seguinte` ⇒ `truncado`.
 *
 * ## The fan-out
 *
 * {@link executarEmPool} at {@link LARGURA_DOS_DETALHES}, each row written at its
 * id's INDEX so Shopee's order survives the concurrency. Per id, four named
 * outcomes and nothing else (rule 6):
 * - success ⇒ `{ sizeChartId, sizeChartName, legivel: true }`;
 * - success, but the answer is about ANOTHER template — the echoed
 *   `size_chart_id` is present and differs from the one asked — ⇒ the row STAYS
 *   with `sizeChartName: null`, `legivel: false`, counted (`divergentes`) and
 *   one warn of the two ids. Labelling the listed id with another chart's name
 *   would have the operator pick X by Y's name. The echo is judged by
 *   `ecoDivergenteTabelaShopee` — the rule `projetarTabelaShopee` turns into
 *   the detail route's `id-divergente`, not a second copy of it — so the list
 *   and "Ver" cannot disagree; an ABSENT echo proves nothing either way and
 *   reads as success, exactly as there;
 * - Shopee says the id does not exist (`kind: 'other'` +
 *   {@link classificarRecusaTabelaMedidas} `tabela-inexistente`) ⇒ the row is
 *   DROPPED and counted in `removidas` — deleted in Seller Centre between the
 *   list and the detail;
 * - the detail did not parse (`ShopeeSchemaError`) ⇒ the row STAYS,
 *   `legivel: false`, `sizeChartName: null`, one warn — one malformed template
 *   never hides the others, and it is still pickable by id;
 * - anything else (a rate limit, a dead grant, a network failure, an
 *   unclassified refusal) ⇒ the abort flag goes up FIRST and the error is
 *   rethrown to the route: every remaining iteration short-circuits, so no
 *   detail STARTS after the decision (the `estoque/enviarEstoqueManual.ts`
 *   idiom).
 *
 * Worst case: 2 list calls + 100 details at width 4 ≈ 25 rounds. UNCACHED by
 * design: a template created in Seller Centre a minute ago must appear.
 */
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE,
  ShopeeApiError,
  ShopeeSchemaError,
  lerPaginaDeTabelasDeMedidas,
  type ShopeeClient,
  type ShopeeSizeChartDetail,
} from '@delfrance/integrations-shopee';
import { ecoDivergenteTabelaShopee } from '@delfrance/schemas';

import { executarEmPool } from '../core/pool';
import type { ListaTabelasMedidasDto } from './dto';
import {
  MOTIVO_RECUSA_TABELA_MEDIDAS,
  classificarRecusaTabelaMedidas,
} from './recusaTabelaMedidas';

/** `page_size` of every list call — the package's documented maximum, never a second literal. */
export const TAMANHO_DA_PAGINA_TABELAS = SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE;

/** At most this many list pages ⇒ at most 100 ids, at most 100 detail calls. */
export const MAX_PAGINAS_TABELAS = 2;

/** Detail calls in flight at once (`precos/descobertaPreco.ts`'s `LARGURA_DA_JUNCAO` precedent). */
export const LARGURA_DOS_DETALHES = 4;

/** The list route's answer minus the leaf verdict, which is the route's. */
export type ListaTabelasMedidasLida = Omit<ListaTabelasMedidasDto, 'leaf'>;

type LinhaDaLista = ListaTabelasMedidasDto['tabelas'][number];

/** The walk's result: distinct ids in Shopee's order, plus what the DTO reports about them. */
interface IdsDaCategoria {
  readonly ids: readonly number[];
  readonly totalCount: number | null;
  readonly truncado: boolean;
  readonly idsIlegiveis: number;
  readonly paginas: number;
}

/** The cursor walk (see the module docblock). */
async function lerIdsDaCategoria(
  client: ShopeeClient,
  categoryId: number,
): Promise<IdsDaCategoria> {
  const ids: number[] = [];
  const vistos = new Set<number>();
  let idsIlegiveis = 0;
  let totalCount: number | null = null;
  let paginas = 0;
  let cursor: string | undefined;

  for (;;) {
    const resposta = await client.getSizeChartList({
      categoryId,
      pageSize: TAMANHO_DA_PAGINA_TABELAS,
      // ⚠️ ABSENT on page 1 — never `cursor: undefined` (a key the guard and the
      // query builder would both have to remember to skip) and never `''`.
      ...(cursor === undefined ? {} : { cursor }),
    });
    paginas += 1;
    const pagina = lerPaginaDeTabelasDeMedidas(resposta);
    if (paginas === 1) totalCount = pagina.total;
    idsIlegiveis += pagina.linhasIlegiveis;
    for (const id of pagina.ids) {
      if (vistos.has(id)) continue;
      vistos.add(id);
      ids.push(id);
    }

    const continuacao = pagina.continuacao;
    if (continuacao.estado === 'fim') {
      return { ids, totalCount, truncado: false, idsIlegiveis, paginas };
    }
    if (continuacao.estado === 'sem-cursor') {
      const completa = totalCount !== null && ids.length >= totalCount;
      return { ids, totalCount, truncado: !completa, idsIlegiveis, paginas };
    }
    if (cursor !== undefined && continuacao.cursor === cursor) {
      // Never the cursor itself: it is Shopee's opaque text, and the count says enough.
      console.warn('[shopee/tabela-medidas] cursor não avançou — lista truncada', {
        categoryId,
        pagina: paginas,
      });
      return { ids, totalCount, truncado: true, idsIlegiveis, paginas };
    }
    if (paginas >= MAX_PAGINAS_TABELAS) {
      return { ids, totalCount, truncado: true, idsIlegiveis, paginas };
    }
    cursor = continuacao.cursor;
  }
}

/**
 * This shop's size-chart templates for ONE leaf category, each named by its
 * detail read (see the module docblock). The caller has already gated the
 * category on the leaf verdict.
 *
 * @throws whatever a list call throws, and whatever a detail call throws that is
 *   neither "not exist" nor a schema failure — the route maps it.
 */
export async function listarTabelasDaCategoria(
  ctx: { readonly client: ShopeeClient },
  categoryId: number,
): Promise<ListaTabelasMedidasLida> {
  const lidos = await lerIdsDaCategoria(ctx.client, categoryId);

  const linhas: (LinhaDaLista | null)[] = lidos.ids.map(() => null);
  let removidas = 0;
  let ilegiveis = 0;
  let divergentes = 0;
  let abortado = false;

  await executarEmPool(lidos.ids, LARGURA_DOS_DETALHES, async (sizeChartId, indice) => {
    if (abortado) return;
    let detalhe: ShopeeSizeChartDetail;
    try {
      detalhe = await ctx.client.getSizeChartDetail({ sizeChartId });
    } catch (err) {
      // `kind` FIRST: a rate limit and a dead grant are `ShopeeApiError`s too,
      // and each must abort the list rather than read as a missing template.
      if (
        err instanceof ShopeeApiError &&
        err.kind === SHOPEE_ERROR_KIND.other &&
        classificarRecusaTabelaMedidas(err) === MOTIVO_RECUSA_TABELA_MEDIDAS.tabelaInexistente
      ) {
        removidas += 1;
        return;
      }
      if (err instanceof ShopeeSchemaError) {
        linhas[indice] = { sizeChartId, sizeChartName: null, legivel: false };
        ilegiveis += 1;
        // Field PATHS only (`campos`), never the body.
        console.warn('[shopee/tabela-medidas] detalhe ilegível — listado sem nome', {
          sizeChartId,
          campos: err.campos,
        });
        return;
      }
      // ⚠️ The flag BEFORE the rethrow: the pool waits for every worker, and the
      // siblings are still pulling ids off the shared cursor while this one
      // unwinds — without it they would keep spending detail calls on an answer
      // that is already decided.
      abortado = true;
      throw err;
    }

    // The projector's own echo rule decides whether this answer is about the id
    // we asked for — never a second spelling of it here.
    const recebido = ecoDivergenteTabelaShopee(sizeChartId, detalhe);
    if (recebido !== null) {
      linhas[indice] = { sizeChartId, sizeChartName: null, legivel: false };
      divergentes += 1;
      // The two ids only — never either chart's name.
      console.warn('[shopee/tabela-medidas] detalhe de OUTRA tabela — listado sem nome', {
        sizeChartId,
        recebido,
      });
      return;
    }
    linhas[indice] = { sizeChartId, sizeChartName: detalhe.size_chart_name, legivel: true };
  });

  const tabelas = linhas.filter((linha): linha is LinhaDaLista => linha !== null);
  // Counts only — never a template name, never a cursor.
  // eslint-disable-next-line no-console -- expected on every healthy read; a warn nobody can act on is what hides the real ones
  console.info('[shopee/tabela-medidas] lista lida', {
    categoryId,
    paginas: lidos.paginas,
    ids: lidos.ids.length,
    tabelas: tabelas.length,
    truncado: lidos.truncado,
    removidas,
    ilegiveis,
    divergentes,
    idsIlegiveis: lidos.idsIlegiveis,
  });

  return {
    categoryId,
    tabelas,
    totalCount: lidos.totalCount,
    truncado: lidos.truncado,
    removidas,
    idsIlegiveis: lidos.idsIlegiveis,
  };
}
