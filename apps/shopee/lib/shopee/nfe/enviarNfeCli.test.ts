/**
 * The `enviar:nfe` CLI's testable half (#1522, step 14): the argv parser, both
 * runs over the REAL handler entry points (`simularEnvioNfeShopee` /
 * `processarNfeShopee`) on the shared fake Firestore with a fake SHOP client,
 * the renderers and the error describer.
 *
 * ⛔ titles name the reconcile §4 / D3 §10 mutant each test kills (33–39). A
 * predicate test names a PAIR (must come out equal) and a NEAR-MISS (must stay
 * distinct).
 *
 * ⚠️ Fixture keys are SYNTHETIC and visibly fake — cUF `99` (no such UF) and a
 * CNPJ of repeated digits — assembled field by field; the ids are the repo's
 * fixture ids. Nothing here reaches a network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
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
  SHOPEE_UPLOAD_INVOICE_DOC_FILENAME,
  SHOPEE_UPLOAD_INVOICE_DOC_PATH,
  ShopeeApiError,
  ShopeeNetworkError,
  shopeeOrderDetailRowSchema,
  type ShopeeClient,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { makePedidoIdShopee } from '../pedidos/orderIds';
import { FakeDb, asDb, increment, type DocData } from '../testing/fakeDb';
import { ATRASO_SERPRO_S, ATRASOS_REVERIFICACAO_S } from './constantesNfe';
import {
  ArgumentoInvalidoError,
  MSG_EXCEDE_LIMITE,
  MSG_NFE_EXIGE_UM_PEDIDO,
  MSG_PEDIDO_OBRIGATORIO,
  PAUSA_ENTRE_PEDIDOS_MS,
  SHOPEE_ENVIO_NFE_MAX_PEDIDOS,
  criarAgendadorGravador,
  descreverErroEnviarNfe,
  ehRecusaAntesDoEnvioNfe,
  ensaiarEnvioNfe,
  enviarNfeAoVivo,
  lerArgumentosEnviarNfe,
  renderizarJsonEnviarNfe,
  renderizarRelatorioEnviarNfe,
  resumoDoEnvioNfe,
  type ArgsEnviarNfe,
  type LinhaEnviarNfe,
  type RelatorioEnviarNfe,
} from './enviarNfeCli';
import {
  DESFECHO_NFE_SHOPEE,
  MOTIVO_NFE_SHOPEE,
  mensagemDoMotivoNfe,
  type MotivoNfeShopee,
} from './errosNfe';
import { processarNfeShopee, simularEnvioNfeShopee } from './processarNfe';
import { createShopeeNfeUploadScheduler } from './shopeeNfeUploadTasks';
import { FASE_NFE_SHOPEE } from './tarefaNfe';

// The REAL transport, replaced by a spy that fails loudly: nothing in the CLI's
// live run may ever build it (mutant 39).
vi.mock('./shopeeNfeUploadTasks', () => ({
  createShopeeNfeUploadScheduler: vi.fn(() => {
    throw new Error('o agendador REAL da fila não pode ser construído pela CLI');
  }),
}));

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
/** A pedido with no document at all — the slot rule finds nothing, zero Shopee calls. */
const PEDIDO_SEM_NFE = 'pedido-sem-nfe';
const PEDIDO_PATH = pedidoCollection.docPath({}, PEDIDO_ID);
const INTEGRACAO_PATH = integracaoCollection.docPath({}, CONTA);
const NOW_MS = 1_789_000_000_000;

/** A synthetic key: cUF 99 + AAMM + CNPJ + mod 55 + série + nNF + tpEmis + cNF + DV. */
function montarChave(nNF = '000000001'): string {
  return `99${'2609'}${'1'.repeat(14)}55${'000'}${nNF}1${'00000000'}0`;
}

const K = montarChave();
/** Another legible key of the SAME emitter — a different nNF. */
const K_OUTRA = montarChave('000000002');

/** A minimal synthetic `nfeProc` — no signature, no real party anywhere. */
function procXml(chave = K): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
    `<NFe><infNFe versao="4.00" Id="NFe${chave}"><ide><cUF>99</cUF><mod>55</mod>`,
    '<tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>1</finNFe>',
    '</ide><emit><xNome>TESTE SINTETICO SEM VALOR FISCAL</xNome></emit>',
    '</infNFe></NFe>',
    `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${chave}</chNFe>`,
    '<cStat>100</cStat></infProt></protNFe></nfeProc>',
  ].join('');
}

const XML_INVALIDO = procXml().replace(`Id="NFe${K}"`, 'Id=""');

function nfeRaw(o: DocData = {}): DocData {
  return {
    estado: ESTADO_NFE.aprovada,
    chave: K,
    xml_nfe_proc: procXml(),
    data_autorizacao: NOW_MS - 3_600_000,
    ...o,
  };
}

function pedidoRaw(): DocData {
  return {
    numero: ORDER_SN,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    bloquearEmissaoNFe: false,
    ultimaModificacao: NOW_MS * 1000 - 5_000_000,
    freteInicial: freteDoPedidoSchema.parse({
      ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
      externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
      estado: ESTADO_FRETE.aguardandoNFe,
      pacotes: [],
    }) as DocData,
  };
}

/** The order row as Shopee answers it with the folder's detail fields. */
function linha(invoice: Record<string, unknown>): ShopeeOrderDetailRow {
  return shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    region: 'BR',
    order_status: 'READY_TO_SHIP',
    fulfillment_flag: 'fulfilled_by_local_seller',
    is_international: false,
    invoice_data: invoice,
  });
}

const semNota = (): ShopeeOrderDetailRow => linha({ access_key: '' });
const nossa = (status: string, pendingReason: string | null = null): ShopeeOrderDetailRow =>
  linha({ access_key: K, status, pending_reason: pendingReason });
const outra = (): ShopeeOrderDetailRow => linha({ access_key: K_OUTRA, status: 'valid' });

type Leitura = ShopeeOrderDetailRow | Error;

interface Cenario {
  readonly db: FakeDb;
  readonly getOrderDetail: ReturnType<typeof vi.fn>;
  readonly uploadInvoiceDoc: ReturnType<typeof vi.fn>;
  readonly resolveClient: Mock<() => Promise<ShopeeClient>>;
  readonly esperar: Mock<(ms: number) => Promise<void>>;
  readonly concluidas: LinhaEnviarNfe[];
}

function cenario(o: { leituras?: Leitura[]; nfes?: Record<string, DocData> } = {}): Cenario {
  const db = new FakeDb();
  db.seed(INTEGRACAO_PATH, {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja Sandbox',
    shop_id: SHOP,
  });
  db.seed(PEDIDO_PATH, pedidoRaw());
  for (const [id, raw] of Object.entries(o.nfes ?? { s1: nfeRaw() })) {
    db.seed(nfev4Collection.docPath({ pedidoId: PEDIDO_ID }, id), raw);
  }

  const fila: Leitura[] = [...(o.leituras ?? [semNota(), nossa('pending')])];
  const getOrderDetail = vi.fn(async () => {
    const proxima = fila.shift();
    if (proxima === undefined) throw new Error('leitura de pedido NÃO esperada pelo teste');
    if (proxima instanceof Error) throw proxima;
    return { order_list: [proxima] };
  });
  const uploadInvoiceDoc = vi.fn(async () => ({ error: '', message: '', request_id: 'req-teste' }));
  const client = { getOrderDetail, uploadInvoiceDoc } as unknown as ShopeeClient;
  return {
    db,
    getOrderDetail,
    uploadInvoiceDoc,
    resolveClient: vi.fn(async () => client),
    esperar: vi.fn(async (_ms: number) => undefined),
    concluidas: [],
  };
}

function comuns(c: Cenario) {
  return {
    db: asDb(c.db),
    agora: () => NOW_MS,
    esperar: c.esperar,
    resolveClient: c.resolveClient,
    aoConcluir: (l: LinhaEnviarNfe) => {
      c.concluidas.push(l);
    },
  };
}

function ensaiar(
  c: Cenario,
  pedidoIds: readonly string[] = [PEDIDO_ID],
  nfeId: string | null = null,
) {
  return ensaiarEnvioNfe({ pedidoIds, nfeId }, { ...comuns(c), simular: simularEnvioNfeShopee });
}

function aoVivo(
  c: Cenario,
  pedidoIds: readonly string[] = [PEDIDO_ID],
  nfeId: string | null = null,
) {
  return enviarNfeAoVivo(
    { pedidoIds, nfeId },
    { ...comuns(c), processar: processarNfeShopee, increment },
  );
}

let logs: MockInstance[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  vi.mocked(createShopeeNfeUploadScheduler).mockClear();
  logs = [
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every printable surface of a report, as ONE string — the table, the JSON and the logs. */
function tudoQueSeria(r: RelatorioEnviarNfe): string {
  return [
    ...renderizarRelatorioEnviarNfe(r),
    renderizarJsonEnviarNfe(r),
    JSON.stringify(logs.map((s) => s.mock.calls)),
  ].join('\n');
}

/** The identifiers and payloads nothing may print. */
function semIdentificadores(texto: string): void {
  for (const proibido of [K, K_OUTRA, ORDER_SN, procXml(), SHOPEE_UPLOAD_INVOICE_DOC_FILENAME]) {
    expect(texto).not.toContain(proibido);
  }
  expect(texto).not.toMatch(/\d{44}/);
  expect(texto).not.toContain('1'.repeat(14));
}

/* -------------------------------------------------------------------------- */
/*                                  the parser                                 */
/* -------------------------------------------------------------------------- */

function args(argv: string[]): ArgsEnviarNfe {
  const comando = lerArgumentosEnviarNfe(argv);
  if (comando.kind !== 'enviar') throw new Error('esperava um comando de envio');
  return comando.args;
}

function recusa(argv: string[]): string {
  try {
    lerArgumentosEnviarNfe(argv);
  } catch (err) {
    if (err instanceof ArgumentoInvalidoError) return err.message;
    throw err;
  }
  throw new Error(`esperava uma recusa para ${argv.join(' ')}`);
}

describe('lerArgumentosEnviarNfe', () => {
  it('⛔ 33 — o PADRÃO é o dry-run: sem --live nada é enviado', () => {
    expect(args(['--pedido', 'p1'])).toEqual({
      pedidoIds: ['p1'],
      nfeId: null,
      live: false,
      json: false,
      projectId: null,
    });
    expect(args(['--pedido', 'p1', '--dry-run']).live).toBe(false);
    expect(args(['--pedido', 'p1', '--live']).live).toBe(true);
  });

  it('⛔ 34 — --live com --dry-run é RECUSADO, nas duas ordens', () => {
    expect(recusa(['--pedido', 'p1', '--live', '--dry-run'])).toMatch(/contraditórios/);
    expect(recusa(['--dry-run', '--pedido', 'p1', '--live'])).toMatch(/contraditórios/);
  });

  it('--help responde antes de qualquer validação', () => {
    expect(lerArgumentosEnviarNfe(['--help'])).toEqual({ kind: 'ajuda' });
    expect(lerArgumentosEnviarNfe(['--live', '--dry-run', '-h'])).toEqual({ kind: 'ajuda' });
  });

  it('PAR: `p1`, ` p1 ` e `--pedido=p1` são UM pedido; NEAR-MISS: `P1` continua outro pedido', () => {
    expect(args(['--pedido', 'p1', '--pedido', ' p1 ', '--pedido=p1']).pedidoIds).toEqual(['p1']);
    expect(args(['--pedido', 'p1', '--pedido', 'P1']).pedidoIds).toEqual(['p1', 'P1']);
  });

  it(`⛔ 38 — PAR: ${String(SHOPEE_ENVIO_NFE_MAX_PEDIDOS)} distintos (em 51 flags) passam; NEAR-MISS: 51 distintos são RECUSADOS, nunca truncados`, () => {
    const cinquenta = Array.from(
      { length: SHOPEE_ENVIO_NFE_MAX_PEDIDOS },
      (_, i) => `p${String(i)}`,
    );
    const comRepetido = [...cinquenta, 'p0'].flatMap((id) => ['--pedido', id]);
    expect(args(comRepetido).pedidoIds).toHaveLength(SHOPEE_ENVIO_NFE_MAX_PEDIDOS);

    const cinquentaEUm = [...cinquenta, 'p50'].flatMap((id) => ['--pedido', id]);
    expect(recusa(cinquentaEUm)).toBe(MSG_EXCEDE_LIMITE);
  });

  it('--nfe só com UM pedido: PAR um pedido (mesmo repetido) passa; NEAR-MISS dois pedidos são recusados', () => {
    expect(args(['--pedido', 'p1', '--nfe', 's1']).nfeId).toBe('s1');
    expect(args(['--pedido', 'p1', '--pedido', 'p1', '--nfe=s1']).nfeId).toBe('s1');
    expect(recusa(['--pedido', 'p1', '--pedido', 'p2', '--nfe', 's1'])).toBe(
      MSG_NFE_EXIGE_UM_PEDIDO,
    );
    expect(recusa(['--pedido', 'p1', '--nfe', 's1', '--nfe', 's2'])).toMatch(/uma vez/);
  });

  it('recusa o que não é um comando válido', () => {
    expect(recusa([])).toBe(MSG_PEDIDO_OBRIGATORIO);
    expect(recusa(['--live'])).toBe(MSG_PEDIDO_OBRIGATORIO);
    expect(recusa(['--', '--pedido', 'p1'])).toMatch(/Separador/);
    expect(recusa(['--pedido', 'p1', '--live=0'])).toMatch(/não aceita valor/);
    expect(recusa(['--pedido', 'p1', '--json=false'])).toMatch(/não aceita valor/);
    expect(recusa(['--pedido', 'p1', '--order-sn', 'x'])).toMatch(/desconhecida/);
    expect(recusa(['--pedido', 'a/b'])).toMatch(/não é um id de documento/);
    expect(recusa(['--pedido', '..'])).toMatch(/não é um id de documento/);
    expect(recusa(['--pedido'])).toMatch(/exige um valor/);
    expect(recusa(['--pedido', '--live'])).toMatch(/exige um valor/);
    expect(recusa(['--pedido', 'p1', '--nfe', 'a/b'])).toMatch(/não é um id de documento/);
  });

  it('--project e --json', () => {
    expect(args(['--pedido', 'p1', '--project', 'demo-erp', '--json'])).toMatchObject({
      projectId: 'demo-erp',
      json: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the dry run                                 */
/* -------------------------------------------------------------------------- */

describe('ensaiarEnvioNfe — lê e decide, NUNCA escreve, sobe ou enfileira', () => {
  it('⛔ 35 — `sem-nota` ⇒ enviaria; zero escritas, nenhum upload, UMA leitura na Shopee', async () => {
    const c = cenario({ leituras: [semNota()] });
    const r = await ensaiar(c);

    expect(r.live).toBe(false);
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0]).toMatchObject({
      pedidoId: PEDIDO_ID,
      nfeId: 's1',
      desfecho: 'enviado',
      motivo: null,
      enviaria: true,
      chave: 'ausente',
      bytesDoXml: new TextEncoder().encode(procXml()).byteLength,
      atrasoSerproS: 0,
      naoEnfileirado: [],
    });
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(c.db.writes).toEqual([]);
  });

  it('⛔ 35 — `xml-invalido` diz que AVISARIA e marcaria o frete, e não escreve nada', async () => {
    const c = cenario({
      leituras: [],
      nfes: { s1: nfeRaw({ xml_nfe_proc: XML_INVALIDO, chave: null }) },
    });
    const r = await ensaiar(c);

    expect(r.linhas[0]).toMatchObject({
      desfecho: 'recusado',
      motivo: MOTIVO_NFE_SHOPEE.xmlInvalido,
      mensagem: mensagemDoMotivoNfe(MOTIVO_NFE_SHOPEE.xmlInvalido),
      efeitos: { aviso: true, carimbo: true, resolucao: false, reverificacao: false },
    });
    expect(c.getOrderDetail).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });

  it('sem `--nfe`, a REGRA de escolha decide (a aprovada mais recente); com `--nfe`, a flag manda', async () => {
    const nfes = {
      s1: nfeRaw({ data_autorizacao: NOW_MS - 7_200_000 }),
      s2: nfeRaw({ data_autorizacao: NOW_MS - 3_600_000 }),
    };
    const implicita = await ensaiar(cenario({ leituras: [semNota()], nfes }));
    expect(implicita.linhas[0]?.nfeId).toBe('s2');

    const explicita = await ensaiar(cenario({ leituras: [semNota()], nfes }), [PEDIDO_ID], 's1');
    expect(explicita.linhas[0]?.nfeId).toBe('s1');
    expect(explicita.nfeExplicita).toBe('s1');
  });

  it('um pedido sem NF-e aprovada ⇒ `sem-nfe-aprovada`, sem simular e sem chamar a Shopee', async () => {
    const c = cenario({ leituras: [] });
    const simular = vi.fn(simularEnvioNfeShopee);
    const r = await ensaiarEnvioNfe(
      { pedidoIds: [PEDIDO_SEM_NFE], nfeId: null },
      { ...comuns(c), simular },
    );
    expect(r.linhas[0]).toMatchObject({
      pedidoId: PEDIDO_SEM_NFE,
      nfeId: null,
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.semNfeAprovada,
    });
    expect(simular).not.toHaveBeenCalled();
    expect(c.getOrderDetail).not.toHaveBeenCalled();
  });

  it('um pedido por vez, com a pausa ENTRE eles (nunca antes do primeiro), na ordem pedida', async () => {
    const c = cenario({ leituras: [semNota()] });
    const r = await ensaiar(c, [PEDIDO_SEM_NFE, PEDIDO_ID]);
    expect(r.linhas.map((l) => l.pedidoId)).toEqual([PEDIDO_SEM_NFE, PEDIDO_ID]);
    expect(c.esperar).toHaveBeenCalledTimes(1);
    expect(c.esperar).toHaveBeenCalledWith(PAUSA_ENTRE_PEDIDOS_MS);
    expect(c.concluidas.map((l) => l.pedidoId)).toEqual([PEDIDO_SEM_NFE, PEDIDO_ID]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the live run                               */
/* -------------------------------------------------------------------------- */

describe('enviarNfeAoVivo — o handler NESTE processo, com um agendador que só GRAVA', () => {
  it('⛔ 39 — a reverificação que a fila agendaria é GRAVADA e impressa, nunca enfileirada', async () => {
    const c = cenario({ leituras: [semNota(), nossa('pending')] });
    const r = await aoVivo(c);

    expect(r.live).toBe(true);
    expect(c.uploadInvoiceDoc).toHaveBeenCalledTimes(1);
    expect(r.linhas[0]).toMatchObject({
      desfecho: 'enviado',
      motivo: MOTIVO_NFE_SHOPEE.validacaoPendente,
      naoEnfileirado: [
        { fase: FASE_NFE_SHOPEE.reverificacao, atrasoS: ATRASOS_REVERIFICACAO_S[0] },
      ],
      efeitos: { reverificacao: true },
    });
    expect(createShopeeNfeUploadScheduler).not.toHaveBeenCalled();
    expect(renderizarRelatorioEnviarNfe(r).join('\n')).toMatch(
      new RegExp(`NÃO enfileirado \\.+ reverificacao em ${String(ATRASOS_REVERIFICACAO_S[0])} s`),
    );
  });

  it('o gravador captura fase e atraso por NOME, e "sem atraso" fica `null`', async () => {
    const { agendador, gravados } = criarAgendadorGravador();
    await agendador.enqueue({
      pedidoId: PEDIDO_ID,
      nfeId: 's1',
      fase: FASE_NFE_SHOPEE.envio,
      adiamentosSerpro: 0,
      pausas: 0,
      reverificacoes: 0,
    });
    await agendador.enqueue(
      {
        pedidoId: PEDIDO_ID,
        nfeId: 's1',
        fase: FASE_NFE_SHOPEE.reverificacao,
        adiamentosSerpro: 0,
        pausas: 0,
        reverificacoes: 0,
      },
      { scheduleDelaySeconds: 900 },
    );
    expect(gravados).toEqual([
      { fase: FASE_NFE_SHOPEE.envio, atrasoS: null },
      { fase: FASE_NFE_SHOPEE.reverificacao, atrasoS: 900 },
    ]);
  });

  it(`SERPRO — PAR: aprovada há 60 s ⇒ RECUSADA (aguardando-serpro, ${String(ATRASO_SERPRO_S - 60)} s) sem chamar a Shopee; NEAR-MISS: há ${String(ATRASO_SERPRO_S)} s ⇒ segue e sobe`, async () => {
    const fresca = cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - 60_000 }) } });
    const r = await aoVivo(fresca);
    expect(r.linhas[0]).toMatchObject({
      desfecho: 'adiado',
      motivo: MOTIVO_NFE_SHOPEE.aguardandoSerpro,
      atrasoSerproS: ATRASO_SERPRO_S - 60,
    });
    expect(fresca.resolveClient).not.toHaveBeenCalled();
    expect(fresca.getOrderDetail).not.toHaveBeenCalled();
    expect(fresca.db.writes).toEqual([]);

    const vencida = cenario({
      nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - ATRASO_SERPRO_S * 1000 }) },
    });
    const r2 = await aoVivo(vencida);
    expect(r2.linhas[0]).toMatchObject({ desfecho: 'enviado', atrasoSerproS: 0 });
    expect(vencida.uploadInvoiceDoc).toHaveBeenCalledTimes(1);
  });

  it('SERPRO — instante DESCONHECIDO (`data_autorizacao: null`) ⇒ o --live segue e sobe, e o dry-run não anuncia recusa (uma recusa valeria em TODA execução); NEAR-MISS: conhecido e fresco ⇒ recusado', async () => {
    const semInstante = cenario({ nfes: { s1: nfeRaw({ data_autorizacao: null }) } });
    const r = await aoVivo(semInstante);
    expect(r.linhas[0]).toMatchObject({ desfecho: 'enviado', atrasoSerproS: null });
    expect(semInstante.uploadInvoiceDoc).toHaveBeenCalledTimes(1);

    const ensaio = await ensaiar(
      cenario({ leituras: [semNota()], nfes: { s1: nfeRaw({ data_autorizacao: null }) } }),
    );
    expect(ensaio.linhas[0]).toMatchObject({ enviaria: true, atrasoSerproS: null });
    expect(renderizarRelatorioEnviarNfe(ensaio).join('\n')).not.toContain('recusaria');

    const fresca = cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - 1_000 }) } });
    expect((await aoVivo(fresca)).linhas[0]).toMatchObject({
      desfecho: 'adiado',
      motivo: MOTIVO_NFE_SHOPEE.aguardandoSerpro,
    });
    expect(fresca.uploadInvoiceDoc).not.toHaveBeenCalled();
  });

  it('um slot que NÃO está pronto recebe a resposta do handler, nunca a espera SERPRO', async () => {
    const c = cenario({
      leituras: [],
      nfes: { s1: nfeRaw({ estado: ESTADO_NFE.rejeitada, data_autorizacao: null }) },
    });
    const r = await aoVivo(c, [PEDIDO_ID], 's1');
    expect(r.linhas[0]).toMatchObject({
      desfecho: 'descartado',
      motivo: MOTIVO_NFE_SHOPEE.naoAprovada,
    });
    expect(c.getOrderDetail).not.toHaveBeenCalled();
  });

  it('uma falha transitória na tentativa 0 LANÇA (sai com 1); as linhas já concluídas chegaram antes', async () => {
    const c = cenario({ leituras: [new ShopeeNetworkError('rede caiu')] });
    await expect(aoVivo(c, [PEDIDO_SEM_NFE, PEDIDO_ID])).rejects.toBeInstanceOf(ShopeeNetworkError);
    expect(c.concluidas.map((l) => l.pedidoId)).toEqual([PEDIDO_SEM_NFE]);
    expect(c.uploadInvoiceDoc).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         what is printed, and what never is                  */
/* -------------------------------------------------------------------------- */

describe('o que é impresso — nunca a chave, o número do pedido ou o XML', () => {
  it('⛔ 36 — dry-run com OUTRA chave na Shopee ⇒ `chave: difere`, nunca a chave', async () => {
    const c = cenario({ leituras: [outra()] });
    const r = await ensaiar(c);
    expect(r.linhas[0]).toMatchObject({
      chave: 'difere',
      motivo: MOTIVO_NFE_SHOPEE.outraNfeAnexada,
    });
    const texto = tudoQueSeria(r);
    expect(texto).toContain('chave: difere');
    semIdentificadores(texto);
  });

  it('⛔ 36 — `sefaz-pendente` com a chave e o número no motivo da Shopee ⇒ o trecho sai MASCARADO', async () => {
    const c = cenario({
      leituras: [nossa('pending', `NF-e ${K} do pedido ${ORDER_SN} em análise pela SEFAZ`)],
    });
    const r = await ensaiar(c);
    expect(r.linhas[0]).toMatchObject({
      chave: 'confere',
      motivo: MOTIVO_NFE_SHOPEE.sefazPendente,
    });
    expect(r.linhas[0]?.excerto).toContain('•••');
    const texto = tudoQueSeria(r);
    expect(texto).toContain('trecho da Shopee');
    semIdentificadores(texto);
  });

  it('⛔ 36 — --live que avisa e marca o frete (`xml-invalido`) não imprime a chave nem o número', async () => {
    const c = cenario({
      leituras: [],
      nfes: { s1: nfeRaw({ xml_nfe_proc: XML_INVALIDO, chave: null }) },
    });
    const r = await aoVivo(c);
    expect(r.linhas[0]).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.xmlInvalido,
      efeitos: { aviso: true, carimbo: true },
      carimbo: 'carimbado',
    });
    semIdentificadores(tudoQueSeria(r));

    // NEAR-MISS: the re-run meets its own stamp — the stamp ANSWERED, but marked nothing.
    const again = await aoVivo(c);
    expect(again.linhas[0]).toMatchObject({
      motivo: MOTIVO_NFE_SHOPEE.xmlInvalido,
      efeitos: { carimbo: false },
      carimbo: 'ja-carimbado',
    });
  });

  it('o trecho é MASCARADO de novo aqui — PAR: `sefaz-pendente` imprime o trecho limpo; NEAR-MISS: um motivo fora de MOTIVOS_COM_EXCERTO não imprime trecho nenhum', async () => {
    const cru = `NF-e ${K} do pedido ${ORDER_SN} em análise`;
    const simulacao = (motivo: MotivoNfeShopee) =>
      vi.fn(async () => ({
        desfecho: DESFECHO_NFE_SHOPEE.recusado,
        motivo,
        enviaria: false,
        substituicao: false,
        avisaria: true,
        carimbaria: true,
        resolveria: false,
        reverificaria: false,
        notaNaShopee: 'nossa' as const,
        statusDaNota: 'pendente' as const,
        bytesDoXml: 1,
        atrasoSerproS: 0,
        codigo: null,
        // A double that hands the CLI an UNSANITIZED excerpt — the CLI must not trust it.
        excerto: cru,
      }));

    const c = cenario({ leituras: [] });
    const pendente = await ensaiarEnvioNfe(
      { pedidoIds: [PEDIDO_ID], nfeId: null },
      { ...comuns(c), simular: simulacao(MOTIVO_NFE_SHOPEE.sefazPendente) },
    );
    expect(pendente.linhas[0]?.excerto).toContain('•••');
    semIdentificadores(tudoQueSeria(pendente));

    const outroMotivo = await ensaiarEnvioNfe(
      { pedidoIds: [PEDIDO_ID], nfeId: null },
      { ...comuns(c), simular: simulacao(MOTIVO_NFE_SHOPEE.cnpjDivergente) },
    );
    expect(outroMotivo.linhas[0]?.excerto).toBeNull();
    semIdentificadores(tudoQueSeria(outroMotivo));
  });

  it('⛔ 37 — o --json é UM documento, sem nenhuma linha antes dele', async () => {
    const r = await ensaiar(cenario({ leituras: [semNota()] }));
    const texto = renderizarJsonEnviarNfe(r);
    expect(texto.split('\n')[0]).toBe('{');
    expect(JSON.parse(texto)).toEqual(resumoDoEnvioNfe(r));
    expect(JSON.parse(texto)).toMatchObject({
      modo: 'dry-run',
      solicitados: 1,
      totais: { enviado: 1, recusado: 0, 'erro-final': 0 },
    });
  });

  it('a tabela: uma linha por pedido, e o cabeçalho diz o modo', async () => {
    const r = await ensaiar(cenario({ leituras: [semNota()] }), [PEDIDO_SEM_NFE, PEDIDO_ID]);
    const linhas = renderizarRelatorioEnviarNfe(r);
    expect(linhas[0]).toMatch(/DRY-RUN/);
    const inicio = linhas.indexOf('### pedidos (2)');
    expect(linhas[inicio + 1]).toMatch(/^ {2}pedido +nfe +desfecho +motivo +chave +bytes +serpro$/);
    expect(linhas[inicio + 2]).toContain(PEDIDO_SEM_NFE);
    expect(linhas[inicio + 3]).toContain(PEDIDO_ID);
  });
});

describe('descreverErroEnviarNfe — pela CLASSE, nunca pela mensagem da Shopee', () => {
  it('um ShopeeApiError cuja mensagem cita a chave ⇒ classe, código e caminho; a chave, nunca', () => {
    const err = new ShopeeApiError(`Shopee respondeu error_param — NF-e ${K} inválida`, {
      code: 'error_param',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
      providerMessage: `NF-e ${K} inválida`,
    });
    const texto = descreverErroEnviarNfe(err).join('\n');
    expect(texto).toContain('ShopeeApiError');
    expect(texto).toContain('code=error_param');
    expect(texto).toContain(SHOPEE_UPLOAD_INVOICE_DOC_PATH);
    semIdentificadores(texto);
  });

  it('PAR: um código-token é impresso; NEAR-MISS: um "código" com texto livre não é', () => {
    const comCodigo = (code: string) =>
      descreverErroEnviarNfe(
        new ShopeeApiError('x', {
          code,
          kind: SHOPEE_ERROR_KIND.transient,
          httpStatus: 500,
          path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
        }),
      ).join('\n');
    expect(comCodigo('error_server')).toContain('code=error_server');
    expect(comCodigo(`chave ${K}`)).toContain('code=(não é um código)');
    semIdentificadores(comCodigo(`chave ${K}`));
  });

  it('review 2 (S3-6) — PAR: `order.upload_invoice_error` com TAB é impresso aparado; NEAR-MISS: `e` + os 44 dígitos da chave e um código de 70 caracteres não são códigos', () => {
    const comCodigo = (code: string) =>
      descreverErroEnviarNfe(
        new ShopeeApiError('x', {
          code,
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
        }),
      ).join('\n');
    expect(comCodigo('order.upload_invoice_error\t')).toContain('code=order.upload_invoice_error ');
    // Token-SHAPED, and still an identifier: the digit cap is what refuses it.
    expect(comCodigo(`e${K}`)).toContain('code=(não é um código)');
    semIdentificadores(comCodigo(`e${K}`));
    expect(comCodigo(`error_${'x'.repeat(64)}`)).toContain('code=(não é um código)');
  });

  it('só um erro de argumento é anterior a qualquer envio', () => {
    expect(ehRecusaAntesDoEnvioNfe(new ArgumentoInvalidoError('x'))).toBe(true);
    expect(ehRecusaAntesDoEnvioNfe(new ShopeeNetworkError('x'))).toBe(false);
    expect(descreverErroEnviarNfe(new ArgumentoInvalidoError('ruim'))[0]).toBe('❌ ruim');
  });
});

describe('a fonte — o dry-run não alcança o upload, e nada constrói a fila real', () => {
  it('o módulo nomeia `processarNfe` só por TIPOS, e não nomeia o transporte da fila', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./enviarNfeCli.ts', import.meta.url)),
      'utf8',
    );
    // `\r?` — a CRLF checkout must not red an exact-line comparison.
    const importacoes = fonte.split(/\r?\n/).filter((l) => l.includes("from './processarNfe'"));
    expect(importacoes).toEqual([
      "import type { DepsNfeShopee, ResultadoNfeShopee, SimulacaoNfeShopee } from './processarNfe';",
    ]);
    for (const proibido of [
      'shopeeNfeUploadTasks',
      'createShopeeNfeUploadScheduler',
      'getFunctions',
      'uploadInvoiceDoc',
    ]) {
      expect(fonte).not.toContain(proibido);
    }
  });
});
