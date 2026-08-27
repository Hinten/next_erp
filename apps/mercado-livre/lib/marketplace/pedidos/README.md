# pedidos — the order → pedido import pipeline

One ML order (or pack) becomes an ERP `pedido` with its items, cliente,
endereço, pagamentos and `freteInicial`. The largest theme in the channel.

Entry points are the three `*Import.ts` files, each driven by its own webhook
topic; everything else is either a pure mapper or a resolver they share.

**Orchestration**

- `orderImport.ts` — the top-level orchestrator (~1,700 lines). Four
  transactions, all re-deriving from `tx.get`.
- `orderPedidoTx.ts` — transactional "discover or create the target pedido",
  covering every order of a pack with an explicit read phase.
- `orderPedidoResolve.ts` — resolves the pedido owning an order/pack id via the
  `orderML` collection-group mirror. Small, but imported by claims, chat,
  payments and shipments.

**Topic handlers**

- `orderPaymentImport.ts` — `payments` topic; upserts one `pagamento`.
  Tier-2 guarded in **µs**.
- `orderShipmentImport.ts` — `shipments` topic; refreshes `freteInicial`.
  Tier-2 guarded in **µs**, null-tolerant the opposite way from payments.
- `pedidoTravadoSweep.ts` — **#1087 follow-up**, the WEEKLY release of pedidos
  stuck awaiting a payment that never resolved. Every other release path in this
  channel is event-driven, so a reservation whose terminal `orders_v2`/`payments`
  event never arrived was held forever; this is the only time-based one.
  ⚠️ Mostly a RE-DRIVER: it asks ML what happened and enqueues a synthetic
  `orders_v2` so the import arms decide, writing `pagamentoNaoRealizado` itself
  only when ML still reports the order pre-payment past the horizon.
  ⚠️ **`integracaoPedidoOuterRef` is NOT the marketplace gate** — a human-created
  pedido is required by the form to set it. The gate is `lastMarketplaceUpdate`,
  whose sole writer is `discoverPedidoMercadoLivre`.
  ⚠️ It ENDS SALES, so it is doubly flag-gated with a dry-run mode, and it never
  acts on an unverifiable ML read.

- `pendingOrderBootstrap.ts` — **#1087**. A payment whose order the ERP has never
  seen used to be dropped, so no pedido existed and no stock was reserved while
  the buyer held the unit. ML fires `orders_v2` only for _"vendas confirmadas"_,
  so a `payment_in_process` order arrives on the payments topic and **nowhere
  else**. This enqueues a synthetic `orders_v2` for `/orders/{id}` — so
  `orderImport.ts` stays the only pedido creator — and inherits the notification
  pipeline's own bounds rather than inventing a counter.
  ⚠️ Its `id: null` is load-bearing: the pipeline's `docIdOf` falls back to
  `derivedDocId`, which keys the dedup on the **order**. A synthesised id would
  key it on the payment, of which ML sends several per order.
  ⚠️ It owns this folder's only edge into `notificacoes/mlTasks.ts`, deliberately
  — `mlTasks.ts` imports a value from `notificacao.ts`, so reaching it from the
  dispatcher instead would close a file-level import cycle.

**Pure mapping and identity**

- `orderMapping.ts` — order → `pedido` / `ItemDoPedido` field mapping.
- `orderPaymentMapping.ts` · `orderShipmentMapping.ts` — the payment and
  shipment equivalents (the latter includes the state-preserving merge).
- `orderStatusMaps.ts` — ML → ERP status enum maps (order, payment, shipment).
- `orderIds.ts` — deterministic digest ids for order/item/payment docs, at the
  legacy-exact preimages.
- `orderMLWire.ts` — builds the byte-faithful `pedidos/{id}/orderML/{orderId}`
  mirror doc.

**Resolvers and derived values**

- `orderCliente.ts` — cliente find-or-create plus endereço resolution.
- `orderProdutoResolve.ts` — resolves the ERP produto (including a variation
  child) for one order line. The one order file that reaches into `importacao/`.
- `orderPrazoDespacho.ts` — computes the dispatch deadline.
- `orderShipmentConference.ts` — pure conference of what ML will ship against
  what the pedido stores.
- `shipmentOrderId.ts` — answers "which ML order does this shipment belong to?"
  after ML dropped `shipment.order_id`.
- `shipmentSellerCost.ts` — answers "what does the SELLER pay for this shipment?"
  from `GET /shipments/{id}/costs` after ML dropped `base_cost`. ⚠️ Matches the
  `senders[]` row on our own `user_id`, never `senders[0]`.
