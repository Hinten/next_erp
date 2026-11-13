import { describe, expect, it } from 'vitest';

import * as cliente from '../src/client';
import * as integridade from '../src/crc32';
import * as barril from '../src/index';
import * as preAssinada from '../src/preAssinada';

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
    // Listings (step 12a).
    expect(barril.OPERACAO_LER_LISTING).toBe('getListingsItem');
    expect(barril.OPERACAO_BUSCAR_LISTINGS).toBe('searchListingsItems');
    expect(barril.OPERACAO_ENVIAR_LISTING).toBe('patchListingsItem');
    expect(barril.CAMINHO_LISTINGS).toBe('/listings/2021-08-01/items');
    expect(barril.MAX_SKUS_POR_BUSCA).toBe(20);
    expect(barril.CANAL_MFN).toBe('DEFAULT');
    expect(barril.TIPO_PRODUTO_OFERTA).toBe('PRODUCT');
    expect(barril.CAMINHO_ATRIBUTO_DISPONIBILIDADE).toBe('/attributes/fulfillment_availability');
    expect(barril.LOCALIDADE_ISSUES_LISTINGS).toBe('pt_BR');
    expect(barril.DADOS_LISTING_AMAZON).toEqual({
      resumos: 'summaries',
      disponibilidade: 'fulfillmentAvailability',
      relacoes: 'relationships',
      issues: 'issues',
    });
    // Feeds (step 12a).
    expect(barril.OPERACAO_CRIAR_DOCUMENTO_FEED).toBe('createFeedDocument');
    expect(barril.OPERACAO_CRIAR_FEED).toBe('createFeed');
    expect(barril.OPERACAO_LER_FEED).toBe('getFeed');
    expect(barril.OPERACAO_LER_DOCUMENTO_FEED).toBe('getFeedDocument');
    expect(barril.CAMINHO_DOCUMENTOS_FEED).toBe('/feeds/2021-06-30/documents');
    expect(barril.CAMINHO_FEEDS).toBe('/feeds/2021-06-30/feeds');
    expect(barril.TIPO_FEED_LISTINGS).toBe('JSON_LISTINGS_FEED');
    expect(barril.CONTENT_TYPE_FEED_JSON).toBe('application/json; charset=UTF-8');
    expect(barril.MAX_MENSAGENS_FEED).toBe(25_000);
    expect(barril.MAX_BYTES_FEED).toBe(9_500_000);
    expect(barril.VERSAO_FEED_LISTINGS).toBe('2.0');
    expect(barril.LOCALIDADE_ISSUES_FEED).toBe('pt_BR');
    expect(barril.FEED_ID_AMAZON_REGEX.source).toBe('^[0-9]{1,20}$');
    expect(Object.keys(barril.STATUS_FEED_AMAZON)).toHaveLength(5);
    expect(barril.MAX_RELATORIO_FEED_BYTES).toBe(20 * 1024 * 1024);
    expect(barril.MAX_RELATORIO_JSON_BYTES).toBe(32 * 1024 * 1024);
    expect(barril.VALIDADE_URL_DOCUMENTO_FEED_MS).toBe(5 * 60_000);
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
      'ehTransitoriaDocumentoFeed',
      'segmentoSkuAmazon',
      'skuTemCaminhoAmazon',
      'skuBuscavelAmazon',
      'lerListingAmazon',
      'buscarListingsAmazon',
      'enviarDisponibilidadeAmazon',
      'criarDocumentoFeedAmazon',
      'criarFeedAmazon',
      'lerFeedAmazon',
      'lerDocumentoFeedAmazon',
      'montarDocumentoListingsFeed',
      'lerRelatorioProcessamentoListings',
      'enviarDocumentoFeedAmazon',
      'baixarRelatorioFeedAmazon',
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
      'listingAmazonSchema',
      'buscaListingsAmazonSchema',
      'envioListingAmazonSchema',
      'documentoFeedCriadoSchema',
      'feedCriadoSchema',
      'feedAmazonSchema',
      'documentoFeedSchema',
      'relatorioProcessamentoListingsSchema',
    ] as const) {
      expect(typeof barril[nome].safeParse, nome).toBe('function');
    }
    expect(barril.PRAZO_AMAZON_MS).toEqual({
      documento: 20_000,
      escrita: 30_000,
      leitura: 20_000,
      lwa: 20_000,
      upload: 30_000,
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
      barril.AmazonDocumentoFeedError,
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
      // The path check and its one-segment encoder (`client.ts`), the shared
      // pre-signed URL guard (`preAssinada.ts`) and the integrity helpers
      // (`crc32.ts`).
      'caminhoValido',
      'segmentoDeCaminho',
      'urlPreAssinadaAmazon',
      'ehErroDoFflate',
    ]) {
      expect(exportados, interno).not.toContain(interno);
    }
    // Anti-vacuity: the step-12a internals are real — their modules DO export them.
    expect(typeof cliente.caminhoValido).toBe('function');
    expect(typeof cliente.segmentoDeCaminho).toBe('function');
    expect(typeof preAssinada.urlPreAssinadaAmazon).toBe('function');
    expect(typeof integridade.crc32).toBe('function');
    expect(typeof integridade.ehErroDoFflate).toBe('function');
  });

  it('declares no MarketplaceChannel (ADR 0015)', () => {
    expect(Object.keys(barril)).not.toContain('MarketplaceChannel');
  });
});
