import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { LegalLinks } from './LegalLinks';

afterEach(() => {
  vi.unstubAllEnvs();
});

function renderLinks() {
  return render(
    <MantineTestProvider>
      <LegalLinks />
    </MantineTestProvider>,
  );
}

describe('login legal links', () => {
  it('links to both documents at the configured origin without submitting the login form', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', ' https://legal.example.com/ ');
    renderLinks();
    expect(screen.getByRole('link', { name: 'Termos de Uso' }).getAttribute('href')).toBe(
      'https://legal.example.com/termos-de-uso',
    );
    expect(screen.getByRole('link', { name: 'Política de Privacidade' }).getAttribute('href')).toBe(
      'https://legal.example.com/politica-privacidade',
    );
    expect(screen.getByRole('link', { name: 'Termos de Uso' }).getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows local links in development without configuration', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', undefined);
    renderLinks();
    expect(screen.getByRole('link', { name: 'Termos de Uso' }).getAttribute('href')).toBe(
      'http://localhost:3002/termos-de-uso',
    );
  });

  it.each([undefined, '', ' ', 'javascript:alert(1)'])(
    'hides links in production for an absent or invalid URL: %s',
    (value) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', value);
      renderLinks();
      expect(screen.queryByRole('navigation', { name: 'Governança' })).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    },
  );
});
