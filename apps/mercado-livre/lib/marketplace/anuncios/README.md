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

**Per-SKU fiscal data for ML's Faturador (#745)**

- `dadosFiscais.ts` — registers each SKU at `/items/fiscal_information` (a `PUT`,
  and a `POST` only for a SKU ML does not know), links it to its item, reads `can_invoice`, and
  stamps the outcome on the SKU's link (`dadosFiscais*`, `podeFaturar`). Runs
  LAST in every publish and behind the "Enviar dados fiscais" route; an ML
  refusal never fails a publish (a Firestore error or a bug still throws — rule 6).
- `dadosFiscaisPayload.ts` — pure body builder. ⚠️ The `Imposto` comes from the
  NF-e's own cascade (`criarLeitorDeImpostoPorOperacao`, bound to the conta's
  `operacaoOuterRef` — the operação every ML pedido is stamped with), and the
  per-field operação fallback + cEAN rule from `camposProdutoFiscal` /
  `gtinFiscal` in `@delfrance/schemas`. Never a local copy: what ML invoices
  must be what our nota says. Simples only (`csosn`); a kit is ONE `single`
  SKU, like our nota's one line; `origin_type` comes from the resolved CFOP.
- `dadosFiscaisAlvos.ts` — the same SKUs rebuilt from the STORED links, for the
  manual re-send.

**User-Products family**

- `upMemberLink.ts` — resolves a UP family from one member's ML item id.
- `upFamilyStatus.ts` — folds member statuses into the one status the parent
  link can carry. ⚠️ Three surfaces feed it, and none may bypass it: the `items`
  webhook, the stock sender's terminal 4xx branch, and `reverificarAnuncio`.

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
- `reverificarAnuncio.ts` — the operator escape hatch: re-read a listing and
  record its real state (stock-latch recovery). ⚠️ On a User-Products FAMILY it
  re-reads every MEMBER (multiget) and folds; it must never hand the parent
  link's `id` to `GET /items/{id}`, because that 404 records `closed` on the
  whole family (#1142).
- `anuncioUrl.ts` — resolves a listing's public ML URL (needed only for
  User-Products links).
- `variacoesFantasma.ts` — phantom-variation self-heal for old-model bulk stock
  writes. Publish-domain concept; its only consumer is `estoque/estoqueSend.ts`.
- `integracoesComProduto.ts` — Mercado Livre's BINDING of the server-owned
  `produtos.integracoesComProduto` denorm, the anchor pre-filter both sweeps
  open with. Since #1519 the channel-neutral writers and their reasoning live in
  `@delfrance/data/admin/produtos` (Shopee's link trigger shares them); what
  stays here is ML-shaped — the two link subcollections, the survivor queries
  and the variação fallback. ⚠️ The tier follows where a writer's EVIDENCE came
  from, not which way it moves the array (root `CLAUDE.md` rule 7):
  - `adicionarConta` — the link triggers' ADD, **tier 0**: an `arrayUnion`
    whose evidence is the event itself; a later close fires its own event.
  - `removerContaSeOrfa` — the triggers' REMOVE, **tier 1**: a transaction
    that re-reads the surviving links (`sobrevivem(tx)`) and removes only when
    none still counts for the conta.
  - `adicionarContaSeViva` — **#1200**, the monthly link audit's heal, **tier
    1**: a READ-derived add (the walk saw the link minutes earlier), so it
    re-reads the produto's PARENT links (`sobrevivemLinksDoProduto`) inside the
    transaction and adds only while a live one survives. A plain `arrayUnion`
    landing after a close would be a PERMANENT false positive — the close's
    event already ran, and nothing revisits a closed link.
- `linksNaoEnumerados.ts` — **#1200**, the **link-side walk** shared by the
  price job's reconciliation (`preco/precoReconciliacao.ts`) and the monthly
  stock audit (`estoque/auditoriaNaoEnumerados.ts`). It asks the LINKS "which
  produto owns you?" over the conta's `produtoMercadoLivre` collection group,
  keeps only live listings (`linkHasLiveListing` — the same predicate the
  denorm trigger runs), and classifies each owning produto against the sweeps'
  two anchor terms (`classificarLinkNaoEnumerado` → four `NAO_ENUMERADO_*`
  codes, or `null`). Also `reclassificarProdutoNaoEnumerado`, the one-produto
  re-read the audit runs before resolving an aviso. ⚠️ The classifier IS both
  sweeps' anchor predicate re-derived, with an EXACT `paiId === null` — the
  binding describes in `estoque/bulkEstoquePlan.test.ts` and
  `preco/precoPlan.test.ts` pin it to each query. ⚠️ The codes are persisted
  wire strings (`EnvioPrecoSkip.code`) — never rename one. ⚠️ Load-bearing by
  PATH: `preco/precoMotivos.test.ts` scans this file for those codes and throws
  `ENOENT` if it moves. Rides the COLLECTION_GROUP index
  `produtoMercadoLivre(contaOuterRef, __name__)`; every query is classic, so it
  all runs in the emulator. `pageLimit` is required and must be an integer ≥ 1
  — a 0 would read as a drained, COMPLETE walk.
- `listaDePrecosCache.ts` — despite the name, **not** pricing: its only importer
  is `publish.ts`, which reads it to name the list in a blocked-price message.
