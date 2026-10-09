import { describe, expect, it } from 'vitest';
import { mercadoLivreRastreioResultSchema } from './rastreioMercadoLivre';

describe('Mercado Livre tracking response', () => {
  it.each([
    'http://tracking.totalexpress.com.br/poupup_track.php?reid=3&pedido=14&nfiscal=1',
    'https://carrier.example/track?pedido=01&token=a%2Bb',
  ])('preserves the carrier URL exactly: %s', (url) => {
    expect(mercadoLivreRastreioResultSchema.parse({ name: null, url })).toEqual({
      name: null,
      url,
    });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///tmp/a',
    '//carrier.example/x',
    '/track',
    'https:carrier.example',
    'https://',
    '',
    'not a URL',
  ])('rejects unsafe/non-absolute URLs: %s', (url) => {
    expect(mercadoLivreRastreioResultSchema.safeParse({ name: 'Carrier', url }).success).toBe(
      false,
    );
  });

  it.each([
    {},
    { name: 'Carrier' },
    { name: 3, url: 'https://carrier.example' },
    { name: null, url: null },
  ])('rejects malformed success bodies: %j', (body) => {
    expect(mercadoLivreRastreioResultSchema.safeParse(body).success).toBe(false);
  });
});
