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
