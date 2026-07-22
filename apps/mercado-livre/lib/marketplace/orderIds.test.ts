import { describe, it, expect } from 'vitest';
import {
  makeItemEnsureUniqueId,
  makePagamentoIdMercadoLivre,
  makePedidoIdMercadoLivre,
} from './orderIds';

describe('makePedidoIdMercadoLivre', () => {
  it('matches the legacy sha256("mercadoLivre<contaId>-<orderId>") digest (no pack)', () => {
    // sha256(utf8("mercadoLivreCONTA123-987654321"))
    expect(makePedidoIdMercadoLivre('CONTA123', 987654321)).toBe(
      '0d39fd75b0bd5db6265c5163cede0dc35b9905f5567b4e98851c47af0783b89d',
    );
  });

  it('uses packId instead of orderId when a pack is present', () => {
    // sha256(utf8("mercadoLivreCONTA123-111222333"))
    expect(makePedidoIdMercadoLivre('CONTA123', 987654321, 111222333)).toBe(
      '16796fd16a3f32c9358b311147db52ab3da9ca108c7860785509e5a73369ff9a',
    );
  });

  it('null/undefined packId falls back to orderId (same digest as no pack)', () => {
    expect(makePedidoIdMercadoLivre('CONTA123', 987654321, null)).toBe(
      makePedidoIdMercadoLivre('CONTA123', 987654321),
    );
    expect(makePedidoIdMercadoLivre('CONTA123', 987654321, undefined)).toBe(
      makePedidoIdMercadoLivre('CONTA123', 987654321),
    );
  });

  it('a different contaId yields a different id (account isolation)', () => {
    // sha256(utf8("mercadoLivreCONTA999-987654321"))
    expect(makePedidoIdMercadoLivre('CONTA999', 987654321)).toBe(
      'a9857be80635970eb8f7152bd2cebcc41c488231aac7256d47412a017247b616',
    );
    expect(makePedidoIdMercadoLivre('CONTA999', 987654321)).not.toBe(
      makePedidoIdMercadoLivre('CONTA123', 987654321),
    );
  });

  it('presence of packId changes the id vs. no pack at all', () => {
    expect(makePedidoIdMercadoLivre('CONTA123', 987654321, 111222333)).not.toBe(
      makePedidoIdMercadoLivre('CONTA123', 987654321),
    );
  });

  it('returns a 64-char lowercase hex digest', () => {
    const id = makePedidoIdMercadoLivre('CONTA123', 1);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('makeItemEnsureUniqueId', () => {
  it('matches the legacy sha256("<orderId>-<mktplaceId>-<index>") digest', () => {
    // sha256(utf8("987654321-MLB123456-0"))
    expect(makeItemEnsureUniqueId(987654321, 'MLB123456', 0)).toBe(
      '5d060a8efc6b81c996197aa01b9f666f60d72098ecc570ced852621ed27c52bf',
    );
  });

  it('a different index changes the id (disambiguates repeated lines)', () => {
    // sha256(utf8("987654321-MLB123456-1"))
    expect(makeItemEnsureUniqueId(987654321, 'MLB123456', 1)).toBe(
      '990a7abb804b0ea03fdff2fc6634a5c45ed3464811828b42a8fda836f84cb490',
    );
    expect(makeItemEnsureUniqueId(987654321, 'MLB123456', 1)).not.toBe(
      makeItemEnsureUniqueId(987654321, 'MLB123456', 0),
    );
  });

  it('a variation-id mktplaceId produces a different id than the plain item id', () => {
    // sha256(utf8("987654321-55667788-0"))
    expect(makeItemEnsureUniqueId(987654321, '55667788', 0)).toBe(
      '4df891fa3174571ababee0f8c72ce9e5f818f6c7871dea61b4ed5af4e8362a7b',
    );
    expect(makeItemEnsureUniqueId(987654321, '55667788', 0)).not.toBe(
      makeItemEnsureUniqueId(987654321, 'MLB123456', 0),
    );
  });

  it('returns a 64-char lowercase hex digest', () => {
    expect(makeItemEnsureUniqueId(1, 'x', 0)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('makePagamentoIdMercadoLivre', () => {
  it('matches the legacy sha1("/documents/integracao/<contaId><paymentId>") digest', () => {
    // sha1(utf8("/documents/integracao/CONTA12325110070625"))
    expect(makePagamentoIdMercadoLivre('CONTA123', 25110070625)).toBe(
      '8b2c91eee36e1ea698eb8c5d7f7feed1de265cd4',
    );
  });

  it('accepts a string paymentId with the same result as the equivalent number', () => {
    expect(makePagamentoIdMercadoLivre('CONTA123', '25110070625')).toBe(
      makePagamentoIdMercadoLivre('CONTA123', 25110070625),
    );
  });

  it('the leading slash is load-bearing — omitting it changes the digest', () => {
    // sha1(utf8("documents/integracao/CONTA12325110070625")) — no leading slash
    const withoutLeadingSlash = '772b60dbfabe9dbfc6d2b52bdb020158a572236a';
    expect(makePagamentoIdMercadoLivre('CONTA123', 25110070625)).not.toBe(withoutLeadingSlash);
  });

  it('returns a 40-char lowercase hex digest', () => {
    expect(makePagamentoIdMercadoLivre('CONTA123', 1)).toMatch(/^[0-9a-f]{40}$/);
  });
});
