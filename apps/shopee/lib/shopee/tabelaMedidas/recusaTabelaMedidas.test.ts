import { describe, expect, it } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
  SHOPEE_GET_SIZE_CHART_LIST_PATH,
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  shopeeErrorFromEnvelope,
} from '@delfrance/integrations-shopee';

import {
  FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
  FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
  lerFixture,
} from '../fixtures/wireCorpus';
import {
  FRASE_CATEGORIA_INVALIDA_TABELA,
  FRASE_TABELA_MEDIDAS_INEXISTENTE,
  MOTIVO_RECUSA_TABELA_MEDIDAS,
  classificarRecusaTabelaMedidas,
  type MotivoRecusaTabelaMedidas,
} from './recusaTabelaMedidas';

/* -------------------------------------------------------------------------- */
/*  Fixtures — Shopee's own pages' sentences; no id, no shop datum.           */
/* -------------------------------------------------------------------------- */

/**
 * The error the transport really builds for an envelope — the package's own
 * builder, so the class, the `kind` and the formatted `.message` are the ones
 * production sees.
 */
function doEnvelope(
  error: string,
  message: string | null,
  path: string = SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function classificar(error: string, message: string | null): MotivoRecusaTabelaMedidas | null {
  return classificarRecusaTabelaMedidas(doEnvelope(error, message));
}

/** A committed error body (`{ error, message }`), read as plain JSON. */
function corpoDeErro(file: string): { readonly error: string; readonly message: string } {
  const corpo = lerFixture(file);
  if (
    typeof corpo !== 'object' ||
    corpo === null ||
    Array.isArray(corpo) ||
    typeof corpo.error !== 'string' ||
    typeof corpo.message !== 'string'
  ) {
    throw new TypeError(`${file} não é um corpo de erro { error, message }`);
  }
  return { error: corpo.error, message: corpo.message };
}

/* ------------------------------ the vocabulary ------------------------------ */

describe('MOTIVO_RECUSA_TABELA_MEDIDAS — o vocabulário', () => {
  it('são exatamente os dois motivos, e cada chave é o slug em camelCase', () => {
    expect(Object.values(MOTIVO_RECUSA_TABELA_MEDIDAS).sort()).toEqual([
      'categoria-invalida',
      'tabela-inexistente',
    ]);
    for (const [chave, slug] of Object.entries(MOTIVO_RECUSA_TABELA_MEDIDAS)) {
      expect(chave).toBe(slug.replace(/-([a-z])/g, (_, letra: string) => letra.toUpperCase()));
    }
  });
});

describe('as frases — a ÚNICA grafia de cada uma, contra os corpos commitados', () => {
  // ⚠️ The publish refusal table (step 18 PR 5) matches FRASE_TABELA_MEDIDAS_INEXISTENTE
  // as an EXACT, case-sensitive substring — so the constant must sit verbatim inside
  // the sentence the detail page prints, not merely fold-equal to it.
  it('FRASE_TABELA_MEDIDAS_INEXISTENTE está, VERBATIM, na frase da página do detalhe', () => {
    const { message } = corpoDeErro(FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE);
    expect(message.includes(FRASE_TABELA_MEDIDAS_INEXISTENTE)).toBe(true);
    // Near-miss: the lower-cased needle is NOT a verbatim substring.
    expect(message.includes(FRASE_TABELA_MEDIDAS_INEXISTENTE.toLowerCase())).toBe(false);
  });

  it('FRASE_CATEGORIA_INVALIDA_TABELA é, VERBATIM, a frase da página da lista', () => {
    const { message } = corpoDeErro(FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA);
    expect(message.includes(FRASE_CATEGORIA_INVALIDA_TABELA)).toBe(true);
  });

  it('nenhuma agulha contém a outra (a ordem do laço não decide nada)', () => {
    const a = FRASE_TABELA_MEDIDAS_INEXISTENTE.toLowerCase();
    const b = FRASE_CATEGORIA_INVALIDA_TABELA.toLowerCase();
    expect(a.includes(b) || b.includes(a)).toBe(false);
  });
});

/* ------------------------------ the classifier ------------------------------ */

describe('classificarRecusaTabelaMedidas — os corpos de erro commitados (as páginas)', () => {
  it('o exemplo de erro do DETALHE ⇒ tabela-inexistente', () => {
    const { error, message } = corpoDeErro(FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE);
    const err = doEnvelope(error, message, SHOPEE_GET_SIZE_CHART_DETAIL_PATH);
    expect(err.kind).toBe(SHOPEE_ERROR_KIND.other);
    expect(classificarRecusaTabelaMedidas(err)).toBe(
      MOTIVO_RECUSA_TABELA_MEDIDAS.tabelaInexistente,
    );
  });

  it('o exemplo de erro da LISTA ⇒ categoria-invalida — o MESMO código, só a frase separa', () => {
    const { error, message } = corpoDeErro(FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA);
    const lista = corpoDeErro(FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE);
    expect(error).toBe(lista.error);
    const err = doEnvelope(error, message, SHOPEE_GET_SIZE_CHART_LIST_PATH);
    expect(classificarRecusaTabelaMedidas(err)).toBe(
      MOTIVO_RECUSA_TABELA_MEDIDAS.categoriaInvalida,
    );
  });
});

describe('classificarRecusaTabelaMedidas — PARES e QUASE-ACERTOS (escopo da dobra, #1372)', () => {
  // The design's nine-row table (D2 §2.1), plus the code-fold pairs.
  it.each<[string, string, string | null, MotivoRecusaTabelaMedidas | null]>([
    // the documented pairs
    [
      'o par documentado (detalhe)',
      'product.error_param',
      'Size chart id not exist in this shop',
      'tabela-inexistente',
    ],
    [
      'o par documentado (lista)',
      'product.error_param',
      'Category id is invalid',
      'categoria-invalida',
    ],
    // PAIRS — what the folds treat as equal
    [
      'PAR: sem o prefixo de módulo, minúsculas, ponto final',
      'error_param',
      'size chart id not exist in this shop.',
      'tabela-inexistente',
    ],
    [
      'PAR: o molde "Wrong parameters, detail:" e dois pontos finais',
      'product.error_param',
      'Wrong parameters, detail: Size chart id not exist in this shop..',
      'tabela-inexistente',
    ],
    [
      'PAR: o código com brancos nas pontas',
      ' product.error_param\t',
      'Size chart id not exist in this shop',
      'tabela-inexistente',
    ],
    [
      'PAR: espaços internos colapsados, caixa alta',
      'product.error_param',
      'CATEGORY   ID IS INVALID',
      'categoria-invalida',
    ],
    // NEAR-MISSES — what must stay distinct
    [
      'QUASE: a frase certa sob OUTRO código (error_data)',
      'product.error_data',
      'Size chart id not exist in this shop',
      null,
    ],
    [
      'QUASE: DOIS segmentos de módulo (só um é removido)',
      'x.product.error_param',
      'Size chart id not exist in this shop',
      null,
    ],
    [
      'QUASE: a caixa do CÓDIGO é mantida',
      'product.Error_Param',
      'Size chart id not exist in this shop',
      null,
    ],
    ['QUASE: a frase genérica', 'product.error_param', 'parameter invalid', null],
    ['QUASE: providerMessage null', 'product.error_param', null, null],
    ['QUASE: providerMessage vazio', 'product.error_param', '', null],
    [
      'QUASE: uma frase MAIS CURTA não é a nossa',
      'product.error_param',
      'Size chart not exist',
      null,
    ],
    ['QUASE: a frase da categoria sem "is"', 'product.error_param', 'Category id invalid', null],
  ])('%s', (_, code, message, esperado) => {
    expect(classificar(code, message)).toBe(esperado);
  });
});

describe('classificarRecusaTabelaMedidas — lê providerMessage, NUNCA .message', () => {
  const base = {
    httpStatus: 200,
    path: SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
    kind: SHOPEE_ERROR_KIND.other,
  } as const;

  it('a frase só no .message (providerMessage null) ⇒ null', () => {
    const err = new ShopeeApiError(
      'Shopee /api/v2/product/get_size_chart_detail respondeu product.error_param (HTTP 200) — Size chart id not exist in this shop',
      { ...base, code: 'product.error_param', providerMessage: null },
    );
    expect(err.message).toContain(FRASE_TABELA_MEDIDAS_INEXISTENTE);
    expect(classificarRecusaTabelaMedidas(err)).toBeNull();
  });

  it('a frase só no providerMessage (um .message sem ela) ⇒ classificada', () => {
    const err = new ShopeeApiError('outra coisa', {
      ...base,
      code: 'product.error_param',
      providerMessage: 'Size chart id not exist in this shop',
    });
    expect(classificarRecusaTabelaMedidas(err)).toBe(
      MOTIVO_RECUSA_TABELA_MEDIDAS.tabelaInexistente,
    );
  });

  it('o .message formatado de um código sem frase nunca casa por conter "size_chart" no caminho', () => {
    // The haystack of `.message` already says `size_chart` (the PATH) before Shopee has
    // said a word — the reason the classifier never reads it.
    const err = doEnvelope('product.error_param', null);
    expect(err.message).toContain('size_chart');
    expect(classificarRecusaTabelaMedidas(err)).toBeNull();
  });
});

describe('classificarRecusaTabelaMedidas — as outras classes não têm o código da recusa', () => {
  it('um limite de taxa e uma autorização morta ⇒ null (o chamador ainda filtra kind)', () => {
    const limite = doEnvelope('error_rate_limit', 'Size chart id not exist in this shop');
    expect(limite).toBeInstanceOf(ShopeeRateLimitError);
    expect(classificarRecusaTabelaMedidas(limite)).toBeNull();

    const reauth = doEnvelope('error_shop_refresh_token', 'Size chart id not exist in this shop');
    expect(reauth).toBeInstanceOf(ShopeeReauthRequiredError);
    expect(classificarRecusaTabelaMedidas(reauth)).toBeNull();
  });
});
