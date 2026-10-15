import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readLegalConfig } from '@/lib/config';
import { privacyPolicy, termsOfUse } from '@/lib/documents';
import HomePage from '@/app/page';
import RootLayout, { metadata } from '@/app/layout';
import { LegalDocument } from './LegalDocument';

describe('public legal documents', () => {
  it.each([termsOfUse, privacyPolicy])(
    'renders $title with a complete anchored contents list',
    (document) => {
      const html = renderToStaticMarkup(
        <LegalDocument document={document} config={readLegalConfig({ NODE_ENV: 'production' })} />,
      );
      expect(html).toContain(`<h1>${document.title}</h1>`);
      expect(html).toContain(`dateTime="${document.revision.iso}"`);
      expect(html).toContain('1 de outubro de 2026');
      for (const section of document.sections) {
        expect(html).toContain(`href="#${section.id}"`);
        expect(html).toContain(`id="${section.id}"`);
      }
      expect(html).not.toContain('LEGAL_');
      expect(html).not.toContain('Responsável e contato');
    },
  );

  it('renders configured identity and a usable contact without notices', () => {
    const html = renderToStaticMarkup(
      <LegalDocument
        document={privacyPolicy}
        config={readLegalConfig({
          NODE_ENV: 'production',
          LEGAL_CONTROLLER_NAME: 'Empresa Exemplo',
          LEGAL_CONTROLLER_CNPJ: '00.000.000/0001-00',
          LEGAL_PRIVACY_EMAIL: 'privacy@example.com',
        })}
      />,
    );
    expect(html).toContain('Empresa Exemplo');
    expect(html).toContain('00.000.000/0001-00');
    expect(html).toContain('href="mailto:privacy@example.com"');
    expect(html).not.toContain('Configuração de desenvolvimento');
  });

  it('omits only the missing fields in production', () => {
    const html = renderToStaticMarkup(
      <LegalDocument
        document={privacyPolicy}
        config={readLegalConfig({
          NODE_ENV: 'production',
          LEGAL_CONTROLLER_NAME: 'Empresa Exemplo',
          LEGAL_CONTROLLER_CNPJ: ' ',
        })}
      />,
    );
    expect(html).toContain('<dt>Controlador</dt>');
    expect(html).not.toContain('<dt>CNPJ</dt>');
    expect(html).not.toContain('<dt>Contato para privacidade</dt>');
    expect(html).not.toContain('LEGAL_');
  });

  it('identifies each missing variable in development while keeping provided fields', () => {
    const html = renderToStaticMarkup(
      <LegalDocument
        document={termsOfUse}
        config={readLegalConfig({
          NODE_ENV: 'development',
          LEGAL_CONTROLLER_NAME: 'Empresa Exemplo',
          LEGAL_PRIVACY_EMAIL: '\t',
        })}
      />,
    );
    expect(html).toContain('Empresa Exemplo');
    expect(html).toContain('LEGAL_CONTROLLER_CNPJ');
    expect(html).toContain('LEGAL_PRIVACY_EMAIL');
    expect(html).not.toContain('LEGAL_CONTROLLER_NAME');
  });

  it('escapes identity values rather than interpreting HTML from environment variables', () => {
    const html = renderToStaticMarkup(
      <LegalDocument
        document={privacyPolicy}
        config={readLegalConfig({
          NODE_ENV: 'production',
          LEGAL_CONTROLLER_NAME: '<script>alert(1)</script>',
        })}
      />,
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('provides a public home, language, keyboard skip link and document navigation', () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <HomePage />
      </RootLayout>,
    );
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain('<h1>Governança</h1>');
    expect(html).toContain('aria-label="Governança"');
    expect(metadata.title).toEqual({
      default: 'Governança | Delfrance',
      template: '%s | Delfrance',
    });
    expect(html).toContain('href="#conteudo"');
    expect(html).toContain('id="conteudo"');
    expect(html).toContain('href="/termos-de-uso"');
    expect(html).toContain('href="/politica-privacidade"');
    expect(html).toContain('sem entrar no sistema');
    expect(html).not.toContain('/login');
  });
});
