import { describe, expect, it } from 'vitest';

import * as barril from '../src/index';
import { urlPreAssinadaAmazon } from '../src/preAssinada';
import { agendamentoEasyShip200, URL_CLOUDFRONT_DO_SANDBOX } from './_fixtures/sandbox';

/*
 * The ONE pre-signed URL guard, shared by the Easy Ship label download and the
 * two feed document transfers. Each module's own suite proves it refuses
 * before anything is sent; this one pins the rule itself.
 */

describe('urlPreAssinadaAmazon', () => {
  it.each([
    ['http:', 'http://example-bucket.s3.amazonaws.com/x.zip'],
    ['userinfo', 'https://user:pw@example-bucket.s3.amazonaws.com/x.zip'],
    ['a user only', 'https://user@example-bucket.s3.amazonaws.com/x.zip'],
    ['a port', 'https://x.amazonaws.com:8443/x.zip'],
    ['a foreign host', 'https://evil.example/x.zip'],
    ['the suffix as a subdomain of a foreign host', 'https://amazonaws.com.evil.example/x.zip'],
    ['the bare suffix', 'https://amazonaws.com/x.zip'],
    ['a look-alike suffix', 'https://example-bucket.s3.xamazonaws.com/x.zip'],
    ['a trailing dot', 'https://example-bucket.s3.amazonaws.com./x.zip'],
    ['not a URL', 'nao e uma url'],
    ['a relative path', '/x.zip'],
    ['empty', ''],
    ['ftp:', 'ftp://example-bucket.s3.amazonaws.com/x.zip'],
    ['the Easy Ship model’s own example URL', agendamentoEasyShip200.printableDocumentsUrl],
    ['the feeds sandbox’s CloudFront URL', URL_CLOUDFRONT_DO_SANDBOX],
  ])('★ %s → null', (_caso, url) => {
    expect(urlPreAssinadaAmazon(url)).toBeNull();
  });

  it.each([undefined, null, 42, {}, new URL('https://example-bucket.s3.amazonaws.com/x')])(
    'a value that is not a string (%s) → null',
    (valor) => {
      expect(urlPreAssinadaAmazon(valor)).toBeNull();
    },
  );

  it('★ NEAR-MISS: an object-storage URL is accepted as its parsed href, an upper-case host read lower-case', () => {
    const url = 'https://example-bucket.s3.amazonaws.com/x.zip?X-Amz-Signature=0000';
    expect(urlPreAssinadaAmazon(url)).toBe(url);
    expect(
      urlPreAssinadaAmazon('https://EXAMPLE-BUCKET.S3.AMAZONAWS.COM/x.zip?X-Amz-Signature=0000'),
    ).toBe(url);
  });

  it('is internal: the barrel does not export it', () => {
    expect(Object.keys(barril)).not.toContain('urlPreAssinadaAmazon');
  });
});
