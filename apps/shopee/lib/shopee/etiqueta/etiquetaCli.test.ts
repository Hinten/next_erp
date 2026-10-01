/**
 * The `baixar:etiqueta` CLI's testable half (#1523, step 15): the argv parser,
 * the pedido → conta ladder, both modes over the REAL runner
 * (`executarEtiquetaShopee`) on the shared fake Firestore with a fake SHOP
 * client, the renderer and the error describer.
 *
 * ⛔ Titles name the reconcile §4 mutant each test kills (S46: the dry run
 * reaches a write) and the round-trip lens it serves (L5: no order number,
 * package number, tracking number, address or byte on a CLI line). A predicate
 * test names a PAIR (must come out equal) and a NEAR-MISS (must stay distinct).
 *
 * ⚠️ Every id is a repo fixture id; nothing here reaches a network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { integracaoCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import {
  SHOPEE_SURFACE,
  ShopeeArquivoVazioError,
  ShopeeSchemaError,
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
  type GetPackageDetailParams,
  type GetShippingParameterParams,
  type ShipOrderParams,
  type ShopeeAlvoDePacote,
  type ShopeeClient,
  type ShopeeLoteLogistico,
} from '@delfrance/integrations-shopee';
import { INTEGRACAO_FRETE, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { ShopeeContaSemShopIdError } from '../core/tokenStore';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import { ESPERA_POS_PROGRAMAR_MS, TIPO_OMITIDO } from './constantesEtiqueta';
import {
  ArgumentoInvalidoError,
  MAX_CHAMADAS_ETIQUETA_CLI,
  MSG_PEDIDO_OBRIGATORIO,
  ORCAMENTO_CLI_ETIQUETA_MS,
  PEDIDO_NAO_ENCONTRADO,
  USO_BAIXAR_ETIQUETA,
  descreverErroEtiqueta,
  ehRecusaAntesDoEnvioEtiqueta,
  parseArgsEtiqueta,
  renderizarRelatorioEtiqueta,
  rodarEtiquetaCli,
  type ArgsBaixarEtiqueta,
  type ArgsDaExecucaoEtiqueta,
  type DepsBaixarEtiquetaCli,
  type RelatorioBaixarEtiqueta,
} from './etiquetaCli';
import {
  executarEtiquetaShopee,
  type DepsExecucaoEtiqueta,
  type EntradaEtiqueta,
  type ResultadoEtiqueta,
} from './executarEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE } from './motivosEtiqueta';
import { MENSAGEM_ESCOLHER_ENVIO } from './pendenteEtiqueta';

/* ---------------------------------- the world -------------------------------- */

const CONTA = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const P1 = 'OFG000000000001';
const P2 = 'OFG000000000002';
const RASTREIO = 'BR000000000000T';
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const PEDIDO_PATH = pedidoCollection.docPath({}, PEDIDO_ID);
const INTEGRACAO_PATH = integracaoCollection.docPath({}, CONTA);

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0x80]);

/** The seller's own address text — it must never reach a CLI line either. */
const RUA = 'Rua do Vendedor';

const DOIS_ENDERECOS = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: {
    address_list: [
      {
        address_id: 2001,
        city: 'Cidade do Vendedor',
        address: `${RUA}, 100`,
        address_flag: ['pickup_address'],
        time_slot_list: [{ date: 1_790_000_000, time_text: '09:00', pickup_time_id: 'slot-1' }],
      },
      {
        address_id: 2002,
        city: 'Cidade do Vendedor',
        address: `${RUA}, 200`,
        address_flag: ['pickup_address'],
        time_slot_list: [{ date: 1_790_000_000, time_text: '14:00', pickup_time_id: 'slot-2' }],
      },
    ],
  },
};

interface PacoteFake {
  numero: string;
  canal: number;
  fulfillment: string;
  arranjado: boolean;
  /** `tracking_number` on the package row, VERBATIM (`-` included). */
  rastreio: string;
  nfePendente: boolean;
  criado: boolean;
}

function novo(numero: string, extra: Partial<PacoteFake> = {}): PacoteFake {
  return {
    numero,
    canal: 91001,
    fulfillment: 'LOGISTICS_READY',
    arranjado: false,
    rastreio: '-',
    nfePendente: false,
    criado: false,
    ...extra,
  };
}

/** Arranged, tracked, its document READY: a reprint. */
function pronto(numero: string, extra: Partial<PacoteFake> = {}): PacoteFake {
  return novo(numero, {
    fulfillment: 'LOGISTICS_REQUEST_CREATED',
    arranjado: true,
    rastreio: RASTREIO,
    criado: true,
    ...extra,
  });
}

function lote<Row>(linhas: Row[]): ShopeeLoteLogistico<Row> {
  return { requestId: null, todasFalharam: false, linhas, linhasIlegiveis: 0, avisos: null };
}

function pedidoRaw(extra: DocData = {}): DocData {
  return {
    numero: ORDER_SN,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.shopee },
    ...extra,
  };
}

function contaRaw(extra: DocData = {}): DocData {
  return {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja Sandbox',
    shop_id: SHOP,
    ...extra,
  };
}

/** The fake Shopee, the fake Firestore, a fake clock and sleep, and a spy on the REAL runner. */
function cenario(
  pacotes: PacoteFake[],
  o: { pedido?: DocData | null; conta?: DocData | null; parametro?: unknown } = {},
) {
  const db = new FakeDb();
  if (o.pedido !== null) db.seed(PEDIDO_PATH, o.pedido ?? pedidoRaw());
  if (o.conta !== null) db.seed(INTEGRACAO_PATH, o.conta ?? contaRaw());
  const relogio = { agora: T0 };
  const achar = (numero: string | undefined): PacoteFake => {
    const p = pacotes.find((x) => x.numero === numero);
    if (p === undefined) throw new Error('pacote desconhecido no mundo');
    return p;
  };

  const getOrderDetail = vi.fn(async () =>
    shopeeOrderDetailPayloadSchema.parse({
      order_list: [
        {
          order_sn: ORDER_SN,
          order_status: 'READY_TO_SHIP',
          fulfillment_flag: 'fulfilled_by_local_seller',
          package_list: pacotes.map((p) => ({ package_number: p.numero })),
        },
      ],
    }),
  );
  const getPackageDetail = vi.fn(async (p: GetPackageDetailParams) =>
    shopeePackageDetailPayloadSchema.parse({
      package_list: p.packageNumbers.map((n) => {
        const x = achar(n);
        return {
          order_sn: ORDER_SN,
          package_number: x.numero,
          fulfillment_status: x.fulfillment,
          logistics_channel_id: x.canal,
          is_shipment_arranged: x.arranjado,
          tracking_number: x.rastreio,
          pending_terms: [],
          invoice_pending: x.nfePendente ? { status: 'pending' } : null,
        };
      }),
    }),
  );
  const getShippingParameter = vi.fn(async (_p: GetShippingParameterParams) =>
    shopeeShippingParameterPayloadSchema.parse(o.parametro ?? DOIS_ENDERECOS),
  );
  const shipOrder = vi.fn(async (p: ShipOrderParams) => {
    const x = achar(p.packageNumber ?? pacotes[0]?.numero);
    x.fulfillment = 'LOGISTICS_REQUEST_CREATED';
    x.arranjado = true;
    return { error: '', message: null, request_id: null, warning: null };
  });
  const getTrackingNumber = vi.fn(async () =>
    shopeeTrackingNumberPayloadSchema.parse({ tracking_number: RASTREIO }),
  );
  const getShippingDocumentParameter = vi.fn(
    async (p: { readonly pacotes: readonly ShopeeAlvoDePacote[] }) =>
      lote(
        p.pacotes.map((a) =>
          shopeeParametroDeDocumentoSchema.parse({
            order_sn: ORDER_SN,
            package_number: a.packageNumber,
            suggest_shipping_document_type: 'NORMAL_AIR_WAYBILL',
            selectable_shipping_document_type: ['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'],
          }),
        ),
      ),
  );
  const createShippingDocument = vi.fn(async (p: CriarDocumentoParams) => {
    for (const d of p.documentos) achar(d.packageNumber).criado = true;
    return lote(
      p.documentos.map((d) =>
        shopeeLinhaDeLoteSchema.parse({ order_sn: ORDER_SN, package_number: d.packageNumber }),
      ),
    );
  });
  const getShippingDocumentResult = vi.fn(async (p: DocumentoParams) =>
    lote(
      p.documentos.map((d) => {
        const x = achar(d.packageNumber);
        return shopeeResultadoDeDocumentoSchema.parse(
          x.criado
            ? { order_sn: ORDER_SN, package_number: x.numero, status: 'READY' }
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
  const downloadShippingDocument = vi.fn(async (_p: BaixarDocumentoParams) => ({
    bytes: PDF,
    contentType: 'application/pdf',
    contentDisposition: null,
    httpStatus: 200,
  }));

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
  const criarCliente = vi.fn(async (_contaId: string) => client);
  const executar = vi.fn((d: DepsExecucaoEtiqueta, e: EntradaEtiqueta) =>
    executarEtiquetaShopee(d, e),
  );

  const rodar = (
    args: Partial<ArgsDaExecucaoEtiqueta> = {},
    executarDe: DepsBaixarEtiquetaCli['executar'] = executar,
  ): Promise<RelatorioBaixarEtiqueta> =>
    rodarEtiquetaCli(
      { db: asDb(db), agora: () => relogio.agora, dormir, criarCliente, executar: executarDe },
      { pedidoId: PEDIDO_ID, formato: 'pdf', pacote: null, envio: null, live: false, ...args },
    );

  return {
    rodar,
    relogio,
    dormir,
    criarCliente,
    executar,
    getOrderDetail,
    getShippingParameter,
    shipOrder,
    createShippingDocument,
    downloadShippingDocument,
  };
}

/** Every id, number and address of the world — none may reach a printed line (L5). */
const PROIBIDOS = [
  ORDER_SN,
  P1,
  P2,
  RASTREIO,
  PEDIDO_ID,
  RUA,
  'Cidade do Vendedor',
  '2001',
  'slot-1',
];

function semIdentificadores(linhas: readonly string[]): void {
  const texto = linhas.join('\n');
  for (const proibido of PROIBIDOS) expect(texto).not.toContain(proibido);
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
  for (const l of logs) l.mockRestore();
  vi.restoreAllMocks();
});

/* ---------------------------------- the parser ------------------------------- */

describe('parseArgsEtiqueta', () => {
  const args = (argv: string[]): ArgsBaixarEtiqueta => {
    const c = parseArgsEtiqueta(argv);
    if (c.kind !== 'etiqueta') throw new Error('esperava um comando de etiqueta');
    return c.args;
  };

  it('o padrão é o DRY-RUN em pdf, sem pacote e sem resposta de envio', () => {
    expect(args(['--pedido', PEDIDO_ID])).toEqual({
      pedidoId: PEDIDO_ID,
      formato: 'pdf',
      pacote: null,
      envio: null,
      live: false,
      projectId: null,
    });
  });

  it('--help em qualquer posição responde a ajuda antes de validar qualquer coisa', () => {
    expect(parseArgsEtiqueta(['--formato', 'xyz', '-h'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsEtiqueta(['--help'])).toEqual({ kind: 'ajuda' });
  });

  it('--pedido é obrigatório, uma vez só, e passa pelo predicado de id de documento', () => {
    expect(() => parseArgsEtiqueta([])).toThrow(MSG_PEDIDO_OBRIGATORIO);
    expect(() => parseArgsEtiqueta(['--pedido', 'a', '--pedido', 'b'])).toThrow(
      ArgumentoInvalidoError,
    );
    expect(() => parseArgsEtiqueta(['--pedido', 'a/b'])).toThrow(/não é um id de documento/);
    expect(() => parseArgsEtiqueta(['--pedido', '..'])).toThrow(/não é um id de documento/);
    expect(() => parseArgsEtiqueta(['--pedido'])).toThrow(/exige um valor/);
    expect(args([`--pedido=${PEDIDO_ID}`]).pedidoId).toBe(PEDIDO_ID);
  });

  it('--formato aceita pdf e zpl2 (PAR), e recusa o vizinho zpl (NEAR-MISS)', () => {
    expect(args(['--pedido', 'p', '--formato', 'zpl2']).formato).toBe('zpl2');
    expect(args(['--pedido', 'p', '--formato=pdf']).formato).toBe('pdf');
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--formato', 'zpl'])).toThrow(
      /use pdf ou zpl2/,
    );
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--formato', 'PDF'])).toThrow(
      /use pdf ou zpl2/,
    );
  });

  it('--pacote: até 64 caracteres passa, 65 é recusado', () => {
    expect(args(['--pedido', 'p', '--pacote', 'x'.repeat(64)]).pacote).toBe('x'.repeat(64));
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--pacote', 'x'.repeat(65)])).toThrow(
      /mais de 64/,
    );
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--pacote', '   '])).toThrow(/exige um valor/);
  });

  it('--endereco [--horario] é a coleta; --dropoff é a agência; os dois juntos são contraditórios', () => {
    expect(args(['--pedido', 'p', '--endereco', '7', '--horario', 'h']).envio).toEqual({
      modo: 'pickup',
      enderecoId: '7',
      horarioId: 'h',
    });
    expect(args(['--pedido', 'p', '--endereco', '7']).envio).toEqual({
      modo: 'pickup',
      enderecoId: '7',
      horarioId: null,
    });
    expect(args(['--pedido', 'p', '--dropoff']).envio).toEqual({ modo: 'dropoff' });
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--horario', 'h'])).toThrow(
      /só vale junto de --endereco/,
    );
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--dropoff', '--endereco', '7'])).toThrow(
      /contraditórias/,
    );
  });

  it('um switch com valor é recusado, nunca lido como presente (--live=0 não organiza nada)', () => {
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--live=0'])).toThrow(/não aceita valor/);
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--dropoff=1'])).toThrow(/não aceita valor/);
  });

  it('--live e --dry-run juntos são recusados; --live sozinho é o único opt-in', () => {
    expect(args(['--pedido', 'p', '--live']).live).toBe(true);
    expect(args(['--pedido', 'p', '--dry-run']).live).toBe(false);
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--live', '--dry-run'])).toThrow(
      /contraditórios/,
    );
  });

  it('não existe --confirmar-janela (Apêndice A): é uma opção desconhecida como outra qualquer', () => {
    expect(() => parseArgsEtiqueta(['--pedido', 'p', '--confirmar-janela'])).toThrow(
      'Opção desconhecida na posição 3',
    );
  });

  /** The parser's refusal, typed — any other throw is not this test's. */
  function erroDe(argv: string[]): ArgumentoInvalidoError {
    try {
      parseArgsEtiqueta(argv);
    } catch (err: unknown) {
      if (err instanceof ArgumentoInvalidoError) return err;
      throw err;
    }
    throw new Error('esperava um ArgumentoInvalidoError');
  }

  it('R3-F3: um argumento SOLTO (um 2º número de pacote) sai pela POSIÇÃO — o valor nunca é impresso; o MESMO número logo após --pacote é aceito', () => {
    const err = erroDe(['--pedido', 'p', '--pacote', P1, P2]);
    expect(err.message).toContain('Argumento solto na posição 5');
    const linhas = descreverErroEtiqueta(err);
    expect(linhas.join('\n')).not.toContain(P2);
    semIdentificadores(linhas);
    // Near-miss: the token in its option's slot is a value, not a stray.
    expect(args(['--pedido', 'p', '--pacote', P2]).pacote).toBe(P2);
  });

  it.each<[string, string[], string]>([
    [
      'uma opção desconhecida com o valor colado',
      ['--pedido', 'p', `--pacotes=${P2}`],
      'posição 3',
    ],
    ['uma opção desconhecida que É o número', ['--pedido', 'p', `-${P2}`], 'posição 3'],
    ['um switch com valor', ['--pedido', 'p', `--dropoff=${P2}`], 'não aceita valor'],
    [
      'um --pedido que não é id de documento',
      ['--pedido', `pedidos/${PEDIDO_ID}`],
      'id de documento',
    ],
    ['um --formato que é outra coisa', ['--pedido', 'p', '--formato', P2], 'use pdf ou zpl2'],
  ])('R3-F3: %s — recusado sem ecoar o texto', (_rotulo, argv, trecho) => {
    const err = erroDe(argv);
    expect(err.message).toContain(trecho);
    semIdentificadores(descreverErroEtiqueta(err));
  });

  it('o separador "--" do pnpm é recusado com a explicação', () => {
    expect(() => parseArgsEtiqueta(['--', '--pedido', 'p'])).toThrow(/Separador "--"/);
  });

  it('--project é lido; o texto de uso não carrega o separador "--"', () => {
    expect(args(['--pedido', 'p', '--project', 'demo-erp']).projectId).toBe('demo-erp');
    expect(USO_BAIXAR_ETIQUETA).not.toMatch(/\s--\s+--/);
    expect(USO_BAIXAR_ETIQUETA).not.toContain('confirmar-janela');
  });
});

/* ---------------------------------- the ladder ------------------------------- */

// The ladder's own pairs and near-misses moved to `alvoEtiqueta.test.ts` with
// the ladder (review 1, R5-3); what stays here is the CLI's use of it.
describe('rodarEtiquetaCli — a escada da rota (alvoEtiqueta.ts)', () => {
  it.each([
    ['pedido ausente', { pedido: null }, PEDIDO_NAO_ENCONTRADO],
    ['conta ausente', { conta: null }, MOTIVO_ETIQUETA_SHOPEE.contaNaoConfigurada],
    ['conta inativa', { conta: contaRaw({ ativo: false }) }, MOTIVO_ETIQUETA_SHOPEE.contaInativa],
    [
      'frete de outra integração',
      { pedido: pedidoRaw({ freteInicial: { externalOptionIntegracao: 'mercadoLivre' } }) },
      MOTIVO_ETIQUETA_SHOPEE.freteDeOutraIntegracao,
    ],
  ])('%s ⇒ recusa ANTES de qualquer cliente: zero chamadas à Shopee', async (_n, o, motivo) => {
    const c = cenario([novo(P1)], o);
    const r = await c.rodar({ live: true });
    expect(r.recusaDoPedido).toBe(motivo);
    expect(r.chamadas).toEqual([]);
    expect(c.criarCliente).not.toHaveBeenCalled();
    expect(c.executar).not.toHaveBeenCalled();
    const linhas = renderizarRelatorioEtiqueta(r);
    expect(linhas.join('\n')).toContain('nenhuma chamada foi feita');
    semIdentificadores(linhas);
  });
});

/* ---------------------------------- the dry run ------------------------------ */

describe('rodarEtiquetaCli — o dry-run (padrão)', () => {
  it('S46: um pacote a organizar ⇒ simulado "programar", ZERO ship/create/download, e o modo lido', async () => {
    const c = cenario([novo(P1)]);
    const r = await c.rodar();

    expect(c.executar).toHaveBeenCalledTimes(1);
    const deps = c.executar.mock.calls[0]?.[0];
    expect(deps?.somenteLeitura).toBe(true);
    expect(deps?.orcamentoMs).toBeUndefined();
    expect(c.shipOrder).not.toHaveBeenCalled();
    expect(c.createShippingDocument).not.toHaveBeenCalled();
    expect(c.downloadShippingDocument).not.toHaveBeenCalled();
    // The one extra read, naming the package.
    expect(c.getShippingParameter).toHaveBeenCalledTimes(1);
    expect(c.getShippingParameter).toHaveBeenCalledWith({ orderSn: ORDER_SN, packageNumber: P1 });

    expect(r.chamadas).toHaveLength(1);
    expect(r.chamadas[0]?.resumo).toMatchObject({
      tipo: 'simulado',
      acao: 'programar',
      pacotesDaAcao: 1,
      comPacote: false,
      fases: ['programar'],
      modo: {
        tipo: 'pergunta',
        enderecos: 2,
        horarios: 2,
        permiteDropoff: false,
        escolhaInvalida: false,
      },
    });
  });

  it('a resposta dada vira o corpo que o live mandaria — ligada ao pacote da AÇÃO', async () => {
    const c = cenario([novo(P1)]);
    const r = await c.rodar({ envio: { modo: 'pickup', enderecoId: '2001', horarioId: 'slot-1' } });
    expect(r.chamadas[0]?.resumo).toMatchObject({ modo: { tipo: 'corpo', modo: 'pickup' } });
    expect(c.shipOrder).not.toHaveBeenCalled();
  });

  it('uma resposta que não bate com a Shopee sai como escolha inválida, sem organizar nada', async () => {
    const c = cenario([novo(P1)]);
    const r = await c.rodar({ envio: { modo: 'pickup', enderecoId: '9999', horarioId: null } });
    expect(r.chamadas[0]?.resumo).toMatchObject({
      modo: { tipo: 'pergunta', escolhaInvalida: true },
    });
  });

  it('S46: uma reimpressão pronta ⇒ simulado "baixar" com o tipo de etiqueta, ZERO download', async () => {
    const c = cenario([pronto(P1)]);
    const r = await c.rodar();
    expect(c.downloadShippingDocument).not.toHaveBeenCalled();
    expect(c.getShippingParameter).not.toHaveBeenCalled();
    expect(r.chamadas[0]?.resumo).toMatchObject({
      tipo: 'simulado',
      acao: 'baixar',
      tipoDocumento: 'NORMAL_AIR_WAYBILL',
      fases: ['arranjado'],
      progresso: { total: 1, organizados: 1, comRastreio: 1, prontos: 1 },
      modo: null,
    });
    const linhas = renderizarRelatorioEtiqueta(r);
    expect(linhas[0]).toContain('DRY-RUN');
    expect(linhas.join('\n')).toContain('NORMAL_AIR_WAYBILL');
    semIdentificadores(linhas);
  });

  it('o dry-run chama o runner UMA vez: um pedido dividido responde baixar-por-pacote e NÃO abre a caminhada', async () => {
    const c = cenario([pronto(P1, { canal: 91001 }), pronto(P2, { canal: 91002 })]);
    const r = await c.rodar({ envio: { modo: 'dropoff' } });
    expect(c.executar).toHaveBeenCalledTimes(1);
    expect(c.downloadShippingDocument).not.toHaveBeenCalled();
    expect(r.chamadas.map((ch) => ch.resumo)).toMatchObject([
      { tipo: 'baixar-por-pacote', pacotes: 2 },
    ]);
    semIdentificadores(renderizarRelatorioEtiqueta(r));
  });
});

/* ---------------------------------- the live run ----------------------------- */

describe('rodarEtiquetaCli — o --live', () => {
  it('a volta completa: pergunta → a resposta ligada ao pacote NOMEADO → UM ship → bytes', async () => {
    const c = cenario([novo(P1)]);
    const r = await c.rodar({
      live: true,
      envio: { modo: 'pickup', enderecoId: '2001', horarioId: 'slot-1' },
    });

    expect(c.shipOrder).toHaveBeenCalledTimes(1);
    expect(c.shipOrder).toHaveBeenCalledWith({
      orderSn: ORDER_SN,
      modo: 'pickup',
      pickup: { addressId: 2001, pickupTimeId: 'slot-1' },
    });
    expect(c.downloadShippingDocument).toHaveBeenCalledTimes(1);
    expect(c.executar).toHaveBeenCalledTimes(2);
    // The second call carries the answer for the package the QUESTION named.
    expect(c.executar.mock.calls[1]?.[1].envio).toEqual({
      pacote: P1,
      modo: 'pickup',
      enderecoId: '2001',
      horarioId: 'slot-1',
    });
    const deps = c.executar.mock.calls[0]?.[0];
    expect(deps?.somenteLeitura).toBe(false);
    expect(deps?.podeProgramar).toBe(true);
    expect(deps?.orcamentoMs).toBe(ORCAMENTO_CLI_ETIQUETA_MS);

    expect(r.chamadas.map((ch) => ch.resumo.tipo)).toEqual(['escolher-envio', 'bytes']);
    expect(r.chamadas.map((ch) => ch.comResposta)).toEqual([false, true]);
    expect(r.chamadas[1]?.resumo).toEqual({
      tipo: 'bytes',
      formato: 'pdf',
      contentType: 'application/pdf',
      extensao: 'pdf',
      tamanho: PDF.byteLength,
      indice: null,
      total: 1,
    });
    expect(r.interrompido).toBeNull();

    const linhas = renderizarRelatorioEtiqueta(r);
    expect(linhas.join('\n')).toContain(`${String(PDF.byteLength)} bytes, NÃO gravado`);
    semIdentificadores(linhas);
  });

  it('sem resposta de envio, a pergunta ENCERRA a execução: nenhum ship', async () => {
    const c = cenario([novo(P1)]);
    const r = await c.rodar({ live: true });
    expect(c.shipOrder).not.toHaveBeenCalled();
    expect(r.chamadas).toHaveLength(1);
    expect(r.chamadas[0]?.resumo).toMatchObject({
      tipo: 'escolher-envio',
      pacoteRotulo: null,
      enderecos: 2,
      horarios: 2,
      mensagem: MENSAGEM_ESCOLHER_ENVIO,
    });
    const linhas = renderizarRelatorioEtiqueta(r);
    expect(linhas.join('\n')).toContain('--endereco <id> [--horario <id>] ou --dropoff');
    semIdentificadores(linhas);
  });

  it('uma resposta que a Shopee não aceita é respondida UMA vez: a segunda pergunta encerra', async () => {
    const c = cenario([novo(P1)]);
    const r = await c.rodar({
      live: true,
      envio: { modo: 'pickup', enderecoId: '9999', horarioId: null },
    });
    expect(c.shipOrder).not.toHaveBeenCalled();
    expect(r.chamadas.map((ch) => ch.resumo)).toMatchObject([
      { tipo: 'escolher-envio', escolhaInvalida: false },
      { tipo: 'escolher-envio', escolhaInvalida: true },
    ]);
  });

  it('pedido dividido em 2 transportadoras ⇒ baixar-por-pacote, depois UM arquivo por pacote, em ordem', async () => {
    const c = cenario([pronto(P1, { canal: 91001 }), pronto(P2, { canal: 91002 })]);
    const r = await c.rodar({ live: true });

    expect(c.shipOrder).not.toHaveBeenCalled();
    expect(c.downloadShippingDocument).toHaveBeenCalledTimes(2);
    expect(
      c.downloadShippingDocument.mock.calls.map((ch) =>
        ch[0].documentos.map((d) => d.packageNumber),
      ),
    ).toEqual([[P1], [P2]]);
    expect(c.executar.mock.calls.map((ch) => ch[1].pacote)).toEqual([null, P1, P2]);

    expect(r.chamadas.map((ch) => ch.pacote)).toEqual([
      null,
      { indice: 1, total: 2 },
      { indice: 2, total: 2 },
    ]);
    expect(r.chamadas.map((ch) => ch.resumo)).toMatchObject([
      { tipo: 'baixar-por-pacote', pacotes: 2 },
      { tipo: 'bytes', indice: 1, total: 2 },
      { tipo: 'bytes', indice: 2, total: 2 },
    ]);
    semIdentificadores(renderizarRelatorioEtiqueta(r));
  });

  it('com --pacote, baixar-por-pacote não abre a caminhada (o operador já escolheu o pacote)', async () => {
    const fake = vi.fn(
      async (): Promise<ResultadoEtiqueta> => ({
        tipo: 'pendente',
        corpo: {
          acao: 'baixar-por-pacote',
          fase: 'baixando',
          pacotes: [P1, P2],
          mensagem: 'm',
          progresso: { total: 2, organizados: 2, comRastreio: 2, prontos: 2 },
        },
      }),
    );
    const c = cenario([pronto(P1)]);
    const r = await c.rodar({ live: true, pacote: P1 }, fake);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(r.chamadas).toHaveLength(1);
  });

  it('nfe-pendente ⇒ "use enviar:nfe", e a CLI nunca reenvia a NF-e (uma chamada, nenhum ship)', async () => {
    const c = cenario([novo(P1, { nfePendente: true })]);
    const r = await c.rodar({ live: true, envio: { modo: 'dropoff' } });
    expect(c.shipOrder).not.toHaveBeenCalled();
    expect(r.chamadas).toHaveLength(1);
    expect(r.chamadas[0]?.resumo.tipo).toBe('nfe-pendente');
    const linhas = renderizarRelatorioEtiqueta(r);
    expect(linhas.join('\n')).toContain('use enviar:nfe');
    semIdentificadores(linhas);
  });

  it(`o limite de ${String(MAX_CHAMADAS_ETIQUETA_CLI)} chamadas corta uma caminhada sem fim, e diz`, async () => {
    let n = 0;
    const fake = vi.fn(async (): Promise<ResultadoEtiqueta> => {
      n += 1;
      return {
        tipo: 'pendente',
        corpo: {
          acao: 'escolher-envio',
          fase: 'programando',
          // A NEW package every time: the answered-once rule never stops it.
          pacote: `OFG${String(n).padStart(12, '0')}`,
          pacoteRotulo: null,
          mensagem: 'm',
          enderecos: [],
          permiteDropoff: true,
          escolhaInvalida: false,
          progresso: { total: 1, organizados: 0, comRastreio: 0, prontos: 0 },
        },
      };
    });
    const c = cenario([novo(P1)]);
    const r = await c.rodar({ live: true, envio: { modo: 'dropoff' } }, fake);
    expect(fake).toHaveBeenCalledTimes(MAX_CHAMADAS_ETIQUETA_CLI);
    expect(r.interrompido).toBe('limite-de-chamadas');
    expect(renderizarRelatorioEtiqueta(r).join('\n')).toContain(
      `parou em ${String(MAX_CHAMADAS_ETIQUETA_CLI)} chamadas`,
    );
  });

  it('o orçamento de 5 min vale para a execução INTEIRA: a chamada seguinte recebe o que resta, e nenhuma começa depois', async () => {
    const c = cenario([novo(P1)]);
    const orcamentos: (number | undefined)[] = [];
    const fake = vi.fn(async (d: DepsExecucaoEtiqueta): Promise<ResultadoEtiqueta> => {
      orcamentos.push(d.orcamentoMs);
      // The first call eats 4 min, the second the rest.
      c.relogio.agora += orcamentos.length === 1 ? 4 * 60_000 : 60_000;
      return {
        tipo: 'pendente',
        corpo: {
          acao: 'escolher-envio',
          fase: 'programando',
          pacote: orcamentos.length === 1 ? P1 : P2,
          pacoteRotulo: null,
          mensagem: 'm',
          enderecos: [],
          permiteDropoff: true,
          escolhaInvalida: false,
          progresso: { total: 2, organizados: 0, comRastreio: 0, prontos: 0 },
        },
      };
    });
    const r = await c.rodar({ live: true, envio: { modo: 'dropoff' } }, fake);
    // The re-call's wait (R2-4) is charged to the same budget.
    expect(orcamentos).toEqual([ORCAMENTO_CLI_ETIQUETA_MS, 60_000 - ESPERA_POS_PROGRAMAR_MS]);
    expect(r.interrompido).toBe('sem-tempo');
    expect(r.chamadas).toHaveLength(2);
  });

  it('R2-4 PAR: a RE-chamada espera ESPERA_POS_PROGRAMAR_MS antes de chamar de novo — a leitura pode não refletir o ship ainda', async () => {
    const eventos: string[] = [];
    const c = cenario([novo(P1)]);
    c.dormir.mockImplementation(async (ms: number) => {
      eventos.push(`dormir:${String(ms)}`);
      c.relogio.agora += ms;
    });
    const respostas: ResultadoEtiqueta[] = [
      {
        tipo: 'pendente',
        corpo: {
          acao: 'escolher-envio',
          fase: 'programando',
          pacote: P2,
          pacoteRotulo: 'Pacote 2 de 2',
          mensagem: 'm',
          enderecos: [],
          permiteDropoff: true,
          escolhaInvalida: false,
          progresso: { total: 2, organizados: 1, comRastreio: 0, prontos: 0 },
        },
      },
      {
        tipo: 'pendente',
        corpo: {
          acao: 'aguardar',
          fase: 'aguardando-rastreio',
          tentarEmMs: 5_000,
          mensagem: 'm',
          progresso: { total: 2, organizados: 2, comRastreio: 0, prontos: 0 },
        },
      },
    ];
    const fake = vi.fn(async (): Promise<ResultadoEtiqueta> => {
      eventos.push('executar');
      const r = respostas.shift();
      if (r === undefined) throw new Error('chamada a mais');
      return r;
    });
    const r = await c.rodar({ live: true, envio: { modo: 'dropoff' } }, fake);
    expect(r.chamadas).toHaveLength(2);
    // Near-miss: the FIRST call never waits; only the re-call does.
    expect(eventos).toEqual(['executar', `dormir:${String(ESPERA_POS_PROGRAMAR_MS)}`, 'executar']);
  });

  it('R3-F1 PAR: a `recusa-desconhecida` imprime `code=<código>` ao lado do motivo', async () => {
    const c = cenario([novo(P1)]);
    const fake = vi.fn(
      async (): Promise<ResultadoEtiqueta> => ({
        tipo: 'recusa',
        motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
        shopeeCode: 'some_new_code',
        operacao: 'programar',
      }),
    );
    const r = await c.rodar({ live: true }, fake);
    expect(r.chamadas[0]?.resumo).toMatchObject({ tipo: 'recusa', shopeeCode: 'some_new_code' });
    const texto = renderizarRelatorioEtiqueta(r).join('\n');
    expect(texto).toContain('recusa-desconhecida code=some_new_code: ');
    semIdentificadores(renderizarRelatorioEtiqueta(r));
  });

  it.each<[string, Partial<Extract<ResultadoEtiqueta, { tipo: 'recusa' }>>, string | null]>([
    ['sem `shopeeCode` ⇒ nenhum `code=`', {}, null],
    [
      'um "código" com 14 dígitos ⇒ `(não é um código)`, nunca os dígitos',
      { shopeeCode: 'erro_12345678901234' },
      '(não é um código)',
    ],
  ])('R3-F1 QUASE-MISS: %s', async (_rotulo, extra, esperado) => {
    const c = cenario([novo(P1)]);
    const fake = vi.fn(
      async (): Promise<ResultadoEtiqueta> => ({
        tipo: 'recusa',
        motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
        ...extra,
      }),
    );
    const r = await c.rodar({ live: true }, fake);
    const texto = renderizarRelatorioEtiqueta(r).join('\n');
    if (esperado === null) {
      expect(texto).not.toContain('code=');
    } else {
      expect(texto).toContain(`code=${esperado}`);
      expect(texto).not.toContain('12345678901234');
    }
  });
});

/* -------------------------------- the renderer ------------------------------- */

describe('renderizarRelatorioEtiqueta', () => {
  const base = {
    live: true,
    formato: 'pdf' as const,
    pacoteExplicito: false,
    envio: null,
    recusaDoPedido: null,
    interrompido: null,
  };

  it('uma recusa com cota diária imprime o motivo, a frase e o instante em ISO', () => {
    const tentarApos = Date.UTC(2026, 8, 30, 16, 0, 0);
    const linhas = renderizarRelatorioEtiqueta({
      ...base,
      chamadas: [
        {
          pacote: null,
          comResposta: false,
          resumo: {
            tipo: 'recusa',
            motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
            mensagem: 'Tente de novo.',
            tentarApos,
            shopeeCode: null,
          },
        },
      ],
    });
    const texto = linhas.join('\n');
    expect(linhas[0]).toContain('LIVE');
    expect(texto).toContain('limite-diario: Tente de novo.');
    expect(texto).toContain(new Date(tentarApos).toISOString());
  });

  it('R5-6: o sentinela `TIPO_OMITIDO` DO RUNNER (importado, não redigitado) sai como o padrão da Shopee', async () => {
    const c = cenario([pronto(P1)]);
    const fake = vi.fn(
      async (): Promise<ResultadoEtiqueta> => ({
        tipo: 'simulado',
        acao: { tipo: 'baixar', pacotes: [P1], tipoDocumento: TIPO_OMITIDO },
        fases: ['arranjado'],
        progresso: { total: 1, organizados: 1, comRastreio: 1, prontos: 1 },
      }),
    );
    const r = await c.rodar({}, fake);
    expect(r.chamadas[0]?.resumo).toMatchObject({ tipoDocumento: 'padrão da Shopee (sem tipo)' });
  });

  it('um tipo de documento fora do padrão de token não é impresso', async () => {
    const c = cenario([pronto(P1)]);
    const fake = vi.fn(
      async (): Promise<ResultadoEtiqueta> => ({
        tipo: 'simulado',
        acao: { tipo: 'baixar', pacotes: [P1], tipoDocumento: `tipo ${ORDER_SN}` },
        fases: ['arranjado'],
        progresso: { total: 1, organizados: 1, comRastreio: 1, prontos: 1 },
      }),
    );
    const r = await c.rodar({}, fake);
    expect(r.chamadas[0]?.resumo).toMatchObject({
      tipoDocumento: '(tipo fora do padrão — não impresso)',
    });
    semIdentificadores(renderizarRelatorioEtiqueta(r));
  });
});

/* ---------------------------------- the errors ------------------------------- */

describe('descreverErroEtiqueta', () => {
  it('um ShopeeApiError sai por CLASSE e código — nunca a mensagem da Shopee', () => {
    const err = shopeeErrorFromEnvelope(
      {
        error: 'logistics.package_can_not_print',
        message: `o pacote ${P1} do pedido ${ORDER_SN} não imprime`,
        request_id: null,
        warning: null,
      },
      {
        path: '/api/v2/logistics/ship_order',
        httpStatus: 200,
        surface: SHOPEE_SURFACE.business,
      },
    );
    const linhas = descreverErroEtiqueta(err);
    expect(linhas.join('\n')).toContain('code=logistics.package_can_not_print');
    semIdentificadores(linhas);
  });

  it('a etiqueta vazia é descrita ANTES do ramo genérico de schema', () => {
    const vazio = new ShopeeArquivoVazioError('vazio', { httpStatus: 200, path: '/x' });
    expect(descreverErroEtiqueta(vazio)[0]).toContain('ShopeeArquivoVazioError');
    const schema = new ShopeeSchemaError('s', { httpStatus: 200, path: '/x', campos: ['a'] });
    expect(descreverErroEtiqueta(schema)[0]).toContain('ShopeeSchemaError');
  });

  it('as classes de credencial saem com uma frase fixa, sem o id da integração', () => {
    const linhas = descreverErroEtiqueta(
      new ShopeeContaSemShopIdError(`Integração ${CONTA} está conectada por conta principal.`),
    );
    expect(linhas.join('\n')).not.toContain(CONTA);
  });

  it('um argumento inválido imprime a ajuda desta CLI, e só ele é uma recusa ANTES do envio', () => {
    const err = new ArgumentoInvalidoError('ruim');
    expect(descreverErroEtiqueta(err)).toEqual(['❌ ruim', '', USO_BAIXAR_ETIQUETA]);
    expect(ehRecusaAntesDoEnvioEtiqueta(err)).toBe(true);
    expect(ehRecusaAntesDoEnvioEtiqueta(new Error('x'))).toBe(false);
  });
});

/* ------------------------------- the module text ----------------------------- */

describe('o módulo', () => {
  const fonte = readFileSync(fileURLToPath(new URL('./etiquetaCli.ts', import.meta.url)), 'utf8');

  it('nomeia o runner e as respostas só por TIPO, e não carrega next/server', () => {
    expect(fonte).toContain(
      "import type { DepsExecucaoEtiqueta, EntradaEtiqueta, ResultadoEtiqueta } from './executarEtiqueta';",
    );
    expect(fonte).toContain(
      "import type { EtiquetaPendente, Progresso } from './pendenteEtiqueta';",
    );
    expect(fonte).not.toMatch(/import\s+\{[^}]*\}\s+from\s+'\.\/executarEtiqueta'/);
    expect(fonte).not.toMatch(/import\s+\{[^}]*\}\s+from\s+'\.\/respostaEtiqueta'/);
    expect(fonte).not.toContain("from 'next/server'");
  });

  it('não lê relógio, ambiente nem grava arquivo', () => {
    expect(fonte).not.toMatch(/Date\.now\(|process\.env|writeFile|node:fs/);
  });
});
