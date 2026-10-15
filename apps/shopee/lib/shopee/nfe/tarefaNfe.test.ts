import { describe, expect, it } from 'vitest';

import {
  FASE_NFE_SHOPEE,
  faseNfeShopeeSchema,
  tarefaNfeShopeeSchema,
  type AgendadorNfeShopee,
  type ContextoNfeShopee,
  type DepsNfeShopee,
  type OpcoesDeEnfileiramentoNfe,
  type ResultadoNfeShopee,
  type TarefaNfeShopee,
} from './tarefaNfe';

/** Type-level equality: `true` only when A and B are the same set of literals. */
type Igual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const MINIMA = { pedidoId: 'pedido-1', nfeId: 'nfe-1' } as const;

describe('faseNfeShopeeSchema / FASE_NFE_SHOPEE', () => {
  it('1 — as duas fases, e o const é exatamente as opções do enum', () => {
    expect([...faseNfeShopeeSchema.options].sort()).toEqual(['envio', 'reverificacao']);
    expect(Object.values(FASE_NFE_SHOPEE).sort()).toEqual([...faseNfeShopeeSchema.options].sort());
    for (const [chave, valor] of Object.entries(FASE_NFE_SHOPEE)) expect(chave).toBe(valor);
  });
});

describe('tarefaNfeShopeeSchema', () => {
  it('2 — PAR: `{ pedidoId, nfeId }` basta — fase `envio` e os três contadores em 0', () => {
    expect(tarefaNfeShopeeSchema.parse(MINIMA)).toEqual({
      pedidoId: 'pedido-1',
      nfeId: 'nfe-1',
      fase: 'envio',
      adiamentosSerpro: 0,
      pausas: 0,
      reverificacoes: 0,
    });
  });

  it('3 — uma carga completa volta IGUAL (a reentrega da própria tarefa)', () => {
    const cheia: TarefaNfeShopee = {
      pedidoId: 'pedido-1',
      nfeId: 'nfe-1',
      fase: FASE_NFE_SHOPEE.reverificacao,
      adiamentosSerpro: 2,
      pausas: 5,
      reverificacoes: 1,
    };
    expect(tarefaNfeShopeeSchema.parse(cheia)).toEqual(cheia);
  });

  it("4 — ⛔ NEAR-MISS: `fase: 'x'` é recusada, e uma fase em maiúsculas também", () => {
    expect(tarefaNfeShopeeSchema.safeParse({ ...MINIMA, fase: 'x' }).success).toBe(false);
    expect(tarefaNfeShopeeSchema.safeParse({ ...MINIMA, fase: 'Envio' }).success).toBe(false);
    expect(tarefaNfeShopeeSchema.safeParse({ ...MINIMA, fase: null }).success).toBe(false);
  });

  it('5 — ⛔ `.strict()`: uma chave a mais é recusada — conta, número do pedido e chave de acesso NUNCA viajam', () => {
    for (const extra of ['integracaoId', 'orderSn', 'order_sn', 'chave', 'numero', 'xml']) {
      const r = tarefaNfeShopeeSchema.safeParse({ ...MINIMA, [extra]: 'qualquer' });
      expect({ extra, success: r.success }).toEqual({ extra, success: false });
    }
  });

  it('6 — ⛔ um contador negativo, fracionário ou em texto é recusado', () => {
    for (const campo of ['adiamentosSerpro', 'pausas', 'reverificacoes'] as const) {
      for (const valor of [-1, 0.5, '1', Number.NaN]) {
        const r = tarefaNfeShopeeSchema.safeParse({ ...MINIMA, [campo]: valor });
        expect({ campo, valor, success: r.success }).toEqual({ campo, valor, success: false });
      }
    }
  });

  it('7 — ⛔ `pedidoId` e `nfeId` são obrigatórios e não vazios', () => {
    expect(tarefaNfeShopeeSchema.safeParse({ nfeId: 'nfe-1' }).success).toBe(false);
    expect(tarefaNfeShopeeSchema.safeParse({ pedidoId: 'pedido-1' }).success).toBe(false);
    expect(tarefaNfeShopeeSchema.safeParse({ ...MINIMA, pedidoId: '' }).success).toBe(false);
    expect(tarefaNfeShopeeSchema.safeParse({ ...MINIMA, nfeId: '' }).success).toBe(false);
    expect(tarefaNfeShopeeSchema.safeParse(null).success).toBe(false);
  });

  it('8 — a carga tem EXATAMENTE seis campos, em tempo de compilação', () => {
    const campos: Igual<
      keyof TarefaNfeShopee,
      'pedidoId' | 'nfeId' | 'fase' | 'adiamentosSerpro' | 'pausas' | 'reverificacoes'
    > = true;
    expect(campos).toBe(true);
  });
});

describe('o seam de enfileiramento e o contexto', () => {
  it('9 — um gravador satisfaz o agendador, e o atraso é OPCIONAL (ausente ≠ undefined)', async () => {
    const gravadas: { payload: TarefaNfeShopee; opts: OpcoesDeEnfileiramentoNfe | undefined }[] =
      [];
    const agendador: AgendadorNfeShopee = {
      enqueue: (payload, opts) => {
        gravadas.push({ payload, opts });
        return Promise.resolve();
      },
    };
    const tarefa = tarefaNfeShopeeSchema.parse(MINIMA);
    await agendador.enqueue(tarefa);
    await agendador.enqueue(tarefa, { scheduleDelaySeconds: 360 });
    expect(gravadas.map((g) => g.opts)).toEqual([undefined, { scheduleDelaySeconds: 360 }]);
  });

  it('10 — o contexto tem EXATAMENTE os seis campos da §2.8, em tempo de compilação', () => {
    const campos: Igual<
      keyof ContextoNfeShopee,
      'pedidoId' | 'nfeId' | 'integracaoId' | 'numero' | 'nossaChave' | 'client'
    > = true;
    expect(campos).toBe(true);
  });
});

describe('F-2 — as deps e o resultado de UMA execução moram no contrato (uma declaração só)', () => {
  it('11 — as deps têm EXATAMENTE os seis campos da W3-1, em tempo de compilação', () => {
    const campos: Igual<
      keyof DepsNfeShopee,
      'db' | 'scheduler' | 'nowMs' | 'increment' | 'jitterSec' | 'resolveClient'
    > = true;
    expect(campos).toBe(true);
  });

  it('12 — o resultado tem EXATAMENTE os sete campos da §2.8, em tempo de compilação', () => {
    const campos: Igual<
      keyof ResultadoNfeShopee,
      'desfecho' | 'motivo' | 'fase' | 'substituicao' | 'carimbo' | 'avisado' | 'resolvido'
    > = true;
    expect(campos).toBe(true);
  });
});
