import { describe, expect, it } from 'vitest';
import { sha512Hex, toBytes } from './hash';

describe('sha512Hex', () => {
  it('matches the known SHA-512 vector for "abc"', async () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
    expect(await sha512Hex(bytes)).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
        '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
  });

  it('is stable for identical bytes (content-addressing)', async () => {
    const a = await sha512Hex(new Uint8Array([1, 2, 3]));
    const b = await sha512Hex(new Uint8Array([1, 2, 3]));
    expect(a).toBe(b);
  });
});

describe('toBytes', () => {
  it('normalizes Uint8Array, ArrayBuffer and Blob to Uint8Array', async () => {
    const u = new Uint8Array([9, 8, 7]);
    expect(await toBytes(u)).toBe(u);
    expect([...(await toBytes(u.buffer))]).toEqual([9, 8, 7]);
    expect([...(await toBytes(new Blob([u])))]).toEqual([9, 8, 7]);
  });
});
