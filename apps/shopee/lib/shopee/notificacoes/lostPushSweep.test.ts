import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { notificacaoShopeeCollection } from '@delfrance/data/admin/collections';
import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  type ShopeeConfirmLostPush,
  type ShopeeLostPushResponse,
  ShopeeNetworkError,
  type ShopeePartnerClient,
  ShopeeRateLimitError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { ShopeeTasksDisabledError } from '../shopeeTasks';
import { type ShopeeNotificationPayload, docIdOf, parseNotificationBody } from './notificacao';
import {
  BRUTO_MAX_CHARS,
  IDADE_ALERTA_MS,
  MAX_PAGES_PER_TICK,
  SHOPEE_LOST_PUSH_CONFIRM_DISABLED_ENV,
  runShopeeLostPushSweep,
} from './lostPushSweep';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real partner id, key or shop id.      */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_760_000_000_000;
const HORA_MS = 3_600_000;
const SHOP = 987654;
/** `last_message_id` — an invented cursor; `_lostPush.ref` is built from it. */
const LAST_ID = 176610;
/** When Shopee says the message WAS LOST. Seconds, and never an event clock. */
const PERDIDA_S = Math.floor(AGORA_MS / 1000) - 600;

const NOTIF_PATH = notificacaoShopeeCollection.resolvePath({});

/** Shopee's own `push 1` (code 3) sample shape, re-nested as the queue sends it. */
function envelopeCode3(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 3,
    shop_id: SHOP,
    timestamp: PERDIDA_S - 60,
    data: {
      ordersn: 'BR2409NX1',
      status: 'READY_TO_SHIP',
      completed_scenario: '',
      update_time: 1_759_990_000,
      items: [],
    },
    ...over,
  };
}

interface EntradaBruta {
  shop_id: number | null;
  code: number;
  timestamp: number;
  data: string;
}

function entrada(over: Partial<EntradaBruta> = {}): EntradaBruta {
  return {
    shop_id: SHOP,
    code: 3,
    timestamp: PERDIDA_S,
    data: JSON.stringify(envelopeCode3()),
    ...over,
  };
}

/**
 * ⚠️ The WHOLE parsed operation, envelope included — that is what
 * `getLostPushMessages()` hands back, and the envelope's `error` is the field
 * `envelopeError` reports.
 */
function pagina(
  entradas: EntradaBruta[] | null,
  over: { has_next_page?: boolean; last_message_id?: number; error?: string } = {},
): ShopeeLostPushResponse {
  const { error = '', ...resto } = over;
  return {
    request_id: 'req-get',
    error,
    message: null,
    warning: null,
    response: {
      push_message_list: entradas,
      has_next_page: false,
      last_message_id: LAST_ID,
      ...resto,
    },
  } as unknown as ShopeeLostPushResponse;
}

function envelopeDeConfirmacao(error = ''): ShopeeConfirmLostPush {
  return { request_id: 'req-1', error, message: null, warning: null } as ShopeeConfirmLostPush;
}

/* -------------------------------------------------------------------------- */

/** The shared call log — what makes the ordering assertions direct. */
let chamadas: string[] = [];
let enfileirados: ShopeeNotificationPayload[] = [];
let avisos: { msg: string; meta?: Record<string, unknown> }[] = [];

const getLostPushMessages = vi.fn();
const confirmConsumedLostPushMessages = vi.fn();
const enqueue = vi.fn();

const partnerClient = {
  getLostPushMessages,
  confirmConsumedLostPushMessages,
} as unknown as ShopeePartnerClient;

const logger = {
  warn: (msg: string, meta?: Record<string, unknown>): void => {
    avisos.push(meta === undefined ? { msg } : { msg, meta });
  },
};

function sweep(db: FakeDb, nowMs = AGORA_MS) {
  return runShopeeLostPushSweep(asDb(db), {
    partnerClient,
    scheduler: { enqueue: (p) => enqueue(p) as Promise<void> },
    nowMs,
    logger,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  chamadas = [];
  enfileirados = [];
  avisos = [];
  enqueue.mockImplementation(async (p: ShopeeNotificationPayload) => {
    chamadas.push('enqueue');
    enfileirados.push(p);
  });
  confirmConsumedLostPushMessages.mockImplementation(async (p: { lastMessageId: number }) => {
    chamadas.push(`confirm:${String(p.lastMessageId)}`);
    return envelopeDeConfirmacao();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */

describe('a regra de ordenação — confirmar só depois de durável', () => {
  it('enfileira TODAS as entradas antes de confirmar a página', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([
        entrada(),
        entrada({ data: JSON.stringify(envelopeCode3({ data: { ordersn: 'BR-2' } })) }),
      ]),
    );

    const out = await sweep(db);

    // A ordem É a propriedade: um confirm antes de um enqueue apaga a entrada da
    // fila do provedor sem nada durável do nosso lado.
    expect(chamadas).toEqual(['enqueue', 'enqueue', `confirm:${String(LAST_ID)}`]);
    expect(out).toMatchObject({ paginas: 1, encontradas: 2, enfileiradas: 2, confirmadas: 1 });
  });

  it('⚠️ uma mensagem perdida cujo handler falha é re-tentada pelo pipeline, não perdida pelo watermark', async () => {
    // O teste de aceitação do plano, expresso como duas igualdades: a mensagem
    // recuperada entra na MESMA fila, com a MESMA identidade que uma entrega ao
    // vivo do mesmo envelope produz. Por isso `TASK_MAX_ATTEMPTS`, a varredura
    // de 30 minutos e o teto de parada caem todos sobre UMA linha em vez de
    // bifurcar — o watermark avançou porque o trabalho passou a ser da fila.
    const db = new FakeDb();
    const envelope = envelopeCode3();
    getLostPushMessages.mockResolvedValue(pagina([entrada({ data: JSON.stringify(envelope) })]));

    const out = await sweep(db);

    const aoVivo = parseNotificationBody(envelope);
    expect(enfileirados).toHaveLength(1);
    expect(enfileirados[0]).toEqual(aoVivo);
    expect(docIdOf(enfileirados[0]!)).toBe(docIdOf(aoVivo!));
    expect(out.confirmadas).toBe(1);
  });

  it('quando enqueue lança, a entrada é PERSISTIDA e a página É confirmada', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()]));
    enqueue.mockRejectedValue(grpc(14, 'UNAVAILABLE'));

    const out = await sweep(db);

    expect(out).toMatchObject({ enfileiradas: 0, persistidas: 1, confirmadas: 1, erros: [] });
    const id = docIdOf(parseNotificationBody(envelopeCode3())!);
    expect(db.store[`${NOTIF_PATH}/${String(id)}`]?.data).toMatchObject({
      code: 3,
      status: 'failed',
      erro: 'enqueue falhou (mensagem perdida): UNAVAILABLE',
    });
  });

  it('quando o persist também lança (gRPC 14), a página NÃO é confirmada', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()]));
    enqueue.mockRejectedValue(new Error('sem fila'));
    const id = docIdOf(parseNotificationBody(envelopeCode3())!);
    db.falhasDeCriacao.set(`${NOTIF_PATH}/${String(id)}`, grpc(14, 'UNAVAILABLE'));

    const out = await sweep(db);

    expect(out).toMatchObject({ enfileiradas: 0, persistidas: 0, confirmadas: 0 });
    expect(out.erros).toEqual([{ pagina: 1, erro: 'UNAVAILABLE' }]);
    expect(confirmConsumedLostPushMessages).not.toHaveBeenCalled();
  });

  it('um ZodError no persist cai para a linha PARADA, e a página segue confirmável', async () => {
    // O terceiro degrau da escada: o payload foi recusado pelo validador da
    // coleção, então re-persistir a mesma forma é inútil — a forma PARADA é
    // mínima e conhecidamente válida, que é o que este degrau tem e o anterior
    // não tinha.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()]));
    enqueue.mockRejectedValue(new Error('sem fila'));
    const id = docIdOf(parseNotificationBody(envelopeCode3())!);
    db.falhasDeCriacao.set(`${NOTIF_PATH}/${String(id)}`, new ZodError([]));

    const out = await sweep(db);

    expect(out).toMatchObject({ persistidas: 0, paradas: 1, confirmadas: 1 });
    // A forma PARADA é keyed na POSIÇÃO da entrada na fila, não no recurso — o
    // payload que o validador recusou não entra na identidade.
    expect(
      db.store[`${NOTIF_PATH}/-1:${String(SHOP)}:${String(LAST_ID)}_0:${String(PERDIDA_S * 1000)}`],
    ).toBeDefined();
  });

  it('uma página parcialmente durável nunca é confirmada', async () => {
    const db = new FakeDb();
    const segunda = entrada({ data: JSON.stringify(envelopeCode3({ data: { ordersn: 'BR-2' } })) });
    getLostPushMessages.mockResolvedValue(pagina([entrada(), segunda]));
    enqueue.mockImplementationOnce(async (p: ShopeeNotificationPayload) => {
      chamadas.push('enqueue');
      enfileirados.push(p);
    });
    enqueue.mockRejectedValue(new Error('sem fila'));
    db.falhasDeCriacao.set(
      `${NOTIF_PATH}/${String(docIdOf(parseNotificationBody(envelopeCode3({ data: { ordersn: 'BR-2' } }))!))}`,
      grpc(14, 'UNAVAILABLE'),
    );

    const out = await sweep(db);

    expect(out).toMatchObject({ enfileiradas: 1, confirmadas: 0 });
    expect(chamadas).toEqual(['enqueue']);
  });

  it('as entradas já duráveis não são desfeitas — a página volta e DUPLICA, o lado seguro', async () => {
    // O corolário da regra: recusar o confirm custa trabalho repetido, nunca uma
    // perda. Todo handler re-busca e os ids derivados colapsam numa linha só.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()]));
    enqueue.mockRejectedValueOnce(new Error('sem fila'));
    const id = docIdOf(parseNotificationBody(envelopeCode3())!);
    db.falhasDeCriacao.set(`${NOTIF_PATH}/${String(id)}`, grpc(14, 'UNAVAILABLE'));

    const primeira = await sweep(db);
    db.falhasDeCriacao.clear();
    const segunda = await sweep(db);

    expect(primeira.confirmadas).toBe(0);
    expect(segunda).toMatchObject({ enfileiradas: 1, confirmadas: 1 });
  });
});

describe('SHOPEE_TASKS_DISABLED — o modo só-varredura', () => {
  it('um ShopeeTasksDisabledError persiste e NÃO interrompe a tick', async () => {
    // A divergência deliberada em relação ao ML: sob a válvula de tasks, deixar
    // a página sem confirmar tornaria a varredura um no-op permanente. Uma linha
    // persistida é MAIS durável que uma entrada de feed, não menos — a varredura
    // de 30 minutos a drena com a escada completa.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([
        entrada(),
        entrada({ data: JSON.stringify(envelopeCode3({ data: { ordersn: 'BR-2' } })) }),
      ]),
    );
    enqueue.mockRejectedValue(new ShopeeTasksDisabledError());

    const out = await sweep(db);

    expect(out).toMatchObject({ enfileiradas: 0, persistidas: 2, confirmadas: 1, erros: [] });
  });
});

describe('paginação', () => {
  it('has_next_page encadeia, e cada página confirma o SEU last_message_id', async () => {
    const db = new FakeDb();
    getLostPushMessages
      .mockResolvedValueOnce(pagina([entrada()], { has_next_page: true, last_message_id: 1 }))
      .mockResolvedValueOnce(
        pagina([entrada({ data: JSON.stringify(envelopeCode3({ data: { ordersn: 'BR-2' } })) })], {
          last_message_id: 2,
        }),
      );

    const out = await sweep(db);

    expect(chamadas).toEqual(['enqueue', 'confirm:1', 'enqueue', 'confirm:2']);
    expect(out).toMatchObject({ paginas: 2, confirmadas: 2, truncado: false });
  });

  it('⚠️ uma página VAZIA nunca é confirmada', async () => {
    // `last_message_id` é "a entrada final dos dados devolvidos nesta chamada":
    // sem entradas não há entrada final, e confirmar um id não relacionado é
    // comportamento indefinido contra um watermark que a Shopee nunca escreveu.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([]));

    const out = await sweep(db);

    expect(confirmConsumedLostPushMessages).not.toHaveBeenCalled();
    expect(out).toMatchObject({ paginas: 1, encontradas: 0, confirmadas: 0, maisAntigaMs: null });
  });

  it('uma página vazia com has_next_page: true é contradição do provedor — avisa e para', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([], { has_next_page: true }));

    const out = await sweep(db);

    expect(out.confirmadas).toBe(0);
    expect(avisos.some((a) => a.msg.includes('contradição do provedor'))).toBe(true);
  });

  it('push_message_list null é tratada como vazia, não como erro', async () => {
    // A fila vazia é o caso esmagadoramente comum e nenhum sample mostra o que a
    // Shopee manda para ela.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina(null));

    const out = await sweep(db);

    expect(out).toMatchObject({ paginas: 1, encontradas: 0, confirmadas: 0, erros: [] });
  });

  it('o cap de páginas trunca a tick, e as páginas já confirmadas seguem confirmadas', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockImplementation(async () =>
      pagina([entrada({ data: JSON.stringify(envelopeCode3({ timestamp: Math.random() })) })], {
        has_next_page: true,
      }),
    );

    const out = await sweep(db);

    expect(out).toMatchObject({
      paginas: MAX_PAGES_PER_TICK,
      confirmadas: MAX_PAGES_PER_TICK,
      truncado: true,
    });
    // ⚠️ Truncar aqui é inofensivo, ao contrário do backfill: cada página
    // confirmada já avançou o cursor do PRÓPRIO provedor, então a próxima tick
    // recomeça exatamente onde esta parou.
    expect(getLostPushMessages).toHaveBeenCalledTimes(MAX_PAGES_PER_TICK);
  });
});

describe('entradas ilegíveis — o escape do bloqueio de cabeça de fila', () => {
  const idParado = (indice: number, ts = PERDIDA_S): string =>
    `${NOTIF_PATH}/-1:-:${String(LAST_ID)}_${String(indice)}:${String(ts * 1000)}`;

  it('um data que não é JSON vira linha PARADA e a página ainda é confirmada', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([entrada({ shop_id: null, data: 'não é json {' })]),
    );

    const out = await sweep(db);

    expect(out).toMatchObject({ paradas: 1, enfileiradas: 0, confirmadas: 1 });
    expect(db.store[idParado(0)]?.data).toMatchObject({
      status: 'parked',
      erro: `entrada da fila de mensagens perdidas ilegível: data não é JSON (ref ${String(LAST_ID)}_0)`,
    });
  });

  it('um data que é JSON mas não é objeto vira linha parada', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada({ shop_id: null, data: '[1,2,3]' })]));

    const out = await sweep(db);
    expect(out).toMatchObject({ paradas: 1, confirmadas: 1 });
  });

  it('um envelope sem code inteiro vira linha parada', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([entrada({ shop_id: null, data: '{"shop_id":987654}' })]),
    );

    const out = await sweep(db);
    expect(out).toMatchObject({ paradas: 1, confirmadas: 1 });
  });

  it('⚠️ duas entradas ilegíveis na MESMA página, no mesmo segundo, geram ids DISTINTOS', async () => {
    // Sem a linha `_lostPush.ref` em `identidadeDoPush` as duas chaveiam
    // `-1:-:-:<carimbo>`, `store.create` estreita ALREADY_EXISTS e retorna em
    // SILÊNCIO — a varredura confirmaria passando por uma entrada cujo payload
    // nunca foi gravado. É a forma do #1488 chegando pela escotilha que existe
    // para evitá-la.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([
        entrada({ shop_id: null, data: 'ilegível A' }),
        entrada({ shop_id: null, data: 'ilegível B' }),
      ]),
    );

    const out = await sweep(db);

    expect(out).toMatchObject({ paradas: 2, confirmadas: 1 });
    expect(db.store[idParado(0)]).toBeDefined();
    expect(db.store[idParado(1)]).toBeDefined();
    expect(db.idsEm(NOTIF_PATH)).toHaveLength(2);
  });

  it('a mesma página relida sem confirmação gera o MESMO id — a repetição colapsa', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada({ shop_id: null, data: 'ilegível A' })]));
    confirmConsumedLostPushMessages.mockRejectedValue(new ShopeeNetworkError('conexão caiu'));

    await sweep(db);
    await sweep(db);

    expect(db.idsEm(NOTIF_PATH)).toEqual([`-1:-:${String(LAST_ID)}_0:${String(PERDIDA_S * 1000)}`]);
  });

  it('o bruto é limitado a BRUTO_MAX_CHARS e marca truncado', async () => {
    const db = new FakeDb();
    const gigante = `{${'x'.repeat(BRUTO_MAX_CHARS + 500)}`;
    getLostPushMessages.mockResolvedValue(pagina([entrada({ shop_id: null, data: gigante })]));

    await sweep(db);

    const lost = (db.store[idParado(0)]?.data.data as Record<string, unknown>)._lostPush as Record<
      string,
      unknown
    >;
    expect((lost.bruto as string).length).toBe(BRUTO_MAX_CHARS);
    expect(lost.truncado).toBe(true);
  });

  it('a linha parada guarda code, shopId e timestamp da LISTA, com o timestamp em SEGUNDOS como veio', async () => {
    // ⚠️ O `timestamp` da lista é o relógio da PERDA, nunca o do evento. Ele
    // fica no `_lostPush` ao lado do seu significado real; o campo `timestamp`
    // do documento existe só para o id ser estável numa releitura.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([entrada({ shop_id: SHOP, code: 12, data: 'ilegível' })]),
    );

    await sweep(db);

    const doc =
      db.store[`${NOTIF_PATH}/-1:${String(SHOP)}:${String(LAST_ID)}_0:${String(PERDIDA_S * 1000)}`];
    expect(doc?.data).toMatchObject({ code: -1, shop_id: SHOP, timestamp: PERDIDA_S * 1000 });
    expect((doc?.data.data as Record<string, unknown>)._lostPush).toMatchObject({
      ref: `${String(LAST_ID)}_0`,
      code: 12,
      shopId: SHOP,
      timestamp: PERDIDA_S,
    });
  });
});

describe('dedup dentro da tick', () => {
  it('duas entregas do MESMO evento enfileiram uma vez', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada(), entrada()]));

    const out = await sweep(db);

    expect(out).toMatchObject({ encontradas: 2, enfileiradas: 1, duplicadas: 1, confirmadas: 1 });
  });

  it('⚠️ dois eventos DIFERENTES do mesmo pedido NÃO colapsam — o carimbo os separa', async () => {
    // O near-miss `docIdOf` × `dedupKeyOf`. `dedupKeyOf` derruba o carimbo de
    // propósito ("duas re-entregas do mesmo recurso são um job"), o que está
    // certo para a varredura de reprocessamento — que DEIXA o documento para uma
    // próxima passada. Aqui a entrada pulada está prestes a ser CONFIRMADA e
    // some para sempre.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([
        entrada({ data: JSON.stringify(envelopeCode3()) }),
        entrada({
          data: JSON.stringify(
            envelopeCode3({
              data: {
                ordersn: 'BR2409NX1',
                status: 'SHIPPED',
                completed_scenario: '',
                update_time: 1_759_995_000,
              },
            }),
          ),
        }),
      ]),
    );

    const out = await sweep(db);

    expect(out).toMatchObject({ enfileiradas: 2, duplicadas: 0 });
  });

  it('um docId nulo não deduplica — perder dedup por um id inválido custa uma task', async () => {
    // `asDocId` recusa uma barra (seria uma subcoleção aninhada — um buraco
    // negro silencioso), e a troca que ele já faz é exatamente esta.
    const db = new FakeDb();
    const comBarra = envelopeCode3({
      data: { ordersn: 'BR/2409', status: 'READY_TO_SHIP', update_time: 1_759_990_000 },
    });
    expect(docIdOf(parseNotificationBody(comBarra)!)).toBeNull();
    getLostPushMessages.mockResolvedValue(
      pagina([
        entrada({ data: JSON.stringify(comBarra) }),
        entrada({ data: JSON.stringify(comBarra) }),
      ]),
    );

    const out = await sweep(db);

    expect(out).toMatchObject({ enfileiradas: 2, duplicadas: 0 });
  });
});

describe('entradas de nível de parceiro', () => {
  it('sem shop_id na lista, o shopId vem do envelope INTERNO (code 1)', async () => {
    // A ausência do `shop_id` na lista é documentada ("such as 1, 2, 12"), e o
    // payload vem do envelope de dentro — `parseNotificationBody` levanta o
    // `shop_id` das quatro posições, inclusive de dentro de `data`.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([
        entrada({
          shop_id: null,
          code: 1,
          data: JSON.stringify({
            code: 1,
            timestamp: PERDIDA_S - 30,
            data: { shop_id: SHOP, success: true },
          }),
        }),
      ]),
    );

    await sweep(db);

    expect(enfileirados[0]).toMatchObject({ code: 1, shopId: SHOP });
  });

  it('um code 12 sem shop_id em lugar nenhum enfileira com shopId null', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(
      pagina([
        entrada({
          shop_id: null,
          code: 12,
          data: JSON.stringify({
            code: 12,
            timestamp: PERDIDA_S - 30,
            data: { expire_before: PERDIDA_S + 86_400, page_no: 1, shop_expire_soon: [SHOP] },
          }),
        }),
      ]),
    );

    await sweep(db);

    expect(enfileirados[0]).toMatchObject({ code: 12, shopId: null });
  });
});

describe('erros contidos por TICK', () => {
  const apiError = (code: string) =>
    new ShopeeApiError(`falhou: ${code}`, {
      code,
      kind: 'other',
      httpStatus: 200,
      path: '/api/v2/push/get_lost_push_message',
    });

  it('um ShopeeApiError na leitura para a tick sem confirmar nada', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockRejectedValue(apiError('error_server'));

    const out = await sweep(db);

    expect(out).toMatchObject({ paginas: 0, confirmadas: 0 });
    expect(out.erros).toEqual([{ pagina: 1, erro: 'falhou: error_server' }]);
    expect(confirmConsumedLostPushMessages).not.toHaveBeenCalled();
  });

  it('um ShopeeNetworkError, um ShopeeHttpError e um ShopeeSchemaError no CONFIRM param igual', async () => {
    for (const erro of [
      new ShopeeNetworkError('conexão caiu'),
      new ShopeeHttpError('edge recusou', { httpStatus: 403, path: '/api/v2/push/x' }),
      new ShopeeSchemaError('corpo inesperado', { httpStatus: 200, path: '/api/v2/push/x' }),
    ]) {
      vi.clearAllMocks();
      chamadas = [];
      const db = new FakeDb();
      getLostPushMessages.mockResolvedValue(pagina([entrada()]));
      enqueue.mockResolvedValue(undefined);
      confirmConsumedLostPushMessages.mockRejectedValue(erro);

      const out = await sweep(db);

      expect(out).toMatchObject({ enfileiradas: 1, confirmadas: 0 });
      expect(out.erros).toHaveLength(1);
    }
  });

  it('burst e daily param a tick do mesmo jeito — a distinção só sobrevive no log', async () => {
    // A cadência de 2 h já passou de qualquer janela de burst, e a cota diária
    // reseta no relógio da Shopee, no qual as próximas ticks entram. Nada aqui
    // dorme.
    for (const kind of ['burst', 'daily'] as const) {
      vi.clearAllMocks();
      const db = new FakeDb();
      getLostPushMessages.mockRejectedValue(
        new ShopeeRateLimitError('limite', {
          code: 'error_rate_limit',
          kind,
          httpStatus: 429,
          path: '/api/v2/push/get_lost_push_message',
          retryAfterSeconds: 30,
        }),
      );

      const out = await sweep(db);
      expect(out).toMatchObject({
        paginas: 0,
        confirmadas: 0,
        erros: [{ pagina: 1, erro: 'limite' }],
      });
    }
  });

  it('⚠️ um ShopeeConfigError NÃO é contido — derruba a execução, o único lugar onde a credencial ausente se nomeia', async () => {
    // #778 é o exemplo trabalhado: uma varredura que registrava erros por item
    // para sempre em vez de falhar a execução que teria nomeado o binding
    // ausente. E ele NÃO é um `ShopeeApiError` — estende `ShopeeError`
    // diretamente, então capturar a classe base o engoliria.
    const db = new FakeDb();
    getLostPushMessages.mockRejectedValue(new ShopeeConfigError('SHOPEE_PARTNER_KEY ausente'));

    await expect(sweep(db)).rejects.toBeInstanceOf(ShopeeConfigError);
  });

  it('⚠️ um TypeError é relançado', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockRejectedValue(new TypeError('x is not a function'));

    await expect(sweep(db)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('a válvula do confirm', () => {
  it('pula SÓ a confirmação — leitura, parse e enfileiramento continuam acontecendo', async () => {
    // O ensaio da primeira tick de produção: as duas APIs não existem no
    // sandbox, então a primeira chamada é em produção. Opt-in-to-DISABLE, para
    // que um valor não definido nunca deixe a varredura inerte.
    vi.stubEnv(SHOPEE_LOST_PUSH_CONFIRM_DISABLED_ENV, '1');
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()], { has_next_page: true }));

    const out = await sweep(db);

    expect(out).toMatchObject({ enfileiradas: 1, confirmadas: 0 });
    expect(confirmConsumedLostPushMessages).not.toHaveBeenCalled();
    // A fila não avançou, então continuar paginando releria a MESMA página.
    expect(getLostPushMessages).toHaveBeenCalledTimes(1);
  });

  it('qualquer valor que não seja exatamente "1" deixa a confirmação ligada', async () => {
    vi.stubEnv(SHOPEE_LOST_PUSH_CONFIRM_DISABLED_ENV, 'true');
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()]));

    const out = await sweep(db);
    expect(out.confirmadas).toBe(1);
  });
});

describe('diagnóstico', () => {
  it('reporta o error do envelope cru do GETTER — mesmo com o confirm desligado', async () => {
    // ⚠️ A propriedade inteira: o ensaio existe para ler a fila SEM dar o ack,
    // então um `envelopeError` tirado do CONFIRM seria `null` exatamente na
    // única tick para a qual o campo foi criado. Com a válvula ligada, ele tem
    // de valer o `error` do GETTER.
    vi.stubEnv(SHOPEE_LOST_PUSH_CONFIRM_DISABLED_ENV, '1');
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()], { error: '-' }));

    const out = await sweep(db);

    expect(out).toMatchObject({ enfileiradas: 1, confirmadas: 0, envelopeError: '-' });
    expect(confirmConsumedLostPushMessages).not.toHaveBeenCalled();
  });

  it('com o confirm ligado, o campo continua sendo o do getter — nunca o do confirm', async () => {
    // NEAR-MISS do teste acima: os dois envelopes discordam de propósito, e o
    // que sai é o da LEITURA.
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()], { error: '' }));
    confirmConsumedLostPushMessages.mockResolvedValue(envelopeDeConfirmacao('-'));

    const out = await sweep(db);

    expect(out).toMatchObject({ confirmadas: 1, envelopeError: '' });
  });

  it('a PRIMEIRA página é a que responde — uma segunda leitura não sobrescreve', async () => {
    const db = new FakeDb();
    getLostPushMessages
      .mockResolvedValueOnce(
        pagina([entrada()], { has_next_page: true, last_message_id: 1, error: '-' }),
      )
      .mockResolvedValueOnce(
        pagina([entrada({ data: JSON.stringify(envelopeCode3({ data: { ordersn: 'BR-2' } })) })], {
          last_message_id: 2,
          error: '',
        }),
      );

    const out = await sweep(db);

    expect(out).toMatchObject({ paginas: 2, envelopeError: '-' });
  });

  it('uma leitura contida na página 1 deixa o campo null — nada foi lido', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockRejectedValue(new ShopeeNetworkError('conexão caiu'));

    const out = await sweep(db);

    expect(out.envelopeError).toBeNull();
  });

  it('reporta a idade da entrada mais antiga e avisa acima de 48 h', async () => {
    const db = new FakeDb();
    const perdidaHa50h = Math.floor((AGORA_MS - 50 * HORA_MS) / 1000);
    getLostPushMessages.mockResolvedValue(pagina([entrada({ timestamp: perdidaHa50h })]));

    const out = await sweep(db);

    expect(out.maisAntigaMs).toBeGreaterThan(IDADE_ALERTA_MS);
    expect(avisos.some((a) => a.msg.includes('perto de expirar'))).toBe(true);
  });

  it('uma fila saudável não avisa nada sobre idade', async () => {
    const db = new FakeDb();
    getLostPushMessages.mockResolvedValue(pagina([entrada()]));

    await sweep(db);

    expect(avisos.some((a) => a.msg.includes('perto de expirar'))).toBe(false);
  });
});
