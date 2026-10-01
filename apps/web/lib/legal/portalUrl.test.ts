import { describe, expect, it } from 'vitest';
import { resolvePortalUrl } from './portalUrl';

describe('legal app origin', () => {
  it.each([undefined, '', ' \t '])(
    'uses the local default only in development when URL is %s',
    (value) => {
      expect(resolvePortalUrl(value, 'development')).toBe('http://localhost:3002');
      expect(resolvePortalUrl(value, 'production')).toBeNull();
      expect(resolvePortalUrl(value, 'test')).toBeNull();
    },
  );

  it('accepts a configured origin with whitespace and a trailing slash', () => {
    expect(resolvePortalUrl(' https://legal.example.com/ ', 'production')).toBe(
      'https://legal.example.com',
    );
    expect(resolvePortalUrl('http://localhost:3002', 'development')).toBe('http://localhost:3002');
  });

  it.each([
    'javascript:alert(1)',
    '//legal.example.com',
    'invalid',
    'https://user:pass@example.com',
    'https://example.com/other',
    'https://example.com/?x=1',
    'https://example.com/#other',
  ])('rejects an unusable or unsafe origin: %s', (value) => {
    expect(resolvePortalUrl(value, 'production')).toBeNull();
    expect(resolvePortalUrl(value, 'development')).toBeNull();
  });
});
