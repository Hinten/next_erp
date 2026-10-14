import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import * as modulo from './notificacaoLojaIntegrada';
import {
  ORIGEM_NOTIFICACAO_LI,
  TIPO_TAREFA_LI,
  camposNotificacaoLi,
  dataModificacaoLiSchema,
  notificacaoLojaIntegradaSchema,
  numeroPedidoLiSchema,
  origemNotificacaoLiSchema,
  tipoTarefaLiSchema,
} from './notificacaoLojaIntegrada';
import { ALL_DOMAINS } from './registry';

/** A minimal failure document, as the shared store writes one. */
const minimo = {
  tipo: 'pedido',
  contaId: 'conta-li_1',
  numero: '123',
  origem: 'poll',
};

describe('notificacaoLojaIntegradaSchema', () => {
  it('applies the defaults to a minimal failure document', () => {
    expect(notificacaoLojaIntegradaSchema.parse(minimo)).toEqual({
      ...minimo,
      dataModificacaoLi: null,
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: null,
    });
  });

  it('STRIPS unknown keys — the payload is ids only (D13)', () => {
    const parsed = notificacaoLojaIntegradaSchema.parse({
      ...minimo,
      cliente: { nome: 'Fulano de Tal' },
      hubHint: true,
    }) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'cliente')).toBe(false);
    expect(Object.hasOwn(parsed, 'hubHint')).toBe(false);
  });

  it('numero: accepts the decimal grammar up to 2^53 - 1, nothing else', () => {
    for (const ok of ['1', '123', '9007199254740991']) {
      expect(numeroPedidoLiSchema.safeParse(ok).success, ok).toBe(true);
    }
    // Near-misses: a leading zero, one past the safe range, empty, a sign,
    // whitespace, a number instead of a string, 17 digits.
    for (const ruim of [
      '0123',
      '0',
      '9007199254740992',
      '',
      '-1',
      ' 1',
      '1 ',
      '1.0',
      1,
      '12345678901234567',
    ]) {
      expect(numeroPedidoLiSchema.safeParse(ruim).success, String(ruim)).toBe(false);
    }
  });

  it('dataModificacaoLi: only the canonical 26-character form', () => {
    for (const ok of ['2026-10-13T08:15:58.000000', '2026-02-28T23:59:59.999999']) {
      expect(dataModificacaoLiSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const ruim of [
      '2026-10-13T08:15:58',
      '2026-10-13T08:15:58.1',
      '2026-10-13T08:15:58.0000000',
      '2026-10-13T08:15:58.000000Z',
      '2026-10-13T08:15:58.000000-03:00',
      '2026-10-13 08:15:58.000000',
      '2026-13-13T08:15:58.000000',
      '2026-10-13T24:15:58.000000',
      '2026-10-13T08:60:58.000000',
      '',
    ]) {
      expect(dataModificacaoLiSchema.safeParse(ruim).success, ruim).toBe(false);
    }
  });

  it('contaId: the conta grammar — no slash, no dot, no colon, at most 128 characters', () => {
    const ok = (contaId: string) =>
      notificacaoLojaIntegradaSchema.safeParse({ ...minimo, contaId }).success;
    expect(ok('a'.repeat(128))).toBe(true);
    expect(ok('Conta_1-x')).toBe(true);
    for (const ruim of ['', 'a'.repeat(129), 'a/b', '.', '..', 'a.b', 'a:b', 'a b', 'á']) {
      expect(ok(ruim), ruim).toBe(false);
    }
  });

  it('tipo and origem are closed enums with named members', () => {
    expect(tipoTarefaLiSchema.options).toEqual([TIPO_TAREFA_LI.pedido]);
    expect([...origemNotificacaoLiSchema.options].sort()).toEqual(
      [ORIGEM_NOTIFICACAO_LI.poll, ORIGEM_NOTIFICACAO_LI.webhook].sort(),
    );
    for (const [nome, valor] of Object.entries(ORIGEM_NOTIFICACAO_LI)) expect(valor).toBe(nome);
    expect(notificacaoLojaIntegradaSchema.safeParse({ ...minimo, tipo: 'produto' }).success).toBe(
      false,
    );
    expect(notificacaoLojaIntegradaSchema.safeParse({ ...minimo, origem: 'POLL' }).success).toBe(
      false,
    );
  });

  it('the wire fields are a fresh object per call, shared with the persisted schema', () => {
    expect(camposNotificacaoLi()).not.toBe(camposNotificacaoLi());
    expect(Object.keys(camposNotificacaoLi()).sort()).toEqual(
      ['contaId', 'dataModificacaoLi', 'numero', 'origem', 'tipo'].sort(),
    );
  });
});

describe('notificacoesLojaIntegrada is admin-only', () => {
  it('is NOT registered in ALL_DOMAINS', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(notificacaoLojaIntegradaSchema);
  });

  it('the module exports nothing combined { schema, meta }, and the barrel re-exports it bare', () => {
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });
});
