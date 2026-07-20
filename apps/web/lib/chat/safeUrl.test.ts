import { describe, expect, it } from 'vitest';
import { isHttpUrl } from './safeUrl';

describe('isHttpUrl', () => {
  it('accepts absolute http/https URLs', () => {
    expect(isHttpUrl('http://example.com/a')).toBe(true);
    expect(isHttpUrl('https://example.com/a?b=1#c')).toBe(true);
    expect(isHttpUrl('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('rejects dangerous / non-http(s) schemes', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isHttpUrl('mailto:a@b.com')).toBe(false);
  });

  it('rejects relative / malformed / empty / nullish inputs', () => {
    expect(isHttpUrl('/relative/path')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('   ')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
});
