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

## 6. Recriar vs converter (`recriarKit.ts`)

Shopee never changes the recipe of a live kit: a quantity change is a silent 200
(§1). So a new recipe means a NEW kit. Two explicit commands make one, and both
are ENSURE sequences built from §2's `garantirKitNovo` + `completarKit`. Neither
stores anything about its own progress.

|                    | `--link <kit antigo> --recriar` (L4(4))                                                        | `--converter-em-kit` (L8)                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| target             | a native-kit link: live, removed or superseded — ALWAYS named, so a re-run is the same command | a live ORDINARY link (an old-model kit listing): named, or step 11's lexically-first pick among the live ordinary links |
| scan exclusion     | the target's `item_id` (the old kit carries the same SKU)                                      | none (an ordinary listing is not a kit row)                                                                             |
| the old listing    | `delete_item`d once the gate passes; superseded when the delete does not take                  | NEVER touched: no Shopee write carries its `item_id`; it is superseded and keeps its stock and price (¹)                |
| the aviso decision | `kit-recriado`, after every stamp                                                              | `kit-recriado`, after the supersede                                                                                     |
| produto gate       | the target's own link (`kitNativo === true`)                                                   | `ehKit === true` — NOT `ehKitVirtual`, which old kits carry false/null                                                  |

(¹) The only call that may carry the ordinary listing's `item_id` is a READ: the
L6 scan's batched `get_item_base_info`, when its list row has `tag: null` (a
legacy row is a candidate until its base info says `tag.kit: false`).

**The recriar, in order:**

| step | what it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (−)  | the scan's verdict FIRST: a foreign hit, the produto's own superseded kit, an incomplete scan or two OURS refuse before anything else, so an unlinked same-SKU twin is always named                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 0    | the SAFETY NET: a LIVE target whose every model is bound, every ERP child bound, every pair folding EQUAL, with `--principal` absent or equal to the live main ⇒ `recriacao-sem-diferenca`, zero Shopee writes (the aviso decision still runs). Skipped on a removed or superseded target, and on a resume (another live native link exists)                                                                                                                                                                                                                                                                                                                  |
| 1    | ensure the new kit: create (`add_kit_item`, the link write, `completarKit('tier-enviado')`), or complete the one already linked (`completarKit('opcao')`), or refuse ("importe-o" / the list). `incerto` ⇒ the 202 at once                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2    | the DELETE GATE, only while the target still exists. The new kit must: read `NORMAL`/`UNLIST`, and `NORMAL` whenever the old kit reads `NORMAL` — a paused kit never replaces a kit on sale, so `--recriar --status UNLIST` over a live kit stops here and deletes nothing (else `kit-novo-inativo`); carry the ERP composition, i.e. every ERP child bound, every pair folding EQUAL on the read-back and no `receita-divergente`/`variacao-nao-anexada`/`modelo-sem-filho` (else `kit-novo-divergente`); carry the named `--principal` (else `principal-diferente`); be NEWER than the target by `create_time` (else `kit-alvo-mais-novo`). Any miss ⇒ STOP |
| 3    | ensure the old kit is gone: it reads deleted already ⇒ no call, the link written `removido`; `NORMAL`/`UNLIST` ⇒ `delete_item`, then a re-read; `BANNED`/`REVIEWING` is never sent a delete ⇒ superseded + `kit-antigo-nao-excluido`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4    | `reavaliarAvisoDeReceitaKit(…, 'kit-recriado')`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The converter is steps 1, a supersede of the ordinary link, and 4: no safety
net, no gate, nothing destructive to protect. A named `--principal` that is not
the completed kit's main warns `principal-diferente` and still supersedes.

**Rules a change must not break:**

- **`incerto` stops everything.** No gate, no step 3, no supersede, no aviso
  decision: an uncertain create may or may not exist, and the exact command the
  202 prints is the way back (M183).
- **The `delete_item` ack is never trusted.** Only the re-read decides. Deleted
  (`SELLER_DELETE`, `SHOPEE_DELETE`, or an absent row) ⇒ #2 on the OLD link, which
  folds to `removido`; a delete that timed out but that Shopee executed is the
  success path. Anything else ⇒ the old link is superseded by the new one and the
  run warns `kit-antigo-nao-excluido`: the old kit still sells the OLD
  composition, so its rows keep the aviso open until it is gone. A failed call is
  narrowed to the package's `ShopeeError` family minus `ShopeeConfigError` (rule
  6); anything else rethrows.
- **The gate guards only an ACTION on a target that still exists.** A target
  whose link is `removido`, or that reads deleted, is not live-read again
  (`prepararKit` skips the read on a `removido` link, M123); the gate is skipped,
  and the completion's own warnings are reported as they are.
- **The gate compares against the COMPLETED kit, never the target.** On a
  recriar or converter RESUME (`decidirKitNovo` answers `completar`),
  `prepararKit` reads the completed kit live, step "4b". Its read-back main
  becomes the context's `principal`, which feeds the limits category and
  `principal-diferente`. That costs ONE extra `lerAnuncioShopee`, since
  `completarKit` reads the same kit again. If that kit reads with no main,
  `principal` is `null` and the local band is skipped.
- **`kit-alvo-mais-novo` names the kit to pass.** With the target newer than the
  completed kit, it names the older one (`--link <ele> --recriar`). With EQUAL
  `create_time`s, or either one `null`, there is no "older" to name, and it asks
  the operator to check.
- **The old `variashopee` rows are LEFT AS THEY ARE.** Rung 1 of the order
  cascade has no `modeloAusenteEm` filter, so old orders still bind, and the
  per-listing sync below never marks them from the new kit's reading.

### What "superseded" means (R-12)

Two flat scalars on the OLD link, `substituidoPorLinkDocId` and `substituidoEm`
(ms). ONE writer, `carimbarSubstituicao` (`vinculosKit.ts`, a flat `merge` a
re-run re-writes identically), from two sites: the converter, and a recriar
whose delete did not take. It changes **publish only**:

- the dispatcher never routes a plain publish to a superseded link, and naming
  one answers `vinculo-substituido` — except `--recriar` on a superseded NATIVE
  kit, which retries the delete that did not take;
- steps 12 and 13 do NOT read it: the old ordinary listing keeps its
  component-min stock and its `update_price` until it is deleted (L8 ⚠️: it is
  still selling, and a stale stock on it oversells); a superseded old native kit
  keeps its step-13 kit price;
- the order cascade does not read it (rung 1 binds by `model_id` and rung 2 by
  `item_id`), so old orders still resolve.

### Two resolvers, and why PUBLISH stays lexical

- **`resolverLinkPorProduto`** is the publish path's resolver
  (`prepararPublicacao`). It stays main's lexical `escolherLink` over every link
  of the conta, unchanged, because L10(3) says publishing a non-kit produto must
  not change. Reordering it would publish a non-kit produto whose REMOVED link
  sorts first to its live link, where main answers `listagem-removida` (M185,
  `publicarAnuncio.test.ts`).
- **`resolverLinkVivoPorProduto`** (`linkAnuncio.ts`) serves the reverify, the
  status, `pausar` and the `reverificar:anuncio` CLI. Same signature, conta
  filter and `linkDocId` narrowing. With no `linkDocId` it picks an active native
  kit (`ehKitNativoAtivo`), then a link neither removed nor superseded, then the
  rest, using `escolherLink` within each tier. So `pausar` on a converted produto
  unlists the new kit, never the superseded listing (M185's near-miss,
  `pausarAnuncio.test.ts`).

### The model-list sync is per LISTING (R-12(e))

A converted or recreated produto holds TWO listings' `variashopee` rows under the
same children. `lerLinksDeVariacao` and `sincronizarLinksDeVariacao` take the
listing's `linkDocId` and keep only the rows whose
`idDoRef(produtoShopeeOuterRef)` equals it, over BOTH stored encodings. A row
whose ref is unreadable is skipped and logged, never marked; `null` means
unfiltered, and only a step-11 first publish (no link yet) passes it. Without
the filter, reverifying one listing would stamp the OTHER's rows
`modeloAusenteEm`, and steps 12/13 would drop them (M121).

### Deleting an old listing — the runbook

No Shopee push reports a SELLER delete, and the stock and price senders never
write `estadoAnuncio`. So the ERP learns that an old listing (a converted one, or
an old kit whose delete did not take) is gone only when someone re-verifies it.
Lucas deletes it in Seller Centre, then runs (`scripts/README.md` §18):

```bash
pnpm --filter @delfrance/shopee-app reverificar:anuncio --integracao <integracaoId> --produto <produtoId> --link <linkDocId>
```

`SELLER_DELETE` folds to `removido`, and steps 12/13 then skip the link as
`anuncio-removido`. Until that run, a step-12/13 write to it lands on those
senders' existing refusal paths (register 300). The CLI has **no dry run**: it
only reads Shopee and writes the reading, and it refuses `--dry-run` and
`--live`.

**The aviso hook.** After any write whose resulting `estadoAnuncio` is `removido`
on a link with `kitNativo === true`, the reverify and the push handlers (codes
16/27) call `reavaliarAvisoDeKitRemovido` (`reverificarAnuncio.ts`). That covers
the read path's `SELLER_DELETE` fold, the not-found arm, and the push's
`SHOPEE_DELETE`. It runs on an unchanged reading too, so a crash between the link
write and the decision converges on the re-run. The shared decision then picks
the motivo:

- no kit of the produto still sells ⇒ `sem-kit-ativo`;
- the deleted kit was a recriar's superseded OLD kit and the new one folds equal
  ⇒ `kit-recriado` (the deletion finished the recriar, M120);
- the new kit still diverges ⇒ the aviso stays open.

An ordinary link never reaches it: zero aviso reads.

### Crash recovery — what the operator runs from each state

Every terminal state below sends no Shopee write when the same command runs
again.

**`--link L_old --recriar`:**

| state found                                      | arises from                                                   | run                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0 nothing done                                  | a crash before `add_kit_item`; `nao-criado`                   | the same command: it creates                                                                                                                                   |
| R1 new kit on Shopee, unlinked                   | `incerto` that did create; a crash before the new link write  | the same command refuses "importe-o" ⇒ `importar:anuncio <item>` (the listing-scoped child cascade lands on K's children) ⇒ R2                                 |
| R2 new kit linked, L_old live                    | a crash before the delete                                     | the same command completes the new kit, passes the gate, deletes L_old's kit. A plain publish meanwhile answers `vinculos-ambiguos` naming both, with the hint |
| R2′ new kit not live, or not equal to the ERP    | Shopee's own state; an ERP edit after the create              | every run stops at the gate (`kit-novo-inativo` / `kit-novo-divergente`), L_old untouched; once the new kit is live and aligned, the same command finishes     |
| R3 L_old's kit deleted, its link not `removido`  | a crash between `delete_item` and the old-link write; a purge | the same command: the target reads deleted ⇒ gate skipped ⇒ NO second `delete_item` ⇒ `removido` written                                                       |
| R5 L_old superseded                              | its delete did not take (warned)                              | a plain publish republishes the NEW kit; the same command retries the delete (or delete it in Seller Centre and run `reverificar:anuncio --link L_old`)        |
| R4 done: L_old `removido`, the new kit with rows | —                                                             | the same command answers `retomado` with zero Shopee writes; `--link <new kit> --recriar` with nothing different is `recriacao-sem-diferenca`                  |

**`--converter-em-kit`:**

| state found                             | arises from                                              | run                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| V0 nothing done                         | a crash before `add_kit_item`; `nao-criado`              | the same command: it creates, then supersedes                                                                                             |
| V1 new kit unlinked, L_ord live         | `incerto` that did create; a crash before the link write | the same command refuses "importe-o" ⇒ `importar:anuncio <item>` (L_ord's rows are left byte-unchanged) ⇒ V2                              |
| V2 new kit linked, L_ord not superseded | a crash before the supersede                             | `--converter-em-kit` completes and supersedes; a plain publish republishes the new kit                                                    |
| V3 done: L_ord superseded               | —                                                        | `--converter-em-kit` answers `ja-e-kit-nativo`, zero writes; a plain publish is `kit-atualizar`; delete L_ord in Seller Centre + reverify |

A phase-A miss (say, `sem-peso`) refuses any create-arm run, a resume included,
before the first Shopee read, and it adds and removes no fact: the run after the
ERP fix resumes from the same row. Meanwhile `--link <kit novo>` (a plain
publish) still completes the new kit.

Pinned by RT5 (recipe change → aviso → recriar → resolved), RT6 (converter → the
old listing is still served by steps 12/13 and the reverify; the PR 8 half lives
in `precos/kitNativoImportado.test.ts`), RT13 (recriar R1/R2/R5 resumes) and RT14
(converter V1/V2 resumes, with zero writes carrying the ordinary `item_id`), all
in `recriarKit.test.ts` except where noted; the dispatcher halves of RT13/RT14
are in `anuncios/publicarShopee.test.ts`.

### The SKU rules

- **The scan (L6) runs on the create arms only** — `kit-criar`, `--recriar`,
  `--converter-em-kit` — and never on a republish (L10(4)).
- **What it scans.** It pages `get_item_list` over `STATUS_BUSCA_KIT` =
  `NORMAL`/`UNLIST`/`REVIEWING`/`BANNED`, with no `update_time_from`. A deleted kit
  is never a hit. Beyond `MAX_PAGINAS_BUSCA_KIT` (100 pages), it refuses
  `busca-de-kit-incompleta`.
- **Fail-closed on `tag`.** A row whose `tag`/`tag.kit` is null is a candidate,
  decided by its base info; only `tag.kit === false` is dropped. A missing tag
  costs reads, never a duplicate kit.
- **The SKU match is step 9's identity**: `skuDoItemShopee(base) === sku`, where
  `skuDoItemShopee` is `(item_sku ?? '').trim()`, case-sensitive like the parent
  rung's `where('sku','==',…)`.
- **OURS is decided by the link docs.** A linked kit that the list does not show
  yet (~9 s of listing latency) still exists: one batched `get_item_base_info`
  confirms it. A linked id that reads deleted is written `removido` before the
  run acts.
- **Our side must be clean.** A SKU missing, padded or shared is refused in phase
  A, before any Shopee read. "Missing" and "padded" are not re-derived here: every
  guard (phase A, the republish's `sku-do-kit-nao-enviado`, the rung-2 read) asks
  `situacaoDoSkuDoKit` (`planoKit.ts`), which asks `skuDoItemShopee` itself — K's SKU
  must be a FIXED POINT of the import's fold, so a wider fold moves every guard with it
  (R2-F3):
  - `kit-sem-sku`;
  - `kit-sku-com-espacos` (register 299);
  - `kit-sku-repetido` — phase A runs step 9's rung-2 query
    (`produtos where sku == K.sku and paiId == null limit(2)`, the existing
    `produtos (sku, paiId)` composite) and refuses unless it returns exactly K.
    Otherwise the L9 recovery import could decline rung 2 and MINT a produto.

## 7. Errors, the other steps, and the aviso

### Errors are read by SENTENCE (`recusaKit.ts`)

`product.error_busi` carries both a transient and a permanent refusal, with the
same code and the same `kind`. So every kit-arm WRITE consults
`problemasDaRecusaKit` BEFORE step 11's `problemasDeErroShopee`, never
`KIND_BY_CODE`. Each row matches only under its own canonical code
(`codigoCanonicoShopee`), with the needle compared against the folded
`providerMessage` (`fraseCanonicaShopee`) — never `err.message`, which is OUR
sentence.

| code (canonical)              | needle                                          | motivo                              | source                    |
| ----------------------------- | ----------------------------------------------- | ----------------------------------- | ------------------------- |
| `error_busi`                  | "Invalid product setting"                       | `operacao-invalida-para-kit`        | probe (`update_stock`)    |
| `error_busi`                  | "Too many connections"                          | `instabilidade-shopee` ⚠️ TRANSIENT | probe (`add_kit_item`)    |
| `error_server`                | "generate kit image toggle closed"              | `imagem-de-kit-desligada`           | probe                     |
| `.`                           | "product is not found"                          | `kit-inexistente`                   | probe                     |
| `error_busi_cannot_edit_vsku` | — (by code)                                     | `kit-bloqueado-pela-shopee`         | documented (register 281) |
| `error_busi`                  | "The amount of component in this Kit Variation" | `faixa-de-componentes`              | documented                |
| `error_price_out_of_range`    | — (by code)                                     | `preco-fora-da-faixa`               | documented                |
| `error_param`                 | "The information you queried is not found"      | `kit-inexistente`                   | documented                |
| `error_busi`                  | "mupltiple main sku" (Shopee's spelling)        | `kit-principal-duplicado`           | probe #2 (P2-a)           |

**`desfechoDeCriacaoDeKit` — did a failed `add_kit_item` create a kit?**

- **`nao-criado`** (a 422, nothing written): our own `ShopeeConfigError`, a rate
  limit, a dead grant, or a NON-transient row above.
- **`incerto`** (a 202 with Shopee's sentence, `MENSAGEM_KIT_INCERTO` and the
  exact command to re-run; nothing written): everything else — the transient row,
  an unknown refusal, a network failure (a body cut mid-stream included), a
  non-envelope answer.

The verbatim `providerMessage` of an `incerto` is `console.warn`ed with ids only;
that is how registers 281 and 287 get settled.

### What the other steps do with a native kit

| step     | what it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12 stock | NEVER sends one: `kitNativo === true` ⇒ `kit-derivado`. Shopee derives the kit's stock (§1) and refuses a write. A link whose #2 never ran still holds the literal `true` from the link write, so it is skipped too. An old ORDINARY listing is not a kit, so it keeps its component-min stock                                                                                                                                                                                                                                                                                                                                |
| 13 price | Plans a native kit like any listing (the price slug `kit-derivado` is retired). G9 picks the transport from G1's base row (`LeituraDePreco.kit`): ONE `get_kit_item_info` + ONE `update_kit_item` with ONLY the changed models, each `{ model_id, tier_index (live), original_price, component_list: linhasDeReenvioDoKit(live) }`, and no tier list. G11 runs `'releitura'` for a kit — never the synthesised echo — and compares `item_name` + the image count as register 301's tripwire. A kit link with zero attributed rows is `sem-modelos`. `update_price` on a kit is the measured unused alternative (register 271) |
| 5 orders | A kit line carries the KIT `model_id` and binds rung 1 through the child's kit-model `variashopee` row (register 282/283). `kit_items` is never exploded: the ERP kit produto owns its components (ADR 0014)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9 import | The hidden model id is folded by `has_model` (§3), and a plain component hops to its sellable unit. A NEW kit link is written at `idDoVinculoDeKit` (`merge`), so an import and a create converge on ONE doc. The child cascade is scoped to the imported listing, so another listing's rows neither claim a child nor get merged onto. A re-import never overwrites a pending ERP recipe edit (below). Step 9 never sets `ehKitVirtual`                                                                                                                                                                                      |

### ONE aviso decision (`reavaliarAvisoDeReceitaKit`, `@delfrance/data`)

A recipe edit on a produto with a native-kit link opens
`shopeeKitReceitaDivergente`, ONE per (conta, kit produto K). Every site calls the
same decision AFTER its own stamp, never a blind `resolverAviso`. The sites are:

- the `apps/functions` trigger, behind a pure gate that costs zero reads on an
  ordinary save;
- the create arms;
- the republish;
- step 9's import;
- the reverify/push hook.

It re-reads, in ONE read-only snapshot, every child's CURRENT `componentesKit`
and its rows bound to a native-kit link that STILL SELLS
(`ehKitNativoQueAindaVende`: active, or superseded and neither removed nor
banned). It clocks its write by the max µs `updateTime` of every doc it read,
because a recriar writes only links and rows, so a children-only clock would tie
the raise it must close.

- **Opens** when any row's `receitaKitConferida` ≠ the current fingerprint; a
  `null` stamp counts as different.
- **Resolves** only when every row is equal, with the caller's motivo
  (`MOTIVO_RESOLUCAO_RECEITA_KIT`, five values):

| motivo                   | who resolves with it                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `receita-igual-a-shopee` | the trigger: the recipe folded back to Shopee's                                                                      |
| `kit-recriado`           | a create arm finished (criar, recriar, converter), or the reverify hook saw a recriar's old kit deleted (§6)         |
| `republicado-igual`      | a republish folded EQUAL and re-stamped — how a #1450 repoint closes without a recriar                               |
| `importado`              | step 9 re-imported the kit and its recipe folded equal                                                               |
| `sem-kit-ativo`          | the decision itself, on 'nada': no native kit of K still sells (deleted in Seller Centre and reverified, or removed) |

With no open row and nothing that still sells, it writes the resolved
`sem-kit-ativo` WATERMARK only when K holds some native-kit link of the conta, so
a late raise from an older snapshot is dropped. For an old-model kit it writes
nothing at all. Its accepted residual is a deletion-only resolve dropped as "not
newer": the aviso stays open, the safe direction, until the next save, republish
or reverify.

**A re-import never silently reverts a pending edit (R-t, L10(2)).** It compares
the fingerprint of Shopee's resolved recipe with the current ERP map, per child.
The rows that count are the child's rows on EVERY active native-kit link of K.

- **Equal** ⇒ the import proceeds and pre-stamps, so the aviso resolves
  `importado`.
- **Different, with a row whose stamp ≠ the current fingerprint** (an edit the
  aviso is tracking) ⇒ the import KEEPS the ERP map for that child, writes no
  stamp, leaves the aviso open and reports `receita-divergente`.
- **Otherwise** ⇒ Shopee's recipe wins, as before step 19.
- **Two exceptions** (step-19 review): a família de um whose K differs from its member (the
  mirror still pending) is `igual` only when Shopee folds to K's OWN stored recipe, else the
  member is kept (R1-RT7-01); and an address-unfaithful recipe (two Shopee addresses onto one
  produto) is written but never stamped, an earlier stamp CLEARED, so the aviso opens (R2-F2).
  Detail: `produtos/README.md`.

Only the produto's ACTIVE native kit writes a recipe: importing a superseded or
removed listing binds its rows and writes no `componentesKit`.

⚠️ **Kit rows written before step 19 carry no stamp.** A re-import whose Shopee
recipe differs from the stored ERP map, on a child whose rows predate
`receitaKitConferida`, reads `null ≠ current` and KEEPS the ERP map — the
pending-edit branch above, taken literally (the aviso decision agrees: it
opens). No native kit exists in production (L0), so this touches staging rows
only. A plain republish that folds equal re-stamps them and closes the aviso.

## 8. The settle-live register (rows 270–305)

Each row is a claim the code makes and what settles it. Every row from 292 to
298 is ✅ measured on the SG sandbox. The rest are open, and every open one is
Lucas's to run. BR settles 271, 272, 273, 274, 275, 288 and 291; the SG sandbox
settles 270, 276–287, 289, 290, 299–302, 304 and 305. Settle 301 before the first
`--live` kit price push, 302 before the first `--live` recriar, and 305 before the
first `--live` create with `--status UNLIST`.

| #   | claim (the assumption the code makes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | settles it                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 270 | Ordering a kit DECREMENTS its components' stock on Shopee (and shows a reservation on them); the ERP's own sale moves the components through the child's `componentesKit` (ADR 0014), so both sides agree                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | sandbox Console → Test Order on a kit; read the components + `get_model_list(kit)` before and after                                                                 |
| 271 | `update_price` on a kit model — ✅ ACCEPTED on SG (probe #2, P2-d). Step 13 uses `update_kit_item` anyway (L5); `update_price` is the measured ALTERNATIVE transport. BR: open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | BR shop: one `update_price` on a kit model, read back                                                                                                               |
| 272 | Lucas's BR shop and this app are whitelisted for the OpenAPI kit ops (announcement 1310); otherwise every kit write answers `error_busi_cannot_edit_vsku` (→ `kit-bloqueado-pela-shopee`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | BR shop: the first `publicar:anuncio --live` of a kit (no native kit exists to read, L0)                                                                            |
| 273 | BR serves `get_kit_item_limit`; its success `error` is `''` or `'-'` (both accepted); a 404 elsewhere is "not served", never "not whitelisted" (master-plan row 52's old settle)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | BR shop: one `GET taxonomia/limites/kit`                                                                                                                            |
| 274 | `generate_kit_image` on BR: the toggle state; the keys `item_id`/`model_id`; whether it returns an `image_id` usable in `images.image_id_list` or a URL (nothing calls it, O-1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | one call with the toggle open                                                                                                                                       |
| 275 | `long_image` is singular on BR too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | one `get_kit_item_info` on BR                                                                                                                                       |
| 276 | A model with ONE component needs quantity ≥ 2 (announcement 1262), and 1 component × 2 is accepted (`kit-componente-unico-quantidade`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | sandbox: two creates                                                                                                                                                |
| 277 | `component_count_limit_of_single_model` counts ROWS or Σ`quantity` — the local check refuses only when both readings agree (R-f)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | sandbox with a served band, or Shopee's own `faixa-de-componentes` text                                                                                             |
| 278 | `update_kit_item` with a CHANGED `component_list` on an existing model (a row added or removed): refused or silently ignored (a quantity change is ✅ silently ignored, P2-c)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | sandbox: one update, read back                                                                                                                                      |
| 279 | A transient `add_kit_item` failure ("Too many connections") leaves NO ghost kit. If it does, nothing duplicates: the re-run's scan finds it and refuses "importe-o" (§6, C1), so the cost is one import                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the next sighting: the re-run after a transient                                                                                                                     |
| 280 | `search_item?item_sku=` returns kit items, exact match (an optimisation of the scan; not used, O-2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | one call                                                                                                                                                            |
| 281 | What actually triggers `error_busi_cannot_edit_vsku` (documented on five pages, never fired in either probe)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | the first sighting, logged verbatim                                                                                                                                 |
| 282 | A kit ORDER line carries the KIT `model_id` and binds rung 1 through the child's `variashopee` (RT2, offline)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the row-270 test order, `get_order_detail`                                                                                                                          |
| 283 | `get_kit_item_info.model_list[].model_id` = `get_model_list(kit).model[].model_id` = the order line's `model_id` (the create's read-back cross-checks the first two and `console.error`s a mismatch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | the row-270 order + both reads                                                                                                                                      |
| 284 | `get_model_list(kit)` shows the `original_price` an `update_kit_item` set (step 13's G11 read-back for kits); if not, every kit price send reads `preco-nao-atualizado` (the safe direction)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | sandbox: one step-13 manual push on a kit                                                                                                                           |
| 285 | `update_item` on a kit `item_id` is refused (the item arm never sends it; the dispatcher routes kits away)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | sandbox: one call                                                                                                                                                   |
| 286 | Deleting or unlisting a COMPONENT item leaves the kit readable and says so in `get_kit_item_info`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | sandbox                                                                                                                                                             |
| 287 | A category whose size chart is mandatory (the probe's `add_item` warning) refuses a kit whose main sits in it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the first sighting                                                                                                                                                  |
| 288 | The `get_item_list` ROW carries `tag.kit` on BR as on SG. The scan is FAIL-CLOSED either way: a row with `tag`/`tag.kit` null is a candidate decided by its base info, so a missing tag costs reads, never a duplicate kit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | BR shop: one page                                                                                                                                                   |
| 289 | Shopee accepts a kit whose `item_sku` equals a LIVE ordinary listing's (the converter keeps K's SKU, L8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | sandbox: one converter `--live`                                                                                                                                     |
| 290 | The single-model tier `'Kit'`/`'Padrão'` (DECIDED by L10(1); only Shopee's side is open) is accepted, and how Seller Centre shows it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | sandbox: the first família-de-um create                                                                                                                             |
| 291 | BR kits price in BRL (announcement 1310 is BR-local SIP only); the SG rehearsal is SGD in a BRL field, and the CLI says so                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the first BR create                                                                                                                                                 |
| 292 | ✅ PROBE #1: kit stock = min ⌊component stock / qty⌋ over ALL components, synchronous, readable only via `get_model_list(kit)`; `update_stock` on a kit is refused ("Invalid product setting")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | closed (SG)                                                                                                                                                         |
| 293 | ✅ PROBE #1: `get_model_list` on a `has_model: false` item answers zero models; the kit's `component_model_id` for it is a hidden non-zero id, with name and SKU `''`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | closed (SG)                                                                                                                                                         |
| 294 | ✅ PROBE #1: `delete_item` on a kit works; a deleted kit stays readable (`SELLER_DELETE`) and listed under the delete statuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | closed (SG)                                                                                                                                                         |
| 295 | ✅ PROBE #1: `add_kit_item` is NOT idempotent; `product.error_busi` carries a transient AND a permanent refusal; only the sentence separates them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | closed (SG)                                                                                                                                                         |
| 296 | ✅ PROBE #2: ONE `main_component` per kit across all models ("mupltiple main sku")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | closed (SG)                                                                                                                                                         |
| 297 | ✅ PROBE #2: `update_kit_item` is partial (omitted models kept); an append is `model_id: 0` + the full tier list; a quantity change is a silent 200                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | closed (SG)                                                                                                                                                         |
| 298 | ✅ PROBE #2: `unlist_item` on a kit works both ways; each kit model derives its own stock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | closed (SG)                                                                                                                                                         |
| 299 | Shopee stores `item_sku` exactly as sent (no trim or fold), so the L6 scan (`skuDoItemShopee(base) === sku`) finds what was created and step 9's parent rung (the same fold) lands it on K; a whitespace-padded ERP SKU is refused locally (`kit-sku-com-espacos`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | sandbox: one create, read `item_sku` back                                                                                                                           |
| 300 | A step-12 `update_stock` / step-13 `update_price` on a SELLER_DELETEd ordinary item answers an error the existing senders record on their refusal paths (`estoqueRecusa*` / `precoRecusa*`); it is never folded into `removido` — only `reverificar:anuncio` does that                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | sandbox: one of each on a deleted item                                                                                                                              |
| 301 | A partial `update_kit_item` (`item_setting: { model_list }` only) KEEPS the omitted item fields (`item_name`, `images`, `description`, `logistic_info`); if not, every step-13 kit price push would wipe them, and `precos/enviarPrecoKit.ts` must resend the live item fields from the same `get_kit_item_info`. Tripwire: G11's kit re-read compares the name and the image count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | sandbox: one partial update, read back every item field — before the first `--live` kit price push                                                                  |
| 302 | Shopee accepts a SECOND live KIT whose `item_sku` equals a LIVE kit's — L4(4)'s create-first recriar depends on it (row 289 covers only a kit beside a live ORDINARY listing). If refused, the unrecognised sentence maps to `incerto`, so every `--recriar` answers 202 and its re-run creates nothing new either (the scan finds no new kit). If the settle says "refused": `recusaKit.ts` gains the measured sentence as a PERMANENT row (`nao-criado`, its own pt-BR mensagem), and the delete-first alternative goes to Lucas, because it changes binding L4(4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | SG sandbox: create a kit, then a second kit with the same `item_sku` while the first is `NORMAL` — before the first `--live` recriar                                |
| 303 | **ACCEPTED RESIDUAL (L9, R-w).** Two concurrent creates for one (produto, conta) — a double-click, two tabs, or a re-run while an `incerto` `add_kit_item` was still in flight — can make two kits with one SKU; nothing guards it. The claim the code makes: nothing ever picks one silently. Both LINKED ⇒ every plain publish refuses `vinculos-ambiguos` naming both. One UNLINKED ⇒ **the twin surfaces on the next CREATE-arm run and only there (L10(4))**: a plain publish (`kit-atualizar`) runs NO scan and names nothing; a `--link <linked> --recriar` refuses `kit-ja-existe-na-shopee` naming it; a `--converter-em-kit` resume beside a live ordinary link refuses the same way (with none, it answers `ja-e-kit-nativo` and never scans); and the `incerto` sentence tells the operator to re-run the exact command, which scans while no other run has linked a kit. Once one has, that command is `kit-atualizar` — or a converter refusal — and the uncertain create's twin waits for the next create-arm run like any unlinked twin; `MENSAGEM_KIT_INCERTO` says so. Neither kit oversells (Shopee derives both from the same components). The window is bounded by the listing latency (~9 s on SG) and the route ceiling (180 s); the `incerto` sentence asks for 4 minutes | offline: RT15. Live: a second kit with K's SKU in Seller Centre after the first BR `--live` creates is the signal; Lucas deletes one and runs `reverificar:anuncio` |
| 304 | An APPEND on a republish resends the live tier WITHOUT its option images (`tier_variation_list` carries the live option TEXTS verbatim plus the new option, never an `image`). A kit whose options carry images — one made or edited in Seller Centre, since the ERP never sends option images — may be refused on that append (option images are all-or-none on a tier), or may lose the images. The ERP's own kits are unaffected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | sandbox: a Seller-Centre kit with option images, then one republish that appends a child; read the tier back                                                        |
| 305 | `add_kit_item`'s documented `item_setting.unlisted: true` (OP-9) creates the kit PAUSED (`UNLIST`) — neither probe sent the key, so this is the doc's word only. The create sends it ONLY on `--status UNLIST`; `NORMAL` keeps the measured body. If Shopee ignores it, the read-back says `NORMAL` (the result's `itemStatus`/`estadoAnuncio`, the CLI's summary) and the kit is on sale: pause it with `anuncio-status pausar` (`unlist_item`, measured on a kit, 298). If Shopee refuses it, the unrecognised sentence maps to `incerto` and the run writes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | SG sandbox: one create with `--status UNLIST`, read `item_status` back — before the first `--live` paused create                                                    |

Step 19 also amended four rows of the master plan's earlier steps (reconcile
§5.2):

- **52** — the docs side is answered (BR launch, whitelisting), and its free
  settle is broken by the sandbox 404, so it re-points to 272/273;
- **57** — partly answered on SG: a kit's base info is `has_model: true`,
  `tag.kit: true`, with no `stock_info_v2`;
- **99** — RE-CONFIRMED by L0: no native kit exists today;
- **109** — ✅ on SG: `update_stock` on a kit is refused, and kit stock derives
  synchronously.

## 9. What step 19 does not do

- **Send kit stock.** Shopee derives it (§1), and step 12 skips a native kit as
  `kit-derivado`.
- **Edit a recipe in place.** Shopee ignores it (§1). A changed recipe is the
  warning `receita-divergente` on a republish, and the explicit `--recriar` (§6).
- **Call `generate_kit_image`.** The package declares it with no caller (O-1);
  the cover is the kit produto's own photos through step 11's `upload_image`, cap 9.
- **Touch an old ordinary listing unasked.** Nothing reads or writes Lucas's
  old-model kit listings unless he names `--converter-em-kit` (L0, L8). A
  produto with `ehKitVirtualEfetivo` AND a live ordinary link publishes through
  the item arm, with no new warning.
- **Set `ehKitVirtual` on import** (O-7). Once a listing is linked, the LINK's
  `kitNativo` decides, never the flag.
- **Store a recipe, a principal, or any create progress** (L9, R-2). Only the
  fingerprint `receitaKitConferida`, written on a fold-EQUAL read-back.
- **Add an index, a ruleset change, a TTL policy or a migration** (R-r).
  `kit-sku-repetido` rides the existing `produtos (sku, paiId)` composite. The
  ONE window item is the read-only `ehKitVirtual === true` contagem for Lucas's
  review (`tools/migrations/kit-virtual-contagem.README.md`, L7).
- **Send `unlisted` on a kit REPUBLISH, or `description_type` other than
  `normal`** on any kit write. Pausing a live kit is step 11's `unlist_item`,
  which works on a kit (P2-e). A CREATE honours the operator's `--status UNLIST`
  (`unlisted: true`, OP-9 — register 305) and sends no key otherwise.
- **Narrow the existing ladders on `ShopeeOperacaoNaoServidaError`.** D1 §2.2
  suggested it for the other taxonomy reads; it stays unbuilt and unfiled, as do
  the remaining notes of the legacy critique (E4 §4.10).
- **Run a model sync on a push.** A push 16/27 for the old listing folds the
  status only.
- **Build the web parts.** Deferred to step 21 / #1432:
  - the kit badge;
  - the recriar and converter buttons;
  - the principal pick;
  - the composition preview;
  - the bulk-registry rows.

  Step 19's web is only the `ehKitVirtual` fix and the pre-save notice (O-9).
