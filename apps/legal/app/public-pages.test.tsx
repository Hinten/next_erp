import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { connection } from 'next/server';
import PrivacyPage from './politica-privacidade/page';
import TermsPage from './termos-de-uso/page';
import nextConfig from '../next.config';

vi.mock('next/server', () => ({ connection: vi.fn().mockResolvedValue(undefined) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('public page requests', () => {
  it.each([PrivacyPage, TermsPage])(
    'reads runtime values only after the request boundary',
    async (Page) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('LEGAL_CONTROLLER_NAME', 'Before request');
      vi.mocked(connection).mockImplementationOnce(() => {
        vi.stubEnv('LEGAL_CONTROLLER_NAME', 'At request time');
        return Promise.resolve();
      });
      const html = renderToStaticMarkup(await Page());
      expect(connection).toHaveBeenCalledOnce();
      expect(html).toContain('At request time');
      expect(html).not.toContain('Before request');
    },
  );

  it('does not cache the controller across requests', async () => {
    vi.stubEnv('LEGAL_CONTROLLER_NAME', 'First controller');
    expect(renderToStaticMarkup(await PrivacyPage())).toContain('First controller');
    vi.stubEnv('LEGAL_CONTROLLER_NAME', 'Second controller');
    const html = renderToStaticMarkup(await PrivacyPage());
    expect(html).toContain('Second controller');
    expect(html).not.toContain('First controller');
  });

  it('redirects every legacy document path to its canonical public route', async () => {
    expect(await nextConfig.redirects?.()).toEqual([
      { source: '/termosdeuso', destination: '/termos-de-uso', permanent: true },
      { source: '/termo-de-uso', destination: '/termos-de-uso', permanent: true },
      { source: '/politicadeprivacidade', destination: '/politica-privacidade', permanent: true },
    ]);
  });
});
