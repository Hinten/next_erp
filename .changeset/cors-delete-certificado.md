---
"@delfrance/nfe-app": patch
"@delfrance/mercado-livre-app": patch
"@delfrance/schemas": minor
---

Make filial certificate removal work from the browser, and expose download filenames (#1680).

`apps/nfe`'s CORS proxy answered the preflight with `GET, POST, OPTIONS` while `DELETE /api/nfe/certificado` is how `apps/web` removes a certificate, so the request never left the browser — broken since the feature shipped. The proxy now admits `DELETE`, and both the NF-e and Mercado Livre proxies expose `Content-Disposition` to an allowed origin, so a DANFE / CC-e / etiqueta download keeps its real filename (a Mercado Livre ZIP batch was being saved as `.pdf`).

The certificate route writes the encrypted key and the filial's public `certificado` in ONE `WriteBatch` per verb, with `update()` on the filial: an unknown filial is a 404 instead of a stub document, and an upload racing a removal can no longer leave the two disagreeing. The upload carries a `lastUpdateTime` precondition from the read its CNPJ check was derived from (409 `FILIAL_ALTERADA`, also when the filial was deleted mid-upload). `apps/web` asks for confirmation before removing a certificate, and a config-eslint guard now fails when any proxy omits a non-safelisted verb (anything but GET/HEAD/POST) its own routes export.

The per-instance certificate cache now has a 15-minute TTL (`CERTIFICADO_CACHE_TTL_MS`, new in `@delfrance/schemas`). It used to live as long as the process, so a replacement or removal reached only the instance that served it, and every other one kept the old certificate until it restarted (a first upload was already seen everywhere: absence was never cached). Now every instance and the `nfe` Functions codebase converge within 15 minutes; an unchanged certificate keeps its decrypted key and keep-alive agent across the re-read. The certificate screen says that changes can take up to 15 minutes to reach every emission: on the panel, in the removal confirmation, and in both success notifications.
