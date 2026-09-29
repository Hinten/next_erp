---
"@delfrance/core": patch
---

`createViaCepClient` wraps a timeout that fires while the response BODY is still arriving in `ViaCepError` (#1654).

The timeout covers the body read, and a signal that fires after the headers errors the body stream: `res.json()` then rejects with the abort's `DOMException` (`AbortError`), which the body-read catch — narrowing only `SyntaxError` and `TypeError` — let through raw. Past the CMUN resolver (which narrows `ViaCepError`), that raw `DOMException` would reach the NF-e batch's prep as an unknown class, and since `toEmitError` now rethrows unknown classes it would abort every pedido of the lote instead of failing only its own with a "could not resolve codigoMunicipio" report. Every other caller (the endereço forms, the Mercado Livre order import) narrows on `ViaCepError` too. It is now the same `ViaCepError` the fetch phase's timeout already was.
