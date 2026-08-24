# anuncios — publishing & listing lifecycle (ERP → ML)

Creating and maintaining the listing itself: build the payload, publish it, keep
its status and moderation state current. The inverse direction (ML → ERP) is
`importacao/`.

**Publish**

- `publish.ts` — publish IO orchestration: load the graph, upload/cache
  pictures, call ML, write back.
- `publishCore.ts` — pure `buildItemPayload` assembly from the loaded graph.
- `publishUserProduct.ts` — User-Products fan-out (one ML item per variation,
  shared family).

**User-Products family**

- `upMemberLink.ts` — resolves a UP family from one member's ML item id.
- `upFamilyStatus.ts` — folds member statuses into the one status the parent
  link can carry.

**Lifecycle & state**

- `itemsStatusSync.ts` — the `items` topic status sync onto the link doc.
  ⚠️ Its transaction exists for the family fold (#1142), not for the ML read:
  a fold decided against a stale sibling parks the family at `estado "c"` while
  another member is live, silently dropping the conta from
  `integracoesComProduto`.
- `moderacoes.ts` — how to ask ML for moderation reasons, and how to write
  `link.moderacoes`. ⚠️ Consumed from **outside** this theme too:
  `importacao/import.ts` is the third writer of that field (#1087) and shares
  this module so the `-ITM` reference and the 404-is-data narrow cannot drift
  between the three. ⚠️ The **gate** — `precisaConsultarModeracao`, _when_ to ask
  — no longer lives here: it moved to `@delfrance/schemas` beside the field it
  gates when `apps/web` needed the same decision (#1239), and this module now
  imports it like every other caller. Keep it free of anything import-specific.
- `reverificarAnuncio.ts` — the operator escape hatch: re-read one listing and
  record its real state (stock-latch recovery).
- `anuncioUrl.ts` — resolves a listing's public ML URL (needed only for
  User-Products links).
- `variacoesFantasma.ts` — phantom-variation self-heal for old-model bulk stock
  writes. Publish-domain concept; its only consumer is `estoque/estoqueSend.ts`.
- `integracoesComProduto.ts` — server-owned maintenance of
  `produtos.integracoesComProduto`, the anchor pre-filter both sweeps open with.
  Tier 0 — the write is a commutative `arrayRemove`.
- `listaDePrecosCache.ts` — despite the name, **not** pricing: its only importer
  is `publish.ts`, which reads it to name the list in a blocked-price message.
