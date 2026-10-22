import { describe, expect, it } from 'vitest';
import { MOTIVO_IMPORTACAO_PARADA_AMAZON } from './aviso';
import * as barrel from './index';
import * as modulo from './pollPedidosAmazon';
import {
  LAST_UPDATED_AFTER_POLL_AMAZON_REGEX,
  MARKETPLACE_IDS_POLL_AMAZON_REGEX,
  pendentePollAmazonSchema,
  pollPedidosAmazonSchema,
} from './pollPedidosAmazon';
import { ALL_DOMAINS } from './registry';

const PENDENTE = {
  paginationToken: 'token-opaco+/=',
  lastUpdatedAfter: '2027-01-15T09:50:00Z',
  marketplaceIds: 'A2Q3Y263D00KWC',
  inicioDrenagemMs: 1_800_000_000_000,
  tokenEmMs: 1_800_000_060_000,
  paginas: 5,
  linhaInvalida: false,
  maiorLinhaMs: 1_799_999_900_000,
};

describe('pollPedidosAmazonSchema', () => {
  it('an empty document parses to the defaults: no cursor, nothing pending or seen, no lease, no failure', () => {
    expect(pollPedidosAmazonSchema.parse({})).toEqual({
      cursorMs: null,
      pendente: null,
      vistos: {},
      emExecucaoAteMs: 0,
      execucaoId: null,
      ultimaVarreduraEmMs: null,
      ultimoErro: null,
      falhasSeguidas: 0,
    });
  });

  it('a full document round-trips', () => {
    const doc = {
      cursorMs: 1_799_999_000_000,
      pendente: PENDENTE,
      vistos: { '171-2345678-9012345': 1_799_999_000_123_456 },
      emExecucaoAteMs: 1_800_000_360_000,
      execucaoId: 'run-1',
      ultimaVarreduraEmMs: 1_799_999_100_000,
      ultimoErro: MOTIVO_IMPORTACAO_PARADA_AMAZON.limiteDeTaxa,
      falhasSeguidas: 2,
    };
    expect(pollPedidosAmazonSchema.parse(doc)).toEqual(doc);
  });

  it('a W7 re-bootstrap (cursorMs, pendente and vistos deleted) parses as cursorless', () => {
    const parsed = pollPedidosAmazonSchema.parse({
      emExecucaoAteMs: 0,
      execucaoId: null,
      falhasSeguidas: 1,
      ultimoErro: 'falha-transitoria',
    });
    expect(parsed.cursorMs).toBeNull();
    expect(parsed.pendente).toBeNull();
    expect(parsed.vistos).toEqual({});
  });

  it('STRIPS unknown keys, on the document and inside pendente', () => {
    const parsed = pollPedidosAmazonSchema.parse({
      cursorMs: 1,
      pendente: { ...PENDENTE, lastUpdatedBefore: '2027-01-15T10:00:00Z' },
      ultimoErroDetalhe: 'texto livre',
    }) as Record<string, unknown> & { pendente: Record<string, unknown> };
    expect(Object.hasOwn(parsed, 'ultimoErroDetalhe')).toBe(false);
    expect(Object.hasOwn(parsed.pendente, 'lastUpdatedBefore')).toBe(false);
  });

  it('cursorMs is a STRICT non-negative safe integer — never coerced, never a string', () => {
    for (const ruim of [-1, 1.5, '1800000000000', Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      expect(pollPedidosAmazonSchema.safeParse({ cursorMs: ruim }).success, String(ruim)).toBe(
        false,
      );
    }
    // Near-miss: a µs-sized number stays EXACTLY that number (no ms/µs coercion).
    expect(pollPedidosAmazonSchema.parse({ cursorMs: 1_800_000_000_000_000 }).cursorMs).toBe(
      1_800_000_000_000_000,
    );
  });

  it('vistos: keys are 3-7-7 order ids, values µs safe integers', () => {
    expect(
      pollPedidosAmazonSchema.safeParse({ vistos: { '171-2345678-9012345': 1 } }).success,
    ).toBe(true);
    for (const chave of ['171-2345678-901234', 'ABC-2345678-9012345', '171_2345678_9012345']) {
      expect(pollPedidosAmazonSchema.safeParse({ vistos: { [chave]: 1 } }).success, chave).toBe(
        false,
      );
    }
    for (const valor of [-1, 1.5, '1']) {
      expect(
        pollPedidosAmazonSchema.safeParse({ vistos: { '171-2345678-9012345': valor } }).success,
        String(valor),
      ).toBe(false);
    }
  });

  it('ultimoErro takes only the Amazon motivos', () => {
    expect(pollPedidosAmazonSchema.safeParse({ ultimoErro: 'vendedor-duplicado' }).success).toBe(
      true,
    );
    // Uncounted outcomes, and a Loja Integrada motivo, are not Amazon's.
    for (const ruim of ['conta-parada', 'paginacao-expirada', 'janela-instavel']) {
      expect(pollPedidosAmazonSchema.safeParse({ ultimoErro: ruim }).success, ruim).toBe(false);
    }
  });
});

describe('pendentePollAmazonSchema', () => {
  it('a null token is page 1 of the stored window', () => {
    expect(pendentePollAmazonSchema.parse({ ...PENDENTE, paginationToken: null })).toEqual({
      ...PENDENTE,
      paginationToken: null,
    });
  });

  it('linhaInvalida: absent reads as false, a stored true survives, a non-boolean is refused', () => {
    const { linhaInvalida: _semFlag, ...semFlag } = PENDENTE;
    expect(pendentePollAmazonSchema.parse(semFlag).linhaInvalida).toBe(false);
    expect(pendentePollAmazonSchema.parse({ ...PENDENTE, linhaInvalida: true }).linhaInvalida).toBe(
      true,
    );
    for (const ruim of ['true', 1, null]) {
      expect(
        pendentePollAmazonSchema.safeParse({ ...PENDENTE, linhaInvalida: ruim }).success,
        String(ruim),
      ).toBe(false);
    }
  });

  it('maiorLinhaMs: absent (a pendente stored before the field) reads as null, a stored stamp survives', () => {
    const { maiorLinhaMs: _semMaximo, ...semMaximo } = PENDENTE;
    expect(pendentePollAmazonSchema.parse(semMaximo).maiorLinhaMs).toBeNull();
    expect(
      pollPedidosAmazonSchema.parse({ pendente: semMaximo }).pendente?.maiorLinhaMs,
    ).toBeNull();
    expect(pendentePollAmazonSchema.parse({ ...PENDENTE, maiorLinhaMs: null }).maiorLinhaMs).toBe(
      null,
    );
    expect(pendentePollAmazonSchema.parse(PENDENTE).maiorLinhaMs).toBe(1_799_999_900_000);
  });

  it('maiorLinhaMs is a STRICT non-negative safe integer — never coerced, never a string', () => {
    for (const ruim of [-1, 1.5, '1799999900000', Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      expect(
        pendentePollAmazonSchema.safeParse({ ...PENDENTE, maiorLinhaMs: ruim }).success,
        String(ruim),
      ).toBe(false);
    }
    // Near-miss: 0 and the largest safe integer are stamps like any other.
    for (const ok of [0, Number.MAX_SAFE_INTEGER]) {
      expect(pendentePollAmazonSchema.parse({ ...PENDENTE, maiorLinhaMs: ok }).maiorLinhaMs).toBe(
        ok,
      );
    }
  });

  it('refuses an empty token: it could only be read as "no more pages"', () => {
    expect(pendentePollAmazonSchema.safeParse({ ...PENDENTE, paginationToken: '' }).success).toBe(
      false,
    );
  });

  it('lastUpdatedAfter: only the whole-second UTC form the poll builds', () => {
    for (const ok of ['2027-01-15T09:50:00Z', '2028-02-29T23:59:59Z']) {
      expect(LAST_UPDATED_AFTER_POLL_AMAZON_REGEX.test(ok), ok).toBe(true);
    }
    for (const ruim of [
      '2027-01-15T09:50:00.000Z',
      '2027-01-15T09:50:00',
      '2027-01-15T06:50:00-03:00',
      '2027-01-15 09:50:00Z',
      '2027-13-15T09:50:00Z',
    ]) {
      expect(LAST_UPDATED_AFTER_POLL_AMAZON_REGEX.test(ruim), ruim).toBe(false);
    }
  });

  it('marketplaceIds: one CSV of uppercase ids, no spaces', () => {
    expect(MARKETPLACE_IDS_POLL_AMAZON_REGEX.test('A2Q3Y263D00KWC')).toBe(true);
    expect(MARKETPLACE_IDS_POLL_AMAZON_REGEX.test('A2Q3Y263D00KWC,ATVPDKIKX0DER')).toBe(true);
    for (const ruim of ['', 'A2Q3Y263D00KWC, ATVPDKIKX0DER', 'a2q3y263d00kwc', 'A2Q3Y263D00KWC,']) {
      expect(MARKETPLACE_IDS_POLL_AMAZON_REGEX.test(ruim), ruim).toBe(false);
    }
  });
});

describe('admin-only / default-deny', () => {
  it('is barrel-exported bare, never as a { schema, meta } pair', () => {
    expect(Object.keys(modulo).length).toBeGreaterThan(0);
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });

  it('is NOT registered in ALL_DOMAINS (no rules block, no client access)', () => {
    expect(ALL_DOMAINS.map((d) => d.schema)).not.toContain(pollPedidosAmazonSchema);
    expect(ALL_DOMAINS.map((d) => d.meta.collectionPath)).not.toContain('pollPedidosAmazon');
  });
});
