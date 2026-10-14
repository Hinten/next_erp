/**
 * `redriveDeferredSemContaForShopId` (#1528, step 20 — o gêmeo Shopee do #808)
 * sobre o `FakeDb` compartilhado e o pipeline REAL: o store que grava a linha
 * adiada, o `mergeIfExists` do re-drive e a varredura quente que a consome.
 *
 * Nada aqui é mockado: o resolvedor de conta (`core/contaCache`) é o real sobre
 * o `FakeDb`, e é isso que faz do T35 uma ida e volta — a linha nasce adiada
 * pelo `handleTask` de verdade e morre importada pela varredura de verdade.
 *
 * IDs reconcile §4.1: T30, T31, T32, T35.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { notificacaoShopeeCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, NOTIFICACAO_RESILIENCIA_STATUS } from '@delfrance/schemas';

import type {
  AlvoDeImportacaoShopee,
  ResultadoImportacaoPedidoShopee,
} from '../pedidos/importarPedido';
import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  type ShopeeProcessDeps,
  REDRIVE_SEM_CONTA_LEITURA,
  REDRIVE_SEM_CONTA_LIMIT,
  handleNotificationTask,
  motivoSemConta,
  parseNotificationBody,
  redriveDeferredSemContaForShopId,
  reprocessNotifications,
} from './notificacao';

/* -------------------------------------------------------------------------- */
/*  Fixtures — valores inventados. Nenhum shop id, pedido ou conta real.       */
/* -------------------------------------------------------------------------- */

const SHOP_ID = 987654;
const SHOP_ID_2 = 987655;
const INTEGRACAO_ID = 'int-1';
const AGORA_MS = 1_760_000_000_000;
/** O formato de `order_sn` dos exemplos da Shopee — não é um pedido real. */
const ORDER_SN = '220810QSK8S7BX';

const COL = notificacaoShopeeCollection.resolvePath({});
const DEFERRED = NOTIFICACAO_RESILIENCIA_STATUS.deferred;
const FAILED = NOTIFICACAO_RESILIENCIA_STATUS.failed;
const PARKED = NOTIFICACAO_RESILIENCIA_STATUS.parked;

/** O `erro` que o re-drive grava — o texto do seam, byte a byte. */
const ERRO_REDRIVE = `loja ${String(SHOP_ID)} resolvível — reprocessando`;
const AVISO_TRUNCADO = '[shopee] redrive atingiu o limite — o restante sai na varredura diária';

/** Uma linha `deferred` `sem-conta` da loja, no formato que o store grava. */
function linha(over: DocData = {}): DocData {
  return {
    code: 3,
    shop_id: SHOP_ID,
    timestamp: AGORA_MS - 60_000,
    data: { ordersn: ORDER_SN },
    status: DEFERRED,
    tentativas: 2,
    erro: motivoSemConta(SHOP_ID),
    processedAt: AGORA_MS - 3_600_000,
    ...over,
  };
}

/** Semeia uma CÓPIA e devolve o original — o "antes" de cada comparação. */
function semear(db: FakeDb, id: string, over: DocData = {}): DocData {
  const dados = linha(over);
  db.seed(`${COL}/${id}`, { ...dados });
  return dados;
}

function dados(db: FakeDb, id: string): DocData | undefined {
  return db.store[`${COL}/${id}`]?.data;
}

/** Linhas de OUTRO tipo adiado da mesma loja, que dividem a página de leitura. */
function semearDevolucoes(db: FakeDb, n: number, prefixo = 'dev'): void {
  for (let i = 0; i < n; i += 1) {
    semear(db, `${prefixo}-${String(i).padStart(3, '0')}`, {
      code: 29,
      erro: 'devolucao: pedido ainda não importado — aguardando o code 3',
    });
  }
}

function semearSemConta(db: FakeDb, n: number, prefixo = 'sc'): void {
  for (let i = 0; i < n; i += 1) semear(db, `${prefixo}-${String(i).padStart(3, '0')}`);
}

function contarComStatus(db: FakeDb, status: string): number {
  return db.idsEm(COL).filter((id) => dados(db, id)?.status === status).length;
}

let avisos: unknown[][] = [];

beforeEach(() => {
  __resetAllReadCaches();
  avisos = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});

afterEach(() => {
  __resetAllReadCaches();
  vi.restoreAllMocks();
});

const avisosDeTruncado = (): unknown[][] => avisos.filter((a) => a[0] === AVISO_TRUNCADO);

describe('os dois tetos do re-drive', () => {
  it('lê 500 linhas por evento e move no máximo uma página quente (50)', () => {
    // Q3(a): 50, não 500 — um connect não pode segurar a faixa quente por horas
    // à frente das falhas reais. A página de leitura é MAIOR que o teto de
    // movimento de propósito (K1-F3): outros tipos adiados dividem a página.
    expect(REDRIVE_SEM_CONTA_LEITURA).toBe(500);
    expect(REDRIVE_SEM_CONTA_LIMIT).toBe(50);
  });
});

describe('T30 — só as linhas `sem-conta` desta loja, pela string EXATA', () => {
  it('re-conduz as linhas adiadas de shop_id NUMÉRICO cujo erro é motivoSemConta; os quase-acertos ficam intactos', async () => {
    const db = new FakeDb();
    // Os alvos: três braços que adiam `sem-conta` com shop_id no topo.
    const alvos: Record<string, DocData> = {
      'alvo-code3': semear(db, 'alvo-code3', { code: 3 }),
      'alvo-code4': semear(db, 'alvo-code4', {
        code: 4,
        data: { package_number: 'OFG0000000001' },
      }),
      'alvo-code29': semear(db, 'alvo-code29', {
        code: 29,
        data: { return_sn: '2609100000000001' },
      }),
    };

    // Os quase-acertos — cada um deve manter status, tentativas e erro.
    const quaseAcertos: Record<string, DocData> = {
      // mesma loja, outro tipo adiado (a precondição não é o connect)
      devolucao: semear(db, 'devolucao', {
        code: 29,
        erro: 'devolucao: pedido ainda não importado — aguardando o code 3',
      }),
      'pedido-adiado': semear(db, 'pedido-adiado', {
        erro: 'push_code 3: ShopeeReauthRequiredError — reconsentimento necessário',
      }),
      // o texto CONTÉM o motivo, mas não É o motivo — nada de `includes`/`endsWith`
      prefixado: semear(db, 'prefixado', { erro: `push_code 3: ${motivoSemConta(SHOP_ID)}` }),
      // a mesma frase sem um caractere — EXATO, sem dobra (#1372)
      'com-espaco': semear(db, 'com-espaco', { erro: `${motivoSemConta(SHOP_ID)} ` }),
      // shop_id gravado como STRING: a consulta é numérica, então não o encontra
      'shop-string': semear(db, 'shop-string', { shop_id: String(SHOP_ID) }),
      // ⚠️ o resíduo K1-F4: um code 1 cuja única loja veio de `data.shop_id_list`
      // é gravado com `shop_id: null` — esta consulta nunca o acha; só a faixa
      // diária o drena.
      'code1-lista': semear(db, 'code1-lista', {
        code: 1,
        shop_id: null,
        data: { shop_id_list: [SHOP_ID] },
      }),
      // a linha `sem-conta` de OUTRA loja
      'outra-loja': semear(db, 'outra-loja', {
        shop_id: SHOP_ID_2,
        erro: motivoSemConta(SHOP_ID_2),
      }),
      // fora da faixa adiada: a parada é terminal, a falha já está na faixa quente
      parada: semear(db, 'parada', { status: PARKED }),
      quente: semear(db, 'quente', { status: FAILED }),
    };

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    // encontradas = as adiadas de shop_id NUMÉRICO 987654: 3 alvos + devolucao,
    // pedido-adiado, prefixado, com-espaco.
    expect(r).toEqual({ encontradas: 7, semConta: 3, redirecionadas: 3, truncado: false });

    for (const [id, antes] of Object.entries(alvos)) {
      // O que o pipeline ESCREVEU (`store.redrive`), e só isso: os campos do
      // push (code, shop_id, timestamp, data) seguem como estavam.
      expect(dados(db, id), id).toEqual({
        ...antes,
        status: FAILED,
        tentativas: 0,
        erro: ERRO_REDRIVE,
        processedAt: 0,
      });
    }
    for (const [id, antes] of Object.entries(quaseAcertos)) {
      expect(dados(db, id), id).toEqual(antes);
    }
    // ÂNCORA: escreveu nos três alvos e em NENHUM outro lugar.
    expect(db.writes.map((w) => w.path).sort()).toEqual(
      [`${COL}/alvo-code29`, `${COL}/alvo-code3`, `${COL}/alvo-code4`].sort(),
    );
    expect(avisosDeTruncado()).toHaveLength(0);
  });

  it('a consulta é (status == deferred, shop_id == <NÚMERO>), lendo uma página de 500', async () => {
    const db = new FakeDb();
    semear(db, 'alvo');

    await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    // A forma que o guard D e o índice `notificacoesShopee (status, shop_id)`
    // descrevem. `shop_id` é NÚMERO dos dois lados (`z.number().int()`).
    expect(db.consultasCompletas).toEqual([
      {
        fonte: COL,
        clausulas: [
          ['status', '==', DEFERRED],
          ['shop_id', '==', SHOP_ID],
        ],
        ordens: [],
        limite: REDRIVE_SEM_CONTA_LEITURA,
        apos: null,
      },
    ]);
  });

  it('mistura de página (K1-F3): 60 adiadas de outro tipo ANTES de uma `sem-conta` — a `sem-conta` É re-conduzida', async () => {
    const db = new FakeDb();
    // O FakeDb devolve na ordem de inserção: as 60 vêm primeiro. Uma leitura de
    // `limit` (50) linhas seria preenchida só por elas e não moveria nada.
    semearDevolucoes(db, 60);
    semear(db, 'sem-conta-depois');

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    expect(r).toEqual({ encontradas: 61, semConta: 1, redirecionadas: 1, truncado: false });
    expect(dados(db, 'sem-conta-depois')).toMatchObject({ status: FAILED, tentativas: 0 });
    expect(contarComStatus(db, DEFERRED)).toBe(60);
  });

  it('uma linha apagada entre a consulta e a escrita NÃO é contada nem ressuscitada', async () => {
    const db = new FakeDb();
    semear(db, 'some');
    semear(db, 'fica');
    // O `update` do `mergeIfExists` falha NOT_FOUND — o documento sumiu depois
    // de a consulta o ter lido.
    db.falhasDeUpdate.set(`${COL}/some`, grpc(5, 'NOT_FOUND'));

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    expect(r).toEqual({ encontradas: 2, semConta: 2, redirecionadas: 1, truncado: false });
    expect(dados(db, 'fica')).toMatchObject({ status: FAILED });
  });

  it('uma falha transitória da consulta PROPAGA (o gatilho re-tenta) e nada é escrito', async () => {
    const db = new FakeDb();
    semear(db, 'alvo');
    const falha = grpc(14, 'UNAVAILABLE');
    db.falhas.set(SHOP_ID, falha);

    await expect(redriveDeferredSemContaForShopId(asDb(db), SHOP_ID)).rejects.toBe(falha);
    expect(db.writes).toHaveLength(0);
    expect(dados(db, 'alvo')).toMatchObject({ status: DEFERRED });
  });
});

describe('T31 — um replay não encontra nada para mover', () => {
  it('a segunda chamada lê as mesmas adiadas de outro tipo e não escreve nada', async () => {
    const db = new FakeDb();
    semearSemConta(db, 3);
    semearDevolucoes(db, 2);

    const primeira = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);
    expect(primeira).toEqual({ encontradas: 5, semConta: 3, redirecionadas: 3, truncado: false });
    const escritas = db.writes.length;

    const replay = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    expect(replay).toEqual({ encontradas: 2, semConta: 0, redirecionadas: 0, truncado: false });
    expect(db.writes).toHaveLength(escritas);
  });
});

describe('T32 — os tetos: `truncado` e o aviso', () => {
  it('500 linhas lidas (uma só `sem-conta`) ⇒ truncado e UM aviso', async () => {
    const db = new FakeDb();
    semearDevolucoes(db, REDRIVE_SEM_CONTA_LEITURA - 1);
    semear(db, 'unica');

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    // A página veio CHEIA: pode haver mais adiadas desta loja além dela.
    expect(r).toEqual({ encontradas: 500, semConta: 1, redirecionadas: 1, truncado: true });
    expect(avisosDeTruncado()).toEqual([
      [AVISO_TRUNCADO, { shopId: SHOP_ID, limit: REDRIVE_SEM_CONTA_LIMIT, leitura: 500 }],
    ]);
  });

  it('QUASE-ACERTO: 499 linhas lidas ⇒ a página não encheu, nada de aviso', async () => {
    const db = new FakeDb();
    semearDevolucoes(db, REDRIVE_SEM_CONTA_LEITURA - 2);
    semear(db, 'unica');

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    expect(r).toEqual({ encontradas: 499, semConta: 1, redirecionadas: 1, truncado: false });
    expect(avisosDeTruncado()).toHaveLength(0);
  });

  it('limit + 1 linhas `sem-conta` ⇒ exatamente `limit` movidas, truncado, UM aviso', async () => {
    const db = new FakeDb();
    semearSemConta(db, REDRIVE_SEM_CONTA_LIMIT + 1);

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    expect(r).toEqual({
      encontradas: REDRIVE_SEM_CONTA_LIMIT + 1,
      semConta: REDRIVE_SEM_CONTA_LIMIT + 1,
      redirecionadas: REDRIVE_SEM_CONTA_LIMIT,
      truncado: true,
    });
    expect(contarComStatus(db, FAILED)).toBe(REDRIVE_SEM_CONTA_LIMIT);
    expect(contarComStatus(db, DEFERRED)).toBe(1);
    expect(avisosDeTruncado()).toHaveLength(1);
  });

  it('exatamente `limit` linhas `sem-conta` ⇒ todas movidas, NÃO truncado (nada ficou para trás)', async () => {
    const db = new FakeDb();
    semearSemConta(db, REDRIVE_SEM_CONTA_LIMIT);

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    expect(r).toEqual({
      encontradas: REDRIVE_SEM_CONTA_LIMIT,
      semConta: REDRIVE_SEM_CONTA_LIMIT,
      redirecionadas: REDRIVE_SEM_CONTA_LIMIT,
      truncado: false,
    });
    expect(avisosDeTruncado()).toHaveLength(0);
  });

  it('limit − 1 linhas `sem-conta` ⇒ todas movidas, sem aviso', async () => {
    const db = new FakeDb();
    semearSemConta(db, REDRIVE_SEM_CONTA_LIMIT - 1);

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);

    expect(r.redirecionadas).toBe(REDRIVE_SEM_CONTA_LIMIT - 1);
    expect(r.truncado).toBe(false);
    expect(avisosDeTruncado()).toHaveLength(0);
  });

  it('um `limit` explícito é honrado, e o aviso o nomeia', async () => {
    const db = new FakeDb();
    semearSemConta(db, 3);

    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID, 2);

    expect(r).toEqual({ encontradas: 3, semConta: 3, redirecionadas: 2, truncado: true });
    expect(avisosDeTruncado()).toEqual([
      [AVISO_TRUNCADO, { shopId: SHOP_ID, limit: 2, leitura: REDRIVE_SEM_CONTA_LEITURA }],
    ]);
  });
});

describe('T35 — ida e volta pelo pipeline REAL', () => {
  function resultadoDeImportacao(): ResultadoImportacaoPedidoShopee {
    return {
      kind: 'pedido',
      acao: 'criado',
      orderSn: ORDER_SN,
      pedidoId: 'ped-abc',
      orderStatus: 'READY_TO_SHIP',
      itensSemProduto: 0,
      acaoPagamentos: 'criado',
      pagamentosGravados: 1,
      acaoFrete: 'atualizado',
      pacotesGravados: 1,
      detail: 'criado',
    };
  }

  function montar() {
    const db = new FakeDb();
    const importarPedido = vi.fn(async (_db: Firestore, _alvo: AlvoDeImportacaoShopee) =>
      resultadoDeImportacao(),
    );
    const deps: ShopeeProcessDeps = {
      partnerClient: () => {
        throw new Error('este teste não chama a Shopee');
      },
      increment: (by) => by,
      nowMs: () => AGORA_MS,
      importarPedido,
    };
    const payload = parseNotificationBody({
      code: 3,
      shop_id: SHOP_ID,
      timestamp: Math.floor(AGORA_MS / 1000),
      data: { ordersn: ORDER_SN, status: 'READY_TO_SHIP' },
    });
    if (payload == null) throw new Error('parseNotificationBody recusou um envelope válido');
    return { db, importarPedido, deps, payload };
  }

  async function adiar(db: FakeDb, deps: ShopeeProcessDeps, payload: unknown): Promise<string> {
    const r = await handleNotificationTask(asDb(db), payload, 0, deps);
    expect(r.outcome).toBe('deferred');
    const ids = db.idsEm(COL);
    expect(ids).toHaveLength(1);
    return ids[0]!;
  }

  it('um code 3 de loja não mapeada é ADIADO pelo store real ⇒ a conta chega ⇒ o re-drive o devolve à faixa quente ⇒ a varredura quente o importa', async () => {
    const { db, importarPedido, deps, payload } = montar();

    // 1. O pipeline real adia (`store.create(…, 'deferred', 0, motivoSemConta)`).
    const id = await adiar(db, deps, payload);
    expect(dados(db, id)).toMatchObject({
      code: 3,
      shop_id: SHOP_ID,
      status: DEFERRED,
      tentativas: 0,
      erro: motivoSemConta(SHOP_ID),
    });
    expect(importarPedido).not.toHaveBeenCalled();

    // 2. A conta passa a resolver a loja (o callback OAuth grava o shop_id).
    db.seed(`integracao/${INTEGRACAO_ID}`, {
      tipo: INTEGRACAO_TIPO.shopee,
      ativo: true,
      nome: 'Loja de teste',
      shop_id: SHOP_ID,
    });

    // 3. O re-drive.
    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);
    expect(r).toEqual({ encontradas: 1, semConta: 1, redirecionadas: 1, truncado: false });
    expect(dados(db, id)).toMatchObject({
      status: FAILED,
      tentativas: 0,
      processedAt: 0,
      erro: ERRO_REDRIVE,
    });

    // 4. `processedAt: 0` põe a linha na janela da varredura quente, que agora
    //    resolve a conta e importa o pedido — e apaga a linha.
    const varredura = await reprocessNotifications(asDb(db), { now: AGORA_MS }, deps);
    expect(varredura).toEqual({ processed: 1, outcomes: { pedido: 1 }, errors: [] });
    expect(importarPedido).toHaveBeenCalledTimes(1);
    expect(importarPedido.mock.calls[0]![1]).toMatchObject({
      integracaoId: INTEGRACAO_ID,
      shopId: SHOP_ID,
      orderSn: ORDER_SN,
    });
    expect(db.idsEm(COL)).toEqual([]);
  });

  it('um re-drive de evento VELHO (a loja deixou de resolver) re-adia com o MESMO motivo — o próximo connect ainda o acha', async () => {
    const { db, importarPedido, deps, payload } = montar();
    const id = await adiar(db, deps, payload);

    // Sem conta nenhuma: o gatilho não deveria ter chamado (guarda da releitura,
    // T43b), mas se chamou, a linha volta para a faixa ADIADA, intacta no que
    // importa.
    await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);
    const varredura = await reprocessNotifications(asDb(db), { now: AGORA_MS }, deps);

    expect(varredura.processed).toBe(1);
    expect(importarPedido).not.toHaveBeenCalled();
    expect(dados(db, id)).toMatchObject({ status: DEFERRED, erro: motivoSemConta(SHOP_ID) });

    // E o connect de verdade, depois, a encontra de novo.
    const r = await redriveDeferredSemContaForShopId(asDb(db), SHOP_ID);
    expect(r).toMatchObject({ semConta: 1, redirecionadas: 1 });
  });
});
