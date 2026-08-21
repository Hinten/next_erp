# frete — int_frete ⇆ ML conta sync

A single-file theme, kept separate because it is the only place the freight
configuration and the ML account meet. The broader freight domain lives in
`apps/melhor-envio` and `packages/integrations/freight-br` — see the
`freight-integrations` skill.

- `intFreteSync.ts` — syncs the `int_frete` config against the ML `integracao`
  doc, including deactivate-on-delete. Driven by
  `functions/src/onIntegracaoMercadoLivreChanged.ts`; its only in-folder
  consumer is `pedidos/orderImport.ts`.
  ⚠️ An Eventarc redelivery replays the **original** CloudEvent, so the write is
  tier-2 guarded in **ms**: the lookup reads through `tx`, `ultimaModificacao`
  is compared against the event time, and the winning write advances the
  watermark. The create path is tier 0 (`tx.create`).
