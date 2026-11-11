import { gunzipSync, gzipSync, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { crc32, ehErroDoFflate } from '../src/crc32';
import { AmazonDocumentoEasyShipError, AmazonDocumentoFeedError } from '../src/errors';
import * as barril from '../src/index';
import { falha } from './_helpers/mockFetch';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** What `f` throws, through a rejection: no catch of our own. */
const erroDe = (f: () => unknown): Promise<unknown> => falha(Promise.resolve().then(f));

describe('crc32', () => {
  it('★ the standard check value: 0xCBF43926 for "123456789"', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('equals the CRC-32 a gzip trailer records for its member', () => {
    const dados = bytes('{"summary":{"errors":0}}'.repeat(50));
    const gz = gzipSync(dados);
    const trailer = new DataView(gz.buffer, gz.byteOffset, gz.byteLength).getUint32(
      gz.length - 8,
      true,
    );
    expect(crc32(dados)).toBe(trailer);
  });

  it('is internal: the barrel exports neither helper', () => {
    expect(Object.keys(barril)).not.toContain('crc32');
    expect(Object.keys(barril)).not.toContain('ehErroDoFflate');
  });
});

describe('ehErroDoFflate', () => {
  it('★ is true for fflate’s own errors (a numeric code)', async () => {
    expect(ehErroDoFflate(await erroDe(() => gunzipSync(bytes('não é gzip, nem de longe'))))).toBe(
      true,
    );
    expect(ehErroDoFflate(await erroDe(() => unzipSync(bytes('não é zip'))))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a plain Error', new Error('x')],
    ['a TypeError', new TypeError('x')],
    ['an Error with a string code', Object.assign(new Error('x'), { code: 'ERR_X' })],
    ['the Easy Ship class', new AmazonDocumentoEasyShipError('zip-invalido')],
    ['the feed class', new AmazonDocumentoFeedError('gzip-invalido')],
    ['a non-error with a numeric code', { code: 1 }],
    ['undefined', undefined],
  ])('NEAR-MISS: false for %s', (_caso, err) => {
    expect(ehErroDoFflate(err)).toBe(false);
  });
});
