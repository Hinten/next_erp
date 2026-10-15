# Delfrance governance

Public Terms of Use and Privacy Policy in PT-BR, implemented for issue #560.
This app has no Firebase dependency, authentication, forms or analytics.

```sh
pnpm --filter @delfrance/legal dev
pnpm --filter @delfrance/legal build
pnpm --filter @delfrance/legal start
```

Local origin: `http://localhost:3002`. All scripts load the repository-root
`.env.local`, matching the other Next apps. The application builds and serves
its documents without Firebase credentials or legal identity values.

## Routes and canonical text

- `/`: Governança document directory.
- `/termos-de-uso`: Terms of Use.
- `/politica-privacidade`: Privacy Policy.
- `/termosdeuso` and `/termo-de-uso`: permanent redirects to Terms of Use.
- `/politicadeprivacidade`: permanent redirect to Privacy Policy.

`lib/documents.tsx` is the only canonical text source. The authored revision is
2026-10-01; update the fixed revision when changing the documents. No text or
personal information is copied from either legacy document version.

## Public configuration

| Variable                 | App / timing    | Purpose                                |
| ------------------------ | --------------- | -------------------------------------- |
| `LEGAL_CONTROLLER_NAME`  | legal / runtime | Controller's name or legal entity name |
| `LEGAL_CONTROLLER_CNPJ`  | legal / runtime | Controller's public CNPJ               |
| `LEGAL_PRIVACY_EMAIL`    | legal / runtime | Public privacy contact                 |
| `NEXT_PUBLIC_PORTAL_URL` | web / build     | HTTP(S) origin for the login links     |

Document pages await Next's `connection()` before reading the three `LEGAL_*`
values. They are not frozen during the build or cached between requests.
Configure ordinary runtime environment variables for the legal App Hosting
backend; do not store public identity information as secrets. The backend's
`apphosting.yaml` declares its runtime sizing without hardcoding entity values.

Whitespace-only values count as missing. With `NODE_ENV=development`, each missing
variable is identified in a visible configuration notice. With
`NODE_ENV=production`, missing fields are omitted independently, and a completely
empty identification block is removed. Test mode does not show debug notices.

Configure `NEXT_PUBLIC_PORTAL_URL` for the **web backend at build time**, using an
HTTP(S) origin without a path, credentials, query or fragment. It is deliberately
named `PORTAL_URL` to retain the approved interface despite the app being named
`legal`. Unset development configuration defaults to `http://localhost:3002`;
unset or invalid production configuration hides the login links. Updating this
public variable requires rebuilding web. The links open in a separate tab, keeping
the login form intact.

## Content and legal references

The documents describe the actual ERP features and distinguish them from these
public pages. Integrations and AI are conditional on use. No automatic consent,
absolute security promise, blanket liability exclusion or restriction of the
Apache-2.0 software license is introduced.

- [LGPD, especially arts. 6–9, 16, 18–20, 33 and 46–48](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm).
- [ANPD: data subjects and controller/operator roles](https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados).
- [ANPD: cookies and personal data protection](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_orientativo_cookies_e_protecao_de_dados_pessoais).
- [ANPD Resolution 19/2024: international transfers](https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-19-de-23-de-agosto-de-2024).
- [ANPD: security incident communication](https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/comunicado-de-incidente-de-seguranca-cis).

The requested production omission does not fulfill the controller identification
and contact duties in LGPD art. 9. The organization must supply current identity,
contact and operational information and assess the actual legal bases, retention
and transfer safeguards before treating publication as complete compliance.
The privacy contact is not presented as a formally appointed DPO.

## Validation and publication

```sh
pnpm --filter @delfrance/legal test
pnpm --filter @delfrance/legal lint
pnpm --filter @delfrance/legal typecheck
```

Vitest covers rendering, runtime reads, production omission, development notices,
navigation and legacy redirects. Tests run through the existing Turbo CI
aggregation. Login links have their own tests in web.

A human configures and publishes the separate Firebase App Hosting backend with
app root `apps/legal`, then configures its public identity and the web backend's
origin. This change does not deploy Firebase infrastructure or move data.
