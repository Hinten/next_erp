/**
 * Response fixtures, as TypeScript constants so they are linted and typechecked
 * like the code that reads them.
 *
 * ## Provenance
 *
 * The ones above "Synthetic" come from Loja Integrada's PUBLIC OpenAPI document
 * (the one `li-doc.mjs` reads), redacted:
 *
 *  - `categoriaPagina1` — the `GET /v1/categoria` 200 example, trimmed to three
 *    of its rows, with the demo storefront's URLs replaced by
 *    `https://loja.example/…`.
 *  - `categoriaUltimaPagina` — the same shape with `next: null`: two later rows
 *    of the same example under a hand-built last-page `meta`.
 *  - `metaLimite15` — the `meta` of the single `GET /v1/pedido/search` example,
 *    which answers `limit: 15`: the provider does not always echo the limit
 *    asked for.
 *  - `pedidoBuscaExemplo` — that whole example, both rows, verbatim: it holds no
 *    personal value (the cliente is a resource URI, the money is the
 *    document's own).
 *  - `corpo409Bruto` — the document's only `/v1` error example (a `409` on a
 *    produto alias), which is a bare JSON STRING, not an object.
 *  - `marcaPaginaExemplo` — the `GET /v1/marca` 200 example, trimmed to three of
 *    its rows. Every brand name and `apelido` slug is replaced by a neutral fake
 *    (`Marca Exemplo A`, `marca-exemplo-a`); the ids, the `meta` and the first
 *    row's `descricao: "null"` (a STRING, sic) are the document's own.
 *  - `gradesPaginaExemplo` — the `GET /v1/grades` 200 example, trimmed to five
 *    of its rows: four platform grades with a generic name, and one whose
 *    `nome_visivel` is the empty string, as several of the document's rows are.
 *  - `gradeDetalheExemplo` — the `GET /v1/grades/{grade_id}` 200 example (grade
 *    `8946`), trimmed to three of its six options. Note the two URI forms the
 *    document gives an option: `grade` is `/api/v1/grades/<g>` (plural) and
 *    `resource_uri` is `/api/v1/grade/<g>/variacao/<v>` (singular).
 *  - `produtoPaginaExemplo` — the `GET /v1/produto` 200 example, all 20 rows:
 *    variations ARE rows (`atributo_opcao`, ten of them) between their parents
 *    (`atributo`) and simple products (`normal`); five children are claimed
 *    by no row of the page (their parents sit on other pages), two parents
 *    have `filhos: []`, and a child row carries no `filhos` and no `grades`
 *    key at all. `nome` is `null` on two children, and one `nome` keeps its
 *    leading space.
 *  - `produtoFiltroSkuExemplo`, `produtoFiltroDataExemplo` — the same
 *    operation's two other examples (a `sku` filter, a date filter): one parent
 *    whose `grades` is `[]` although it names children, and two children whose
 *    `seo` is `/api/v1/seo/None` (sic). This package never SENDS either filter;
 *    the bodies are kept for their row shapes.
 *  - `produtoDetalheExemplo` — the `GET /v1/produto/{produto_id}` 200 example
 *    (a simple product): its `peso` a decimal STRING, its dimensions integers,
 *    its price and stock keys (`preco_*`, `estoque_*`), and two images, the
 *    second with `posicao: null` and `mime: null`.
 *  - `produtoFilhoCriadoExemplo` — the `POST /v1/produto` 201 example of a
 *    CHILD (`cadastrar_produto_filho`): the one variation detail the document
 *    shows, with its `pai`, its two option URIs and no image or category.
 *
 *    In these five, every product name is `Produto Exemplo <n>` (a leading space
 *    kept where the document has one), every slug (`apelido`) is
 *    `produto-exemplo-<n>`, every storefront URL is `https://loja.example/…`,
 *    every CDN path is `1000/1000001/produto/imagem-exemplo-<n>.<ext>` (the
 *    host kept), and one row's styled description is reduced to neutral text.
 *    The ids, SKUs, URIs, flags, weights, sizes and `meta` are the document's
 *    own.
 *
 * ⚠️ Everything under "Synthetic" is INVENTED: the document shows no 401, 403,
 * 429 or 5xx body at all. They exist to drive the classifier through the shapes
 * a gateway or the API could plausibly send (JSON, text, HTML, empty). The
 * personal data in `corpo422ComDadosPessoais` is fake by construction
 * (`.invalid` domain, an all-zero CPF).
 */

export const categoriaPagina1 = {
  meta: {
    limit: 20,
    next: '/api/v1/categoria?limit=20&offset=20',
    offset: 0,
    previous: null,
    total_count: 55,
  },
  objects: [
    {
      categoria_pai: null,
      descricao: 'Looks para mulheres modernas.',
      id: 7645875,
      id_externo: null,
      nome: 'Feminino',
      resource_uri: '/api/v1/categoria/7645875',
      seo: '/api/v1/seo/44626931',
      url: 'https://loja.example/feminino',
    },
    {
      categoria_pai: '/api/v1/categoria/7645875',
      descricao: '',
      id: 7645904,
      id_externo: null,
      nome: 'Acessórios feminino',
      resource_uri: '/api/v1/categoria/7645904',
      seo: '/api/v1/seo/44626950',
      url: 'https://loja.example/acessorios-feminino',
    },
    {
      categoria_pai: '/api/v1/categoria/7645875',
      descricao: null,
      id: 7645906,
      id_externo: null,
      nome: 'Look feminino completo',
      resource_uri: '/api/v1/categoria/7645906',
      seo: '/api/v1/seo/44626960',
      url: 'https://loja.example/look-feminino-completo',
    },
  ],
} as const;

export const categoriaUltimaPagina = {
  meta: {
    limit: 20,
    next: null,
    offset: 40,
    previous: '/api/v1/categoria?limit=20&offset=20',
    total_count: 55,
  },
  objects: [
    {
      categoria_pai: '/api/v1/categoria/7645875',
      descricao: null,
      id: 11214945,
      id_externo: null,
      nome: 'Bolsas Femininas',
      resource_uri: '/api/v1/categoria/11214945',
      // Sic: the document's own example renders `None` (a Python null) here.
      seo: '/api/v1/seo/None',
      url: 'https://loja.example/None',
    },
    {
      categoria_pai: '/api/v1/categoria/7645875',
      descricao: null,
      id: 11214946,
      id_externo: null,
      nome: 'Mochilas',
      resource_uri: '/api/v1/categoria/11214946',
      seo: '/api/v1/seo/None',
      url: 'https://loja.example/None',
    },
  ],
} as const;

export const metaLimite15 = {
  limit: 15,
  next: null,
  offset: 0,
  previous: null,
  total_count: 2,
} as const;

const situacaoCancelado = {
  aprovado: false,
  cancelado: true,
  codigo: 'pedido_cancelado',
  final: true,
  id: 8,
  nome: 'Pedido Cancelado',
  notificar_comprador: true,
  padrao: false,
  resource_uri: '/api/v1/situacao/8',
} as const;

export const pedidoBuscaExemplo = {
  meta: metaLimite15,
  objects: [
    {
      cliente: '/api/v1/cliente/34220641',
      data_criacao: '2022-10-31T12:17:51.633657',
      data_expiracao: '2022-11-06T12:17:51.733114',
      data_modificacao: '2022-10-31T12:17:58.949670',
      id_anymarket: null,
      id_externo: null,
      numero: 164,
      peso_real: '0.170',
      resource_uri: '/api/v1/pedido/164',
      situacao: situacaoCancelado,
      utm_campaign: null,
      valor_desconto: '0.00',
      valor_envio: '21.38',
      valor_subtotal: '85.00',
      valor_total: '106.38',
    },
    {
      cliente: '/api/v1/cliente/34220641',
      data_criacao: '2022-10-31T12:28:05.704751',
      data_expiracao: '2022-11-06T12:28:05.782308',
      data_modificacao: '2022-10-31T12:28:12.653648',
      id_anymarket: null,
      id_externo: null,
      numero: 165,
      peso_real: '0.450',
      resource_uri: '/api/v1/pedido/165',
      situacao: situacaoCancelado,
      utm_campaign: null,
      valor_desconto: '0.00',
      valor_envio: '21.38',
      valor_subtotal: '11.10',
      valor_total: '32.48',
    },
  ],
} as const;

/** The raw body text, exactly as the document shows it: a JSON string literal. */
export const corpo409Bruto = '"Slug already in use."';

export const marcaPaginaExemplo = {
  meta: {
    limit: 20,
    next: '/api/v1/marca?limit=20&offset=20',
    offset: 0,
    previous: null,
    total_count: 39,
  },
  objects: [
    {
      apelido: 'marca-exemplo-a',
      ativo: true,
      // Sic: the document's example is the STRING "null", not a JSON null.
      descricao: 'null',
      id: 2875259,
      id_externo: null,
      imagem: null,
      nome: 'Marca Exemplo A',
      resource_uri: '/api/v1/marca/2875259',
    },
    {
      apelido: 'marca-exemplo-b',
      ativo: true,
      descricao: null,
      id: 2875261,
      id_externo: null,
      imagem: null,
      nome: 'Marca Exemplo B',
      resource_uri: '/api/v1/marca/2875261',
    },
    {
      apelido: 'marca-exemplo-c',
      ativo: true,
      descricao: null,
      id: 3012488,
      id_externo: null,
      imagem: null,
      nome: 'Marca Exemplo C',
      resource_uri: '/api/v1/marca/3012488',
    },
  ],
} as const;

export const gradesPaginaExemplo = {
  meta: {
    limit: 20,
    next: '/api/v1/grades?limit=20&offset=20',
    offset: 0,
    previous: null,
    total_count: 32,
  },
  objects: [
    {
      id: 32769,
      id_externo: null,
      nome: 'Gênero',
      nome_visivel: 'Gênero',
      resource_uri: '/api/v1/grades/32769',
    },
    {
      id: 8945,
      id_externo: null,
      nome: 'Produto com uma cor',
      nome_visivel: 'Cor',
      resource_uri: '/api/v1/grades/8945',
    },
    {
      id: 8946,
      id_externo: null,
      nome: 'Tamanho de capacete',
      nome_visivel: 'Tamanho',
      resource_uri: '/api/v1/grades/8946',
    },
    {
      id: 8949,
      id_externo: null,
      nome: 'Voltagem',
      nome_visivel: 'Voltagem',
      resource_uri: '/api/v1/grades/8949',
    },
    {
      id: 2047707,
      id_externo: null,
      nome: 'Medidas',
      nome_visivel: '',
      resource_uri: '/api/v1/grades/2047707',
    },
  ],
} as const;

export const gradeDetalheExemplo = {
  id: 8946,
  id_externo: null,
  nome: 'Tamanho de capacete',
  nome_visivel: 'Tamanho',
  resource_uri: '/api/v1/grades/8946',
  variacoes: [
    {
      grade: '/api/v1/grades/8946',
      id: 37097,
      id_externo: null,
      nome: '53-54',
      resource_uri: '/api/v1/grade/8946/variacao/37097',
    },
    {
      grade: '/api/v1/grades/8946',
      id: 37098,
      id_externo: null,
      nome: '55-56',
      resource_uri: '/api/v1/grade/8946/variacao/37098',
    },
    {
      grade: '/api/v1/grades/8946',
      id: 37099,
      id_externo: null,
      nome: '57-58',
      resource_uri: '/api/v1/grade/8946/variacao/37099',
    },
  ],
} as const;

export const produtoPaginaExemplo = {
  meta: {
    limit: 20,
    next: '/api/v1/produto?limit=20&offset=20',
    offset: 0,
    previous: null,
    total_count: 1382,
  },
  objects: [
    {
      apelido: 'produto-exemplo-1',
      ativo: false,
      bloqueado: false,
      categorias: ['/api/v1/categoria/15246059'],
      descricao_completa: '<strong>Desctição HTML do produto</strong>',
      grades: [],
      gtin: null,
      id: 202591789,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 1',
      removido: false,
      resource_uri: '/api/v1/produto/202591789',
      seo: '/api/v1/seo/88217435',
      sku: 'prod-009',
      tipo: 'normal',
      url: 'https://loja.example/produto/produto-exemplo-1.html',
      url_video_youtube: null,
      variacoes: [],
    },
    {
      apelido: null,
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: '',
      gtin: '',
      id: 198399269,
      id_externo: null,
      mpn: '',
      ncm: '',
      nome: null,
      removido: false,
      resource_uri: '/api/v1/produto/198399269',
      seo: '/api/v1/seo/87223008',
      sku: 'Q65VXE4BB-abacaxi',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/198399269.html',
      url_video_youtube: '',
      variacoes: ['/api/v1/grade/2218954/variacao/7336938'],
    },
    {
      apelido: 'produto-exemplo-2',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      filhos: ['/api/v1/produto/198399269'],
      grades: ['/api/v1/grades/2218954'],
      gtin: '',
      id: 198399254,
      id_externo: null,
      mpn: '',
      ncm: '',
      nome: 'Produto Exemplo 2',
      removido: false,
      resource_uri: '/api/v1/produto/198399254',
      seo: '/api/v1/seo/87220925',
      sku: 'Q65VXE4BB',
      tipo: 'atributo',
      url: 'https://loja.example/produto-exemplo-2',
      url_video_youtube: null,
      variacoes: [],
    },
    {
      apelido: 'produto-exemplo-3',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: '',
      gtin: '',
      id: 198219152,
      id_externo: null,
      mpn: '',
      ncm: '',
      nome: 'Produto Exemplo 3',
      removido: false,
      resource_uri: '/api/v1/produto/198219152',
      seo: '/api/v1/seo/87176883',
      sku: 'E6LR243T5-abacaxi',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/produto-exemplo-3.html',
      url_video_youtube: '',
      variacoes: ['/api/v1/grade/2218954/variacao/7336938'],
    },
    {
      apelido: 'produto-exemplo-4',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: '',
      filhos: ['/api/v1/produto/198219152'],
      grades: ['/api/v1/grades/2218954'],
      gtin: '',
      id: 198219093,
      id_externo: null,
      mpn: '',
      ncm: '',
      nome: 'Produto Exemplo 4',
      removido: false,
      resource_uri: '/api/v1/produto/198219093',
      seo: '/api/v1/seo/87176525',
      sku: 'E6LR243T5',
      tipo: 'atributo',
      url: 'https://loja.example/produto-exemplo-4',
      url_video_youtube: '',
      variacoes: [],
    },
    {
      apelido: 'produto-exemplo-5',
      ativo: false,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      grades: [],
      gtin: null,
      id: 194704586,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 5',
      removido: true,
      resource_uri: '/api/v1/produto/194704586',
      seo: '/api/v1/seo/86475324',
      sku: 'prod-simples-novo',
      tipo: 'normal',
      url: 'https://loja.example/produto/produto-exemplo-5.html',
      url_video_youtube: null,
      variacoes: [],
    },
    {
      apelido: 'produto-exemplo-6',
      ativo: false,
      bloqueado: false,
      categorias: [],
      descricao_completa: '<strong>Desctição HTML do produto</strong>',
      grades: [],
      gtin: null,
      id: 190101432,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 6',
      removido: true,
      resource_uri: '/api/v1/produto/190101432',
      seo: '/api/v1/seo/85555479',
      sku: 'prod-simples1234',
      tipo: 'normal',
      url: 'https://loja.example/produto/produto-exemplo-6.html',
      url_video_youtube: null,
      variacoes: [],
    },
    {
      apelido: null,
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: '',
      gtin: '',
      id: 189482484,
      id_externo: null,
      mpn: '',
      ncm: '',
      nome: null,
      removido: false,
      resource_uri: '/api/v1/produto/189482484',
      seo: '/api/v1/seo/None',
      sku: '1068-13',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/189482484.html',
      url_video_youtube: '',
      variacoes: ['/api/v1/grade/2248145/variacao/7394271'],
    },
    {
      apelido: 'produto-exemplo-7',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      gtin: null,
      id: 188464295,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 7',
      removido: false,
      resource_uri: '/api/v1/produto/188464295',
      seo: '/api/v1/seo/None',
      sku: 'prod-test-s-preco',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/produto-exemplo-7.html',
      url_video_youtube: null,
      variacoes: ['/api/v1/grade/8945/variacao/37068'],
    },
    {
      apelido: 'produto-exemplo-8',
      ativo: true,
      bloqueado: false,
      categorias: ['/api/v1/categoria/10060516'],
      descricao_completa:
        '<p><span style="color: rgb(102, 102, 102);">Descrição de exemplo</span></p>\r\n',
      grades: [],
      gtin: '',
      id: 188235342,
      id_externo: null,
      mpn: '',
      ncm: '',
      nome: 'Produto Exemplo 8',
      removido: false,
      resource_uri: '/api/v1/produto/188235342',
      seo: '/api/v1/seo/84778952',
      sku: 'PSYG7AY54',
      tipo: 'normal',
      url: 'https://loja.example/produto-exemplo-8',
      url_video_youtube: '',
      variacoes: [],
    },
    {
      apelido: 'produto-exemplo-9',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      filhos: [],
      grades: ['/api/v1/grades/8945'],
      gtin: null,
      id: 187963973,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 9',
      removido: false,
      resource_uri: '/api/v1/produto/187963973',
      seo: '/api/v1/seo/84663708',
      sku: 'teste-qa-url-pai-10',
      tipo: 'atributo',
      url: 'https://loja.example/produto/produto-exemplo-9.html',
      url_video_youtube: null,
      variacoes: [],
    },
    {
      apelido: 'produto-exemplo-10',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      gtin: null,
      id: 187963614,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 10',
      removido: false,
      resource_uri: '/api/v1/produto/187963614',
      seo: '/api/v1/seo/None',
      sku: 'url-09-filho-novo',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/produto-exemplo-10.html',
      url_video_youtube: null,
      variacoes: ['/api/v1/grade/8945/variacao/37066'],
    },
    {
      apelido: 'produto-exemplo-11',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      filhos: ['/api/v1/produto/187963614'],
      grades: ['/api/v1/grades/8945'],
      gtin: null,
      id: 187962871,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 11',
      removido: false,
      resource_uri: '/api/v1/produto/187962871',
      seo: '/api/v1/seo/84663356',
      sku: 'teste-qa-url-pai-09',
      tipo: 'atributo',
      url: 'https://loja.example/produto/produto-exemplo-11.html',
      url_video_youtube: null,
      variacoes: [],
    },
    {
      apelido: 'produto-exemplo-12',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      filhos: [],
      grades: ['/api/v1/grades/8945'],
      gtin: null,
      id: 187961073,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 12',
      removido: false,
      resource_uri: '/api/v1/produto/187961073',
      seo: '/api/v1/seo/84662667',
      sku: 'teste-qa-url-pai-08',
      tipo: 'atributo',
      url: 'https://loja.example/produto/produto-exemplo-12.html',
      url_video_youtube: null,
      variacoes: [],
    },
    {
      apelido: 'produto-exemplo-13',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      gtin: null,
      id: 187960808,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 13',
      removido: false,
      resource_uri: '/api/v1/produto/187960808',
      seo: '/api/v1/seo/None',
      sku: 'url-07-filho-novo',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/produto-exemplo-13.html',
      url_video_youtube: null,
      variacoes: ['/api/v1/grade/8945/variacao/37066'],
    },
    {
      apelido: 'produto-exemplo-14',
      ativo: false,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      gtin: null,
      id: 187959333,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: ' Produto Exemplo 14',
      removido: false,
      resource_uri: '/api/v1/produto/187959333',
      seo: '/api/v1/seo/None',
      sku: 'teste-qa-url-filho-07',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/produto-exemplo-14.html',
      url_video_youtube: null,
      variacoes: ['/api/v1/grade/8945/variacao/37066'],
    },
    {
      apelido: 'produto-exemplo-15',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      filhos: ['/api/v1/produto/187960808', '/api/v1/produto/187959333'],
      grades: ['/api/v1/grades/8945'],
      gtin: null,
      id: 187958244,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 15',
      removido: false,
      resource_uri: '/api/v1/produto/187958244',
      seo: '/api/v1/seo/84661394',
      sku: 'teste-qa-url-pai-07',
      tipo: 'atributo',
      url: 'https://loja.example/produto/produto-exemplo-15.html',
      url_video_youtube: null,
      variacoes: [],
    },
    {
      apelido: 'produto-exemplo-16',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      gtin: null,
      id: 187950264,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 16',
      removido: false,
      resource_uri: '/api/v1/produto/187950264',
      seo: '/api/v1/seo/None',
      sku: 'prod-test-url-06',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/produto-exemplo-16.html',
      url_video_youtube: null,
      variacoes: ['/api/v1/grade/8945/variacao/37067'],
    },
    {
      apelido: 'produto-exemplo-17',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      gtin: null,
      id: 187949811,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 17',
      removido: false,
      resource_uri: '/api/v1/produto/187949811',
      seo: '/api/v1/seo/None',
      sku: 'prod-test-url-05',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/produto-exemplo-17.html',
      url_video_youtube: null,
      variacoes: ['/api/v1/grade/8945/variacao/37067'],
    },
    {
      apelido: 'produto-exemplo-18',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      gtin: null,
      id: 187474790,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 18',
      removido: false,
      resource_uri: '/api/v1/produto/187474790',
      seo: '/api/v1/seo/None',
      sku: 'prod-test-filho-url-5',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/produto-exemplo-18.html',
      url_video_youtube: null,
      variacoes: ['/api/v1/grade/8945/variacao/37067'],
    },
  ],
} as const;

export const produtoFiltroSkuExemplo = {
  meta: {
    limit: 20,
    next: null,
    offset: 0,
    previous: null,
    total_count: 1,
  },
  objects: [
    {
      apelido: 'produto-exemplo-19',
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: null,
      filhos: ['/api/v1/produto/166737213', '/api/v1/produto/166737211'],
      grades: [],
      gtin: null,
      id: 166737177,
      id_externo: null,
      mpn: null,
      ncm: null,
      nome: 'Produto Exemplo 19',
      removido: false,
      resource_uri: '/api/v1/produto/166737177',
      seo: '/api/v1/seo/76387920',
      sku: '3025',
      tipo: 'atributo',
      url: 'https://loja.example/produto-exemplo-19',
      url_video_youtube: null,
      variacoes: [],
    },
  ],
} as const;

export const produtoFiltroDataExemplo = {
  meta: {
    limit: 20,
    next: null,
    offset: 0,
    previous: null,
    total_count: 2,
  },
  objects: [
    {
      apelido: null,
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: '',
      gtin: '',
      id: 139547180,
      id_externo: null,
      mpn: '',
      ncm: '',
      nome: null,
      removido: false,
      resource_uri: '/api/v1/produto/139547180',
      seo: '/api/v1/seo/None',
      sku: 'VVUSK9KQX-1-20',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/139547180.html',
      url_video_youtube: '',
      variacoes: [
        '/api/v1/grade/2248146/variacao/7394249',
        '/api/v1/grade/2248145/variacao/7394276',
      ],
    },
    {
      apelido: null,
      ativo: true,
      bloqueado: false,
      categorias: [],
      descricao_completa: '',
      gtin: '',
      id: 139547147,
      id_externo: null,
      mpn: '',
      ncm: '',
      nome: null,
      removido: false,
      resource_uri: '/api/v1/produto/139547147',
      seo: '/api/v1/seo/None',
      sku: 'VVUSK9KQX-1-16',
      tipo: 'atributo_opcao',
      url: 'https://loja.example/produto/139547147.html',
      url_video_youtube: '',
      variacoes: [
        '/api/v1/grade/2248146/variacao/7394249',
        '/api/v1/grade/2248145/variacao/7394273',
      ],
    },
  ],
} as const;

export const produtoDetalheExemplo = {
  id: 238281213,
  altura: 15,
  apelido: 'produto-exemplo-20',
  ativo: true,
  bloqueado: false,
  categorias: ['/api/v1/categoria/23171713'],
  data_criacao: '2023-10-23T16:06:03.257071',
  data_modificacao: '2025-03-17T10:27:10.571236',
  descricao_completa: '',
  destaque: false,
  grades: [],
  gtin: '',
  id_externo: null,
  imagem_principal: {
    caminho: '1000/1000001/produto/imagem-exemplo-1.jpg',
    grande: 'https://cdn.awsli.com.br/800x800/1000/1000001/produto/imagem-exemplo-1.jpg',
    icone: 'https://cdn.awsli.com.br/64x64/1000/1000001/produto/imagem-exemplo-1.jpg',
    id: 143127013,
    id_anymarket: null,
    imagem_id: 154961348,
    imagem_variacao: null,
    media: 'https://cdn.awsli.com.br/380x380/1000/1000001/produto/imagem-exemplo-1.jpg',
    mime: 'image/jpeg',
    pequena: 'https://cdn.awsli.com.br/210x210/1000/1000001/produto/imagem-exemplo-1.jpg',
    posicao: '0',
    principal: true,
    produto: '/api/v1/produto/238281213',
    resource_uri: '/api/v1/produto_imagem/143127013',
  },
  imagens: [
    {
      caminho: '1000/1000001/produto/imagem-exemplo-1.jpg',
      grande: 'https://cdn.awsli.com.br/800x800/1000/1000001/produto/imagem-exemplo-1.jpg',
      icone: 'https://cdn.awsli.com.br/64x64/1000/1000001/produto/imagem-exemplo-1.jpg',
      id: 143127013,
      id_anymarket: null,
      imagem_id: 154961348,
      media: 'https://cdn.awsli.com.br/380x380/1000/1000001/produto/imagem-exemplo-1.jpg',
      mime: 'image/jpeg',
      pequena: 'https://cdn.awsli.com.br/210x210/1000/1000001/produto/imagem-exemplo-1.jpg',
      posicao: '0',
      principal: true,
      produto: '/api/v1/produto/238281213',
      resource_uri: '/api/v1/produto_imagem/143127013',
    },
    {
      caminho: '1000/1000001/produto/imagem-exemplo-2.png',
      grande: 'https://cdn.awsli.com.br/800x800/1000/1000001/produto/imagem-exemplo-2.png',
      icone: 'https://cdn.awsli.com.br/64x64/1000/1000001/produto/imagem-exemplo-2.png',
      id: 138518698,
      id_anymarket: null,
      imagem_id: 150044515,
      media: 'https://cdn.awsli.com.br/380x380/1000/1000001/produto/imagem-exemplo-2.png',
      mime: null,
      pequena: 'https://cdn.awsli.com.br/210x210/1000/1000001/produto/imagem-exemplo-2.png',
      posicao: null,
      principal: false,
      produto: '/api/v1/produto/238281213',
      resource_uri: '/api/v1/produto_imagem/138518698',
    },
  ],
  largura: 15,
  marca: '/api/v1/marca/20507618',
  mpn: '',
  ncm: '',
  nome: 'Produto Exemplo 20',
  peso: '0.500',
  profundidade: 15,
  removido: false,
  resource_uri: '/api/v1/produto/238281213',
  seo: '/api/v1/seo/98177864',
  sku: '16167',
  tipo: 'normal',
  url: 'https://loja.example/produto-exemplo-20',
  url_video_youtube: '',
  usado: false,
  variacoes: [],
  tags: [],
  preco_cheio: 100,
  preco_custo: null,
  preco_promocional: null,
  preco_sob_consulta: false,
  estoque_gerenciado: true,
  estoque_situacao_em_estoque: 0,
  estoque_situacao_sem_estoque: -1,
  estoque_quantidade: 15,
  pai: null,
} as const;

export const produtoFilhoCriadoExemplo = {
  altura: 2,
  apelido: 'produto-exemplo-21',
  ativo: true,
  bloqueado: false,
  categorias: [],
  data_criacao: '2022-10-24T15:32:35.969785',
  data_modificacao: '2022-10-24T15:32:35.969803',
  descricao_completa: null,
  destaque: false,
  gtin: null,
  id: 182905567,
  id_externo: null,
  imagem_principal: null,
  imagens: [],
  largura: 12,
  marca: null,
  mpn: null,
  ncm: null,
  nome: 'Produto Exemplo 21',
  pai: '/api/v1/produto/182904918',
  peso: '0.450',
  profundidade: 6,
  removido: false,
  resource_uri: '/api/v1/produto/182905567',
  seo: '/api/v1/seo/None',
  sku: 'casaco-azul-tamanho-m',
  tipo: 'atributo_opcao',
  url: 'https://loja.example/produto/produto-exemplo-21.html',
  url_video_youtube: null,
  usado: false,
  variacoes: ['/api/v1/grade/8945/variacao/37078', '/api/v1/grade/8950/variacao/38417'],
} as const;

/* -------------------------------------------------------------------------- */
/*                     Synthetic — NOT from the document                      */
/* -------------------------------------------------------------------------- */

export const corpo401Json = '{"error": "Unauthorized", "detail": "Token inválido."}';
export const corpo403Texto = 'Forbidden';
export const corpo403Html =
  '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>';
export const corpo500Html =
  '<html><body><h1>500 Internal Server Error</h1><p>upstream failed</p></body></html>';
export const corpo503Texto = 'Service Unavailable';

/** 429 naming the STORE bucket. */
export const corpo429Loja =
  '{"codigo": 633, "mensagem": "Limite de requisições da loja atingido."}';
/** 429 naming the APPLICATION bucket. */
export const corpo429Aplicacao = '{"codigo": 533, "mensagem": "Limite da aplicação atingido."}';
/** 429 naming the IP bucket, as text. */
export const corpo429Ip = 'erro 133. Limite por IP atingido.';
/** 429 with no code at all. */
export const corpo429SemCodigo = '{"mensagem": "Too Many Requests"}';
/** 429 as an HTML gateway page. */
export const corpo429Html = '<html><body><h1>429 Too Many Requests</h1></body></html>';
/**
 * 429 with no code, but echoing a UUID-like correlation id whose hex groups
 * contain `633`, `533` and `133` — none of which may read as a code.
 */
export const corpo429SoUuid =
  '{"id": "3f2a-a633e-b533f-c133d-0000", "mensagem": "Too Many Requests"}';

/**
 * A 400 in the API gateway's own JSON shape, `{Code, OperationId, Message}`:
 * the KEYS of the answer the owner's capture C10 recorded for a produto page
 * size the API refuses (`limit=200`); every value here is invented.
 */
export const corpo400Gateway =
  '{"Code": "400", "OperationId": "op-0000-sintetico", "Message": "Limite invalido (sintetico)."}';

/** A 4xx echoing fake personal data: none of it may reach an error. */
export const corpo422ComDadosPessoais =
  '{"erro": "cliente inválido", "email": "fulano@exemplo.invalid", "cpf": "000.000.000-00"}';
export const EMAIL_FALSO = 'fulano@exemplo.invalid';
export const CPF_FALSO = '000.000.000-00';
