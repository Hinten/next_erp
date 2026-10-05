import { describe, expect, it } from 'vitest';

import {
  MAX_CAMPOS_NO_DIARIO,
  alvoDoPushDeDevolucao,
  type AlvoDoPushDeDevolucao,
} from './pushDevolucao';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const ORDER_SN = '260910KJBHUJDM';
const RETURN_SN = '2609100000000001';
/** ALPHANUMERIC, like every sample on Shopee's returns pages (`2411280EDT4JRV5`). */
const RETURN_SN_ALFA = '260910ABCDE0001';

/**
 * `push 32`'s own sample (`return_updates_push`), ids swapped for fixtures —
 * the `data` the receiver hands the arm. ⚠️ `order_sn` WITH the underscore, and
 * NO top-level `update_time`: the clocks live per field.
 */
const DATA_PUSH_32 = {
  order_sn: ORDER_SN,
  return_sn: RETURN_SN,
  updated_values: [
    {
      update_field: 'return_status',
      old_value: 'JUDGING',
      new_value: 'PROCESSING',
      update_time: 1_732_796_767,
    },
    {
      update_field: 'logistics_status',
      old_value: 'LOGISTICS_NOT_STARTED',
      new_value: 'LOGISTICS_PENDING_ARRANGE',
      update_time: 1_732_796_767,
    },
  ],
} as const;

function ok(r: AlvoDoPushDeDevolucao): Extract<AlvoDoPushDeDevolucao, { ok: true }> {
  if (!r.ok) throw new Error(`esperava ok, veio recusa: ${r.motivo}`);
  return r;
}

function recusa(r: AlvoDoPushDeDevolucao): string {
  if (r.ok) throw new Error('esperava recusa, veio ok');
  return r.motivo;
}

describe('alvoDoPushDeDevolucao — a identidade', () => {
  it('lê o sample do push 32 (order_sn COM sublinhado) — um parser só de `ordersn` fica vermelho aqui', () => {
    const r = ok(alvoDoPushDeDevolucao({ ...DATA_PUSH_32 }));
    expect(r.orderSn).toBe(ORDER_SN);
    expect(r.returnSn).toBe(RETURN_SN);
    expect(r.origem).toBe('push');
  });

  it('aceita o return_sn ALFANUMÉRICO — um guard só de dígitos fica vermelho aqui', () => {
    const r = ok(alvoDoPushDeDevolucao({ ...DATA_PUSH_32, return_sn: RETURN_SN_ALFA }));
    expect(r.returnSn).toBe(RETURN_SN_ALFA);
  });

  it('tolera `ordersn` (sem sublinhado) quando `order_sn` falta', () => {
    const r = ok(alvoDoPushDeDevolucao({ ordersn: ORDER_SN, return_sn: RETURN_SN }));
    expect(r.orderSn).toBe(ORDER_SN);
  });

  it('a grafia DOCUMENTADA (`order_sn`) vence quando as duas chegam e discordam', () => {
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        ordersn: '260910OUTROPED',
        return_sn: RETURN_SN,
      }),
    );
    expect(r.orderSn).toBe(ORDER_SN);
  });

  it('um `order_sn` inutilizável cai para `ordersn` — vazio, sentinela, com espaço', () => {
    for (const ruim of ['', ' ', '-', ` ${ORDER_SN}`, `${ORDER_SN} `, 260910]) {
      const r = ok(
        alvoDoPushDeDevolucao({ order_sn: ruim, ordersn: ORDER_SN, return_sn: RETURN_SN }),
      );
      expect(r.orderSn).toBe(ORDER_SN);
    }
  });

  it('o order_sn é VERBATIM — nunca aparado (é o preimage do id do pedido)', () => {
    // Near-miss: a padded key is refused, never trimmed into a DIFFERENT digest.
    expect(
      recusa(alvoDoPushDeDevolucao({ order_sn: ` ${ORDER_SN} `, return_sn: RETURN_SN })),
    ).toContain('order_sn/ordersn');
  });

  it.each([
    ['ausente', {}],
    ['vazio', { order_sn: '' }],
    ['a sentinela `-`', { order_sn: '-' }],
    ['só espaço nas duas grafias', { order_sn: ' ', ordersn: '  ' }],
    ['um número', { order_sn: 260910 }],
  ])('RECUSA quando o pedido é %s — e o motivo nomeia só os CAMPOS', (_rotulo, chaves) => {
    const motivo = recusa(alvoDoPushDeDevolucao({ ...chaves, return_sn: RETURN_SN }));
    expect(motivo).toContain('order_sn/ordersn');
    expect(motivo).not.toContain(RETURN_SN);
  });

  it.each([
    ['ausente', undefined],
    ['null', null],
    ['vazio', ''],
  ])('RECUSA quando o return_sn está %s', (_rotulo, bruto) => {
    expect(recusa(alvoDoPushDeDevolucao({ order_sn: ORDER_SN, return_sn: bruto }))).toContain(
      'sem return_sn',
    );
  });

  it.each([
    ['com espaço', ` ${RETURN_SN}`],
    ['só espaço', ' '],
    ['com barra', '2609/0001'],
    ['com dois-pontos', '2609:0001'],
    ['com hífen', '2609-0001'],
    ['acentuado', 'DEVOLUÇÃO1'],
    ['com 65 caracteres', 'Z'.repeat(65)],
    ['um NÚMERO JSON (já arredondado pelo JSON.parse acima de 2^53)', 2609100000000001],
    ['um objeto', { id: RETURN_SN }],
  ])('RECUSA um return_sn %s — e nunca ecoa o valor', (_rotulo, bruto) => {
    const motivo = recusa(alvoDoPushDeDevolucao({ order_sn: ORDER_SN, return_sn: bruto }));
    expect(motivo).toContain('return_sn fora do formato');
    if (typeof bruto === 'string' && bruto.trim().length > 0) expect(motivo).not.toContain(bruto);
  });
});

describe('alvoDoPushDeDevolucao — a origem', () => {
  it.each(['reconciliacao', 'acao-vendedor', 'push'] as const)(
    'lê `data.origem` %s de um sintético',
    (origem) => {
      const r = ok(alvoDoPushDeDevolucao({ order_sn: ORDER_SN, return_sn: RETURN_SN, origem }));
      expect(r.origem).toBe(origem);
    },
  );

  it.each([['backfill'], ['devolucao'], ['RECONCILIACAO'], [' push'], [1], [null]])(
    'uma origem fora do conjunto (%s) é um push real',
    (origem) => {
      const r = ok(alvoDoPushDeDevolucao({ order_sn: ORDER_SN, return_sn: RETURN_SN, origem }));
      expect(r.origem).toBe('push');
    },
  );
});

describe('alvoDoPushDeDevolucao — o diário (SÓ LOG)', () => {
  it('do push 32: os campos que mudaram, o relógio do push e o status que ele DIZ', () => {
    const r = ok(alvoDoPushDeDevolucao({ ...DATA_PUSH_32 }));
    expect(r.diario).toEqual({
      camposMudados: ['return_status', 'logistics_status'],
      relogioDoPushS: 1_732_796_767,
      statusNoPush: 'PROCESSING',
    });
  });

  it('um SINTÉTICO (sem updated_values) tem o diário vazio por construção', () => {
    const r = ok(
      alvoDoPushDeDevolucao({ order_sn: ORDER_SN, return_sn: RETURN_SN, origem: 'reconciliacao' }),
    );
    expect(r.diario).toEqual({ camposMudados: [], relogioDoPushS: null, statusNoPush: null });
  });

  it('NUNCA lê um `update_time` de topo — o push 32 não tem um, e inventá-lo daria um relógio sem fonte', () => {
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        update_time: 1_789_000_000,
      }),
    );
    expect(r.diario.relogioDoPushS).toBeNull();
  });

  it('o relógio do push é o MAIOR por campo, em SEGUNDOS (sem conversão de unidade)', () => {
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: [
          { update_field: 'seller_proof_status', new_value: 'PENDING', update_time: 1_789_000_010 },
          { update_field: 'return_status', new_value: 'ACCEPTED', update_time: '1789000020' },
          { update_field: 'logistics_status', new_value: 'X', update_time: 1_789_000_005 },
        ],
      }),
    );
    expect(r.diario.relogioDoPushS).toBe(1_789_000_020);
  });

  it('um relógio zerado (ou antes de 2020) não é relógio', () => {
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: [
          { update_field: 'return_status', new_value: 'REQUESTED', update_time: 0 },
          { update_field: 'logistics_status', new_value: 'X', update_time: 1_500_000_000 },
        ],
      }),
    );
    expect(r.diario.relogioDoPushS).toBeNull();
    expect(r.diario.statusNoPush).toBe('REQUESTED');
  });

  it('o status do push é o da entrada `return_status` MAIS NOVA, não a última listada', () => {
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: [
          { update_field: 'return_status', new_value: 'ACCEPTED', update_time: 1_789_000_020 },
          { update_field: 'return_status', new_value: 'REQUESTED', update_time: 1_789_000_010 },
          { update_field: 'return_status', new_value: 'JUDGING' },
        ],
      }),
    );
    expect(r.diario.statusNoPush).toBe('ACCEPTED');
    expect(r.diario.camposMudados).toEqual(['return_status']);
  });

  it('QUASE-IGUAL (G1): a MAIS NOVA vence também quando vem listada DEPOIS', () => {
    // The case above lists the newer entry FIRST, where "keep the first" and
    // "keep the newest" agree; here they disagree, and only the newest is right.
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: [
          { update_field: 'return_status', new_value: 'REQUESTED', update_time: 1_789_000_010 },
          { update_field: 'return_status', new_value: 'ACCEPTED', update_time: 1_789_000_020 },
        ],
      }),
    );
    expect(r.diario.statusNoPush).toBe('ACCEPTED');
  });

  it('o token do diário é a regra ÚNICA (`tokenParaLog.ts`), mas o que falha nela é DESCARTADO, nunca marcado', () => {
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: [
          { update_field: 'Z'.repeat(64), new_value: 'X', update_time: 1_789_000_000 },
          { update_field: 'Z'.repeat(65), new_value: 'X', update_time: 1_789_000_000 },
          { update_field: 'return_status', new_value: ' ACCEPTED', update_time: 1_789_000_001 },
        ],
      }),
    );
    expect(r.diario.camposMudados).toEqual(['Z'.repeat(64), 'return_status']);
    expect(r.diario.statusNoPush).toBeNull();
    expect(JSON.stringify(r)).not.toContain('<nao-token>');
  });

  it('o new_value de OUTRO campo nunca vira o status do push', () => {
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: [
          { update_field: 'logistics_status', new_value: 'CLOSED', update_time: 1_789_000_010 },
          { update_field: 'return_status_x', new_value: 'CANCELLED', update_time: 1_789_000_010 },
        ],
      }),
    );
    expect(r.diario.statusNoPush).toBeNull();
  });

  it(`deduplica os campos na ordem de chegada e guarda no máximo ${String(MAX_CAMPOS_NO_DIARIO)}`, () => {
    const repetidos = Array.from({ length: 20 }, (_, i) => ({
      update_field: `campo_${String(i % 12)}`,
      new_value: 'X',
      update_time: 1_789_000_000,
    }));
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: repetidos,
      }),
    );
    expect(MAX_CAMPOS_NO_DIARIO).toBe(8);
    expect(r.diario.camposMudados).toEqual([
      'campo_0',
      'campo_1',
      'campo_2',
      'campo_3',
      'campo_4',
      'campo_5',
      'campo_6',
      'campo_7',
    ]);
  });

  it('só TOKENS chegam ao diário — texto livre é descartado, nunca logado', () => {
    const texto = 'O comprador disse que a caixa chegou amassada';
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: [
          { update_field: texto, new_value: 'X', update_time: 1_789_000_000 },
          { update_field: 'return_status', new_value: texto, update_time: 1_789_000_001 },
        ],
      }),
    );
    expect(r.diario.camposMudados).toEqual(['return_status']);
    expect(r.diario.statusNoPush).toBeNull();
    expect(JSON.stringify(r)).not.toContain('amassada');
  });

  it.each([
    ['um escalar', 'return_status'],
    ['um objeto', { update_field: 'return_status' }],
    ['null', null],
  ])(
    'um `updated_values` que não é lista (%s) é um diário vazio — nunca uma recusa',
    (_r, bruto) => {
      const r = ok(
        alvoDoPushDeDevolucao({ order_sn: ORDER_SN, return_sn: RETURN_SN, updated_values: bruto }),
      );
      expect(r.diario).toEqual({ camposMudados: [], relogioDoPushS: null, statusNoPush: null });
    },
  );

  it('uma entrada torta custa só ELA — as irmãs ainda entram no diário', () => {
    const r = ok(
      alvoDoPushDeDevolucao({
        order_sn: ORDER_SN,
        return_sn: RETURN_SN,
        updated_values: [
          'lixo',
          null,
          { update_field: 'return_status', new_value: 'CLOSED', update_time: 'amanhã' },
          { update_field: 'seller_proof_status', new_value: 'PENDING', update_time: 1_789_000_000 },
        ],
      }),
    );
    expect(r.diario).toEqual({
      camposMudados: ['return_status', 'seller_proof_status'],
      relogioDoPushS: 1_789_000_000,
      statusNoPush: 'CLOSED',
    });
  });
});
