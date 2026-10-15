import type { LegalConfig } from '@/lib/config';
import Link from 'next/link';
import type { LegalDocumentContent } from '@/lib/documents';
import { LegalIdentity } from './LegalIdentity';

export function LegalDocument({
  document,
  config,
}: {
  document: LegalDocumentContent;
  config: LegalConfig;
}) {
  return (
    <article className="legal-document">
      <header className="document-heading">
        <h1>{document.title}</h1>
        <p className="revision">
          Última atualização:{' '}
          <time dateTime={document.revision.iso}>{document.revision.label}</time>
        </p>
        <p className="document-intro">{document.introduction}</p>
      </header>
      <LegalIdentity config={config} />
      <nav className="contents" aria-label="Sumário">
        <h2>Neste documento</h2>
        <ol>
          {document.sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ol>
      </nav>
      {document.sections.map((section) => (
        <section key={section.id} aria-labelledby={section.id}>
          <h2 id={section.id} tabIndex={-1}>
            {section.title}
          </h2>
          {section.content}
        </section>
      ))}
      <footer className="document-footer">
        <Link href="/" prefetch={false}>
          Voltar à Governança
        </Link>
      </footer>
    </article>
  );
}
