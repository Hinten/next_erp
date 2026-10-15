import { describe, expect, it } from 'vitest';
import {
  MODO_LINK_PAGAMENTO,
  MODO_LINK_PAGAMENTO_LABELS,
  STATUS_LINK_PAGAMENTO,
  STATUS_LINK_PAGAMENTO_LABELS,
  TIPO_PAGAMENTO_MP,
  TIPO_PAGAMENTO_MP_LABELS,
  linkPagamentoIdSchema,
  linkPgtoMercadoPagoMeta,
  linkPgtoMercadoPagoSchema,
  modoLinkPagamentoSchema,
  statusLinkPagamentoSchema,
  tipoPagamentoMpSchema,
} from './linkPgtoMercadoPago';

/** A doc exactly as the LEGACY Flutter app wrote it (OLD models.g.dart:147-186). */
const LEGACY = {
  contaMercadoPagoOuterRef: 'documents/metodo_pgto/abc',
  valorCobrado: 50.5,
  link: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=1-x',
  id: '1-x',
  dataCriacao: 1727000000000,
  dataExpiracao: 1727100000000,
};

const ID_20 = '0123456789abcdefABCD';

describe('linkPgtoMercadoPagoSchema — the legacy corpus still parses', () => {
  it('parses a legacy doc, keeping its dates in MILLISECONDS', () => {
    const r = linkPgtoMercadoPagoSchema.safeParse(LEGACY);
    expect(r.success).toBe(true);
    const out = linkPgtoMercadoPagoSchema.parse(LEGACY);
    // Pins the unit: a `microsSinceEpoch` field would hand back ×1000 here.
    expect(out.dataCriacao).toBe(1727000000000);
    expect(out.dataExpiracao).toBe(1727100000000);
    expect(out.id).toBe('1-x');
    // Every field added for #367 is null on a legacy link (untracked), and its
    // status defaults to open — expiry is derived, never stored.
    expect(out.modo).toBeNull();
    expect(out.nomePagador).toBeNull();
    expect(out.quantidadeMaxima).toBeNull();
    expect(out.grupoId).toBeNull();
    expect(out.ordem).toBeNull();
    expect(out.encerradoEm).toBeNull();
    expect(out.encerradoPorOuterRef).toBeNull();
    expect(out.erroEncerramento).toBeNull();
    expect(out.criadoPorOuterRef).toBeNull();
    expect(out.tiposExcluidos).toBeNull();
    expect(out.parcelasMaximas).toBeNull();
    expect(out.status).toBe(STATUS_LINK_PAGAMENTO.aberto);
  });

  it('parses a legacy doc whose preference id and creation date are null', () => {
    const out = linkPgtoMercadoPagoSchema.parse({ ...LEGACY, id: null, dataCriacao: null });
    expect(out.id).toBeNull();
    expect(out.dataCriacao).toBeNull();
  });

  it('materializes the defaultQuery sort key when the writer omits it', () => {
    // A classic `orderBy` EXCLUDES a doc that lacks the ordered field, so an
    // omitted `dataCriacao` must come back as an explicit null, not a dropped key.
    const { dataCriacao: _omitido, id: _semId, ...semChaves } = LEGACY;
    const out = linkPgtoMercadoPagoSchema.parse(semChaves);
    expect('dataCriacao' in out).toBe(true);
    expect(out.dataCriacao).toBeNull();
    expect('id' in out).toBe(true);
    expect(out.id).toBeNull();
  });

  it('strips the ODM extras some legacy docs carry instead of failing the parse', () => {
    const r = linkPgtoMercadoPagoSchema.safeParse({
      ...LEGACY,
      docId: 'AbCdEfGhIjKlMnOpQrSt',
      createTime: '2026-09-01T10:00:00.000Z',
      updateTime: '2026-09-01T10:00:00.000Z',
      readTime: '2026-09-02T10:00:00.000Z',
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    for (const extra of ['docId', 'createTime', 'updateTime', 'readTime']) {
      expect(r.data).not.toHaveProperty(extra);
    }
  });

  it('normalizes a microsecond or ISO date to milliseconds (one unit per orderBy)', () => {
    const out = linkPgtoMercadoPagoSchema.parse({
      ...LEGACY,
      dataCriacao: 1_727_000_000_000_000,
      dataExpiracao: '2026-09-30T23:59:59.000-03:00',
    });
    expect(out.dataCriacao).toBe(1_727_000_000_000);
    expect(out.dataExpiracao).toBe(Date.UTC(2026, 9, 1, 2, 59, 59, 0));
  });

  it('round-trips a fully populated #367 link, every value preserved', () => {
    const doc = {
      ...LEGACY,
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      nomePagador: 'Maria',
      quantidadeMaxima: 3,
      grupoId: 'grupo-1',
      ordem: 2,
      status: STATUS_LINK_PAGAMENTO.cancelado,
      encerradoEm: 1727050000000,
      encerradoPorOuterRef: 'documents/usuarios/u1',
      erroEncerramento: 'Mercado Pago recusou o encerramento',
      criadoPorOuterRef: 'documents/usuarios/u2',
      tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto, TIPO_PAGAMENTO_MP.cartaoDebito],
      parcelasMaximas: 12,
    };
    expect(linkPgtoMercadoPagoSchema.strict().parse(doc)).toEqual(doc);
  });
});

describe('linkPgtoMercadoPagoSchema — bounds', () => {
  const rejects = (patch: Record<string, unknown>) =>
    linkPgtoMercadoPagoSchema.safeParse({ ...LEGACY, ...patch }).success === false;
  const accepts = (patch: Record<string, unknown>) =>
    linkPgtoMercadoPagoSchema.safeParse({ ...LEGACY, ...patch }).success === true;

  it('rejects a charge below one centavo and accepts exactly one', () => {
    expect(rejects({ valorCobrado: 0 })).toBe(true);
    expect(rejects({ valorCobrado: 0.001 })).toBe(true);
    expect(rejects({ valorCobrado: -5 })).toBe(true);
    expect(accepts({ valorCobrado: 0.01 })).toBe(true);
  });

  it('bounds quantidadeMaxima to 1..50', () => {
    expect(rejects({ quantidadeMaxima: 0 })).toBe(true);
    expect(rejects({ quantidadeMaxima: 51 })).toBe(true);
    expect(rejects({ quantidadeMaxima: 1.5 })).toBe(true);
    expect(accepts({ quantidadeMaxima: 1 })).toBe(true);
    expect(accepts({ quantidadeMaxima: 50 })).toBe(true);
  });

  it('bounds nomePagador to 1..20 characters', () => {
    expect(rejects({ nomePagador: 'x'.repeat(21) })).toBe(true);
    expect(rejects({ nomePagador: '' })).toBe(true);
    expect(accepts({ nomePagador: 'x'.repeat(20) })).toBe(true);
  });

  it('bounds parcelasMaximas to 1..12', () => {
    expect(rejects({ parcelasMaximas: 0 })).toBe(true);
    expect(rejects({ parcelasMaximas: 13 })).toBe(true);
    expect(accepts({ parcelasMaximas: 1 })).toBe(true);
    expect(accepts({ parcelasMaximas: 12 })).toBe(true);
  });

  it('never lets every payment type be excluded (at most three of four)', () => {
    const todos = Object.values(TIPO_PAGAMENTO_MP);
    expect(rejects({ tiposExcluidos: todos })).toBe(true);
    expect(accepts({ tiposExcluidos: todos.slice(0, 3) })).toBe(true);
    expect(accepts({ tiposExcluidos: [] })).toBe(true);
    // `account_money` can never be excluded, so it is not a member at all.
    expect(rejects({ tiposExcluidos: ['account_money'] })).toBe(true);
  });

  it('rejects an unknown status or modo', () => {
    expect(rejects({ status: 'expirado' })).toBe(true); // expiry is derived, never stored
    expect(rejects({ status: 'encerrado' })).toBe(true);
    expect(rejects({ modo: 'porPessoa' })).toBe(true);
    expect(rejects({ modo: 'unico' })).toBe(true);
  });

  it('requires dataExpiracao, link and a canonical conta outerRef', () => {
    const { dataExpiracao: _sem, ...semExpiracao } = LEGACY;
    expect(linkPgtoMercadoPagoSchema.safeParse(semExpiracao).success).toBe(false);
    expect(rejects({ link: '' })).toBe(true);
    expect(rejects({ contaMercadoPagoOuterRef: 'metodo_pgto/abc' })).toBe(true);
    expect(rejects({ contaMercadoPagoOuterRef: 'documents/metodo_pgto' })).toBe(true);
    expect(rejects({ encerradoPorOuterRef: 'usuarios/u1' })).toBe(true);
    expect(rejects({ criadoPorOuterRef: 'usuarios/u1' })).toBe(true);
  });

  it('does not require the link to be a URL (legacy tolerance)', () => {
    expect(accepts({ link: 'mercadopago.com.br/checkout?pref_id=1-x' })).toBe(true);
  });
});

describe('linkPgtoMercadoPagoMeta', () => {
  it('lives at the LEGACY leaf, not the issue text spelling', () => {
    expect(linkPgtoMercadoPagoMeta.collectionPath).toBe('pedidos/{pedidoId}/linkPgtoMercadoPago');
    expect(linkPgtoMercadoPagoMeta.collectionPath).not.toContain('linkpagamentomercadopago');
  });

  it('is server-owned with no per-field guard and keeps the collection-group read', () => {
    expect(linkPgtoMercadoPagoMeta.serverOwned).toBe(true);
    // The rules generator throws on `serverOwned` next to `serverOwnedFields`.
    expect(linkPgtoMercadoPagoMeta.serverOwnedFields).toBeUndefined();
    // Leaving it unset keeps the collection-group read block, which is what
    // closes the second legacy rules row.
    expect(linkPgtoMercadoPagoMeta.noCollectionGroupRead).toBeUndefined();
  });

  it('reads on the PAGAMENTO bits, never the pedido ones', () => {
    expect(linkPgtoMercadoPagoMeta.permissions.read).toBe(1n << 24n);
    expect(linkPgtoMercadoPagoMeta.permissions.write).toBe(1n << 25n);
    expect(linkPgtoMercadoPagoMeta.permissions.delete).toBe(1n << 26n);
    expect(linkPgtoMercadoPagoMeta.permissions.read).not.toBe(1n << 16n);
  });

  it('declares the newest-first list the tab reads (its index is required)', () => {
    expect(linkPgtoMercadoPagoMeta.defaultQuery).toEqual({
      orderBy: [{ field: 'dataCriacao', direction: 'desc' }],
      limit: 50,
    });
  });

  it('has no ultimaModificacao / timestamp key (that would need a second index)', () => {
    const shape = linkPgtoMercadoPagoSchema.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty('ultimaModificacao');
    expect(shape).not.toHaveProperty('timestamp');
    // ...and the sort key it does declare exists in the shape.
    expect(shape).toHaveProperty('dataCriacao');
  });
});

describe('linkPagamentoIdSchema', () => {
  it('accepts a 20-character alphanumeric id (the newDocId() shape)', () => {
    expect(linkPagamentoIdSchema.safeParse(ID_20).success).toBe(true);
    expect(linkPagamentoIdSchema.safeParse('A'.repeat(20)).success).toBe(true);
    expect(linkPagamentoIdSchema.safeParse('9'.repeat(20)).success).toBe(true);
  });

  it('rejects 19 and 21 characters', () => {
    expect(linkPagamentoIdSchema.safeParse(ID_20.slice(0, 19)).success).toBe(false);
    expect(linkPagamentoIdSchema.safeParse(`${ID_20}x`).success).toBe(false);
  });

  it('rejects a path separator and any non-alphanumeric character', () => {
    expect(linkPagamentoIdSchema.safeParse(`a/b${ID_20.slice(3)}`).success).toBe(false);
    expect(linkPagamentoIdSchema.safeParse(`a-b${ID_20.slice(3)}`).success).toBe(false);
    expect(linkPagamentoIdSchema.safeParse(`a_b${ID_20.slice(3)}`).success).toBe(false);
    expect(linkPagamentoIdSchema.safeParse(`a b${ID_20.slice(3)}`).success).toBe(false);
  });

  it('rejects a Mercado Pago preference id (that is the `id` FIELD, not the doc id)', () => {
    expect(linkPagamentoIdSchema.safeParse('1234567890-abcdef-1234-5678').success).toBe(false);
  });

  it('rejects an empty or non-string value', () => {
    expect(linkPagamentoIdSchema.safeParse('').success).toBe(false);
    expect(linkPagamentoIdSchema.safeParse(null).success).toBe(false);
    expect(linkPagamentoIdSchema.safeParse(12345678901234567890).success).toBe(false);
  });
});

describe('companion constants', () => {
  it('list exactly the members of their enums, each with a label', () => {
    expect(Object.values(MODO_LINK_PAGAMENTO).sort()).toEqual(
      [...modoLinkPagamentoSchema.options].sort(),
    );
    expect(Object.values(STATUS_LINK_PAGAMENTO).sort()).toEqual(
      [...statusLinkPagamentoSchema.options].sort(),
    );
    expect(Object.values(TIPO_PAGAMENTO_MP).sort()).toEqual(
      [...tipoPagamentoMpSchema.options].sort(),
    );
    for (const modo of modoLinkPagamentoSchema.options) {
      expect(MODO_LINK_PAGAMENTO_LABELS[modo].length).toBeGreaterThan(0);
    }
    for (const status of statusLinkPagamentoSchema.options) {
      expect(STATUS_LINK_PAGAMENTO_LABELS[status].length).toBeGreaterThan(0);
    }
    for (const tipo of tipoPagamentoMpSchema.options) {
      expect(TIPO_PAGAMENTO_MP_LABELS[tipo].length).toBeGreaterThan(0);
    }
  });

  it('maps the Mercado Pago payment_type_ids to the operator-facing names', () => {
    expect(TIPO_PAGAMENTO_MP.cartaoCredito).toBe('credit_card');
    expect(TIPO_PAGAMENTO_MP.cartaoDebito).toBe('debit_card');
    expect(TIPO_PAGAMENTO_MP.boleto).toBe('ticket');
    expect(TIPO_PAGAMENTO_MP.pix).toBe('bank_transfer');
    expect(TIPO_PAGAMENTO_MP_LABELS[TIPO_PAGAMENTO_MP.pix]).toBe('Pix');
  });

  it('labels the modes and statuses in pt-BR', () => {
    expect(MODO_LINK_PAGAMENTO_LABELS[MODO_LINK_PAGAMENTO.individual]).toBe('Por pessoa');
    expect(MODO_LINK_PAGAMENTO_LABELS[MODO_LINK_PAGAMENTO.compartilhado]).toBe('Compartilhado');
    expect(STATUS_LINK_PAGAMENTO_LABELS[STATUS_LINK_PAGAMENTO.aberto]).toBe('Aberto');
    expect(STATUS_LINK_PAGAMENTO_LABELS[STATUS_LINK_PAGAMENTO.concluido]).toBe('Concluído');
    expect(STATUS_LINK_PAGAMENTO_LABELS[STATUS_LINK_PAGAMENTO.cancelado]).toBe('Cancelado');
  });
});
