import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_SURFACE,
  ShopeeArquivoVazioError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  shopeeErrorFromEnvelope,
  shopeeLinhaDeLoteSchema,
  shopeeOrderDetailPayloadSchema,
  shopeePackageDetailPayloadSchema,
  shopeeParametroDeDocumentoSchema,
  shopeeResultadoDeDocumentoSchema,
  shopeeShippingParameterPayloadSchema,
  shopeeTrackingNumberPayloadSchema,
  type BaixarDocumentoParams,
  type CriarDocumentoParams,
  type DocumentoParams,
  type GetOrderDetailParams,
  type GetPackageDetailParams,
  type GetTrackingNumberParams,
  type ShipOrderParams,
  type ShopeeAlvoDePacote,
  type ShopeeApiError,
  type ShopeeClient,
  type ShopeeLoteLogistico,
} from '@delfrance/integrations-shopee';

import {
  ESPERA_POS_PROGRAMAR_MS,
  INTERVALO_DOCUMENTO_MS,
  INTERVALO_RASTREIO_MS,
  TENTAR_EM_LIMITE_MS,
} from './constantesEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE } from './errosEtiqueta';
import {
  executarEtiquetaShopee,
  type EntradaEtiqueta,
  type ResultadoEtiqueta,
} from './executarEtiqueta';
import { MENSAGEM_DA_FASE } from './respostaEtiqueta';

/* ---------------------------------- the world -------------------------------- */

const ORDER_SN = '260910KJBHUJDM';
const P1 = 'OFG000000000001';
const P2 = 'OFG000000000002';
const RASTREIO = 'BR000000000000T';
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0x80]);
const HTML = new TextEncoder().encode('<html>erro</html>');

interface PacoteDoMundo {
  numero: string;
  canal: number | null;
  fulfillment: string;
  arranjado: boolean | null;
  /** `tracking_number` on the package row (VERBATIM, `-` included). */
  rastreioNaLinha: string | null;
  /** What `get_tracking_number` answers, one per call; the last one repeats. */
  rastreiosDaApi: string[];
  invoicePendente?: boolean;
  selecionaveis: string[] | null;
  sugerido: string | null;
  criado: boolean;
  /** What `get_shipping_document_result` answers once created; the last one repeats. */
  statusDoDocumento: string[];
}

interface Mundo {
  status: string;
  fbs: string | null;
  pacotes: PacoteDoMundo[];
  parametro: unknown;
  /** Does our ship show on the next `get_package_detail`? (register 208) */
  refletirShip: boolean;
  /** Thrown by `shipOrder`, in order; an exhausted queue succeeds. */
  errosDoShip: unknown[];
  errosDoDownload: unknown[];
  errosDoRastreio: unknown[];
  arquivo: Uint8Array;
  /** Rows of `create_shipping_document`, replacing the defaults when set. */
  linhasDoCriar: unknown[] | null;
  /** Rows of `get_shipping_document_parameter`, replacing the defaults when set. */
  linhasDoParametro: unknown[] | null;
  /** Advance the clock by this much on each `get_tracking_number`. */
  custoDoRastreioMs: number;
}

function pacote(numero: string, extra: Partial<PacoteDoMundo> = {}): PacoteDoMundo {
  return {
    numero,
    canal: 91001,
    fulfillment: 'LOGISTICS_READY',
    arranjado: false,
    rastreioNaLinha: '-',
    rastreiosDaApi: [RASTREIO],
    selecionaveis: ['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'],
    sugerido: 'NORMAL_AIR_WAYBILL',
    criado: false,
    statusDoDocumento: ['READY'],
    ...extra,
  };
}

/** Arranged, tracked, and its document READY: a reprint. */
function pronto(numero: string, extra: Partial<PacoteDoMundo> = {}): PacoteDoMundo {
  return pacote(numero, {
    fulfillment: 'LOGISTICS_REQUEST_CREATED',
    arranjado: true,
    rastreioNaLinha: RASTREIO,
    criado: true,
    ...extra,
  });
}

const UM_ENDERECO = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: {
    address_list: [
      {
        address_id: 2001,
        city: 'Cidade do Vendedor',
        address: 'Rua do Vendedor, 100',
        address_flag: ['pickup_address', 'default_address'],
        time_slot_list: [{ date: 1_790_000_000, time_text: '09:00', pickup_time_id: 'slot-1' }],
      },
    ],
  },
};

const DOIS_ENDERECOS = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: {
    address_list: [
      {
        address_id: 2001,
        address: 'Rua do Vendedor, 100',
        address_flag: ['pickup_address'],
        time_slot_list: [{ date: 1_790_000_000, time_text: '09:00', pickup_time_id: 'slot-1' }],
      },
      {
        address_id: 2002,
        address: 'Rua do Vendedor, 200',
        address_flag: ['pickup_address'],
        time_slot_list: [{ date: 1_790_000_000, time_text: '14:00', pickup_time_id: 'slot-2' }],
      },
    ],
  },
};

function mundo(pacotes: PacoteDoMundo[], extra: Partial<Mundo> = {}): Mundo {
  return {
    status: 'READY_TO_SHIP',
    fbs: 'fulfilled_by_local_seller',
    pacotes,
    parametro: UM_ENDERECO,
    refletirShip: true,
    errosDoShip: [],
    errosDoDownload: [],
    errosDoRastreio: [],
    arquivo: PDF,
    linhasDoCriar: null,
    linhasDoParametro: null,
    custoDoRastreioMs: 0,
    ...extra,
  };
}

function envelope(error: string, message: string | null = null): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path: '/api/v2/logistics/x', httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function lote<Row>(linhas: Row[]): ShopeeLoteLogistico<Row> {
  return { requestId: null, todasFalharam: false, linhas, linhasIlegiveis: 0, avisos: null };
}

function proximo<T>(fila: T[]): T {
  const v = fila.length > 1 ? fila.shift() : fila[0];
  if (v === undefined) throw new Error('fila vazia');
  return v;
}

/** A stateful fake Shopee, a fake clock and a fake sleep. */
function montar(m: Mundo) {
  const relogio = { agora: T0 };
  const doMundo = (numero: string | undefined) => {
    const p = m.pacotes.find((x) => x.numero === numero);
    if (p === undefined) throw new Error('pacote desconhecido no mundo');
    return p;
  };

  const getOrderDetail = vi.fn(async (_p: GetOrderDetailParams) =>
    shopeeOrderDetailPayloadSchema.parse({
      order_list: [
        {
          order_sn: ORDER_SN,
          order_status: m.status,
          fulfillment_flag: m.fbs,
          package_list: m.pacotes.map((p) => ({ package_number: p.numero })),
        },
      ],
    }),
  );
  const getPackageDetail = vi.fn(async (p: GetPackageDetailParams) =>
    shopeePackageDetailPayloadSchema.parse({
      package_list: p.packageNumbers.map((n) => {
        const x = doMundo(n);
        return {
          order_sn: ORDER_SN,
          package_number: x.numero,
          fulfillment_status: x.fulfillment,
          logistics_channel_id: x.canal,
          is_shipment_arranged: x.arranjado,
          tracking_number: x.rastreioNaLinha,
          pending_terms: [],
          invoice_pending: x.invoicePendente === true ? { status: ' Pending ' } : null,
        };
      }),
    }),
  );
  const getShippingParameter = vi.fn(async () =>
    shopeeShippingParameterPayloadSchema.parse(m.parametro),
  );
  const shipOrder = vi.fn(async (p: ShipOrderParams) => {
    const erro = m.errosDoShip.shift();
    if (erro !== undefined) throw erro;
    const alvo = p.packageNumber ?? m.pacotes[0]?.numero;
    if (m.refletirShip) {
      const x = doMundo(alvo);
      x.fulfillment = 'LOGISTICS_REQUEST_CREATED';
      x.arranjado = true;
    }
    return { error: '', message: null, request_id: null, warning: null };
  });
  const getTrackingNumber = vi.fn(async (p: GetTrackingNumberParams) => {
    relogio.agora += m.custoDoRastreioMs;
    const erro = m.errosDoRastreio.shift();
    if (erro !== undefined) throw erro;
    return shopeeTrackingNumberPayloadSchema.parse({
      tracking_number: proximo(doMundo(p.packageNumber).rastreiosDaApi),
    });
  });
  const getShippingDocumentParameter = vi.fn(
    async (p: { readonly pacotes: readonly ShopeeAlvoDePacote[] }) =>
      lote(
        (
          m.linhasDoParametro ??
          p.pacotes.map((a) => {
            const x = doMundo(a.packageNumber);
            return {
              order_sn: ORDER_SN,
              package_number: x.numero,
              suggest_shipping_document_type: x.sugerido,
              selectable_shipping_document_type: x.selecionaveis,
            };
          })
        ).map((r) => shopeeParametroDeDocumentoSchema.parse(r)),
      ),
  );
  const createShippingDocument = vi.fn(async (p: CriarDocumentoParams) => {
    for (const d of p.documentos) doMundo(d.packageNumber).criado = true;
    return lote(
      (
        m.linhasDoCriar ??
        p.documentos.map((d) => ({ order_sn: ORDER_SN, package_number: d.packageNumber }))
      ).map((r) => shopeeLinhaDeLoteSchema.parse(r)),
    );
  });
  const getShippingDocumentResult = vi.fn(async (p: DocumentoParams) =>
    lote(
      p.documentos.map((d) => {
        const x = doMundo(d.packageNumber);
        return shopeeResultadoDeDocumentoSchema.parse(
          x.criado
            ? { order_sn: ORDER_SN, package_number: x.numero, status: proximo(x.statusDoDocumento) }
            : {
                order_sn: ORDER_SN,
                package_number: x.numero,
                fail_error: 'logistics.shipping_document_should_print_first',
                fail_message: 'print first',
              },
        );
      }),
    ),
  );
  const downloadShippingDocument = vi.fn(async (_p: BaixarDocumentoParams) => {
    const erro = m.errosDoDownload.shift();
    if (erro !== undefined) throw erro;
    return {
      bytes: m.arquivo,
      contentType: 'application/pdf',
      contentDisposition: null,
      httpStatus: 200,
    };
  });

  const client = {
    getOrderDetail,
    getPackageDetail,
    getShippingParameter,
    shipOrder,
    getTrackingNumber,
    getShippingDocumentParameter,
    createShippingDocument,
    getShippingDocumentResult,
    downloadShippingDocument,
  } as unknown as ShopeeClient;

  const dormir = vi.fn(async (ms: number) => {
    relogio.agora += ms;
  });

  const rodar = (
    e: Partial<EntradaEtiqueta> = {},
    deps: { orcamentoMs?: number; somenteLeitura?: boolean; podeProgramar?: boolean } = {},
  ): Promise<ResultadoEtiqueta> =>
    executarEtiquetaShopee(
      {
        client,
        agora: () => relogio.agora,
        dormir,
        podeProgramar: deps.podeProgramar ?? true,
        ...(deps.orcamentoMs === undefined ? {} : { orcamentoMs: deps.orcamentoMs }),
        ...(deps.somenteLeitura === undefined ? {} : { somenteLeitura: deps.somenteLeitura }),
      },
      { orderSn: ORDER_SN, formato: 'pdf', pacote: null, envio: null, ...e },
    );

  return {
    rodar,
    relogio,
    dormir,
    getOrderDetail,
    getPackageDetail,
    getShippingParameter,
    shipOrder,
    getTrackingNumber,
    getShippingDocumentParameter,
    createShippingDocument,
    getShippingDocumentResult,
    downloadShippingDocument,
  };
}

function pendente(r: ResultadoEtiqueta) {
  if (r.tipo !== 'pendente') throw new Error(`esperava pendente, veio ${r.tipo}`);
  return r.corpo;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------- the reads -------------------------------- */

describe('executarEtiquetaShopee — a leitura', () => {
  it('S20: get_order_detail pede EXATAMENTE package_list,fulfillment_flag', async () => {
    const s = montar(mundo([pronto(P1)]));
    await s.rodar();
    expect(s.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(s.getOrderDetail.mock.calls[0]?.[0]).toStrictEqual({
      orderSnList: [ORDER_SN],
      responseOptionalFields: ['package_list', 'fulfillment_flag'],
    });
  });

  it('get_package_detail em lotes de 50 (51 pacotes ⇒ 50 + 1)', async () => {
    const pacotes = Array.from({ length: 51 }, (_, i) =>
      pacote(`PACOTE-TESTE-${String(i).padStart(3, '0')}`, {
        fulfillment: 'LOGISTICS_NOT_START',
      }),
    );
    const s = montar(mundo(pacotes));
    await expect(s.rodar()).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.pacoteNaoPronto,
    });
    expect(s.getPackageDetail.mock.calls.map((c) => c[0].packageNumbers.length)).toStrictEqual([
      50, 1,
    ]);
  });

  it('um erro que a tabela não possui é RELANÇADO intacto', async () => {
    const s = montar(mundo([pronto(P1)]));
    const estranho = new TypeError('não é da Shopee');
    s.getOrderDetail.mockRejectedValueOnce(estranho);
    await expect(s.rodar()).rejects.toBe(estranho);
  });

  it('invoice_pending ⇒ nfe-pendente, ZERO get_shipping_parameter', async () => {
    const s = montar(
      mundo([pacote(P1, { invoicePendente: true, fulfillment: 'LOGISTICS_NOT_START' })]),
    );
    await expect(s.rodar()).resolves.toStrictEqual({ tipo: 'nfe-pendente' });
    expect(s.getShippingParameter).not.toHaveBeenCalled();
  });
});

/* ------------------------------- the round trip ------------------------------ */

describe('executarEtiquetaShopee — a volta completa', () => {
  it('pacote novo → escolher-envio → a resposta → ship → aguardar rastreio → aguardar documento → bytes', async () => {
    const p = pacote(P1, { rastreiosDaApi: [''], statusDoDocumento: ['PROCESSING'] });
    const m = mundo([p], { parametro: DOIS_ENDERECOS });
    const s = montar(m);

    // ---- 1: the question, ZERO ship ----
    const pergunta = pendente(await s.rodar());
    expect(pergunta).toMatchObject({
      acao: 'escolher-envio',
      fase: 'programando',
      pacote: P1,
      pacoteRotulo: null,
      escolhaInvalida: false,
      permiteDropoff: false,
    });
    expect(pergunta.acao === 'escolher-envio' ? pergunta.enderecos.map((e) => e.id) : []).toEqual([
      '2001',
      '2002',
    ]);
    expect(s.shipOrder).not.toHaveBeenCalled();

    // ---- 2: the answer ⇒ ONE ship; no tracking inside the budget ⇒ 202 ----
    const envio = { pacote: P1, modo: 'pickup' as const, enderecoId: '2002', horarioId: 'slot-2' };
    const rastreio = pendente(await s.rodar({ envio }));
    expect(rastreio).toStrictEqual({
      acao: 'aguardar',
      fase: 'aguardando-rastreio',
      tentarEmMs: INTERVALO_RASTREIO_MS,
      mensagem: MENSAGEM_DA_FASE['aguardando-rastreio'],
      progresso: { total: 1, organizados: 1, comRastreio: 0, prontos: 0 },
    });
    expect(s.shipOrder).toHaveBeenCalledTimes(1);
    expect(s.shipOrder.mock.calls[0]?.[0]).toStrictEqual({
      orderSn: ORDER_SN,
      modo: 'pickup',
      pickup: { addressId: 2002, pickupTimeId: 'slot-2' },
    });
    expect(s.createShippingDocument).not.toHaveBeenCalled();

    // ---- 3: the tracking number arrives; the document is still processing ⇒ 202 ----
    p.rastreiosDaApi = [RASTREIO];
    const documento = pendente(await s.rodar());
    expect(documento).toMatchObject({
      acao: 'aguardar',
      fase: 'gerando-documento',
      progresso: { total: 1, organizados: 1, comRastreio: 1, prontos: 0 },
    });
    expect(s.createShippingDocument).toHaveBeenCalledTimes(1);
    expect(s.createShippingDocument.mock.calls[0]?.[0]).toStrictEqual({
      documentos: [
        {
          orderSn: ORDER_SN,
          packageNumber: P1,
          shippingDocumentType: 'NORMAL_AIR_WAYBILL',
          trackingNumber: RASTREIO,
        },
      ],
    });

    // ---- 4: READY ⇒ the bytes ----
    p.rastreioNaLinha = RASTREIO;
    p.statusDoDocumento = ['READY'];
    const final = await s.rodar();
    expect(final).toStrictEqual({
      tipo: 'bytes',
      bytes: PDF,
      formato: 'pdf',
      contentType: 'application/pdf',
      extensao: 'pdf',
      indice: null,
      total: 1,
    });
    expect(s.downloadShippingDocument).toHaveBeenCalledWith({
      shippingDocumentType: 'NORMAL_AIR_WAYBILL',
      documentos: [{ orderSn: ORDER_SN, packageNumber: P1 }],
    });
    // The whole flow: ONE ship, ONE create.
    expect(s.shipOrder).toHaveBeenCalledTimes(1);
    expect(s.createShippingDocument).toHaveBeenCalledTimes(1);
  });

  it('uma nova chamada depois de um abort (já organizado) ⇒ ZERO shipOrder', async () => {
    const s = montar(
      mundo([pacote(P1, { fulfillment: 'LOGISTICS_REQUEST_CREATED', arranjado: true })]),
    );
    const r = await s.rodar();
    expect(r.tipo).toBe('bytes');
    expect(s.shipOrder).not.toHaveBeenCalled();
    expect(s.getShippingParameter).not.toHaveBeenCalled();
  });

  it('package_already_shipped ⇒ retoma (e nunca envia de novo, mesmo lendo READY)', async () => {
    const m = mundo([pacote(P1, { arranjado: null })], {
      refletirShip: false,
      errosDoShip: [envelope(' logistics.package_already_shipped', 'already shipped')],
    });
    const s = montar(m);
    const r = await s.rodar();
    expect(r.tipo).toBe('bytes');
    expect(s.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('o próprio ship ainda invisível na releitura (registro 208) ⇒ organizado, UM ship', async () => {
    const s = montar(mundo([pacote(P1)], { refletirShip: false }));
    const r = await s.rodar();
    expect(r.tipo).toBe('bytes');
    expect(s.shipOrder).toHaveBeenCalledTimes(1);
    expect(s.dormir).toHaveBeenCalledWith(ESPERA_POS_PROGRAMAR_MS);
  });

  it('S30: rede caída no ship ⇒ 202 programando, UM ship, nada depois', async () => {
    const s = montar(mundo([pacote(P1)], { errosDoShip: [new ShopeeNetworkError('queda')] }));
    const r = pendente(await s.rodar());
    expect(r).toMatchObject({
      acao: 'aguardar',
      fase: 'programando',
      tentarEmMs: ESPERA_POS_PROGRAMAR_MS,
    });
    expect(s.shipOrder).toHaveBeenCalledTimes(1);
    expect(s.getTrackingNumber).not.toHaveBeenCalled();
  });
});

/* ------------------------------ the permissions ------------------------------ */

describe('executarEtiquetaShopee — permissão e simulação', () => {
  it('S38: sem frete.write no `programar` ⇒ sem-permissao ANTES do get_shipping_parameter', async () => {
    const s = montar(mundo([pacote(P1)]));
    await expect(s.rodar({}, { podeProgramar: false })).resolves.toStrictEqual({
      tipo: 'sem-permissao',
    });
    expect(s.getShippingParameter).not.toHaveBeenCalled();
    expect(s.shipOrder).not.toHaveBeenCalled();
  });

  it('S37: sem frete.write, um pacote JÁ organizado imprime', async () => {
    const s = montar(mundo([pronto(P1)]));
    const r = await s.rodar({}, { podeProgramar: false });
    expect(r.tipo).toBe('bytes');
  });

  it('S46: somenteLeitura ⇒ simulado, ZERO ship/create/download — em cada ação de escrita', async () => {
    const casos: { pacote: PacoteDoMundo; acao: string }[] = [
      { pacote: pacote(P1), acao: 'programar' },
      { pacote: pronto(P1, { criado: false }), acao: 'criar-documento' },
      { pacote: pronto(P1), acao: 'baixar' },
    ];
    for (const caso of casos) {
      const s = montar(mundo([caso.pacote]));
      const r = await s.rodar({}, { somenteLeitura: true });
      expect(r.tipo).toBe('simulado');
      expect(r.tipo === 'simulado' ? r.acao.tipo : null).toBe(caso.acao);
      expect(s.shipOrder).not.toHaveBeenCalled();
      expect(s.createShippingDocument).not.toHaveBeenCalled();
      expect(s.downloadShippingDocument).not.toHaveBeenCalled();
    }
  });

  it('a simulação diz a fase de cada pacote por POSIÇÃO e o progresso', async () => {
    const s = montar(mundo([pronto(P1), pacote(P2)]));
    const r = await s.rodar({}, { somenteLeitura: true });
    expect(r).toMatchObject({
      tipo: 'simulado',
      fases: ['arranjado', 'programar'],
      progresso: { total: 2, organizados: 1 },
    });
  });

  it('IN_CANCEL recusa só no programar; um pacote já organizado ainda imprime (R-v)', async () => {
    const s = montar(mundo([pacote(P1)], { status: 'IN_CANCEL' }));
    await expect(s.rodar()).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoEmCancelamento,
    });
    expect(s.getShippingParameter).not.toHaveBeenCalled();

    const t = montar(mundo([pronto(P1)], { status: 'IN_CANCEL' }));
    expect((await t.rodar()).tipo).toBe('bytes');
  });
});

/* ------------------------------- multi-package ------------------------------- */

describe('executarEtiquetaShopee — pedido dividido (R-s)', () => {
  it('organiza TODOS os pacotes em sequência, cada ship nomeando o seu pacote', async () => {
    const s = montar(mundo([pacote(P1), pacote(P2)]));
    const r = await s.rodar();
    expect(r).toMatchObject({ tipo: 'bytes', indice: null, total: 2 });
    expect(s.shipOrder.mock.calls.map((c) => c[0].packageNumber)).toStrictEqual([P1, P2]);
    expect(s.downloadShippingDocument).toHaveBeenCalledWith({
      shippingDocumentType: 'NORMAL_AIR_WAYBILL',
      documentos: [
        { orderSn: ORDER_SN, packageNumber: P1 },
        { orderSn: ORDER_SN, packageNumber: P2 },
      ],
    });
  });

  it('a pergunta nomeia o seu pacote ("Pacote i de n"), e a resposta de um não serve ao outro', async () => {
    const s = montar(mundo([pacote(P1), pacote(P2)], { parametro: DOIS_ENDERECOS }));
    const primeira = pendente(await s.rodar());
    expect(primeira).toMatchObject({
      acao: 'escolher-envio',
      pacote: P1,
      pacoteRotulo: 'Pacote 1 de 2',
    });

    const envio = { pacote: P1, modo: 'pickup' as const, enderecoId: '2001', horarioId: 'slot-1' };
    const segunda = pendente(await s.rodar({ envio }));
    expect(segunda).toMatchObject({
      acao: 'escolher-envio',
      pacote: P2,
      pacoteRotulo: 'Pacote 2 de 2',
    });
    expect(s.shipOrder).toHaveBeenCalledTimes(1);
    expect(s.shipOrder.mock.calls[0]?.[0].packageNumber).toBe(P1);
  });

  it('dois canais ⇒ baixar-por-pacote, ZERO download; o re-call com `pacote` baixa -p2de2', async () => {
    const s = montar(mundo([pronto(P1, { canal: 91001 }), pronto(P2, { canal: 91002 })]));
    const r = pendente(await s.rodar());
    expect(r).toMatchObject({ acao: 'baixar-por-pacote', fase: 'baixando', pacotes: [P1, P2] });
    expect(s.downloadShippingDocument).not.toHaveBeenCalled();

    const um = await s.rodar({ pacote: P2 });
    expect(um).toMatchObject({ tipo: 'bytes', indice: 2, total: 2 });
    expect(s.downloadShippingDocument).toHaveBeenCalledWith({
      shippingDocumentType: 'NORMAL_AIR_WAYBILL',
      documentos: [{ orderSn: ORDER_SN, packageNumber: P2 }],
    });
  });

  it('packages_can_not_download_together (backstop) ⇒ a mesma resposta por pacote', async () => {
    const s = montar(
      mundo([pronto(P1), pronto(P2)], {
        errosDoDownload: [envelope('logistics.packages_can_not_download_together')],
      }),
    );
    expect(pendente(await s.rodar())).toMatchObject({
      acao: 'baixar-por-pacote',
      pacotes: [P1, P2],
    });
  });

  it('uma linha FALHA sem package_number num pedido dividido é do lote inteiro (nunca adivinha)', async () => {
    const s = montar(
      mundo([pronto(P1, { criado: false }), pronto(P2, { criado: false })], {
        linhasDoCriar: [
          {
            order_sn: ORDER_SN,
            package_number: null,
            fail_error: 'logistics.package_can_not_print',
            fail_message: 'x',
          },
        ],
      }),
    );
    await expect(s.rodar()).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.etiquetaIndisponivel,
    });
  });

  it('uma linha de SUCESSO sem package_number casa só num pedido de UM pacote', async () => {
    const linha = {
      order_sn: ORDER_SN,
      package_number: null,
      suggest_shipping_document_type: 'THERMAL_AIR_WAYBILL',
      selectable_shipping_document_type: ['THERMAL_AIR_WAYBILL'],
    };
    const um = montar(mundo([pronto(P1, { criado: false })], { linhasDoParametro: [linha] }));
    await um.rodar();
    expect(um.createShippingDocument.mock.calls[0]?.[0].documentos[0]?.shippingDocumentType).toBe(
      'THERMAL_AIR_WAYBILL',
    );

    // Near-miss: on a split order the row names no package ⇒ no package gets it.
    const dois = montar(
      mundo([pronto(P1, { criado: false }), pronto(P2, { criado: false })], {
        linhasDoParametro: [linha],
      }),
    );
    await dois.rodar();
    for (const d of dois.createShippingDocument.mock.calls[0]?.[0].documentos ?? []) {
      expect('shippingDocumentType' in d).toBe(false);
    }
  });
});

/* ------------------------------ the document --------------------------------- */

describe('executarEtiquetaShopee — o documento (R-u)', () => {
  it('zpl2 ⇒ THERMAL quando selecionável', async () => {
    const s = montar(mundo([pronto(P1, { criado: false })]));
    await s.rodar({ formato: 'zpl2' });
    expect(s.createShippingDocument.mock.calls[0]?.[0].documentos[0]?.shippingDocumentType).toBe(
      'THERMAL_AIR_WAYBILL',
    );
  });

  it('não selecionável ⇒ o `suggest` da Shopee', async () => {
    const s = montar(
      mundo([
        pronto(P1, {
          criado: false,
          selecionaveis: ['NORMAL_AIR_WAYBILL'],
          sugerido: 'NORMAL_AIR_WAYBILL',
        }),
      ]),
    );
    await s.rodar({ formato: 'zpl2' });
    expect(s.createShippingDocument.mock.calls[0]?.[0].documentos[0]?.shippingDocumentType).toBe(
      'NORMAL_AIR_WAYBILL',
    );
  });

  it('nem selecionável nem suggest ⇒ tipo OMITIDO — decidido UMA vez, nunca re-perguntado', async () => {
    const s = montar(mundo([pronto(P1, { criado: false, selecionaveis: null, sugerido: null })]));
    const r = await s.rodar();
    expect(r.tipo).toBe('bytes');
    expect(s.getShippingDocumentParameter).toHaveBeenCalledTimes(1);
    expect(
      'shippingDocumentType' in (s.createShippingDocument.mock.calls[0]?.[0].documentos[0] ?? {}),
    ).toBe(false);
    expect('shippingDocumentType' in (s.downloadShippingDocument.mock.calls[0]?.[0] ?? {})).toBe(
      false,
    );
  });

  it('round-trip 7: rastreio "-" na linha e "" na API ⇒ NUNCA um create', async () => {
    const s = montar(
      mundo([pronto(P1, { criado: false, rastreioNaLinha: '-', rastreiosDaApi: [''] })]),
    );
    const r = pendente(await s.rodar());
    expect(r).toMatchObject({ acao: 'aguardar', fase: 'aguardando-rastreio' });
    expect(s.getTrackingNumber).toHaveBeenCalled();
    expect(s.createShippingDocument).not.toHaveBeenCalled();
  });

  it('documento FAILED ⇒ recriado UMA vez; FAILED de novo ⇒ documento-falhou', async () => {
    const s = montar(mundo([pronto(P1, { statusDoDocumento: ['FAILED'] })]));
    await expect(s.rodar()).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.documentoFalhou,
    });
    expect(s.createShippingDocument).toHaveBeenCalledTimes(1);
  });

  it('tipo recusado no create ⇒ cai para o suggest UMA vez; recusado de novo ⇒ tipo-invalido', async () => {
    const recusado = {
      order_sn: ORDER_SN,
      package_number: P1,
      fail_error: 'logistics.shipping_document_type_invalid',
      fail_message: 'x',
    };
    const s = montar(
      mundo([pronto(P1, { criado: false, sugerido: 'THERMAL_AIR_WAYBILL' })], {
        linhasDoCriar: [recusado],
      }),
    );
    await expect(s.rodar()).resolves.toStrictEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.tipoInvalido,
    });
    expect(
      s.createShippingDocument.mock.calls.map((c) => c[0].documentos[0]?.shippingDocumentType),
    ).toStrictEqual(['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL']);
  });

  it('arquivo vazio ⇒ UMA espera por chamada, depois os bytes', async () => {
    const vazio = () => new ShopeeArquivoVazioError('vazio', { httpStatus: 200, path: '/x' });
    const s = montar(mundo([pronto(P1)], { errosDoDownload: [vazio()] }));
    expect((await s.rodar()).tipo).toBe('bytes');
    expect(s.dormir).toHaveBeenCalledWith(INTERVALO_DOCUMENTO_MS);
    expect(s.downloadShippingDocument).toHaveBeenCalledTimes(2);
  });

  it('arquivo vazio DUAS vezes na mesma chamada ⇒ o segundo é relançado (o 502 da rota)', async () => {
    const segundo = new ShopeeArquivoVazioError('vazio 2', { httpStatus: 200, path: '/x' });
    const s = montar(
      mundo([pronto(P1)], {
        errosDoDownload: [
          new ShopeeArquivoVazioError('vazio 1', { httpStatus: 200, path: '/x' }),
          segundo,
        ],
      }),
    );
    await expect(s.rodar()).rejects.toBe(segundo);
  });

  it('bytes sem assinatura conhecida ⇒ formato-desconhecido; o log não leva id nem byte', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = montar(mundo([pronto(P1)], { arquivo: HTML }));
    await expect(s.rodar()).resolves.toStrictEqual({ tipo: 'formato-desconhecido' });
    const logado = JSON.stringify(aviso.mock.calls);
    for (const proibido of [ORDER_SN, P1, RASTREIO, '<html>']) {
      expect(logado).not.toContain(proibido);
    }
  });
});

/* -------------------------------- the budget --------------------------------- */

describe('executarEtiquetaShopee — o orçamento', () => {
  it('o rastreio é consultado a cada INTERVALO_RASTREIO_MS dentro dos 30 s, e a espera que não cabe vira 202', async () => {
    const s = montar(
      mundo([pronto(P1, { criado: false, rastreioNaLinha: '-', rastreiosDaApi: [''] })]),
    );
    const r = pendente(await s.rodar());
    expect(r).toMatchObject({ fase: 'aguardando-rastreio', tentarEmMs: INTERVALO_RASTREIO_MS });
    // Polls at 0, 5, 10, 15, 20 and 25 s; the wait to 30 s does not fit.
    expect(s.getTrackingNumber).toHaveBeenCalledTimes(6);
    expect(s.relogio.agora - T0).toBe(25_000);
  });

  it('nenhuma ação COMEÇA depois do prazo', async () => {
    // Every tracking read costs 20 s: 0 → 20 (starts, 20 < 30) → 40; the third never starts.
    const s = montar(
      mundo(
        [
          pronto(P1, { rastreioNaLinha: '-', rastreiosDaApi: [''] }),
          pronto(P2, { rastreioNaLinha: '-', rastreiosDaApi: [''] }),
          pronto('PACOTE-TESTE-003', { rastreioNaLinha: '-', rastreiosDaApi: [''] }),
        ],
        { custoDoRastreioMs: 20_000 },
      ),
    );
    const r = pendente(await s.rodar());
    expect(r).toMatchObject({ acao: 'aguardar', fase: 'aguardando-rastreio', tentarEmMs: 0 });
    expect(s.getTrackingNumber).toHaveBeenCalledTimes(2);
  });

  it('um limite burst no rastreio é esperado DENTRO da chamada quando cabe', async () => {
    const burst = new ShopeeRateLimitError('burst', {
      code: 'error_busy',
      kind: 'burst',
      httpStatus: 429,
      path: '/x',
      retryAfterSeconds: null,
    });
    const s = montar(mundo([pronto(P1, { rastreioNaLinha: '-' })], { errosDoRastreio: [burst] }));
    expect((await s.rodar()).tipo).toBe('bytes');
    expect(s.dormir).toHaveBeenCalledWith(TENTAR_EM_LIMITE_MS);
  });
});
