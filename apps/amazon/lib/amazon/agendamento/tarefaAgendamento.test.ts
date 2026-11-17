/**
 * The Easy Ship scheduling's task contract (step 15, PR 15-b): the constants,
 * the strict payload, the three builders' copy rules and the per-observation
 * task names. Pure.
 */
import { sha256Hex } from '@delfrance/data/admin';
import { describe, expect, it } from 'vitest';

import { makePedidoIdAmazon } from '../pedidos/orderIds';
import {
  ATRASO_AGENDAMENTO_DO_ACEITE_S,
  ESPERA_ACEITE_AGENDAMENTO_AMAZON_S,
  FILA_AGENDAMENTO_AMAZON,
  ORIGEM_AGENDAMENTO_AMAZON,
  type OrigemAgendamentoAmazon,
  PAUSAS_AGENDAMENTO_AMAZON_S,
  TENTATIVAS_AGENDAMENTO_AMAZON,
  type TarefaAgendamentoAmazon,
  esperaAgendamentoAmazon,
  idDaTarefaDeAgendamentoAmazon,
  origemAgendamentoAmazonSchema,
  pausaAgendamentoAmazon,
  tarefaAgendamentoAmazonSchema,
  tarefaInicialAgendamentoAmazon,
} from './tarefaAgendamento';

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const ID_TAREFA_NFE = 'tarefa-nfe-sintetica-0001';
const WATERMARK_US = 1_790_000_000_000_000;

const inicial = (origem: OrigemAgendamentoAmazon = ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe) =>
  tarefaInicialAgendamentoAmazon(PEDIDO_ID, CONTA, ORDER, origem);

describe('the constants', () => {
  it('the queue, its attempts, the entry delay and the two ladders', () => {
    expect(FILA_AGENDAMENTO_AMAZON).toBe('processAmazonEasyShipSchedule');
    expect(TENTATIVAS_AGENDAMENTO_AMAZON).toBe(4);
    expect(ATRASO_AGENDAMENTO_DO_ACEITE_S).toBe(60);
    expect(ESPERA_ACEITE_AGENDAMENTO_AMAZON_S).toEqual([120, 600, 1800]);
    expect(PAUSAS_AGENDAMENTO_AMAZON_S).toEqual([30, 60, 120, 240, 480]);
  });

  it('ORIGEM_AGENDAMENTO_AMAZON is exactly the schema’s options (the prefer-schema-enum companion)', () => {
    expect(Object.values(ORIGEM_AGENDAMENTO_AMAZON).sort()).toEqual(
      [...origemAgendamentoAmazonSchema.options].sort(),
    );
    expect(ORIGEM_AGENDAMENTO_AMAZON).toEqual({
      aceiteNfe: 'aceite-nfe',
      importacao: 'importacao',
    });
  });
});

describe('the payload (.strict())', () => {
  it('the first payload: nothing spent, every field as given, and it parses', () => {
    const t = inicial();
    expect(t).toEqual({
      pedidoId: PEDIDO_ID,
      contaId: CONTA,
      orderId: ORDER,
      origem: 'aceite-nfe',
      espera: 0,
      pausas: 0,
    });
    expect(tarefaAgendamentoAmazonSchema.parse(t)).toEqual(t);
    expect(inicial(ORIGEM_AGENDAMENTO_AMAZON.importacao).origem).toBe('importacao');
  });

  it('★ a payload with an extra key is refused — a URL or a token included', () => {
    for (const extra of [{ url: 'https://x.invalid/' }, { token: 'x' }, { fase: 'envio' }]) {
      expect(tarefaAgendamentoAmazonSchema.safeParse({ ...inicial(), ...extra }).success).toBe(
        false,
      );
    }
  });

  it.each<[string, Partial<Record<keyof TarefaAgendamentoAmazon, unknown>>]>([
    ['espera past its bound', { espera: 4 }],
    ['a negative espera', { espera: -1 }],
    ['pausas past their bound', { pausas: 6 }],
    ['a fractional pausas', { pausas: 1.5 }],
    ['an unknown origem', { origem: 'reenvio' }],
    ['a pedido id in upper case', { pedidoId: PEDIDO_ID.toUpperCase() }],
    ['an order outside 3-7-7', { orderId: '171-9876543-210987' }],
    ['a conta id with a slash', { contaId: 'conta/teste' }],
    ['a missing field', { pausas: undefined }],
  ])('refuses %s', (_caso, mudanca) => {
    expect(tarefaAgendamentoAmazonSchema.safeParse({ ...inicial(), ...mudanca }).success).toBe(
      false,
    );
  });

  it('NEAR-MISS: every bound itself parses (espera 3, pausas 5)', () => {
    expect(
      tarefaAgendamentoAmazonSchema.safeParse({ ...inicial(), espera: 3, pausas: 5 }).success,
    ).toBe(true);
  });

  it('the first-payload builder refuses an id outside its grammar, naming the grammar and never the value', () => {
    for (const [args, campo] of [
      [['X'.repeat(64), CONTA, ORDER], 'pedidoId'],
      [[PEDIDO_ID, 'conta com espaço', ORDER], 'contaId'],
      [[PEDIDO_ID, CONTA, 'pedido-sentinela'], 'orderId'],
    ] as const) {
      expect(() => tarefaInicialAgendamentoAmazon(args[0], args[1], args[2], 'importacao')).toThrow(
        RangeError,
      );
      try {
        tarefaInicialAgendamentoAmazon(args[0], args[1], args[2], 'importacao');
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        expect(err.message).toContain(campo);
        expect(err.message).not.toContain('sentinela');
        expect(err.message).not.toContain('conta com espaço');
      }
    }
  });
});

describe('the builders (copy rules)', () => {
  it('★ esperaAgendamentoAmazon: espera + 1, pausas RESET, everything else copied; null at espera 3', () => {
    const t = { ...inicial(), pausas: 2 };
    expect(esperaAgendamentoAmazon(t)).toEqual({ ...t, espera: 1, pausas: 0 });
    let atual: TarefaAgendamentoAmazon | null = inicial();
    const vistas: number[] = [];
    while (atual !== null) {
      vistas.push(atual.espera);
      atual = esperaAgendamentoAmazon(atual);
    }
    expect(vistas).toEqual([0, 1, 2, 3]);
    expect(esperaAgendamentoAmazon({ ...inicial(), espera: 3 })).toBeNull();
  });

  it('★ pausaAgendamentoAmazon: pausas + 1, everything else KEPT; null at pausas 5', () => {
    const t = { ...inicial(ORIGEM_AGENDAMENTO_AMAZON.importacao), espera: 2 };
    expect(pausaAgendamentoAmazon(t)).toEqual({ ...t, pausas: 1 });
    expect(pausaAgendamentoAmazon({ ...t, pausas: 4 })).toEqual({ ...t, pausas: 5 });
    expect(pausaAgendamentoAmazon({ ...t, pausas: 5 })).toBeNull();
  });

  it('every payload a builder yields parses, and none carries a key the schema lacks', () => {
    const t = inicial();
    for (const p of [t, esperaAgendamentoAmazon(t), pausaAgendamentoAmazon(t)]) {
      expect(tarefaAgendamentoAmazonSchema.safeParse(p).success).toBe(true);
    }
  });
});

describe('the task name: one per OBSERVATION, never per pedido (step-15 plan §3 decision 3)', () => {
  const e1 = (idTarefaNfe: string) =>
    idDaTarefaDeAgendamentoAmazon({ origem: ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe, idTarefaNfe });
  const e2 = (pedidoId: string, watermarkUs: number) =>
    idDaTarefaDeAgendamentoAmazon({
      origem: ORIGEM_AGENDAMENTO_AMAZON.importacao,
      pedidoId,
      watermarkUs,
    });

  it('the derivation is pinned: 64 lowercase hex over the documented strings', () => {
    expect(e1(ID_TAREFA_NFE)).toBe(sha256Hex(`agendamento:aceite:${ID_TAREFA_NFE}`));
    expect(e2(PEDIDO_ID, WATERMARK_US)).toBe(
      sha256Hex(`agendamento:importacao:${PEDIDO_ID}:${String(WATERMARK_US)}`),
    );
    expect(e1(ID_TAREFA_NFE)).toMatch(/^[0-9a-f]{64}$/);
    expect(e2(PEDIDO_ID, WATERMARK_US)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('★ the same NF-e task id gives the same name (a queue retry of that dispatch dedupes); another one a new name', () => {
    expect(e1(ID_TAREFA_NFE)).toBe(e1(ID_TAREFA_NFE));
    expect(e1('tarefa-nfe-sintetica-0002')).not.toBe(e1(ID_TAREFA_NFE));
  });

  it('★ mutation 21: the same (pedidoId, watermarkUs) gives the same name; a NEWER read a new one, for the same pedido', () => {
    expect(e2(PEDIDO_ID, WATERMARK_US)).toBe(e2(PEDIDO_ID, WATERMARK_US));
    expect(e2(PEDIDO_ID, WATERMARK_US + 1)).not.toBe(e2(PEDIDO_ID, WATERMARK_US));
    expect(e2(makePedidoIdAmazon(CONTA, '171-9876543-2109877'), WATERMARK_US)).not.toBe(
      e2(PEDIDO_ID, WATERMARK_US),
    );
  });

  it('★ NEAR-MISS: an aceite-nfe and an importacao entry of the same pedido never share a name', () => {
    const nomes = new Set([
      e2(PEDIDO_ID, WATERMARK_US),
      // An NF-e task id spelled like the import's own observation.
      e1(`${PEDIDO_ID}:${String(WATERMARK_US)}`),
      e1(`importacao:${PEDIDO_ID}:${String(WATERMARK_US)}`),
      e1(PEDIDO_ID),
    ]);
    expect(nomes.size).toBe(4);
  });
});
