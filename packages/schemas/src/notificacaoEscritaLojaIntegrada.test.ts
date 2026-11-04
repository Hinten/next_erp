import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import * as modulo from './notificacaoEscritaLojaIntegrada';
import {
  ESTADO_RASTREIO_LI,
  TIPO_TAREFA_ESCRITA_LI,
  camposNotificacaoEscritaLi,
  estadoRastreioLiSchema,
  notificacaoEscritaLojaIntegradaSchema,
  tipoTarefaEscritaLiSchema,
} from './notificacaoEscritaLojaIntegrada';
import { ALL_DOMAINS } from './registry';
import { ESTADO_FRETE } from './shared/frete';

const HEX = '0123456789abcdef'.repeat(4);

/** A minimal failure document of the writes queue, as the shared store writes one. */
const minimo = {
  tipo: 'rastreio',
  contaId: 'conta-li_1',
  numero: '165',
  pedidoId: HEX,
  evento: 'f'.repeat(64),
  estado: 'postado',
  eventoEmMs: 1_789_000_000_123,
};

describe('notificacaoEscritaLojaIntegradaSchema', () => {
  it('applies the resilience defaults to a minimal failure document', () => {
    expect(notificacaoEscritaLojaIntegradaSchema.parse(minimo)).toEqual({
      ...minimo,
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: null,
    });
  });

  it('STRIPS unknown keys — ids and one enum only, never a body (no `fonte`, no `passagemFinal`)', () => {
    const parsed = notificacaoEscritaLojaIntegradaSchema.parse({
      ...minimo,
      cliente: { nome: 'Comprador' },
      codRastreio: 'PJ258408772BR',
      fonte: 'historico',
      passagemFinal: 'quente',
    }) as Record<string, unknown>;
    for (const chave of ['cliente', 'codRastreio', 'fonte', 'passagemFinal']) {
      expect(Object.hasOwn(parsed, chave), chave).toBe(false);
    }
  });

  it('the task tipo: exactly `rastreio`, the constant in step with the enum', () => {
    expect(tipoTarefaEscritaLiSchema.options).toEqual(['rastreio']);
    expect(Object.values(TIPO_TAREFA_ESCRITA_LI)).toEqual(['rastreio']);
    // NEAR-MISS: the queue's sweep tipo is dispatched before any parse, never a payload tipo.
    for (const quase of ['varredura', 'pedido', 'Rastreio', 'rastreio ']) {
      expect(tipoTarefaEscritaLiSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('the estado: exactly the three freight estados a write-back acts on, by the ESTADO_FRETE names', () => {
    expect([...estadoRastreioLiSchema.options].sort()).toEqual(
      [ESTADO_FRETE.postado, ESTADO_FRETE.entregue, ESTADO_FRETE.aguardandoRetirada].sort(),
    );
    expect(Object.values(ESTADO_RASTREIO_LI).sort()).toEqual(
      [...estadoRastreioLiSchema.options].sort(),
    );
    // NEAR-MISS: every other freight estado is unrepresentable in the payload.
    for (const quase of [
      ESTADO_FRETE.aCaminho,
      ESTADO_FRETE.aguardandoPostagem,
      ESTADO_FRETE.cancelado,
      ESTADO_FRETE.devolvido,
      'Postado',
      'postado ',
    ]) {
      expect(estadoRastreioLiSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('pedidoId and evento: exactly 64 lowercase hex characters', () => {
    for (const campo of ['pedidoId', 'evento'] as const) {
      expect(notificacaoEscritaLojaIntegradaSchema.safeParse(minimo).success, campo).toBe(true);
      for (const ruim of [
        HEX.toUpperCase(),
        HEX.slice(1),
        `${HEX}0`,
        `${HEX.slice(1)}g`,
        '',
        'pedidos/x',
        42,
        null,
      ]) {
        expect(
          notificacaoEscritaLojaIntegradaSchema.safeParse({ ...minimo, [campo]: ruim }).success,
          `${campo}: ${String(ruim)}`,
        ).toBe(false);
      }
    }
  });

  it('the conta and the numero use the reads queue grammar (no leading zero, no path)', () => {
    for (const [campo, ruim] of [
      ['numero', '0165'],
      ['numero', '165.0'],
      ['numero', 165],
      ['contaId', 'conta/1'],
      ['contaId', ''],
    ] as const) {
      expect(
        notificacaoEscritaLojaIntegradaSchema.safeParse({ ...minimo, [campo]: ruim }).success,
        `${campo}: ${String(ruim)}`,
      ).toBe(false);
    }
  });

  it('eventoEmMs: a positive safe integer of milliseconds, nothing else', () => {
    for (const ok of [1, 1_789_000_000_123, Number.MAX_SAFE_INTEGER]) {
      expect(
        notificacaoEscritaLojaIntegradaSchema.safeParse({ ...minimo, eventoEmMs: ok }).success,
        String(ok),
      ).toBe(true);
    }
    for (const ruim of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1789000000123', null]) {
      expect(
        notificacaoEscritaLojaIntegradaSchema.safeParse({ ...minimo, eventoEmMs: ruim }).success,
        String(ruim),
      ).toBe(false);
    }
  });

  it('every wire field is required: a payload missing one does not parse', () => {
    for (const campo of Object.keys(camposNotificacaoEscritaLi())) {
      const semCampo: Record<string, unknown> = { ...minimo };
      delete semCampo[campo];
      expect(notificacaoEscritaLojaIntegradaSchema.safeParse(semCampo).success, campo).toBe(false);
    }
  });

  it('is admin-only: NOT in ALL_DOMAINS, and no `{ schema, meta }` export (registry.test)', () => {
    for (const [nome, valor] of Object.entries(modulo)) {
      const ehDominio =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(ehDominio, nome).toBe(false);
    }
    expect(ALL_DOMAINS.map((d) => d.schema)).not.toContain(notificacaoEscritaLojaIntegradaSchema);
  });

  it('is exported from the barrel', () => {
    expect(barrel.notificacaoEscritaLojaIntegradaSchema).toBe(
      notificacaoEscritaLojaIntegradaSchema,
    );
    expect(barrel.TIPO_TAREFA_ESCRITA_LI).toBe(TIPO_TAREFA_ESCRITA_LI);
    expect(barrel.ESTADO_RASTREIO_LI).toBe(ESTADO_RASTREIO_LI);
  });
});
