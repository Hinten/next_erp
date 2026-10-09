# `lib/shopee/kits/` — native Shopee kits (step 19, #1527)

The design notes for the step that creates, republishes and recreates NATIVE Shopee kits
(`add_kit_item` / `update_kit_item` / `get_kit_item_info`) from an ERP kit produto.
`apps/shopee/CLAUDE.md` keeps only the rules a reader must not break and points here for
the reasoning. The reconciled design (v2, with Lucas's answers L0–L10 of 2026-10-07), the
explorations and the wave reports that produced this folder are in the step-19 review
directory named by the PRs that close #1527.

Lucas sells NO native Shopee kit today (L0): his kits are ordinary listings whose stock the
ERP sends (component-min). Step 19 is how the FIRST native kits get created; the old
listings stay as they are until he migrates them by hand.

## 1. What the probes measured

Two probes on the SG sandbox (2026-10-06 and 2026-10-07; register rows 292–298, §8) settled
what the docs leave open or contradict. Every rule below rests on one of these facts.

- **Kit stock is DERIVED, never written.** A kit model's stock is min ⌊component stock /
  quantity⌋ over ALL its components, recomputed synchronously, and readable only through
  `get_model_list(kit)`. `update_stock` on a kit is refused ("Invalid product setting"), so
  step 12 never sends one (`kit-derivado`). Each kit model derives its OWN stock (row 292,
  row 298).
- **A plain component reads back a HIDDEN model id.** `get_kit_item_info` answers, for a
  component item WITHOUT variations, a non-zero `component_model_id` whose name and SKU are
  `''` and which that item's own `get_model_list` does not list (it answers zero models).
  That id is meaningless to the ERP: only the component item's `has_model === false` tells
  it apart from a real variation (row 293, §3).
- **`delete_item` and `unlist_item` work on a kit.** A deleted kit stays readable as
  `SELLER_DELETE` and is listed under the delete statuses; `unlist_item` works both ways
  (rows 294, 298).
- **`add_kit_item` is NOT idempotent**, and `product.error_busi` carries both a transient
  and a permanent refusal — only the SENTENCE separates them (`recusaKit.ts`, row 295).
- **ONE `main_component` per KIT**, across every model, not one per model: a second is
  refused with Shopee's own spelling, "mupltiple main sku" (row 296).
- **`update_kit_item` is a PARTIAL update** (the models a body omits are kept), an append
  is `model_id: 0` plus the FULL tier list, and **a quantity change on an existing model is
  a silent 200**: the ack says success and the read-back keeps the old quantity (row 297).
  So no kit write is ever read as "applied" from its ack — every one is verified by
  READ-BACK, and a recipe is frozen once created (a recipe change is `--recriar`, §6).

## 2. The create sequence (`kit-criar`)

`publicarKitShopee` (`publicarKit.ts`) is `prepararKit` → `planejarKit` → the arm's
applier. A create runs, in this order:

| #   | step                                                                                                                                                                                                                                                                                                                                        | module                                    | Shopee                                                         | Firestore write (tier, rule 7)                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | the Firestore reads: K, its children (`lerFilhos`, in TIER order — the grupo's variante order, then `ordem`, R-8), the description, the grupos, the conta's `prodshopee` of K, every child's `variashopee` of the conta, and the rung-2 query `produtos (sku == K.sku, paiId == null) limit(2)`                                             | `prepararKit.ts`                          | —                                                              | —                                                                                                              |
| 2   | **phase A** — `problemasDaFaseA`: SKU missing/padded/shared, no sellable unit, name, description, weight, dimensions, a child without components, > 9 children, not exactly one axis (two or more grupos, or none). ANY miss ⇒ ONE aggregated `ShopeePublishBlockedError`, before the first Shopee read                                     | `planoKit.ts`                             | —                                                              | —                                                                                                              |
| 3   | the phase-B reads: component resolution + ONE batched `has_model` read (`lerTemModelosDosComponentes`) — a NAMED `--principal` it cannot place refuses `principal-invalido` right there, before everything below (OP-8) — the kit limits of the principal's category (best-effort: `indisponivel` ⇒ no local band), the channels (UNCACHED) | `componentesKit.ts`, `prepararKit.ts`     | `get_item_base_info`, `get_kit_item_limit`, `get_channel_list` | —                                                                                                              |
| 4   | **the L6 scan** — `get_item_list` (statuses `NORMAL`/`UNLIST`/`REVIEWING`/`BANNED`, no `update_time_from`) + `get_item_base_info`, a same-SKU KIT is a hit; plus ONE base-info batch over our linked kits the list did not show                                                                                                             | `localizarKitPorSku.ts`, `prepararKit.ts` | `get_item_list`, `get_item_base_info`                          | —                                                                                                              |
| 5   | the photos — K's own pictures through step 11's resolver (≤ 9), ONLY when the scan's verdict (`decidirKitNovo`) is `criar`                                                                                                                                                                                                                  | `prepararKit.ts`                          | `upload_image`                                                 | `arquivos.externalIds` (the resolver's own cache)                                                              |
| 6   | **phase B** — the plan: the recipe projection per child, the structural bounds, the band when served, the principal, the scan's verdict                                                                                                                                                                                                     | `planoKit.ts`                             | —                                                              | —                                                                                                              |
| 7   | `add_kit_item`, EXACTLY once per run — with `item_setting.unlisted: true` only when the operator asked `--status UNLIST` (OP-9; `NORMAL` sends no such key, register 305)                                                                                                                                                                   | `aplicarKit.ts`                           | `add_kit_item`                                                 | —                                                                                                              |
| 8   | **the ONE link write**: `merge` at `idDoVinculoDeKit(conta, item_id)` with literal `kitNativo: true`                                                                                                                                                                                                                                        | `vinculosKit.ts`                          | —                                                              | tier 0 (an id no other create can compute)                                                                     |
| 9   | the read-back: `get_item_base_info` + `get_kit_item_info` + `get_model_list`                                                                                                                                                                                                                                                                | `aplicarKit.ts`                           | the three reads                                                | —                                                                                                              |
| 10  | write-back #2: `item_status`, `estadoAnuncio`, `kitNativo: ehKitDe(read)`                                                                                                                                                                                                                                                                   | `vinculosKit.ts`                          | —                                                              | values READ, last read wins — but never OUT of `removido`: tier 1, `update(…, { lastUpdateTime })` (R1-RT7-05) |
| 11  | one `variashopee` per child at `idDaVariacaoDeKit(link, model_id)`, stamped `receitaKitConferida` ONLY when the child's read-back model folds EQUAL to what was sent                                                                                                                                                                        | `vinculosKit.ts`                          | —                                                              | tier 0 (`create()`; ALREADY_EXISTS ⇒ a flat `mergeIfExists` re-stamp)                                          |
| 12  | the aviso decision (`reavaliarAvisoDeReceitaKit`, motivo `kit-recriado`)                                                                                                                                                                                                                                                                    | `@delfrance/data`                         | —                                                              | the shared decision's own clock                                                                                |

A phase-A or scan refusal spends no `upload_image`; a phase-B row (step 6) can still refuse
after the photos are uploaded, and an uploaded image no listing references changes nothing
on Shopee, so that order is accepted. A dry run is steps 1–6 (`ensaiarKitShopee`): reads, the
scan and the photo upload, never a write and never `add_kit_item`.

**No transaction, anywhere in this folder.** Every write is idempotent on its own: an upsert
at a deterministic id, a `create()` that falls back to a re-stamp, a `merge` of values just
read. The transaction inventory greps the bare API name, so no `kits/*.ts` file may spell
it, comments included.

**#2 never revives a deleted kit (R1-RT7-05).** A republish of an old kit can race a
`--recriar` of it from a second tab or operator: the republish reads the kit `NORMAL` before
the recriar's `delete_item`, and its #2 lands after the recriar wrote `removido`. A plain
last-read-wins `merge` there would put the deleted kit back as live beside its successor —
every publish then refuses `vinculos-ambiguos`, and step 13 prices a deleted item. So #2
reads the link, never writes a non-removed estado over a stored `removido`, and writes with
`update(patch, { lastUpdateTime })` (rule 7 tier 1): a concurrent write fails the
precondition and the decision is re-derived from a fresh read (3 attempts, then the error
surfaces). Shopee never un-deletes a listing; the one way a link leaves `removido` is a
human's `reverificar:anuncio`, a different writer. Pinned by `vinculosKit.test.ts` ("a
removido landing BETWEEN the read and the write fails the precondition…").

**No persisted progress (L9).** Nothing stores where a create got to: no intent document,
no create state, no stored principal or recipe. Every kit command is an ENSURE sequence —
it re-derives which facts hold from Shopee reads plus the link docs, writes only the
missing ones, and is safe to run again. An `incerto` `add_kit_item` (a transient, a
network failure, an unknown answer) writes NOTHING and answers 202 with the exact command
to re-run; if the kit was created, the re-run's scan finds it and refuses "importe-o", and
step 9's import links it at the SAME `idDoVinculoDeKit` on the SAME produto. A
`nao-criado` is a 422 refusal, and also writes nothing. A crash between the link write and
the read-back leaves a link with `kitNativo: true` — steps 12/13 already treat it as a kit
— and the next plain publish (`kit-atualizar`) completes it.

## 3. The default-model rule, and why `0` is not "no model"

A component's Shopee address is `{ itemId, modelId }`, and `modelId === null` means "this
item has no variations". ONE rule maps a wire `component_model_id` to it, in both
directions — `modeloDoComponenteKit` in `@delfrance/schemas` (`receitaKitShopee.ts`) — keyed
on the component ITEM's `has_model`, read live and batched (`lerTemModelosDosComponentes`,
≤ 50 ids per call, never cached: a `has_model` flip must be seen):

| `has_model`                | → `modelId`                                       | why                                                                                           |
| -------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `false`                    | `null`                                            | a plain item: Shopee's hidden default id (§1) is meaningless                                  |
| `true`                     | the id, when a positive safe integer; else `null` | `0`/absent on an item WITH variations is a resolution hole, never "no model"                  |
| unknown (no base-info row) | the id VERBATIM                                   | never a guess; the import keeps today's path, the create refuses `componente-anuncio-inativo` |

`0` is not "no model" because the hidden id is NOT `0`: the pre-step-19 import treated a
plain component as `model_id 0`, missed rung 1 on the hidden id and only bound through the
SKU rungs. On the request side, a plain component's row OMITS `component_model_id` — never
`0`, never `undefined` on the wire.

## 4. The recipe fold and the fingerprint

ONE recipe module, `packages/schemas/src/receitaKitShopee.ts`: the create, the republish,
the recreate, step 9's import and the `apps/functions` trigger all call it, and no second
copy exists here (#1369). The fold is split in two so "main moved" and "quantity changed"
stay distinguishable (R-e).

**`mesmaReceitaKitShopee(erp, shopee, temModelos)`** — the per-model fold, main EXCLUDED.

| EQUAL                                                                                  | pinned by (`receitaKitShopee.test.ts`)                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| rows in a different order                                                              | "(M13) EQUAL pair: rows in a different order"                                                    |
| duplicate keys SUMMED on either side (2 + 3 ≡ 5)                                       | "(M14) EQUAL pair: duplicate keys SUMMED on either side (2 + 3 ≡ 5); NEAR-MISS 2 + 3 vs 6"       |
| a plain item: the ERP's absent model vs Shopee's hidden id, when `has_model === false` | "(M15) EQUAL pair: a plain item — ERP absent model vs Shopee hidden id when has_model === false" |
| `main_component` moved, and every display field                                        | "(M17) EQUAL pair: main_component moved — the per-model fold ignores the main (R-e)"             |

| DISTINCT                                                                   | pinned by                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| a quantity (2 vs 3)                                                        | "(M12) EQUAL pair: the same quantity; NEAR-MISS: quantity 2 vs 3 is DISTINCT"                |
| a component added or removed                                               | "NEAR-MISS: a component added or removed ⇒ DISTINCT, in both directions"                     |
| model A vs model B of an item with variations                              | "NEAR-MISS: model A vs model B of an item that HAS variations ⇒ DISTINCT"                    |
| a null model vs a model on an item that HAS variations (a resolution hole) | "(M16) has_model === true: a null model vs a model is a resolution hole ⇒ DISTINCT"          |
| the hidden id when `has_model` is UNKNOWN (compared literally)             | "(M15 near-miss) the same pair with has_model UNKNOWN compares the ids literally ⇒ DISTINCT" |

**`principalDoKitShopee` / `mesmoEnderecoDeComponente`** — the kit-level main, folded by
the same default-model rule; the same address flagged on several models is ONE main, two
different flagged addresses are unreadable (`null`, never a pick). Pinned by "EQUAL: the
same main flagged on several models is ONE main" and "NEAR-MISS: two DIFFERENT mains are
unreadable ⇒ null, never a pick"; the address comparison is literal ("EQUAL pair: the same
(itemId, modelId); NEAR-MISSES: model, null-vs-model, item").

**`chaveReceitaKitErp(componentesKit)`** — the ERP-side FINGERPRINT (L4, R-4): the JSON of
`[produtoId, quantidade]` entries sorted by id.

| EQUAL                                                        | DISTINCT                                                                 | pinned by                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| key order, `limitarEstoque`, `timestamp`, passthrough extras | —                                                                        | "(M18) EQUAL pair: key order, limitarEstoque, timestamp and passthrough extras do not count" |
| —                                                            | `{p1: 12}` vs `{p11: 2}` (no bare join)                                  | "(M19) NEAR-MISS: {p1: 12} vs {p11: 2} stay DISTINCT (no bare join)"                         |
| —                                                            | a quantidade change; a key added, removed or renamed (the #1450 repoint) | "NEAR-MISSES: a quantidade change, a key added, removed or renamed (#1450 repoint)"          |

**The stamp folds the STORED map — the readers' input (R1-RT7-02).** Every reader of the
fingerprint (the aviso decision in `@delfrance/data`, the `apps/functions` trigger, step 9's
R-t) folds the child's `componentesKit` exactly as stored. The writer therefore stamps
`chaveReceitaArmazenadaDoFilho(filho)` = `chaveReceitaKitErp(<the stored map>)`
(`planoKit.ts`; `prepararKit` keeps it on `FilhoDoKit.componentesKitArmazenado`), never the
schema-PARSED map the projection uses: an entry stored without `quantidade` parses to 1 (and
is sent as 1) but folds to `null`, so a parsed stamp could never equal the readers' current
and the aviso would stay open after a verified create. The família-de-um mirror check reads
both sides the same way. Pinned by `planoKit.test.ts` ("a impressão gravada é a do mapa
ARMAZENADO…", EQUAL and near-miss), `aplicarKit.test.ts` ("(R1-RT7-02 / R3-03) a stored entry
WITHOUT quantidade…") and `publicarKit.test.ts` end to end.

**Why the fingerprint is not a recipe.** The trigger that opens the recipe aviso runs in
`apps/functions`, with no Shopee token, so it cannot read Shopee's recipe. What it can read
is `receitaKitConferida` on each kit-model `variashopee`: the fingerprint of the ERP recipe
that a READ-BACK last proved equal to Shopee's. It is written ONLY on a fold-EQUAL read-back
(the create's completion, a fold-equal republish, step 9's import) — never on a write's 200,
which proves nothing (§1) — and a DISTINCT read-back writes `null` (a new row) or leaves the
old stamp. It is never sent to Shopee and never read to decide a Shopee write: republish
and recreate always read `get_kit_item_info` live. A #1450 repoint flips the fingerprint with
Shopee's recipe unchanged; that is accepted, because a plain republish folds EQUAL on
Shopee's side, re-stamps and resolves the aviso.

## 5. Republish (`kit-atualizar`)

`republicarKit.ts`. A plain publish of a produto whose conta holds ONE live native-kit link
(not removed, not superseded) republishes that kit: ONE `update_kit_item`, PARTIAL (the
models a body omits are kept, P2-c). What Shopee lets a kit change after its create is what
it sends (L4(3)): the name and description (the stored link's first — the live listing's,
D2 §8), the cover (≤ 9, the same resolver as the create), the logistics, the weight and
dimension, `item_sku` (K's when trim-clean; else the LIVE one, with the warning
`sku-do-kit-nao-enviado`), each model's price and `model_sku`, and APPENDED models. Never
`unlisted` (pausing is step 11's `unlist_item`), and never a recipe.

**Every live model goes back with its LIVE components, verbatim.** `component_list` is
`linhasDeReenvioDoKit(get_kit_item_info's model)` — the hidden model id of a plain component
included — and `tier_index` is `[live.tier_index[0]]`. Re-encoding the ERP recipe would be
pointless (a quantity change answers 200 and is silently ignored) and dangerous (a 200 would
read as "applied"). A live model with nothing verbatim to resend (no tier index, an
unreadable quantity) is omitted, which keeps it as it is.

**Binding — the rule that also completes an interrupted create.** A live model binds to an
ERP child, in this order:

1. through its `variashopee` ROW on THIS listing (`linhasDoAnuncio`: the `idDoRef` fold over
   BOTH stored encodings of `produtoShopeeOuterRef` — canonical `documents/…` and the legacy
   bare path; never a raw `===` against a path);
2. a família de um's single model → the member;
3. the child whose variante equals the model's tier OPTION text;
4. the child whose `sku` equals the model's `model_sku`.

Never by the tier position recomputed from the ERP: the grupo's order may have moved since
the create. A live model is never re-appended (§2.5.4 U1: an appended model whose row was
never written binds by its option and gets its row). Only an ERP child that NO live model
carries is an append candidate. `ligarModelosDoKit` (`aplicarKit.ts`) is the one binder; the
completion and the republish both call it.

**Completion first (S2C-06).** When the target link has no write-back #2 (`item_status`
never written — §2.5.4 C2) or a BOUND live model has no row (C3, U1), `completarKit(…,
'opcao')` runs BEFORE the refusal gate: Shopee READS plus idempotent Firestore writes, no
Shopee write. So a half-created kit whose produto now misses, say, its weight still gets its
#2 and its rows (steps 12/13 and the aviso can see it), and the run then refuses.

**What refuses, and what only warns** (§2.6 — a republish NEVER blocks for a recipe reason):

| finding                                                                                                                            | republish                                                                                                     | create arm                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `sem-nome`, `sem-descricao`, `sem-peso`, `sem-dimensoes`, the name/description bands, `sem-fotos`, `logistica-sem-canal`           | refuses                                                                                                       | refuses                                               |
| a BOUND child's `filho-sem-preco` / `sem-preco` / `preco-fora-da-faixa` (band only when served for the LIVE main's category)       | refuses                                                                                                       | refuses (every child)                                 |
| the target kit reads deleted (a delete status, or a purged row)                                                                    | refuses `listagem-removida` (the kit sentence) and writes `estadoAnuncio: removido` on the link — a fact read | —                                                     |
| `kit-sem-sku`, `kit-sku-com-espacos`                                                                                               | warns `sku-do-kit-nao-enviado`, resends the live `item_sku`                                                   | refuses                                               |
| a BOUND child's recipe changed (folds DISTINCT from the live model)                                                                | warns `receita-divergente` (advice: `--recriar`)                                                              | —                                                     |
| a BOUND child's recipe row (`componente-*`, `kit-sem-componentes`, `kit-componente-unico-quantidade`, `componentes-fora-da-faixa`) | warns `receita-nao-publicavel` (NO `--recriar` advice: a recriar refuses on the same row)                     | refuses                                               |
| `--principal` ≠ the live main                                                                                                      | warns `principal-diferente` (the main is frozen after create; never applied)                                  | `principal-obrigatorio` / `principal-invalido` refuse |
| a live model no child matches                                                                                                      | resent unchanged, warns `modelo-sem-filho`                                                                    | —                                                     |
| an unbound ERP child that does not fit                                                                                             | the append is SKIPPED, warns `variacao-nao-anexada`; the update still goes                                    | `kit-variacoes-demais` / `kit-dois-eixos` refuse      |

An append (`model_id: 0`, the child's price, `model_sku` and ERP projection, never a main)
needs the WHOLE tier resent with the new option appended (the live options verbatim, never
option images). It is skipped, with the reason in the warning, when the child's recipe did
not resolve fully or carries a recipe row, the kit varies on two grupos, it would be the 10th
model, the child has no option of its own (no variante, or one the live tier already has, or
the live tier is unreadable), or it has no price / a price outside the served band.

**Verified by READ-BACK, never by the 200.** After the ack the same completion reads the kit
back (base + kit page + `get_model_list`), writes #2, binds every model (an appended one by
its new option — compared through the fold the option was SENT with, `opcaoDoTierKit`:
trimmed, case kept, so a padded grupo name still re-binds, R2-F1; a lone child's single
`'Padrão'` sentinel model binds to it, R3-01), `create()`s the missing rows and stamps `receitaKitConferida` ONLY on a
child whose read-back model folds EQUAL to the ERP projection. A child whose recipe Shopee
ignored keeps its OLD stamp, so the aviso stays open; an appended child whose read-back lacks
a sent row is created unstamped. Then ONE `reavaliarAvisoDeReceitaKit(…, 'republicado-igual')`
— which is how a #1450 repoint closes without a recriar. `modelos.anexados` counts the
appends the read-back actually bound; `vinculados` counts every bound model, appended ones
included.

**No duplicate scan (L10(4)).** `ctx.busca` is `null`: a republish makes zero `get_item_list`
calls and names no same-SKU twin. An unlinked twin of a double create surfaces on the next
CREATE-arm run (`--recriar`, `--converter-em-kit`), register 303.

**Errors.** Shopee's refusal of `update_kit_item` is a `ShopeePublishRejectedError` at etapa
`update_kit_item`, classified by `recusaKit.ts` first, then by step 11's table; a rate limit,
a dead grant, our own guard and a network failure keep their own class. A republish is
idempotent (§2.5.4 U2): re-running it resends the same content, so a failed run is simply run
again.

**A refused `update_kit_item` stamps NO `falhaPublicacao` (OP-19, decided).** Step 11 stamps
the link's `falhaPublicacao {em, etapa, erro, mensagem, problemas}` when a write fails; the kit
arms do not — neither this republish nor step 13's kit price arm. The 422 (and the CLI/route
summary built from it) is the ONLY signal, and the link's diary keeps whatever it held: `null`
after a kit write-back #2 (which clears it), or a stale step-11 value on a converted listing's
OLD link. Why not stamp: the seam gives the kit arms exactly one link writer (`vinculosKit.ts`,
values READ from Shopee — #2, the `removido` fold, the post-delete read), and a stamp is the
first write of a value Shopee did not report, on a link #2 guards against leaving `removido`
(R1-RT7-05). It belongs with the step-21 panel that will read it — which then needs both the
stamp here and the clear that #2 already does.

| state found                                                   | arises from                                 | the next plain publish does                                 |
| ------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| U0 nothing sent                                               | a crash before `update_kit_item`; a refusal | the same republish                                          |
| U1 the update applied (an appended model live), no row for it | a crash before the rows                     | binds that model by option, writes its row, appends nothing |
| U2 rows written, the aviso not re-decided                     | a crash before `reavaliar`                  | its own `reavaliar`                                         |
