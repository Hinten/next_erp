# frete — int_frete ⇆ ML conta sync

A single-file theme, kept separate because it is the only place the freight
configuration and the ML account meet. The broader freight domain lives in
`apps/melhor-envio` and `packages/integrations/freight-br` — see the
`freight-integrations` skill.

- `intFreteSync.ts` — the ML BINDING of the shared `int_frete` ⇆ conta sync in
  `@delfrance/data/admin/frete` (moved there for Shopee step 20, #1528, so the
  two channels run one core — #1369). The only ML-specific piece kept here is
  the tolerant matcher for a bare `integracao/<id>` back-ref. Driven by
  `functions/src/onIntegracaoMercadoLivreChanged.ts`; its only in-folder
  consumer is `pedidos/orderImport.ts`.

  ⚠️ ML still runs the core's EVENT-driven pair: an Eventarc redelivery replays
  the **original** CloudEvent, so the write is tier-2 guarded in **ms**, and a
  newer event that changes nothing does not advance that guard. Shopee runs the
  core's state-driven `reconciliar`, which re-reads the conta inside the
  transaction; moving ML onto it is follow-up #1888. The create path is NOT
  tier 0: with a random id, a duplicate is prevented only by the transaction's
  conflict check on the lookup query. The full argument is the core's
  transaction-inventory row.
