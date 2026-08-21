# nfe — NF-e upload to ML

Sending an approved NF-e XML to Mercado Livre for an order that requires one.
NF-e _generation_ is a different app entirely (`apps/nfe`); this is only the
upload leg.

- `nfeUpload.ts` — the upload itself, plus `decideNfeUploadDispatch` and
  `shouldUploadForPedido` (which `functions/src/onNfeAprovada.ts` drives).
  ⚠️ Stamps `freteInicial.estado = "error"` after an attempt through a
  monotonic **µs** watermark, so the stamp can only move forward.
- `mlNfeUploadTasks.ts` — the task-queue scheduler. No direct test sibling;
  covered by `enviar-nfe/route.test.ts`.
