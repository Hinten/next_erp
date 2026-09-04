import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEmbedScript, buildEmbedScriptBase64, webchatWidgetUrl } from './embedSnippet';

describe('webchatWidgetUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to localhost:3002 when NEXT_PUBLIC_WEBCHAT_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_WEBCHAT_URL;
    expect(webchatWidgetUrl()).toBe('http://localhost:3002');
  });

  it('reads NEXT_PUBLIC_WEBCHAT_URL when set', () => {
    vi.stubEnv('NEXT_PUBLIC_WEBCHAT_URL', 'https://webchat-prod.web.app');
    expect(webchatWidgetUrl()).toBe('https://webchat-prod.web.app');
  });
});

describe('buildEmbedScript', () => {
  it('embeds the doc id as data-tenant and points at the widget origin', () => {
    const script = buildEmbedScript('abc123', 'https://webchat-prod.web.app');
    expect(script).toContain('src="https://webchat-prod.web.app/loader.js"');
    expect(script).toContain('data-tenant="abc123"');
    expect(script).toContain('data-widget-url="https://webchat-prod.web.app/"');
    expect(script).toMatch(/^<script\n/);
    expect(script).toMatch(/<\/script>$/);
  });

  it('normalizes a widget URL missing a trailing slash', () => {
    const withSlash = buildEmbedScript('abc123', 'https://webchat-prod.web.app/');
    const withoutSlash = buildEmbedScript('abc123', 'https://webchat-prod.web.app');
    expect(withoutSlash).toBe(withSlash);
  });
});

describe('buildEmbedScriptBase64', () => {
  it('round-trips through base64 back to the plain script', () => {
    const script = buildEmbedScript('abc123', 'https://webchat-prod.web.app');
    const encoded = buildEmbedScriptBase64('abc123', 'https://webchat-prod.web.app');
    expect(Buffer.from(encoded, 'base64').toString('utf-8')).toBe(script);
  });

  it('differs per doc id', () => {
    const a = buildEmbedScriptBase64('doc-a', 'https://webchat-prod.web.app');
    const b = buildEmbedScriptBase64('doc-b', 'https://webchat-prod.web.app');
    expect(a).not.toBe(b);
  });
});
