# nfe — NF-e upload to ML

Sending an approved production sale NF-e XML to Mercado Livre for an order that requires one.
NF-e _generation_ is a different app entirely (`apps/nfe`); this is only the
upload leg.

- `nfeUpload.ts` — the upload itself and `shouldUploadForPedido`.
  The trigger and manual resend use `decideNfeSaleUploadDispatch` from
  `@delfrance/schemas` before reading the pedido. The task checks the sale
  purpose again against the NF-e it reads for the upload.
  ⚠️ Stamps `freteInicial.estado = "error"` after an attempt through a
  monotonic **µs** watermark, so the stamp can only move forward.
- `mlNfeUploadTasks.ts` — the task-queue scheduler. No direct test sibling;
  covered by `enviar-nfe/route.test.ts`.
