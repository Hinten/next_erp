# MISSING — MOC 7.0, Anexo II — Manual de Especificações Técnicas do DANFE e Código de Barras

**Priority**: SKIP (out of scope for this skill)

## What this document is

DANFE (Documento Auxiliar da NF-e) layout, dimensions, fonts, barcodes, QR
codes for the printed companion document. Defines visual rendering rules
for the paper representation of an authorized NF-e.

- **Published**: Novembro/2020
- **Document family**: MOC 7.0, Anexo II

## Download

| Source | URL |
|---|---|
| SEFAZ portal index | https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE= |

## Why we are NOT including it (yet)

The `nfe` skill focuses on **XML generation, signing, SOAP transmission,
state management and recovery** — the back-end half. DANFE rendering is a
separate concern that this repo's NF-e package doesn't currently own.

If/when the repo adds DANFE generation, create a separate `danfe` skill or
extend `nfe` with `danfe.md` and import this anexo at that time. Until
then, downloading and committing this is **bloat without payoff**.

## Action

**Delete this placeholder.** Do not upload the PDF. The skill update can
proceed without it.

If you disagree and want DANFE coverage included, ping with a note and
I'll change scope.
