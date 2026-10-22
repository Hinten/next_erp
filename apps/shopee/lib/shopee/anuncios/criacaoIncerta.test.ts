import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ADD_ITEM_PATH,
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeOperacaoNaoServidaError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeeAddItemRequest,
  type ShopeeClient,
  classifyShopeeError,
  createShopeeClient,
  resolveShopeeHosts,
  shopeeErrorFromEnvelope,
} from '@delfrance/integrations-shopee';

import { codigoCanonicoShopee, fraseCanonicaShopee } from '../core/recusaShopee';
import { MOTIVO_RECUSA_KIT_TRANSITORIO, TABELA_RECUSA_KIT } from '../kits/recusaKit';
import {
  INCERTEZAS_DOCUMENTADAS_ADD_ITEM,
  RECUSAS_DETERMINISTICAS_ADD_ITEM,
  desfechoDeCriacaoDeItem,
  incertezaDocumentadaDeAddItem,
  recusaDeterministicaDeAddItem,
  type DesfechoDeCriacaoDeItem,
  type LinhaCriacaoDeItem,
} from './criacaoIncerta';
import { MOTIVO_PROBLEMA_PUBLICACAO, MOTIVO_PUBLICACAO_BLOQUEADA } from './errosPublicacao';
import { FRASE_TABELA_MEDIDAS_FOTO_RECUSADA } from './problemasPublicacao';

/* -------------------------------------------------------------------------- */
/*  A página é a fixture                                                       */
/* -------------------------------------------------------------------------- */

const N = 'nao-criado' as const satisfies DesfechoDeCriacaoDeItem;
const I = 'incerto' as const satisfies DesfechoDeCriacaoDeItem;

type LinhaDaPagina = readonly [codigo: string, frase: string, esperado: DesfechoDeCriacaoDeItem];

/**
 * As DUAS listas de erro da página do `add_item`, VERBATIM — código e frase
 * como a Shopee os imprime (os erros de digitação dela inclusos: `becasue`,
 * `Interal`, `filed`, `error_incalid_*`, `error.param`), cada par
 * `(código, frase)` uma vez, com a classe que este PR decidiu para ele.
 *
 * Fonte: `node .master_plans/shopee/shopee-doc.mjs api v2.product.add_item`
 * (cache lido em 2026-10-22; topo do update log: 2026-09-01). O cache é
 * gitignorado, por isso a cópia commitada mora AQUI — e a página tem 147
 * linhas na lista específica (24 repetidas, ex.: onze `error_check_luc_fail`)
 * e 35 na comum.
 */
const PAGINA_ESPECIFICOS: readonly LinhaDaPagina[] = [
  ['product.error_busi', 'The GTIN code is mandatory, please check and upload again.', N],
  [
    'product.error_busi',
    'Please input the correct TS Mark (TD Mark) to upload your product, and refer to the SEH article - https://seller.shopee.tw/edu/article/19732 if you have any questions.',
    N,
  ],
  ['product.error_busi', 'Medicine ID is mandatory for products in Prescription/OTC category.', N],
  ['product.error_busi', 'Please input the correct medicine ID.', N],
  [
    'product.error_busi',
    'For OTC medicine, maximum purchase limit per order is mandatory and cannot exceed 3 days of use.',
    N,
  ],
  ['product.error_busi', 'Upload failed, please upload a more standard size chart image.', N],
  [
    'product.error_busi',
    'Please input the tax information becasue the shop is invoice issued by Shopee',
    N,
  ],
  ['error_network', 'Inner http call failed', I],
  ['error_data', 'parse data failed', N],
  ['error_data', 'data not exist', N],
  ['error_param', 'parameter invalid', N],
  ['error_param', 'The information you queried is not found.', N],
  ['error_param', 'Wrong parameters, detail: {msg}.', N],
  ['error_server', 'Something wrong. Please try later.', I],
  ['error_shop', 'shopid is invalid', N],
  ['error_param', 'request not from gateway', N],
  ['error_auth_shop_not_found', 'Shop is not found.', N],
  ['error_auth', 'cnsc shop not upgraded, can not edit item.', N],
  ['error_param_shop_id_not_found', 'Shop_id is not found.', N],
  ['error_param', '[Gateway] illegal request.', N],
  ['error_param', 'Invalid logistic info, {{.error_info}}', N],
  ['error_param', 'Invalid category.', N],
  ['error_param', 'Invalid attribute. {{.error_info}}', N],
  ['error_param', 'Invalid wholesale setting.', N],
  ['error_param', 'Parameter is not match the constraints, {{.error_info}}.', N],
  ['error_param', 'Invalid Weight.', N],
  ['error_param', 'Image not exist.', N],
  ['error_invalid_days_to_ship', 'Invalid days_to_ship.', N],
  ['error_value_name_required', 'Value_name is required.', N],
  ['error_value_id_must_equal_zero', 'Value_id must equal 0.', N],
  ['error_invalid_category_attribute', 'Category and attribute not match.', N],
  ['error_busi', 'logistic must be free', N],
  ['error_invalid_brand', 'Invalid brand', N],
  ['error_invalid_brand', 'Brand ID value should be "0".', N],
  ['error_invalid_brand', 'Brand name required', N],
  ['error_invalid_brand', 'Brand ID required', N],
  ['error_incalid_brand', 'Brand ID or brand name required', N],
  ['error_invalid_attribute', 'Mandatory attribute information required', N],
  ['error_invalid_brand', 'Brand information required', N],
  ['error_param', 'dimension is required', N],
  ['error_param', 'invalid additional information', N],
  ['error_param', 'all BR tax field should be empty or be filled at same time', N],
  ['error_get_shop_fail', 'Get shop failed. please try later.', I],
  ['error_busi_add_item_failed', 'Add item failed. please try later {{.error_info}}.', I],
  ['error_busi_invalid_shop_status', 'Shop status invalid.', N],
  ['error_busi_invalid_account_status', 'Account status is invalid.', N],
  ['error_invalid_category', 'Invalid category ID {{.error_info}}', N],
  ['error_busi_attribute_error', 'Attribute NCC value is invalid', N],
  ['error_busi_attribute_error', 'Attribute NCC is mandatory', N],
  ['error_busi_attribute_error', 'Attribute BSMI value is invalid', N],
  ['error_busi_attribute_error', 'Attribute BSMI is mandatory', N],
  ['error_attribute_fda_error', 'Attribute FDA value is invalid', N],
  ['error_inner', 'Our system is taking some time to respond, please try later.', I],
  ['error_inner', 'System error, please try again later or contact the OpenAPI support team.', I],
  ['error_unknown', '{{.error_info}}', I],
  ['error_item_not_found', 'Product not found', I],
  ['error_check_luc_fail', '{{.error_info}}', N],
  ['error_repeated_mtsku', 'A similar product has already been uploaded', N],
  ['error_invalid_price', 'Invalid price, please use the correct format', N],
  ['error_category_is_block', 'Category is restricted', N],
  ['error_less_required_attribute', 'Mandatory attribute information required', N],
  ['error_less_required_brand', 'Brand information required', N],
  ['error_inner', 'Update item failed {{.error_info}}', I],
  ['error_param', 'Attribute format is invalid. NCC field only allows Eng Alphanumeric input', N],
  ['error_param', 'NCC filed only allows character length less than 50.', N],
  [
    'error_unlist_item_fail',
    'Please upload your products to UNLIST status. Products will be published automatically by Shopee at the official launch date.',
    N,
  ],
  ['error_invalid_logistic_info', 'invalid logistic info , {{.error_info}}', N],
  [
    'error_invalid_price_for_logistic',
    'Shipping channel cannot be enabled as product price exceeds limit.',
    N,
  ],
  [
    'error_auth',
    'The current item belong to the full FBS or B2C shop, so normal stock must be equal to 0',
    N,
  ],
  ['error_param_validate', 'This is not a valid GTIN. Please, inform a valid number.', N],
  ['error_desc_image_no_pass', '{{.error_info}}', N],
  [
    'error_busi_cannot_edit_vsku',
    'Can not use OpenAPI to edit/create VSKU, please connect with your manager',
    N,
  ],
  [
    'error_auth',
    "The location_id input is not matched the shop's location_id(more/wrong). Please double check.",
    N,
  ],
  ['error_auth', 'Lack of location_id, please double check.', N],
  ['error_auth', 'Please wait for the holiday mode set then to edit item. Please try later.', N],
  ['error_auth', 'Total stock must be more than reserved stock.', N],
  ['error_param', '{{.error_info}}', N],
  ['error_param_validate', 'Wholesale cannot be used in this category and attributes.', N],
  ['error_auth', 'Your shop can not use model level dts', N],
  [
    'error_auth',
    'You do not have right to use seller location_id, please only fill seller_stock filed.',
    N,
  ],
  ['error.param', 'Can not update item with stock less than reserved stock', N],
  ['error_inner', 'Invalid stock location ID', N],
  [
    'error_param',
    'Can not update item with different stock structure. Can only update seller stock with location id when existing seller stock have location id. Can only update seller stock without location id when existing seller stock without location id.',
    N,
  ],
  ['error_param', 'Can not update item with stock less than reserve stock', N],
  ['error_busi', 'The merchant/shop has multi warehouse, please input location id', N],
  ['error_auth', 'Stock should be larger than reserved stock.', N],
  ['error_incalid_brand', '{{.error_info}}', N],
  ['error_duplicated_brand', 'Brand already exists', N],
  ['error_marshal', 'Interal error, please contact openapi team', I],
  ['error_param', 'Invalid parameter for product.', N],
  ['error_system_busy', 'Our system is taking some time to respond, please try later.', I],
  ['error_image_unavailable', 'Image is invalid: single image url length is less than 32.', N],
  ['error_reach_shop_item_limit', 'Item published item count reaches limit.', N],
  ['error_name_length_limit', 'Exceeded item_name length limitation.', N],
  ['error_nil_shopid_or_itemid', 'Query information failed.', N],
  ['error_desc_hash_tag_over_limit', 'Count of hash tags is more than 18', N],
  ['error_item_name_empty', 'Item name could not be empty.', N],
  ['error_holiday_on_add_item', 'Shop is under vocation mode.', N],
  ['error_nil_name_new_item', 'Item_name cannot be empty.', N],
  ['error_item_name_is_too_short', 'Item_name length is less than min limit.', N],
  ['error_title_exceeds_max_length', 'The length of item_name is bigger than max limit.', N],
  ['error_title_character_forbidden', 'Item_name contains forbidden characters.', N],
  ['error_desc_length_min_limit', 'Description length is less than the min limit.', N],
  ['error_image_num_min', '{{.error_info}}', N],
  ['error_forbidden_category', 'The category is forbidden.', N],
  ['error_brand_forbidden', 'The brand is forbidden.', N],
  ['error_param_dts_exceeds_max_limit', 'Days_to_ship exceeds max limit', N],
  ['error_price_exceed_min_limitt', 'Original_price is less than min price limit.', N],
  ['error_price_exceed_max_limitt', 'Original_price is bigger than max price limit.', N],
  ['error_wholesale_price_less_than_ratio_limit', 'Wholesale price is less than ratio limit.', N],
  ['error_param_category_not_support_pre_order', 'Category does not support pre-order.', N],
  ['error_invalid_attribute_value', 'Invalid attribute value.', N],
  ['error_wrong_attrsnapshot', 'Invalid attribute.', N],
  ['error_category_level', 'Interal error, please contact openapi team.', I],
  ['error_category_path_count_limit', 'Interal error, please contact openapi team.', I],
  ['error_server', 'Interal error, please contact openapi team.', I],
  ['error_invalid_category', 'Invalid category.', N],
  ['error_incalid_category', 'Category IDs for L1 and L2 do not match.', N],
  ['error_category_dts', "The current day_to_ship is bigger than category's max days_to_ship.", N],
  ['error_invalid_category', 'Category is blocked for CB seller.', N],
  ['error_whole_sale_min_count_incorrect', 'Interal error, please contact openapi team.', I],
  [
    'error_whole_sale_price_setting_incorrect',
    "Wholesale price can't more than original price.",
    N,
  ],
  ['error_video_info_not_found', 'Video_info not found.', N],
];

/** A lista COMUM — a mesma em toda página da API. */
const PAGINA_COMUNS: readonly LinhaDaPagina[] = [
  ['error_auth', 'partner_id is invalid', N],
  ['error_auth', "The App is deleted, and you'll be unable to make any API call.", N],
  [
    'error_auth',
    'App developer’s permissions for authorizations have been restricted. If you’re a seller, contact the developer for more information. If you’re the developer, refer to the Open Platform Console for details.',
    N,
  ],
  ['error_param', 'There is no partner_id in query.', N],
  ['error_param', 'Invalid partner_id.', N],
  ['error_param', 'no timestamp', N],
  ['error_param', 'Invalid timestamp', N],
  ['error_param', 'There is no sign in query.', N],
  ['error_sign', 'Wrong sign.', N],
  ['invalid_partner_id', 'Invalid partner_id, please have a check.', N],
  ['error_auth', 'No permission to current api.', N],
  [
    'error_api_call_restricted',
    'The App permission for api call have been restricted. If you’re a seller, contact the developer for more information. If you’re the developer, refer to the Open Platform Console for details.',
    N,
  ],
  ['api_suspended', 'The API is offline. Please call v2 API instead.', N],
  [
    'error_limit',
    'The total API call number made by your APP has reached the daily API call limit, please try again after 00: 00 (UTC+08:00)',
    N,
  ],
  [
    'error_rate_limit',
    'Too many requests. You have reached the rate limit. Please try again later.',
    N,
  ],
  [
    'source_ip_undeclared',
    'Request Source IP ({ip}) is undeclared. Please declare all your IP addresses in the Shopee Open Platform Console > App list > IP Address Whitelist',
    N,
  ],
  [
    'error_param',
    'Permission denied. This API is currently offline or the request path is incorrect.',
    N,
  ],
  ['error_param', 'Partner_id is invalid, should be an integer between 0 and 4294967295.', N],
  ['error_param', 'no timestamp.', N],
  ['error_param', 'Timestamp is invalid, should be an integer between 0 and 4294967295.', N],
  ['error_param', 'Timestamp is expired.', N],
  [
    'error_partner_key_expired',
    'Your API partner key has expired, please reset the Live API Partner Key in Console to get a new valid partner key to call open api.',
    N,
  ],
  ['error_api_permission', 'This app type has no permission to this API.', N],
  ['error_param', 'There is no access_token in query.', N],
  ['error_auth', 'Invalid access_token.', N],
  ['error_auth', 'Invalid partner_id or shopid.', N],
  ['shop_no_linked', 'Partner and shop has no linked.', N],
  [
    'shop_banned',
    'The shop account has been banned. Permissions for shop authorization and API calls have been suspended until the shop account is restored.',
    N,
  ],
  ['invalid_acceess_token', 'Invalid access_token, please have a check.', N],
  ['partner_shop_no_link', 'Invalid partner_id or shop_id, please have a check.', N],
  [
    'error_ashop_api_permission',
    'The shop is Affiliate shop has no permission to call this API.',
    N,
  ],
  [
    'error_kyc_auth',
    'No permission. Please inform the seller to complete the Seller Registration on Shopee Seller Center first, then this shop can call for this API.',
    N,
  ],
  ['error_auth', 'System error, please try again later.', I],
  ['error_param', 'There is no shop_id in query.', N],
  ['error_param', 'shop_id is invalid, should be an integer between 0 and 4294967295.', N],
];

const PAGINA: readonly LinhaDaPagina[] = [...PAGINA_ESPECIFICOS, ...PAGINA_COMUNS];

/** O erro que o transporte REALMENTE constrói para um envelope (HTTP 200, chamada de negócio). */
function doEnvelope(error: string, message: string | null): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path: SHOPEE_ADD_ITEM_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

/**
 * A OUTRA grafia do mesmo código que a Shopee também imprime: `product.<x>` ⟷
 * `<x>`. `error.param` (o ponto é da própria Shopee) não tem outra.
 */
function outraGrafia(codigo: string): string | null {
  if (codigo.startsWith('product.')) return codigo.slice('product.'.length);
  return codigo.includes('.') ? null : `product.${codigo}`;
}

/** TODAS as linhas de `tabela` que casam com `err` — a contagem que a busca do módulo esconde. */
function linhasQueCasam(
  tabela: readonly LinhaCriacaoDeItem[],
  err: ShopeeApiError,
): readonly LinhaCriacaoDeItem[] {
  const codigo = codigoCanonicoShopee(err.code);
  const frase = fraseCanonicaShopee(err.providerMessage);
  return tabela.filter(
    (l) => l.codigo === codigo && (l.agulha === null || frase.includes(l.agulha)),
  );
}

/** Um erro que não é da Shopee tem de SAIR do classificador, o mesmo objeto. */
function relancado(err: unknown): Promise<unknown> {
  return Promise.resolve().then(() => desfechoDeCriacaoDeItem(err));
}

describe('a página do `add_item` é a fixture (rev. 2, K1-1)', () => {
  it('ÂNCORA: as duas listas, deduplicadas, inteiras', () => {
    expect(PAGINA_ESPECIFICOS).toHaveLength(123);
    expect(PAGINA_COMUNS).toHaveLength(35);
    const chaves = PAGINA.map(([c, f]) => `${c}\u0000${f}`);
    expect(new Set(chaves).size).toBe(PAGINA.length);
    // As classes que a página reparte — um recorte que mude de lado aparece aqui.
    expect(PAGINA.filter(([, , e]) => e === I)).toHaveLength(16);
  });

  it('CADA (código, frase) documentada cai na SUA classe — nas duas grafias do código', () => {
    const errados: string[] = [];
    for (const [codigo, frase, esperado] of PAGINA) {
      for (const grafia of [codigo, outraGrafia(codigo)]) {
        if (grafia === null) continue;
        const obtido = desfechoDeCriacaoDeItem(doEnvelope(grafia, frase));
        if (obtido !== esperado) errados.push(`${grafia}: ${frase} → ${obtido}`);
      }
    }
    expect(errados).toEqual([]);
  });

  it('cada linha `nao-criado` tem UM dono: a CLASSE do pacote, ou exatamente UMA linha da tabela', () => {
    for (const [codigo, frase, esperado] of PAGINA) {
      const err = doEnvelope(codigo, frase);
      const recusas = linhasQueCasam(RECUSAS_DETERMINISTICAS_ADD_ITEM, err);
      const incertezas = linhasQueCasam(INCERTEZAS_DOCUMENTADAS_ADD_ITEM, err);
      const daClasse =
        err instanceof ShopeeRateLimitError || err instanceof ShopeeReauthRequiredError;
      if (esperado === N) {
        // A classe decide sozinha — a tabela não tem linha para ela.
        expect(recusas, `${codigo}: ${frase}`).toHaveLength(daClasse ? 0 : 1);
        expect(incertezas, `${codigo}: ${frase}`).toEqual([]);
      } else {
        // Uma frase incerta nunca é casada por uma recusa; nem é da classe.
        expect(recusas, `${codigo}: ${frase}`).toEqual([]);
        expect(daClasse, `${codigo}: ${frase}`).toBe(false);
      }
    }
  });

  it('toda linha das duas tabelas é alcançada por uma linha DOCUMENTADA — nenhuma foi inventada', () => {
    const erros = PAGINA.map(([codigo, frase]) => doEnvelope(codigo, frase));
    const recusasSemPagina = RECUSAS_DETERMINISTICAS_ADD_ITEM.filter(
      (linha) => !erros.some((err) => recusaDeterministicaDeAddItem(err) === linha),
    ).map((l) => l.rotulo);
    expect(recusasSemPagina).toEqual([]);
    const incertezasSemPagina = INCERTEZAS_DOCUMENTADAS_ADD_ITEM.filter(
      (linha) => !erros.some((err) => incertezaDocumentadaDeAddItem(err) === linha),
    ).map((l) => l.rotulo);
    expect(incertezasSemPagina).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  A higiene das tabelas                                                      */
/* -------------------------------------------------------------------------- */

describe('as tabelas — fechadas, alcançáveis, sem motivo soletrado', () => {
  const TODAS = [...RECUSAS_DETERMINISTICAS_ADD_ITEM, ...INCERTEZAS_DOCUMENTADAS_ADD_ITEM];

  it('todo código e toda agulha já estão DOBRADOS (ponto fixo da dobra) e nenhuma agulha é vazia', () => {
    for (const linha of TODAS) {
      expect(codigoCanonicoShopee(linha.codigo), linha.rotulo).toBe(linha.codigo);
      if (linha.agulha === null) continue;
      expect(linha.agulha, linha.rotulo).not.toBe('');
      expect(fraseCanonicaShopee(linha.agulha), linha.rotulo).toBe(linha.agulha);
    }
  });

  it('os rótulos são únicos e NENHUM é a grafia de um motivo (O7 contaria o rótulo como produtor)', () => {
    const rotulos = TODAS.map((l) => l.rotulo);
    expect(new Set(rotulos).size).toBe(rotulos.length);
    const slugs = new Set<string>([
      ...Object.values(MOTIVO_PUBLICACAO_BLOQUEADA),
      ...Object.values(MOTIVO_PROBLEMA_PUBLICACAO),
    ]);
    expect(slugs.size).toBeGreaterThan(50);
    for (const rotulo of rotulos) {
      expect(slugs.has(rotulo), rotulo).toBe(false);
      // A forma que nenhum slug tem — um sublinhado ou uma barra.
      expect(/[_/]/.test(rotulo), rotulo).toBe(true);
    }
  });

  it('o FONTE não soletra motivo algum — nem entre aspas, nem pela constante', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./criacaoIncerta.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte).toContain('RECUSAS_DETERMINISTICAS_ADD_ITEM');
    expect(fonte).not.toContain('MOTIVO_PUBLICACAO_BLOQUEADA.');
    expect(fonte).not.toContain('MOTIVO_PROBLEMA_PUBLICACAO.');
    const slugs = [
      ...Object.values(MOTIVO_PUBLICACAO_BLOQUEADA),
      ...Object.values(MOTIVO_PROBLEMA_PUBLICACAO),
    ];
    const soletrados = slugs.filter((s) => fonte.includes(`'${s}'`) || fonte.includes(`"${s}"`));
    expect(soletrados).toEqual([]);
  });

  it('uma linha só de CÓDIGO é a única do seu código; dentro de um código nenhuma agulha contém outra', () => {
    for (const tabela of [RECUSAS_DETERMINISTICAS_ADD_ITEM, INCERTEZAS_DOCUMENTADAS_ADD_ITEM]) {
      for (const linha of tabela) {
        const doCodigo = tabela.filter((l) => l.codigo === linha.codigo);
        if (linha.agulha === null) {
          expect(doCodigo, linha.rotulo).toEqual([linha]);
          continue;
        }
        for (const outra of doCodigo) {
          if (outra === linha || outra.agulha === null) continue;
          expect(linha.agulha.includes(outra.agulha), `${linha.rotulo} ⊇ ${outra.rotulo}`).toBe(
            false,
          );
        }
      }
    }
  });

  it('uma INCERTEZA só existe onde o código também tem recusas por FRASE — e nunca esconde uma delas', () => {
    for (const incerteza of INCERTEZAS_DOCUMENTADAS_ADD_ITEM) {
      expect(incerteza.agulha, incerteza.rotulo).not.toBeNull();
      const recusas = RECUSAS_DETERMINISTICAS_ADD_ITEM.filter((l) => l.codigo === incerteza.codigo);
      expect(recusas.length, incerteza.rotulo).toBeGreaterThan(0);
      for (const recusa of recusas) {
        // Uma recusa só-de-código nesse código faria da incerteza a única voz;
        // uma agulha de recusa que CONTIVESSE a incerteza nunca seria alcançada.
        expect(recusa.agulha, recusa.rotulo).not.toBeNull();
        expect(
          (recusa.agulha ?? '').includes(incerteza.agulha ?? ''),
          `${recusa.rotulo} ⊇ ${incerteza.rotulo}`,
        ).toBe(false);
      }
    }
  });

  it('nenhum código das tabelas é da escada de taxa ou de reautorização — essas a CLASSE decide', () => {
    for (const linha of TODAS) {
      expect(classifyShopeeError(linha.codigo, SHOPEE_SURFACE.business), linha.rotulo).toBe(
        SHOPEE_ERROR_KIND.other,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Os pares do rev. 2 (§3 P3)                                                 */
/* -------------------------------------------------------------------------- */

describe('os PARES e QUASE-ACERTOS do rev. 2', () => {
  it('`error_inner` "taking some time" ⇒ incerto ⟷ `error_inner` "Invalid stock location ID" ⇒ nao-criado', () => {
    expect(
      desfechoDeCriacaoDeItem(
        doEnvelope('error_inner', 'Our system is taking some time to respond, please try later.'),
      ),
    ).toBe(I);
    expect(desfechoDeCriacaoDeItem(doEnvelope('error_inner', 'Invalid stock location ID'))).toBe(N);
  });

  it('`error_auth` férias ⇒ nao-criado ⟷ `error_auth` "System error" ⇒ incerto', () => {
    expect(
      desfechoDeCriacaoDeItem(
        doEnvelope(
          'error_auth',
          'Please wait for the holiday mode set then to edit item. Please try later.',
        ),
      ),
    ).toBe(N);
    expect(
      desfechoDeCriacaoDeItem(doEnvelope('error_auth', 'System error, please try again later.')),
    ).toBe(I);
  });

  it('um código DESCONHECIDO ⇒ incerto — mesmo com o prefixo e com uma frase de validação', () => {
    for (const codigo of ['error_xyz', 'product.error_xyz', 'error_novo_da_shopee']) {
      expect(desfechoDeCriacaoDeItem(doEnvelope(codigo, 'Invalid category.')), codigo).toBe(I);
      expect(desfechoDeCriacaoDeItem(doEnvelope(codigo, null)), codigo).toBe(I);
    }
  });

  it('FECHADA: um irmão não documentado de uma família documentada ⇒ incerto (sem prefixos)', () => {
    // Os pares: os documentados da mesma família são `nao-criado`.
    expect(desfechoDeCriacaoDeItem(doEnvelope('error_invalid_brand', 'Invalid brand'))).toBe(N);
    expect(desfechoDeCriacaoDeItem(doEnvelope('error_title_exceeds_max_length', null))).toBe(N);
    expect(desfechoDeCriacaoDeItem(doEnvelope('error_param_validate', null))).toBe(N);
    for (const irmao of [
      'error_invalid_cor',
      'error_title_too_short',
      'error_param_novo',
      'error_less_required_size_chart',
      'error_nil_model',
    ]) {
      expect(desfechoDeCriacaoDeItem(doEnvelope(irmao, 'Invalid brand')), irmao).toBe(I);
    }
  });

  it('`error_busi` com uma frase que a tabela não tem ⇒ incerto ⟷ a do GTIN ⇒ nao-criado', () => {
    expect(
      desfechoDeCriacaoDeItem(doEnvelope('product.error_busi', 'Something about the listing.')),
    ).toBe(I);
    expect(desfechoDeCriacaoDeItem(doEnvelope('product.error_busi', null))).toBe(I);
    expect(
      desfechoDeCriacaoDeItem(
        doEnvelope(
          'product.error_busi',
          'The GTIN code is mandatory, please check and upload again.',
        ),
      ),
    ).toBe(N);
  });

  it('AGULHAS ESTREITAS: frases-irmãs que dividem palavras com uma recusa documentada ⇒ incerto', () => {
    // Cada uma partilha um trecho com uma linha da tabela — o começo, o fim ou
    // o meio. Uma agulha alargada até esse trecho as leria como `nao-criado`.
    const irmas: readonly (readonly [string, string])[] = [
      // "Upload failed" sozinho é o começo da frase da foto da tabela de medidas.
      ['product.error_busi', 'Upload failed, please try again later.'],
      ['product.error_busi', 'Please input the correct information.'],
      ['product.error_busi', 'The GTIN code is being validated, please try later.'],
      ['product.error_busi', 'Medicine ID is being checked.'],
      ['error_busi', 'logistic is unavailable, please try later'],
      ['error_busi', 'The merchant/shop is busy, please try later'],
      ['error_auth', 'Please try later.'],
      ['error_auth', 'Please double check.'],
      ['error_auth', 'Invalid partner_id'],
      ['error_auth', 'The App is temporarily unavailable.'],
      ['error_auth', 'Stock is being updated, please wait.'],
      ['error_inner', 'Invalid stock'],
      ['error_inner', 'Invalid location ID'],
      ['error.param', 'Can not update item'],
    ];
    for (const [codigo, frase] of irmas) {
      expect(desfechoDeCriacaoDeItem(doEnvelope(codigo, frase)), `${codigo}: ${frase}`).toBe(I);
    }
  });

  it('a foto da tabela de medidas usa a frase do classificador do passo 11 — UMA grafia no app', () => {
    const linha = RECUSAS_DETERMINISTICAS_ADD_ITEM.find(
      (l) => l.rotulo === 'error_busi/foto-da-tabela',
    );
    expect(linha?.agulha).toBe(fraseCanonicaShopee(FRASE_TABELA_MEDIDAS_FOTO_RECUSADA));
  });

  it('a instabilidade MEDIDA no kit (`error_busi` "Too many connections") ⇒ incerto — a linha do KIT, importada', () => {
    const transitorias = TABELA_RECUSA_KIT.filter((l) =>
      MOTIVO_RECUSA_KIT_TRANSITORIO.has(l.motivo),
    );
    expect(transitorias.length).toBeGreaterThan(0);
    for (const linha of transitorias) {
      const err = doEnvelope(`product.${linha.codigo}`, linha.agulha ?? 'qualquer frase');
      expect(desfechoDeCriacaoDeItem(err), linha.rotulo).toBe(I);
    }
    // A frase real da sonda, com o resto do texto do banco.
    expect(
      desfechoDeCriacaoDeItem(doEnvelope('product.error_busi', 'Error 1040: Too many connections')),
    ).toBe(I);
  });
});

describe('o INCERTO vence — uma frase com as duas agulhas do mesmo código (a regra do kit)', () => {
  it('cada incerteza × cada recusa por frase do MESMO código ⇒ incerto; a recusa sozinha ⇒ nao-criado', () => {
    let pares = 0;
    for (const incerteza of INCERTEZAS_DOCUMENTADAS_ADD_ITEM) {
      for (const recusa of RECUSAS_DETERMINISTICAS_ADD_ITEM) {
        if (recusa.codigo !== incerteza.codigo || recusa.agulha === null) continue;
        pares += 1;
        const so = doEnvelope(recusa.codigo, recusa.agulha);
        expect(desfechoDeCriacaoDeItem(so), recusa.rotulo).toBe(N);
        for (const frase of [
          `${recusa.agulha} — ${incerteza.agulha ?? ''}`,
          `${incerteza.agulha ?? ''}: ${recusa.agulha}`,
        ]) {
          expect(
            desfechoDeCriacaoDeItem(doEnvelope(recusa.codigo, frase)),
            `${incerteza.rotulo} + ${recusa.rotulo}`,
          ).toBe(I);
        }
      }
    }
    // `error_auth` 15 × 1 + `error_inner` 1 × 3.
    expect(pares).toBe(18);
  });

  it('`error_busi`: cada recusa por frase + "Too many connections" ⇒ incerto', () => {
    const recusasBusi = RECUSAS_DETERMINISTICAS_ADD_ITEM.filter((l) => l.codigo === 'error_busi');
    expect(recusasBusi).toHaveLength(9);
    for (const recusa of recusasBusi) {
      const frase = `${recusa.agulha ?? ''}. Error 1040: Too many connections`;
      expect(desfechoDeCriacaoDeItem(doEnvelope('product.error_busi', frase)), recusa.rotulo).toBe(
        I,
      );
    }
  });

  it('"Update item failed" + a frase do estoque, no `error_inner` ⇒ incerto (pode ter criado e falhado depois)', () => {
    expect(
      desfechoDeCriacaoDeItem(
        doEnvelope('error_inner', 'Update item failed Invalid stock location ID'),
      ),
    ).toBe(I);
  });
});

/* -------------------------------------------------------------------------- */
/*  O escopo das duas dobras                                                   */
/* -------------------------------------------------------------------------- */

describe('o ESCOPO das duas dobras — o que é IGUAL e o que fica DISTINTO', () => {
  it('IGUAL: as grafias do código que a dobra do pacote junta', () => {
    for (const codigo of [
      'error_param',
      'product.error_param',
      ' product.error_param\t',
      'error_param ',
    ]) {
      expect(desfechoDeCriacaoDeItem(doEnvelope(codigo, 'Invalid Weight.')), codigo).toBe(N);
    }
  });

  it('DISTINTO: caixa, dois segmentos e um sufixo mais longo NÃO são `error_param`', () => {
    for (const codigo of [
      'Error_Param',
      'ERROR_PARAM',
      'a.b.error_param',
      'error_param_',
      'xerror_param',
    ]) {
      expect(desfechoDeCriacaoDeItem(doEnvelope(codigo, 'Invalid Weight.')), codigo).toBe(I);
    }
  });

  it('IGUAL: espaços, caixa, o prefixo "Wrong parameters, detail:" e os pontos finais da FRASE', () => {
    for (const frase of [
      'INVALID STOCK LOCATION ID',
      'Wrong parameters, detail: Invalid stock location ID..',
      '  Invalid   stock\nlocation ID ',
    ]) {
      expect(desfechoDeCriacaoDeItem(doEnvelope('error_inner', frase)), frase).toBe(N);
    }
    expect(
      desfechoDeCriacaoDeItem(
        doEnvelope('error_auth', 'LACK OF LOCATION_ID, please double check.'),
      ),
    ).toBe(N);
  });

  it('DISTINTO: pontuação interna, a frase ausente ou vazia ⇒ incerto', () => {
    for (const frase of ['Invalid stock-location ID', 'Invalid stocklocation ID', '', null]) {
      expect(desfechoDeCriacaoDeItem(doEnvelope('error_inner', frase)), String(frase)).toBe(I);
      expect(desfechoDeCriacaoDeItem(doEnvelope('error_auth', frase)), String(frase)).toBe(I);
    }
  });

  it('lê `providerMessage`, NUNCA `message` (a NOSSA frase, com o caminho e o código)', () => {
    const base = {
      code: 'error_auth',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: SHOPEE_ADD_ITEM_PATH,
    } as const;
    // A agulha só na nossa frase: não decide.
    const soNaNossa = new ShopeeApiError('Shopee respondeu error_auth — Lack of location_id', {
      ...base,
      providerMessage: 'outra coisa',
    });
    expect(desfechoDeCriacaoDeItem(soNaNossa)).toBe(I);
    // A agulha só na da Shopee: decide.
    const soNaDaShopee = new ShopeeApiError('Shopee respondeu error_auth', {
      ...base,
      providerMessage: 'Lack of location_id, please double check.',
    });
    expect(desfechoDeCriacaoDeItem(soNaDaShopee)).toBe(N);
  });
});

/* -------------------------------------------------------------------------- */
/*  As classes                                                                 */
/* -------------------------------------------------------------------------- */

/** Um corpo de criação VÁLIDO para os guardas do pacote — ids de fixture. */
const CRIAR = {
  item_name: 'Camiseta básica de algodão',
  description: 'Camiseta básica de algodão, corte reto, tamanhos P a GG.',
  original_price: 39.9,
  weight: 0.3,
  category_id: 100017,
  image: { image_id_list: ['img-1'] },
  logistic_info: [{ logistic_id: 90003, enabled: true }],
} satisfies ShopeeAddItemRequest;

/**
 * O cliente REAL do pacote — assinador, `shopeeCall`, construtor de envelope e
 * todo guarda — com só o `fetch` dublado. Ids de fixture, chave inventada.
 */
function clienteServindo(
  corpo: unknown,
  status = 200,
): { readonly client: ShopeeClient; readonly chamadas: () => number } {
  const transporte = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  const client = createShopeeClient({
    partnerId: 1000001,
    partnerKey: 'chave-de-teste-nao-e-credencial',
    hosts: resolveShopeeHosts({ sandbox: true }),
    shopId: 987654,
    getAccessToken: () => Promise.resolve('access-inventado'),
    now: () => 1_767_000_000_000,
    fetch: transporte,
  });
  return { client, chamadas: () => transporte.mock.calls.length };
}

/** Com o que `p` rejeitou — e uma falha do TESTE se resolveu. */
function erroDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('a operação deveria ter falhado');
    },
    (err: unknown) => err,
  );
}

describe('as classes — as duas subclasses ANTES da base', () => {
  it('o NOSSO guarda (ShopeeConfigError, antes do fetch) ⇒ nao-criado', async () => {
    const { client, chamadas } = clienteServindo({});
    const err = await erroDe(client.addItem({ ...CRIAR, logistic_info: [] }));
    expect(err).toBeInstanceOf(ShopeeConfigError);
    expect(chamadas()).toBe(0);
    expect(desfechoDeCriacaoDeItem(err)).toBe(N);
  });

  it('a taxa (rajada e diária) e a autorização morta ⇒ nao-criado — com códigos que NENHUMA linha tem', () => {
    const casos = [
      doEnvelope('error_rate_limit', 'Too many requests.'),
      doEnvelope('product.error_limit', null),
      doEnvelope('shop_no_linked', 'Partner and shop has no linked.'),
      doEnvelope('shop_banned', null),
      new ShopeeRateLimitError('limite', {
        code: 'qualquer_codigo',
        kind: 'burst',
        httpStatus: 429,
        path: SHOPEE_ADD_ITEM_PATH,
      }),
      new ShopeeReauthRequiredError('morta', {
        code: 'qualquer_codigo',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 200,
        path: SHOPEE_ADD_ITEM_PATH,
      }),
    ];
    expect(casos[0]).toBeInstanceOf(ShopeeRateLimitError);
    expect(casos[1]).toBeInstanceOf(ShopeeRateLimitError);
    expect(casos[2]).toBeInstanceOf(ShopeeReauthRequiredError);
    expect(casos[3]).toBeInstanceOf(ShopeeReauthRequiredError);
    for (const err of casos) {
      // ⛔ QUASE-PAR da ORDEM: lidos como a base, nenhum casa linha — seriam `incerto`.
      expect(recusaDeterministicaDeAddItem(err), err.code).toBeNull();
      expect(desfechoDeCriacaoDeItem(err), err.code).toBe(N);
    }
  });

  it('a rede, um HTML de borda, um 2xx sem `item_id`, o 404 do gateway ⇒ incerto (pelo cliente REAL)', async () => {
    const semRede = createShopeeClient({
      partnerId: 1000001,
      partnerKey: 'chave-de-teste-nao-e-credencial',
      hosts: resolveShopeeHosts({ sandbox: true }),
      shopId: 987654,
      getAccessToken: () => Promise.resolve('access-inventado'),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const rede = await erroDe(semRede.addItem(CRIAR));
    expect(rede).toBeInstanceOf(ShopeeNetworkError);

    const borda = await erroDe(
      clienteServindo('<html>bad gateway</html>', 502).client.addItem(CRIAR),
    );
    expect(borda).toBeInstanceOf(ShopeeHttpError);

    const semItemId = await erroDe(
      clienteServindo({ error: '', message: '', warning: '', response: {} }).client.addItem(CRIAR),
    );
    expect(semItemId).toBeInstanceOf(ShopeeSchemaError);

    const gateway = await erroDe(
      clienteServindo({ error: 'error_not_found' }, 404).client.addItem(CRIAR),
    );
    expect(gateway).toBeInstanceOf(ShopeeOperacaoNaoServidaError);

    for (const err of [rede, borda, semItemId, gateway]) {
      expect(desfechoDeCriacaoDeItem(err)).toBe(I);
    }
  });

  it('o transitório do pacote (`error_server`, `error_network`) e um ShopeeError nu ⇒ incerto', () => {
    const servidor = doEnvelope('product.error_server', 'Something wrong. Please try later.');
    expect(servidor.kind).toBe(SHOPEE_ERROR_KIND.transient);
    expect(desfechoDeCriacaoDeItem(servidor)).toBe(I);
    expect(desfechoDeCriacaoDeItem(doEnvelope('error_network', 'Inner http call failed'))).toBe(I);
    expect(desfechoDeCriacaoDeItem(new ShopeeError('da família, de classe nenhuma'))).toBe(I);
  });

  it('um erro que NÃO é da Shopee é relançado — o MESMO objeto, nunca "talvez criado"', async () => {
    const bug = new TypeError('bug nosso');
    await expect(relancado(bug)).rejects.toBe(bug);
    const generico = new Error('genérico');
    await expect(relancado(generico)).rejects.toBe(generico);
    await expect(relancado('um texto')).rejects.toBe('um texto');
  });
});

describe('pelo CAMINHO REAL: o erro que `addItem` do pacote LANÇA (fetch → envelope → erro)', () => {
  it('cada classe sai do transporte de verdade, e a nossa frase composta não decide', async () => {
    const casos = [
      {
        envelope: {
          error: 'product.error_busi',
          message: 'The GTIN code is mandatory, please check and upload again.',
        },
        esperado: N,
      },
      {
        envelope: {
          error: 'error_inner',
          message: 'Our system is taking some time to respond, please try later.',
        },
        esperado: I,
      },
      {
        envelope: {
          error: 'error_busi_add_item_failed',
          message: 'Add item failed. please try later',
        },
        esperado: I,
      },
      { envelope: { error: 'error_xyz', message: 'Invalid brand' }, esperado: I },
      {
        envelope: {
          error: 'error_repeated_mtsku',
          message: 'A similar product has already been uploaded',
        },
        esperado: N,
      },
      { envelope: { error: 'error_rate_limit', message: 'Too many requests.' }, esperado: N },
    ] as const;
    for (const caso of casos) {
      const { client, chamadas } = clienteServindo({
        request_id: 'req-1',
        warning: null,
        ...caso.envelope,
      });
      const err = await erroDe(client.addItem(CRIAR));
      expect(err, caso.envelope.error).toBeInstanceOf(ShopeeApiError);
      const api = err as ShopeeApiError;
      expect(chamadas()).toBe(1);
      // A frase da Shopee chega VERBATIM em `providerMessage`; a nossa carrega o caminho.
      expect(api.providerMessage).toBe(caso.envelope.message);
      expect(api.message).toContain(SHOPEE_ADD_ITEM_PATH);
      expect(desfechoDeCriacaoDeItem(api), caso.envelope.error).toBe(caso.esperado);
    }
  });
});
