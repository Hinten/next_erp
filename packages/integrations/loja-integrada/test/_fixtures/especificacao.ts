/**
 * Response fixtures, as TypeScript constants so they are linted and typechecked
 * like the code that reads them.
 *
 * ## Provenance
 *
 * The first four come from Loja Integrada's PUBLIC OpenAPI document (the one
 * `li-doc.mjs` reads), redacted:
 *
 *  - `categoriaPagina1` — the `GET /v1/categoria` 200 example, trimmed to three
 *    of its rows, with the demo storefront's URLs replaced by
 *    `https://loja.example/…`.
 *  - `categoriaUltimaPagina` — the same shape with `next: null`: two later rows
 *    of the same example under a hand-built last-page `meta`.
 *  - `metaLimite15` — the `meta` of the single `GET /v1/pedido/search` example,
 *    which answers `limit: 15`: the provider does not always echo the limit
 *    asked for.
 *  - `corpo409Bruto` — the document's only `/v1` error example (a `409` on a
 *    produto alias), which is a bare JSON STRING, not an object.
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

/** The raw body text, exactly as the document shows it: a JSON string literal. */
export const corpo409Bruto = '"Slug already in use."';

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
