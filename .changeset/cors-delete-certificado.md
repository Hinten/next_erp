---
"@delfrance/nfe-app": patch
"@delfrance/mercado-livre-app": patch
---

Make filial certificate removal work from the browser, and expose download filenames (#1680).

`apps/nfe`'s CORS proxy answered the preflight with `GET, POST, OPTIONS` while `DELETE /api/nfe/certificado` is how `apps/web` removes a certificate, so the request never left the browser — broken since the feature shipped. The proxy now admits `DELETE`, and both the NF-e and Mercado Livre proxies expose `Content-Disposition` to an allowed origin, so a DANFE / CC-e / etiqueta download keeps its real filename (a Mercado Livre ZIP batch was being saved as `.pdf`).

The certificate route writes the encrypted key and the filial's public `certificado` in ONE `WriteBatch` per verb, with `update()` on the filial: an unknown filial is a 404 instead of a stub document, and an upload racing a removal can no longer leave the two disagreeing. The upload carries a `lastUpdateTime` precondition from the read its CNPJ check was derived from (409 `FILIAL_ALTERADA`, also when the filial was deleted mid-upload). `apps/web` asks for confirmation before removing a certificate, and a config-eslint guard now fails when any proxy omits a non-safelisted verb (anything but GET/HEAD/POST) its own routes export.
