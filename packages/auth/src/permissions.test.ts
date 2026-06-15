import { describe, expect, it } from 'vitest';
import { PERM, hasPerm } from './permissions';

describe('hasPerm', () => {
  it('returns false when claim is undefined', () => {
    expect(hasPerm(undefined, PERM.cliente.read)).toBe(false);
  });

  it('returns false when claim is empty', () => {
    expect(hasPerm('', PERM.cliente.read)).toBe(false);
  });

  it('returns false when claim is not parseable as BigInt', () => {
    expect(hasPerm('not-a-number', PERM.cliente.read)).toBe(false);
  });

  it('returns true when the required bit is set', () => {
    const granted = (PERM.cliente.read | PERM.cliente.write).toString();
    expect(hasPerm(granted, PERM.cliente.read)).toBe(true);
    expect(hasPerm(granted, PERM.cliente.write)).toBe(true);
  });

  it('returns false when the required bit is not set', () => {
    const granted = PERM.cliente.read.toString();
    expect(hasPerm(granted, PERM.cliente.delete)).toBe(false);
  });

  it('handles large permission sets above the JS 53-bit limit', () => {
    // PERM.nfe.delete = 1 << 34, well within 53 bits, but a real-world
    // claim could be a union of dozens of bits. Use a value > 2^53.
    const huge = (1n << 60n) | PERM.cliente.read;
    expect(hasPerm(huge.toString(), PERM.cliente.read)).toBe(true);
    expect(hasPerm(huge.toString(), 1n << 60n)).toBe(true);
  });

  it('treats AND-mask matching as set inclusion', () => {
    const granted = PERM.pedido.read | PERM.pedido.write;
    const required = PERM.pedido.read | PERM.pedido.write;
    expect(hasPerm(granted.toString(), required)).toBe(true);
  });
});

describe('PERM layout', () => {
  it('every bit is a single power of two', () => {
    for (const [domain, actions] of Object.entries(PERM)) {
      for (const [action, bit] of Object.entries(actions)) {
        expect(bit > 0n, `${domain}.${action}`).toBe(true);
        expect((bit & (bit - 1n)) === 0n, `${domain}.${action} must be a single bit`).toBe(true);
      }
    }
  });

  it('no two domains share a bit (the old impostoCategoria/regraImposto vs arquivo collision)', () => {
    const seen = new Map<bigint, string>();
    for (const [domain, actions] of Object.entries(PERM)) {
      for (const [action, bit] of Object.entries(actions)) {
        const prior = seen.get(bit);
        expect(prior, `${domain}.${action} reuses the bit of ${prior}`).toBeUndefined();
        seen.set(bit, `${domain}.${action}`);
      }
    }
  });

  it('pins the promoted sub-domain bits', () => {
    expect(PERM.categoria).toEqual({ read: 1n << 11n, write: 1n << 12n, delete: 1n << 13n });
    expect(PERM.metodoPagamento).toEqual({ read: 1n << 27n, write: 1n << 28n, delete: 1n << 29n });
    expect(PERM.mensagem).toEqual({ read: 1n << 51n, write: 1n << 52n, delete: 1n << 53n });
    expect(PERM.impostoProduto).toEqual({ read: 1n << 75n, write: 1n << 76n, delete: 1n << 77n });
    expect(PERM.impostoCategoria).toEqual({ read: 1n << 96n, write: 1n << 97n, delete: 1n << 98n });
    expect(PERM.regraImposto).toEqual({ read: 1n << 99n, write: 1n << 100n, delete: 1n << 101n });
  });
});
