import { describe, expect, it } from 'vitest';

import * as barril from '../src/index';

describe('the constants', () => {
  it('pins the SP-API host, the LWA endpoint and the BR marketplace id', () => {
    expect(barril.URL_BASE_SP_API).toBe('https://sellingpartnerapi-na.amazon.com');
    expect(barril.URL_TOKEN_LWA).toBe('https://api.amazon.com/auth/o2/token');
    expect(barril.MARKETPLACE_ID_BR).toBe('A2Q3Y263D00KWC');
    expect(barril.CAMINHO_SEARCH_ORDERS).toBe('/orders/2026-01-01/orders');
    expect(barril.OPERACAO_GET_ORDER).toBe('getOrder');
    expect([...barril.DADOS_INCLUIDOS_GET_ORDER]).toEqual([
      'BUYER',
      'RECIPIENT',
      'TAX',
      'PAYMENT',
      'PROCEEDS',
      'FULFILLMENT',
      'PACKAGES',
      'CANCELLATION',
    ]);
    expect(barril.MAX_USER_AGENT).toBe(500);
    expect(barril.MAX_REF_CREDENCIAL).toBe(64);
    expect(barril.OPERACAO_GET_INVOICE_STATUS).toBe('getInvoiceStatus');
    expect(barril.OPERACAO_SUBMIT_INVOICE).toBe('submitInvoice');
    expect(barril.CAMINHO_STATUS_NOTA_FISCAL).toBe('/delivery/2022-07-01/invoice/status');
    expect(barril.CAMINHO_NOTA_FISCAL).toBe('/delivery/2022-07-01/invoice');
    expect(barril.TIPO_FATURA_AMAZON).toBe('Outbound');
    expect(barril.PROGRAMA_ENTREGA_AMAZON).toBe('EasyShip');
    expect(Object.keys(barril.STATUS_FATURA_ENTREGA_AMAZON)).toHaveLength(4);
    expect(Object.keys(barril.STATUS_FATURAMENTO_PEDIDO_AMAZON)).toHaveLength(4);
    expect(Object.keys(barril.STATUS_FATURA_ITEM_AMAZON)).toHaveLength(4);
    expect(barril.OPERACAO_AGENDAMENTO_EASY_SHIP).toBe('createScheduledPackageBulk');
    expect(barril.CAMINHO_AGENDAMENTO_EASY_SHIP).toBe('/easyShip/2022-03-23/packages/bulk');
    expect(barril.FORMATO_ETIQUETA_EASY_SHIP).toBe('ZPL');
    expect(barril.CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP).toBe('ScheduledPackageAlreadyExists');
    expect(barril.CODIGO_DIMENSOES_AUSENTES_EASY_SHIP).toBe('MissingPackageDimensions');
    expect(barril.OPERACAO_TOKEN_RESTRITO).toBe('createRestrictedDataToken');
    expect(barril.CAMINHO_TOKEN_RESTRITO).toBe('/tokens/2021-03-01/restrictedDataToken');
    expect(barril.RECURSO_RESTRITO_AGENDAMENTO).toEqual({
      method: 'POST',
      path: '/easyShip/2022-03-23/packages/bulk',
    });
    expect(barril.MAX_ZIP_EASY_SHIP_BYTES).toBe(5 * 1024 * 1024);
    expect(barril.MAX_ENTRADAS_ZIP_EASY_SHIP).toBe(64);
    expect(barril.MAX_ZPL_EASY_SHIP_BYTES).toBe(1024 * 1024);
  });
});

describe('the barrel', () => {
  it('exports the public surface', () => {
    for (const nome of [
      'criarClienteSpApi',
      'trocarRefreshToken',
      'trocarCodigoAutorizacao',
      'lerLimiteTaxa',
      'lerCodigoErroLwa',
      'montarUrlConsentimento',
      'credencialLwaValida',
      'applicationIdValido',
      'buscarPedidosAtualizados',
      'buscarPedido',
      'caminhoGetOrder',
      'criarClienteEscritaSpApi',
      'consultarStatusNotaFiscal',
      'enviarNotaFiscal',
      'agendarPacotesEasyShip',
      'criarTokenRestrito',
      'baixarDocumentosEasyShip',
      'extrairEtiquetaZplEasyShip',
    ] as const) {
      expect(typeof barril[nome], nome).toBe('function');
    }
    for (const nome of [
      'lwaTokenRespostaSchema',
      'lwaErroSchema',
      'spApiErrosSchema',
      'respostaSearchOrdersSchema',
      'respostaGetOrderSchema',
      'pedidoWireAmazonSchema',
      'itemPedidoWireAmazonSchema',
      'pacoteWireAmazonSchema',
      'dinheiroWireAmazonSchema',
      'respostaStatusNotaFiscalSchema',
      'respostaEnvioNotaFiscalSchema',
      'respostaAgendamentoEasyShipSchema',
      'respostaTokenRestritoSchema',
    ] as const) {
      expect(typeof barril[nome].safeParse, nome).toBe('function');
    }
    expect(barril.PRAZO_AMAZON_MS).toEqual({
      documento: 20_000,
      escrita: 30_000,
      leitura: 20_000,
      lwa: 20_000,
    });
    for (const classe of [
      barril.AmazonError,
      barril.AmazonConfigError,
      barril.AmazonHttpError,
      barril.AmazonAuthError,
      barril.AmazonNotFoundError,
      barril.AmazonThrottleError,
      barril.AmazonSchemaError,
      barril.AmazonNetworkError,
      barril.AmazonTimeoutError,
      barril.AmazonDocumentoEasyShipError,
    ]) {
      expect(typeof classe).toBe('function');
    }
  });

  it('does NOT export the internal transport', () => {
    const exportados = Object.keys(barril);
    for (const interno of [
      'enviar',
      'criarEmissor',
      'resolverFetch',
      'refValida',
      'userAgentValido',
      'ehAsciiVisivel',
      'contemSegredo',
      'lerRequestIdAmazon',
      'redirectUriValido',
      // The request core both clients share (`client.ts`).
      'executarSpApi',
      'prepararNucleoSpApi',
      // The shared order-id check (`transporte.ts`), and the document module's
      // internals (`documentosEasyShip.ts`).
      'exigirPedidoAmazon',
      'crc32',
    ]) {
      expect(exportados, interno).not.toContain(interno);
    }
  });

  it('declares no MarketplaceChannel (ADR 0015)', () => {
    expect(Object.keys(barril)).not.toContain('MarketplaceChannel');
  });
});
