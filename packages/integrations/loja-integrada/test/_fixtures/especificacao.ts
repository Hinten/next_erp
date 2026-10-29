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

/** A 4xx echoing fake personal data: none of it may reach an error. */
export const corpo422ComDadosPessoais =
  '{"erro": "cliente inválido", "email": "fulano@exemplo.invalid", "cpf": "000.000.000-00"}';
export const EMAIL_FALSO = 'fulano@exemplo.invalid';
export const CPF_FALSO = '000.000.000-00';
