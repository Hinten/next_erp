/**
 * `reenviarNfeDoPedidoShopee` (#1522 → #1523, step 15): the NF-e re-drive
 * extracted from the `enviar-nfe` route so the label route runs the SAME
 * ladder. The route stays proved by its unedited `route.test.ts`; here each arm
 * of the union is driven DIRECTLY, over the shared `FakeDb` and a RECORDING
 * scheduler, with no HTTP in between.
 *
 * A predicate case names a PAIR (must answer the same) and a NEAR-MISS (must
 * stay distinct) in its title.
 *
 * ⚠️ Fixture keys are SYNTHETIC and visibly fake — cUF `99` (no such UF) and a
 * CNPJ of repeated digits — assembled field by field; the ids are the repo's
 * fixture ids. Nothing here reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  integracaoCollection,
  nfev4Collection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { ESTADO_NFE, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { makePedidoIdShopee } from '../pedidos/orderIds';
import { ShopeeTasksDisabledError } from '../shopeeTasks';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import { ATRASO_SERPRO_S } from './constantesNfe';
import {
  MOTIVO_NFE_SHOPEE,
  ShopeeNfeUploadTasksDisabledError,
  type MotivoNfeShopee,
} from './errosNfe';
import { FASE_NFE_SHOPEE, tarefaNfeShopeeSchema } from './tarefaNfe';

const h = vi.hoisted(() => ({ criar: vi.fn(), enqueue: vi.fn() }));

// The scheduler is a RECORDER: the re-drive's only effect is this enqueue.
vi.mock('./shopeeNfeUploadTasks', () => ({ createShopeeNfeUploadScheduler: h.criar }));

const { reenviarNfeDoPedidoShopee } = await import('./reenvioNfe');

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const INTEGRACAO_PATH = integracaoCollection.docPath({}, CONTA);
const NFEV4_PATH = nfev4Collection.resolvePath({ pedidoId: PEDIDO_ID });
/** The caller's one clock read; the re-drive must never read its own. */
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
  return db;
}

function reenviar(db: FakeDb, o: { pedidoId?: string; nfeId?: string | null } = {}) {
  return reenviarNfeDoPedidoShopee(asDb(db), {
    pedidoId: o.pedidoId ?? PEDIDO_ID,
    nfeId: o.nfeId ?? null,
    nowMs: NOW_MS,
  });
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

function naoElegivel(motivo: MotivoNfeShopee) {
  return { tipo: 'nao-elegivel', motivo };
}

beforeEach(() => {
  __resetAllReadCaches();
  h.enqueue.mockReset().mockResolvedValue(undefined);
  h.criar.mockReset().mockImplementation(() => ({ enqueue: h.enqueue }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------- `enfileirado` ------------------------------ */

describe('`enfileirado` — o documento elegível vai para a fila', () => {
  it('com `nfeId` explícito: a carga por NOME, estrita, e a união exata', async () => {
    const db = cenario();
    const r = await reenviar(db, { nfeId: 's1' });
    expect(r).toStrictEqual({ tipo: 'enfileirado', nfeId: 's1', atrasoSegundos: 0 });
    expect(h.enqueue.mock.calls).toEqual([[tarefaEsperada()]]);
    const [carga] = h.enqueue.mock.calls[0] ?? [];
    expect(tarefaNfeShopeeSchema.parse(carga)).toStrictEqual(carga);
  });

  it('sem `nfeId`: a regra de escolha pela LISTAGEM — a devolução ao lado de `s1` é ignorada', async () => {
    const db = cenario({
      nfes: {
        d1: nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }), data_autorizacao: NOW_MS - 1_000 }),
        s1: nfeRaw(),
      },
    });
    expect(await reenviar(db)).toStrictEqual({
      tipo: 'enfileirado',
      nfeId: 's1',
      atrasoSegundos: 0,
    });
    expect(db.caminhos).toContain(NFEV4_PATH);
    expect(h.enqueue).toHaveBeenCalledWith(tarefaEsperada('s1'));
  });

  it('PAR: autorizada há 60 s pelo `nowMs` DADO ⇒ 300 s de espera, e a opção vai junto', async () => {
    // The clock is the PARAMETER: the process clock is set one hour AHEAD, so a
    // re-drive that read it would see a 61-minute-old note and wait nothing.
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + 3_600_000);
    const db = cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS - 60_000 }) } });
    expect(await reenviar(db)).toStrictEqual({
      tipo: 'enfileirado',
      nfeId: 's1',
      atrasoSegundos: 300,
    });
    expect(h.enqueue.mock.calls).toEqual([[tarefaEsperada(), { scheduleDelaySeconds: 300 }]]);
  });

  it('QUASE-MISS: autorizada há uma hora ⇒ zero, e a opção é OMITIDA (uma chamada de um argumento)', async () => {
    const db = cenario();
    expect(await reenviar(db)).toMatchObject({ atrasoSegundos: 0 });
    expect(h.enqueue.mock.calls[0]).toHaveLength(1);
  });

  it.each<[string, DocData]>([
    ['`null`', { data_autorizacao: null }],
    ['ilegível', { data_autorizacao: 'não é uma data' }],
  ])('instante DESCONHECIDO (%s) ⇒ enfileira agora, nunca segura a janela', async (_r, o) => {
    const db = cenario({ nfes: { s1: nfeRaw(o) } });
    expect(await reenviar(db, { nfeId: 's1' })).toStrictEqual({
      tipo: 'enfileirado',
      nfeId: 's1',
      atrasoSegundos: 0,
    });
    expect(h.enqueue.mock.calls).toEqual([[tarefaEsperada()]]);
  });

  it('uma autorização no FUTURO espera a janela inteira, nunca mais', async () => {
    const db = cenario({ nfes: { s1: nfeRaw({ data_autorizacao: NOW_MS + 60_000 }) } });
    expect(await reenviar(db)).toMatchObject({ atrasoSegundos: ATRASO_SERPRO_S });
  });

  it('enqueue-only: zero escritas e exatamente as três leituras (pedido, conta, listagem)', async () => {
    const db = cenario();
    await reenviar(db);
    expect(db.writes).toEqual([]);
    expect(new Set(db.caminhos)).toEqual(
      new Set([
        pedidoCollection.resolvePath({}),
        pedidoCollection.docPath({}, PEDIDO_ID),
        integracaoCollection.resolvePath({}),
        INTEGRACAO_PATH,
        NFEV4_PATH,
      ]),
    );
  });
});

/* ------------------------------- `nao-elegivel` ----------------------------- */

describe('`nao-elegivel` — o motivo exato, e nada enfileirado', () => {
  it('o pedido que não existe ⇒ `pedido-nao-encontrado`, e nenhuma NF-e é lida', async () => {
    const db = cenario({ pedido: null });
    expect(await reenviar(db, { nfeId: 's1' })).toStrictEqual(
      naoElegivel(MOTIVO_NFE_SHOPEE.pedidoNaoEncontrado),
    );
    expect(db.caminhos.some((c) => c.includes('/nfev4'))).toBe(false);
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('QUASE-MISS: os MESMOS campos sob um id que não é o digest de (conta, order_sn) ⇒ `nao-shopee`', async () => {
    const db = cenario({ pedidoId: 'pedido-de-outro-canal' });
    expect(await reenviar(db, { pedidoId: 'pedido-de-outro-canal' })).toStrictEqual(
      naoElegivel(MOTIVO_NFE_SHOPEE.naoShopee),
    );
    expect(db.caminhos.some((c) => c.includes('/nfev4'))).toBe(false);
  });

  it('`bloquearEmissaoNFe` ⇒ `emissao-bloqueada`', async () => {
    const db = cenario({ pedido: pedidoRaw({ bloquearEmissaoNFe: true }) });
    expect(await reenviar(db)).toStrictEqual(naoElegivel(MOTIVO_NFE_SHOPEE.emissaoBloqueada));
  });

  it.each<[string, DocData | null, MotivoNfeShopee]>([
    ['a conta que não existe', null, MOTIVO_NFE_SHOPEE.contaNaoConfigurada],
    [
      'uma conta de OUTRO tipo',
      contaRaw({ tipo: INTEGRACAO_TIPO.mercadoLivre }),
      MOTIVO_NFE_SHOPEE.contaNaoConfigurada,
    ],
    ['uma conta desativada', contaRaw({ ativo: false }), MOTIVO_NFE_SHOPEE.contaInativa],
  ])('%s ⇒ o motivo, sem ler NF-e', async (_r, conta, motivo) => {
    const db = cenario({ conta });
    expect(await reenviar(db)).toStrictEqual(naoElegivel(motivo));
    expect(db.caminhos.some((c) => c.includes('/nfev4'))).toBe(false);
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
      'uma DEVOLUÇÃO (finNFe 4)',
      nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }) }),
      MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda,
    ],
  ])('`nfeId` explícito %s ⇒ o motivo exato', async (_r, nfe, motivo) => {
    const db = cenario({ nfes: { s1: nfe } });
    expect(await reenviar(db, { nfeId: 's1' })).toStrictEqual(naoElegivel(motivo));
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('PAR: um proc ILEGÍVEL ao portão de venda passa — o manipulador responde com aviso e carimbo', async () => {
    const ilegivel = procXml()
      .replace(/<tpNF>1<\/tpNF>/, '')
      .replace(/<finNFe>1<\/finNFe>/, '');
    const db = cenario({ nfes: { s1: nfeRaw({ xml_nfe_proc: ilegivel }) } });
    expect(await reenviar(db, { nfeId: 's1' })).toMatchObject({ tipo: 'enfileirado' });
  });

  it('sem `nfeId` e sem NF-e nenhuma ⇒ `sem-nfe-aprovada`', async () => {
    const db = cenario({ nfes: {} });
    expect(await reenviar(db)).toStrictEqual(naoElegivel(MOTIVO_NFE_SHOPEE.semNfeAprovada));
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('a união de recusa não carrega a chave, o XML nem o número do pedido', async () => {
    const db = cenario({ nfes: { s1: nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }) }) } });
    const texto = JSON.stringify(await reenviar(db, { nfeId: 's1' }));
    expect(texto).not.toContain(K);
    expect(texto).not.toContain(ORDER_SN);
    expect(texto).not.toContain('nfeProc');
  });
});

/* ---------------------------- `nfe-nao-encontrada` -------------------------- */

describe('`nfe-nao-encontrada` — só para um `nfeId` EXPLÍCITO ausente', () => {
  it('`nfeId` explícito que não existe ⇒ `nfe-nao-encontrada`, nada enfileirado', async () => {
    const db = cenario();
    expect(await reenviar(db, { nfeId: 's9' })).toStrictEqual({ tipo: 'nfe-nao-encontrada' });
    expect(h.criar).not.toHaveBeenCalled();
  });

  it('QUASE-MISS: SEM `nfeId` e sem documento é recusa de elegibilidade, não `nfe-nao-encontrada`', async () => {
    const db = cenario({ nfes: {} });
    expect(await reenviar(db)).not.toStrictEqual({ tipo: 'nfe-nao-encontrada' });
  });
});

/* -------------------------------- `desligado` ------------------------------- */

describe('`desligado` — só a válvula DESTA fila', () => {
  it('a válvula da fila de NF-e ⇒ `desligado`, sem escrita', async () => {
    const db = cenario();
    h.enqueue.mockRejectedValue(new ShopeeNfeUploadTasksDisabledError());
    expect(await reenviar(db)).toStrictEqual({ tipo: 'desligado' });
    expect(db.writes).toEqual([]);
  });

  it('QUASE-MISS: a válvula COMPARTILHADA do canal relança — nunca `desligado`', async () => {
    const db = cenario();
    h.enqueue.mockRejectedValue(new ShopeeTasksDisabledError());
    await expect(reenviar(db)).rejects.toBeInstanceOf(ShopeeTasksDisabledError);
  });

  it('um erro inesperado do enfileiramento relança (sem catch-all)', async () => {
    const db = cenario();
    const falha = new Error('fila indisponível');
    h.enqueue.mockRejectedValue(falha);
    await expect(reenviar(db)).rejects.toBe(falha);
  });

  it('um erro na CONSTRUÇÃO do agendador também relança', async () => {
    const db = cenario();
    const falha = new RangeError('região ausente');
    h.criar.mockImplementation(() => {
      throw falha;
    });
    await expect(reenviar(db)).rejects.toBe(falha);
  });
});
