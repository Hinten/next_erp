import { describe, expect, it } from 'vitest';
import { GeoPoint, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { encodeFirestore, decodeFirestore } from './codec';
import { fingerprint } from './transform';

const db = { doc: (path: string) => ({ path }) } as unknown as Pick<Firestore, 'doc'>;

describe('lossless manifest codec', () => {
  it('round-trips Firestore types and escaped ordinary maps', () => {
    const original = {
      time: new Timestamp(10, 123),
      geo: new GeoPoint(1, 2),
      bytes: Buffer.from([0, 255]),
      float: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      minusZero: -0,
      map: { $whatsappMigrationValue: 'ordinary-user-field', nested: ['01', 1, null] },
    };
    const encoded = encodeFirestore(original);
    const roundTrip = decodeFirestore(JSON.parse(JSON.stringify(encoded)), db);
    expect(roundTrip).toEqual(original);
    expect(fingerprint(encodeFirestore(roundTrip))).toBe(fingerprint(encoded));
  });
  it('refuses unknown objects rather than dropping their fields', () => {
    expect(() => encodeFirestore(new Map([['key', 1]]))).toThrow('não suportado');
    expect(() => encodeFirestore({ lost: undefined })).toThrow('não suportado');
    expect(() => decodeFirestore({ $whatsappMigrationValue: 'bad' }, db)).toThrow('inválida');
  });
});
