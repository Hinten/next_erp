import { describe, expect, it } from 'vitest';
import { MOTIVO_IMPORTACAO_PARADA_LI } from './aviso';
import * as barrel from './index';
import { DATA_MODIFICACAO_LI_REGEX } from './notificacaoLojaIntegrada';
import * as modulo from './pollPedidosLojaIntegrada';
import {
  CURSOR_POLL_LI_REGEX,
  MARCA_DATA_ILEGIVEL_LI,
  cursorPollLiSchema,
  pollPedidosLojaIntegradaSchema,
  vistoPollLiSchema,
} from './pollPedidosLojaIntegrada';
import { ALL_DOMAINS } from './registry';

describe('pollPedidosLojaIntegradaSchema', () => {
  it('an empty document parses to the defaults: no cursor, no lease, no failure, nothing seen', () => {
    expect(pollPedidosLojaIntegradaSchema.parse({})).toEqual({
      cursor: null,
      emExecucaoAteMs: 0,
      execucaoId: null,
      ultimaVarreduraEmMs: null,
      ultimoErro: null,
      falhasSeguidas: 0,
      vistos: {},
    });
  });

  it('a full document round-trips', () => {
    const doc = {
      cursor: '2026-10-13T08:15:58',
      emExecucaoAteMs: 1_791_000_000_000,
      execucaoId: 'run-1',
      ultimaVarreduraEmMs: 1_790_999_000_000,
      ultimoErro: MOTIVO_IMPORTACAO_PARADA_LI.janelaInstavel,
      falhasSeguidas: 2,
      vistos: { '164': '2022-10-31T12:17:58.949670', '165': MARCA_DATA_ILEGIVEL_LI },
    };
    expect(pollPedidosLojaIntegradaSchema.parse(doc)).toEqual(doc);
  });

  it('STRIPS unknown keys', () => {
    const parsed = pollPedidosLojaIntegradaSchema.parse({
      cursor: null,
      continuacao: 'offset=40',
      ultimoErroDetalhe: 'texto livre',
    }) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'continuacao')).toBe(false);
    expect(Object.hasOwn(parsed, 'ultimoErroDetalhe')).toBe(false);
  });

  it('cursor: only the naive 19-character form', () => {
    for (const ok of ['2026-10-13T08:15:58', '2028-02-29T23:59:59', '2026-01-01T00:00:00']) {
      expect(cursorPollLiSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const ruim of [
      '2026-10-13T08:15:58.000000',
      '2026-10-13T08:15:58Z',
      '2026-10-13T08:15:58-03:00',
      '2026-10-13 08:15:58',
      '2026-10-13T08:15',
      '2026-10-13T24:00:00',
      '2026-13-01T00:00:00',
      '2026-10-13t08:15:58',
      ' 2026-10-13T08:15:58',
      '',
    ]) {
      expect(cursorPollLiSchema.safeParse(ruim).success, ruim).toBe(false);
    }
  });

  it("the cursor grammar is exactly the canonical stamp's whole-second prefix", () => {
    const canonica = '2022-10-31T12:28:12.653648';
    expect(DATA_MODIFICACAO_LI_REGEX.test(canonica)).toBe(true);
    expect(CURSOR_POLL_LI_REGEX.test(canonica.slice(0, 19))).toBe(true);
    expect(CURSOR_POLL_LI_REGEX.source).toBe(
      DATA_MODIFICACAO_LI_REGEX.source.replace('\\.[0-9]{6}$', '$'),
    );
  });

  it('vistos: numero keys in the payload grammar, canonical stamps or the unreadable marker', () => {
    const ok = (vistos: unknown) => pollPedidosLojaIntegradaSchema.safeParse({ vistos }).success;
    expect(ok({ '164': '2022-10-31T12:17:58.949670' })).toBe(true);
    expect(ok({ '9007199254740991': MARCA_DATA_ILEGIVEL_LI })).toBe(true);
    // Near-misses on the key: a leading zero, zero, past 2^53 - 1, not digits.
    for (const chave of ['0164', '0', '9007199254740992', 'abc', '']) {
      expect(ok({ [chave]: '2022-10-31T12:17:58.949670' }), chave).toBe(false);
    }
    // Near-misses on the value: a short fraction, the space form, another marker.
    for (const valor of [
      '2022-10-31T12:17:58.9',
      '2022-10-31T12:17:58',
      '2022-10-31 12:17:58.949670',
      '??',
      '',
      null,
    ]) {
      expect(ok({ '164': valor }), String(valor)).toBe(false);
    }
  });

  it('the unreadable marker is the one non-stamp value, and it is not a canonical stamp', () => {
    expect(MARCA_DATA_ILEGIVEL_LI).toBe('?');
    expect(DATA_MODIFICACAO_LI_REGEX.test(MARCA_DATA_ILEGIVEL_LI)).toBe(false);
    expect(vistoPollLiSchema.safeParse(MARCA_DATA_ILEGIVEL_LI).success).toBe(true);
  });

  it('ultimoErro: a motivo code or null, nothing else', () => {
    const ok = (ultimoErro: unknown) =>
      pollPedidosLojaIntegradaSchema.safeParse({ ultimoErro }).success;
    for (const motivo of Object.values(MOTIVO_IMPORTACAO_PARADA_LI)) expect(ok(motivo)).toBe(true);
    expect(ok(null)).toBe(true);
    for (const ruim of ['conta-parada', 'falha transitória', 'FILTRO-IGNORADO', '']) {
      expect(ok(ruim), ruim).toBe(false);
    }
  });

  it('falhasSeguidas: a non-negative integer', () => {
    const ok = (falhasSeguidas: unknown) =>
      pollPedidosLojaIntegradaSchema.safeParse({ falhasSeguidas }).success;
    expect(ok(0)).toBe(true);
    expect(ok(3)).toBe(true);
    for (const ruim of [-1, 1.5, '1', null]) expect(ok(ruim), String(ruim)).toBe(false);
  });

  it('the lease: 0 and null are the released state; execucaoId is never empty', () => {
    const lido = pollPedidosLojaIntegradaSchema.parse({ emExecucaoAteMs: 0, execucaoId: null });
    expect(lido.emExecucaoAteMs).toBe(0);
    expect(lido.execucaoId).toBeNull();
    expect(pollPedidosLojaIntegradaSchema.safeParse({ execucaoId: '' }).success).toBe(false);
  });
});

describe('pollPedidosLojaIntegrada is admin-only', () => {
  it('is NOT registered in ALL_DOMAINS', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(pollPedidosLojaIntegradaSchema);
    expect(ALL_DOMAINS.map((d) => d.meta.collectionPath)).not.toContain('pollPedidosLojaIntegrada');
  });

  it('the module exports nothing combined { schema, meta }, and the barrel re-exports it bare', () => {
    expect(Object.keys(modulo).length).toBeGreaterThan(0);
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });
});
