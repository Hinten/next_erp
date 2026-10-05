# apps/legal

Public PT-BR legal documents for Delfrance, served on port 3002.

- Server Components with semantic HTML and CSS. No Firebase SDK or auth provider.
- `lib/documents.tsx` is the canonical text. Update its fixed revision date when
  changing the documents; never derive that date from the request clock.
- Legal identity comes only from the three `LEGAL_*` environment variables.
  Read them after `connection()` during the request, never at module load or
  behind a cache. Development shows missing-variable notices; production omits
  missing fields. Never copy personal information from the legacy documents.
- Keep the distinction between the public pages and the authenticated ERP in
  the privacy notice. Describe optional integrations as conditional on use.
- Tests render pure document components with `react-dom/server`; request-time
  page tests mock `connection()`. No network, Firebase credentials or fixtures.
- Hosting and actual controller/contact values are configured by a human.

See README.md for environment configuration and official legal references.
