/**
 * The label route's body (step 15, PR 15-d), the ladder R2–R14, end to end against
 * the fake Firestore: the REAL context, the REAL write engine and run, the REAL
 * order read, decision, plan and answer reader, the REAL token mint, bulk, download
 * and extraction, all over ONE scripted `fetch` routed by host, path and method. A
 * class the real ladder cannot raise at a given rung is thrown through a one-shot
 * seam on the module that would raise it.
 *
 * After EVERY test: nothing reached the global `fetch` (a refusing stub for this
 * file), no line or answer carries the label's link, and no scenario wrote anything
 * but what it declared (nothing, unless it meets a stale LWA token or a forced
 * refresh after a 401/403).
 *
 * ⚠️ D11: the read switch is `on` ONLY in the object literal handed in as `ambiente`.
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { AmazonConfigError } from '@delfrance/integrations-amazon-sp-api';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ETIQUETA_AMAZON as CODIGO,
  ESTADO_FRETE,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  erroEtiquetaAmazonSchema,
} from '@delfrance/schemas';

import { avisarSegredoLwaRecusado, chaveSegredoRecusado } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonInativaError,
} from '../core/erros';
import type { LoggerAmazon } from '../core/log';
import type { AmbienteAmazon } from '../env';
import { FalhaTarefaAmazonError } from '../notificacoes/notificacao';
import { AmazonLeituraDefasadaError } from '../pedidos/erros';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  erroLwa,
  type LinhaDeLog,
  loggerEspiao,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import {
  ATUALIZADO_US,
  ORDER_ID_TESTE,
  type OpcoesPedidoTeste,
  linhaAmazon,
  pacoteAmazon,
  pedidoAmazon,
} from '../testing/pedidoWireAmazon';
import { bytesDe, corromper, zipDeTeste } from '../testing/zipEtiqueta';
import {
  type DepsEtiquetaAmazon,
  MAX_CORPO_ETIQUETA_BYTES,
  ROTA_ETIQUETA_AMAZON,
  type ResultadoEtiquetaAmazon,
  imprimirEtiquetaAmazon,
} from './etiquetaAmazon';

/** One-shot seams for the classes the real ladder cannot raise at their rung. */
const h = vi.hoisted(() => ({
  falhaLeitura: null as unknown,
  falhaBulk: null as unknown,
  depoisDoContexto: null as (() => void) | null,
}));

vi.mock('../core/contexto', async (original) => {
  const real = await original<typeof import('../core/contexto')>();
  return {
    ...real,
    loadAmazonContext: async (...args: Parameters<typeof real.loadAmazonContext>) => {
      const contexto = await real.loadAmazonContext(...args);
      h.depoisDoContexto?.();
      return contexto;
    },
  };
});

vi.mock('../pedidos/lerPedidoAmazon', async (original) => {
  const real = await original<typeof import('../pedidos/lerPedidoAmazon')>();
  return {
    ...real,
    lerPedidoAmazon: (...args: Parameters<typeof real.lerPedidoAmazon>) =>
      h.falhaLeitura === null ? real.lerPedidoAmazon(...args) : Promise.reject(h.falhaLeitura),
  };
});

vi.mock('./easyShipAmazon', async (original) => {
  const real = await original<typeof import('./easyShipAmazon')>();
  return {
    ...real,
    agendarNaAmazon: (...args: Parameters<typeof real.agendarNaAmazon>) =>
      h.falhaBulk === null ? real.agendarNaAmazon(...args) : Promise.reject(h.falhaBulk),
  };
});

const CONTA = 'conta-amz-etiqueta';
const ORDER = ORDER_ID_TESTE;
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const CAMINHO = `pedidos/${PEDIDO_ID}`;
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/etiqueta';
const RDT = 'Atz.TESTE-rdt-sintetico-naoreal';
const CAMINHO_MINT = '/tokens/2021-03-01/restrictedDataToken';
const CAMINHO_BULK = '/easyShip/2022-03-23/packages/bulk';
const GET_ORDER = `GET /orders/2026-01-01/orders/${ORDER}`;
const POST_MINT = `POST ${CAMINHO_MINT}`;
const POST_BULK = `POST ${CAMINHO_BULK}`;
const GET_DOCUMENTO = 'GET DOCUMENTO';
const LWA = 'LWA';

/** Amazon-made ids and the label's link: what the scans below hunt. */
const SENTINELA = {
  refPacote: 'PKG-SENTINELA-REF-0001',
  rastreioPedido: 'TRK-SENTINELA-PEDIDO-0001',
  pacoteBulk: 'PKG-SENTINELA-BULK-0001',
  rastreioBulk: 'TRK-SENTINELA-BULK-0001',
  slot: 'SLOT-SENTINELA-0001',
  url: 'https://example-bucket.s3.amazonaws.com/etiqueta.zip?X-Amz-Signature=0000sentinela',
  textoDaAmazon: 'TEXTO-SENTINELA-DA-AMAZON',
  entrada: 'entrada-sentinela.zpl',
} as const;

const ZPL = bytesDe('^XA^FO50,50^ADN,36,20^FDETIQUETA DE TESTE^FS^XZ\n');
const ZIP_OK = zipDeTeste({ [SENTINELA.entrada]: ZPL });

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  /** A byte answer (the document), instead of a JSON one. */
  readonly bytes?: Uint8Array;
  /** The connection drops instead of an answer (`fetch` rejects). */
  readonly rede?: true;
  /** No answer ever comes: it settles only when the request's own deadline aborts it. */
  readonly nunca?: true;
}

type Rota = 'getOrder' | 'mint' | 'bulk' | 'documento' | 'lwa';

/** The DBA order getOrder sends: one package at `detalhe`, the order-level invoice status ACCEPTED. */
function ordem(detalhe = 'PENDING_SCHEDULE', opcoes: OpcoesPedidoTeste = {}): Roteiro {
  return {
    status: 200,
    corpo: {
      order: JSON.parse(
        JSON.stringify(
          pedidoAmazon({
            status: 'UNSHIPPED',
            programs: ['DELIVERY_BY_AMAZON'],
            invoiceStatus: 'ACCEPTED',
            pacotesBrutos: [
              pacoteAmazon(SENTINELA.refPacote, detalhe, {
                status: 'PENDING',
                rastreio: SENTINELA.rastreioPedido,
              }),
            ],
            ...opcoes,
          }),
        ),
      ) as unknown,
    },
  };
}

const JA_AGENDADO = ordem('PENDING_PICK_UP');

/** Our order in `scheduledPackages`, every Amazon-made id and the label's link included. */
const pacoteDoBulk = {
  scheduledPackageId: { amazonOrderId: ORDER, packageId: SENTINELA.pacoteBulk },
  packageStatus: 'ReadyForPickup',
  trackingDetails: { trackingId: SENTINELA.rastreioBulk },
  packageTimeSlot: { slotId: SENTINELA.slot, handoverMethod: 'PICKUP' },
};
const BULK_OK: Roteiro = {
  status: 200,
  corpo: {
    scheduledPackages: [pacoteDoBulk],
    rejectedOrders: [],
    printableDocumentsUrl: SENTINELA.url,
  },
};
const BULK_SEM_URL: Roteiro = {
  status: 200,
  corpo: { scheduledPackages: [pacoteDoBulk], rejectedOrders: [] },
};

/** Amazon's 2xx rejecting OUR order with `codigo` (`null`: no `error` object at all). */
function rejeitado(codigo: string | null, url: boolean): Roteiro {
  return {
    status: 200,
    corpo: {
      scheduledPackages: [],
      rejectedOrders: [
        codigo === null
          ? { amazonOrderId: ORDER }
          : {
              amazonOrderId: ORDER,
              error: { code: codigo, message: SENTINELA.textoDaAmazon },
            },
      ],
      ...(url ? { printableDocumentsUrl: SENTINELA.url } : {}),
    },
  };
}

/** Amazon's 2xx naming our order in neither list. */
function semPedido(url: boolean): Roteiro {
  return {
    status: 200,
    corpo: {
      scheduledPackages: [],
      rejectedOrders: [],
      ...(url ? { printableDocumentsUrl: SENTINELA.url } : {}),
    },
  };
}

/** A top-level error list. */
const erro = (status: number, codigo: string): Roteiro => ({
  status,
  corpo: { errors: [{ code: codigo, message: SENTINELA.textoDaAmazon }] },
});

/** A synthetic proc: `finNFe` and `tpAmb` (production); no real party. */
function proc(finNFe = '1'): string {
  return (
    '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF>' +
    `<finNFe>${finNFe}</finNFe></ide></infNFe></NFe></nfeProc>`
  );
}

const NFE_APROVADA = { estado: ESTADO_NFE.aprovada, xml_nfe_proc: proc() };
const NFE_VENDA_CANCELADA = { estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc() };

/** The pedido as the importer wrote it: proved, paid, DBA, its freight `amz` waiting to be scheduled. */
function pedidoRaw(
  extra: Record<string, unknown> = {},
  frete: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: ESTADO_PEDIDO.pago,
    ultimaModificacao: ATUALIZADO_US + 10,
    lastMarketplaceUpdate: ATUALIZADO_US,
    marketplace: { tipo: 'amazon', fulfilledBy: 'MERCHANT', programs: ['DELIVERY_BY_AMAZON'] },
    freteInicial: {
      externalOptionIntegracao: 'amz',
      modalidade: '1',
      estado: ESTADO_FRETE.aguardandoAgendamento,
      ultimaModificacao: ATUALIZADO_US,
      ...frete,
    },
    ...extra,
  };
}

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  readonly rotas: Record<Rota, Roteiro[]>;
  /** Every request that reached the scripted fetch, in order. */
  readonly chamadas: string[];
  /** What the document request carried. */
  readonly documento: { init: RequestInit | undefined };
  /** Firestore's operation count when the bulk was answered, and when the download started. */
  readonly operacoesEm: { bulk: number | null; documento: number | null };
  /** The paths this scenario may write (the context's own, on a stale LWA token or a forced refresh). */
  readonly escritasPermitidas: Set<string>;
  /** Firestore's operation count at each `evento: 'valvula'` line, as `rodar` logged it. */
  readonly operacoesNaValvula: number[];
  readonly lerDb: ReturnType<typeof vi.fn<DepsEtiquetaAmazon['db']>>;
  readonly fetch: typeof globalThis.fetch;
  ambiente: AmbienteAmazon;
  podeAgendar: boolean;
  /** Runs once, right after getOrder is answered (before the plan). */
  depoisDoGetOrder: (() => void) | null;
  /** Every answer this scenario produced, for the hygiene scan. */
  readonly respostas: ResultadoEtiquetaAmazon[];
  rodar(corpo?: unknown): Promise<ResultadoEtiquetaAmazon>;
}

const cenarios: Cenario[] = [];

function requisicao(corpo: unknown): Request {
  return new Request(URL_ROTA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function respostaDeBytes(r: Roteiro): Response {
  return new Response((r.bytes ?? new Uint8Array(0)) as BodyInit, { status: r.status ?? 200 });
}

function cenario(rotas: Partial<Record<Rota, Roteiro[]>> = {}, pedido = pedidoRaw()): Cenario {
  const fake = new FakeDb();
  seedConta(fake, CONTA, { nome: 'Conta etiqueta', selling_partner_id: SPID_A });
  seedCredencial(fake, CONTA);
  fake.seed(CAMINHO, pedido);
  const log = loggerEspiao();
  const operacoesNaValvula: number[] = [];
  const espiar =
    (gravar: LoggerAmazon['info']): LoggerAmazon['info'] =>
    (mensagem, campos) => {
      if (campos?.evento === 'valvula') operacoesNaValvula.push(fake.operacoes);
      gravar(mensagem, campos);
    };
  const logger: LoggerAmazon = {
    info: espiar(log.logger.info),
    warn: espiar(log.logger.warn),
    error: espiar(log.logger.error),
  };
  const c: Cenario = {
    fake,
    log,
    rotas: {
      getOrder: rotas.getOrder ?? [ordem()],
      mint: rotas.mint ?? [{ status: 200, corpo: { restrictedDataToken: RDT, expiresIn: 3600 } }],
      bulk: rotas.bulk ?? [BULK_OK],
      documento: rotas.documento ?? [{ status: 200, bytes: ZIP_OK }],
      lwa: rotas.lwa ?? [],
    },
    chamadas: [],
    documento: { init: undefined },
    operacoesEm: { bulk: null, documento: null },
    escritasPermitidas: new Set<string>(),
    operacoesNaValvula,
    lerDb: vi.fn<DepsEtiquetaAmazon['db']>(() => asDb(fake)),
    ambiente: {
      ...AMBIENTE_LIGADO,
      AMAZON_MODO_AGENDAMENTO: 'on',
      AMAZON_CANARIO_AGENDAMENTO: '*',
    },
    podeAgendar: true,
    depoisDoGetOrder: null,
    respostas: [],
    fetch: (input, init) => {
      const url = new URL(String(input));
      const metodo = init?.method ?? 'GET';
      const proximo = (rota: Rota): Roteiro => {
        const fila = c.rotas[rota];
        const r = fila.length > 1 ? fila.shift() : fila[0];
        if (r === undefined) throw new Error(`sem resposta para ${rota}`);
        return r;
      };
      if (url.hostname.endsWith('.amazonaws.com')) {
        c.chamadas.push(GET_DOCUMENTO);
        c.documento.init = init;
        c.operacoesEm.documento = fake.operacoes;
        const r = proximo('documento');
        if (r.rede === true) return Promise.reject(new TypeError('fetch failed'));
        if (r.nunca === true) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason as Error);
            });
          });
        }
        return Promise.resolve(respostaDeBytes(r));
      }
      if (url.pathname === '/auth/o2/token') {
        c.chamadas.push(LWA);
        if (c.rotas.lwa.length === 0) return Promise.resolve(tokenDeAcesso());
        const r = proximo('lwa');
        return Promise.resolve(
          r.status === 200 || r.status === undefined
            ? tokenDeAcesso()
            : erroLwa(r.status, 'invalid_grant'),
        );
      }
      c.chamadas.push(`${metodo} ${url.pathname}`);
      const rota: Rota | null =
        `${metodo} ${url.pathname}` === GET_ORDER
          ? 'getOrder'
          : url.pathname === CAMINHO_MINT && metodo === 'POST'
            ? 'mint'
            : url.pathname === CAMINHO_BULK && metodo === 'POST'
              ? 'bulk'
              : null;
      if (rota === null) return Promise.reject(new Error(`rota não roteirizada: ${url.pathname}`));
      const r = proximo(rota);
      if (rota === 'bulk') c.operacoesEm.bulk = fake.operacoes;
      if (r.rede === true) return Promise.reject(new TypeError('fetch failed'));
      if (rota === 'getOrder' && c.depoisDoGetOrder !== null) {
        const gancho = c.depoisDoGetOrder;
        c.depoisDoGetOrder = null;
        gancho();
      }
      return Promise.resolve(respostaJson(r.status ?? 200, r.corpo ?? {}));
    },
    rodar: async (corpo = { pedidoId: PEDIDO_ID }) => {
      const r = await imprimirEtiquetaAmazon(requisicao(corpo), {
        ambiente: c.ambiente,
        db: c.lerDb,
        logger,
        podeAgendar: c.podeAgendar,
        fetch: c.fetch,
        agora: () => AGORA_MS,
        gerarCorrelationId: () => 'corr-etiqueta-teste',
      });
      c.respostas.push(r);
      return r;
    },
  };
  cenarios.push(c);
  return c;
}

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  h.falhaLeitura = null;
  h.falhaBulk = null;
  h.depoisDoContexto = null;
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: o fetch global nunca deve ser chamado'));
  });
});

const texto = (l: LinhaDeLog) => `${l.mensagem} ${JSON.stringify(l.meta ?? {})}`;

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  // Emptied before any assertion, so a failure here never leaks into the next test.
  const globais = rede.splice(0);
  const vistos = cenarios.splice(0);
  // ★ (mutation 20) Nothing ever reached the global fetch.
  expect(globais).toEqual([]);
  for (const c of vistos) {
    // ★ (mutation 3) The route writes no pedido, freight, scheduling or aviso document.
    const outras = c.fake.escritas
      .map((w) => w.caminho)
      .filter((p) => !c.escritasPermitidas.has(p));
    expect(outras).toEqual([]);
    // ★ (mutation 6) The label's link reaches no line and no answer, on any arm.
    for (const l of c.log.linhas) {
      expect(texto(l)).not.toContain('X-Amz-');
      expect(texto(l)).not.toContain('amazonaws');
    }
    for (const r of c.respostas) {
      const corpo = r.tipo === 'erro' ? JSON.stringify(r.corpo) : r.nomeArquivo;
      expect(corpo).not.toContain('X-Amz-');
      expect(corpo).not.toContain('amazonaws');
      expect(corpo).not.toContain(SENTINELA.textoDaAmazon);
    }
  }
});

const posts = (c: Cenario) => c.chamadas.filter((x) => x.startsWith('POST '));

/** Lines this route wrote: its own `evento: 'agendamento'`, never the engine's diff. */
const linhasDaRota = (c: Cenario) =>
  c.log.linhas.filter(
    (l) => l.meta?.evento === 'agendamento' && l.meta.rota === ROTA_ETIQUETA_AMAZON,
  );

interface Esperado {
  readonly status: number;
  readonly code: string;
  /** The answer's `motivo`; omitted when the answer carries none (and the 502/503 never do). */
  readonly motivo?: string;
  /** The line's `motivo`, when it says more than the answer's. */
  readonly motivoNaLinha?: string | null;
}

/** The answer, through the envelope's own schema, and its ONE line. */
function esperarResposta(c: Cenario, r: ResultadoEtiquetaAmazon, e: Esperado): void {
  if (r.tipo !== 'erro') throw new Error('esperava uma resposta de erro');
  expect(r.status).toBe(e.status);
  const corpo = erroEtiquetaAmazonSchema.parse(r.corpo);
  expect(corpo.code).toBe(e.code);
  if (e.motivo === undefined) expect(r.corpo).not.toHaveProperty('motivo');
  else expect(corpo.motivo).toBe(e.motivo);
  const linhas = linhasDaRota(c);
  expect(linhas).toHaveLength(1);
  expect(linhas[0]?.meta).toMatchObject({
    resultado: e.code,
    motivo: e.motivoNaLinha === undefined ? (e.motivo ?? null) : e.motivoNaLinha,
  });
  expect(linhas[0]?.nivel).toBe(e.status >= 500 ? 'warn' : 'info');
}

/** The 200: the zip's ZPL entry, byte for byte, and its ONE line. */
function esperarEtiqueta(c: Cenario, r: ResultadoEtiquetaAmazon): void {
  if (r.tipo !== 'zpl') throw new Error(`esperava a etiqueta, veio ${JSON.stringify(r)}`);
  expect(r.nomeArquivo).toBe(`amazon-${ORDER}.zpl`);
  expect(Buffer.from(r.bytes).equals(Buffer.from(ZPL))).toBe(true);
  const linhas = linhasDaRota(c);
  expect(linhas).toHaveLength(1);
  expect(linhas[0]?.meta).toMatchObject({
    resultado: 'impresso',
    motivo: null,
    bytesZip: ZIP_OK.byteLength,
    bytesZpl: ZPL.byteLength,
  });
}

/** The ids a line carries: the pedido id from R5, the conta and the order from R6 on. */
const IDS_ATE_O_PEDIDO = { pedidoId: PEDIDO_ID, conta: null, pedido: null } as const;
const IDS_COMPLETOS = { pedidoId: PEDIDO_ID, conta: CONTA, pedido: ORDER } as const;

/** A failure that leaves as a 500: thrown, after ONE ERROR line naming the class and the ids. */
function esperarLinhaDeFalha(
  c: Cenario,
  motivo: string,
  ids: typeof IDS_ATE_O_PEDIDO | typeof IDS_COMPLETOS,
): void {
  const linhas = linhasDaRota(c);
  expect(linhas).toHaveLength(1);
  expect(linhas[0]).toMatchObject({
    nivel: 'error',
    meta: { resultado: 'falhou', motivo, ...ids },
  });
}

/** The forced refresh's ONE write: the credential's 3-key patch, and nothing else. */
function esperarSoOPatchDaCredencial(c: Cenario): void {
  expect(c.fake.escritas.map((w) => w.caminho)).toEqual([caminhoCredencial(CONTA)]);
  expect(Object.keys(c.fake.escritas[0]?.dados ?? {}).sort()).toEqual([
    'access_token',
    'acessoRef',
    'expirationDate',
  ]);
}

/* -------------------------------------------------------------------------- */

describe('R2 — the body, before anything else is read', () => {
  it.each<[string, unknown, readonly string[]]>([
    ['not JSON', 'x{', ['(corpo)']],
    ['an empty body', '', ['(corpo)']],
    ['an array', [PEDIDO_ID], ['(corpo)']],
    ['a JSON string', JSON.stringify(PEDIDO_ID), ['(corpo)']],
    ['no pedidoId', {}, ['pedidoId']],
    ['a pedidoId outside the grammar', { pedidoId: 'x' }, ['pedidoId']],
    ['a pedidoId in upper case', { pedidoId: PEDIDO_ID.toUpperCase() }, ['pedidoId']],
    ['the Amazon order number', { pedidoId: ORDER }, ['pedidoId']],
    ['a `formato` beside the id', { pedidoId: PEDIDO_ID, formato: 'ZPL' }, ['formato']],
    [
      'past the 4-KiB bound',
      { pedidoId: PEDIDO_ID, x: 'a'.repeat(MAX_CORPO_ETIQUETA_BYTES) },
      ['(corpo)'],
    ],
  ])('★ %s ⇒ 400, the field paths, nothing read', async (_titulo, corpo, issues) => {
    const c = cenario();
    const r = await c.rodar(corpo);
    esperarResposta(c, r, { status: 400, code: CODIGO.CORPO_INVALIDO });
    if (r.tipo !== 'erro') throw new Error('esperava erro');
    expect(r.corpo.issues).toEqual(issues);
    expect(c.lerDb).not.toHaveBeenCalled();
    expect(c.fake.operacoes).toBe(0);
    expect(c.chamadas).toEqual([]);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ pedidoId: null, conta: null });
  });

  it('a body exactly at the 4-KiB bound is read (NEAR-MISS of the row above): it fails on its key, not its size', async () => {
    expect(MAX_CORPO_ETIQUETA_BYTES).toBe(4096);
    const c = cenario();
    const corpo = JSON.stringify({ pedidoId: PEDIDO_ID, x: '' });
    const noLimite = corpo.replace(
      '"x":""',
      `"x":"${'a'.repeat(MAX_CORPO_ETIQUETA_BYTES - corpo.length)}"`,
    );
    expect(noLimite).toHaveLength(MAX_CORPO_ETIQUETA_BYTES);
    const r = await c.rodar(noLimite);
    if (r.tipo !== 'erro') throw new Error('esperava erro');
    expect(r.corpo.issues).toEqual(['x']);
  });
});

describe('R3 — the read switch, before any Firestore read', () => {
  it.each<[string, string, string | undefined]>([
    ['unset', 'info', undefined],
    ['blank', 'info', ''],
    ['off', 'info', 'off'],
    ['upper case', 'warn', 'ON'],
    ['with a space', 'warn', ' on'],
    ['true', 'warn', 'true'],
  ])(
    '★ (mutation 4) %s ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS: the db handle never built, zero operations, zero fetch, the shared line only, at level %s',
    async (_titulo, nivel, valor) => {
      const c = cenario();
      c.ambiente = { ...c.ambiente, AMAZON_CHAMADAS: valor };
      const r = await c.rodar();
      if (r.tipo !== 'erro') throw new Error('esperava erro');
      expect(r.status).toBe(503);
      expect(erroEtiquetaAmazonSchema.parse(r.corpo).code).toBe(
        CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      );
      expect(r.corpo).not.toHaveProperty('motivo');
      expect(c.lerDb).not.toHaveBeenCalled();
      expect(c.fake.operacoes).toBe(0);
      expect(c.chamadas).toEqual([]);
      expect(c.log.linhas.map((l) => l.meta?.evento)).toEqual(['chamada-bloqueada']);
      expect(c.log.linhas[0]?.meta).toMatchObject({ rota: ROTA_ETIQUETA_AMAZON });
      expect(c.log.linhas[0]?.nivel).toBe(nivel);
    },
  );

  it('NEAR-MISS: a bad body with the switch off is still the 400 — the body comes first', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CHAMADAS: undefined };
    esperarResposta(c, await c.rodar({}), { status: 400, code: CODIGO.CORPO_INVALIDO });
  });
});

describe('R4 — the valve line', () => {
  it('★ (mutation 18) ONE evento valvula line, fluxo agendamento, with no `rota`: that is a campo of the route’s own line', async () => {
    const c = cenario();
    await c.rodar();
    const linhas = c.log.linhas.filter((l) => l.meta?.evento === 'valvula');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toMatchObject({ fluxo: 'agendamento', modo: 'on', canario: 'todos' });
    expect(linhas[0]?.meta).not.toHaveProperty('rota');
  });
});

describe('R5 — the pedido and its NF-e documents', () => {
  it('★ an absent pedido ⇒ 404, ONE read, no listing, zero fetch — and the valve was read and logged BEFORE that read (R4 precedes R5)', async () => {
    const c = cenario();
    c.fake.apagar(CAMINHO);
    esperarResposta(c, await c.rodar(), {
      status: 404,
      code: CODIGO.PEDIDO_NAO_ENCONTRADO,
    });
    expect(c.fake.leituras).toEqual([CAMINHO]);
    expect(c.fake.consultas).toEqual([]);
    expect(c.chamadas).toEqual([]);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ pedidoId: PEDIDO_ID, pedido: null });
    expect(c.log.linhas.map((l) => l.meta?.evento)).toEqual(['valvula', 'agendamento']);
    // The valve line was written with ZERO Firestore operations behind it.
    expect(c.operacoesNaValvula).toEqual([0]);
  });

  it('★ the print reads the pedido ONCE and lists its nfev4 subcollection ONCE, unfiltered', async () => {
    const c = cenario();
    esperarEtiqueta(c, await c.rodar());
    expect(c.fake.leituras.filter((p) => p === CAMINHO)).toHaveLength(1);
    expect(c.fake.consultas).toEqual([
      expect.objectContaining({
        colecao: `${CAMINHO}/nfev4`,
        filtros: [],
        ordens: [],
        limite: null,
      }),
    ]);
  });

  it.each<
    [string, (c: Cenario, falha: Error) => void, typeof IDS_ATE_O_PEDIDO | typeof IDS_COMPLETOS]
  >([
    ['the pedido read', (c, falha) => c.fake.falharLeitura(CAMINHO, falha), IDS_ATE_O_PEDIDO],
    [
      'the nfev4 listing',
      (c, falha) => c.fake.falharConsulta(`${CAMINHO}/nfev4`, falha),
      IDS_ATE_O_PEDIDO,
    ],
    [
      'the conta read (R8)',
      (c, falha) => c.fake.falharLeitura(caminhoConta(CONTA), falha),
      IDS_COMPLETOS,
    ],
    [
      'the credential read (R8)',
      (c, falha) => c.fake.falharLeitura(caminhoCredencial(CONTA), falha),
      IDS_COMPLETOS,
    ],
  ])(
    '★ a Firestore failure at %s PROPAGATES unchanged (the platform’s 500), after ONE ERROR line with its class and the ids known there, zero fetch',
    async (_titulo, armar, ids) => {
      const c = cenario();
      const falha = grpc(14, 'indisponível');
      armar(c, falha);
      await expect(c.rodar()).rejects.toBe(falha);
      esperarLinhaDeFalha(c, 'Firestore/14', ids);
      expect(c.chamadas).toEqual([]);
    },
  );

  it('★ a Firestore failure mid-run (the credential re-read of the first request) PROPAGATES too, after ONE ERROR line, nothing sent', async () => {
    const c = cenario();
    const falha = grpc(4, 'prazo');
    h.depoisDoContexto = () => c.fake.falharLeitura(caminhoCredencial(CONTA), falha);
    await expect(c.rodar()).rejects.toBe(falha);
    esperarLinhaDeFalha(c, 'Firestore/4', IDS_COMPLETOS);
    expect(c.chamadas).toEqual([]);
  });

  it('★ a bug (a TypeError inside the run) propagates UNTOUCHED, with no line of its own (rule 6)', async () => {
    const c = cenario();
    const bug = new TypeError('defeito');
    h.falhaBulk = bug;
    await expect(c.rodar()).rejects.toBe(bug);
    expect(linhasDaRota(c)).toEqual([]);
  });
});

describe('R6 — the stored gates', () => {
  it.each<[string, () => Record<string, unknown>, string]>([
    [
      'not proved an Amazon pedido',
      () => pedidoRaw({ integracaoPedidoOuterRef: null }),
      'nao-amazon',
    ],
    [
      'another integradora’s freight',
      () => pedidoRaw({}, { externalOptionIntegracao: 'me' }),
      'outra-integradora',
    ],
    ['a cancelled sale', () => pedidoRaw({ estado: ESTADO_PEDIDO.cancelado }), 'pedido-cancelado'],
    [
      'a sale refunded in full',
      () => pedidoRaw({ estado: ESTADO_PEDIDO.estornadoIntegralmente }),
      'pedido-cancelado',
    ],
    [
      'a pedido held at error',
      () => pedidoRaw({ estado: ESTADO_PEDIDO.error }),
      'pedido-bloqueado',
    ],
    ['stored goods out', () => pedidoRaw({}, { estado: ESTADO_FRETE.postado }), 'mercadoria-fora'],
  ])(
    '★ %s ⇒ 409 NAO_ELEGIVEL with its motivo, before the context: no conta or credential read, zero fetch',
    async (_titulo, pedido, motivo) => {
      const c = cenario({}, pedido());
      esperarResposta(c, await c.rodar(), { status: 409, code: CODIGO.NAO_ELEGIVEL, motivo });
      expect(c.chamadas).toEqual([]);
      expect(c.fake.leituras).toEqual([CAMINHO]);
      expect(linhasDaRota(c)[0]?.meta).toMatchObject(IDS_ATE_O_PEDIDO);
    },
  );

  it('★ a stored refusal on a conta the context would refuse is still the stored refusal: R6 answers before R8', async () => {
    const c = cenario({}, pedidoRaw({ estado: ESTADO_PEDIDO.cancelado }));
    seedConta(c.fake, CONTA, { ativo: false, selling_partner_id: SPID_A });
    esperarResposta(c, await c.rodar(), {
      status: 409,
      code: CODIGO.NAO_ELEGIVEL,
      motivo: 'pedido-cancelado',
    });
    expect(c.fake.leituras).toEqual([CAMINHO]);
  });

  it.each([
    ESTADO_FRETE.checkFinalizado,
    ESTADO_FRETE.aguardandoPostagem,
    ESTADO_FRETE.error,
  ] as const)(
    'NEAR-MISS: stored %s is not goods out: the live order decides, and it prints',
    async (estado) => {
      const c = cenario({}, pedidoRaw({}, { estado }));
      esperarEtiqueta(c, await c.rodar());
    },
  );
});

describe('R7 — the target under the valve', () => {
  it.each<[string, string | undefined]>([
    ['unset', undefined],
    ['off', 'off'],
    ['an unrecognised value', 'ON'],
  ])(
    '★ (mutation 2) the valve %s ⇒ 503 DESLIGADA, ZERO fetch, and it stops before the context: no conta or credential read',
    async (_titulo, modo) => {
      const c = cenario();
      c.ambiente = { ...c.ambiente, AMAZON_MODO_AGENDAMENTO: modo };
      esperarResposta(c, await c.rodar(), {
        status: 503,
        code: CODIGO.DESLIGADA,
        motivoNaLinha: 'off',
      });
      expect(c.chamadas).toEqual([]);
      expect(c.fake.leituras).toEqual([CAMINHO]);
      expect(linhasDaRota(c)[0]?.meta).toMatchObject(IDS_COMPLETOS);
    },
  );
});

describe('R8 — the context, mapped by class', () => {
  it.each<[string, (c: Cenario) => void, string]>([
    ['the conta absent', (c) => c.fake.apagar(caminhoConta(CONTA)), 'conta-indisponivel'],
    [
      'the conta not an Amazon one',
      (c) => seedConta(c.fake, CONTA, { tipo: 1, selling_partner_id: SPID_A }),
      'conta-indisponivel',
    ],
    [
      'the conta inactive',
      (c) => seedConta(c.fake, CONTA, { ativo: false, selling_partner_id: SPID_A }),
      'conta-inativa',
    ],
    [
      'the conta not connected',
      (c) => seedConta(c.fake, CONTA, { selling_partner_id: null }),
      'conta-indisponivel',
    ],
    ['no credential', (c) => c.fake.apagar(caminhoCredencial(CONTA)), 'conta-indisponivel'],
    [
      'a corrupt credential',
      (c) => c.fake.seed(caminhoCredencial(CONTA), credencialDoc({ acessoRef: 42 })),
      'conta-indisponivel',
    ],
    [
      'a parked credential',
      (c) =>
        c.fake.seed(
          caminhoCredencial(CONTA),
          credencialDoc({
            reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: 'r' },
          }),
        ),
      'conta-indisponivel',
    ],
  ])('★ %s ⇒ 503 CONTA_INDISPONIVEL, zero fetch', async (_titulo, armar, motivoNaLinha) => {
    const c = cenario();
    armar(c);
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO.CONTA_INDISPONIVEL,
      motivoNaLinha,
    });
    expect(c.chamadas).toEqual([]);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject(IDS_COMPLETOS);
  });

  it('the switch closing between R3 and the context ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS, zero fetch', async () => {
    const c = cenario();
    let leituras = 0;
    c.ambiente = {
      ...c.ambiente,
      get AMAZON_CHAMADAS() {
        leituras += 1;
        return leituras === 1 ? 'on' : 'off';
      },
    };
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      motivoNaLinha: 'chamadas-desligadas',
    });
    expect(c.chamadas).toEqual([]);
  });

  it('★ the LWA pair missing from the deploy ⇒ ConfigAmazonAusenteError PROPAGATES (a 500), after ONE ERROR line, ZERO Amazon calls', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_LWA_CLIENT_ID: undefined };
    await expect(c.rodar()).rejects.toBeInstanceOf(ConfigAmazonAusenteError);
    esperarLinhaDeFalha(c, 'ConfigAmazonAusenteError', IDS_COMPLETOS);
    expect(c.chamadas).toEqual([]);
  });
});

describe('R9 — a plan that writes nothing', () => {
  it.each<[string, string, string | undefined, string]>([
    ['dry-run', 'dry-run', '*', 'valvula'],
    ['on with no canary', 'on', undefined, 'sem-canario'],
    ['on outside the canary', 'on', `${CONTA}:000-0000000-0000000`, 'fora-do-canario'],
  ])(
    '★ (mutation 2) %s ⇒ ONE getOrder, ZERO POSTs, 503 DESLIGADA: no label without the bulk, and the engine’s diff line',
    async (_titulo, modo, canario, motivoNaLinha) => {
      const c = cenario();
      c.ambiente = {
        ...c.ambiente,
        AMAZON_MODO_AGENDAMENTO: modo,
        AMAZON_CANARIO_AGENDAMENTO: canario,
      };
      esperarResposta(c, await c.rodar(), {
        status: 503,
        code: CODIGO.DESLIGADA,
        motivoNaLinha,
      });
      expect(c.chamadas).toEqual([GET_ORDER]);
      expect(linhasDaRota(c)[0]?.meta).toMatchObject({ acao: 'agendar' });
      const diff = c.log.linhas.filter(
        (l) => l.meta?.evento === 'agendamento' && l.meta.rota === undefined,
      );
      expect(diff).toHaveLength(1);
      expect(diff[0]?.meta).toMatchObject({
        acao: 'agendar',
        escreveria: true,
        modoExecucao: 'impressao',
        motivoDryRun: motivoNaLinha,
      });
    },
  );

  it('NEAR-MISS: the order IN the canary list prints', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_AGENDAMENTO: `${CONTA}:${ORDER}` };
    esperarEtiqueta(c, await c.rodar());
  });

  it('★ (mutation 1) a caller without frete.write on a first schedule ⇒ 403, zero POSTs (NEAR-MISS: with it, the label)', async () => {
    const semPermissao = cenario();
    semPermissao.podeAgendar = false;
    esperarResposta(semPermissao, await semPermissao.rodar(), {
      status: 403,
      code: CODIGO.SEM_PERMISSAO,
    });
    expect(semPermissao.chamadas).toEqual([GET_ORDER]);
    expect(linhasDaRota(semPermissao)[0]?.meta).toMatchObject({ acao: 'agendar' });

    const comPermissao = cenario();
    esperarEtiqueta(comPermissao, await comPermissao.rodar());
    expect(posts(comPermissao)).toEqual([POST_MINT, POST_BULK]);
  });

  it('★ a caller without frete.write on an EXISTING schedule ⇒ the label: two POSTs and one document GET', async () => {
    const c = cenario({ getOrder: [JA_AGENDADO] });
    c.podeAgendar = false;
    esperarEtiqueta(c, await c.rodar());
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
  });

  it.each<[string, () => Roteiro, string]>([
    [
      'PROCESSING',
      () => ordem('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }),
      'nfe-em-processamento',
    ],
    [
      'an absent status',
      () => ordem('PENDING_SCHEDULE', { invoiceStatus: null }),
      'nfe-em-processamento',
    ],
    [
      'an unknown status',
      () => ordem('PENDING_SCHEDULE', { invoiceStatus: 'NOVO_STATUS' }),
      'nfe-em-processamento',
    ],
    [
      'ERRORED',
      () => ordem('PENDING_SCHEDULE', { invoiceStatus: 'ERRORED' }),
      'nfe-recusada-pela-amazon',
    ],
    [
      'NOT_FOUND',
      () => ordem('PENDING_SCHEDULE', { invoiceStatus: 'NOT_FOUND' }),
      'nfe-nao-enviada',
    ],
  ])(
    '★ (mutation 22) %s ⇒ 409 AGUARDANDO_NFE with its motivo, zero POSTs',
    async (_titulo, order, motivo) => {
      const c = cenario({ getOrder: [order()] });
      const r = await c.rodar();
      esperarResposta(c, r, { status: 409, code: CODIGO.AGUARDANDO_NFE, motivo });
      expect(posts(c)).toEqual([]);
      if (r.tipo !== 'erro') throw new Error('esperava erro');
      // Only a note still processing may ask the operator to reprint.
      if (motivo === 'nfe-em-processamento') expect(r.corpo.error).toMatch(/Reimprima/);
      else expect(r.corpo.error).not.toMatch(/imprima|aguarde/i);
    },
  );

  it('★ PENDING_SCHEDULE + NOT_REQUIRED ⇒ 409 nf-nao-requerida, zero POSTs, even with frete.write', async () => {
    const c = cenario({ getOrder: [ordem('PENDING_SCHEDULE', { invoiceStatus: 'NOT_REQUIRED' })] });
    expect(c.podeAgendar).toBe(true);
    esperarResposta(c, await c.rodar(), {
      status: 409,
      code: CODIGO.NAO_ELEGIVEL,
      motivo: 'nf-nao-requerida',
    });
    expect(posts(c)).toEqual([]);
  });

  it.each<[string, () => Roteiro, string]>([
    [
      'a foreign marketplace',
      () =>
        ordem('PENDING_SCHEDULE', { extra: { salesChannel: { marketplaceId: 'OUTRO-MERCADO' } } }),
      'marketplace-estrangeiro',
    ],
    ['CANCELLED', () => ordem('PENDING_SCHEDULE', { status: 'CANCELLED' }), 'pedido-cancelado'],
    ['PENDING', () => ordem('PENDING_SCHEDULE', { status: 'PENDING' }), 'pedido-pendente'],
    [
      'an open cancellation request',
      () =>
        ordem('PENDING_SCHEDULE', {
          linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true })],
        }),
      'cancelamento-solicitado',
    ],
    ['not Delivery by Amazon', () => ordem('PENDING_SCHEDULE', { programs: ['PRIME'] }), 'nao-dba'],
    ['SHIPPED', () => ordem('PENDING_SCHEDULE', { status: 'SHIPPED' }), 'ja-enviado'],
    [
      'UNFULFILLABLE',
      () => ordem('PENDING_SCHEDULE', { status: 'UNFULFILLABLE' }),
      'status-pedido-inesperado',
    ],
    ['an unknown package token', () => ordem('NEW_TOKEN'), 'pacote-desconhecido'],
    ['LABEL_CANCELLED', () => ordem('LABEL_CANCELLED'), 'coleta-cancelada'],
    [
      'a package whose goods are out',
      () => ({
        status: 200,
        corpo: {
          order: JSON.parse(
            JSON.stringify(
              pedidoAmazon({
                status: 'UNSHIPPED',
                programs: ['DELIVERY_BY_AMAZON'],
                invoiceStatus: 'ACCEPTED',
                pacotesBrutos: [pacoteAmazon(SENTINELA.refPacote, 'PICKED_UP')],
              }),
            ),
          ) as unknown,
        },
      }),
      'ja-enviado',
    ],
  ])(
    '★ the live order: %s ⇒ 409 NAO_ELEGIVEL with its motivo, zero POSTs',
    async (_titulo, order, motivo) => {
      const c = cenario({ getOrder: [order()] });
      esperarResposta(c, await c.rodar(), { status: 409, code: CODIGO.NAO_ELEGIVEL, motivo });
      expect(c.chamadas).toEqual([GET_ORDER]);
      expect(linhasDaRota(c)[0]?.meta).toMatchObject({ acao: 'recusar' });
    },
  );

  it('★ (mutation 16) an agendar order with two aprovada sale notes ⇒ 409 nfe-ambigua, zero POSTs (NEAR-MISS: a ja-agendado order with the same notes prints)', async () => {
    const agendar = cenario();
    agendar.fake.seed(`${CAMINHO}/nfev4/s1`, NFE_APROVADA);
    agendar.fake.seed(`${CAMINHO}/nfev4/s2`, NFE_APROVADA);
    esperarResposta(agendar, await agendar.rodar(), {
      status: 409,
      code: CODIGO.NAO_ELEGIVEL,
      motivo: 'nfe-ambigua',
    });
    expect(posts(agendar)).toEqual([]);

    const reimpressao = cenario({ getOrder: [JA_AGENDADO] });
    reimpressao.fake.seed(`${CAMINHO}/nfev4/s1`, NFE_APROVADA);
    reimpressao.fake.seed(`${CAMINHO}/nfev4/s2`, NFE_APROVADA);
    esperarEtiqueta(reimpressao, await reimpressao.rodar());
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'one aprovada + one cancelled',
      { s1: NFE_APROVADA, s0: NFE_VENDA_CANCELADA },
      'nfe-substituta',
    ],
    ['only a cancelled sale note', { s0: NFE_VENDA_CANCELADA }, 'nfe-cancelada'],
  ])(
    '★ the NF-e gate, %s ⇒ 409 with its motivo, zero POSTs, with and without frete.write: no permission would unblock it',
    async (_titulo, notas, motivo) => {
      for (const podeAgendar of [true, false]) {
        const c = cenario();
        c.podeAgendar = podeAgendar;
        for (const [id, nota] of Object.entries(notas)) {
          c.fake.seed(`${CAMINHO}/nfev4/${id}`, nota as Record<string, unknown>);
        }
        esperarResposta(c, await c.rodar(), { status: 409, code: CODIGO.NAO_ELEGIVEL, motivo });
        expect(posts(c)).toEqual([]);
      }
    },
  );
});

describe('R9 — a stale read answers wait-and-reprint on EVERY action, never writing', () => {
  const FLOOR = { lastMarketplaceUpdate: ATUALIZADO_US + 1 };

  it.each<[string, () => Roteiro, string]>([
    ['agendar', () => ordem(), 'agendar'],
    ['ja-agendado', () => JA_AGENDADO, 'ja-agendado'],
    [
      'aceite-pendente',
      () => ordem('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }),
      'aceite-pendente',
    ],
    ['a refusal', () => ordem('PENDING_SCHEDULE', { status: 'CANCELLED' }), 'recusar'],
  ])('★ (mutation 21) %s ⇒ 503 AMAZON_INDISPONIVEL, ZERO POSTs', async (_titulo, order, acao) => {
    const c = cenario({ getOrder: [order()] }, pedidoRaw(FLOOR));
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO.AMAZON_INDISPONIVEL,
      motivoNaLinha: 'leitura-defasada',
    });
    expect(c.chamadas).toEqual([GET_ORDER]);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ acao });
  });

  it('★ a stored mirror at despachoNegado (LABEL_CANCELLED) plus an older getOrder reading PENDING_PICK_UP ⇒ 503, ZERO POSTs', async () => {
    const c = cenario(
      { getOrder: [JA_AGENDADO] },
      pedidoRaw(FLOOR, { estado: ESTADO_FRETE.despachoNegado }),
    );
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO.AMAZON_INDISPONIVEL,
      motivoNaLinha: 'leitura-defasada',
    });
    expect(posts(c)).toEqual([]);
  });

  it('NEAR-MISS: a read EQUAL to the stored floor is not stale: it prints', async () => {
    const c = cenario({}, pedidoRaw({ lastMarketplaceUpdate: ATUALIZADO_US }));
    esperarEtiqueta(c, await c.rodar());
  });

  it('a dry-run over a stale read stays DESLIGADA: the valve is the reason no label exists', async () => {
    const c = cenario({ getOrder: [ordem()] }, pedidoRaw(FLOOR));
    c.ambiente = { ...c.ambiente, AMAZON_MODO_AGENDAMENTO: 'dry-run' };
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO.DESLIGADA,
      motivoNaLinha: 'valvula',
    });
    expect(posts(c)).toEqual([]);
  });
});

describe('R9 — a failure with nothing sent, by the shared ladder’s token', () => {
  /** A real order read that fails: scripted on the wire. */
  it.each<
    [
      string,
      Partial<Record<Rota, Roteiro[]>>,
      Esperado,
      { credencial?: boolean; lwa?: boolean; codigos?: string },
    ]
  >([
    [
      'a getOrder 429 (pausa)',
      { getOrder: [erro(429, 'QuotaExceeded')] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'pausa' },
      { codigos: 'QuotaExceeded' },
    ],
    [
      'a getOrder 500 (transitorio)',
      { getOrder: [erro(500, 'InternalFailure')] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
      { codigos: 'InternalFailure' },
    ],
    [
      'a dropped connection (transitorio)',
      { getOrder: [{ rede: true }] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
      {},
    ],
    [
      'a getOrder 404 (nao-encontrado)',
      { getOrder: [erro(404, 'NotFound')] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'nao-encontrado' },
      { codigos: 'NotFound' },
    ],
    [
      'a getOrder 400 (http-definitivo)',
      { getOrder: [erro(400, 'InvalidInput')] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'http-definitivo' },
      { codigos: 'InvalidInput' },
    ],
    [
      'a getOrder 2xx off its schema (esquema)',
      { getOrder: [{ status: 200, corpo: { order: 'x' } }] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'esquema' },
      {},
    ],
    [
      'a getOrder answering ANOTHER order (ilegivel)',
      { getOrder: [ordem('PENDING_SCHEDULE', { extra: { orderId: '171-0000000-0000001' } })] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'ilegivel' },
      {},
    ],
    [
      'a getOrder 403 after the forced refresh (auth-sp-api)',
      { getOrder: [erro(403, 'Unauthorized')] },
      { status: 503, code: CODIGO.CONTA_INDISPONIVEL, motivoNaLinha: 'auth-sp-api' },
      { credencial: true, lwa: true, codigos: 'Unauthorized' },
    ],
  ])(
    '★ (mutation 14) %s ⇒ its answer, zero POSTs, NEVER RECUSADA',
    async (_titulo, rotas, esperado, o) => {
      const c = cenario(rotas);
      if (o.credencial === true) c.escritasPermitidas.add(caminhoCredencial(CONTA));
      esperarResposta(c, await c.rodar(), esperado);
      expect(posts(c)).toEqual([]);
      if (o.lwa === true) expect(c.chamadas).toContain(LWA);
      // The forced refresh persists the renewed token: the context's 3-key patch only.
      if (o.credencial === true) esperarSoOPatchDaCredencial(c);
      // A read-side line carries the HTTP codes, and no decision: no plan was made.
      expect(linhasDaRota(c)[0]?.meta).toMatchObject({
        codigos: o.codigos ?? null,
        acao: null,
        pedido: ORDER,
        conta: CONTA,
      });
    },
  );

  it('★ a stale LWA token whose refresh Amazon refuses (auth-lwa) ⇒ 503 CONTA_INDISPONIVEL, no SP-API request at all', async () => {
    const c = cenario({ lwa: [{ status: 400 }] });
    seedCredencial(c.fake, CONTA, { expirationDate: AGORA_MS });
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO.CONTA_INDISPONIVEL,
      motivoNaLinha: 'auth-lwa',
    });
    expect(c.chamadas).toEqual([LWA]);
  });

  it('★ a credential parked between the context and getOrder (conta-indisponivel) ⇒ 503 CONTA_INDISPONIVEL, zero requests', async () => {
    const c = cenario();
    h.depoisDoContexto = () =>
      c.fake.seed(
        caminhoCredencial(CONTA),
        credencialDoc({
          reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: 'r' },
        }),
      );
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO.CONTA_INDISPONIVEL,
      motivoNaLinha: 'conta-indisponivel',
    });
    expect(c.chamadas).toEqual([]);
  });

  it.each<[string, () => unknown, Esperado]>([
    [
      'a read older than its floor on a queue attempt (transitorio)',
      () => new AmazonLeituraDefasadaError(CONTA, ORDER),
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
    ],
    [
      'an inactive conta (conta-inativa)',
      () => new ContaAmazonInativaError(CONTA),
      { status: 503, code: CODIGO.CONTA_INDISPONIVEL, motivoNaLinha: 'conta-inativa' },
    ],
    [
      'the read switch (chamadas-desligadas)',
      () => new ChamadasAmazonDesligadasError(CONTA),
      {
        status: 503,
        code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
        motivoNaLinha: 'chamadas-desligadas',
      },
    ],
  ])('★ %s, through the run ⇒ its answer, zero requests', async (_titulo, falha, esperado) => {
    const c = cenario();
    h.falhaLeitura = falha();
    esperarResposta(c, await c.rodar(), esperado);
    expect(c.chamadas).toEqual([]);
  });

  it('★ relancar (an AmazonConfigError: a bug) ⇒ thrown SANITIZED, after ONE ERROR line with its class', async () => {
    const c = cenario();
    h.falhaLeitura = new AmazonConfigError('pedido', {
      operacao: 'getOrder',
      refCredencial: 'ref-sentinela',
    });
    const err: unknown = await c.rodar().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FalhaTarefaAmazonError);
    expect(err).toMatchObject({ classe: 'AmazonConfigError', detalhe: 'pedido' });
    expect(JSON.stringify(err)).not.toContain('ref-sentinela');
    esperarLinhaDeFalha(c, 'AmazonConfigError', IDS_COMPLETOS);
  });
});

describe('R10 — an agendar print, by the outcome’s token', () => {
  it.each<
    [
      string,
      Partial<Record<Rota, Roteiro[]>>,
      Esperado,
      {
        posts?: readonly string[];
        credencial?: boolean;
        codigoRejeicao?: string;
        codigos?: string;
      },
    ]
  >([
    // ---- indisponivel ----
    [
      'scheduled with no URL',
      { bulk: [BULK_SEM_URL] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'agendado' },
      {},
    ],
    [
      'ScheduledPackageAlreadyExists per order with no URL',
      { bulk: [rejeitado('ScheduledPackageAlreadyExists', false)] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'ja-agendado' },
      { codigoRejeicao: 'ScheduledPackageAlreadyExists' },
    ],
    [
      'sem-pedido (an answer naming neither list)',
      { bulk: [semPedido(false)] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'sem-pedido' },
      {},
    ],
    [
      'sem-pedido WITH a URL: on a first schedule the URL decides nothing',
      { bulk: [semPedido(true)] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'sem-pedido' },
      {},
    ],
    [
      'a bulk 2xx off its schema',
      { bulk: [{ status: 200, corpo: { scheduledPackages: 'x' } }] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'esquema' },
      {},
    ],
    [
      'a thrown 400 ScheduledPackageAlreadyExists (a top-level list carries no URL)',
      { bulk: [erro(400, 'ScheduledPackageAlreadyExists')] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'http-definitivo' },
      { codigos: 'ScheduledPackageAlreadyExists' },
    ],
    [
      'the token MINT refused (400): nothing in the order was refused',
      { mint: [erro(400, 'InvalidInput')] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'http-definitivo' },
      { posts: [POST_MINT] },
    ],
    [
      'the token MINT 2xx off its schema: no bulk was sent',
      { mint: [{ status: 200, corpo: { expiresIn: 'x' } }] },
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'esquema' },
      { posts: [POST_MINT] },
    ],
    // ---- recusada ----
    [
      'MissingPackageDimensions per order',
      { bulk: [rejeitado('MissingPackageDimensions', true)] },
      {
        status: 409,
        code: CODIGO.RECUSADA,
        motivo: 'dimensoes-ausentes',
      },
      { codigoRejeicao: 'MissingPackageDimensions' },
    ],
    [
      'a top-level 400 MissingPackageDimensions',
      { bulk: [erro(400, 'MissingPackageDimensions')] },
      { status: 409, code: CODIGO.RECUSADA, motivo: 'dimensoes-ausentes' },
      {},
    ],
    [
      'any other per-order code, its URL ignored',
      { bulk: [rejeitado('InvalidOrderState', true)] },
      { status: 409, code: CODIGO.RECUSADA, motivo: 'agendamento-recusado' },
      { codigoRejeicao: 'InvalidOrderState' },
    ],
    [
      'TimeSlotNotAvailable per order',
      { bulk: [rejeitado('TimeSlotNotAvailable', false)] },
      { status: 409, code: CODIGO.RECUSADA, motivo: 'agendamento-recusado' },
      { codigoRejeicao: 'TimeSlotNotAvailable' },
    ],
    [
      'a rejection with no error object',
      { bulk: [rejeitado(null, false)] },
      { status: 409, code: CODIGO.RECUSADA, motivo: 'agendamento-recusado' },
      {},
    ],
    [
      'a bulk 404 (NEAR-MISS of the getOrder 404, which is a 502)',
      { bulk: [erro(404, 'InvalidOrderState')] },
      { status: 409, code: CODIGO.RECUSADA, motivo: 'agendamento-recusado' },
      { codigos: 'InvalidOrderState' },
    ],
    [
      'a bulk 400 with an open code',
      { bulk: [erro(400, 'InvalidInput')] },
      { status: 409, code: CODIGO.RECUSADA, motivo: 'agendamento-recusado' },
      {},
    ],
    // ---- amazon-indisponivel ----
    [
      'a per-order InternalServerError, its URL ignored',
      { bulk: [rejeitado('InternalServerError', true)] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
      { codigoRejeicao: 'InternalServerError' },
    ],
    [
      'a per-order ScheduleWindowExpired',
      { bulk: [rejeitado('ScheduleWindowExpired', false)] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
      { codigoRejeicao: 'ScheduleWindowExpired' },
    ],
    [
      'a per-order RetryableAfterGettingNewSlots',
      { bulk: [rejeitado('RetryableAfterGettingNewSlots', false)] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
      { codigoRejeicao: 'RetryableAfterGettingNewSlots' },
    ],
    [
      'a top-level 400 RetryableAfterGettingNewSlots',
      { bulk: [erro(400, 'RetryableAfterGettingNewSlots')] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'http-definitivo' },
      {},
    ],
    [
      'a bulk 500, sent ONCE',
      { bulk: [erro(500, 'InternalFailure')] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
      {},
    ],
    [
      'a bulk 429',
      { bulk: [erro(429, 'QuotaExceeded')] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'pausa' },
      {},
    ],
    [
      'a bulk whose connection drops, sent ONCE',
      { bulk: [{ rede: true }] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
      {},
    ],
    [
      'the token MINT 500',
      { mint: [erro(500, 'InternalFailure')] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
      { posts: [POST_MINT] },
    ],
    [
      'the token MINT 429',
      { mint: [erro(429, 'QuotaExceeded')] },
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'pausa' },
      { posts: [POST_MINT] },
    ],
    // ---- conta-indisponivel ----
    [
      'a second 401/403 on the bulk (the refresh spent)',
      { bulk: [erro(403, 'Unauthorized')] },
      { status: 503, code: CODIGO.CONTA_INDISPONIVEL, motivoNaLinha: 'auth-sp-api' },
      { posts: [POST_MINT, POST_BULK, POST_MINT, POST_BULK], credencial: true },
    ],
    [
      'a second 401/403 on the mint',
      { mint: [erro(403, 'Unauthorized')] },
      { status: 503, code: CODIGO.CONTA_INDISPONIVEL, motivoNaLinha: 'auth-sp-api' },
      { posts: [POST_MINT, POST_MINT], credencial: true },
    ],
    [
      'an LWA exchange refused at the forced refresh after a bulk 403',
      { bulk: [erro(403, 'Unauthorized')], lwa: [{ status: 400 }] },
      { status: 503, code: CODIGO.CONTA_INDISPONIVEL, motivoNaLinha: 'auth-lwa' },
      {},
    ],
  ])('★ (mutations 12, 15) %s', async (_titulo, rotas, esperado, o) => {
    const c = cenario(rotas);
    if (o.credencial === true) c.escritasPermitidas.add(caminhoCredencial(CONTA));
    esperarResposta(c, await c.rodar(), esperado);
    // ★ (mutation 12) Never a second bulk beyond the forced refresh's one repeat after a
    // 401/403, and never a download.
    expect(posts(c)).toEqual(o.posts ?? [POST_MINT, POST_BULK]);
    // The forced refresh persists the renewed token: the context's 3-key patch only.
    if (o.credencial === true) esperarSoOPatchDaCredencial(c);
    expect(c.chamadas).not.toContain(GET_DOCUMENTO);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({
      acao: 'agendar',
      pedido: ORDER,
      pedidoId: PEDIDO_ID,
      conta: CONTA,
      codigoRejeicao: o.codigoRejeicao ?? null,
    });
    if (o.codigos !== undefined) {
      expect(linhasDaRota(c)[0]?.meta).toMatchObject({ codigos: o.codigos });
    }
  });

  it('★ a credential parked at the WRITE client’s getter (conta-indisponivel) ⇒ 503 CONTA_INDISPONIVEL, zero POSTs', async () => {
    const c = cenario();
    c.depoisDoGetOrder = () =>
      c.fake.seed(
        caminhoCredencial(CONTA),
        credencialDoc({
          reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: 'r' },
        }),
      );
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO.CONTA_INDISPONIVEL,
      motivoNaLinha: 'conta-indisponivel',
    });
    expect(posts(c)).toEqual([]);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ acao: 'agendar' });
  });

  it('★ the read switch answered by the write side (chamadas-desligadas) ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS', async () => {
    const c = cenario();
    h.falhaBulk = new ChamadasAmazonDesligadasError(CONTA);
    esperarResposta(c, await c.rodar(), {
      status: 503,
      code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      motivoNaLinha: 'chamadas-desligadas',
    });
  });

  it('★ relancar on the write side (an AmazonConfigError refused before sending) ⇒ thrown SANITIZED, after ONE ERROR line', async () => {
    const c = cenario();
    h.falhaBulk = new AmazonConfigError('pedido', {
      operacao: 'createScheduledPackageBulk',
      refCredencial: 'ref-sentinela',
    });
    const err: unknown = await c.rodar().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FalhaTarefaAmazonError);
    expect(err).toMatchObject({ classe: 'AmazonConfigError', detalhe: 'pedido' });
    esperarLinhaDeFalha(c, 'AmazonConfigError', IDS_COMPLETOS);
  });

  it.each<[string, Roteiro, string | null]>([
    ['scheduled with a URL', BULK_OK, null],
    [
      'ScheduledPackageAlreadyExists with a URL',
      rejeitado('ScheduledPackageAlreadyExists', true),
      'ScheduledPackageAlreadyExists',
    ],
  ])('★ baixar: %s ⇒ the label, the code in its line', async (_titulo, bulk, codigoRejeicao) => {
    const c = cenario({ bulk: [bulk] });
    esperarEtiqueta(c, await c.rodar());
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ codigoRejeicao, acao: 'agendar' });
  });

  it('★ the line’s HTTP codes go through the closed set: an unknown one is <outro>, never echoed', async () => {
    const fora = 'CodigoForaDoConjuntoQualquer';
    const c = cenario({ bulk: [erro(400, fora)] });
    await c.rodar();
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ codigos: '<outro>' });
    expect(texto(linhasDaRota(c)[0] as LinhaDeLog)).not.toContain(fora);
  });

  it('★ the line’s rejection code goes through its grammar: a value outside it is <outro>, never echoed', async () => {
    const fora = 'codigo com espacos e 12345678';
    const c = cenario({ bulk: [rejeitado(fora, false)] });
    await c.rodar();
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ codigoRejeicao: '<outro>' });
    expect(texto(linhasDaRota(c)[0] as LinhaDeLog)).not.toContain(fora);
  });
});

describe('R10 — a print over an EXISTING schedule: the pickup exists, so it is never RECUSADA', () => {
  it.each<[string, Roteiro]>([
    ['scheduled with a URL', BULK_OK],
    ['ScheduledPackageAlreadyExists with a URL', rejeitado('ScheduledPackageAlreadyExists', true)],
    [
      'OrderNotEligibleForRescheduling with a URL',
      rejeitado('OrderNotEligibleForRescheduling', true),
    ],
    ['MissingPackageDimensions per order with a URL', rejeitado('MissingPackageDimensions', true)],
    ['a rejection with no error object, with a URL', rejeitado(null, true)],
    ['sem-pedido with a URL (the URL decides)', semPedido(true)],
  ])('★ (mutation 23) %s ⇒ the label', async (_titulo, bulk) => {
    const c = cenario({ getOrder: [JA_AGENDADO], bulk: [bulk] });
    esperarEtiqueta(c, await c.rodar());
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ acao: 'ja-agendado' });
  });

  it.each<[string, Roteiro, Esperado]>([
    [
      'OrderNotEligibleForRescheduling with no URL',
      rejeitado('OrderNotEligibleForRescheduling', false),
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'recusado' },
    ],
    [
      'sem-pedido with no URL',
      semPedido(false),
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'sem-pedido' },
    ],
    [
      'a thrown InvalidOrderState 404',
      erro(404, 'InvalidOrderState'),
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'nao-encontrado' },
    ],
    [
      'a top-level 400 MissingPackageDimensions',
      erro(400, 'MissingPackageDimensions'),
      { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: 'http-definitivo' },
    ],
    [
      'a per-order InternalServerError, its URL ignored',
      rejeitado('InternalServerError', true),
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
    ],
    [
      'a top-level 400 ScheduleWindowExpired',
      erro(400, 'ScheduleWindowExpired'),
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'http-definitivo' },
    ],
    [
      'a bulk 500',
      erro(500, 'InternalFailure'),
      { status: 503, code: CODIGO.AMAZON_INDISPONIVEL, motivoNaLinha: 'transitorio' },
    ],
  ])('★ (mutation 23) %s ⇒ its answer, no download', async (_titulo, bulk, esperado) => {
    const c = cenario({ getOrder: [JA_AGENDADO], bulk: [bulk] });
    esperarResposta(c, await c.rodar(), esperado);
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK]);
    expect(linhasDaRota(c)[0]?.meta).toMatchObject({ acao: 'ja-agendado' });
  });

  it('★ NEAR-MISS of mutation 23: the same rejection on an agendar print IS RECUSADA', async () => {
    const c = cenario({ bulk: [rejeitado('OrderNotEligibleForRescheduling', true)] });
    esperarResposta(c, await c.rodar(), {
      status: 409,
      code: CODIGO.RECUSADA,
      motivo: 'agendamento-recusado',
    });
    expect(c.chamadas).not.toContain(GET_DOCUMENTO);
  });
});

describe('R11, R12 — the download and the extraction', () => {
  const DOIS_ZPL = zipDeTeste({ 'a.zpl': ZPL, 'b.ZPL2': ZPL });
  const PDF = bytesDe('%PDF-1.7 sentinela do pdf');
  const SO_PDF = zipDeTeste({ 'label.pdf': PDF });
  const ENTRADAS_DEMAIS = zipDeTeste(
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${String(i)}.txt`, PDF])),
  );
  const ZPL_GRANDE = zipDeTeste({ 'a.zpl': new Uint8Array(1024 * 1024 + 1) });

  it.each<[string, Partial<Record<Rota, Roteiro[]>>, string, number | null]>([
    [
      'the model’s example URL, refused before any request',
      {
        bulk: [
          {
            status: 200,
            corpo: {
              scheduledPackages: [pacoteDoBulk],
              printableDocumentsUrl: 'https://www.amazon.com/documents.zip',
            },
          },
        ],
      },
      'url-invalida',
      null,
    ],
    ['an expired link (403)', { documento: [{ status: 403 }] }, 'expirado', null],
    ['any other status (500)', { documento: [{ status: 500 }] }, 'http', null],
    ['a dropped connection', { documento: [{ rede: true }] }, 'rede', null],
    ['an XML error page', { documento: [{ bytes: bytesDe('<Error/>') }] }, 'nao-zip', null],
    [
      'past the 5-MiB bound',
      { documento: [{ bytes: new Uint8Array(5 * 1024 * 1024 + 1) }] },
      'grande-demais',
      null,
    ],
    [
      '★ (mutation 5) a zip with only a PDF',
      { documento: [{ bytes: SO_PDF }] },
      'sem-zpl',
      SO_PDF.byteLength,
    ],
    ['two ZPL entries', { documento: [{ bytes: DOIS_ZPL }] }, 'zpl-multiplo', DOIS_ZPL.byteLength],
    [
      'more entries than a label zip may hold',
      { documento: [{ bytes: ENTRADAS_DEMAIS }] },
      'entradas-demais',
      ENTRADAS_DEMAIS.byteLength,
    ],
    [
      'a ZPL entry past its 1-MiB bound',
      { documento: [{ bytes: ZPL_GRANDE }] },
      'zpl-grande-demais',
      ZPL_GRANDE.byteLength,
    ],
    [
      'a ZPL entry that fails its CRC',
      { documento: [{ bytes: corromper(ZIP_OK, ZPL) }] },
      'zip-invalido',
      ZIP_OK.byteLength,
    ],
    [
      'a ZPL entry holding a PDF',
      { documento: [{ bytes: zipDeTeste({ 'a.zpl': bytesDe('%PDF-1.7 ^XA') }) }] },
      'zpl-invalido',
      zipDeTeste({ 'a.zpl': bytesDe('%PDF-1.7 ^XA') }).byteLength,
    ],
  ])(
    '★ %s ⇒ 502 INDISPONIVEL, the motivo in the log ONLY',
    async (_titulo, rotas, motivo, bytesZip) => {
      const c = cenario(rotas);
      const r = await c.rodar();
      esperarResposta(c, r, { status: 502, code: CODIGO.INDISPONIVEL, motivoNaLinha: motivo });
      expect(linhasDaRota(c)[0]?.meta).toMatchObject({ bytesZip, bytesZpl: null });
      // ★ (mutation 5) Neither the zip nor a PDF reaches an answer, whole or in part.
      expect(JSON.stringify(r)).not.toContain('sentinela do pdf');
      expect(JSON.stringify(r)).not.toContain('PDF-');
      // One bulk per request, whatever the document did (mutation 12).
      expect(posts(c)).toEqual([POST_MINT, POST_BULK]);
      // Every row sent the document request but the link refused before any request.
      expect(c.chamadas).toEqual(
        motivo === 'url-invalida'
          ? [GET_ORDER, POST_MINT, POST_BULK]
          : [GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO],
      );
    },
  );

  it('★ a download that never answers is cut by its 20-s deadline, still pending at 19 s ⇒ 502 INDISPONIVEL, motivo prazo in the log ONLY', async () => {
    const c = cenario({ documento: [{ nunca: true }] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let terminou = false;
      const pendente = c.rodar().finally(() => {
        terminou = true;
      });
      await vi.waitFor(() => {
        expect(c.chamadas).toContain(GET_DOCUMENTO);
      });
      // `waitFor` may itself advance the fake clock a little: a 1-s margin, never the boundary.
      await vi.advanceTimersByTimeAsync(19_000);
      expect(terminou).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      esperarResposta(c, await pendente, {
        status: 502,
        code: CODIGO.INDISPONIVEL,
        motivoNaLinha: 'prazo',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(posts(c)).toEqual([POST_MINT, POST_BULK]);
  });

  it('a failure the download does not name (not its class) propagates untouched (rule 6)', async () => {
    const c = cenario();
    const bug = new RangeError('defeito');
    const real = c.fetch;
    const r = imprimirEtiquetaAmazon(requisicao({ pedidoId: PEDIDO_ID }), {
      ambiente: c.ambiente,
      db: c.lerDb,
      logger: c.log.logger,
      podeAgendar: true,
      agora: () => AGORA_MS,
      fetch: (input, init) => {
        if (new URL(String(input)).hostname.endsWith('.amazonaws.com')) return Promise.reject(bug);
        return real(input, init);
      },
    });
    await expect(r).rejects.toBe(bug);
    expect(linhasDaRota(c)).toEqual([]);
  });
});

describe('R13 — the answer', () => {
  it('★ (mutations 13, 20) ONE scripted fetch sees getOrder, the mint, the bulk and the document, in that order, with no Firestore read between the bulk and the download', async () => {
    const c = cenario();
    esperarEtiqueta(c, await c.rodar());
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
    expect(c.operacoesEm.bulk).not.toBeNull();
    expect(c.operacoesEm.documento).toBe(c.operacoesEm.bulk);
  });

  it('★ (mutation 13) with the clock frozen (timeouts faked, never advanced), the print still reaches the download and answers: no timer gates any step', async () => {
    const c = cenario();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const estado = { terminou: false };
      const pendente = c.rodar().finally(() => {
        estado.terminou = true;
      });
      // `setImmediate` is not faked: each turn lets every queued microtask run.
      for (let volta = 0; volta < 200 && !estado.terminou; volta += 1) {
        await new Promise<void>((pronto) => {
          setImmediate(pronto);
        });
      }
      expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
      expect(estado.terminou).toBe(true);
      esperarEtiqueta(c, await pendente);
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ (mutation 20) with no fetch injected, the default is resolved ONCE, at the top: a global swapped mid-request reaches neither the context’s later calls nor the download', async () => {
    const c = cenario();
    const trocado: string[] = [];
    vi.stubGlobal('fetch', c.fetch);
    // Right after getOrder is answered, the global is no longer the one the print started with.
    c.depoisDoGetOrder = () => {
      vi.stubGlobal('fetch', (input: unknown) => {
        trocado.push(String(input));
        return Promise.reject(new Error('teste: o fetch global trocado nunca deve ser chamado'));
      });
    };
    const r = await imprimirEtiquetaAmazon(requisicao({ pedidoId: PEDIDO_ID }), {
      ambiente: c.ambiente,
      db: c.lerDb,
      logger: c.log.logger,
      podeAgendar: true,
      agora: () => AGORA_MS,
      gerarCorrelationId: () => 'corr-etiqueta-teste',
    });
    c.respostas.push(r);
    esperarEtiqueta(c, r);
    expect(c.chamadas).toEqual([GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
    expect(trocado).toEqual([]);
  });

  it('★ the document request carries NO header at all, refuses a redirect, and is a GET', async () => {
    const c = cenario();
    await c.rodar();
    expect(c.documento.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(c.documento.init).not.toHaveProperty('headers');
  });

  it('★ the file name is built from the order id alone: never the entry’s name', async () => {
    const c = cenario();
    const r = await c.rodar();
    expect(r).toMatchObject({ tipo: 'zpl', nomeArquivo: `amazon-${ORDER}.zpl` });
    expect(JSON.stringify(c.log.linhas)).not.toContain(SENTINELA.entrada);
  });

  it('★ a stored (uncompressed) entry comes back byte for byte, even bytes no UTF-8 round trip keeps', async () => {
    const binario = Uint8Array.from([
      0x5e, 0x58, 0x41, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x5e, 0x58, 0x5a,
    ]);
    const c = cenario({ documento: [{ bytes: zipDeTeste({ 'x.zpl': binario }) }] });
    const r = await c.rodar();
    if (r.tipo !== 'zpl') throw new Error('esperava a etiqueta');
    expect([...r.bytes]).toEqual([...binario]);
  });

  it('★ the 200’s ONE line: exactly the closed campos, and the envelope', async () => {
    const c = cenario();
    await c.rodar();
    expect(linhasDaRota(c)[0]).toEqual({
      nivel: 'info',
      mensagem: '[amazon] etiqueta impresso',
      meta: {
        rota: 'etiqueta',
        resultado: 'impresso',
        motivo: null,
        acao: 'agendar',
        pedidoId: PEDIDO_ID,
        pedido: ORDER,
        bytesZip: ZIP_OK.byteLength,
        bytesZpl: ZPL.byteLength,
        codigoRejeicao: null,
        codigos: null,
        evento: 'agendamento',
        fluxo: 'agendamento',
        conta: CONTA,
      },
    });
  });
});

describe('Rule 7 — the ONE write the request can cause is the context’s own', () => {
  it('★ a FRESH stored token: ZERO Firestore writes on the whole print', async () => {
    const c = cenario();
    esperarEtiqueta(c, await c.rodar());
    expect(c.chamadas).not.toContain(LWA);
    expect(c.fake.escritas).toEqual([]);
  });

  it('★ a stale token: the same ja-agendado print writes EXACTLY the credential’s 3-key patch, and nothing under pedidos/, avisos/ or any freight field', async () => {
    const pedido = pedidoRaw();
    const c = cenario({ getOrder: [JA_AGENDADO] }, pedido);
    seedCredencial(c.fake, CONTA, { expirationDate: AGORA_MS });
    c.escritasPermitidas.add(caminhoCredencial(CONTA));
    esperarEtiqueta(c, await c.rodar());
    expect(c.chamadas).toEqual([LWA, GET_ORDER, POST_MINT, POST_BULK, GET_DOCUMENTO]);
    expect(c.fake.escritas.map((w) => w.caminho)).toEqual([caminhoCredencial(CONTA)]);
    expect(Object.keys(c.fake.escritas[0]?.dados ?? {}).sort()).toEqual([
      'access_token',
      'acessoRef',
      'expirationDate',
    ]);
    expect(c.fake.ler(CAMINHO)).toEqual(pedido);
  });

  it('★ a stale token with a standing amazonSegredoLwaRecusado: the patch, then the resolve — and still no per-pedido row', async () => {
    const c = cenario({ getOrder: [JA_AGENDADO] });
    seedCredencial(c.fake, CONTA, { expirationDate: AGORA_MS });
    await avisarSegredoLwaRecusado(
      asDb(c.fake),
      { codigoLwa: 'invalid_client' },
      { increment, nowMs: AGORA_MS - 1000 },
    );
    const caminhoSegredo = caminhoAviso(chaveSegredoRecusado());
    c.escritasPermitidas.add(caminhoCredencial(CONTA));
    c.escritasPermitidas.add(caminhoSegredo);
    const antes = c.fake.escritas.length;
    esperarEtiqueta(c, await c.rodar());
    expect(c.fake.escritas.slice(antes).map((w) => w.caminho)).toEqual([
      caminhoCredencial(CONTA),
      caminhoSegredo,
    ]);
    expect(c.fake.ler(caminhoSegredo)?.resolucaoMotivo).toBe('troca-aceita');
    expect(c.fake.caminhos().filter((p) => p.startsWith('avisos/'))).toEqual([caminhoSegredo]);
  });

  it('★ a cut bulk may still be running at Amazon: its answer says to WAIT and reprint from the list, never to try again', async () => {
    const c = cenario({ bulk: [{ rede: true }] });
    const r = await c.rodar();
    if (r.tipo !== 'erro') throw new Error('esperava erro');
    expect(r.corpo.error).toMatch(/Aguarde cerca de 1 minuto e reimprima pela lista de pedidos/);
    expect(r.corpo.error).not.toMatch(/tente/i);
  });

  it('★ the 502 and the valve’s 503 send the operator to Seller Central: no label is coming from here', async () => {
    const indisponivel = cenario({ bulk: [BULK_SEM_URL] });
    const r = await indisponivel.rodar();
    if (r.tipo !== 'erro') throw new Error('esperava erro');
    expect(r.corpo.error).toMatch(/Seller Central/);

    const desligada = cenario();
    desligada.ambiente = { ...desligada.ambiente, AMAZON_MODO_AGENDAMENTO: 'dry-run' };
    const d = await desligada.rodar();
    if (d.tipo !== 'erro') throw new Error('esperava erro');
    expect(d.corpo.error).toMatch(/Seller Central/);
  });

  it('★ the RECUSADA sentence: dimensoes-ausentes names its remedy, agendamento-recusado names none', async () => {
    const dimensoes = cenario({ bulk: [rejeitado('MissingPackageDimensions', false)] });
    const r = await dimensoes.rodar();
    if (r.tipo !== 'erro') throw new Error('esperava erro');
    expect(r.corpo.error).toMatch(/dimensões ou peso/);

    const outra = cenario({ bulk: [rejeitado('TimeSlotNotAvailable', false)] });
    const o = await outra.rodar();
    if (o.tipo !== 'erro') throw new Error('esperava erro');
    expect(o.corpo.error).not.toMatch(/dimensões|peso|Seller Central/);
  });

  it('★ a refusal raises no aviso: the scheduling task is the one that raises them', async () => {
    const c = cenario({ bulk: [rejeitado('MissingPackageDimensions', true)] });
    await c.rodar();
    expect(c.fake.caminhos().filter((p) => p.startsWith('avisos/'))).toEqual([]);
    expect(c.fake.escritas).toEqual([]);
  });
});

describe('the sentence of every code, row by row', () => {
  /** A remedy that only a wait cures. */
  const ESPERA = /aguarde|reimprima/i;
  const ESPERA_OU_SELLER = /aguarde|reimprima|Seller Central/i;

  /** [title, code, the print, what the sentence says, what it must never say]. */
  const FRASES: [string, string, () => Promise<ResultadoEtiquetaAmazon>, RegExp, RegExp][] = [
    [
      'CORPO_INVALIDO',
      CODIGO.CORPO_INVALIDO,
      () => cenario().rodar({}),
      /^Corpo inválido: envie apenas \{ pedidoId \}/,
      ESPERA_OU_SELLER,
    ],
    [
      'PEDIDO_NAO_ENCONTRADO',
      CODIGO.PEDIDO_NAO_ENCONTRADO,
      () => {
        const c = cenario();
        c.fake.apagar(CAMINHO);
        return c.rodar();
      },
      /^Pedido não encontrado; nada foi enviado à Amazon\.$/,
      ESPERA_OU_SELLER,
    ],
    [
      'SEM_PERMISSAO',
      CODIGO.SEM_PERMISSAO,
      () => {
        const c = cenario();
        c.podeAgendar = false;
        return c.rodar();
      },
      /agendar exige permissão de escrita de frete/,
      ESPERA_OU_SELLER,
    ],
    [
      'NAO_ELEGIVEL',
      CODIGO.NAO_ELEGIVEL,
      () => cenario({}, pedidoRaw({ estado: ESTADO_PEDIDO.cancelado })).rodar(),
      /^A etiqueta deste pedido não pode ser impressa agora/,
      ESPERA_OU_SELLER,
    ],
    [
      'AGUARDANDO_NFE nfe-em-processamento',
      CODIGO.AGUARDANDO_NFE,
      () =>
        cenario({ getOrder: [ordem('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' })] }).rodar(),
      /ainda está processando a NF-e deste pedido\. Reimprima pela lista de pedidos depois do aceite/,
      /recusou|não recebeu|Seller Central/,
    ],
    [
      'AGUARDANDO_NFE nfe-recusada-pela-amazon',
      CODIGO.AGUARDANDO_NFE,
      () =>
        cenario({ getOrder: [ordem('PENDING_SCHEDULE', { invoiceStatus: 'ERRORED' })] }).rodar(),
      /^A Amazon recusou a NF-e deste pedido\. Veja o aviso de NF-e do pedido/,
      /processando|não recebeu|aguarde|reimprima|Seller Central/i,
    ],
    [
      'AGUARDANDO_NFE nfe-nao-enviada',
      CODIGO.AGUARDANDO_NFE,
      () =>
        cenario({ getOrder: [ordem('PENDING_SCHEDULE', { invoiceStatus: 'NOT_FOUND' })] }).rodar(),
      /^A Amazon não recebeu a NF-e deste pedido\. Veja o aviso de NF-e do pedido/,
      /processando|recusou|aguarde|reimprima|Seller Central/i,
    ],
    [
      'RECUSADA dimensoes-ausentes',
      CODIGO.RECUSADA,
      () => cenario({ bulk: [rejeitado('MissingPackageDimensions', false)] }).rodar(),
      /faltam dimensões ou peso no anúncio deste pedido/,
      ESPERA_OU_SELLER,
    ],
    [
      'RECUSADA agendamento-recusado',
      CODIGO.RECUSADA,
      () => cenario({ bulk: [rejeitado('TimeSlotNotAvailable', false)] }).rodar(),
      /^A Amazon recusou agendar a coleta deste pedido\.$/,
      /dimensões|peso|aguarde|reimprima|Seller Central/i,
    ],
    [
      'INDISPONIVEL',
      CODIGO.INDISPONIVEL,
      () => cenario({ bulk: [BULK_SEM_URL] }).rodar(),
      /não devolveu uma etiqueta utilizável; imprima pelo Seller Central/,
      ESPERA,
    ],
    [
      'AMAZON_INDISPONIVEL',
      CODIGO.AMAZON_INDISPONIVEL,
      () => cenario({ bulk: [{ rede: true }] }).rodar(),
      /Aguarde cerca de 1 minuto e reimprima pela lista de pedidos/,
      /tente|Seller Central/i,
    ],
    [
      // The arm AFTER a bulk was sent (twice, through the forced refresh): its sentence
      // must still hold, so it never claims that nothing reached Amazon.
      'CONTA_INDISPONIVEL after the bulk was sent',
      CODIGO.CONTA_INDISPONIVEL,
      () => {
        const c = cenario({ bulk: [erro(403, 'Unauthorized')] });
        c.escritasPermitidas.add(caminhoCredencial(CONTA));
        return c.rodar();
      },
      /^A conta Amazon deste pedido não pode ser usada agora .*; nenhuma coleta foi agendada por esta impressão\.$/,
      /nada foi enviado|aguarde|reimprima|Seller Central/i,
    ],
    [
      'DESLIGADA',
      CODIGO.DESLIGADA,
      () => {
        const c = cenario();
        c.ambiente = { ...c.ambiente, AMAZON_MODO_AGENDAMENTO: 'dry-run' };
        return c.rodar();
      },
      /impressão de etiquetas da Amazon está desligada para este pedido.*imprima pelo Seller Central/,
      ESPERA,
    ],
    [
      'AMAZON_CHAMADAS_DESLIGADAS',
      CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      () => {
        const c = cenario();
        c.ambiente = { ...c.ambiente, AMAZON_CHAMADAS: 'off' };
        return c.rodar();
      },
      /^As chamadas à Amazon estão desligadas neste backend/,
      ESPERA_OU_SELLER,
    ],
  ];

  it('the table covers every code this route answers, and holds three AGUARDANDO_NFE rows', () => {
    expect(new Set(FRASES.map(([, codigo]) => codigo))).toEqual(
      new Set([...Object.values(CODIGO), CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS]),
    );
    expect(FRASES.filter(([, codigo]) => codigo === CODIGO.AGUARDANDO_NFE)).toHaveLength(3);
  });

  it.each(FRASES)(
    '★ %s: its own sentence, never another code’s remedy',
    async (_titulo, codigo, rodar, deve, naoDeve) => {
      const r = await rodar();
      if (r.tipo !== 'erro') throw new Error('esperava erro');
      expect(r.corpo.code).toBe(codigo);
      expect(r.corpo.error).toMatch(deve);
      expect(r.corpo.error).not.toMatch(naoDeve);
    },
  );
});

describe('R14 — what a line never carries', () => {
  const IDS_FEITOS_PELA_AMAZON = [
    SENTINELA.refPacote,
    SENTINELA.rastreioPedido,
    SENTINELA.pacoteBulk,
    SENTINELA.rastreioBulk,
    SENTINELA.slot,
  ];

  it('★ no line carries https://, X-Amz-, Atz., ^XA or a 64+ base64 run; no line but the observer’s call lines carries a tracking, package or slot id, or Amazon’s text — and the bulk’s call line DOES carry the package id (the positive control)', async () => {
    const impresso = cenario();
    const recusado = cenario({ bulk: [rejeitado('InvalidOrderState', true)] });
    const semZpl = cenario({ documento: [{ bytes: zipDeTeste({ 'label.pdf': ZPL }) }] });
    await impresso.rodar();
    await recusado.rodar();
    await semZpl.rodar();
    const linhas = [...impresso.log.linhas, ...recusado.log.linhas, ...semZpl.log.linhas];
    // Anti-vacuity: every run reached the bulk, and each wrote its own line.
    expect([...posts(impresso), ...posts(recusado), ...posts(semZpl)]).toHaveLength(6);
    expect(linhas.filter((l) => l.meta?.rota === ROTA_ETIQUETA_AMAZON)).toHaveLength(3);
    for (const l of linhas) {
      // The pedido id is 64 hex by design (an id, not a payload): masked before the run scan.
      const t = texto(l).split(PEDIDO_ID).join('<pedidoId>');
      for (const proibido of ['https://', 'X-Amz-', 'Atz.', '^XA']) {
        expect(t.includes(proibido), `${proibido} em ${t}`).toBe(false);
      }
      expect(t, t).not.toMatch(/[A-Za-z0-9+/=]{64,}/);
    }
    for (const l of linhas.filter((x) => x.meta?.evento !== 'chamada')) {
      for (const id of IDS_FEITOS_PELA_AMAZON) expect(texto(l), id).not.toContain(id);
      expect(texto(l)).not.toContain(SENTINELA.textoDaAmazon);
    }
    const chamadasDoBulk = impresso.log.linhas.filter(
      (l) =>
        l.meta?.evento === 'chamada' && String(l.meta.caminho ?? '').includes('/packages/bulk'),
    );
    expect(chamadasDoBulk).toHaveLength(1);
    expect(texto(chamadasDoBulk[0] as LinhaDeLog)).toContain(SENTINELA.pacoteBulk);
  });

  it('★ the run’s SP-API call lines are filed under this flow, with no attempt and no task id: a route, not a queue', async () => {
    const c = cenario();
    await c.rodar();
    const chamadas = c.log.linhas.filter((l) => l.meta?.evento === 'chamada');
    // Anti-vacuity: getOrder, the mint and the bulk each wrote its line; the document none.
    expect(chamadas).toHaveLength(3);
    for (const l of chamadas) {
      expect(l.meta).toMatchObject({
        fluxo: 'agendamento',
        tentativa: null,
        idTarefa: null,
        conta: CONTA,
        correlationId: 'corr-etiqueta-teste',
      });
    }
  });
});
