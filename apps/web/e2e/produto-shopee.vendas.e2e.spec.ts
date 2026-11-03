import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  ACAO_STATUS_ANUNCIO,
  ESTADO_ANUNCIO_SHOPEE,
  PADRAO_ID_RASCUNHO_SHOPEE,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  campoRascunhoShopeeSchema,
  descreverFaixaShopee,
  textoNaFaixaShopee,
  type CampoRascunhoShopee,
  type CategoriaResumoDto,
  type FaixaDto,
  type RespostaAtualizarRascunhoShopee,
  type RespostaCategoriasShopee,
  type RespostaCriarRascunhoShopee,
  type RespostaDescartarRascunhoShopee,
  type RespostaLimitesDoItemShopee,
  type RespostaRecomendacaoCategoriaShopee,
} from '@delfrance/schemas';
import type { AnuncioStatusShopee, ProblemaShopee } from '../lib/shopee/wire';
import {
  SHOPEE_E2E_CATEGORIA,
  SHOPEE_E2E_ITEM_ATIVO,
  SHOPEE_E2E_SHOP_ID,
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  cleanupShopeeFixtures,
  e2ePrefix,
  seedEditorRascunhoShopee,
  seedMarcaShopee,
  seedProdutoShopeeVinculado,
  seedRascunhoProntoShopee,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the produto editor's **Shopee** tab (step 21-3,
 * #1529): the state of each EXISTING listing, read live from its
 * `produtos/<id>/prodshopee` link document, and the actions on it — the
 * native-kit ones included (the confirmed Recriar on a removed kit, and a
 * refused publish worded by its motivo and its `acao`, never by the CLI
 * sentence the server writes beside them) — and, since #1911 P10, the listing
 * DRAFT editor: a draft link edited with its own buttons (Salvar rascunho /
 * Descartar / Publicar), a new draft opened per conta by "Novo anúncio" and
 * written only on Salvar rascunho, and the second-listing confirmation. Since
 * P11 a draft with no pendência is PUBLISHED by its link alone, after a
 * confirmation, and a refusal row is routed to the produto tab that fixes it.
 *
 * The apps/shopee backend does NOT run in this suite. Every route under
 * `/api/marketplace/shopee/` is intercepted on the PATHNAME (any host the
 * build's `NEXT_PUBLIC_SHOPEE_URL` names) and RECORDED with its body: a route
 * in {@link rotasComStub} answers the body the real route builds; any other
 * is answered 404, recorded in `semStub` and never forwarded — and each test
 * asserts that list is empty. What a real pause does on Shopee is the route's
 * own suite's to prove; this proves what the browser SENDS and what it SHOWS.
 * ⚠️ The draft routes are stubbed too, so no draft document is ever written,
 * created or deleted by this suite: every test opens the seeded draft as
 * seeded. That draft has no category, so the editor reads no category bands
 * and asks apps/shopee for nothing on render — no test of ITS produto needs a
 * taxonomy stub. Two tests open a SECOND produto, whose draft has a category,
 * each stubbing its own reads through {@link instalarStubsShopee}'s per-test
 * map: the category pick (the stubbed tree — that category, its root and a
 * sibling leaf —, Shopee's suggestions for the draft's title and both leaves'
 * bands) and the publish (that category's node and bands, and its own
 * `publicar`). Every READ is recorded with its query too ({@link Leitura}),
 * so a test can say WHICH category's bands the page asked for.
 *
 * The tab lists every Shopee conta on staging (shared project), so every
 * assertion is scoped by the run-scoped `data-testid="shopee-conta-<id>"` /
 * `shopee-anuncio-<linkDocId>` / `shopee-rascunho-<linkDocId>`. Navigation is
 * TWO levels — the Shopee tab, then the conta's tab inside it — and a conta's
 * panel is lazy, so a `toHaveCount(0)` is always paired with something
 * positive proving the panel rendered.
 */

const PREFIXO_ROTAS = '/api/marketplace/shopee/';

/** The pause run's per-listing sentence this spec answers with — rendered verbatim. */
const MENSAGEM_PAUSA_STUB = 'Anúncio pausado na Shopee (resposta do e2e).';

/** CLI copy — a flag, a `<verbo>:anuncio` script name or the word "comando" — never reaches the page. */
const TEXTO_DE_TERMINAL = /(^|\s)--[a-z]|:anuncio|comando/i;

/*
 * The draft editor's copy (#1911 P10), spelled here as the rest of this spec
 * spells the tab's copy: its source, `lib/shopee/anuncioProduto.ts`, imports the
 * browser's Shopee client (and through it the auth hook), which a Node spec
 * must not load. Each names the constant it mirrors.
 */

/** `FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE` — the `marca-nao-escolhida` pendência. */
const PENDENCIA_MARCA = 'Escolha a marca deste rascunho (ou «Sem marca») antes de publicar.';
/** `FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE` — the `categoria-ausente` pendência. */
const PENDENCIA_CATEGORIA = 'Escolha a categoria (uma categoria final da árvore da Shopee).';
/** `FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE`'s opening — the `sem-descricao` pendência. */
const PENDENCIA_SEM_DESCRICAO = /O anúncio não tem descrição/;
/** `FRASE_RASCUNHO_NOVO_SHOPEE` — a draft opened here and not saved yet. */
const FRASE_RASCUNHO_NOVO = 'Novo rascunho (ainda não salvo).';
/** `TITULO_SEGUNDO_ANUNCIO_SHOPEE` — the second-listing confirmation's title. */
const TITULO_SEGUNDO_ANUNCIO = 'Criar outro anúncio nesta conta?';
/** `ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE` — its confirming button. */
const ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO = 'Criar rascunho mesmo assim';
/** `FRASE_CONFIRMAR_DESCARTE_SHOPEE` — the discard confirmation of a saved draft. */
const FRASE_CONFIRMAR_DESCARTE = 'O rascunho será excluído. Nada foi publicado na Shopee.';
/** `FRASE_RASCUNHO_CRIADO_SHOPEE` / `…_SALVO_…` / `…_DESCARTADO_…` — the three 2xx toasts. */
const TOAST_RASCUNHO_CRIADO = 'Rascunho criado.';
const TOAST_RASCUNHO_SALVO = 'Rascunho salvo.';
const TOAST_RASCUNHO_DESCARTADO = 'Rascunho descartado.';
/** `ROTULO_SEM_MARCA_SHOPEE` (`MarcaRascunhoShopee.tsx`) — the picker's own «Sem marca» option. */
const ROTULO_SEM_MARCA = 'Sem marca (No Brand)';

/**
 * The ONE brand seeded on conta 1's shortlist (`integracao/{id}/brandshopee`,
 * #1911 P9) by `seedMarcaShopee`, through the Marcas section's own writer rule
 * — a fixture id, never a real Shopee brand. Its two names DIFFER on purpose:
 * the draft's picker labels a row by its display name, while the draft stores
 * (and publish sends) its ORIGINAL name, so a body carrying the label is a
 * drift this spec sees.
 */
const MARCA_DA_CONTA = {
  brandId: 9_200_001,
  originalBrandName: 'E2E Brand',
  displayBrandName: 'Marca do e2e',
} as const;

/**
 * The sentence a draft link showed BEFORE the editor existed (P10 removed it
 * with its constant). Asserted absent: the draft block is the editor now.
 */
const FRASE_PRIMEIRA_PUBLICACAO_REMOVIDA =
  'Primeira publicação: chega na etapa de autoria do anúncio.';

/*
 * The «Publicar» copy of a draft (#1911 P11), spelled for the same reason, from
 * `lib/shopee/anuncioProduto.ts` (and the produto section from
 * `produtos/_components/produtoFields.ts`).
 */

/** `ROTULO_PUBLICAR_RASCUNHO_SHOPEE` — a draft's «Publicar», and its confirmation's confirm. */
const ROTULO_PUBLICAR = 'Publicar';
/** `FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE` — why a draft not saved yet cannot be published. */
const FRASE_PUBLICAR_RASCUNHO_NOVO = 'Salve o rascunho antes de publicar.';
/** `TITULO_PUBLICAR_RASCUNHO_SHOPEE` — the Publicar confirmation's title. */
const TITULO_PUBLICAR = 'Publicar na Shopee';
/** `ROTULO_CRIAR_PAUSADO_SHOPEE` — the confirmation's «Criar pausado» checkbox. */
const ROTULO_CRIAR_PAUSADO = 'Criar pausado (o anúncio só aparece na loja depois de reativado)';
/** `textoDaConfirmacaoDePublicacaoShopee`'s opening — it names the conta the listing goes to. */
function aberturaDaConfirmacao(contaNome: string): string {
  return `O anúncio será criado na conta «${contaNome}»`;
}
/**
 * The test id of the Publicar confirmation's D15 second-listing warning
 * (`RascunhoShopee.tsx`). By test id, never by its copy: the warning has three
 * wordings since the #1911 P11 review (`textoDoSegundoAnuncioNaPublicacaoShopee`
 * — an adoption, a create beside drafts only, «cria OUTRO»), and a count-0 on
 * one of them would pass over the other two.
 */
function idDoAvisoDeSegundoAnuncio(linkDocId: string): string {
  return `shopee-rascunho-publicar-${linkDocId}-segundo-anuncio`;
}
/** `ROTULO_PUBLICAR_SEGUNDO_ANUNCIO_SHOPEE` — the confirm of a Publicar under the D15 warning. */
const ROTULO_PUBLICAR_SEGUNDO_ANUNCIO = 'Publicar mesmo assim';
/** `FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE` — why a draft with unsaved changes cannot be published. */
const FRASE_PUBLICAR_COM_ALTERACOES = 'Salve as alterações antes de publicar.';
/** `TITULO_ANUNCIO_INCERTO_SHOPEE` — the uncertain create's title, never a definite refusal's. */
const TITULO_ANUNCIO_INCERTO = 'A Shopee pode ter criado o anúncio';
/**
 * `TITULO_PUBLICACAO_BLOQUEADA_SHOPEE` (`DesfechoAcaoShopee.tsx`) — the title
 * of OUR 422, on a live listing's Republicar (test 5) and a draft's first
 * publish alike. Since the #1911 P11 review it says only WHO refused: on an
 * update the model leg can refuse after `update_item`, so the title never
 * claims «nada foi enviado à Shopee». Asserted `exact`, so a title that
 * grows that claim back does not match.
 */
const TITULO_PUBLICACAO_BLOQUEADA = 'Publicação bloqueada pelo ERP';
/** The produto tab holding `pesoBrutoKg` (`produtoFields.ts`) — where a `weight` refusal is fixed. */
const SECAO_DO_PESO = 'Dimensões e peso';
/** `rotuloDaSuperficieShopee` for a produto surface in {@link SECAO_DO_PESO}. */
const ROTULO_ABRIR_SECAO_DO_PESO = `Abrir no produto: ${SECAO_DO_PESO}`;
/** The `sem-peso` row's sentence, as `montagemAnuncio.ts` builds it (no CLI text: shown verbatim). */
const MENSAGEM_SEM_PESO = 'o produto não tem peso bruto nem líquido utilizável';

/*
 * The draft's Categoria picker (#1911 P10, `CategoriaRascunhoShopee.tsx`, and
 * the tree browser it opens, `components/shopee/ShopeeCategoriaBrowser.tsx`),
 * spelled for the same reason. The three button labels are written inline
 * there, with no constant of their own.
 */

/** `TITULO_ESCOLHA_CATEGORIA_SHOPEE` — the picker modal's title. */
const TITULO_ESCOLHA_CATEGORIA = 'Categoria na Shopee';
/** The label's button once a category is held (`valida`); «Escolher categoria» otherwise. */
const ROTULO_TROCAR_CATEGORIA = 'Trocar categoria';
/** A LEAF suggestion's button (`SugestoesDaCategoria`). */
const ROTULO_USAR_SUGESTAO = 'Usar esta';
/** A LEAF row's button in the tree browser. */
const ROTULO_ESCOLHER_FOLHA = 'Escolher';
/** `FRASE_SUGESTAO_NAO_FOLHA_SHOPEE` — a suggestion that is not a leaf, offered with no button. */
const FRASE_SUGESTAO_NAO_FOLHA = 'Não é uma categoria final';

/**
 * A category's label as the draft's Categoria shows it: the path from the
 * root, each step by `rotuloCategoriaShopee` (display name first), joined by
 * « › ».
 */
function caminhoDaCategoria(caminho: readonly CategoriaResumoDto[]): string {
  return caminho
    .map((c) => c.name ?? c.originalName ?? `Categoria ${String(c.categoryId)}`)
    .join(' › ');
}

/**
 * The `titulo-fora-da-faixa` pendência — `fraseDoTextoForaDaFaixaShopee('titulo', …)`
 * (`lib/shopee/anuncioProduto.ts`), with the band described by the schemas' own
 * `descreverFaixaShopee`.
 */
function pendenciaDoTituloForaDaFaixa(comprimento: number, faixa: FaixaDto): string {
  return (
    `O título tem ${String(comprimento)} caracteres; esta categoria aceita ` +
    `${descreverFaixaShopee(faixa)}.`
  );
}

type Resposta = { readonly status: number; readonly corpo: unknown };

/**
 * The answer a stubbed route gives one call — from its parsed body (POSTs) or
 * its URL (the GETs' query) — or `null`: the call is then treated exactly as
 * an unstubbed route's (answered 404 and recorded in `semStub`), so a stub
 * that answers one category, or one link, refuses every other.
 */
type Stub = (corpo: Record<string, unknown> | null, url: URL) => Resposta | null;

/** One recorded request to the apps/shopee backend. */
interface Chamada {
  readonly metodo: string;
  readonly rota: string;
  readonly corpo: Record<string, unknown> | null;
}

/**
 * One recorded READ (a GET) — its route and its query, decoded. A GET carries
 * no body, so {@link Chamada} alone cannot say which category's node or bands
 * the page asked for.
 */
interface Leitura {
  readonly rota: string;
  readonly parametros: Readonly<Record<string, string>>;
}

/** One read as `rota?chave=valor&…`, its keys sorted — what {@link leiturasDistintas} compares. */
function leitura(rota: string, parametros: Readonly<Record<string, string>>): string {
  const consulta = Object.keys(parametros)
    .sort()
    .map((chave) => `${chave}=${parametros[chave] ?? ''}`)
    .join('&');
  return `${rota}?${consulta}`;
}

/** A request body, parsed — or a marker the body assertion will print. */
function corpoDaChamada(corpo: string | null): Record<string, unknown> | null {
  if (corpo === null) return null;
  try {
    return JSON.parse(corpo) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) return { corpoNaoJson: corpo };
    throw err;
  }
}

/** A string member of a request body, or `''` (which no assertion of this spec expects). */
function textoDoCorpo(corpo: Record<string, unknown> | null, chave: string): string {
  const valor = corpo?.[chave];
  return typeof valor === 'string' ? valor : '';
}

/**
 * The pause/reactivate run's 200 for the ONE listing the request named — the
 * key set `anuncio-status/route.ts` builds by name, typed by the browser's own
 * wire schema so the stub cannot drift from what the tab parses.
 */
function respostaDoStatus(corpo: Record<string, unknown> | null): AnuncioStatusShopee {
  const produtoIds = Array.isArray(corpo?.produtoIds) ? corpo.produtoIds : [];
  const reativar = corpo?.acao === ACAO_STATUS_ANUNCIO.reativar;
  return {
    canal: 'shopee',
    integracaoId: typeof corpo?.integracaoId === 'string' ? corpo.integracaoId : '',
    acao: reativar ? ACAO_STATUS_ANUNCIO.reativar : ACAO_STATUS_ANUNCIO.pausar,
    listings: [
      {
        produtoId: typeof produtoIds[0] === 'string' ? produtoIds[0] : '',
        produtoNome: null,
        anuncioId: String(SHOPEE_E2E_ITEM_ATIVO),
        linkDocId: typeof corpo?.linkDocId === 'string' ? corpo.linkDocId : null,
        outcome: 'enviado',
        motivo: null,
        mensagem: MENSAGEM_PAUSA_STUB,
        statusFinal: reativar ? 'NORMAL' : 'UNLIST',
        estadoAnuncio: reativar ? ESTADO_ANUNCIO_SHOPEE.ativo : ESTADO_ANUNCIO_SHOPEE.pausado,
      },
    ],
    produtosSemAnuncio: [],
    pausadoAte: null,
  };
}

/**
 * The publish route's 422 for a refusal decided BEFORE any Shopee write — the
 * keys `core/respond.ts`'s blocked arm builds by name. Two rows, each worded for
 * the CLI as the server words them: a removed native kit whose next step is a
 * structured `acao` (recriar, on the link it names), and an `instabilidade-shopee`
 * with no `acao`, which the tab words by its MOTIVO.
 */
function recusaDaPublicacao(
  corpo: Record<string, unknown> | null,
  kitRemovido: string,
): Record<string, unknown> {
  const produtoId = typeof corpo?.produtoId === 'string' ? corpo.produtoId : '';
  const problemas: ProblemaShopee[] = [
    {
      campo: 'linkDocId',
      motivo: 'listagem-removida',
      mensagem:
        `o kit do vínculo ${kitRemovido} foi removido na Shopee — publique com --link ` +
        `${kitRemovido} --recriar (publicar:anuncio)`,
      acao: { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar, linkDocId: kitRemovido },
    },
    {
      campo: null,
      motivo: 'instabilidade-shopee',
      mensagem:
        'a Shopee respondeu com instabilidade; a operação pode ter sido feita — rode ' +
        'exatamente o mesmo comando de novo daqui a 4 minutos',
      acao: null,
    },
  ];
  return {
    error: `Publicação bloqueada no produto ${produtoId}: ${String(problemas.length)} problema(s)`,
    code: 'SHOPEE_PUBLISH_BLOCKED',
    motivo: 'listagem-removida',
    produtoId,
    itemId: SHOPEE_E2E_ITEM_ATIVO,
    problemas,
  };
}

/**
 * The draft create's 201 — `{linkDocId, criado: true}`, the answer of the
 * draft route for a draft it created — typed by the shared answer schema's
 * type, so the stub cannot drift from what the tab parses.
 */
function respostaDoRascunhoCriado(
  corpo: Record<string, unknown> | null,
): RespostaCriarRascunhoShopee {
  return { linkDocId: textoDoCorpo(corpo, 'linkDocId'), criado: true };
}

/**
 * The draft edit's 200 — the fields it WROTE: here, every field the request's
 * `patch` named (the stub stores nothing, and nothing differs from a stub).
 * Read through the shared campo schema, so an unknown key is never echoed.
 */
function respostaDoRascunhoAtualizado(
  corpo: Record<string, unknown> | null,
): RespostaAtualizarRascunhoShopee {
  const patch = corpo?.patch;
  const gravados: CampoRascunhoShopee[] =
    typeof patch === 'object' && patch !== null
      ? Object.keys(patch).flatMap((chave) => {
          const lido = campoRascunhoShopeeSchema.safeParse(chave);
          return lido.success ? [lido.data] : [];
        })
      : [];
  return { linkDocId: textoDoCorpo(corpo, 'linkDocId'), gravados };
}

/** The draft discard's 200 for a draft with no uncertain create behind it. */
function respostaDoRascunhoDescartado(
  corpo: Record<string, unknown> | null,
): RespostaDescartarRascunhoShopee {
  return { linkDocId: textoDoCorpo(corpo, 'linkDocId'), descartado: true, criacaoIncerta: false };
}

/*
 * The stubbed category tree (#1911 P11): ONE root holding two leaves — the
 * ready draft's category ({@link SHOPEE_E2E_CATEGORIA}) and a sibling. Fixture
 * ids, never real ones; no other id is answered.
 */

/** The root — the parent of both leaves. */
const CATEGORIA_RAIZ_E2E = 100001;
/** The ready draft's SIBLING leaf — what the category-pick test picks. */
const CATEGORIA_IRMA_E2E = 100088;

const RAIZ_E2E: CategoriaResumoDto = {
  categoryId: CATEGORIA_RAIZ_E2E,
  name: 'Raiz do e2e',
  originalName: 'E2E root',
  isLeaf: false,
};
const FOLHA_DO_RASCUNHO_PRONTO: CategoriaResumoDto = {
  categoryId: SHOPEE_E2E_CATEGORIA,
  name: 'Categoria do e2e',
  originalName: 'E2E category',
  isLeaf: true,
};
const FOLHA_IRMA_E2E: CategoriaResumoDto = {
  categoryId: CATEGORIA_IRMA_E2E,
  name: 'Outra categoria do e2e',
  originalName: 'Other E2E category',
  isLeaf: true,
};

/**
 * `taxonomia/categorias?categoryId=` for ONE node of the stubbed tree — a leaf
 * with its path from the root (what the draft's category label reads), or the
 * root with both leaves as its children (the level the picker's browser lists
 * around a held leaf) — typed by the shared answer type; `null` for an id the
 * tree does not hold (the stub then refuses the call into `semStub`).
 */
function noDaArvoreE2e(categoryId: number): RespostaCategoriasShopee | null {
  const folha = [FOLHA_DO_RASCUNHO_PRONTO, FOLHA_IRMA_E2E].find((f) => f.categoryId === categoryId);
  if (folha !== undefined) {
    return {
      raizes: null,
      no: { ...folha, parentId: CATEGORIA_RAIZ_E2E, pathFromRoot: [RAIZ_E2E, folha], children: [] },
    };
  }
  if (categoryId !== CATEGORIA_RAIZ_E2E) return null;
  return {
    raizes: null,
    no: {
      ...RAIZ_E2E,
      parentId: 0,
      pathFromRoot: [RAIZ_E2E],
      children: [FOLHA_DO_RASCUNHO_PRONTO, FOLHA_IRMA_E2E],
    },
  };
}

/** The ready draft's category's title band — wide enough for its run-scoped title. */
const FAIXA_DO_TITULO_DO_RASCUNHO_PRONTO: FaixaDto = { min: 1, max: 120 };
/**
 * The SIBLING's title band — narrower than any run-scoped title (`e2ePrefix`
 * alone is longer), so the same title the ready draft's category accepts is
 * outside it: the near-miss that shows the picked category's bands are the
 * ones applied.
 */
const FAIXA_DO_TITULO_DA_IRMA: FaixaDto = { min: 1, max: 20 };

/**
 * `taxonomia/limites?categoryId=` for a leaf of the stubbed tree — the WHOLE
 * envelope, typed by the shared answer type. Only the two bands the draft's
 * pendências measure are set: the title's (per leaf) and a description band
 * wide enough for the produto's stored Descrição; every other band is "Shopee
 * did not say" (`null`).
 */
function limitesDaFolhaE2e(
  categoryId: number,
  itemNameLengthLimit: FaixaDto,
): RespostaLimitesDoItemShopee {
  return {
    scope: 'category',
    categoryId,
    limites: {
      priceLimit: null,
      wholesalePriceThresholdPercentage: null,
      stockLimit: null,
      itemNameLengthLimit,
      itemImageCountLimit: null,
      itemDescriptionLengthLimit: { min: 1, max: 5000 },
      tierVariationNameLengthLimit: null,
      tierVariationOptionLengthLimit: null,
      itemCountLimit: null,
      extendedDescriptionLimit: null,
      dtsLimit: null,
      weightLimit: null,
      dimensionLimit: null,
      sizeChartLimit: null,
    },
    gtinLimit: null,
    supportsPreOrder: false,
  };
}

/**
 * The publish route's 422 for the ready draft: blocked BEFORE any Shopee write
 * on the produto's missing weight — the row `montagemAnuncio.ts` builds
 * (campo `weight`, motivo `sem-peso`, no `acao`), with the keys
 * `core/respond.ts`'s blocked arm sends; `itemId: null` (a first publish names
 * no listing). ⚠️ ONE row on purpose (design-DC-web §3): the real answer is the
 * UNION of every refusal the assembly finds, and this produto would also carry
 * `sem-dimensoes`, `sem-fotos` and `sem-preco` (`seedRascunhoProntoShopee`).
 * `sem-peso` is that answer's FIRST row, so assert row `-0`, never the row
 * count nor the header's total.
 */
function recusaSemPeso(corpo: Record<string, unknown> | null): Record<string, unknown> {
  const produtoId = textoDoCorpo(corpo, 'produtoId');
  const problemas: ProblemaShopee[] = [
    { campo: 'weight', motivo: 'sem-peso', mensagem: MENSAGEM_SEM_PESO, acao: null },
  ];
  return {
    error: `Publicação bloqueada (sem-peso) no produto ${produtoId}: 1 problema`,
    code: 'SHOPEE_PUBLISH_BLOCKED',
    motivo: 'sem-peso',
    produtoId,
    itemId: null,
    problemas,
  };
}

/**
 * The per-test stubs of the publish case (rev. 2a §D P11 #11): the ready
 * draft's category node and bands — answered for THAT conta and category only —
 * and its publish, answered for THAT link only. Any other read or publish
 * falls to `semStub`.
 */
function rotasDoRascunhoPronto(conta: string, rascunho: string): ReadonlyMap<string, Stub> {
  const daCategoria = (url: URL): boolean =>
    url.searchParams.get('integracaoId') === conta &&
    url.searchParams.get('categoryId') === String(SHOPEE_E2E_CATEGORIA);
  return new Map<string, Stub>([
    [
      'taxonomia/categorias',
      (_corpo, url) =>
        daCategoria(url) ? { status: 200, corpo: noDaArvoreE2e(SHOPEE_E2E_CATEGORIA) } : null,
    ],
    [
      'taxonomia/limites',
      (_corpo, url) =>
        daCategoria(url)
          ? {
              status: 200,
              corpo: limitesDaFolhaE2e(SHOPEE_E2E_CATEGORIA, FAIXA_DO_TITULO_DO_RASCUNHO_PRONTO),
            }
          : null,
    ],
    [
      'publicar',
      (corpo) =>
        textoDoCorpo(corpo, 'linkDocId') === rascunho
          ? { status: 422, corpo: recusaSemPeso(corpo) }
          : null,
    ],
  ]);
}

/**
 * `taxonomia/recomendacao-categoria` for the ready draft's title — Shopee's
 * suggestions resolved against the stubbed tree, typed by the shared answer
 * type: the SIBLING leaf (pickable) and the root (not a leaf: offered with no
 * button). `applied: false`, the route's contract.
 */
function recomendacaoDoRascunhoPronto(): RespostaRecomendacaoCategoriaShopee {
  return {
    recomendacoes: [
      {
        position: 1,
        categoryId: CATEGORIA_IRMA_E2E,
        name: FOLHA_IRMA_E2E.name,
        isLeaf: true,
        pathFromRoot: [RAIZ_E2E, FOLHA_IRMA_E2E],
      },
      {
        position: 2,
        categoryId: CATEGORIA_RAIZ_E2E,
        name: RAIZ_E2E.name,
        isLeaf: false,
        pathFromRoot: [RAIZ_E2E],
      },
    ],
    unresolved: 0,
    applied: false,
  };
}

/**
 * The per-test stubs of the category pick (#1911 P11, the follow-up of review
 * R5-e2e#2): the stubbed tree's nodes and both leaves' bands — for THAT conta
 * and those ids only — and Shopee's suggestions for THAT conta and title. No
 * `publicar` of its own: the global one answers, and the test asserts it was
 * never called. Any other read (the roots, a shop-wide band) falls to `semStub`.
 */
function rotasDaEscolhaDeCategoria(conta: string, titulo: string): ReadonlyMap<string, Stub> {
  const daConta = (url: URL): boolean => url.searchParams.get('integracaoId') === conta;
  const idPedido = (url: URL): number | null => {
    const bruto = url.searchParams.get('categoryId');
    return bruto === null ? null : Number(bruto);
  };
  const faixaDoTitulo = new Map<number, FaixaDto>([
    [SHOPEE_E2E_CATEGORIA, FAIXA_DO_TITULO_DO_RASCUNHO_PRONTO],
    [CATEGORIA_IRMA_E2E, FAIXA_DO_TITULO_DA_IRMA],
  ]);
  return new Map<string, Stub>([
    [
      'taxonomia/categorias',
      (_corpo, url) => {
        const id = idPedido(url);
        const no = daConta(url) && id !== null ? noDaArvoreE2e(id) : null;
        return no === null ? null : { status: 200, corpo: no };
      },
    ],
    [
      'taxonomia/limites',
      (_corpo, url) => {
        const id = idPedido(url);
        const faixa = daConta(url) && id !== null ? faixaDoTitulo.get(id) : undefined;
        return faixa === undefined || id === null
          ? null
          : { status: 200, corpo: limitesDaFolhaE2e(id, faixa) };
      },
    ],
    [
      'taxonomia/recomendacao-categoria',
      (_corpo, url) =>
        daConta(url) && url.searchParams.get('nome') === titulo
          ? { status: 200, corpo: recomendacaoDoRascunhoPronto() }
          : null,
    ],
  ]);
}

/** The apps/shopee routes this spec answers, by path under {@link PREFIXO_ROTAS}. */
function rotasComStub(kitRemovido: string): ReadonlyMap<string, Stub> {
  return new Map<string, Stub>([
    ['anuncio-status', (corpo) => ({ status: 200, corpo: respostaDoStatus(corpo) })],
    ['publicar', (corpo) => ({ status: 422, corpo: recusaDaPublicacao(corpo, kitRemovido) })],
    // The three draft routes (#1911 P10). Answered 2xx and writing NOTHING, so
    // the seeded draft stays exactly as seeded for every later test.
    ['rascunho', (corpo) => ({ status: 201, corpo: respostaDoRascunhoCriado(corpo) })],
    [
      'rascunho/atualizar',
      (corpo) => ({ status: 200, corpo: respostaDoRascunhoAtualizado(corpo) }),
    ],
    [
      'rascunho/descartar',
      (corpo) => ({ status: 200, corpo: respostaDoRascunhoDescartado(corpo) }),
    ],
  ]);
}

interface StubsShopee {
  /**
   * Every Shopee backend call the page made, in order. A test whose page must
   * send nothing asserts it EMPTY, never `semStub` alone: every stubbed route
   * answers 2xx — the three draft writes, a pause, a publish — so a stray
   * call to one of them never reaches `semStub`.
   */
  readonly chamadas: Chamada[];
  /** Every GET of {@link chamadas} again, with its query (in order; a repeat is recorded again). */
  readonly leituras: Leitura[];
  /** Calls to a Shopee route this spec does not stub (answered 404, never forwarded). */
  readonly semStub: string[];
}

/**
 * Intercept every apps/shopee route. MUST run BEFORE `page.goto`. Playwright
 * answers the CORS preflight itself (the backend is cross-origin), so only the
 * real requests land here. A route registered AFTER this one takes precedence
 * (Playwright tries the newest handler first) — how test 6 cuts one route off.
 * `porTeste` adds or REPLACES stubs by path for one test (the category pick's
 * and the publish case's taxonomy reads, and the latter's own publish); every
 * call is still recorded.
 */
async function instalarStubsShopee(
  page: Page,
  kitRemovido: string,
  porTeste: ReadonlyMap<string, Stub> = new Map(),
): Promise<StubsShopee> {
  const stubs: StubsShopee = { chamadas: [], leituras: [], semStub: [] };
  const rotas = new Map([...rotasComStub(kitRemovido), ...porTeste]);
  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route) => {
      const pedido = route.request();
      const url = new URL(pedido.url());
      const rota = url.pathname.slice(PREFIXO_ROTAS.length);
      const corpo = corpoDaChamada(pedido.postData());
      stubs.chamadas.push({ metodo: pedido.method(), rota, corpo });
      if (pedido.method() === 'GET') {
        stubs.leituras.push({ rota, parametros: Object.fromEntries(url.searchParams) });
      }
      let resposta = rotas.get(rota)?.(corpo, url) ?? null;
      if (resposta === null) {
        stubs.semStub.push(`${pedido.method()} ${url.pathname}`);
        resposta = {
          status: 404,
          corpo: { error: 'Rota da Shopee sem stub neste e2e.', code: 'E2E_SEM_STUB' },
        };
      }
      await route.fulfill({
        status: resposta.status,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(resposta.corpo),
      });
    },
  );
  return stubs;
}

/** The recorded WRITES — the POSTs; the GETs are reads (here, the taxonomy). */
function escritas(stubs: StubsShopee): Chamada[] {
  return stubs.chamadas.filter((c) => c.metodo === 'POST');
}

/**
 * The DISTINCT reads so far, each as {@link leitura} spells it, sorted — an
 * order-free set: the page's queries run in parallel, and a repeat answered
 * from the same cache entry is not what a test here is about.
 */
function leiturasDistintas(stubs: StubsShopee): string[] {
  return [...new Set(stubs.leituras.map((l) => leitura(l.rota, l.parametros)))].sort();
}

/** The prefix of a draft editor's root test id; the rest is the draft's link doc id. */
const RAIZ_DO_RASCUNHO = 'shopee-rascunho-';

/**
 * The link doc id of the ONE draft editor in `painel` holding a "Salvar
 * rascunho" button — read off its root's test id. Its two pickers carry test
 * ids under the same prefix, but neither holds that button, so only the root
 * matches.
 */
async function idDoUnicoRascunho(painel: Locator): Promise<string> {
  const raiz = painel.locator(`[data-testid^="${RAIZ_DO_RASCUNHO}"]`).filter({
    has: painel.page().getByRole('button', { name: 'Salvar rascunho', exact: true }),
  });
  const testId = (await raiz.getAttribute('data-testid')) ?? '';
  return testId.slice(RAIZ_DO_RASCUNHO.length);
}

test.describe.serial('Produto Shopee tab e2e — listing state, actions and the native kit', () => {
  const prefix = e2ePrefix('shpaba');
  const conta = `${prefix}-001`;
  /** The second conta: it holds ONE removed listing of the produto and nothing else. */
  const contaSoRemovido = `${prefix}-002`;
  // Deterministic (mirrors `seedProdutoShopeeVinculado`) so afterAll can always
  // sweep the link SUBCOLLECTION even when beforeAll dies mid-way: the
  // nome-prefix sweep only reaches the parent doc, and Firestore never cascades.
  const produtoId = `${prefix}-prod`;
  const links = {
    ativo: `${prefix}-ativo`,
    kitRemovido: `${prefix}-kit-removido`,
    rascunho: `${prefix}-rascunho`,
    // Mirrors `seedEditorRascunhoShopee` — on `contaSoRemovido`.
    removido: `${prefix}-removido`,
  };
  /** The seeded draft's stored title — every edit's baseline. */
  const tituloGuardado = `${prefix}-rascunho`;
  /**
   * The SECOND produto and its one draft READY to publish on `conta` — mirrors
   * `seedRascunhoProntoShopee`. Only the category-pick and publish tests open
   * it, each with its own taxonomy stubs, so its category's reads reach no
   * other test.
   */
  const pronto = { produtoId: `${prefix}-pronto`, rascunho: `${prefix}-pronto-rascunho` };
  /** The ready draft's stored title (mirrors the seed) — the suggestions' `nome`, and every band's measure. */
  const tituloPronto = `${prefix}-pronto`;

  test.beforeAll(async ({ browser }) => {
    // Compiling cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      // The link seed stamps the conta's `shop_id`, so the contas come first.
      seedShopeeFixtures(prefix, 2)
        .then(() => seedProdutoShopeeVinculado(prefix, conta))
        .then(() => seedEditorRascunhoShopee(prefix, contaSoRemovido))
        .then(() => seedRascunhoProntoShopee(prefix, conta)),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
    // Once the conta exists: `cleanupShopeeFixtures` reaches a shortlist row
    // only through its conta.
    await seedMarcaShopee(conta, MARCA_DA_CONTA);
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(produtoId, 'prodshopee');
    await cleanupProdutoSubcollection(produtoId, 'extraData');
    await cleanupProdutoSubcollection(pronto.produtoId, 'prodshopee');
    await cleanupProdutoSubcollection(pronto.produtoId, 'extraData');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupShopeeFixtures(prefix);
  });

  /**
   * Open the Shopee tab, then the conta's tab inside it, and return its panel.
   *
   * The conta tab's accessible name holds the integração's `nome`, which
   * `seedIntegracaoFixtures` sets equal to its doc id, plus a badge — so it is
   * matched by substring. The produto tab is matched EXACTLY: a conta tab's
   * name could contain "Shopee" too.
   */
  async function abrirConta(page: Page, contaId: string): Promise<Locator> {
    await page.getByRole('tab', { name: 'Shopee', exact: true }).click({ timeout: 30_000 });
    await page.getByRole('tab', { name: contaId }).click({ timeout: 30_000 });
    const painel = page.getByTestId(`shopee-conta-${contaId}`);
    await expect(painel).toBeVisible({ timeout: 30_000 });
    return painel;
  }

  test("shows each listing's state from its link document", async ({ page }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await expect(ativo.getByText('Ativo', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(ativo.getByText('Rebaixado na busca')).toBeVisible();
    await expect(
      ativo.getByText('A foto principal semeada pelo e2e está desfocada.'),
    ).toBeVisible();
    await expect(ativo.getByText(/Recusa de preço semeada pelo e2e\./)).toBeVisible();
    await expect(ativo.getByRole('link', { name: 'Ver na Shopee' })).toHaveAttribute(
      'href',
      `https://shopee.com.br/product/${String(SHOPEE_E2E_SHOP_ID)}/${String(SHOPEE_E2E_ITEM_ATIVO)}`,
    );

    const removido = painel.getByTestId(`shopee-anuncio-${links.kitRemovido}`);
    await expect(removido.getByText('Removido', { exact: true })).toBeVisible();

    // A draft names no listing: no storefront link — asserted only after the
    // positive "Não publicado" proves the block rendered.
    const rascunho = painel.getByTestId(`shopee-anuncio-${links.rascunho}`);
    await expect(rascunho.getByText('Não publicado', { exact: true })).toBeVisible();
    await expect(rascunho.getByRole('link', { name: 'Ver na Shopee' })).toHaveCount(0);

    // Live first, then the removed kit, then the draft.
    const ordem = await painel
      .locator('[data-testid^="shopee-anuncio-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(ordem).toEqual([
      `shopee-anuncio-${links.ativo}`,
      `shopee-anuncio-${links.kitRemovido}`,
      `shopee-anuncio-${links.rascunho}`,
    ]);

    // Showing the state sends nothing — no draft write, no pause, no publish.
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('pauses one listing by its link, after a confirmation', async ({ page }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await ativo.getByRole('button', { name: 'Pausar anúncio' }).click({ timeout: 30_000 });
    const dialogo = page.getByRole('dialog', { name: 'Pausar anúncio' });
    await expect(dialogo).toBeVisible();
    // Nothing leaves the browser before the operator confirms.
    expect(stubs.chamadas).toEqual([]);
    await dialogo.getByRole('button', { name: 'Pausar', exact: true }).click();

    // The run's own per-listing sentence, in THIS listing's block.
    await expect(ativo.getByText(MENSAGEM_PAUSA_STUB)).toBeVisible({ timeout: 30_000 });
    expect(stubs.chamadas).toEqual([
      {
        metodo: 'POST',
        rota: 'anuncio-status',
        corpo: {
          integracaoId: conta,
          produtoIds: [produtoId],
          acao: ACAO_STATUS_ANUNCIO.pausar,
          linkDocId: links.ativo,
        },
      },
    ]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('edits a draft link with its own buttons and pendências, and keeps its Publicar disabled while they stand', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the live listing offers its republish, so the action
    // rows rendered for this operator.
    await expect(
      painel
        .getByTestId(`shopee-anuncio-${links.ativo}`)
        .getByRole('button', { name: 'Republicar', exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    // The draft block IS the editor now, with its own buttons; nothing differs
    // from what is stored yet, so there is nothing to save.
    const rascunho = painel.getByTestId(`shopee-anuncio-${links.rascunho}`);
    const editor = rascunho.getByTestId(`${RAIZ_DO_RASCUNHO}${links.rascunho}`);
    await expect(editor.getByRole('button', { name: 'Descartar', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const salvar = editor.getByRole('button', { name: 'Salvar rascunho', exact: true });
    await expect(salvar).toBeVisible();
    await expect(salvar).toBeDisabled();
    await expect(rascunho.getByText(FRASE_PRIMEIRA_PUBLICACAO_REMOVIDA)).toHaveCount(0);

    // The seeded draft has neither a category nor a brand: both pendências,
    // in every test that opens this conta.
    await expect(editor.getByText(PENDENCIA_CATEGORIA).first()).toBeVisible();
    await expect(editor.getByText(PENDENCIA_MARCA).first()).toBeVisible();
    // Its description is empty, but the produto's STORED Descrição stands in
    // for it — the document the publish reads — so no `sem-descricao`.
    await expect(editor.getByText(PENDENCIA_SEM_DESCRICAO)).toHaveCount(0);

    // The draft block offers its first publish now (#1911 P11 inverted P10's
    // count-0 pin on purpose): ONE «Publicar», disabled while a pendência
    // stands — the publish would refuse it. Its gate also asks apps/shopee
    // nothing for a draft with no category (the `chamadas` below).
    const publicar = editor.getByRole('button', { name: ROTULO_PUBLICAR, exact: true });
    await expect(publicar).toBeVisible();
    await expect(publicar).toBeDisabled();
    await expect(rascunho.getByRole('button', { name: /Publicar/ })).toHaveCount(1);
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('offers Recriar instead of Pausar on a removed native kit', async ({ page }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the removed kit's block rendered, with its kit badge and
    // the one create arm that applies to it.
    const removido = painel.getByTestId(`shopee-anuncio-${links.kitRemovido}`);
    await expect(removido.getByText('Removido', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(removido.getByText('Kit nativo (inativo)', { exact: true })).toBeVisible();
    const recriar = removido.getByRole('button', { name: 'Recriar kit', exact: true });
    await expect(recriar).toBeVisible();
    await expect(removido.getByRole('button', { name: 'Pausar anúncio' })).toHaveCount(0);
    await expect(removido.getByRole('button', { name: 'Reativar anúncio' })).toHaveCount(0);

    // A create makes a NEW kit on Shopee: it is confirmed first, and a cancel sends nothing.
    await recriar.click();
    const dialogo = page.getByRole('dialog', { name: 'Recriar kit nativo' });
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByText(/já foi excluído na Shopee/)).toBeVisible();
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('renders a blocked publish by motivo without terminal commands', async ({ page }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await ativo.getByRole('button', { name: 'Republicar', exact: true }).click({ timeout: 30_000 });

    const desfecho = ativo.getByTestId(`shopee-desfecho-${links.ativo}`);
    // A Republicar UPDATES the listing, so the title says who refused and
    // nothing more — never «nada foi enviado» (the model leg can refuse after
    // `update_item`).
    await expect(desfecho.getByText(TITULO_PUBLICACAO_BLOQUEADA, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // The row with an acao: its button acts on the link the acao NAMES.
    await expect(
      desfecho.getByRole('button', { name: `Recriar o kit do vínculo ${links.kitRemovido}` }),
    ).toBeVisible();
    // The row without one is worded by its motivo, never by its CLI sentence.
    await expect(desfecho.getByText(/A Shopee respondeu com instabilidade/)).toBeVisible();
    // Scoped to the conta's panel: the page's inline scripts are not the tab's copy.
    await expect(painel.getByText(TEXTO_DE_TERMINAL)).toHaveCount(0);

    expect(stubs.chamadas).toEqual([
      {
        metodo: 'POST',
        rota: 'publicar',
        corpo: { integracaoId: conta, produtoId, linkDocId: links.ativo },
      },
    ]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('keeps the listing state and says so when the shopee service is unreachable', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    // Registered AFTER the stubs, so it wins for this one route: the re-verify
    // fails at the network.
    await page.route(
      (url) => url.pathname === `${PREFIXO_ROTAS}reverificar-anuncio`,
      (route) => route.abort('connectionrefused'),
    );
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await expect(ativo.getByText('Ativo', { exact: true })).toBeVisible({ timeout: 30_000 });
    await ativo.getByRole('button', { name: 'Reverificar' }).click();

    await expect(
      ativo.getByText('Não foi possível contatar a integração com a Shopee.'),
    ).toBeVisible({ timeout: 30_000 });
    // The state the tab reads from Firestore is still there.
    await expect(ativo.getByText('Ativo', { exact: true })).toBeVisible();
    await expect(painel.getByText(/Erro ao carregar os anúncios da Shopee/)).toHaveCount(0);
    // The cut-off re-verify never reaches the recorder (the newer handler took
    // it), so anything recorded is a call the failure set off — a draft save,
    // a pause or a publish, each answered 2xx and so invisible to `semStub`.
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test("saves only a draft's edited title, with the stored title as its baseline", async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${links.rascunho}`);
    const titulo = editor.getByRole('textbox', { name: /^Título/ });
    await expect(titulo).toHaveValue(tituloGuardado, { timeout: 30_000 });
    const tituloEditado = `${tituloGuardado} editado`;

    // The field takes typing once the links listener answered FROM THE SERVER
    // (a cached copy is never an edit's baseline) — `fill` waits for that.
    await titulo.fill(tituloEditado, { timeout: 30_000 });
    // An undo puts the stored title back and sends nothing.
    await editor.getByRole('button', { name: 'Desfazer alterações', exact: true }).click();
    await expect(titulo).toHaveValue(tituloGuardado);

    await titulo.fill(tituloEditado);
    // Nothing leaves the browser before the operator saves.
    expect(stubs.chamadas).toEqual([]);
    await editor.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();

    // ONLY the edited field, and beside it the value the operator SAW stored —
    // never the description, category or brand nobody touched.
    await expect
      .poll(() => stubs.chamadas, { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho/atualizar',
          corpo: {
            integracaoId: conta,
            produtoId,
            linkDocId: links.rascunho,
            base: { item_name: tituloGuardado },
            patch: { item_name: tituloEditado },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_SALVO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test("saves a draft's brand picked from the conta's shortlist under the brand's original name", async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the stored draft's form loaded, and it holds no brand.
    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${links.rascunho}`);
    await expect(editor.getByRole('textbox', { name: /^Título/ })).toHaveValue(tituloGuardado, {
      timeout: 30_000,
    });
    await expect(editor.getByText(PENDENCIA_MARCA).first()).toBeVisible();

    // The picker reads the conta's shortlist from Firestore — the row the
    // Marcas section writes — and asks apps/shopee nothing. Like typing, a
    // pick waits for the links listener's server answer; `click` waits for it.
    const marca = editor
      .getByTestId(`shopee-rascunho-marca-${links.rascunho}`)
      .getByRole('combobox', { name: 'Marca', exact: true });
    await marca.click({ timeout: 30_000 });
    // «Sem marca» is the picker's own option, never a shortlist row; the row
    // is offered under its DISPLAY name.
    await expect(page.getByRole('option', { name: ROTULO_SEM_MARCA, exact: true })).toBeVisible();
    await page.getByRole('option', { name: MARCA_DA_CONTA.displayBrandName, exact: true }).click();
    await expect(marca).toHaveValue(MARCA_DA_CONTA.displayBrandName);
    // The pick answers the brand's pendência, and only that one.
    await expect(editor.getByText(PENDENCIA_MARCA)).toHaveCount(0);
    await expect(editor.getByText(PENDENCIA_CATEGORIA).first()).toBeVisible();
    // Nothing leaves the browser before the operator saves.
    expect(stubs.chamadas).toEqual([]);
    await editor.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();

    // ONLY the brand, as the pair the draft stores: the row's id with its
    // ORIGINAL name — the one publish sends — never the label the picker
    // showed; and beside it the brand the operator saw stored, none.
    await expect
      .poll(() => stubs.chamadas, { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho/atualizar',
          corpo: {
            integracaoId: conta,
            produtoId,
            linkDocId: links.rascunho,
            base: { marca: null },
            patch: {
              marca: {
                brand_id: MARCA_DA_CONTA.brandId,
                original_brand_name: MARCA_DA_CONTA.originalBrandName,
              },
            },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_SALVO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('discards a draft after a confirmation, sending every stored field as its baseline', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${links.rascunho}`);
    const descartar = editor.getByRole('button', { name: 'Descartar', exact: true });
    await descartar.click({ timeout: 30_000 });
    const dialogo = page.getByRole('dialog').filter({ hasText: FRASE_CONFIRMAR_DESCARTE });
    await expect(dialogo).toBeVisible();
    // A cancel sends nothing.
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);
    expect(stubs.chamadas).toEqual([]);

    await descartar.click();
    await expect(dialogo).toBeVisible();
    // Nothing leaves the browser before the operator confirms.
    expect(stubs.chamadas).toEqual([]);
    await dialogo.getByRole('button', { name: /^Descartar/ }).click();

    // ALL FIVE stored fields, as stored — `null` included — so a draft edited
    // meanwhile is refused instead of deleted unseen; never `logistic_info`,
    // and no Seller-Centre attestation for a draft with no uncertain create.
    await expect
      .poll(() => stubs.chamadas, { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho/descartar',
          corpo: {
            integracaoId: conta,
            produtoId,
            linkDocId: links.rascunho,
            base: {
              item_name: tituloGuardado,
              description: null,
              category_id: null,
              marca: null,
              attributes: null,
            },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_DESCARTADO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('opens a new draft on a conta holding only a removed listing and writes it only on Salvar rascunho', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, contaSoRemovido);

    // Positive first: the conta's one listing rendered — removed, so it makes
    // no new listing here a SECOND one.
    await expect(
      painel.getByTestId(`shopee-anuncio-${links.removido}`).getByText('Removido', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await painel.getByRole('button', { name: 'Novo anúncio', exact: true }).click();

    // The new draft opens at once: no second-listing confirmation was asked.
    await expect(
      painel.getByRole('button', { name: 'Salvar rascunho', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO })).toHaveCount(0);
    const novoId = await idDoUnicoRascunho(painel);
    // Minted here — a Firestore-style id, the only shape the create accepts.
    expect(novoId).toMatch(PADRAO_ID_RASCUNHO_SHOPEE);
    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${novoId}`);
    await expect(editor.getByText(FRASE_RASCUNHO_NOVO)).toBeVisible();
    // Prefilled with the produto's name; no category, no brand chosen.
    await expect(editor.getByRole('textbox', { name: /^Título/ })).toHaveValue(produtoId);
    await expect(editor.getByText(PENDENCIA_CATEGORIA).first()).toBeVisible();
    await expect(editor.getByText(PENDENCIA_MARCA).first()).toBeVisible();
    // Nothing exists on the server to publish yet: «Publicar» is disabled, and
    // says the draft must be saved first.
    await expect(editor.getByRole('button', { name: ROTULO_PUBLICAR, exact: true })).toBeDisabled();
    await expect(editor.getByText(FRASE_PUBLICAR_RASCUNHO_NOVO)).toBeVisible();
    // Opening it wrote nothing.
    expect(stubs.chamadas).toEqual([]);

    await editor.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
    // The create names EVERY field (`attributes: null` on a new draft) at the
    // id minted when the draft was opened — and no second-listing flag, since
    // nothing was confirmed.
    await expect
      .poll(() => stubs.chamadas, { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho',
          corpo: {
            integracaoId: contaSoRemovido,
            produtoId,
            linkDocId: novoId,
            conteudo: {
              item_name: produtoId,
              description: null,
              category_id: null,
              marca: null,
              attributes: null,
            },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_CRIADO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('asks before a second listing on a conta that already holds one, and a cancel opens nothing', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the conta's stored draft editor rendered.
    const salvarRascunho = painel.getByRole('button', { name: 'Salvar rascunho', exact: true });
    await expect(salvarRascunho).toHaveCount(1, { timeout: 30_000 });
    await painel.getByRole('button', { name: 'Novo anúncio', exact: true }).click();

    const dialogo = page.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO });
    await expect(dialogo).toBeVisible();
    // The live listing and the draft count; the removed kit does not.
    await expect(
      dialogo.getByText(/Esta conta já tem 2 anúncio\(s\) deste produto, incluindo um rascunho\./),
    ).toBeVisible();
    await expect(
      dialogo.getByRole('button', { name: ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO, exact: true }),
    ).toBeVisible();
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);

    // No new draft opened: the stored draft's editor is still the only one.
    await expect(salvarRascunho).toHaveCount(1);
    await expect(painel.getByText(FRASE_RASCUNHO_NOVO)).toHaveCount(0);
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test("picks a draft's category in the conta's tree, reads the picked category's bands and holds Publicar until the change is saved", async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(
      page,
      links.kitRemovido,
      rotasDaEscolhaDeCategoria(conta, tituloPronto),
    );
    // The near-miss pair, by the publisher's own measure: the SAME title fits
    // the held category's band and not the sibling's.
    expect(textoNaFaixaShopee(tituloPronto, FAIXA_DO_TITULO_DO_RASCUNHO_PRONTO).estado).toBe('ok');
    const naIrma = textoNaFaixaShopee(tituloPronto, FAIXA_DO_TITULO_DA_IRMA);
    expect(naIrma.estado).toBe('fora-da-faixa');
    const pendenciaDaIrma = pendenciaDoTituloForaDaFaixa(
      naIrma.estado === 'ausente' ? 0 : naIrma.comprimento,
      FAIXA_DO_TITULO_DA_IRMA,
    );
    const lidasNaAbertura = [
      leitura('taxonomia/categorias', {
        integracaoId: conta,
        categoryId: String(SHOPEE_E2E_CATEGORIA),
      }),
      leitura('taxonomia/limites', {
        integracaoId: conta,
        categoryId: String(SHOPEE_E2E_CATEGORIA),
      }),
    ].sort();
    const lidasDepoisDaEscolha = [
      ...lidasNaAbertura,
      leitura('taxonomia/recomendacao-categoria', { integracaoId: conta, nome: tituloPronto }),
      leitura('taxonomia/categorias', {
        integracaoId: conta,
        categoryId: String(CATEGORIA_RAIZ_E2E),
      }),
      leitura('taxonomia/categorias', {
        integracaoId: conta,
        categoryId: String(CATEGORIA_IRMA_E2E),
      }),
      leitura('taxonomia/limites', { integracaoId: conta, categoryId: String(CATEGORIA_IRMA_E2E) }),
    ].sort();

    await page.goto(`/produtos/${pronto.produtoId}/editar`);
    const painel = await abrirConta(page, conta);
    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${pronto.rascunho}`);
    const categoria = editor.getByTestId(`shopee-rascunho-categoria-${pronto.rascunho}`);
    const rotulo = categoria.getByTestId(`shopee-rascunho-categoria-${pronto.rascunho}-rotulo`);
    const pendencias = editor.getByTestId(`${RAIZ_DO_RASCUNHO}${pronto.rascunho}-pendencias`);
    const aviso = editor.getByTestId(`${RAIZ_DO_RASCUNHO}${pronto.rascunho}-publicar-aviso`);
    const publicar = editor.getByRole('button', { name: ROTULO_PUBLICAR, exact: true });

    // Positive first: the held category's path, and «Publicar» acts on its
    // bands — no pendência, no sentence under the button.
    await expect(
      rotulo.getByText(caminhoDaCategoria([RAIZ_E2E, FOLHA_DO_RASCUNHO_PRONTO]), { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(publicar).toBeEnabled({ timeout: 30_000 });
    await expect(pendencias).toHaveCount(0);
    await expect(aviso).toHaveCount(0);
    // Two reads, both of the HELD category: its node and its bands.
    expect(leiturasDistintas(stubs)).toEqual(lidasNaAbertura);

    await categoria.getByRole('button', { name: ROTULO_TROCAR_CATEGORIA, exact: true }).click();
    const modal = page.getByRole('dialog', { name: TITULO_ESCOLHA_CATEGORIA });
    await expect(modal).toBeVisible();
    // Shopee's suggestions for the title are offered, never applied: a leaf
    // gets a button, a non-leaf says why it gets none.
    const sugestaoFolha = modal.getByTestId('shopee-rascunho-sugestao-1');
    await expect(
      sugestaoFolha.getByRole('button', { name: ROTULO_USAR_SUGESTAO, exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const sugestaoRaiz = modal.getByTestId('shopee-rascunho-sugestao-2');
    await expect(sugestaoRaiz.getByText(FRASE_SUGESTAO_NAO_FOLHA, { exact: true })).toBeVisible();
    await expect(sugestaoRaiz.getByRole('button')).toHaveCount(0);
    // The tree opens on the held leaf's level — its parent's children.
    await expect(modal.getByTestId(`shopee-categoria-linha-${SHOPEE_E2E_CATEGORIA}`)).toBeVisible({
      timeout: 30_000,
    });
    await modal
      .getByTestId(`shopee-categoria-linha-${CATEGORIA_IRMA_E2E}`)
      .getByRole('button', { name: ROTULO_ESCOLHER_FOLHA, exact: true })
      .click();
    await expect(modal).toHaveCount(0);

    // The pick is the form's: the label reads the picked leaf's path, and the
    // bands of the EDITED category — unsaved — are read and applied: the title
    // the held category accepts is outside the sibling's band.
    await expect(
      rotulo.getByText(caminhoDaCategoria([RAIZ_E2E, FOLHA_IRMA_E2E]), { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(pendencias.getByText(pendenciaDaIrma, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(leiturasDistintas(stubs)).toEqual(lidasDepoisDaEscolha);
    // «Publicar» waits for the change to be saved, and says so.
    await expect(publicar).toBeDisabled();
    await expect(aviso).toHaveText(FRASE_PUBLICAR_COM_ALTERACOES);
    expect(escritas(stubs)).toEqual([]);

    // «Desfazer alterações» puts the held category back — its path, no
    // pendência, «Publicar» acting again — and sends nothing.
    await editor.getByRole('button', { name: 'Desfazer alterações', exact: true }).click();
    await expect(
      rotulo.getByText(caminhoDaCategoria([RAIZ_E2E, FOLHA_DO_RASCUNHO_PRONTO]), { exact: true }),
    ).toBeVisible();
    await expect(publicar).toBeEnabled();
    await expect(pendencias).toHaveCount(0);
    await expect(aviso).toHaveCount(0);
    expect(escritas(stubs)).toEqual([]);

    // A suggestion picks the same leaf, and Salvar sends ONLY the category —
    // beside it the category the operator saw stored and the attributes the
    // change clears (none stored: `null`).
    await categoria.getByRole('button', { name: ROTULO_TROCAR_CATEGORIA, exact: true }).click();
    await modal
      .getByTestId('shopee-rascunho-sugestao-1')
      .getByRole('button', { name: ROTULO_USAR_SUGESTAO, exact: true })
      .click({ timeout: 30_000 });
    await expect(modal).toHaveCount(0);
    await expect(
      rotulo.getByText(caminhoDaCategoria([RAIZ_E2E, FOLHA_IRMA_E2E]), { exact: true }),
    ).toBeVisible();
    await expect(publicar).toBeDisabled();
    expect(escritas(stubs)).toEqual([]);
    await editor.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
    await expect
      .poll(() => escritas(stubs), { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho/atualizar',
          corpo: {
            integracaoId: conta,
            produtoId: pronto.produtoId,
            linkDocId: pronto.rascunho,
            base: { category_id: SHOPEE_E2E_CATEGORIA, attributes: null },
            patch: { category_id: CATEGORIA_IRMA_E2E },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_SALVO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // Nothing read beyond those six — no shop-wide band, no roots — and
    // nothing outside the stubs.
    expect(leiturasDistintas(stubs)).toEqual(lidasDepoisDaEscolha);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('publishes a ready draft by its link after a confirmation, and routes its refusal to the produto tab that fixes it', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(
      page,
      links.kitRemovido,
      rotasDoRascunhoPronto(conta, pronto.rascunho),
    );
    await page.goto(`/produtos/${pronto.produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const bloco = painel.getByTestId(`shopee-anuncio-${pronto.rascunho}`);
    const editor = bloco.getByTestId(`${RAIZ_DO_RASCUNHO}${pronto.rascunho}`);
    // Positive first: saved, clean, a category and «Sem marca» chosen, the
    // produto's stored Descrição standing in — so «Publicar» acts once the
    // category's bands are read (the stubbed `taxonomia/limites`).
    const publicar = editor.getByRole('button', { name: ROTULO_PUBLICAR, exact: true });
    await expect(publicar).toBeEnabled({ timeout: 30_000 });
    await expect(editor.getByText(PENDENCIA_CATEGORIA)).toHaveCount(0);
    await expect(editor.getByText(PENDENCIA_MARCA)).toHaveCount(0);
    await expect(editor.getByText(PENDENCIA_SEM_DESCRICAO)).toHaveCount(0);

    await publicar.click();
    const dialogo = page.getByRole('dialog', { name: TITULO_PUBLICAR });
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByText(aberturaDaConfirmacao(conta))).toBeVisible();
    const pausado = dialogo.getByRole('checkbox', { name: ROTULO_CRIAR_PAUSADO });
    await expect(pausado).toBeVisible();
    await expect(pausado).not.toBeChecked();
    // The conta holds nothing else of this produto — the draft being published
    // never counts as its own "second listing" — so no duplicate warning, in
    // any of its wordings, and the confirm is the plain «Publicar».
    await expect(dialogo.getByTestId(idDoAvisoDeSegundoAnuncio(pronto.rascunho))).toHaveCount(0);
    await expect(
      dialogo.getByRole('button', { name: ROTULO_PUBLICAR_SEGUNDO_ANUNCIO, exact: true }),
    ).toHaveCount(0);
    await expect(dialogo.getByRole('button', { name: ROTULO_PUBLICAR, exact: true })).toBeVisible();
    // A cancel sends nothing.
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);
    expect(escritas(stubs)).toEqual([]);

    await publicar.click();
    await expect(dialogo).toBeVisible();
    // Nothing leaves the browser before the operator confirms.
    expect(escritas(stubs)).toEqual([]);
    await dialogo.getByRole('button', { name: ROTULO_PUBLICAR, exact: true }).click();

    // By its link ALONE: never a `categoryId` (the draft carries its own), no
    // `status` («Criar pausado» left unticked) and no confirmation flag nobody
    // gave.
    await expect
      .poll(() => escritas(stubs), { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'publicar',
          corpo: { integracaoId: conta, produtoId: pronto.produtoId, linkDocId: pronto.rascunho },
        },
      ]);

    // A refusal decided before any Shopee write is DEFINITE: its row, never the
    // uncertain create's wording.
    const desfecho = painel.getByTestId(`shopee-desfecho-${pronto.rascunho}`);
    await expect(desfecho.getByText(TITULO_PUBLICACAO_BLOQUEADA, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const linha = desfecho.getByTestId(`shopee-problema-${pronto.rascunho}-0`);
    await expect(linha.getByText(MENSAGEM_SEM_PESO)).toBeVisible();
    await expect(desfecho.getByText(TITULO_ANUNCIO_INCERTO)).toHaveCount(0);
    await expect(desfecho.getByText(/falhou/i)).toHaveCount(0);

    // Campo `weight` is fixed in the produto's own field: the row's button opens
    // the produto tab holding it.
    await linha.getByRole('button', { name: ROTULO_ABRIR_SECAO_DO_PESO, exact: true }).click();
    await expect(page.getByRole('tab', { name: SECAO_DO_PESO, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 30_000 },
    );
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });
});
