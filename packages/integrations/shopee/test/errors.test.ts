import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_AMBIGUOUS_AUTH_CODE,
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeConfigError,
  ShopeeError,
  type ShopeeErrorKind,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  classifyShopeeError,
  shopeeCodeSemPrefixoDeModulo,
  shopeeErrorFromEnvelope,
} from '../src/errors';

const envelope = (error: string, extra: Partial<{ message: string | null }> = {}) => ({
  error,
  message: extra.message ?? null,
  request_id: 'req-abc',
  warning: null,
});

describe('the class hierarchy', () => {
  it('roots every class at ShopeeError and sets a distinct name', () => {
    const cases: [ShopeeError, string][] = [
      [new ShopeeError('x'), 'ShopeeError'],
      [new ShopeeConfigError('x'), 'ShopeeConfigError'],
      [new ShopeeNetworkError('x'), 'ShopeeNetworkError'],
      [new ShopeeHttpError('x', { httpStatus: 502, path: '/p' }), 'ShopeeHttpError'],
      [new ShopeeSchemaError('x', { httpStatus: 200, path: '/p' }), 'ShopeeSchemaError'],
    ];
    for (const [err, name] of cases) {
      expect(err).toBeInstanceOf(ShopeeError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
    }
  });

  it('keeps the schema and network errors OUT of the ShopeeApiError branch', () => {
    // ⚠️ The callback route maps `ShopeeApiError` to "Shopee rejected it" and the
    // schema/network classes to different reasons. If either extended
    // `ShopeeApiError`, that `instanceof` chain would collapse them all into one.
    expect(new ShopeeSchemaError('x', { httpStatus: 200, path: '/p' })).not.toBeInstanceOf(
      ShopeeApiError,
    );
    expect(new ShopeeNetworkError('x')).not.toBeInstanceOf(ShopeeApiError);
    expect(new ShopeeHttpError('x', { httpStatus: 403, path: '/p' })).not.toBeInstanceOf(
      ShopeeApiError,
    );
  });

  it('keeps the narrowed `kind` on a rate-limit error (the `declare` regression)', () => {
    // ⚠️ Without `declare` on the subclass field, ES2022 class-field semantics
    // DEFINE `kind` as undefined after `super()` assigned it. This reads back the
    // value, which is the only way that regression is visible.
    const err = new ShopeeRateLimitError('x', {
      code: 'error_limit',
      kind: SHOPEE_ERROR_KIND.daily,
      httpStatus: 200,
      path: '/p',
      retryAfterSeconds: 30,
    });
    expect(err.kind).toBe('daily');
    expect(err.retryAfterSeconds).toBe(30);
    expect(err).toBeInstanceOf(ShopeeApiError);
  });

  it('defaults the optional carriers to null rather than undefined', () => {
    const err = new ShopeeApiError('x', {
      code: 'error_param',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: '/p',
    });
    expect(err.requestId).toBeNull();
    expect(err.warning).toBeNull();
    expect(
      new ShopeeRateLimitError('x', {
        code: 'error_rate_limit',
        kind: SHOPEE_ERROR_KIND.burst,
        httpStatus: 429,
        path: '/p',
      }).retryAfterSeconds,
    ).toBeNull();
  });

  it('copies `campos` instead of aliasing the caller array', () => {
    const campos = ['access_token'];
    const err = new ShopeeSchemaError('x', { campos, httpStatus: 200, path: '/p' });
    campos.push('mutated');
    expect(err.campos).toEqual(['access_token']);
  });
});

describe('classifyShopeeError', () => {
  it.each([
    'refresh_token_expired',
    'shop_access_expired',
    'shop_no_linked',
    'shop_banned',
    'error_shop_refresh_token',
  ])('classifies %s as reauth on both surfaces', (code) => {
    expect(classifyShopeeError(code, SHOPEE_SURFACE.auth)).toBe('reauth');
    expect(classifyShopeeError(code, SHOPEE_SURFACE.business)).toBe('reauth');
  });

  it('splits error_auth by surface', () => {
    // The one code whose meaning depends on the endpoint family.
    expect(classifyShopeeError(SHOPEE_AMBIGUOUS_AUTH_CODE, SHOPEE_SURFACE.auth)).toBe('reauth');
    expect(classifyShopeeError(SHOPEE_AMBIGUOUS_AUTH_CODE, SHOPEE_SURFACE.business)).toBe('other');
  });

  it('keeps the two rate-limit codes on DIFFERENT kinds', () => {
    // NEAR-MISS pair: same family, opposite retry advice. `error_rate_limit` may
    // be retried with backoff; `error_limit` must not be retried until 00:00 UTC+8.
    expect(classifyShopeeError('error_rate_limit', SHOPEE_SURFACE.business)).toBe('burst');
    expect(classifyShopeeError('error_limit', SHOPEE_SURFACE.business)).toBe('daily');
  });

  it('classifies the transient pair and the our-fault pair', () => {
    expect(classifyShopeeError('error_server', SHOPEE_SURFACE.business)).toBe('transient');
    expect(classifyShopeeError('error_network', SHOPEE_SURFACE.business)).toBe('transient');
    expect(classifyShopeeError('error_sign', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('error_param', SHOPEE_SURFACE.business)).toBe('other');
  });

  it('knows Shopee’s misspelling and NOT the corrected spelling', () => {
    // NEAR-MISS: `invalid_main_acount_id` is the wire value. The corrected
    // spelling is a code Shopee never sends, so it must fall through to 'other'
    // as an unknown — and the table must not quietly accept both.
    expect(classifyShopeeError('invalid_main_acount_id', SHOPEE_SURFACE.auth)).toBe('other');
    expect(classifyShopeeError('invalid_main_account_id', SHOPEE_SURFACE.auth)).toBe('other');
    expect(classifyShopeeError('invalid_code', SHOPEE_SURFACE.auth)).toBe('other');
    expect(classifyShopeeError('invalid_shop_id', SHOPEE_SURFACE.auth)).toBe('other');
  });

  it('maps an unknown code to other rather than guessing', () => {
    expect(classifyShopeeError('some_code_shopee_added_tomorrow', SHOPEE_SURFACE.business)).toBe(
      'other',
    );
    expect(classifyShopeeError('', SHOPEE_SURFACE.business)).toBe('other');
  });

  it('does not inherit Object.prototype keys through the lookup table', () => {
    // A plain-object table would answer `constructor` with a function; the kind
    // must still be a verdict.
    expect(classifyShopeeError('constructor', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('toString', SHOPEE_SURFACE.business)).toBe('other');
  });
});

/* -------------------------------------------------------------------------- */
/*          O prefixo de módulo (`product.error_param`) — passo 11             */
/* -------------------------------------------------------------------------- */

describe('shopeeCodeSemPrefixoDeModulo', () => {
  // ⚠️ Este é um FOLD: ele decide que dois códigos são o MESMO para efeito de
  // consulta. Por isso vêm os dois lados — o que TEM de casar e o que TEM de
  // continuar distinto.

  it('PAR — remove o prefixo de módulo que a Shopee imprime nos próprios exemplos', () => {
    // `unlist_item` lista `error_param` e o Error example da mesma página imprime
    // `product.error_param`; `delete_item` faz igual; `add_item` traz
    // `product.error_busi`; `get_channel_list` traz `common.invalid_shop`.
    expect(shopeeCodeSemPrefixoDeModulo('product.error_param')).toBe('error_param');
    expect(shopeeCodeSemPrefixoDeModulo('product.error_limit')).toBe('error_limit');
    expect(shopeeCodeSemPrefixoDeModulo('common.invalid_shop')).toBe('invalid_shop');
    expect(shopeeCodeSemPrefixoDeModulo('order.order_list_invalid_time')).toBe(
      'order_list_invalid_time',
    );
  });

  it('⛔ NEAR-MISS — sem prefixo devolve null, e não uma string vazia', () => {
    // `null` distingue "não havia prefixo" de "o prefixo era o código inteiro".
    // Com `''`, `KIND_BY_CODE.get('')` vira uma consulta viva.
    expect(shopeeCodeSemPrefixoDeModulo('error_param')).toBeNull();
    expect(shopeeCodeSemPrefixoDeModulo('')).toBeNull();
    expect(shopeeCodeSemPrefixoDeModulo('.error_param')).toBeNull();
  });

  it('⛔ NEAR-MISS — o prefixo sendo o código INTEIRO (`product.`) devolve null', () => {
    expect(shopeeCodeSemPrefixoDeModulo('product.')).toBeNull();
    expect(shopeeCodeSemPrefixoDeModulo('a.')).toBeNull();
  });

  it('⛔ NEAR-MISS — remove UM segmento só, nunca de forma gulosa', () => {
    // Um `/^.*\./` faria qualquer SUFIXO casar: um código novo que só termine em
    // algo conhecido entraria numa escada à qual não pertence.
    expect(shopeeCodeSemPrefixoDeModulo('a.b.error_limit')).toBe('b.error_limit');
    expect(shopeeCodeSemPrefixoDeModulo('a.b.error_limit')).not.toBe('error_limit');
  });

  it('⛔ NEAR-MISS — só um módulo em minúsculas conta como prefixo', () => {
    expect(shopeeCodeSemPrefixoDeModulo('Product.error_limit')).toBeNull();
    expect(shopeeCodeSemPrefixoDeModulo('1product.error_limit')).toBeNull();
  });
});

describe('classifyShopeeError com prefixo de módulo', () => {
  it('T9 — PAR: `product.error_limit` classifica como daily, igual a `error_limit`', () => {
    // Sem a tolerância, a COTA DIÁRIA chegaria como falha comum, seria repetida
    // na hora e queimaria a escada até 00:00 (UTC+8).
    expect(classifyShopeeError('product.error_limit', SHOPEE_SURFACE.business)).toBe('daily');
    expect(classifyShopeeError('error_limit', SHOPEE_SURFACE.business)).toBe('daily');
    expect(classifyShopeeError('product.error_rate_limit', SHOPEE_SURFACE.business)).toBe('burst');
    expect(classifyShopeeError('product.error_server', SHOPEE_SURFACE.business)).toBe('transient');
  });

  it('T10 — ⛔ NEAR-MISS: `error.param` (o typo da Shopee) NÃO vira o código `param`', () => {
    // ⚠️ A string inteira é consultada PRIMEIRO, e o código lançado continua
    // verbatim. `error.param` aparece na lista de estoque do `add_item` com o
    // ponto no lugar do underscore; lê-lo como módulo `error` + código `param`
    // seria inventar um código que a Shopee nunca mandou.
    expect(classifyShopeeError('error.param', SHOPEE_SURFACE.business)).toBe('other');
    const err = shopeeErrorFromEnvelope(envelope('error.param'), {
      path: '/api/v2/product/add_item',
      httpStatus: 200,
      surface: SHOPEE_SURFACE.business,
    });
    expect(err.code).toBe('error.param');
    expect(err.kind).toBe('other');
  });

  it('T11 — ⛔ NEAR-MISS: `a.b.error_limit` continua `other` — só UM segmento sai', () => {
    expect(classifyShopeeError('a.b.error_limit', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('b.error_limit', SHOPEE_SURFACE.business)).toBe('daily');
  });

  it('T12 — `product.error_auth` é `other` num negócio e `reauth` no auth: o portão de superfície sobrevive ao corte', () => {
    // ⚠️ Num negócio, `error_auth` quer dizer *Invalid sign* — defeito NOSSO. Um
    // `reauth` aqui desconectaria uma conta saudável e a culpa pareceria da
    // Shopee. O prefixo não pode fazer o código escapar desse portão.
    expect(classifyShopeeError('product.error_auth', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('product.error_auth', SHOPEE_SURFACE.auth)).toBe('reauth');
    expect(
      classifyShopeeError(`media_space.${SHOPEE_AMBIGUOUS_AUTH_CODE}`, SHOPEE_SURFACE.auth),
    ).toBe('reauth');
  });

  it('T13 — `ShopeeApiError.code` guarda a string VERBATIM, com prefixo', () => {
    // O corte é uma consulta, nunca uma reescrita: o classificador de publicação
    // e todo log leem a string crua. Normalizá-la aqui faria um grep pelo que a
    // Shopee mandou não achar nada.
    const err = shopeeErrorFromEnvelope(envelope('product.error_limit'), {
      path: '/api/v2/product/add_item',
      httpStatus: 200,
      surface: SHOPEE_SURFACE.business,
      retryAfterSeconds: 60,
    });
    expect(err).toBeInstanceOf(ShopeeRateLimitError);
    expect(err.code).toBe('product.error_limit');
    expect(err.code).not.toBe('error_limit');
    expect(err.kind).toBe('daily');
  });

  it('T14 — `common.invalid_shop` continua `other`: o corte não fabrica entrada nenhuma', () => {
    // Anti-vacuidade. `invalid_shop` não está na tabela, e o corte não pode
    // colocá-lo lá por semelhança com `invalid_shop_id`.
    expect(classifyShopeeError('common.invalid_shop', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('product.error_busi', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('product.', SHOPEE_SURFACE.business)).toBe('other');
  });

  it('os dois erros de access_token do `upload_image` NÃO viram reauth num negócio', () => {
    // ⚠️ A página é `type=Public` e a lista dela traz
    // `error_param: There is no access_token in query.` e
    // `error_auth: Invalid access_token.` — numa chamada de negócio isso quer
    // dizer que o MODO DE ASSINATURA aqui está errado, não que a autorização do
    // vendedor morreu. Um `reauth` mandaria o operador reconectar uma conta sã.
    expect(classifyShopeeError('error_param', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('media_space.error_param', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('error_auth', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('media_space.error_auth', SHOPEE_SURFACE.business)).toBe('other');
  });
});

describe('shopeeErrorFromEnvelope', () => {
  it('returns the reauth subclass and preserves the code', () => {
    const err = shopeeErrorFromEnvelope(envelope('refresh_token_expired'), {
      path: '/api/v2/auth/access_token/get',
      httpStatus: 200,
      surface: SHOPEE_SURFACE.auth,
    });
    expect(err).toBeInstanceOf(ShopeeReauthRequiredError);
    expect(err.code).toBe('refresh_token_expired');
    expect(err.kind).toBe('reauth');
    expect(err.requestId).toBe('req-abc');
    expect(err.httpStatus).toBe(200);
  });

  it('returns the rate-limit subclass carrying retryAfterSeconds', () => {
    const err = shopeeErrorFromEnvelope(envelope('error_rate_limit'), {
      path: '/api/v2/shop/get_shop_info',
      httpStatus: 429,
      surface: SHOPEE_SURFACE.business,
      retryAfterSeconds: 12,
    });
    expect(err).toBeInstanceOf(ShopeeRateLimitError);
    expect((err as ShopeeRateLimitError).retryAfterSeconds).toBe(12);
    expect(err.kind).toBe('burst');
  });

  it('returns the plain ApiError for everything else', () => {
    const err = shopeeErrorFromEnvelope(
      envelope('error_param', { message: 'shop_id is required' }),
      {
        path: '/api/v2/shop/get_shop_info',
        httpStatus: 200,
        surface: SHOPEE_SURFACE.business,
      },
    );
    expect(err).toBeInstanceOf(ShopeeApiError);
    expect(err).not.toBeInstanceOf(ShopeeReauthRequiredError);
    expect(err).not.toBeInstanceOf(ShopeeRateLimitError);
    expect(err.message).toContain('error_param');
    expect(err.message).toContain('shop_id is required');
    expect(err.message).toContain('/api/v2/shop/get_shop_info');
  });

  it('omits the dash when Shopee sent no message', () => {
    const err = shopeeErrorFromEnvelope(envelope('error_server'), {
      path: '/p',
      httpStatus: 500,
      surface: SHOPEE_SURFACE.business,
    });
    expect(err.message).not.toContain('—');
    expect(err.kind).toBe('transient');
  });
});

/* -------------------------------------------------------------------------- */
/*     A lista de erros do `update_stock`, VERBATIM — e o que ela classifica    */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Toda grafia abaixo é a da PÁGINA, erro de digitação incluído: `upate`,
 * `cannt`, `cantnot`, e o `error.param` com PONTO no lugar do underscore.
 * "Corrigir" qualquer uma delas aqui faria o casamento parar de acontecer em
 * silêncio no dia em que alguém keyasse um mapa por estas strings.
 *
 * ⚠️ Superfície `business`: `update_stock` é uma chamada de negócio. É por isso
 * que `error_auth` — a grafia de DUAS das quatro do piso reservado — cai em
 * `'other'` aqui e em `'reauth'` no `auth`. Um `reauth` neste ponto mandaria o
 * operador reconectar uma conta perfeitamente saudável por causa de um estoque
 * abaixo do reservado.
 */
const CODIGOS_UPDATE_STOCK_OUTROS = [
  // --- o piso reservado: QUATRO grafias, duas famílias de código ------------
  'error_auth', // "Total stock must be more than reserved stock." / "Stock should be larger…"
  'error.param', // ⚠️ com PONTO — "Can not update item with stock less than reserved stock"
  'error_param', // "…less than reserve stock" (a segunda grafia de "reserved")
  // --- bloqueios de promoção (regime diferente do piso) --------------------
  'error_cannt_edit_stock_in_promotion',
  'error_promotion_cantnot_update_stock',
  'error_model_update_stock_model_in_promotion',
  'error_in_item_promotion_nomodel_to_models',
  // --- forma da loja / do item ---------------------------------------------
  'error_wms_shop_block_upate_stock',
  'error_busi_cannot_edit_vsku',
  'error_seller_under_penalty',
  'error_perm_non_admin',
  'error_item_uneditable',
  'error_edit_item_stock_for_item_has_model',
  // --- modo férias ----------------------------------------------------------
  'error_holiday_mode_change_stock',
  // --- falha por modelo -----------------------------------------------------
  'error_busi_update_stock_failed',
  // --- âncora perdida (a listagem sumiu ou não é nossa) ---------------------
  'error_item_not_belong_shop',
  'error_item_not_found',
  'error_param_shop_id_not_found',
  'error_nil_shopid_or_itemid',
  'error_shop',
  // --- estrutura de armazém -------------------------------------------------
  'error_busi',
  // --- o único código prefixado que a documentação mostra na forma do fio ---
  'product.cnsc_shop_block',
] as const;

describe('os códigos do `update_stock`, verbatim', () => {
  it.each(CODIGOS_UPDATE_STOCK_OUTROS)(
    'classifica %s como `other` numa chamada de negócio — nenhum deles entra na escada de retentativa',
    (code) => {
      expect(classifyShopeeError(code, SHOPEE_SURFACE.business)).toBe(SHOPEE_ERROR_KIND.other);
    },
  );

  it('⛔ ANTI-VACUIDADE — a mesma tabela ainda devolve os outros quatro veredictos', () => {
    // ⚠️ Sem este par, um `classifyShopeeError` que devolvesse a constante
    // `'other'` passaria por TODAS as linhas acima. O que a lista pina é que
    // esta página específica não tem nada na escada, não que a escada sumiu.
    expect(classifyShopeeError('error_limit', SHOPEE_SURFACE.business)).toBe('daily');
    expect(classifyShopeeError('error_rate_limit', SHOPEE_SURFACE.business)).toBe('burst');
    expect(classifyShopeeError('error_server', SHOPEE_SURFACE.business)).toBe('transient');
    expect(classifyShopeeError('error_network', SHOPEE_SURFACE.business)).toBe('transient');
    expect(classifyShopeeError('shop_banned', SHOPEE_SURFACE.business)).toBe('reauth');
    expect(classifyShopeeError('shop_no_linked', SHOPEE_SURFACE.business)).toBe('reauth');
  });

  it('`error_inner` e `error_system_busy` ficam FORA da tabela de propósito: no update_stock `error_inner` também quer dizer "Invalid stock location ID", um defeito PERMANENTE por item', () => {
    // ⚠️ C-i. Os dois estão na lista desta página com texto de erro interno
    // ("System error, please try again later"), o que convidaria a um
    // `transient` global. Mas `KIND_BY_CODE` vale para TODA operação do
    // monorepo, e aqui `error_inner` carrega uma segunda leitura documentada —
    // `Invalid stock location ID` — que nenhuma retentativa conserta. Um código
    // cuja classe depende da MENSAGEM não pode receber um `kind` global: quem
    // desambigua é o remetente, lendo a mensagem, e não esta tabela.
    expect(classifyShopeeError('error_inner', SHOPEE_SURFACE.business)).toBe(
      SHOPEE_ERROR_KIND.other,
    );
    expect(classifyShopeeError('error_system_busy', SHOPEE_SURFACE.business)).toBe(
      SHOPEE_ERROR_KIND.other,
    );
    // ⚠️ E nas duas superfícies, porque a tabela não tem portão de superfície
    // para eles — só `error_auth` tem.
    expect(classifyShopeeError('error_inner', SHOPEE_SURFACE.auth)).toBe('other');
    expect(classifyShopeeError('error_system_busy', SHOPEE_SURFACE.auth)).toBe('other');
    // O near-miss do mesmo raciocínio: `error_server` ESTÁ na tabela e continua
    // `transient`, embora esta página também o use para uma recusa permanente
    // ("The current item belong to the full FBS shop…"). A desambiguação por
    // mensagem é do remetente nos DOIS casos.
    expect(classifyShopeeError('error_server', SHOPEE_SURFACE.business)).toBe('transient');
  });

  it('`error.param` — o corte de prefixo ACONTECE e devolve `param`; o que segura o veredicto é a tabela não ter essa chave', () => {
    // ⚠️ A mecânica exata, pinada como ela é e não como seria confortável.
    // `shopeeCodeSemPrefixoDeModulo` casa `error.` como módulo e devolve
    // `param` — ele não sabe que esta grafia é um typo da Shopee. O que impede
    // a reclassificação é que a busca da string INTEIRA vem primeiro (e erra) e
    // `param` não é chave de `KIND_BY_CODE` (e erra também). Se alguém um dia
    // acrescentar `param:` à tabela, este teste fica vermelho — que é
    // exatamente o dia em que `error.param` viraria outro veredicto sem
    // ninguém pedir.
    expect(shopeeCodeSemPrefixoDeModulo('error.param')).toBe('param');
    expect(classifyShopeeError('error.param', SHOPEE_SURFACE.business)).toBe('other');
    // ⛔ QUASE-IGUAL: a grafia de underscore é uma chave de verdade, e as duas
    // chegam no MESMO veredicto por caminhos diferentes.
    expect(shopeeCodeSemPrefixoDeModulo('error_param')).toBeNull();
    expect(classifyShopeeError('error_param', SHOPEE_SURFACE.business)).toBe('other');
    // E o código lançado continua VERBATIM nas duas.
    const comPonto = shopeeErrorFromEnvelope(envelope('error.param'), {
      path: '/api/v2/product/update_stock',
      httpStatus: 200,
      surface: SHOPEE_SURFACE.business,
    });
    expect(comPonto.code).toBe('error.param');
    expect(comPonto.code).not.toBe('param');
  });
});

/* -------------------------------------------------------------------------- */
/*      `ShopeeApiPartialError` — a subclasse e a ORDEM da escada que a lê      */
/* -------------------------------------------------------------------------- */

/** Um braço de escada: o nome que ele responde e o `instanceof` que ele testa. */
type BracoDeEscada = readonly [nome: string, casa: (err: unknown) => boolean];

/**
 * Anda a escada EM ORDEM e devolve o nome do primeiro braço que casa — a forma
 * exata que um `if (err instanceof …) … else if …` tem, escrita de um jeito em
 * que a ORDEM é um dado e pode ser asserida.
 */
function primeiroBraco(escada: readonly BracoDeEscada[], err: unknown): string {
  for (const [nome, casa] of escada) if (casa(err)) return nome;
  return 'rethrow';
}

/** A ordem declarada: limite → reauth → parcial → base. */
const ESCADA_CORRETA: readonly BracoDeEscada[] = [
  ['limite', (err) => err instanceof ShopeeRateLimitError],
  ['reauth', (err) => err instanceof ShopeeReauthRequiredError],
  ['parcial', (err) => err instanceof ShopeeApiPartialError],
  ['base', (err) => err instanceof ShopeeApiError],
];

/** A mesma escada com a classe BASE no topo — o erro que engole as outras três. */
const ESCADA_INVERTIDA: readonly BracoDeEscada[] = [
  ['base', (err) => err instanceof ShopeeApiError],
  ['limite', (err) => err instanceof ShopeeRateLimitError],
  ['reauth', (err) => err instanceof ShopeeReauthRequiredError],
  ['parcial', (err) => err instanceof ShopeeApiPartialError],
];

const initBase = (code: string, kind: ShopeeErrorKind = SHOPEE_ERROR_KIND.other) => ({
  code,
  kind,
  httpStatus: 200,
  path: '/api/v2/product/update_stock',
});

describe('ShopeeApiPartialError', () => {
  it('é um ShopeeApiError e NÃO é um ShopeeRateLimitError', () => {
    const err = new ShopeeApiPartialError('x', {
      ...initBase('error_busi_update_stock_failed'),
      parsed: { response: { failure_list: [], success_list: [] } },
    });
    expect(err).toBeInstanceOf(ShopeeApiError);
    expect(err).toBeInstanceOf(ShopeeError);
    expect(err).not.toBeInstanceOf(ShopeeRateLimitError);
    expect(err).not.toBeInstanceOf(ShopeeReauthRequiredError);
    expect(err).not.toBeInstanceOf(ShopeeSchemaError);
    expect(err.name).toBe('ShopeeApiPartialError');
    expect(err.parsed).toEqual({ response: { failure_list: [], success_list: [] } });
    // Os carregadores opcionais seguem o padrão da base: `null`, nunca undefined.
    expect(err.requestId).toBeNull();
    expect(err.warning).toBeNull();
  });

  it('carrega exatamente a classificação que a base carregaria para o mesmo código', () => {
    // ⚠️ A subclasse não reclassifica nada. Ela é construída a partir do erro
    // que `shopeeErrorFromEnvelope` já montou, então `code`, `kind` e a mensagem
    // são os MESMOS — um segundo formatador aqui poderia divergir, e a única
    // coisa que não pode diferir entre as duas classes é como o mesmo envelope
    // se lê.
    const ctx = {
      path: '/api/v2/product/update_stock',
      httpStatus: 200,
      surface: SHOPEE_SURFACE.business,
    };
    const base = shopeeErrorFromEnvelope(envelope('error_busi_update_stock_failed'), ctx);
    const parcial = new ShopeeApiPartialError(base.message, {
      code: base.code,
      kind: base.kind,
      httpStatus: base.httpStatus,
      path: base.path,
      requestId: base.requestId,
      warning: base.warning,
      parsed: { ok: true },
    });
    expect(parcial.kind).toBe(classifyShopeeError(base.code, SHOPEE_SURFACE.business));
    expect(parcial.kind).toBe(base.kind);
    expect(parcial.code).toBe(base.code);
    expect(parcial.message).toBe(base.message);
  });

  it('PAR — na ordem declarada (limite → reauth → parcial → base) cada erro cai no SEU braço', () => {
    const parcial = new ShopeeApiPartialError('x', {
      ...initBase('error_busi_update_stock_failed'),
      parsed: {},
    });
    const limite = new ShopeeRateLimitError('x', {
      ...initBase('error_limit'),
      kind: SHOPEE_ERROR_KIND.daily,
    });
    const reauth = new ShopeeReauthRequiredError('x', {
      ...initBase('shop_banned', SHOPEE_ERROR_KIND.reauth),
    });
    const base = new ShopeeApiError('x', initBase('error_param'));

    expect(primeiroBraco(ESCADA_CORRETA, limite)).toBe('limite');
    expect(primeiroBraco(ESCADA_CORRETA, reauth)).toBe('reauth');
    expect(primeiroBraco(ESCADA_CORRETA, parcial)).toBe('parcial');
    expect(primeiroBraco(ESCADA_CORRETA, base)).toBe('base');
    // Quem não é dessa família nenhuma continua subindo.
    expect(
      primeiroBraco(
        ESCADA_CORRETA,
        new ShopeeSchemaError('x', { httpStatus: 200, path: '/api/v2/product/update_stock' }),
      ),
    ).toBe('rethrow');
  });

  it('⛔ QUASE-IGUAL — com a classe BASE no topo, a escada engole as TRÊS subclasses de uma vez', () => {
    // ⚠️ É a lição que `apps/shopee` já escreveu em três lugares: as quatro
    // classes estão numa cadeia `instanceof` só, e um `instanceof ShopeeApiError`
    // acima de qualquer braço específico casa primeiro. A subclasse nova é a
    // quarta ponta dessa armadilha — um limite de burst lido como "recusa
    // parcial" retentaria contra uma cota que só abre às 00:00 (UTC+8).
    const parcial = new ShopeeApiPartialError('x', {
      ...initBase('error_busi_update_stock_failed'),
      parsed: {},
    });
    const limite = new ShopeeRateLimitError('x', {
      ...initBase('error_rate_limit'),
      kind: SHOPEE_ERROR_KIND.burst,
    });
    const reauth = new ShopeeReauthRequiredError('x', {
      ...initBase('shop_banned', SHOPEE_ERROR_KIND.reauth),
    });

    expect(primeiroBraco(ESCADA_INVERTIDA, parcial)).toBe('base');
    expect(primeiroBraco(ESCADA_INVERTIDA, limite)).toBe('base');
    expect(primeiroBraco(ESCADA_INVERTIDA, reauth)).toBe('base');
    // O contraste é o ponto: os MESMOS três erros, a mesma escada, só a ordem
    // diferente.
    expect(primeiroBraco(ESCADA_CORRETA, parcial)).not.toBe('base');
    expect(primeiroBraco(ESCADA_CORRETA, limite)).not.toBe('base');
    expect(primeiroBraco(ESCADA_CORRETA, reauth)).not.toBe('base');
  });
});

describe('a classification key never carries a module prefix', () => {
  // ⚠️ Esta é a PREMISSA que torna a ordem das duas buscas de
  // `classifyShopeeError` (string cheia primeiro, depois a sem prefixo)
  // inobservável hoje: nenhuma chave da tabela tem ponto, então para um código
  // prefixado a primeira busca sempre erra e para um código nu a segunda nunca
  // acontece. Trocar a ordem não muda nada — e é exatamente por isso que uma
  // entrada com ponto, no dia em que alguém a acrescentar, tem de doer AQUI.
  const FONTE_ERROS = readFileSync(new URL('../src/errors.ts', import.meta.url), 'utf8');

  const tabela = (() => {
    const inicio = FONTE_ERROS.indexOf('const KIND_BY_CODE = new Map');
    const fim = FONTE_ERROS.indexOf('satisfies Record<string, ShopeeErrorKind>', inicio);
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    return FONTE_ERROS.slice(inicio, fim);
  })();

  const chaves = [...tabela.matchAll(/^\s{4}([^\s:]+):\s*SHOPEE_ERROR_KIND\./gm)].map((m) => m[1]!);

  it('ÂNCORA — a fatia lida é mesmo a tabela, com as chaves que ela tem hoje', () => {
    // Sem isto, um `indexOf` que deslizasse deixaria a asserção abaixo passar
    // sobre uma lista VAZIA.
    expect(chaves).toContain('refresh_token_expired');
    expect(chaves).toContain('error_limit');
    expect(chaves.length).toBeGreaterThanOrEqual(14);
  });

  it('nenhuma chave da tabela tem `.` — e por isso as duas grafias concordam', () => {
    expect(chaves.filter((chave) => chave.includes('.'))).toEqual([]);
    for (const chave of chaves) {
      expect(classifyShopeeError(`product.${chave}`, SHOPEE_SURFACE.business)).toBe(
        classifyShopeeError(chave, SHOPEE_SURFACE.business),
      );
    }
  });
});
