---
"@delfrance/integrations-freight-br": minor
---

The browser `FreightHttpClient` types the `comprar` in-flight claim's answers (#1677): `423 { code: 'ME_COMPRA_EM_ANDAMENTO', leaseExpiraEmMs }` is `FreightCompraEmAndamentoError` and `412 { code: 'ME_ETIQUETA_DESVINCULADA', printLabelId, printUrl }` (a label paid but no longer linked to the pedido) is `FreightEtiquetaDesvinculadaError` — both subclasses of `FreightHttpError`, so every existing catch site keeps working; any other 423 or 412 stays a `FreightServerError`. The buy modal closes on both, as it already did on a timeout: a yellow notice for "another buy is in progress", and a red one that stays until dismissed naming the paid label for the unlinked case, because one more click there would start a fresh buy and pay twice. It also closes on any other `412` from `comprar` (the frete changed before checkout): the open modal's cart was built from the old frete, so a re-click would buy the old service.
