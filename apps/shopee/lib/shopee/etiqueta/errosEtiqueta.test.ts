import { describe, expect, it } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeArquivoVazioError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeErrorFromEnvelope,
} from '@delfrance/integrations-shopee';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { ShopeeRefreshEmAndamentoError } from '../core/tokenStore';
import {
  INTERVALO_DOCUMENTO_MS,
  TENTAR_EM_CREDENCIAL_MS,
  TENTAR_EM_LIMITE_MS,
} from './constantesEtiqueta';
import {
  MOTIVO_ETIQUETA_SHOPEE,
  classificarErroDeEtiqueta,
  mensagemDoMotivoEtiqueta,
  type MotivoEtiquetaShopee,
  type OperacaoEtiqueta,
} from './errosEtiqueta';

/** Every slug, in the order the const declares them. */
const TODOS: readonly MotivoEtiquetaShopee[] = Object.values(MOTIVO_ETIQUETA_SHOPEE);

/** `'pedido-em-cancelamento'` → `'pedidoEmCancelamento'`. */
function camelDoSlug(slug: string): string {
  return slug.replace(/-([a-z])/g, (_, letra: string) => letra.toUpperCase());
}

describe('MOTIVO_ETIQUETA_SHOPEE — o vocabulário', () => {
  it('é exatamente o conjunto congelado do reconcile §2.3 (a slug viaja no 409)', () => {
    // Written out by value ON PURPOSE: the slug is persisted on the wire and the
    // web branches on it, so an added, dropped or renamed member must be a
    // reviewed edit of this list, never a side effect.
    expect([...TODOS].sort()).toEqual(
      [
        'agencia-precisa-escolha',
        'cadastro-do-vendedor',
        'conta-inativa',
        'conta-nao-configurada',
        'documento-falhou',
        'etiqueta-indisponivel',
        'frete-de-outra-integracao',
        'ip-nao-declarado',
        'janela-fechada',
        'limite-diario',
        'modo-nao-suportado',
        'nao-shopee',
        'nfe-pendente',
        'pacote-inelegivel',
        'pacote-inexistente',
        'pacote-nao-pronto',
        'pacotes-mudaram',
        'pedido-cancelado',
        'pedido-de-reserva',
        'pedido-em-cancelamento',
        'pedido-fbs',
        'recusa-desconhecida',
        'retido-pela-shopee',
        'sem-endereco-de-coleta',
        'sem-etiqueta-shopee',
        'sem-pacotes',
        'somente-seller-centre',
        'status-desconhecido',
        'tipo-invalido',
      ].sort(),
    );
  });

  it('cada chave é a slug em camelCase — o código nomeia o membro, nunca soletra a slug', () => {
    for (const [chave, slug] of Object.entries(MOTIVO_ETIQUETA_SHOPEE)) {
      expect(chave).toBe(camelDoSlug(slug));
    }
  });

  it('não há slug repetida', () => {
    expect(new Set(TODOS).size).toBe(TODOS.length);
  });
});

describe('mensagemDoMotivoEtiqueta — a frase do operador', () => {
  it.each(TODOS)('%s: uma frase completa — maiúscula, não vazia, termina em UM ponto', (motivo) => {
    const frase = mensagemDoMotivoEtiqueta(motivo);
    expect(frase.trim().length).toBeGreaterThan(1);
    expect(frase).toBe(frase.trim());
    expect(frase.endsWith('.')).toBe(true);
    // Near-miss: a fragment that already ended in a period would come back
    // with two — the capitalizer adds exactly one.
    expect(frase.endsWith('..')).toBe(false);
    const primeira = frase.charAt(0);
    expect(primeira).toBe(primeira.toLocaleUpperCase('pt-BR'));
    expect(primeira).not.toBe(primeira.toLocaleLowerCase('pt-BR'));
  });

  it.each(TODOS)(
    '%s: nenhuma sequência de 7+ dígitos (nunca um pedido, pacote ou rastreio)',
    (motivo) => {
      expect(mensagemDoMotivoEtiqueta(motivo)).not.toMatch(/\d{7,}/);
    },
  );

  it('o próprio teste de dígitos pega o que deve pegar (near-miss do padrão)', () => {
    // The guard above is only as good as its regex: a 7-digit run is caught,
    // a 6-digit one is not — so the pattern is not vacuously loose or tight.
    expect('pacote 1234567 pronto').toMatch(/\d{7,}/);
    expect('pacote 123456 pronto').not.toMatch(/\d{7,}/);
  });

  it('cada motivo tem a SUA frase — duas razões diferentes nunca dizem a mesma coisa', () => {
    const frases = TODOS.map((m) => mensagemDoMotivoEtiqueta(m));
    expect(new Set(frases).size).toBe(frases.length);
  });

  it('a frase de quem tem o que fazer começa pela ação (o formato do passo 14)', () => {
    expect(mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.agenciaPrecisaEscolha)).toBe(
      'Escolha a agência na Central do Vendedor e clique de novo — a Shopee oferece mais de uma agência para este envio.',
    );
    expect(mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.nfePendente)).toMatch(/^Envie a NF-e/);
    expect(mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.janelaFechada)).toMatch(
      /já coletou o pacote/,
    );
  });
});

/* ------------------------- classificarErroDeEtiqueta ------------------------ */

const CAMINHO = '/api/v2/logistics/ship_order';

/** 2026-09-30 12:00 UTC = 20:00 UTC+8 ⇒ the quota resets at 2026-09-30 16:00 UTC. */
const AGORA = Date.UTC(2026, 8, 30, 12, 0, 0);

/**
 * The error the transport really builds for an envelope — the package's own
 * builder, so the class AND the `kind` are the ones production sees (a
 * `logistics.error_limit` comes out as a DAILY rate limit, for instance).
 */
function doEnvelope(
  error: string,
  message: string | null,
  retryAfterSeconds: number | null = null,
): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path: CAMINHO, httpStatus: 200, surface: SHOPEE_SURFACE.business, retryAfterSeconds },
  );
}

function classificar(op: OperacaoEtiqueta, err: unknown) {
  return classificarErroDeEtiqueta(op, err, AGORA);
}

const RECUSA_DESCONHECIDA = { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida };

/** Every operation but the ship, with the phase its waits report. */
const FASE_FORA_DO_SHIP: readonly [OperacaoEtiqueta, string][] = [
  ['detalhe-pedido', 'programando'],
  ['detalhe-pacote', 'programando'],
  ['parametro-envio', 'programando'],
  ['rastreio', 'aguardando-rastreio'],
  ['parametro-documento', 'gerando-documento'],
  ['criar-documento', 'gerando-documento'],
  ['resultado-documento', 'gerando-documento'],
  ['baixar', 'baixando'],
];

describe('classificarErroDeEtiqueta — as classes, antes de qualquer código', () => {
  it.each([
    ['um Error comum', new Error('package_already_shipped')],
    ['um TypeError', new TypeError('x')],
    [
      'um objeto com a FORMA de um erro da Shopee (duck typing não classifica)',
      { code: 'package_already_shipped', kind: 'other', providerMessage: null },
    ],
    ['uma string', 'logistics.package_already_shipped'],
    ['null', null],
    ['undefined', undefined],
  ])('%s ⇒ null (o chamador relança)', (_nome, err) => {
    expect(classificar('programar', err)).toBeNull();
  });

  it('a nossa configuração e um corpo ilegível ⇒ null (o respond.ts responde)', () => {
    expect(classificar('programar', new ShopeeConfigError('x'))).toBeNull();
    expect(
      classificar('baixar', new ShopeeSchemaError('x', { httpStatus: 200, path: CAMINHO })),
    ).toBeNull();
  });

  it('a autorização morta ⇒ null (o 409 de reautorização é do respond.ts)', () => {
    const err = doEnvelope('shop_banned', 'The shop account has been banned.');
    expect(err).toBeInstanceOf(ShopeeReauthRequiredError);
    expect(classificar('programar', err)).toBeNull();
  });

  it('outra instância renovando o token ⇒ aguardar renovando-credencial (uma classe do APP)', () => {
    const err = new ShopeeRefreshEmAndamentoError('x', AGORA + 30_000);
    for (const op of ['programar', 'baixar'] as const) {
      expect(classificar(op, err)).toStrictEqual({
        tipo: 'aguardar',
        fase: 'renovando-credencial',
        tentarEmMs: TENTAR_EM_CREDENCIAL_MS,
      });
    }
  });

  it('um download VAZIO ⇒ aguardar (near-miss: o ShopeeSchemaError comum é null)', () => {
    const vazio = new ShopeeArquivoVazioError('x', { httpStatus: 200, path: CAMINHO });
    expect(vazio).toBeInstanceOf(ShopeeSchemaError);
    expect(classificar('baixar', vazio)).toStrictEqual({
      tipo: 'aguardar',
      fase: 'baixando',
      tentarEmMs: INTERVALO_DOCUMENTO_MS,
    });
    expect(
      classificar('baixar', new ShopeeSchemaError('x', { httpStatus: 200, path: CAMINHO })),
    ).toBeNull();
  });

  it('sem resposta no SHIP ⇒ verificar (rede e HTTP sem envelope; R-m)', () => {
    expect(classificar('programar', new ShopeeNetworkError('reset'))).toStrictEqual({
      tipo: 'verificar',
    });
    expect(
      classificar('programar', new ShopeeHttpError('x', { httpStatus: 403, path: CAMINHO })),
    ).toStrictEqual({ tipo: 'verificar' });
  });

  it.each(FASE_FORA_DO_SHIP)(
    'sem resposta em %s ⇒ uma espera na fase %s, nunca verificar',
    (op, fase) => {
      for (const err of [
        new ShopeeNetworkError('reset'),
        new ShopeeHttpError('x', { httpStatus: 502, path: CAMINHO }),
      ]) {
        expect(classificar(op, err)).toStrictEqual({
          tipo: 'aguardar',
          fase,
          tentarEmMs: TENTAR_EM_LIMITE_MS,
        });
      }
    },
  );
});

describe('classificarErroDeEtiqueta — E0, os limites', () => {
  it('burst sem Retry-After ⇒ aguardar limite-de-requisicoes no piso de 10 s', () => {
    const err = doEnvelope('error_rate_limit', 'Too many requests.');
    expect(err).toBeInstanceOf(ShopeeRateLimitError);
    expect(classificar('programar', err)).toStrictEqual({
      tipo: 'aguardar',
      fase: 'limite-de-requisicoes',
      tentarEmMs: TENTAR_EM_LIMITE_MS,
    });
  });

  it('burst: o MAIOR entre o Retry-After e o piso (30 s vence; 2 s não baixa o piso)', () => {
    expect(classificar('rastreio', doEnvelope('error_rate_limit', null, 30))).toMatchObject({
      tentarEmMs: 30_000,
    });
    expect(classificar('rastreio', doEnvelope('error_rate_limit', null, 2))).toMatchObject({
      tentarEmMs: TENTAR_EM_LIMITE_MS,
    });
  });

  it('a cota diária ⇒ recusa limite-diario com tentarApos na virada de 00:00 UTC+8', () => {
    const err = doEnvelope(
      'error_limit',
      'The total API call number made by your APP has reached the daily API call limit, please try again after 00: 00 (UTC+08:00)',
    );
    const veredito = classificar('programar', err);
    expect(veredito).toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
      tentarApos: Date.UTC(2026, 8, 30, 16, 0, 0),
    });
    expect(veredito).toMatchObject({ tentarApos: proximaViradaDaCotaMs(AGORA) });
    // The clock is the PARAMETER: a day later, a day later.
    expect(classificarErroDeEtiqueta('programar', err, AGORA + 86_400_000)).toMatchObject({
      tentarApos: Date.UTC(2026, 9, 1, 16, 0, 0),
    });
  });

  it('a cota diária SEM frase confia no kind', () => {
    expect(classificar('baixar', doEnvelope('error_limit', null))).toMatchObject({
      motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
    });
  });

  it.each([
    'Parcel count should not exceed limit.',
    'The batch request reach limit 50.',
    'Can not update order logistics in current status.',
  ])('near-miss: logistics.error_limit "%s" — o pacote diz DIÁRIA, a frase não ⇒ E26', (frase) => {
    const err = doEnvelope('logistics.error_limit', frase);
    expect(err.kind).toBe(SHOPEE_ERROR_KIND.daily);
    expect(classificar('programar', err)).toStrictEqual(RECUSA_DESCONHECIDA);
  });
});

describe('classificarErroDeEtiqueta — S31, já programado', () => {
  const JA_ENVIADO =
    "This package has already been arranged shipment and you can't call this API again.";

  it.each([
    ' logistics.package_already_shipped', // the ship page's own spelling, leading space
    'logistics.package_already_shipped',
    'package_already_shipped',
  ])('"%s" ⇒ ja-programado', (code) => {
    expect(classificar('programar', doEnvelope(code, JA_ENVIADO))).toStrictEqual({
      tipo: 'ja-programado',
    });
  });

  it('logistics.error_param "Order has been shipped." ⇒ ja-programado', () => {
    expect(
      classificar('programar', doEnvelope('logistics.error_param', 'Order has been shipped.')),
    ).toStrictEqual({ tipo: 'ja-programado' });
  });

  it.each([
    ['um sufixo', 'logistics.package_already_shipped_x', JA_ENVIADO],
    ['DOIS segmentos de módulo', 'x.logistics.package_already_shipped', JA_ENVIADO],
    ['a mesma frase sob outro código', 'logistics.error_order_state', 'Order has been shipped.'],
  ])('near-miss (%s) ⇒ E26, nunca ja-programado', (_nome, code, frase) => {
    expect(classificar('programar', doEnvelope(code, frase))).toStrictEqual(RECUSA_DESCONHECIDA);
  });

  it('a agulha lê o providerMessage, NUNCA o .message formatado', () => {
    const base = {
      code: 'logistics.error_param',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: CAMINHO,
    };
    const alocando = 'The order is being allocated, please wait until the allocate is completed.';
    // Our text says "shipped", Shopee's says "allocated": the wait wins.
    expect(
      classificar(
        'programar',
        new ShopeeApiError('Order has been shipped.', { ...base, providerMessage: alocando }),
      ),
    ).toMatchObject({ tipo: 'aguardar' });
    // And the inverse.
    expect(
      classificar(
        'programar',
        new ShopeeApiError(alocando, { ...base, providerMessage: 'Order has been shipped.' }),
      ),
    ).toStrictEqual({ tipo: 'ja-programado' });
  });
});

describe('classificarErroDeEtiqueta — S32, "being allocated" é uma espera', () => {
  const ALOCANDO = 'The order is being allocated, please wait until the allocate is completed.';

  it.each([
    ['programar', 'programando'],
    ['parametro-envio', 'programando'],
    ['rastreio', 'aguardando-rastreio'],
    ['parametro-documento', 'gerando-documento'],
  ] as const)('%s ⇒ aguardar %s (nem ja-programado, nem verificar)', (op, fase) => {
    expect(classificar(op, doEnvelope('logistics.error_param', ALOCANDO))).toStrictEqual({
      tipo: 'aguardar',
      fase,
      tentarEmMs: TENTAR_EM_LIMITE_MS,
    });
  });

  it('near-miss: a mesma frase sob outro código não é a espera da alocação', () => {
    expect(
      classificar('programar', doEnvelope('logistics.error_order_state', ALOCANDO)),
    ).toStrictEqual(RECUSA_DESCONHECIDA);
  });
});

describe('classificarErroDeEtiqueta — S33, o pedido encerrado é recusa, nunca "já programado"', () => {
  it('logistics.order_finalized ⇒ recusa pedido-cancelado', () => {
    expect(
      classificar(
        'programar',
        doEnvelope('logistics.order_finalized', 'Order is already in finalized status.'),
      ),
    ).toStrictEqual({ tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado });
  });

  it('error_status "The order has been cancelled." ⇒ recusa pedido-cancelado', () => {
    expect(
      classificar('parametro-envio', doEnvelope('error_status', 'The order has been cancelled.')),
    ).toStrictEqual({ tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado });
  });

  it('near-miss: o OUTRO texto de error_status não é cancelamento', () => {
    expect(
      classificar(
        'programar',
        doEnvelope('error_status', 'Buyer hasn’t completed pre-authorization yet.'),
      ),
    ).toStrictEqual(RECUSA_DESCONHECIDA);
  });
});

describe('classificarErroDeEtiqueta — S34, a família da NF-e pendente', () => {
  it.each([
    ['logistics.lack_of_invoice_data', 'Pending invoice data, can not arrange shipment.'],
    [
      'logistics.lack_of_invoice_data',
      'Please upload the invoice or verify the details of the document already submitted, which is currently flagged as invalid by SEFAZ. Correction is required to release the shipment.',
    ],
    [
      'logistics.lack_of_invoice_data',
      'The invoice has not been uploaded yet or was rejected by SEFAZ: rejeição 999',
    ],
    ['lack_of_invoice_data', 'Pending invoice data, can not arrange shipment.'],
    ['error_pending_invoice', null],
  ])('%s — %s ⇒ nfe-pendente, no ship e no parâmetro', (code, frase) => {
    for (const op of ['programar', 'parametro-envio'] as const) {
      expect(classificar(op, doEnvelope(code, frase))).toStrictEqual({ tipo: 'nfe-pendente' });
    }
  });

  it.each([
    ['um sufixo', 'logistics.lack_of_invoice_data_x'],
    ['DOIS segmentos de módulo', 'a.logistics.lack_of_invoice_data'],
  ])('near-miss (%s) ⇒ E26', (_nome, code) => {
    expect(
      classificar('programar', doEnvelope(code, 'Pending invoice data, can not arrange shipment.')),
    ).toStrictEqual(RECUSA_DESCONHECIDA);
  });

  it('near-miss: "invoice" na frase de error_param é o cadastro do vendedor, não a NF-e', () => {
    expect(
      classificar(
        'programar',
        doEnvelope(
          'logistics.error_param',
          'Seller Info Error. Please check and input your invoice info.',
        ),
      ),
    ).toStrictEqual({ tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.cadastroDoVendedor });
  });
});

describe('classificarErroDeEtiqueta — R-l, o par do package_number', () => {
  it.each([
    [
      'programar',
      'logistics.ship_order_need_pacakge_number',
      'Please request with package_number for this split order.',
    ],
    [
      'parametro-envio',
      'logistics.package_number_not_exist',
      'Please request with package_number for this split order.',
    ],
    [
      'criar-documento',
      'logistics.package_number_not_exist',
      'Please request with package_number for this split order.',
    ],
    ['baixar', 'logistics.package_number_not_found', 'The package_number X is not exist.'],
    ['rastreio', 'logistics.package_not_exist', 'The package is not exist.'],
    ['programar', 'logistics.error_param', 'Order has been splitted.'],
  ] as const)('%s: %s ⇒ pacotes-mudaram', (op, code, frase) => {
    expect(classificar(op, doEnvelope(code, frase))).toStrictEqual({ tipo: 'pacotes-mudaram' });
  });

  it('ship_order_not_need_pacakge_number no ship ⇒ reenviar-sem-pacote', () => {
    expect(
      classificar(
        'programar',
        doEnvelope(
          'logistics.ship_order_not_need_pacakge_number',
          'Please don’t request with package_number for this unsplit order.',
        ),
      ),
    ).toStrictEqual({ tipo: 'reenviar-sem-pacote' });
  });

  it('near-miss: reenviar-sem-pacote é SÓ do ship', () => {
    expect(
      classificar(
        'criar-documento',
        doEnvelope('logistics.ship_order_not_need_pacakge_number', null),
      ),
    ).toStrictEqual(RECUSA_DESCONHECIDA);
  });

  it('near-miss: "can not be splited" não é "has been splitted"', () => {
    expect(
      classificar(
        'programar',
        doEnvelope('logistics.error_param', 'This order can not be splited.'),
      ),
    ).toStrictEqual(RECUSA_DESCONHECIDA);
  });
});

describe('classificarErroDeEtiqueta — E6/E7, o resultado do ship é DESCONHECIDO (R-m)', () => {
  const INCERTOS: readonly [string, string | null][] = [
    ['logistics.error_timeout', 'Timeout to call external system.'],
    ['logistics.error_third_party_server', 'Failed to call external system.'],
    ['error_network', 'Inner http call failed'],
    ['error_server', 'System error. Please try again later.'],
    ['logistics.unknown_error', 'Unknown error, please contact Shopee to check.'],
    ['logistics.error_too_many_invoke_function', 'Failed to get lock.'],
    ['logistics.logistic_order_is_locked_on_creating', 'Fail to get the lock.'],
    ['logistics.error_param', 'System error, please try again later.'],
    ['logistics.error_other', 'System error, please try again later.'],
  ];

  it.each(INCERTOS)('%s no ship ⇒ verificar', (code, frase) => {
    expect(classificar('programar', doEnvelope(code, frase))).toStrictEqual({ tipo: 'verificar' });
  });

  it.each(INCERTOS)('%s fora do ship ⇒ uma espera (E7b)', (code, frase) => {
    expect(classificar('criar-documento', doEnvelope(code, frase))).toStrictEqual({
      tipo: 'aguardar',
      fase: 'gerando-documento',
      tentarEmMs: TENTAR_EM_LIMITE_MS,
    });
  });

  it('near-miss: o MESMO logistics.error_other com outra frase é E26, não verificar', () => {
    expect(
      classificar(
        'programar',
        doEnvelope('logistics.error_other', 'Can not support pick up address.'),
      ),
    ).toStrictEqual(RECUSA_DESCONHECIDA);
  });
});

describe('classificarErroDeEtiqueta — as recusas determinísticas', () => {
  it.each([
    [
      'programar',
      'logistics.ship_order_not_ready_to_ship',
      'The order is not ready to ship.',
      'pacoteNaoPronto',
    ],
    [
      'programar',
      'logistics.error_param',
      'The order status is not ready to ship.',
      'pacoteNaoPronto',
    ],
    ['parametro-envio', 'error_param', 'OFG list type is not TO_PROCESS', 'pacoteNaoPronto'],
    [
      'parametro-envio',
      'error_param',
      'Shipping parameters can only be obtained when package is ready to be shipped',
      'pacoteNaoPronto',
    ],
    [
      'parametro-envio',
      'logistics.no_supported_pickup_address',
      'No supported pickup address',
      'semEnderecoDeColeta',
    ],
    [
      'programar',
      'logistics.error_sender_address',
      'Pickup address not valid.',
      'semEnderecoDeColeta',
    ],
    [
      'parametro-envio',
      'logistics.invalid_address_version',
      'Some addresses are no longer supported per new regulation',
      'semEnderecoDeColeta',
    ],
    [
      'programar',
      'logistics.error_param',
      'Seller Info Error. Please check and input your tax number.',
      'cadastroDoVendedor',
    ],
    [
      'programar',
      'logistics.ship_order_pff_init',
      'You can not ship warehouse order.',
      'pedidoFbs',
    ],
    ['criar-documento', 'logistics.error_booking_order', null, 'pedidoDeReserva'],
    [
      'criar-documento',
      'logistics.can_not_print_combine_order\t', // the page's own trailing TAB
      'This order is part of a combined parcel, please use Seller Center instead.',
      'somenteSellerCentre',
    ],
    [
      'parametro-documento',
      'logistics.can_not_print_jit_order',
      'This shipping channel only supports document printing in Shopee seller center',
      'somenteSellerCentre',
    ],
    [
      'criar-documento',
      'logistics.order_status_error',
      'Order status does not support awb printing.',
      'etiquetaIndisponivel',
    ],
    [
      'criar-documento',
      'logistics.package_can_not_print',
      'The package can not print now.',
      'etiquetaIndisponivel',
    ],
    ['baixar', 'source_ip_undeclared', 'Request Source IP is undeclared.', 'ipNaoDeclarado'],
  ] as const)('%s: %s — %s ⇒ recusa %s (sem tentarApos)', (op, code, frase, chave) => {
    expect(classificar(op, doEnvelope(code, frase))).toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE[chave],
    });
  });
});

describe('classificarErroDeEtiqueta — E11, reescolher o envio (só no ship)', () => {
  const REESCOLHER: readonly [string, string | null][] = [
    ['logistics.ship_order_pickup_time_invalid', 'Invalid pickup time id.'],
    [
      'logistics.ship_order_need_address_pickup_time',
      'Parameter address_id and pickup_time_id are required.',
    ],
    [
      'error_param',
      'The pickup_time_id received is invalid and not expected. Please check and reselect one from the time_slot_list.',
    ],
    ['logistics.error_param', 'Selected pickup timeslot is unavailable. Please reselect.'],
  ];

  it.each(REESCOLHER)('%s no ship ⇒ reescolher-envio', (code, frase) => {
    expect(classificar('programar', doEnvelope(code, frase))).toStrictEqual({
      tipo: 'reescolher-envio',
    });
  });

  it.each(REESCOLHER)('near-miss: %s fora do ship ⇒ E26', (code, frase) => {
    expect(classificar('parametro-envio', doEnvelope(code, frase))).toStrictEqual(
      RECUSA_DESCONHECIDA,
    );
  });
});

describe('classificarErroDeEtiqueta — as etapas do documento', () => {
  it.each([
    ['resultado-documento', 'logistics.shipping_document_should_print_first'],
    ['baixar', 'logistics.shipping_document_should_print_first'],
    ['criar-documento', 'logistics.tracking_number_invalid'],
  ] as const)('%s: %s ⇒ fase-desatualizada', (op, code) => {
    expect(classificar(op, doEnvelope(code, null))).toStrictEqual({ tipo: 'fase-desatualizada' });
  });

  it('download_later ⇒ aguardar baixando na cadência do documento', () => {
    expect(
      classificar(
        'baixar',
        doEnvelope('logistics.download_later', 'Processing, please download later.'),
      ),
    ).toStrictEqual({ tipo: 'aguardar', fase: 'baixando', tentarEmMs: INTERVALO_DOCUMENTO_MS });
  });

  it('package_print_failed ⇒ uma espera (transitório)', () => {
    expect(
      classificar(
        'baixar',
        doEnvelope(
          'logistics.package_print_failed',
          'Some package failed to print, please try again later.',
        ),
      ),
    ).toStrictEqual({ tipo: 'aguardar', fase: 'baixando', tentarEmMs: TENTAR_EM_LIMITE_MS });
  });

  it('packages_can_not_download_together ⇒ baixar-separado', () => {
    expect(
      classificar('baixar', doEnvelope('logistics.packages_can_not_download_together', null)),
    ).toStrictEqual({ tipo: 'baixar-separado' });
  });

  it('shipping_document_type_invalid ⇒ tipo-invalido', () => {
    expect(
      classificar('criar-documento', doEnvelope('logistics.shipping_document_type_invalid', null)),
    ).toStrictEqual({ tipo: 'tipo-invalido' });
  });
});

describe('classificarErroDeEtiqueta — E26, o que ninguém ensinou', () => {
  it('um código desconhecido ⇒ recusa recusa-desconhecida', () => {
    expect(
      classificar(
        'programar',
        doEnvelope(
          'logistics.warehouse_stock_insufficient',
          'Failed to assign a warehouse with sufficient stock',
        ),
      ),
    ).toStrictEqual(RECUSA_DESCONHECIDA);
  });

  it('um "todas falharam" que chegou até aqui (sem linhas) ⇒ E26', () => {
    const err = new ShopeeApiPartialError('x', {
      code: 'common.batch_api_all_failed',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: CAMINHO,
      providerMessage: 'Failed, please check result_list for more details.',
      parsed: {},
    });
    expect(classificar('criar-documento', err)).toStrictEqual(RECUSA_DESCONHECIDA);
  });
});
