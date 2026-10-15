/**
 * `POST /api/marketplace/shopee/etiqueta` (#1523, step 15; reconcile §2.4 minus
 * Appendix A, R-e/R-h/R-r). The RUNNER is a spy here — its own suite
 * (`lib/shopee/etiqueta/executarEtiqueta.test.ts`) drives the Shopee side — so
 * every case below is about what only the ROUTE decides: the ladder, the
 * ownership and block checks, the conta, the permission bits it hands down, the
 * answer mapping, and the NF-e re-drive.
 *
 * The re-drive is the REAL `reenviarNfeDoPedidoShopee` over the shared fake
 * Firestore and a RECORDING NF-e scheduler (the `enviar-nfe/route.test.ts`
 * setup), wrapped in a pass-through spy so a test can count the calls.
 *
 * A predicate case names a PAIR (must answer the same) and a NEAR-MISS (must
 * stay distinct) in its title. Mutants killed here: S26′, S35–S40 (the route
 * halves of S37/S38), S44 and S45 at the route.
 *
 * ⚠️ Fixture ids only; the synthetic NF-e key uses cUF 99. Nothing here reaches
 * a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PERM } from '@delfrance/auth';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  integracaoCollection,
  nfev4Collection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import type { ShopeeClient } from '@delfrance/integrations-shopee';
import { ESTADO_NFE, INTEGRACAO_FRETE, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { ShopeeContaSemShopIdError, ShopeeSemCredencialError } from '@/lib/shopee/core/tokenStore';
import { TAMANHO_MAX_PACOTE } from '@/lib/shopee/etiqueta/constantesEtiqueta';
import type {
  DepsExecucaoEtiqueta,
  EntradaEtiqueta,
  ResultadoEtiqueta,
} from '@/lib/shopee/etiqueta/executarEtiqueta';
import {
  MOTIVO_ETIQUETA_SHOPEE,
  mensagemDoMotivoEtiqueta,
  type MotivoEtiquetaShopee,
} from '@/lib/shopee/etiqueta/motivosEtiqueta';
import {
  MENSAGEM_DA_FASE,
  MENSAGEM_ESCOLHER_ENVIO,
  type EtiquetaPendente,
} from '@/lib/shopee/etiqueta/pendenteEtiqueta';
import {
  MENSAGEM_FORMATO_DESCONHECIDO,
  MENSAGEM_SEM_PERMISSAO_PROGRAMAR,
} from '@/lib/shopee/etiqueta/respostaEtiqueta';
import { MOTIVO_NFE_SHOPEE } from '@/lib/shopee/nfe/errosNfe';
import { avaliarPedidoParaNfeShopee } from '@/lib/shopee/nfe/pedidoNfe';
import { FASE_NFE_SHOPEE, type AgendadorNfeShopee } from '@/lib/shopee/nfe/tarefaNfe';
import { makePedidoIdShopee } from '@/lib/shopee/pedidos/orderIds';
import { MSG_BODY_INVALIDO } from '@/lib/shopee/produtos/corpoImportacao';
import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

type ModuloAgendador = typeof import('@/lib/shopee/nfe/shopeeNfeUploadTasks');
type ModuloReenvio = typeof import('@/lib/shopee/nfe/reenvioNfe');
type Reenviar = ModuloReenvio['reenviarNfeDoPedidoShopee'];

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  createShopClient: vi.fn(),
  executar: vi.fn(),
  criar: vi.fn(),
  enqueue: vi.fn(),
  reenviar: vi.fn(),
  real: {
    criar: null as (() => AgendadorNfeShopee) | null,
    reenviar: null as Reenviar | null,
  },
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
  getAdminApp: () => {
    throw new Error('o app admin REAL não pode ser usado por este teste');
  },
  tryGetAdminBucket: () => null,
}));

// Where a client (and a token read) would start.
vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

// The runner — its own suite owns the Shopee side.
vi.mock('@/lib/shopee/etiqueta/executarEtiqueta', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/etiqueta/executarEtiqueta')>();
  return { ...actual, executarEtiquetaShopee: h.executar };
});

// The NF-e scheduler defaults to a RECORDER; the valve case swaps in the REAL one.
vi.mock('@/lib/shopee/nfe/shopeeNfeUploadTasks', async (importActual) => {
  const actual = await importActual<ModuloAgendador>();
  h.real.criar = actual.createShopeeNfeUploadScheduler;
  return { ...actual, createShopeeNfeUploadScheduler: h.criar };
});

// The re-drive stays REAL; the spy only counts (and delegates).
vi.mock('@/lib/shopee/nfe/reenvioNfe', async (importActual) => {
  const actual = await importActual<ModuloReenvio>();
  h.real.reenviar = actual.reenviarNfeDoPedidoShopee;
  return { ...actual, reenviarNfeDoPedidoShopee: h.reenviar };
});

const {
  POST,
  MSG_CAMPO_NAO_ACEITO,
  MSG_ENVIO_INVALIDO,
  MSG_FORMATO_INVALIDO,
  MSG_PACOTE_INVALIDO,
  MSG_PEDIDO_ID_INVALIDO,
  MSG_PEDIDO_NAO_ENCONTRADO,
} = await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
const P1 = 'OFG000000000001';
const RASTREIO = 'BR000000000000T';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const INTEGRACAO_PATH = integracaoCollection.docPath({}, CONTA);
const NFEV4_PATH = nfev4Collection.resolvePath({ pedidoId: PEDIDO_ID });
const NOW_MS = 1_789_000_000_000;

/** An opaque client: the runner is a spy, so nothing ever calls into it. */
const CLIENTE = { marca: 'cliente-de-teste' } as unknown as ShopeeClient;

/** `%PDF-` plus bytes ≥ 0x80 — a text round trip would mangle them. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0x80, 0x00]);

/** A synthetic key: cUF 99 + AAMM + CNPJ + mod 55 + série + nNF + tpEmis + cNF + DV. */
const K = `99${'2609'}${'1'.repeat(14)}55${'000'}${'000000001'}1${'00000000'}0`;

/** A minimal synthetic `nfeProc` of a SALE, produção — no signature, no real party. */
const PROC = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
  `<NFe><infNFe versao="4.00" Id="NFe${K}"><ide><cUF>99</cUF><mod>55</mod>`,
  '<tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>1</finNFe>',
  '</ide><emit><xNome>TESTE SINTETICO SEM VALOR FISCAL</xNome></emit>',
  '</infNFe></NFe>',
  `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${K}</chNFe>`,
  '<cStat>100</cStat></infProt></protNFe></nfeProc>',
].join('');

function nfeRaw(o: DocData = {}): DocData {
  return {
    estado: ESTADO_NFE.aprovada,
    chave: K,
    xml_nfe_proc: PROC,
    data_autorizacao: NOW_MS - 3_600_000,
    ...o,
  };
}

function pedidoRaw(o: DocData = {}): DocData {
  return {
    numero: ORDER_SN,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    bloquearEmissaoNFe: false,
    freteInicial: {
      externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
      estado: 'aguardandoPostagem',
    },
    ...o,
  };
}

function contaRaw(o: DocData = {}): DocData {
  return { tipo: INTEGRACAO_TIPO.shopee, ativo: true, nome: 'Loja Sandbox', shop_id: SHOP, ...o };
}

interface Cenario {
  readonly pedidoId?: string;
  readonly pedido?: DocData | null;
  readonly conta?: DocData | null;
  readonly nfes?: Record<string, DocData>;
}

function cenario(o: Cenario = {}): FakeDb {
  const db = new FakeDb();
  const pedidoId = o.pedidoId ?? PEDIDO_ID;
  if (o.conta !== null) db.seed(INTEGRACAO_PATH, o.conta ?? contaRaw());
  if (o.pedido !== null) db.seed(pedidoCollection.docPath({}, pedidoId), o.pedido ?? pedidoRaw());
  for (const [id, raw] of Object.entries(o.nfes ?? { s1: nfeRaw() })) {
    db.seed(nfev4Collection.docPath({ pedidoId }, id), raw);
  }
  h.db.atual = asDb(db);
  return db;
}

/** A claim string for a set of permission bits. */
function perms(...bits: bigint[]): string {
  return bits.reduce((a, b) => a | b, 0n).toString();
}

/** The label operator who may print AND arrange — the main path. */
const EXPEDICAO = perms(PERM.frete.read, PERM.frete.write);

function autorizar(permissions: string): void {
  h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions });
}

const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = AUTORIZADO): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/etiqueta', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

async function responder(corpo: unknown, headers?: Record<string, string>) {
  const res = await POST(req(corpo, headers));
  return { status: res.status, res, body: (await res.json()) as Record<string, unknown> };
}

/** A body the ladder accepts. */
function corpo(o: Record<string, unknown> = {}): Record<string, unknown> {
  return { pedidoId: PEDIDO_ID, formato: 'pdf', ...o };
}

const PROGRESSO = { total: 1, organizados: 1, comRastreio: 0, prontos: 0 };

function bytes(
  extra: Partial<Extract<ResultadoEtiqueta, { tipo: 'bytes' }>> = {},
): ResultadoEtiqueta {
  return {
    tipo: 'bytes',
    bytes: PDF,
    formato: 'pdf',
    contentType: 'application/pdf',
    extensao: 'pdf',
    indice: null,
    total: 1,
    ...extra,
  };
}

function pendente(c: EtiquetaPendente): ResultadoEtiqueta {
  return { tipo: 'pendente', corpo: c };
}

const AGUARDAR: EtiquetaPendente = {
  acao: 'aguardar',
  fase: 'aguardando-rastreio',
  tentarEmMs: 5_000,
  mensagem: MENSAGEM_DA_FASE['aguardando-rastreio'],
  progresso: PROGRESSO,
};

const ESCOLHER: EtiquetaPendente = {
  acao: 'escolher-envio',
  fase: 'programando',
  pacote: P1,
  pacoteRotulo: null,
  mensagem: MENSAGEM_ESCOLHER_ENVIO,
  enderecos: [
    {
      id: '2001',
      rotulo: 'Rua do Vendedor, 100',
      principal: true,
      horarios: [{ id: 'slot-1', rotulo: '09:00', recomendado: true }],
    },
  ],
  permiteDropoff: true,
  escolhaInvalida: false,
  progresso: { total: 1, organizados: 0, comRastreio: 0, prontos: 0 },
};

/** The 409 body for a route-owned `motivo`, exactly. */
function recusa(motivo: MotivoEtiquetaShopee) {
  const mensagem = mensagemDoMotivoEtiqueta(motivo);
  return { error: mensagem, code: 'SHOPEE_ETIQUETA_RECUSADA', motivo, mensagem };
}

/** The runner's one call, typed. */
function chamadaDoExecutor(): { deps: DepsExecucaoEtiqueta; entrada: EntradaEtiqueta } {
  expect(h.executar).toHaveBeenCalledTimes(1);
  const [deps, entrada] = h.executar.mock.calls[0] as [DepsExecucaoEtiqueta, EntradaEtiqueta];
  return { deps, entrada };
}

let fetchSpy: MockInstance;

beforeEach(() => {
  __resetAllReadCaches();
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  autorizar(EXPEDICAO);
  h.createShopClient.mockReset().mockReturnValue(CLIENTE);
  h.loadCtx.mockReset().mockResolvedValue({ createShopClient: h.createShopClient });
  h.executar.mockReset().mockResolvedValue(bytes());
  h.enqueue.mockReset().mockResolvedValue(undefined);
  h.criar.mockReset().mockImplementation(() => ({ enqueue: h.enqueue }));
  h.reenviar.mockReset().mockImplementation((...args: Parameters<Reenviar>) => {
    const real = h.real.reenviar;
    if (real === null) throw new Error('o módulo real do reenvio não foi carregado');
    return real(...args);
  });
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('a rota não pode alcançar a rede'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/* ---------------------------------- auth ---------------------------------- */

describe('auth — base `frete.read`; `frete.write` só para ORGANIZAR (R-h)', () => {
  it('401 sem bearer, antes de qualquer leitura', async () => {
    const db = cenario();
    const { status } = await responder(corpo(), {});
    expect(status).toBe(401);
    expect(db.caminhos).toEqual([]);
    expect(h.executar).not.toHaveBeenCalled();
  });

  it('S37 (metade da rota): SÓ `frete.read` recebe os bytes de um pacote organizado — 200, `podeProgramar: false`', async () => {
    cenario();
    autorizar(perms(PERM.frete.read));
    const res = await POST(req(corpo()));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(chamadaDoExecutor().deps.podeProgramar).toBe(false);
  });

  it('PAR: `frete.read` + `frete.write` ⇒ `podeProgramar: true`', async () => {
    cenario();
    autorizar(perms(PERM.frete.read, PERM.frete.write));
    expect((await POST(req(corpo()))).status).toBe(200);
    expect(chamadaDoExecutor().deps.podeProgramar).toBe(true);
  });

  it('S38 (metade da rota): o executor responde `sem-permissao` ⇒ 403 SHOPEE_ETIQUETA_SEM_PERMISSAO, corpo exato', async () => {
    cenario();
    autorizar(perms(PERM.frete.read));
    h.executar.mockResolvedValue({ tipo: 'sem-permissao' });
    const { status, body } = await responder(corpo());
    expect(status).toBe(403);
    expect(body).toStrictEqual({
      error: MENSAGEM_SEM_PERMISSAO_PROGRAMAR,
      code: 'SHOPEE_ETIQUETA_SEM_PERMISSAO',
      motivo: 'programar-envio',
      mensagem: MENSAGEM_SEM_PERMISSAO_PROGRAMAR,
    });
  });

  it.each<[string, string]>([
    ['SÓ `pedido.write` (o bit do `enviar-nfe`)', perms(PERM.pedido.write)],
    ['SÓ `integracao.write` (o bit das outras rotas Shopee)', perms(PERM.integracao.write)],
    ['SÓ `frete.write` — organizar não substitui o bit BASE de leitura', perms(PERM.frete.write)],
  ])('QUASE-MISS: %s ⇒ 403 do verifyCaller, sem ler nada', async (_rotulo, claim) => {
    const db = cenario();
    autorizar(claim);
    const { status, body } = await responder(corpo());
    expect(status).toBe(403);
    expect(body.code).toBeUndefined();
    expect(db.caminhos).toEqual([]);
    expect(h.executar).not.toHaveBeenCalled();
  });
});

/* --------------------------------- the body -------------------------------- */

const LONGO = 'P'.repeat(TAMANHO_MAX_PACOTE + 1);

describe('o corpo — todo degrau ANTES de qualquer leitura (400)', () => {
  it.each<[string, unknown, string]>([
    ['JSON malformado', '{"pedidoId":', MSG_BODY_INVALIDO],
    ['null', null, MSG_BODY_INVALIDO],
    ['um array', [PEDIDO_ID], MSG_BODY_INVALIDO],
    ['um escalar', 42, MSG_BODY_INVALIDO],
    // rung 4 — pedidoId
    ['sem pedidoId', { formato: 'pdf' }, MSG_PEDIDO_ID_INVALIDO],
    ['pedidoId número', corpo({ pedidoId: 123 }), MSG_PEDIDO_ID_INVALIDO],
    ['pedidoId vazio', corpo({ pedidoId: '' }), MSG_PEDIDO_ID_INVALIDO],
    ['pedidoId com `/`', corpo({ pedidoId: `${PEDIDO_ID}/nfev4/s1` }), MSG_PEDIDO_ID_INVALIDO],
    ['pedidoId `..`', corpo({ pedidoId: '..' }), MSG_PEDIDO_ID_INVALIDO],
    // rung 5 — formato (required)
    ['sem formato', { pedidoId: PEDIDO_ID }, MSG_FORMATO_INVALIDO],
    ['formato null', corpo({ formato: null }), MSG_FORMATO_INVALIDO],
    ['formato `PDF` (caixa)', corpo({ formato: 'PDF' }), MSG_FORMATO_INVALIDO],
    ['formato `zpl` (sem o 2)', corpo({ formato: 'zpl' }), MSG_FORMATO_INVALIDO],
    ['formato `zip`', corpo({ formato: 'zip' }), MSG_FORMATO_INVALIDO],
    // rung 6 — pacote
    ['pacote vazio', corpo({ pacote: '' }), MSG_PACOTE_INVALIDO],
    ['pacote só espaços', corpo({ pacote: '   ' }), MSG_PACOTE_INVALIDO],
    ['pacote com 65 caracteres', corpo({ pacote: LONGO }), MSG_PACOTE_INVALIDO],
    ['pacote número', corpo({ pacote: 1 }), MSG_PACOTE_INVALIDO],
    ['pacote array', corpo({ pacote: [P1] }), MSG_PACOTE_INVALIDO],
    // rung 7 — envio
    ['envio texto', corpo({ envio: 'pickup' }), MSG_ENVIO_INVALIDO],
    ['envio array', corpo({ envio: [] }), MSG_ENVIO_INVALIDO],
    ['envio objeto vazio', corpo({ envio: {} }), MSG_ENVIO_INVALIDO],
    [
      'envio pickup SEM a chave horarioId',
      corpo({ envio: { pacote: P1, modo: 'pickup', enderecoId: '2001' } }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio pickup com uma chave a mais',
      corpo({
        envio: { pacote: P1, modo: 'pickup', enderecoId: '2001', horarioId: null, extra: 1 },
      }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio pickup com enderecoId NÚMERO (o eco convertido — S43)',
      corpo({ envio: { pacote: P1, modo: 'pickup', enderecoId: 2001, horarioId: null } }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio pickup com enderecoId vazio',
      corpo({ envio: { pacote: P1, modo: 'pickup', enderecoId: '', horarioId: null } }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio pickup com horarioId vazio',
      corpo({ envio: { pacote: P1, modo: 'pickup', enderecoId: '2001', horarioId: '' } }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio pickup com horarioId número',
      corpo({ envio: { pacote: P1, modo: 'pickup', enderecoId: '2001', horarioId: 7 } }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio dropoff com enderecoId (as chaves do OUTRO formato)',
      corpo({ envio: { pacote: P1, modo: 'dropoff', enderecoId: '2001' } }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio dropoff com uma agência (não há seletor de agência — R-z)',
      corpo({ envio: { pacote: P1, modo: 'dropoff', branchId: 3 } }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio com modo desconhecido',
      corpo({ envio: { pacote: P1, modo: 'agencia' } }),
      MSG_ENVIO_INVALIDO,
    ],
    ['envio sem modo', corpo({ envio: { pacote: P1 } }), MSG_ENVIO_INVALIDO],
    [
      'envio com pacote vazio',
      corpo({ envio: { pacote: ' ', modo: 'dropoff' } }),
      MSG_ENVIO_INVALIDO,
    ],
    [
      'envio com pacote de 65 caracteres',
      corpo({ envio: { pacote: LONGO, modo: 'dropoff' } }),
      MSG_ENVIO_INVALIDO,
    ],
    // rung 8 — the strict key set
    [
      'S26′: `confirmacoes` — a confirmação de 1 h foi REMOVIDA (Apêndice A)',
      corpo({ confirmacoes: ['janela-1h'] }),
      MSG_CAMPO_NAO_ACEITO,
    ],
    ['S26′: `confirmacoes` vazio também', corpo({ confirmacoes: [] }), MSG_CAMPO_NAO_ACEITO],
    [
      '`janelaConfirmada` (o campo removido da entrada)',
      corpo({ janelaConfirmada: true }),
      MSG_CAMPO_NAO_ACEITO,
    ],
    [
      '`escolha` (o nome do D2, substituído por `envio`)',
      corpo({ escolha: { pacote: P1, modo: 'dropoff' } }),
      MSG_CAMPO_NAO_ACEITO,
    ],
    ['um `numero` no corpo', corpo({ numero: ORDER_SN }), MSG_CAMPO_NAO_ACEITO],
  ])('%s ⇒ 400, zero leituras, executor intocado', async (_rotulo, c, erro) => {
    const db = cenario();
    const { status, body } = await responder(c);
    expect(status).toBe(400);
    expect(body).toStrictEqual({ error: erro });
    expect(db.caminhos).toEqual([]);
    expect(h.executar).not.toHaveBeenCalled();
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('a ORDEM dos degraus: formato ruim E chave a mais ⇒ a frase do formato (o degrau 5 vem antes do 8)', async () => {
    cenario();
    const { body } = await responder(corpo({ formato: 'png', confirmacoes: ['janela-1h'] }));
    expect(body).toStrictEqual({ error: MSG_FORMATO_INVALIDO });
  });

  it('PAR: `pacote`/`envio` ausentes e `null` chegam ao executor como `null`', async () => {
    cenario();
    await POST(req(corpo()));
    expect(chamadaDoExecutor().entrada).toStrictEqual({
      orderSn: ORDER_SN,
      formato: 'pdf',
      pacote: null,
      envio: null,
    });
    h.executar.mockClear();
    await POST(req(corpo({ formato: 'zpl2', pacote: null, envio: null })));
    expect(chamadaDoExecutor().entrada).toStrictEqual({
      orderSn: ORDER_SN,
      formato: 'zpl2',
      pacote: null,
      envio: null,
    });
  });

  it('a fronteira do pacote: 64 caracteres passam; 65 não (acima)', async () => {
    cenario();
    const limite = 'P'.repeat(TAMANHO_MAX_PACOTE);
    expect((await POST(req(corpo({ pacote: limite })))).status).toBe(200);
    expect(chamadaDoExecutor().entrada.pacote).toBe(limite);
  });

  it('o pacote é repassado VERBATIM (sem aparar) — o executor o casa exatamente', async () => {
    cenario();
    await POST(req(corpo({ pacote: P1 })));
    expect(chamadaDoExecutor().entrada.pacote).toBe(P1);
  });

  it.each<[string, Record<string, unknown>]>([
    ['pickup com horário', { pacote: P1, modo: 'pickup', enderecoId: '2001', horarioId: 'slot-1' }],
    [
      'pickup SEM horário (`null` — um endereço sem janelas)',
      { pacote: P1, modo: 'pickup', enderecoId: '2001', horarioId: null },
    ],
    ['dropoff', { pacote: P1, modo: 'dropoff' }],
  ])('PAR: envio %s é aceito e RECONSTRUÍDO por nome', async (_rotulo, envio) => {
    cenario();
    expect((await POST(req(corpo({ envio })))).status).toBe(200);
    // Byte-equal to what was sent: the id stays a STRING (never `Number()`).
    expect(chamadaDoExecutor().entrada.envio).toStrictEqual(envio);
  });
});

/* ------------------------------ ownership & gates ----------------------------- */

describe('dono, bloco e conta — antes de qualquer cliente', () => {
  it('o pedido que não existe ⇒ 404 SHOPEE_ETIQUETA_PEDIDO_NAO_ENCONTRADO, sem ler a conta', async () => {
    const db = cenario({ pedido: null });
    const { status, body } = await responder(corpo());
    expect(status).toBe(404);
    expect(body).toStrictEqual({
      error: MSG_PEDIDO_NAO_ENCONTRADO,
      code: 'SHOPEE_ETIQUETA_PEDIDO_NAO_ENCONTRADO',
    });
    expect(db.caminhos).not.toContain(INTEGRACAO_PATH);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.executar).not.toHaveBeenCalled();
  });

  it('QUASE-MISS: os MESMOS campos sob um id que não é o digest de (conta, order_sn) ⇒ 409 `nao-shopee`', async () => {
    const db = cenario({ pedidoId: 'pedido-de-outro-canal' });
    const { status, body } = await responder(corpo({ pedidoId: 'pedido-de-outro-canal' }));
    expect(status).toBe(409);
    expect(body).toStrictEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.naoShopee));
    expect(db.caminhos).not.toContain(INTEGRACAO_PATH);
    expect(h.executar).not.toHaveBeenCalled();
  });

  it('PAR: os mesmos campos sob o digest ⇒ o executor roda com o order_sn DO PEDIDO', async () => {
    cenario();
    expect((await POST(req(corpo()))).status).toBe(200);
    expect(chamadaDoExecutor().entrada.orderSn).toBe(ORDER_SN);
    expect(h.loadCtx).toHaveBeenCalledTimes(1);
    expect(h.loadCtx.mock.calls[0]?.[1]).toBe(CONTA);
  });

  it('S39: um pedido com `bloquearEmissaoNFe: true` NÃO é recusado — a posse é a prova de identidade, nunca o portão da NF-e', async () => {
    const raw = pedidoRaw({ bloquearEmissaoNFe: true });
    cenario({ pedido: raw });
    // The near-miss predicate WOULD refuse this very document — which is why
    // the route must not use it.
    expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, raw)).toMatchObject({
      acao: 'ignorar',
      motivo: MOTIVO_NFE_SHOPEE.emissaoBloqueada,
    });
    const res = await POST(req(corpo()));
    expect(res.status).toBe(200);
    expect(h.executar).toHaveBeenCalledTimes(1);
  });

  it.each<[string, DocData]>([
    [
      'S40: `externalOptionIntegracao: null` (um pedido legado migrado)',
      { externalOptionIntegracao: null },
    ],
    ['a chave ausente no bloco', { estado: 'aguardandoPostagem' }],
    ['`shopee`', { externalOptionIntegracao: INTEGRACAO_FRETE.shopee }],
  ])('PAR — o bloco passa: %s', async (_rotulo, frete) => {
    cenario({ pedido: pedidoRaw({ freteInicial: frete }) });
    expect((await POST(req(corpo()))).status).toBe(200);
    expect(h.executar).toHaveBeenCalledTimes(1);
  });

  it('PAR — sem bloco de frete nenhum, passa', async () => {
    const raw = pedidoRaw();
    delete raw.freteInicial;
    cenario({ pedido: raw });
    expect((await POST(req(corpo()))).status).toBe(200);
  });

  it.each<[string, unknown]>([
    ['outra integração (`mercadoLivre`)', INTEGRACAO_FRETE.mercadoLivre],
    ['`melhorEnvios`', INTEGRACAO_FRETE.melhorEnvios],
    ['`Shopee` com outra caixa — igualdade ESTRITA', 'Shopee'],
  ])(
    'QUASE-MISS — o bloco é de %s ⇒ 409 `frete-de-outra-integracao`, sem conta nem cliente',
    async (_rotulo, dono) => {
      const db = cenario({
        pedido: pedidoRaw({ freteInicial: { externalOptionIntegracao: dono } }),
      });
      const { status, body } = await responder(corpo());
      expect(status).toBe(409);
      expect(body).toStrictEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.freteDeOutraIntegracao));
      expect(db.caminhos).not.toContain(INTEGRACAO_PATH);
      expect(h.loadCtx).not.toHaveBeenCalled();
      expect(h.executar).not.toHaveBeenCalled();
    },
  );

  it.each<[string, DocData | null, MotivoEtiquetaShopee]>([
    ['a conta que não existe', null, MOTIVO_ETIQUETA_SHOPEE.contaNaoConfigurada],
    [
      'uma conta de OUTRO tipo',
      contaRaw({ tipo: INTEGRACAO_TIPO.mercadoLivre }),
      MOTIVO_ETIQUETA_SHOPEE.contaNaoConfigurada,
    ],
    ['uma conta desativada', contaRaw({ ativo: false }), MOTIVO_ETIQUETA_SHOPEE.contaInativa],
  ])('%s ⇒ 409, sem contexto e sem cliente', async (_rotulo, conta, motivo) => {
    cenario({ conta });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body).toStrictEqual(recusa(motivo));
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.executar).not.toHaveBeenCalled();
  });
});

/* ---------------------------------- the runner --------------------------------- */

describe('o executor — o que a rota lhe entrega', () => {
  it('as dependências são EXATAMENTE cliente, relógio, espera e a permissão — nada de leitura-só nem outro orçamento', async () => {
    cenario();
    await POST(req(corpo()));
    const { deps } = chamadaDoExecutor();
    expect(Object.keys(deps).sort()).toEqual(['agora', 'client', 'dormir', 'podeProgramar']);
    expect(deps.client).toBe(CLIENTE);
    expect(deps.agora()).toBe(NOW_MS);
    await expect(deps.dormir(0)).resolves.toBeUndefined();
    expect(h.createShopClient).toHaveBeenCalledTimes(1);
  });

  it('a rota escreve NADA e não alcança a rede por conta própria', async () => {
    const db = cenario();
    expect((await POST(req(corpo()))).status).toBe(200);
    expect(db.writes).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.caminhos.some((c) => c.includes('credenciais'))).toBe(false);
  });

  it('um `simulado` (o modo leitura da CLI) é um DEFEITO aqui — relança, nunca um 2xx', async () => {
    cenario();
    h.executar.mockResolvedValue({
      tipo: 'simulado',
      acao: { tipo: 'nfe-pendente' },
      fases: [],
      progresso: PROGRESSO,
    });
    await expect(POST(req(corpo()))).rejects.toThrow(/simulado/);
  });
});

/* ---------------------------------- the answers -------------------------------- */

describe('as respostas — o mapeamento de `respostaEtiqueta.ts`, na rota', () => {
  it('200: os bytes byte a byte, e os TRÊS cabeçalhos exatos', async () => {
    cenario();
    const res = await POST(req(corpo()));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="etiqueta-shopee-${ORDER_SN}.pdf"`,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('200 ZPL: `text/plain` NU (sem charset) e a extensão `.txt`', async () => {
    cenario();
    h.executar.mockResolvedValue(
      bytes({
        bytes: new TextEncoder().encode('^XA^FO50,50^FDteste^FS^XZ'),
        formato: 'zpl',
        contentType: 'text/plain',
        extensao: 'txt',
      }),
    );
    const res = await POST(req(corpo({ formato: 'zpl2' })));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="etiqueta-shopee-${ORDER_SN}.txt"`,
    );
  });

  it('S45 na rota: o download por pacote leva a POSIÇÃO (`-p1de2`), nunca o número do pacote', async () => {
    cenario();
    h.executar.mockResolvedValue(bytes({ indice: 1, total: 2 }));
    const res = await POST(req(corpo({ pacote: P1 })));
    const disposicao = res.headers.get('content-disposition') ?? '';
    expect(disposicao).toBe(`attachment; filename="etiqueta-shopee-${ORDER_SN}-p1de2.pdf"`);
    expect(disposicao).not.toContain(P1);
  });

  it('um `numero` que não passa a guarda `[\\w.-]+` ⇒ o nome sem número', async () => {
    // The id is recomputed from the numero, so the guard is exercised with a
    // numero the digest still proves.
    const numero = 'SN com espaço';
    const pedidoId = makePedidoIdShopee(CONTA, numero);
    cenario({ pedidoId, pedido: pedidoRaw({ numero }) });
    const res = await POST(req(corpo({ pedidoId })));
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="etiqueta-shopee.pdf"',
    );
    expect(chamadaDoExecutor().entrada.orderSn).toBe(numero);
  });

  it.each<[string, EtiquetaPendente]>([
    ['aguardar', AGUARDAR],
    ['escolher-envio', ESCOLHER],
    [
      'baixar-por-pacote',
      {
        acao: 'baixar-por-pacote',
        fase: 'baixando',
        pacotes: [P1, 'OFG000000000002'],
        mensagem: 'x',
        progresso: { total: 2, organizados: 2, comRastreio: 2, prontos: 2 },
      },
    ],
  ])('202 `%s`: o corpo do executor VERBATIM, `no-store`', async (_rotulo, c) => {
    cenario();
    h.executar.mockResolvedValue(pendente(c));
    const { status, res, body } = await responder(corpo());
    expect(status).toBe(202);
    expect(body).toStrictEqual(JSON.parse(JSON.stringify(c)));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('409 de uma recusa do executor, com `tentarApos` repassado', async () => {
    cenario();
    h.executar.mockResolvedValue({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
      tentarApos: NOW_MS + 3_600_000,
    });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body).toStrictEqual({
      ...recusa(MOTIVO_ETIQUETA_SHOPEE.limiteDiario),
      tentarApos: NOW_MS + 3_600_000,
    });
  });

  it('R3-F1 PAR: uma `recusa-desconhecida` com `shopeeCode` ⇒ o 409 leva o código, e UMA linha de log `{ op, code }`', async () => {
    cenario();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.executar.mockResolvedValue({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
      shopeeCode: 'some_new_code',
      operacao: 'programar',
    });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body).toStrictEqual({
      ...recusa(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida),
      shopeeCode: 'some_new_code',
    });
    expect(warn.mock.calls).toEqual([
      ['[shopee/etiqueta] recusa-desconhecida', { op: 'programar', code: 'some_new_code' }],
    ]);
    const linha = JSON.stringify(warn.mock.calls);
    expect(linha).not.toContain(ORDER_SN);
    expect(linha).not.toContain(PEDIDO_ID);
  });

  it('R3-F1 QUASE-MISS: a MESMA recusa sem `shopeeCode` ⇒ nenhuma chave `shopeeCode` e nenhum log', async () => {
    cenario();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.executar.mockResolvedValue({
      tipo: 'recusa',
      motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
      operacao: 'programar',
    });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body).toStrictEqual(recusa(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida));
    expect(warn).not.toHaveBeenCalled();
  });

  it('S44: `formato-desconhecido` ⇒ 502 JSON SHOPEE_ETIQUETA_FORMATO_DESCONHECIDO, nunca octet-stream', async () => {
    cenario();
    h.executar.mockResolvedValue({ tipo: 'formato-desconhecido' });
    const { status, res, body } = await responder(corpo());
    expect(status).toBe(502);
    expect(body).toStrictEqual({
      error: MENSAGEM_FORMATO_DESCONHECIDO,
      code: 'SHOPEE_ETIQUETA_FORMATO_DESCONHECIDO',
    });
    expect(res.headers.get('content-type')).not.toMatch(/octet-stream/);
    expect(res.headers.get('content-disposition')).toBeNull();
  });
});

/* ------------------------------------ the NF-e ---------------------------------- */

/** The label operator who may ALSO re-drive the NF-e. */
const EXPEDICAO_COM_PEDIDO = perms(PERM.frete.read, PERM.frete.write, PERM.pedido.write);

describe('a NF-e — reenviada SÓ na resposta `nfe-pendente` (R-e)', () => {
  it('S35: sem `pedido.write` ⇒ `nfe.desfecho: sem-permissao`, reenvio NUNCA chamado, nada enfileirado', async () => {
    const db = cenario();
    autorizar(EXPEDICAO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body.code).toBe('SHOPEE_ETIQUETA_RECUSADA');
    expect(body.motivo).toBe(MOTIVO_ETIQUETA_SHOPEE.nfePendente);
    expect(body.nfe).toStrictEqual({ desfecho: 'sem-permissao' });
    // The motivo's sentence, then the outcome's — never the bare sentence alone.
    const base = mensagemDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.nfePendente);
    expect(String(body.mensagem).startsWith(`${base} `)).toBe(true);
    expect(body.error).toBe(body.mensagem);
    expect(h.reenviar).not.toHaveBeenCalled();
    expect(h.criar).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(db.caminhos).not.toContain(NFEV4_PATH);
  });

  it('PAR: com `pedido.write` ⇒ UM reenvio, com o relógio da rota e `nfeId: null`, e a tarefa enfileirada', async () => {
    const db = cenario();
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body.nfe).toStrictEqual({ desfecho: 'enfileirado', atrasoSegundos: 0 });
    expect(h.reenviar).toHaveBeenCalledTimes(1);
    expect(h.reenviar.mock.calls[0]?.[1]).toStrictEqual({
      pedidoId: PEDIDO_ID,
      nfeId: null,
      nowMs: NOW_MS,
    });
    expect(h.enqueue.mock.calls).toEqual([
      [
        {
          pedidoId: PEDIDO_ID,
          nfeId: 's1',
          fase: FASE_NFE_SHOPEE.envio,
          adiamentosSerpro: 0,
          pausas: 0,
          reverificacoes: 0,
        },
      ],
    ]);
    // The re-drive is enqueue-only: it wrote nothing either.
    expect(db.writes).toEqual([]);
  });

  it('a espera do SERPRO chega ao desfecho: autorizada há 60 s ⇒ `atrasoSegundos: 300`', async () => {
    cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - 60_000 }) } });
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    expect((await responder(corpo())).body.nfe).toStrictEqual({
      desfecho: 'enfileirado',
      atrasoSegundos: 300,
    });
  });

  it('`nao-elegivel` carrega o motivo DA NF-e (`emissao-bloqueada`) — e nada é enfileirado', async () => {
    cenario({ pedido: pedidoRaw({ bloquearEmissaoNFe: true }) });
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body.nfe).toStrictEqual({
      desfecho: 'nao-elegivel',
      motivoNfe: MOTIVO_NFE_SHOPEE.emissaoBloqueada,
    });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('sem NF-e aprovada ⇒ `nao-elegivel` com `sem-nfe-aprovada`', async () => {
    cenario({ nfes: {} });
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    expect((await responder(corpo())).body.nfe).toStrictEqual({
      desfecho: 'nao-elegivel',
      motivoNfe: MOTIVO_NFE_SHOPEE.semNfeAprovada,
    });
  });

  it('R1-F2 PAR: sem NF-e aprovada ⇒ a frase pede a EMISSÃO da NF-e — nunca um aviso que não existe', async () => {
    cenario({ nfes: {} });
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    const { body } = await responder(corpo());
    const mensagem = String(body.mensagem);
    expect(mensagem).toContain('emita a NF-e do pedido e clique em Imprimir de novo');
    expect(mensagem).not.toContain('aviso');
  });

  it('R1-F2 QUASE-MISS: `emissao-bloqueada` mantém a frase do aviso de NF-e, sem pedir emissão', async () => {
    cenario({ pedido: pedidoRaw({ bloquearEmissaoNFe: true }) });
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    const { body } = await responder(corpo());
    const mensagem = String(body.mensagem);
    expect(mensagem).toContain('confira o aviso de NF-e do pedido');
    expect(mensagem).not.toContain('emita a NF-e');
  });

  it('a válvula da fila de NF-e (o agendador REAL com `SHOPEE_TASKS_DISABLED=1`) ⇒ `desligado`, ainda 409', async () => {
    cenario();
    autorizar(EXPEDICAO_COM_PEDIDO);
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    const real = h.real.criar;
    if (real === null) throw new Error('o módulo real do agendador não foi carregado');
    h.criar.mockImplementation(() => real());
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body.nfe).toStrictEqual({ desfecho: 'desligado' });
    expect(String(body.error)).not.toContain('SHOPEE_TASKS_DISABLED');
  });

  it('o 409 não carrega a chave, o XML nem o id do documento da NF-e', async () => {
    cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - 1_000 }) } });
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    const { body } = await responder(corpo());
    const texto = JSON.stringify(body);
    expect(texto).not.toContain(K);
    expect(texto).not.toContain('nfeProc');
    expect(texto).not.toContain(ORDER_SN);
    expect(body.nfe).not.toHaveProperty('nfeId');
  });

  it.each<[string, ResultadoEtiqueta]>([
    ['os bytes', bytes()],
    ['um 202 aguardar (cada POLL)', pendente(AGUARDAR)],
    ['um 202 escolher-envio', pendente(ESCOLHER)],
    ['uma recusa', { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.pacoteNaoPronto }],
    ['sem-permissao', { tipo: 'sem-permissao' }],
    ['formato-desconhecido', { tipo: 'formato-desconhecido' }],
  ])('S36: %s ⇒ o reenvio NÃO roda, mesmo com `pedido.write`', async (_rotulo, r) => {
    const db = cenario();
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue(r);
    await POST(req(corpo()));
    expect(h.reenviar).not.toHaveBeenCalled();
    expect(h.criar).not.toHaveBeenCalled();
    expect(db.caminhos).not.toContain(NFEV4_PATH);
  });
});

/* ----------------------------------- the errors --------------------------------- */

describe('os erros — `shopeeErrorResponse` INALTERADO, e o resto relança', () => {
  it('um erro de Shopee que o executor relança ⇒ o mapeamento existente (409 SHOPEE_REAUTH_REQUIRED)', async () => {
    cenario();
    h.executar.mockRejectedValue(new ShopeeSemCredencialError('sem credencial'));
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body.code).toBe('SHOPEE_REAUTH_REQUIRED');
  });

  it('`createShopClient` numa conta de conta-principal ⇒ 409 SHOPEE_CONTA_SEM_SHOP_ID, executor intocado', async () => {
    cenario();
    h.createShopClient.mockImplementation(() => {
      throw new ShopeeContaSemShopIdError('sem shop_id');
    });
    const { status, body } = await responder(corpo());
    expect(status).toBe(409);
    expect(body.code).toBe('SHOPEE_CONTA_SEM_SHOP_ID');
    expect(h.executar).not.toHaveBeenCalled();
  });

  it('um erro inesperado do executor relança (sem catch-all)', async () => {
    cenario();
    const falha = new Error('falha qualquer');
    h.executar.mockRejectedValue(falha);
    await expect(POST(req(corpo()))).rejects.toBe(falha);
  });

  it('um erro inesperado do reenvio relança — a resposta nunca finge um desfecho', async () => {
    cenario();
    autorizar(EXPEDICAO_COM_PEDIDO);
    h.executar.mockResolvedValue({ tipo: 'nfe-pendente' });
    const falha = new Error('fila indisponível');
    h.enqueue.mockRejectedValue(falha);
    await expect(POST(req(corpo()))).rejects.toBe(falha);
  });
});

/* ------------------------------------ PII --------------------------------------- */

describe('PII — nenhuma resposta JSON carrega o rastreio', () => {
  it('o 202 e o 409 não inventam o código de rastreio (a rota só repassa o que o executor montou)', async () => {
    cenario();
    h.executar.mockResolvedValue(pendente(AGUARDAR));
    const aguardando = JSON.stringify((await responder(corpo())).body);
    h.executar.mockResolvedValue({ tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.janelaFechada });
    const recusado = JSON.stringify((await responder(corpo())).body);
    for (const texto of [aguardando, recusado]) {
      expect(texto).not.toContain(RASTREIO);
      expect(texto).not.toContain(ORDER_SN);
    }
  });
});
