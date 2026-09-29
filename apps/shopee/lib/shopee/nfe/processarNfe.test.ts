/**
 * The NF-e upload HANDLER (#1522, step 14), driven through `processarNfeShopee`
 * exactly as the queue calls it: the REAL aviso writer, the REAL frete stamp and
 * the REAL recheck module over the shared fake Firestore, a fake SHOP client and
 * a recording scheduler.
 *
 * ⛔ titles name the reconcile §4 mutant each test kills (59–62, 64–67, plus 30
 * and 32 from the handler side). Every predicate test names a PAIR (must come
 * out equal) and a NEAR-MISS (must stay distinct).
 *
 * ⚠️ Fixture keys are SYNTHETIC and visibly fake — cUF `99` (no such UF) and a
 * CNPJ of repeated digits — assembled field by field; the ids are the repo's
 * fixture ids. Nothing here reaches a network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  integracaoCollection,
  nfev4Collection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  ESTADO_FRETE,
  ESTADO_NFE,
  INTEGRACAO_FRETE,
  INTEGRACAO_TIPO,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  seedFreteInicial,
} from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES,
  SHOPEE_UPLOAD_INVOICE_DOC_PATH,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeOrderDetailRowSchema,
  type ShopeeClient,
  type ShopeeErrorKind,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { ShopeeContaSemShopIdError } from '../core/tokenStore';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { FakeDb, asDb, grpc, increment, type DocData } from '../testing/fakeDb';
import { avisarNfeShopee, chaveAvisoNfeShopee } from './avisoNfe';
import {
  ATRASOS_REVERIFICACAO_S,
  ATRASOS_SERPRO_REENVIO_S,
  NFE_SHOPEE_MAX_PAUSAS,
  NFE_SHOPEE_MAX_TENTATIVAS,
  SHOPEE_NFE_DETALHE_CAMPOS,
} from './constantesNfe';
import { MOTIVO_NFE_SHOPEE, ShopeeNfeUploadTasksDisabledError } from './errosNfe';
import {
  lerPedidoNaShopee,
  processarNfeShopee,
  simularEnvioNfeShopee,
  type DepsNfeShopee,
} from './processarNfe';
import { FASE_NFE_SHOPEE, type OpcoesDeEnfileiramentoNfe, type TarefaNfeShopee } from './tarefaNfe';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const NFE_ID = 's1';
const PEDIDO_PATH = pedidoCollection.docPath({}, PEDIDO_ID);
const NFE_PATH = nfev4Collection.docPath({ pedidoId: PEDIDO_ID }, NFE_ID);
const INTEGRACAO_PATH = integracaoCollection.docPath({}, CONTA);
const AVISO_PATH = `avisos/${chaveAvisoNfeShopee(CONTA, PEDIDO_ID)}`;
const NOW_MS = 1_789_000_000_000;
const ULTIMA_TENTATIVA = NFE_SHOPEE_MAX_TENTATIVAS - 1;

/** A synthetic key: cUF 99 + AAMM + CNPJ + mod 55 + série + nNF + tpEmis + cNF + DV. */
function montarChave(nNF = '000000001'): string {
  return `99${'2609'}${'1'.repeat(14)}55${'000'}${nNF}1${'00000000'}0`;
}

const K = montarChave();
/** Another legible key of the SAME emitter — a different nNF. */
const K_OUTRA = montarChave('000000002');

/** A minimal synthetic `nfeProc` — no signature, no real party anywhere. */
function procXml(o: { chave?: string; finNFe?: string } = {}): string {
  const chave = o.chave ?? K;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
    `<NFe><infNFe versao="4.00" Id="NFe${chave}"><ide><cUF>99</cUF><mod>55</mod>`,
    `<tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>${o.finNFe ?? '1'}</finNFe>`,
    '</ide><emit><xNome>TESTE SINTETICO SEM VALOR FISCAL</xNome></emit>',
    '</infNFe></NFe>',
    `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${chave}</chNFe>`,
    '<cStat>100</cStat></infProt></protNFe></nfeProc>',
  ].join('');
}

function nfeRaw(o: DocData = {}): DocData {
  return {
    estado: ESTADO_NFE.aprovada,
    chave: K,
    xml_nfe_proc: procXml(),
    data_autorizacao: NOW_MS - 3_600_000,
    ...o,
  };
}

function freteShopee(estado: string = ESTADO_FRETE.aguardandoNFe): DocData {
  return freteDoPedidoSchema.parse({
    ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
    externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
    estado,
    pacotes: [],
  }) as DocData;
}

function pedidoRaw(o: DocData = {}): DocData {
  return {
    numero: ORDER_SN,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    bloquearEmissaoNFe: false,
    ultimaModificacao: NOW_MS * 1000 - 5_000_000,
    freteInicial: freteShopee(),
    ...o,
  };
}

function contaRaw(o: DocData = {}): DocData {
  return { tipo: INTEGRACAO_TIPO.shopee, ativo: true, nome: 'Loja Sandbox', shop_id: SHOP, ...o };
}

/** The order row as Shopee answers it with `SHOPEE_NFE_DETALHE_CAMPOS`. */
function linha(
  o: {
    invoice?: Record<string, unknown> | null;
    status?: string;
    region?: string;
    fulfillment?: string | null;
    internacional?: boolean | null;
  } = {},
): ShopeeOrderDetailRow {
  return shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    region: o.region ?? 'BR',
    order_status: o.status ?? 'READY_TO_SHIP',
    fulfillment_flag: o.fulfillment === undefined ? 'fulfilled_by_local_seller' : o.fulfillment,
    is_international: o.internacional === undefined ? false : o.internacional,
    invoice_data: o.invoice === undefined ? { access_key: '' } : o.invoice,
  });
}

const semNota = (): ShopeeOrderDetailRow => linha();
const nossa = (status: string | null, pendingReason: string | null = null): ShopeeOrderDetailRow =>
  linha({ invoice: { access_key: K, status, pending_reason: pendingReason } });
const outra = (chave: string): ShopeeOrderDetailRow =>
  linha({ invoice: { access_key: chave, status: 'valid' } });

/** A Shopee envelope refusal of the upload. */
function recusa(
  providerMessage: string | null,
  code = 'error_param',
  kind: ShopeeErrorKind = SHOPEE_ERROR_KIND.other,
): ShopeeApiError {
  return new ShopeeApiError(`Shopee respondeu ${code}`, {
    code,
    kind,
    httpStatus: 200,
    path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
    providerMessage,
  });
}

function limite(kind: 'burst' | 'daily', retryAfterSeconds: number | null = null) {
  return new ShopeeRateLimitError(`limite ${kind}`, {
    code: kind === 'burst' ? 'error_rate_limit' : 'error_limit',
    kind,
    httpStatus: 429,
    path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
    retryAfterSeconds,
  });
}

type Leitura = ShopeeOrderDetailRow | Error | 'vazio';

interface Cenario {
  readonly db: FakeDb;
  readonly deps: DepsNfeShopee;
  readonly getOrderDetail: ReturnType<typeof vi.fn>;
  readonly uploadInvoiceDoc: ReturnType<typeof vi.fn>;
  readonly resolveClient: ReturnType<typeof vi.fn>;
  readonly enfileiradas: {
    payload: TarefaNfeShopee;
    opts: OpcoesDeEnfileiramentoNfe | undefined;
  }[];
  /** Every Shopee call, in CALL order. */
  readonly chamadas: string[];
  valvulaFechada: boolean;
}

function cenario(
  o: {
    leituras?: Leitura[];
    upload?: Error | null;
    nfe?: DocData | null;
    pedido?: DocData | null;
    conta?: DocData | null;
    irmaos?: Record<string, DocData>;
  } = {},
): Cenario {
  const db = new FakeDb();
  if (o.conta !== null) db.seed(INTEGRACAO_PATH, o.conta ?? contaRaw());
  if (o.pedido !== null) db.seed(PEDIDO_PATH, o.pedido ?? pedidoRaw());
  if (o.nfe !== null) db.seed(NFE_PATH, o.nfe ?? nfeRaw());
  for (const [id, raw] of Object.entries(o.irmaos ?? {})) {
    db.seed(nfev4Collection.docPath({ pedidoId: PEDIDO_ID }, id), raw);
  }

  const fila: Leitura[] = [...(o.leituras ?? [semNota(), nossa('pending')])];
  const chamadas: string[] = [];
  const getOrderDetail = vi.fn(async () => {
    chamadas.push('getOrderDetail');
    const proxima = fila.shift();
    if (proxima === undefined) throw new Error('leitura de pedido NÃO esperada pelo teste');
    if (proxima instanceof Error) throw proxima;
    return { order_list: proxima === 'vazio' ? [] : [proxima] };
  });
  const uploadInvoiceDoc = vi.fn(async () => {
    chamadas.push('uploadInvoiceDoc');
    if (o.upload) throw o.upload;
    return { error: '', message: '', request_id: 'req-teste' };
  });
  const client = { getOrderDetail, uploadInvoiceDoc } as unknown as ShopeeClient;
  const resolveClient = vi.fn(async () => client);

  const enfileiradas: Cenario['enfileiradas'] = [];
  const c: Cenario = {
    db,
    getOrderDetail,
    uploadInvoiceDoc,
    resolveClient,
    enfileiradas,
    chamadas,
    valvulaFechada: false,
    deps: undefined as unknown as DepsNfeShopee,
  };
  const scheduler = {
    enqueue: vi.fn(async (payload: TarefaNfeShopee, opts?: OpcoesDeEnfileiramentoNfe) => {
      if (c.valvulaFechada) throw new ShopeeNfeUploadTasksDisabledError();
      enfileiradas.push({ payload, opts });
    }),
  };
  (c as { deps: DepsNfeShopee }).deps = {
    db: asDb(db),
    scheduler,
    nowMs: NOW_MS,
    increment,
    jitterSec: () => 0,
    resolveClient,
  };
  return c;
}

const TAREFA: TarefaNfeShopee = {
  pedidoId: PEDIDO_ID,
  nfeId: NFE_ID,
  fase: FASE_NFE_SHOPEE.envio,
  adiamentosSerpro: 0,
  pausas: 0,
  reverificacoes: 0,
};

function processar(c: Cenario, tarefa: Partial<TarefaNfeShopee> = {}, retryCount = 0) {
  return processarNfeShopee(c.deps, { ...TAREFA, ...tarefa }, retryCount);
}

function aviso(c: Cenario): DocData | undefined {
  return c.db.store[AVISO_PATH]?.data;
}

function estadoDoFrete(c: Cenario): unknown {
  return (c.db.store[PEDIDO_PATH]?.data.freteInicial as DocData | undefined)?.estado;
}

let logs: MockInstance[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  logs = [
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything this test logged, on every level, as ONE string. */
function tudoQueFoiLogado(): string {
  return JSON.stringify(logs.map((s) => s.mock.calls));
}

/** The completion lines (the handler's own tag, carrying a `desfecho`). */
function linhasDeConclusao(): Record<string, unknown>[] {
  return logs
    .flatMap((s) => s.mock.calls)
    .map((args) => args[1] as Record<string, unknown> | undefined)
    .filter((m): m is Record<string, unknown> => m !== undefined && 'desfecho' in m);
}

/* -------------------------------------------------------------------------- */
/*                                the round trip                               */
/* -------------------------------------------------------------------------- */

describe('ida e volta — pré-leitura, UM upload, releitura, reverificação', () => {
  it('sem-nota ⇒ exatamente UM upload ⇒ releitura ⇒ reverificação com 900 s ⇒ ZERO escritas', async () => {
    const c = cenario({ leituras: [semNota(), nossa('pending')] });

    const r = await processar(c);

    expect(r).toMatchObject({
      desfecho: 'enviado',
      motivo: MOTIVO_NFE_SHOPEE.validacaoPendente,
      fase: 'envio',
      substituicao: false,
      carimbo: null,
      avisado: false,
      resolvido: false,
    });
    expect(c.uploadInvoiceDoc).toHaveBeenCalledTimes(1);
    expect(c.uploadInvoiceDoc).toHaveBeenCalledWith({ orderSn: ORDER_SN, xml: procXml() });
    expect(c.getOrderDetail).toHaveBeenCalledTimes(2);
    expect(c.enfileiradas).toEqual([
      {
        payload: { ...TAREFA, fase: FASE_NFE_SHOPEE.reverificacao },
        opts: { scheduleDelaySeconds: ATRASOS_REVERIFICACAO_S[0] },
      },
    ]);
    expect(ATRASOS_REVERIFICACAO_S[0]).toBe(900);
    expect(c.db.writes).toEqual([]);
  });

  it('⛔ 59 — a pré-leitura vem ANTES do upload (ordem das chamadas)', async () => {
    const c = cenario();
    await processar(c);
    expect(c.chamadas).toEqual(['getOrderDetail', 'uploadInvoiceDoc', 'getOrderDetail']);
    expect(c.getOrderDetail).toHaveBeenNthCalledWith(1, {
      orderSnList: [ORDER_SN],
      responseOptionalFields: SHOPEE_NFE_DETALHE_CAMPOS,
    });
  });

  it('releitura `nossa`+`valid` depois do 200 ⇒ `enviado` + resolve, e a reverificação AINDA é agendada', async () => {
    const c = cenario({ leituras: [semNota(), nossa('valid')] });
    const r = await processar(c);
    expect(r).toMatchObject({ desfecho: 'enviado', motivo: MOTIVO_NFE_SHOPEE.nfeValidada });
    expect(c.enfileiradas).toHaveLength(1);
    expect(c.db.writes).toEqual([]);
  });

  it('releitura `sem-nota` depois do 200 ⇒ `nao-refletida-ainda` (log), sem aviso nem carimbo', async () => {
    const c = cenario({ leituras: [semNota(), semNota()] });
    const r = await processar(c);
    expect(r).toMatchObject({
      desfecho: 'enviado',
      motivo: MOTIVO_NFE_SHOPEE.naoRefletidaAinda,
      avisado: false,
      carimbo: null,
    });
    expect(c.enfileiradas).toHaveLength(1);
  });

  it('releitura `nossa`+`pending`+motivo depois do 200 ⇒ `sefaz-pendente` avisa E carimba, e reverifica', async () => {
    const c = cenario({ leituras: [semNota(), nossa('pending', 'Rejeição 539: Duplicidade')] });
    const r = await processar(c);
    expect(r).toMatchObject({
      desfecho: 'enviado',
      motivo: MOTIVO_NFE_SHOPEE.sefazPendente,
      avisado: true,
      carimbo: 'carimbado',
    });
    expect(estadoDoFrete(c)).toBe(ESTADO_FRETE.error);
    expect(c.enfileiradas).toHaveLength(1);
  });

  it('⛔ 61 — a releitura que FALHA depois do 200 é engolida: `enviado` e a reverificação agendada', async () => {
    const c = cenario({ leituras: [semNota(), new ShopeeNetworkError('rede caiu')] });
    const r = await processar(c, {}, 0);
    expect(r).toMatchObject({ desfecho: 'enviado', motivo: null });
    expect(c.enfileiradas).toHaveLength(1);
    expect(c.db.writes).toEqual([]);
  });

  it('⛔ 61 — PAR: um limite de taxa na releitura também é engolido (o upload pousou)', async () => {
    const c = cenario({ leituras: [semNota(), limite('burst', 5)] });
    const r = await processar(c);
    expect(r.desfecho).toBe('enviado');
    expect(c.enfileiradas.map((e) => e.payload.fase)).toEqual([FASE_NFE_SHOPEE.reverificacao]);
  });

  it('QUASE: uma falha que NÃO é da Shopee na releitura propaga (é bug nosso)', async () => {
    const c = cenario({ leituras: [semNota(), new RangeError('bug')] });
    await expect(processar(c)).rejects.toBeInstanceOf(RangeError);
  });

  it('⛔ 62 — válvula fechada na reverificação depois do 200 ⇒ `warn`, e o desfecho CONTINUA `enviado`', async () => {
    const c = cenario();
    c.valvulaFechada = true;
    const r = await processar(c);
    expect(r.desfecho).toBe('enviado');
    expect(c.uploadInvoiceDoc).toHaveBeenCalledTimes(1);
    expect(tudoQueFoiLogado()).toContain('reverificacao-nao-agendada');
  });
});

/* -------------------------------------------------------------------------- */
/*                         re-drives and the pre-read                          */
/* -------------------------------------------------------------------------- */

describe('pré-leitura — Shopee já tem a NOSSA chave', () => {
  it('re-drive de um pedido já enviado (`nossa`+`valid`) ⇒ nenhum upload, nenhuma escrita, nada enfileirado', async () => {
    const c = cenario({ leituras: [nossa('valid')] });
    const r = await processar(c);
    expect(r).toMatchObject({
      desfecho: 'ja-enviado',
      motivo: MOTIVO_NFE_SHOPEE.nfeValidada,
      resolvido: false,
    });
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
    expect(c.enfileiradas).toEqual([]);
    expect(c.db.writes).toEqual([]);
  });

  it('`nossa`+`valid` com um aviso ABERTO ⇒ resolve `nfe-validada`', async () => {
    const c = cenario({ leituras: [nossa('valid')] });
    await avisarNfeShopee(
      asDb(c.db),
      {
        integracaoId: CONTA,
        pedidoId: PEDIDO_ID,
        numero: ORDER_SN,
        motivo: MOTIVO_NFE_SHOPEE.canalIndisponivel,
        excerto: null,
      },
      { increment, nowMs: NOW_MS - 60_000 },
    );
    const r = await processar(c);
    expect(r.resolvido).toBe(true);
    expect(aviso(c)).toMatchObject({ resolucaoMotivo: MOTIVO_NFE_SHOPEE.nfeValidada });
  });

  it('`nossa`+`pending` sem motivo ⇒ `ja-enviado` + UMA reverificação', async () => {
    const c = cenario({ leituras: [nossa('pending', '   ')] });
    const r = await processar(c);
    expect(r).toMatchObject({
      desfecho: 'ja-enviado',
      motivo: MOTIVO_NFE_SHOPEE.validacaoPendente,
    });
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
    expect(c.enfileiradas).toEqual([
      {
        payload: { ...TAREFA, fase: FASE_NFE_SHOPEE.reverificacao },
        opts: { scheduleDelaySeconds: 900 },
      },
    ]);
  });

  it('`nossa` com status desconhecido (`invalid`) ⇒ `status-desconhecido`, NUNCA resolve, uma reverificação', async () => {
    const c = cenario({ leituras: [nossa('invalid')] });
    const r = await processar(c);
    expect(r).toMatchObject({
      desfecho: 'ja-enviado',
      motivo: MOTIVO_NFE_SHOPEE.statusDesconhecido,
      resolvido: false,
    });
    expect(c.enfileiradas).toHaveLength(1);
  });

  it('`nossa`+`pending`+motivo ⇒ `sefaz-pendente` com o EXCERTO sanitizado + carimbo, sem upload', async () => {
    const c = cenario({ leituras: [nossa('pending', `Rejeição 539 [chNFe:${K}]`)] });
    const r = await processar(c);
    expect(r).toMatchObject({
      desfecho: 'recusado',
      motivo: MOTIVO_NFE_SHOPEE.sefazPendente,
      avisado: true,
      carimbo: 'carimbado',
    });
    const erro = String((aviso(c)?.params as DocData).erro);
    expect(erro).toContain('539');
    expect(erro).not.toContain(K);
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
  });
});

describe('pré-leitura — OUTRA chave: nunca sobrescreve, salvo a substituição', () => {
  it('⛔ 58 — PAR: a chave de um irmão CANCELADO ⇒ upload com `substituicao: true`', async () => {
    const c = cenario({
      leituras: [outra(K_OUTRA), nossa('pending')],
      irmaos: {
        s4: nfeRaw({
          estado: ESTADO_NFE.cancelada,
          chave: K_OUTRA,
          xml_nfe_proc: procXml({ chave: K_OUTRA }),
        }),
      },
    });
    const r = await processar(c);
    expect(r).toMatchObject({ desfecho: 'enviado', substituicao: true });
    expect(c.uploadInvoiceDoc).toHaveBeenCalledTimes(1);
  });

  it('⛔ 58 — QUASE: a mesma chave num irmão NÃO cancelado ⇒ `outra-nfe-anexada`, sem upload e SEM carimbo', async () => {
    const c = cenario({
      leituras: [outra(K_OUTRA)],
      irmaos: { s4: nfeRaw({ chave: K_OUTRA, xml_nfe_proc: procXml({ chave: K_OUTRA }) }) },
    });
    const r = await processar(c);
    expect(r).toMatchObject({
      desfecho: 'recusado',
      motivo: MOTIVO_NFE_SHOPEE.outraNfeAnexada,
      avisado: true,
      carimbo: null,
      substituicao: false,
    });
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
    expect(estadoDoFrete(c)).toBe(ESTADO_FRETE.aguardandoNFe);
  });

  it('QUASE: um irmão cancelado com OUTRA chave (nem a nossa nem a da Shopee) não autoriza a troca', async () => {
    const c = cenario({
      leituras: [outra(K_OUTRA)],
      irmaos: {
        s4: nfeRaw({
          estado: ESTADO_NFE.cancelada,
          chave: montarChave('000000003'),
          xml_nfe_proc: procXml({ chave: montarChave('000000003') }),
        }),
      },
    });
    expect((await processar(c)).motivo).toBe(MOTIVO_NFE_SHOPEE.outraNfeAnexada);
  });

  it('PAR: um irmão cancelado SEM proc guardado é reconhecido pela `chave` armazenada', async () => {
    const c = cenario({
      leituras: [outra(K_OUTRA), nossa('pending')],
      irmaos: { s4: { estado: ESTADO_NFE.cancelada, chave: K_OUTRA } },
    });
    expect(await processar(c)).toMatchObject({ desfecho: 'enviado', substituicao: true });
  });

  it('uma chave ilegível na Shopee ⇒ `chave-ilegivel` (aviso, sem carimbo, sem upload)', async () => {
    const c = cenario({ leituras: [linha({ invoice: { access_key: '-' } })] });
    const r = await processar(c);
    expect(r).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.chaveIlegivel,
      avisado: true,
      carimbo: null,
    });
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                           the prefix, P1 … P8                               */
/* -------------------------------------------------------------------------- */

describe('o prefixo comum — cada parada sem chamada à Shopee', () => {
  it('P1 — NF-e ausente ⇒ `nfe-nao-encontrada`, nada lido do pedido', async () => {
    const c = cenario({ nfe: null });
    expect(await processar(c)).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.nfeNaoEncontrada,
    });
    expect(c.db.caminhos).not.toContain(PEDIDO_PATH);
    expect(c.resolveClient).not.toHaveBeenCalled();
  });

  it('P2 — uma NF-e cancelada desde o enfileiramento (predicado de NÍVEL) ⇒ `nao-aprovada`', async () => {
    const c = cenario({ nfe: nfeRaw({ estado: ESTADO_NFE.cancelada }) });
    expect((await processar(c)).motivo).toBe(MOTIVO_NFE_SHOPEE.naoAprovada);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
  });

  it('P3 — um pedido sem prova de posse ⇒ `nao-shopee`', async () => {
    const c = cenario({ pedido: pedidoRaw({ numero: 'OUTRO-NUMERO' }) });
    expect((await processar(c)).motivo).toBe(MOTIVO_NFE_SHOPEE.naoShopee);
    expect(c.resolveClient).not.toHaveBeenCalled();
  });

  it('P3 — `bloquearEmissaoNFe` ⇒ `emissao-bloqueada`, linha em `warn`', async () => {
    const c = cenario({ pedido: pedidoRaw({ bloquearEmissaoNFe: true }) });
    expect((await processar(c)).motivo).toBe(MOTIVO_NFE_SHOPEE.emissaoBloqueada);
    expect(logs[1]).toHaveBeenCalled();
  });

  it('P4 — uma devolução (`finNFe 4`) ⇒ `nfe-nao-e-de-venda`, log apenas', async () => {
    const c = cenario({ nfe: nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }) }) });
    expect(await processar(c)).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda,
      avisado: false,
    });
    expect(c.db.writes).toEqual([]);
  });

  it('⛔ 60 — XML sem chave julgado DEPOIS do pedido: o aviso `xml-invalido` carrega o número, e carimba — ZERO chamadas', async () => {
    const semChave = procXml().replace(`Id="NFe${K}"`, 'Id="NFe"');
    const c = cenario({ nfe: nfeRaw({ xml_nfe_proc: semChave, chave: null }) });
    const r = await processar(c);
    expect(r).toMatchObject({
      desfecho: 'recusado',
      motivo: MOTIVO_NFE_SHOPEE.xmlInvalido,
      avisado: true,
      carimbo: 'carimbado',
    });
    expect((aviso(c)?.params as DocData).pedido).toBe(ORDER_SN);
    expect(estadoDoFrete(c)).toBe(ESTADO_FRETE.error);
    expect(c.resolveClient).not.toHaveBeenCalled();
    expect(c.chamadas).toEqual([]);
  });

  it('P5 — PAR: um XML de EXATAMENTE o teto em bytes sobe', async () => {
    const base = procXml();
    const xml = `${base}<!--${'a'.repeat(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES - base.length - 7)}-->`;
    expect(new TextEncoder().encode(xml).byteLength).toBe(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES);
    const c = cenario({ nfe: nfeRaw({ xml_nfe_proc: xml }) });
    expect((await processar(c)).desfecho).toBe('enviado');
    expect(c.uploadInvoiceDoc).toHaveBeenCalledWith({ orderSn: ORDER_SN, xml });
  });

  it('P5 — QUASE: o mesmo tamanho em CARACTERES com um acento passa do teto em BYTES ⇒ `xml-grande-demais`', async () => {
    const base = procXml();
    const xml = `${base}<!--é${'a'.repeat(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES - base.length - 8)}-->`;
    expect(xml.length).toBe(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES);
    const c = cenario({ nfe: nfeRaw({ xml_nfe_proc: xml }) });
    expect(await processar(c)).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.xmlGrandeDemais,
      avisado: true,
      carimbo: 'carimbado',
    });
    expect(c.chamadas).toEqual([]);
  });

  it('⛔ 47/48 — PAR: `ativo: null` ⇒ `conta-inativa` e o cliente NUNCA é construído', async () => {
    const c = cenario({ conta: contaRaw({ ativo: null }) });
    expect(await processar(c)).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.contaInativa,
    });
    expect(c.resolveClient).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });

  it('QUASE: uma conta ausente ⇒ `conta-nao-configurada`, também sem cliente', async () => {
    const c = cenario({ conta: null });
    expect((await processar(c)).motivo).toBe(MOTIVO_NFE_SHOPEE.contaNaoConfigurada);
    expect(c.resolveClient).not.toHaveBeenCalled();
  });

  it('P7 — as falhas tipadas da conta são log apenas: sem shop_id e configuração do app', async () => {
    const c1 = cenario();
    c1.resolveClient.mockRejectedValueOnce(new ShopeeContaSemShopIdError('conta principal'));
    expect((await processar(c1)).motivo).toBe(MOTIVO_NFE_SHOPEE.semShopId);

    const c2 = cenario();
    c2.resolveClient.mockRejectedValueOnce(new ShopeeConfigError('SHOPEE_PARTNER_ID ausente'));
    expect((await processar(c2)).motivo).toBe(MOTIVO_NFE_SHOPEE.configuracaoDoApp);
    expect(c2.db.writes).toEqual([]);
  });

  it('P7 — QUASE: uma falha desconhecida ao construir o cliente PROPAGA', async () => {
    const c = cenario();
    c.resolveClient.mockRejectedValueOnce(new TypeError('bug'));
    await expect(processar(c)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('P8 — a leitura do pedido na Shopee (R-f(3)) e o portão do pedido', () => {
  it('PAR: `order.order_not_found` com TAB ⇒ `pedido-inexistente-no-canal`, linha `error`, sem aviso', async () => {
    const c = cenario({ leituras: [recusa(null, 'order.order_not_found\t')] });
    expect(await processar(c)).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.pedidoInexistenteNoCanal,
      avisado: false,
    });
    expect(logs[2]).toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });

  it('PAR: uma resposta SEM a nossa linha ⇒ `pedido-inexistente-no-canal`', async () => {
    const c = cenario({ leituras: ['vazio'] });
    expect((await processar(c)).motivo).toBe(MOTIVO_NFE_SHOPEE.pedidoInexistenteNoCanal);
  });

  it('QUASE: `order_not_found_x` não é o código ⇒ propaga, mesmo na última tentativa', async () => {
    const c = cenario({ leituras: [recusa(null, 'order_not_found_x')] });
    await expect(processar(c, {}, ULTIMA_TENTATIVA)).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('`source_ip_undeclared` ⇒ aviso `ip-nao-declarado`, SEM carimbo', async () => {
    const c = cenario({ leituras: [recusa(null, 'common.source_ip_undeclared')] });
    expect(await processar(c)).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.ipNaoDeclarado,
      avisado: true,
      carimbo: null,
    });
  });

  it('autorização vencida na pré-leitura ⇒ aviso `reauth`, sem carimbo', async () => {
    const reauth = new ShopeeReauthRequiredError('vencida', {
      code: 'shop_access_expired',
      kind: SHOPEE_ERROR_KIND.reauth,
      httpStatus: 403,
      path: '/api/v2/order/get_order_detail',
    });
    const c = cenario({ leituras: [reauth] });
    expect(await processar(c)).toMatchObject({
      desfecho: 'recusado',
      motivo: MOTIVO_NFE_SHOPEE.reauth,
      avisado: true,
      carimbo: null,
    });
    expect(estadoDoFrete(c)).toBe(ESTADO_FRETE.aguardandoNFe);
  });

  it('pedido CANCELLED ⇒ `pedido-cancelado` e resolve o aviso aberto, sem upload', async () => {
    const c = cenario({ leituras: [linha({ status: 'CANCELLED' })] });
    await avisarNfeShopee(
      asDb(c.db),
      {
        integracaoId: CONTA,
        pedidoId: PEDIDO_ID,
        numero: ORDER_SN,
        motivo: MOTIVO_NFE_SHOPEE.reauth,
        excerto: null,
      },
      { increment, nowMs: NOW_MS - 60_000 },
    );
    expect(await processar(c)).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.pedidoCancelado,
      resolvido: true,
    });
    expect(aviso(c)).toMatchObject({ resolucaoMotivo: MOTIVO_NFE_SHOPEE.pedidoCancelado });
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
  });

  it('pedido de exportação ⇒ aviso `pedido-exportacao`, sem carimbo; FBS ⇒ log apenas', async () => {
    const c1 = cenario({ leituras: [linha({ internacional: true })] });
    expect(await processar(c1)).toMatchObject({
      desfecho: 'recusado',
      motivo: MOTIVO_NFE_SHOPEE.pedidoExportacao,
      avisado: true,
      carimbo: null,
    });
    const c2 = cenario({ leituras: [linha({ fulfillment: 'fulfilled_by_shopee' })] });
    expect(await processar(c2)).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.pedidoFbs,
      avisado: false,
    });
    expect(c2.db.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         the upload's refusals (R-f)                         */
/* -------------------------------------------------------------------------- */

describe('recusas do upload — a tabela de R-f', () => {
  it('uma recusa determinística (CNPJ) ⇒ aviso + carimbo, o código vai para o log', async () => {
    const c = cenario({
      leituras: [semNota()],
      upload: recusa('Wrong parameters, detail: Invalid CNPJ..', 'order.error_param'),
    });
    expect(await processar(c)).toMatchObject({
      desfecho: 'recusado',
      motivo: MOTIVO_NFE_SHOPEE.cnpjDivergente,
      avisado: true,
      carimbo: 'carimbado',
    });
    expect(linhasDeConclusao()[0]).toMatchObject({ codigo: 'order.error_param' });
  });

  it('`recusa-desconhecida` ⇒ o excerto SANITIZADO vai ao aviso e ao log, nunca o texto cru', async () => {
    const c = cenario({
      leituras: [semNota()],
      upload: recusa(`Something odd for order ${ORDER_SN} key ${K}`, 'error_desconhecido'),
    });
    expect((await processar(c)).motivo).toBe(MOTIVO_NFE_SHOPEE.recusaDesconhecida);
    const erro = String((aviso(c)?.params as DocData).erro);
    expect(erro).toContain('Something odd');
    expect(erro).not.toContain(K);
    expect(erro).not.toContain(ORDER_SN);
    const [linhaFinal] = linhasDeConclusao();
    expect(linhaFinal?.excerto).toEqual(expect.stringContaining('Something odd'));
  });

  it('`ip-nao-declarado` no upload ⇒ aviso SEM carimbo', async () => {
    const c = cenario({ leituras: [semNota()], upload: recusa(null, 'source_ip_undeclared') });
    expect(await processar(c)).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.ipNaoDeclarado,
      avisado: true,
      carimbo: null,
    });
  });

  it('N1 (chave em outro pedido) + releitura `nossa` ⇒ `ja-enviado`', async () => {
    const c = cenario({
      leituras: [semNota(), nossa('valid')],
      upload: recusa('Wrong parameters, detail: access key duplicated.'),
    });
    expect(await processar(c)).toMatchObject({
      desfecho: 'ja-enviado',
      motivo: MOTIVO_NFE_SHOPEE.nfeValidada,
      carimbo: null,
    });
  });

  it('N1 + releitura `outra` ⇒ `outra-nfe-anexada` (aviso, SEM carimbo)', async () => {
    const c = cenario({
      leituras: [semNota(), outra(K_OUTRA)],
      upload: recusa('access key duplicated'),
    });
    expect(await processar(c)).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.outraNfeAnexada,
      avisado: true,
      carimbo: null,
    });
  });

  it('N1 + releitura `sem-nota` ⇒ `chave-em-outro-pedido` (aviso + carimbo — recusa provada)', async () => {
    const c = cenario({
      leituras: [semNota(), semNota()],
      upload: recusa('access key duplicated'),
    });
    expect(await processar(c)).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.chaveEmOutroPedido,
      avisado: true,
      carimbo: 'carimbado',
    });
  });

  it('N2 (reenvio ao mesmo pedido) + releitura `sem-nota` ⇒ transitório: RELANÇA antes da última tentativa', async () => {
    const c = cenario({ leituras: [semNota(), semNota()], upload: recusa('already sent') });
    await expect(processar(c, {}, 0)).rejects.toBeInstanceOf(ShopeeApiError);
    expect(c.db.writes).toEqual([]);
  });

  it('N2 + `sem-nota` na ÚLTIMA tentativa ⇒ `canal-indisponivel` (aviso, sem carimbo) + UMA reverificação', async () => {
    const c = cenario({ leituras: [semNota(), semNota()], upload: recusa('already sent') });
    expect(await processar(c, {}, ULTIMA_TENTATIVA)).toMatchObject({
      desfecho: 'erro-final',
      motivo: MOTIVO_NFE_SHOPEE.canalIndisponivel,
      avisado: true,
      carimbo: null,
    });
    expect(c.enfileiradas.map((e) => e.payload.fase)).toEqual([FASE_NFE_SHOPEE.reverificacao]);
  });

  it.each([
    [
      'ShopeeSchemaError',
      () =>
        new ShopeeSchemaError('2xx ilegível', {
          campos: ['error'],
          httpStatus: 200,
          path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
        }),
    ],
    [
      'ShopeeHttpError',
      () =>
        new ShopeeHttpError('HTML da borda', {
          httpStatus: 502,
          path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
        }),
    ],
    ['ShopeeNetworkError', () => new ShopeeNetworkError('reset')],
  ] as const)(
    'desfecho incerto (%s) + releitura `nossa` ⇒ caminho `enviado` com reverificação',
    async (_n, erro) => {
      const c = cenario({ leituras: [semNota(), nossa('pending')], upload: erro() });
      expect((await processar(c)).desfecho).toBe('enviado');
      expect(c.enfileiradas).toHaveLength(1);
    },
  );

  it.each([
    [
      'ShopeeSchemaError',
      () =>
        new ShopeeSchemaError('2xx ilegível', {
          campos: ['error'],
          httpStatus: 200,
          path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
        }),
    ],
    [
      'ShopeeHttpError',
      () =>
        new ShopeeHttpError('HTML da borda', {
          httpStatus: 502,
          path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
        }),
    ],
  ] as const)(
    '⛔ 30 — desfecho incerto (%s) + releitura `sem-nota` ⇒ RELANÇA, NUNCA carimba',
    async (_n, erro) => {
      const c = cenario({ leituras: [semNota(), semNota()], upload: erro() });
      await expect(processar(c, {}, 0)).rejects.toBeTruthy();
      expect(estadoDoFrete(c)).toBe(ESTADO_FRETE.aguardandoNFe);
      expect(c.db.writes).toEqual([]);
    },
  );

  it('`ShopeeConfigError` do upload é bug nosso ⇒ propaga, mesmo na última tentativa', async () => {
    const c = cenario({ leituras: [semNota()], upload: new ShopeeConfigError('xml vazio') });
    await expect(processar(c, {}, ULTIMA_TENTATIVA)).rejects.toBeInstanceOf(ShopeeConfigError);
  });
});

describe('case 5 (SERPRO) — re-enfileirar sem gastar tentativa', () => {
  const invalida = () => recusa('Wrong parameters, detail: Invalid NF-e..');

  it('⛔ 64 — `adiamentosSerpro: 0` ⇒ re-enfileira com 600 s e o contador +1, `adiado`, SEM lançar', async () => {
    const c = cenario({ leituras: [semNota()], upload: invalida() });
    expect(await processar(c, {}, 0)).toMatchObject({
      desfecho: 'adiado',
      motivo: MOTIVO_NFE_SHOPEE.aguardandoSerpro,
      avisado: false,
      carimbo: null,
    });
    expect(c.enfileiradas).toEqual([
      { payload: { ...TAREFA, adiamentosSerpro: 1 }, opts: { scheduleDelaySeconds: 600 } },
    ]);
  });

  it('⛔ 65 — PAR: o TERCEIRO adiamento (`adiamentosSerpro: 2`) ainda re-enfileira, com 3600 s', async () => {
    const c = cenario({ leituras: [semNota()], upload: invalida() });
    expect((await processar(c, { adiamentosSerpro: 2 })).desfecho).toBe('adiado');
    expect(c.enfileiradas[0]?.opts).toEqual({ scheduleDelaySeconds: ATRASOS_SERPRO_REENVIO_S[2] });
    expect(c.enfileiradas[0]?.payload.adiamentosSerpro).toBe(3);
  });

  it('⛔ 65 — QUASE: o QUARTO (`adiamentosSerpro: 3`) ⇒ `nfe-invalida` com aviso + carimbo, nada enfileirado', async () => {
    const c = cenario({ leituras: [semNota()], upload: invalida() });
    expect(await processar(c, { adiamentosSerpro: 3 })).toMatchObject({
      desfecho: 'recusado',
      motivo: MOTIVO_NFE_SHOPEE.nfeInvalida,
      avisado: true,
      carimbo: 'carimbado',
    });
    expect(c.enfileiradas).toEqual([]);
  });

  it('válvula fechada no re-enfileiramento ⇒ aviso `tasks-desabilitadas`, desfecho `descartado`', async () => {
    const c = cenario({ leituras: [semNota()], upload: invalida() });
    c.valvulaFechada = true;
    expect(await processar(c)).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.tasksDesabilitadas,
      avisado: true,
      carimbo: null,
    });
  });
});

describe('limites de taxa — pausas que não gastam tentativa', () => {
  it('⛔ 32 — rajada no upload ⇒ `pausado` (NUNCA classificada como recusa), atraso = Retry-After + jitter, pausas +1', async () => {
    const c = cenario({ leituras: [semNota()], upload: limite('burst', 30) });
    c.deps.jitterSec = (max) => {
      expect(max).toBe(30);
      return 7;
    };
    expect(await processar(c)).toMatchObject({
      desfecho: 'pausado',
      motivo: MOTIVO_NFE_SHOPEE.limiteDeTaxa,
      avisado: false,
    });
    expect(c.enfileiradas).toEqual([
      { payload: { ...TAREFA, pausas: 1 }, opts: { scheduleDelaySeconds: 37 } },
    ]);
  });

  it('⛔ 66 — cota diária ⇒ re-enfileira na virada (00:00 UTC+8) e CONTA a pausa', async () => {
    const c = cenario({ leituras: [limite('daily')] });
    expect((await processar(c, { pausas: 2 })).motivo).toBe(MOTIVO_NFE_SHOPEE.cotaDiaria);
    const [unica] = c.enfileiradas;
    expect(unica?.payload.pausas).toBe(3);
    const viradaMs = NOW_MS + (unica?.opts?.scheduleDelaySeconds ?? 0) * 1000;
    expect((viradaMs + 8 * 3_600_000) % 86_400_000).toBeLessThan(1000);
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
  });

  it('PAR: a pausa numa REVERIFICAÇÃO re-enfileira uma reverificação (a fase é mantida)', async () => {
    const c = cenario({ leituras: [limite('burst', 10)] });
    await processar(c, { fase: FASE_NFE_SHOPEE.reverificacao });
    expect(c.enfileiradas[0]?.payload.fase).toBe(FASE_NFE_SHOPEE.reverificacao);
  });

  it('QUASE: com `pausas` no teto ⇒ `pausa-reenqueues-esgotados` (aviso, sem carimbo), nada enfileirado', async () => {
    const c = cenario({ leituras: [limite('burst', 30)] });
    expect(await processar(c, { pausas: NFE_SHOPEE_MAX_PAUSAS })).toMatchObject({
      desfecho: 'erro-final',
      motivo: MOTIVO_NFE_SHOPEE.pausaReenqueuesEsgotados,
      avisado: true,
      carimbo: null,
    });
    expect(c.enfileiradas).toEqual([]);
  });

  it('válvula fechada numa pausa ⇒ aviso `tasks-desabilitadas`', async () => {
    const c = cenario({ leituras: [limite('burst', 30)] });
    c.valvulaFechada = true;
    expect((await processar(c)).motivo).toBe(MOTIVO_NFE_SHOPEE.tasksDesabilitadas);
    expect(aviso(c)).toMatchObject({ motivo: MOTIVO_NFE_SHOPEE.tasksDesabilitadas });
  });
});

describe('⛔ 67 — a última tentativa: só o transitório da Shopee finaliza', () => {
  const servidor = () => recusa(null, 'error_server', SHOPEE_ERROR_KIND.transient);

  it('PAR: transitório no upload antes da última tentativa ⇒ RELANÇA, sem escrita', async () => {
    const c = cenario({ leituras: [semNota()], upload: servidor() });
    await expect(processar(c, {}, ULTIMA_TENTATIVA - 1)).rejects.toBeInstanceOf(ShopeeApiError);
    expect(c.db.writes).toEqual([]);
    expect(c.enfileiradas).toEqual([]);
  });

  it('PAR: o mesmo transitório na ÚLTIMA ⇒ `canal-indisponivel` + UMA reverificação', async () => {
    const c = cenario({ leituras: [semNota()], upload: servidor() });
    expect(await processar(c, {}, ULTIMA_TENTATIVA)).toMatchObject({
      desfecho: 'erro-final',
      motivo: MOTIVO_NFE_SHOPEE.canalIndisponivel,
      avisado: true,
      carimbo: null,
    });
    expect(c.enfileiradas).toHaveLength(1);
  });

  it('transitório na pré-leitura de uma REVERIFICAÇÃO na última ⇒ `reverificacao-indisponivel`, log apenas', async () => {
    const c = cenario({ leituras: [new ShopeeNetworkError('rede')] });
    expect(
      await processar(c, { fase: FASE_NFE_SHOPEE.reverificacao }, ULTIMA_TENTATIVA),
    ).toMatchObject({
      desfecho: 'erro-final',
      motivo: MOTIVO_NFE_SHOPEE.reverificacaoIndisponivel,
      avisado: false,
    });
    expect(c.enfileiradas).toEqual([]);
    expect(c.db.writes).toEqual([]);
  });

  it('QUASE: uma falha de LEITURA do Firestore na última tentativa RELANÇA (nunca finaliza)', async () => {
    const c = cenario();
    // Every document read of this execution fails as the SDK does (gRPC 14).
    const colecaoReal = c.db.collection.bind(c.db);
    c.db.collection = ((path: string) => {
      const real = colecaoReal(path);
      const docReal = real.doc;
      return {
        ...real,
        doc: (id?: string) => ({
          ...docReal(id),
          get: () => Promise.reject(grpc(14, 'UNAVAILABLE')),
        }),
      };
    }) as unknown as FakeDb['collection'];
    await expect(processar(c, {}, ULTIMA_TENTATIVA)).rejects.toMatchObject({ code: 14 });
    expect(c.chamadas).toEqual([]);
    expect(c.enfileiradas).toEqual([]);
  });

  it('QUASE: a escrita do AVISO que falha ao finalizar RELANÇA — nada de reverificação por cima', async () => {
    const c = cenario({
      leituras: [semNota()],
      upload: recusa(null, 'error_server', SHOPEE_ERROR_KIND.transient),
    });
    c.db.falhasDeCriacao.set(AVISO_PATH, grpc(14, 'UNAVAILABLE'));
    await expect(processar(c, {}, ULTIMA_TENTATIVA)).rejects.toMatchObject({ code: 14 });
    expect(c.enfileiradas).toEqual([]);
  });

  it('QUASE: uma recusa determinística cuja escrita do aviso falha RELANÇA, e o carimbo NÃO é escrito', async () => {
    const c = cenario({ leituras: [semNota()], upload: recusa('Invalid CNPJ') });
    c.db.falhasDeCriacao.set(AVISO_PATH, grpc(14, 'UNAVAILABLE'));
    await expect(processar(c, {}, ULTIMA_TENTATIVA)).rejects.toMatchObject({ code: 14 });
    expect(estadoDoFrete(c)).toBe(ESTADO_FRETE.aguardandoNFe);
  });
});

/* -------------------------------------------------------------------------- */
/*                          the recheck phase                                  */
/* -------------------------------------------------------------------------- */

describe('fase `reverificacao` — delegada, com a ÚNICA leitura do prefixo', () => {
  it('`nossa`+`valid` ⇒ `validada`, uma leitura, NENHUM upload', async () => {
    const c = cenario({ leituras: [nossa('valid')] });
    expect(await processar(c, { fase: FASE_NFE_SHOPEE.reverificacao })).toMatchObject({
      desfecho: 'validada',
      fase: FASE_NFE_SHOPEE.reverificacao,
    });
    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
  });

  it('`nossa`+`pending`+motivo numa reverificação ⇒ o excerto sanitizado vai para a linha de log', async () => {
    const c = cenario({ leituras: [nossa('pending', `Rejeição 204 [chNFe:${K}]`)] });
    expect((await processar(c, { fase: FASE_NFE_SHOPEE.reverificacao })).motivo).toBe(
      MOTIVO_NFE_SHOPEE.sefazPendente,
    );
    const [linhaFinal] = linhasDeConclusao();
    expect(String(linhaFinal?.excerto)).toContain('204');
    expect(tudoQueFoiLogado()).not.toContain(K);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the payload                                 */
/* -------------------------------------------------------------------------- */

describe('o payload', () => {
  it('um payload inválido ⇒ `payload-invalido`, NUNCA lança, nada lido, linha `error` com os CAMPOS', async () => {
    const c = cenario();
    const r = await processarNfeShopee(c.deps, { pedidoId: PEDIDO_ID, fase: 'x', segredo: K }, 0);
    expect(r).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.payloadInvalido,
      fase: null,
    });
    expect(c.db.caminhos).toEqual([]);
    expect(logs[2]).toHaveBeenCalledTimes(1);
    expect(tudoQueFoiLogado()).not.toContain(K);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the log                                    */
/* -------------------------------------------------------------------------- */

describe('a linha de conclusão — PII', () => {
  it('UMA linha por execução com os campos do contrato; nunca a chave, o order_sn, o XML ou o nome do arquivo', async () => {
    const casos: [Leitura[], Error | null][] = [
      [[semNota(), nossa('pending', `motivo com ${K} e ${ORDER_SN}`)], null],
      [[semNota()], recusa(`texto cru ${K} ${ORDER_SN}`, 'error_estranho')],
      [[outra(K_OUTRA)], null],
    ];
    for (const [leituras, upload] of casos) {
      const c = cenario({ leituras, upload });
      await processar(c);
    }
    const linhas = linhasDeConclusao();
    expect(linhas).toHaveLength(3);
    for (const l of linhas) {
      expect(Object.keys(l)).toEqual(
        expect.arrayContaining([
          'queue',
          'pedidoId',
          'nfeId',
          'fase',
          'desfecho',
          'motivo',
          'retryCount',
          'adiamentosSerpro',
          'pausas',
          'reverificacoes',
          'substituicao',
          'carimbo',
        ]),
      );
    }
    const tudo = tudoQueFoiLogado();
    for (const proibido of [K, K_OUTRA, ORDER_SN, '<nfeProc', 'procNFe.xml']) {
      expect(tudo).not.toContain(proibido);
    }
    // The excerpt of `recusa-desconhecida` IS Shopee's text — sanitized: the
    // words survive, the identifiers inside are masked.
    expect(tudo).toContain('texto cru •••');
  });

  it('PAR: o excerto aparece SÓ para `MOTIVOS_COM_EXCERTO` — QUASE: uma recusa conhecida não leva excerto', async () => {
    const c = cenario({ leituras: [semNota()], upload: recusa('Invalid CNPJ extra texto') });
    await processar(c);
    expect(linhasDeConclusao()[0]).not.toHaveProperty('excerto');
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the dry run                                 */
/* -------------------------------------------------------------------------- */

describe('simularEnvioNfeShopee — não escreve, não sobe, não enfileira', () => {
  it('`sem-nota` ⇒ `enviaria`, com os bytes e a espera SERPRO restante; zero escritas', async () => {
    const c = cenario({ leituras: [semNota()] });
    const s = await simularEnvioNfeShopee(c.deps, TAREFA);
    expect(s).toMatchObject({
      desfecho: 'enviado',
      enviaria: true,
      substituicao: false,
      notaNaShopee: 'sem-nota',
      bytesDoXml: procXml().length,
      atrasoSerproS: 0,
    });
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
    expect(c.enfileiradas).toEqual([]);
    expect(c.db.writes).toEqual([]);
  });

  it('`xml-invalido` ⇒ diz que AVISARIA e CARIMBARIA, sem escrever nada', async () => {
    const c = cenario({
      nfe: nfeRaw({ xml_nfe_proc: procXml().replace(`Id="NFe${K}"`, 'Id=""'), chave: null }),
    });
    expect(await simularEnvioNfeShopee(c.deps, TAREFA)).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.xmlInvalido,
      avisaria: true,
      carimbaria: true,
      enviaria: false,
    });
    expect(c.db.writes).toEqual([]);
  });

  it('`nossa`+`valid` ⇒ `ja-enviado` e RESOLVERIA; nunca a chave no resultado', async () => {
    const c = cenario({ leituras: [nossa('valid')] });
    const s = await simularEnvioNfeShopee(c.deps, TAREFA);
    expect(s).toMatchObject({ desfecho: 'ja-enviado', resolveria: true, statusDaNota: 'valida' });
    expect(JSON.stringify(s)).not.toContain(K);
    expect(c.db.writes).toEqual([]);
  });

  it('a fonte: o lado de LEITURA e a simulação não nomeiam nenhum escritor', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./processarNfe.ts', import.meta.url)),
      'utf8',
    );
    const inicio = fonte.indexOf('the READ side');
    const fim = fonte.indexOf('the WRITE side');
    expect(inicio).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(inicio);
    const lado = fonte.slice(inicio, fim);
    for (const escritor of [
      'avisarNfeShopee',
      'carimbarFreteNfeShopee',
      'resolverAvisoNfeShopee',
      'uploadInvoiceDoc',
      'enqueue(',
      'reverificarNfeShopee',
    ]) {
      expect(lado).not.toContain(escritor);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                             lerPedidoNaShopee                               */
/* -------------------------------------------------------------------------- */

describe('lerPedidoNaShopee — o mapa dos erros do GET', () => {
  function clienteQue(erro: Error): ShopeeClient {
    return { getOrderDetail: () => Promise.reject(erro) } as unknown as ShopeeClient;
  }

  it('PAR: `error_not_found` e `order.order_not_found` ⇒ `inexistente`; QUASE: `not_found` sozinho PROPAGA', async () => {
    await expect(
      lerPedidoNaShopee(clienteQue(recusa(null, 'error_not_found')), ORDER_SN),
    ).resolves.toMatchObject({
      tipo: 'inexistente',
    });
    await expect(
      lerPedidoNaShopee(clienteQue(recusa(null, 'order.order_not_found')), ORDER_SN),
    ).resolves.toMatchObject({ tipo: 'inexistente' });
    await expect(
      lerPedidoNaShopee(clienteQue(recusa(null, 'not_found')), ORDER_SN),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('o limite de taxa e a autorização vencida são mapeados ANTES da classe-base', async () => {
    await expect(lerPedidoNaShopee(clienteQue(limite('daily')), ORDER_SN)).resolves.toMatchObject({
      tipo: 'limite',
    });
  });

  it('a linha é reconciliada por `order_sn`, nunca por posição', async () => {
    const outraLinha = shopeeOrderDetailRowSchema.parse({
      order_sn: 'OUTRO',
      order_status: 'READY_TO_SHIP',
    });
    const cliente = {
      getOrderDetail: () => Promise.resolve({ order_list: [outraLinha, semNota()] }),
    } as unknown as ShopeeClient;
    const r = await lerPedidoNaShopee(cliente, ORDER_SN);
    expect(r.tipo === 'linha' && r.linha.order_sn).toBe(ORDER_SN);
  });
});
