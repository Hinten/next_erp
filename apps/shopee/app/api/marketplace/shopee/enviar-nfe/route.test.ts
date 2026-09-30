/**
 * `POST /api/marketplace/shopee/enviar-nfe` (#1522, step 14; reconcile §2.9 +
 * R-r, D3 §1). The route is ENQUEUE-ONLY: every case runs the real gates over
 * the shared fake Firestore and a RECORDING scheduler, and proves by the double's
 * own logs what the route read, that it wrote nothing, built no client and
 * reached no network.
 *
 * A predicate case names a PAIR (must answer the same) and a NEAR-MISS (must
 * stay distinct) in its title.
 *
 * ⚠️ Fixture keys are SYNTHETIC and visibly fake — cUF `99` (no such UF) and a
 * CNPJ of repeated digits — assembled field by field; the ids are the repo's
 * fixture ids. Nothing here reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PERM } from '@delfrance/auth';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  integracaoCollection,
  nfev4Collection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { ESTADO_NFE, INTEGRACAO_TIPO, decideNfeUploadTransition } from '@delfrance/schemas';

import { MSG_BODY_INVALIDO } from '@/lib/shopee/produtos/corpoImportacao';
import { ATRASO_SERPRO_S, atrasoSerproS } from '@/lib/shopee/nfe/constantesNfe';
import {
  MOTIVO_NFE_SHOPEE,
  mensagemDoMotivoNfe,
  type MotivoNfeShopee,
} from '@/lib/shopee/nfe/errosNfe';
import {
  FASE_NFE_SHOPEE,
  tarefaNfeShopeeSchema,
  type AgendadorNfeShopee,
} from '@/lib/shopee/nfe/tarefaNfe';
import { makePedidoIdShopee } from '@/lib/shopee/pedidos/orderIds';
import { ShopeeTasksDisabledError } from '@/lib/shopee/shopeeTasks';
import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

type ModuloAgendador = typeof import('@/lib/shopee/nfe/shopeeNfeUploadTasks');

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  criar: vi.fn(),
  enqueue: vi.fn(),
  real: { criar: null as (() => AgendadorNfeShopee) | null },
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

// The context loader is where a client (and a token read) would start: a spy
// that the route must never call.
vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

// The scheduler defaults to a RECORDER; the valve case swaps in the REAL one.
vi.mock('@/lib/shopee/nfe/shopeeNfeUploadTasks', async (importActual) => {
  const actual = await importActual<ModuloAgendador>();
  h.real.criar = actual.createShopeeNfeUploadScheduler;
  return { ...actual, createShopeeNfeUploadScheduler: h.criar };
});

const { POST, MSG_NFE_NAO_ENCONTRADA } = await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = pedidoCollection.docPath({}, PEDIDO_ID);
const INTEGRACAO_PATH = integracaoCollection.docPath({}, CONTA);
const NFEV4_PATH = nfev4Collection.resolvePath({ pedidoId: PEDIDO_ID });
const NOW_MS = 1_789_000_000_000;

/** A synthetic key: cUF 99 + AAMM + CNPJ + mod 55 + série + nNF + tpEmis + cNF + DV. */
function montarChave(nNF = '000000001'): string {
  return `99${'2609'}${'1'.repeat(14)}55${'000'}${nNF}1${'00000000'}0`;
}

const K = montarChave();

/** A minimal synthetic `nfeProc` — no signature, no real party anywhere. */
function procXml(o: { tpAmb?: string; tpNF?: string; finNFe?: string } = {}): string {
  const tpAmb = o.tpAmb ?? '1';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
    `<NFe><infNFe versao="4.00" Id="NFe${K}"><ide><cUF>99</cUF><mod>55</mod>`,
    `<tpNF>${o.tpNF ?? '1'}</tpNF><tpAmb>${tpAmb}</tpAmb><finNFe>${o.finNFe ?? '1'}</finNFe>`,
    '</ide><emit><xNome>TESTE SINTETICO SEM VALOR FISCAL</xNome></emit>',
    '</infNFe></NFe>',
    `<protNFe versao="4.00"><infProt><tpAmb>${tpAmb}</tpAmb><chNFe>${K}</chNFe>`,
    '<cStat>100</cStat></infProt></protNFe></nfeProc>',
  ].join('');
}

/** A proc with no `tpNF`/`finNFe` at all — illegible to the sale gate. */
const XML_ILEGIVEL = procXml()
  .replace(/<tpNF>1<\/tpNF>/, '')
  .replace(/<finNFe>1<\/finNFe>/, '');

function nfeRaw(o: DocData = {}): DocData {
  return {
    estado: ESTADO_NFE.aprovada,
    chave: K,
    xml_nfe_proc: procXml(),
    data_autorizacao: NOW_MS - 3_600_000,
    ...o,
  };
}

function pedidoRaw(o: DocData = {}): DocData {
  return {
    numero: ORDER_SN,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    bloquearEmissaoNFe: false,
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

const AUTORIZADO = { authorization: 'Bearer t' };
const EXPEDICAO = { uid: 'u1', permissions: PERM.pedido.write.toString() };

function req(corpo: unknown, headers: Record<string, string> = AUTORIZADO): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/enviar-nfe', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

async function responder(corpo: unknown, headers?: Record<string, string>) {
  const res = await POST(req(corpo, headers));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The payload the queue must carry for `nfeId` — built by name, every ledger at zero. */
function tarefaEsperada(nfeId = 's1') {
  return {
    pedidoId: PEDIDO_ID,
    nfeId,
    fase: FASE_NFE_SHOPEE.envio,
    adiamentosSerpro: 0,
    pausas: 0,
    reverificacoes: 0,
  };
}

/** The 409 body for `motivo`, exactly. */
function recusa(motivo: MotivoNfeShopee) {
  const mensagem = mensagemDoMotivoNfe(motivo);
  return { error: mensagem, code: 'SHOPEE_NFE_NAO_ELEGIVEL', motivo, mensagem };
}

let fetchSpy: MockInstance;

beforeEach(() => {
  __resetAllReadCaches();
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  h.verifyIdToken.mockReset().mockResolvedValue(EXPEDICAO);
  h.loadCtx.mockReset().mockRejectedValue(new Error('a rota não pode carregar o contexto'));
  h.enqueue.mockReset().mockResolvedValue(undefined);
  h.criar.mockReset().mockImplementation(() => ({ enqueue: h.enqueue }));
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('a rota não pode alcançar a rede'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/* ---------------------------------- auth ---------------------------------- */

describe('auth — `verifyCaller(req, PERM.pedido.write)`', () => {
  it('401 sem bearer, antes de qualquer leitura', async () => {
    const db = cenario();
    const { status } = await responder({ pedidoId: PEDIDO_ID }, {});
    expect(status).toBe(401);
    expect(db.caminhos).toEqual([]);
  });

  it('PAR: quem tem SÓ `pedido.write` (a expedição) enfileira — 202', async () => {
    cenario();
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.pedido.write.toString() });
    expect((await responder({ pedidoId: PEDIDO_ID })).status).toBe(202);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('QUASE-MISS: quem tem SÓ `integracao.write` (o bit das outras rotas Shopee) recebe 403, sem ler nada', async () => {
    const db = cenario();
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.integracao.write.toString() });
    expect((await responder({ pedidoId: PEDIDO_ID })).status).toBe(403);
    expect(db.caminhos).toEqual([]);
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('QUASE-MISS: `pedido.read` não basta — 403', async () => {
    cenario();
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.pedido.read.toString() });
    expect((await responder({ pedidoId: PEDIDO_ID })).status).toBe(403);
  });
});

/* --------------------------------- the body -------------------------------- */

describe('o corpo — todo degrau ANTES de qualquer leitura (400)', () => {
  it.each<[string, unknown, string]>([
    ['JSON malformado', '{"pedidoId":', MSG_BODY_INVALIDO],
    ['null', null, MSG_BODY_INVALIDO],
    ['um array', [PEDIDO_ID], MSG_BODY_INVALIDO],
    ['um escalar', 42, MSG_BODY_INVALIDO],
    ['sem pedidoId', {}, 'pedidoId deve ser um id de documento (sem "/" nem "..").'],
    [
      'pedidoId número',
      { pedidoId: 123 },
      'pedidoId deve ser um id de documento (sem "/" nem "..").',
    ],
    [
      'pedidoId vazio',
      { pedidoId: '' },
      'pedidoId deve ser um id de documento (sem "/" nem "..").',
    ],
    [
      'pedidoId com `/` (outro documento)',
      { pedidoId: `${PEDIDO_ID}/nfev4/s1` },
      'pedidoId deve ser um id de documento (sem "/" nem "..").',
    ],
    [
      'pedidoId `..`',
      { pedidoId: '..' },
      'pedidoId deve ser um id de documento (sem "/" nem "..").',
    ],
    [
      'nfeId vazio',
      { pedidoId: PEDIDO_ID, nfeId: '' },
      'nfeId, quando informado, deve ser um id de documento (sem "/" nem "..").',
    ],
    [
      'nfeId com `/`',
      { pedidoId: PEDIDO_ID, nfeId: 's1/x' },
      'nfeId, quando informado, deve ser um id de documento (sem "/" nem "..").',
    ],
    [
      'nfeId número',
      { pedidoId: PEDIDO_ID, nfeId: 1 },
      'nfeId, quando informado, deve ser um id de documento (sem "/" nem "..").',
    ],
    [
      'uma `fase` no corpo — nunca repassada, nem ignorada em silêncio',
      { pedidoId: PEDIDO_ID, fase: FASE_NFE_SHOPEE.reverificacao },
      'O corpo aceita apenas pedidoId e nfeId.',
    ],
    [
      'a MESMA `fase` da rota (`envio`) — o corpo é estrito por CHAVE, não por valor',
      { pedidoId: PEDIDO_ID, fase: FASE_NFE_SHOPEE.envio },
      'O corpo aceita apenas pedidoId e nfeId.',
    ],
    [
      'um contador no corpo',
      { pedidoId: PEDIDO_ID, adiamentosSerpro: 3 },
      'O corpo aceita apenas pedidoId e nfeId.',
    ],
  ])('%s ⇒ 400, zero leituras, nada enfileirado', async (_rotulo, corpo, erro) => {
    const db = cenario();
    const { status, body } = await responder(corpo);
    expect(status).toBe(400);
    expect(body).toEqual({ error: erro });
    expect(db.caminhos).toEqual([]);
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('PAR: `nfeId: null` é "sem nfeId" — a regra de escolha decide, 202', async () => {
    cenario();
    const { status, body } = await responder({ pedidoId: PEDIDO_ID, nfeId: null });
    expect(status).toBe(202);
    expect(body.nfeId).toBe('s1');
  });
});

/* --------------------------------- the gates -------------------------------- */

describe('os portões antes do enfileiramento (409 `SHOPEE_NFE_NAO_ELEGIVEL`)', () => {
  it('o pedido que não existe ⇒ `pedido-nao-encontrado`, e nenhuma NF-e é lida', async () => {
    const db = cenario({ pedido: null });
    const { status, body } = await responder({ pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(status).toBe(409);
    expect(body).toEqual(recusa(MOTIVO_NFE_SHOPEE.pedidoNaoEncontrado));
    expect(db.caminhos.some((c) => c.includes('/nfev4'))).toBe(false);
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('QUASE-MISS: os MESMOS campos sob um id que não é o digest de (conta, order_sn) ⇒ `nao-shopee`, sem listar NF-e', async () => {
    const db = cenario({ pedidoId: 'pedido-de-outro-canal' });
    const { status, body } = await responder({ pedidoId: 'pedido-de-outro-canal' });
    expect(status).toBe(409);
    expect(body).toEqual(recusa(MOTIVO_NFE_SHOPEE.naoShopee));
    expect(db.caminhos.some((c) => c.includes('/nfev4'))).toBe(false);
  });

  it('PAR: os mesmos campos sob o digest ⇒ 202', async () => {
    cenario();
    expect((await responder({ pedidoId: PEDIDO_ID })).status).toBe(202);
  });

  it('`bloquearEmissaoNFe` ⇒ `emissao-bloqueada`', async () => {
    cenario({ pedido: pedidoRaw({ bloquearEmissaoNFe: true }) });
    expect((await responder({ pedidoId: PEDIDO_ID })).body).toEqual(
      recusa(MOTIVO_NFE_SHOPEE.emissaoBloqueada),
    );
  });

  it.each<[string, DocData | null, MotivoNfeShopee]>([
    ['a conta que não existe', null, MOTIVO_NFE_SHOPEE.contaNaoConfigurada],
    [
      'uma conta de OUTRO tipo',
      contaRaw({ tipo: INTEGRACAO_TIPO.mercadoLivre }),
      MOTIVO_NFE_SHOPEE.contaNaoConfigurada,
    ],
    ['uma conta desativada', contaRaw({ ativo: false }), MOTIVO_NFE_SHOPEE.contaInativa],
  ])('%s ⇒ 409, sem cliente e sem ler NF-e', async (_rotulo, conta, motivo) => {
    const db = cenario({ conta });
    const { status, body } = await responder({ pedidoId: PEDIDO_ID });
    expect(status).toBe(409);
    expect(body).toEqual(recusa(motivo));
    expect(db.caminhos.some((c) => c.includes('/nfev4'))).toBe(false);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it.each<[string, DocData, MotivoNfeShopee]>([
    ['cancelada', nfeRaw({ estado: ESTADO_NFE.cancelada }), MOTIVO_NFE_SHOPEE.naoAprovada],
    ['aprovada sem o proc', nfeRaw({ xml_nfe_proc: null }), MOTIVO_NFE_SHOPEE.xmlAusente],
    [
      'de HOMOLOGAÇÃO (tpAmb 2)',
      nfeRaw({ xml_nfe_proc: procXml({ tpAmb: '2' }) }),
      MOTIVO_NFE_SHOPEE.tpambHomologacao,
    ],
    [
      'uma DEVOLUÇÃO (finNFe 4) de produção',
      nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }) }),
      MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda,
    ],
    [
      'uma ENTRADA (tpNF 0) de produção',
      nfeRaw({ xml_nfe_proc: procXml({ tpNF: '0' }) }),
      MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda,
    ],
  ])('`nfeId` explícito %s ⇒ 409 com o motivo exato', async (_rotulo, nfe, motivo) => {
    cenario({ nfes: { s1: nfe } });
    const { status, body } = await responder({ pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(status).toBe(409);
    expect(body).toEqual(recusa(motivo));
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('`nfeId` explícito que não existe ⇒ 404 `SHOPEE_NFE_NAO_ENCONTRADA`, com a frase DA ROTA', async () => {
    cenario();
    const { status, body } = await responder({ pedidoId: PEDIDO_ID, nfeId: 's9' });
    expect(status).toBe(404);
    expect(body).toEqual({ error: MSG_NFE_NAO_ENCONTRADA, code: 'SHOPEE_NFE_NAO_ENCONTRADA' });
    // Review 2, S3-4 — QUASE-IGUAL: the handler's P1 phrase speaks of a note
    // deleted after an upload was SCHEDULED; at the route nothing was.
    expect((body as { error: string }).error).not.toBe(
      mensagemDoMotivoNfe(MOTIVO_NFE_SHOPEE.nfeNaoEncontrada),
    );
    expect((body as { error: string }).error).not.toMatch(/depois que o envio foi agendado/);
    expect((body as { error: string }).error).toMatch(/nada foi agendado/);
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('o predicado é de NÍVEL: um documento que JÁ estava pronto (o gatilho diria `ja-pronta`) enfileira', async () => {
    cenario();
    // The transition helper refuses exactly this document — the population the
    // route exists for.
    expect(decideNfeUploadTransition(nfeRaw(), nfeRaw())).toEqual({
      action: 'skip',
      reason: 'ja-pronta',
    });
    expect((await responder({ pedidoId: PEDIDO_ID, nfeId: 's1' })).status).toBe(202);
  });

  it('um proc ILEGÍVEL ao portão de venda passa — o manipulador responde com aviso e carimbo', async () => {
    cenario({ nfes: { s1: nfeRaw({ xml_nfe_proc: XML_ILEGIVEL }) } });
    expect((await responder({ pedidoId: PEDIDO_ID, nfeId: 's1' })).status).toBe(202);
  });

  it('sem `nfeId` e sem NF-e nenhuma ⇒ `sem-nfe-aprovada`', async () => {
    cenario({ nfes: {} });
    const { status, body } = await responder({ pedidoId: PEDIDO_ID });
    expect(status).toBe(409);
    expect(body).toEqual(recusa(MOTIVO_NFE_SHOPEE.semNfeAprovada));
  });

  it('sem `nfeId`, só uma devolução ⇒ `nfe-nao-e-de-venda` (o motivo mais próximo, não o primeiro)', async () => {
    cenario({
      nfes: {
        d1: nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }) }),
        c0: nfeRaw({ estado: ESTADO_NFE.cancelada }),
      },
    });
    expect((await responder({ pedidoId: PEDIDO_ID })).body).toEqual(
      recusa(MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda),
    );
  });

  it('sem `nfeId`, a regra de escolha pela LISTAGEM: a devolução ao lado de `s1` é ignorada', async () => {
    const db = cenario({
      nfes: {
        d1: nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }), data_autorizacao: NOW_MS - 1_000 }),
        s1: nfeRaw(),
      },
    });
    const { status, body } = await responder({ pedidoId: PEDIDO_ID });
    expect(status).toBe(202);
    expect(body.nfeId).toBe('s1');
    expect(db.caminhos).toContain(NFEV4_PATH);
    expect(h.enqueue).toHaveBeenCalledWith(tarefaEsperada('s1'));
  });
});

/* -------------------------------- the delay -------------------------------- */

describe('a espera do SERPRO — só com o instante de autorização CONHECIDO', () => {
  it('PAR: autorizada há 60 s ⇒ a opção carrega o que falta da janela (300 s)', async () => {
    cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - 60_000 }) } });
    const { status, body } = await responder({ pedidoId: PEDIDO_ID });
    expect(status).toBe(202);
    expect(atrasoSerproS(NOW_MS - 60_000, NOW_MS)).toBe(300);
    expect(body.atrasoSegundos).toBe(300);
    expect(h.enqueue.mock.calls).toEqual([[tarefaEsperada(), { scheduleDelaySeconds: 300 }]]);
  });

  it('QUASE-MISS: autorizada há uma hora ⇒ a opção é OMITIDA (uma chamada de um argumento)', async () => {
    cenario();
    const { body } = await responder({ pedidoId: PEDIDO_ID });
    expect(body.atrasoSegundos).toBe(0);
    expect(h.enqueue.mock.calls).toEqual([[tarefaEsperada()]]);
    expect(h.enqueue.mock.calls[0]).toHaveLength(1);
  });

  it('a fronteira: 359 s depois ⇒ 1 s de espera; 360 s depois ⇒ nenhuma', async () => {
    cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - 359_000 }) } });
    expect((await responder({ pedidoId: PEDIDO_ID })).body.atrasoSegundos).toBe(1);
    expect(h.enqueue.mock.calls[0]?.[1]).toEqual({ scheduleDelaySeconds: 1 });

    h.enqueue.mockClear();
    cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - ATRASO_SERPRO_S * 1_000 }) } });
    expect((await responder({ pedidoId: PEDIDO_ID })).body.atrasoSegundos).toBe(0);
    expect(h.enqueue.mock.calls[0]).toHaveLength(1);
  });

  it('uma autorização no FUTURO (relógios divergentes) espera a janela inteira, nunca mais', async () => {
    cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS + 60_000 }) } });
    expect((await responder({ pedidoId: PEDIDO_ID })).body.atrasoSegundos).toBe(ATRASO_SERPRO_S);
  });

  it.each<[string, DocData]>([
    ['`null`', { data_autorizacao: null }],
    ['ausente', { data_autorizacao: undefined }],
    ['ilegível', { data_autorizacao: 'não é uma data' }],
  ])(
    'instante DESCONHECIDO (%s) ⇒ enfileira agora, sem opção — nunca recusa, nunca segura 360 s',
    async (_rotulo, o) => {
      const nfe = nfeRaw(o);
      if (o.data_autorizacao === undefined) delete nfe.data_autorizacao;
      cenario({ nfes: { s1: nfe } });
      const { status, body } = await responder({ pedidoId: PEDIDO_ID, nfeId: 's1' });
      expect(status).toBe(202);
      expect(body.atrasoSegundos).toBe(0);
      expect(h.enqueue.mock.calls).toEqual([[tarefaEsperada()]]);
    },
  );
});

/* ------------------------- the payload and the answer ------------------------ */

describe('a tarefa e a resposta — construídas por NOME', () => {
  it('a carga é exatamente `{pedidoId, nfeId, fase: envio, contadores 0}` e passa o schema estrito sem mudar', async () => {
    cenario();
    const { status, body } = await responder({ pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(status).toBe(202);
    expect(body).toStrictEqual({
      enfileirado: true,
      pedidoId: PEDIDO_ID,
      nfeId: 's1',
      atrasoSegundos: 0,
    });
    const [carga] = h.enqueue.mock.calls[0] ?? [];
    expect(carga).toStrictEqual(tarefaEsperada());
    expect(tarefaNfeShopeeSchema.parse(carga)).toStrictEqual(carga);
  });

  it('nenhuma resposta carrega a chave, o XML ou o número do pedido na Shopee', async () => {
    cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - 1_000 }) } });
    const aceito = JSON.stringify((await responder({ pedidoId: PEDIDO_ID })).body);
    cenario({ nfes: { s1: nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }) }) } });
    const recusado = JSON.stringify((await responder({ pedidoId: PEDIDO_ID })).body);
    for (const texto of [aceito, recusado]) {
      expect(texto).not.toContain(K);
      expect(texto).not.toContain(ORDER_SN);
      expect(texto).not.toContain('nfeProc');
      expect(texto).not.toMatch(/\d{44}/);
    }
  });

  it('enqueue-only: zero escritas, nenhum contexto/cliente, nenhuma rede, nada sob `credenciais`', async () => {
    const db = cenario();
    expect((await responder({ pedidoId: PEDIDO_ID })).status).toBe(202);
    expect(db.writes).toEqual([]);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.caminhos.some((c) => c.includes('credenciais'))).toBe(false);
    // Exactly the three reads (each path's collection handle included): the
    // pedido, the conta, the NF-e listing.
    expect(new Set(db.caminhos)).toEqual(
      new Set([
        pedidoCollection.resolvePath({}),
        PEDIDO_PATH,
        integracaoCollection.resolvePath({}),
        INTEGRACAO_PATH,
        NFEV4_PATH,
      ]),
    );
  });
});

/* ----------------------------- the valve, the rest ---------------------------- */

describe('a válvula e os demais erros', () => {
  it('a válvula da fila de NF-e (o agendador REAL com `SHOPEE_TASKS_DISABLED=1`) ⇒ 503', async () => {
    const db = cenario();
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    const real = h.real.criar;
    if (real === null) throw new Error('o módulo real do agendador não foi carregado');
    h.criar.mockImplementation(() => real());
    const { status, body } = await responder({ pedidoId: PEDIDO_ID });
    expect(status).toBe(503);
    expect(body.code).toBe('SHOPEE_NFE_ENFILEIRAMENTO_DESLIGADO');
    expect(String(body.error)).not.toContain('SHOPEE_TASKS_DISABLED');
    expect(db.writes).toEqual([]);
  });

  it('QUASE-MISS: a classe de válvula COMPARTILHADA do canal não é a desta fila — relança, nunca 503', async () => {
    cenario();
    h.enqueue.mockRejectedValue(new ShopeeTasksDisabledError());
    await expect(POST(req({ pedidoId: PEDIDO_ID }))).rejects.toBeInstanceOf(
      ShopeeTasksDisabledError,
    );
  });

  it('um erro inesperado do enfileiramento relança (sem catch-all)', async () => {
    cenario();
    const falha = new Error('fila indisponível');
    h.enqueue.mockRejectedValue(falha);
    await expect(POST(req({ pedidoId: PEDIDO_ID }))).rejects.toBe(falha);
  });
});
