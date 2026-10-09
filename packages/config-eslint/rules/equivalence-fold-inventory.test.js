import { describe, expect, it } from 'vitest';
import { gitGrep } from './lib/repo-scan.js';

/**
 * Every file using a shared **equivalence-key helper** is inventoried here, with
 * what its fold deliberately treats as equal and what must stay distinct. Use
 * one of those helpers in a new file and this test fails until you say which.
 *
 * ## The bug class (#1372)
 *
 * A *fold* is a transform whose OUTPUT decides whether two values are "the
 * same". The size-chart row diff folded `value_name` by parsing it to a NUMBER
 * so a pt-BR separator would not read as an edit — and collapsed far more than
 * the separator:
 *
 * | stored  | edited   | folded | verdict      |
 * |---------|----------|--------|--------------|
 * | `90,5`  | `90,50`  | `90.5` | "no change"  |
 * | `01`    | `1`      | `1`    | "no change"  |
 *
 * Both are real edits. `persistProgress` opens with `if (!updated) return;`, so
 * the edit reached neither Mercado Livre **nor** Firestore — it vanished behind
 * a 200, with a success toast on screen.
 *
 * ⭐ **A test that a normalization APPLIES is not a test of its SCOPE.** Eight
 * mutation tests ran against that fold before it shipped. Every one asked "does
 * the fold work?" — none asked "does it fold more than intended?". So a fold
 * needs BOTH: a pair that must come out equal, and a **near-miss** that must
 * stay distinct.
 *
 * ## Why this is a test and not an ESLint rule
 *
 * "This fold collapses more than intended" is semantic — it depends on what the
 * consumer means by "the same", which is nowhere in the syntax. The identical
 * reasoning is recorded in `reserva-arithmetic-inventory.test.js` for #931 and
 * in root `CLAUDE.md` rule 7 for transaction guards (#776). So this asserts the
 * one thing that IS mechanically checkable — the SET of files involved — and
 * makes the contract a reviewed artifact. Failing it fails CI exactly like a
 * lint error.
 *
 * ## ⚠️ What this does NOT catch
 *
 * A **hand-rolled** fold that uses no shared helper —
 * `a.trim().toLowerCase() === b.trim().toLowerCase()` — matches nothing here and
 * is invisible to this guard. Widening the pattern to raw `.toLowerCase()`
 * comparisons was measured and rejected: it lands in a ~47-file band of
 * formatters (`sanitizeCep`, `normalizeTelefone`) that are not this bug class,
 * and a guard with that many false positives trains people to add files without
 * reading them — which is the failure mode `reserva-arithmetic-inventory`
 * documents. The mitigation is convention: comparisons go through the shared
 * readers, the same trade `me-money-single-reader` and
 * `decimal-input-single-reader` already make.
 */

/**
 * The shared helpers whose output is (or can be) an equivalence key.
 *
 * ⚠️ Word-bounded, so `denormalizeLoosely` and `deepEqualityHint` do NOT match.
 * A guard with false positives is worse than none — see the control at the
 * bottom of this file.
 */
const PATTERN =
  '\\b(normalizeLoose|parseDecimalPtBr|parseCentesimos|localizarDecimal|deepEqual|stripNullsDeep|skuDoMembroUnico|skuPaiDoMembroUnico|sanitizeSearchDsl|foldSearchText|findSearchRegexMatches|firstSearchRegexMatch|searchRegexMatches|mesmoPrecoEmReais|mesmaReceitaKitShopee|chaveReceitaKitErp|principalDoKitShopee|mesmoEnderecoDeComponente|modeloDoComponenteKit|skuDoItemShopee|opcaoDoTierKit|situacaoDoSkuDoKit|chaveReceitaArmazenadaDoFilho|chaveDoPaiDaFamiliaDeUm|receitaFielAosEnderecos)\\b';

/**
 * Source only. Tests are excluded deliberately: a test SHOULD exercise a fold
 * from both sides, and inventorying test files would bury the one new source
 * call site this exists to surface.
 */
const PATHSPECS = [
  '*.ts',
  '*.tsx',
  '*.mjs',
  ':(exclude)*.test.ts',
  ':(exclude)*.test.tsx',
  ':(exclude)*.spec.ts',
  ':(exclude)apps/web/e2e/*',
  ':(exclude)tools/test-fixtures/*',
  ':(exclude)packages/config-eslint/rules/*',
];

/**
 * Path → what the fold collapses, what must stay distinct, and the test that
 * pins it. Grouped by role; the grouping IS the audit.
 */
const INVENTARIO = {
  // ---- Folds that DECIDE SAMENESS — each names its near-miss test ---------
  'packages/data/src/pedido/referenciaDevolucao.ts':
    'CALLS `mesmoPrecoEmReais(d.vUnCom, item.precoDeVenda)` to decide WHICH line of the origin NF-e a devolução item returns, for the `det/DFeReferenciado` VC02-14 demands (#1683). The fold only NARROWS: it runs among the unclaimed origin lines whose `cProd` already equals the item\'s code (exact string equality, entity-decoded; sku, then gtin, then produtoUid, each also cut to 60 — the legacy app\'s cut), and when the price matches none of them (an operator-edited price) or several, LINE ORDER decides — the lowest unclaimed `nItem` (Lucas, 2026-10-07). Exact-price matches are placed in a FIRST pass and line order only runs over what is left, so an earlier edited-price line never takes the slot a later exact-price line matches (near-miss: "NEAR-MISS: an EARLIER edited-price line never takes the slot a LATER exact-price line matches (two passes)"). Folding too much picks the wrong line of a product sold at two prices, and SEFAZ does not check a referenced `nItem`, so the wrong line is authorized silently. Equal: the same centavo after `roundReais` — `10.004` ≡ `10`. Distinct: one centavo apart — `49.99` ≠ `50`; a code differing in case or a trailing space (`a1`, `A1 ` vs `A1`) never matches. Near-miss: `referenciaDevolucao.test.ts` — "NEAR-MISS: one centavo apart is a different line — the line priced 50 claims the 50 det, even though it comes later" paired with "EQUAL PAIR: the same product at the same centavo — 10.004 is 10 — claims the line"; the code fold is pinned by "NEAR-MISS: a code is compared EXACTLY — `a1` and `A1 ` are not `A1`".',
  'apps/mercado-livre/lib/marketplace/fixtures/piiScan.ts':
    '`deepEqual` compares a committed wire body against its own re-redaction, so the fold decides "did redaction leave this leaf alone?". Equal: nothing beyond structural identity — same keys, same order-independent key SET, same primitive values, `null` only equal to `null`. Distinct: a redacted placeholder vs the value it replaced (that inequality IS the finding), `null` vs `"REDACTED"`, `0` vs `"0"`, and an array whose length differs. ⚠️ The dangerous direction here is folding too MUCH: a `deepEqual` that coerced types or ignored key order would report a leaked street address as "unchanged" and the corpus would ship it. Near-miss: `piiScan.test.ts` — "CONTROL A (known-bad) — an unredacted body reports every personal leaf" (must differ) paired with "CONTROL B (known-good) — the redacted body is a fixpoint, so it reports nothing" (must not).',
  'apps/shopee/lib/shopee/fixtures/piiScan.ts':
    '`deepEqual` compares a committed Shopee wire body against its own re-redaction, so the fold decides "did redaction leave this leaf alone?" — the Shopee-shaped sibling of the Mercado Livre entry above. Equal: structural identity ONLY — same key SET (order-independent), same primitive values, `null` equal only to `null`. Distinct: a placeholder vs the value it replaced (that inequality IS the finding), `null` vs `"REDACTED"`, `0` vs `"0"`, arrays of different length, and — Shopee-specific — a MASKED value (`"****"`, `P******n`) vs a redacted one, because `redact.ts` keeps masked values verbatim and a fold that treated the two as the same would hide a leak sitting in a masked-looking field. ⚠️ The dangerous direction is folding too MUCH: a `deepEqual` that coerced types or ignored key order would report a leaked street address as "unchanged" and the corpus would ship it. Near-miss: `piiScan.test.ts` — "CONTROLE A (sabidamente ruim) — um corpo NÃO redigido reporta cada folha pessoal" (must differ) paired with "CONTROLE B (sabidamente bom) — o corpo redigido é ponto fixo e não reporta nada" (must not).',
  'apps/mercado-livre/lib/marketplace/size-charts/sizeChartSync.ts':
    '#1799 remoteRowMatches folds the numeric spelling before a unit through localizarDecimal, never Number. Equal: 90.5 cm = 90,5 cm. Distinct: 90,5 != 90,50 and 01 != 1. Picker IDs remain exact, and multivalued length/content must match. Tests: sizeChartSend.test.ts unchanged separator and leading/trailing-zero near-misses.',
  'tools/migrations/src/2026-09-nfe-totais/transform.ts':
    '⚠️ Reached this scan through a COMMENT, not a helper call — and it belongs here anyway, because `totaisIguais` is exactly the hand-rolled fold this guard says it cannot see. It decides whether the NF-e `totais` block on disk is \u201cthe same\u201d as the one just re-parsed from `xml_nfe_proc`, and the answer drives a SKIP: fold too much and the backfill walks past the notes it exists to fix, silently, while reporting a clean run. Equal: field-for-field identity over the keys of `nfeTotaisSchema` (derived from the schema, never a hand list, so a field added later cannot be forgotten), with a missing `rtc` key and a `null` one treated alike \u2014 both mean \u201cnot an RTC note\u201d, and separating them would rewrite every pre-Reforma note on every pass. Distinct: one centavo on any component, a stored block missing `receitaBruta` (the real slice-1 population), and an RTC block against a non-RTC one. Near-miss: \u201c\u26a0\ufe0f NEAR-MISS: um centavo de diferen\u00e7a N\u00c3O \u00e9 igual\u201d, paired with \u201c\u26a0\ufe0f ALCANCE: alterar QUALQUER campo do schema \u00e9 detectado\u201d, which walks the schema shape so the fold cannot quietly stop reaching a field.',
  'apps/web/lib/mercado-livre/chartDedupe.ts':
    '`parseCentesimos` keys the `atribuidos`/`pedidos` sets deciding which measurements duplicate. Equal: `10,5` ≡ `10.50` (ML receives the same `struct.number`, so they WOULD duplicate on its side). Distinct: one hundredth apart — that is the whole offset mechanism. Near-miss: "walks past a value a later row already holds".',
  'apps/web/lib/mercado-livre/chartRows.ts':
    'TWO folds. (1) `prefillSizeEquivalence` matches a size label by `normalizeLoose` — equal: case + diacritics; distinct: EXACT only, never a prefix, or `4` would claim `40`. Near-miss: "never matches a PREFIX or a near-miss". (2) `seedRows` applies `localizarDecimal` as a display transform on `kind === "number"` parts only — near-miss: "does NOT localize a dot in a non-numeric part".',
  'packages/integrations/mercado-livre/src/ai/medidasApply.ts':
    '`normalizeLoose` resolves a model answer onto a grid row and onto a closed-list option (BOTH the scalar and the array path); `localizarDecimal` localises a numeric answer. Equal: case + diacritics, nothing else. Distinct: a sibling one letter away, and a bare PREFIX of an option. Near-miss: "picks the option that matches, not the sibling one letter away" + "refuses a bare PREFIX of an option, keeping it as free text" + "never matches a PREFIX of a standard size" + "does NOT localize a dot in a non-numeric column".',
  'packages/integrations/mercado-livre/src/ai/attributeApply.ts':
    '`normalizeLoose` resolves a model answer onto ML’s option list. Equal: case + diacritics. Distinct: a sibling one letter away, and a bare PREFIX — a same-length pair alone kills a TRUNCATING fold but not a `.startsWith` one, so the test carries both. Near-miss: "picks the option that matches, not a sibling differing by one letter".',
  'packages/integrations/mercado-livre/src/ai/medidasSchema.ts':
    '`normalizeLoose` is the DEDUPE key for row labels — a collision drops a row and sets `truncated`, so it must fold exactly what `applyAiMedidas` resolves with and no more. Near-miss: "keeps two size labels that differ by more than case and accents".',
  'apps/web/lib/chat/searchRegex.ts':
    'Defines the chat regex fold and its mapped-range readers. Equal: canonical accent variants (precomposed or decomposed) in the haystack and in LITERAL pattern text, with case still owned by the regex `i` flag. Distinct: punctuation, whitespace, different base letters and stems; character classes, escapes and named-group identifiers retain exact regex semantics; exact regex matches are retained before folded matches are added. Near-miss: `searchRegex.test.ts` — "matches accents in either direction while preserving regex syntax" plus "preserves character-class ranges instead of folding their source" (`[à-ÿ]` matches `ç`, never `x`/`y`), paired with the thread/global/highlight tests that refuse `acaso`, `a-ção`, `orcamen-to` and `orcamenta`.',
  'apps/web/app/(app)/chat/_hooks/useThreadSearch.ts':
    '`searchRegexMatches` decides which loaded mensagens enter the stable-key navigation list. Equal: canonical accent variants. Distinct: punctuation and different base letters. Near-miss: `useThreadSearch.test.tsx` — "does not fold a different base letter or punctuation into a match".',
  'apps/web/lib/chat/globalSearch.ts':
    '`searchRegexMatches` filters collection-group rows and `firstSearchRegexMatch` locates the snippet window. Equal: canonical accent variants. Distinct: punctuation and different base letters. Near-miss: `globalSearch.test.ts` — "keeps accent-only folding narrower than punctuation and letter changes".',
  'apps/web/lib/chat/highlight.tsx':
    '`findSearchRegexMatches` maps folded matches back to original UTF-16 spans. Equal: canonical accent variants, including decomposed marks. Distinct: punctuation and different base letters. Near-miss: `highlight.test.tsx` — "does not highlight accent-fold near misses"; the paired decomposed test proves the original bytes reconstruct exactly.',
  'apps/shopee/lib/shopee/precos/decisaoPreco.ts':
    'CALLS `mesmoPrecoEmReais(lido.precoAnterior, alvo.precoAlvo)` as gate G5 of the Shopee price push (step 13, #1521): a `true` settles that model `pulado preco-igual` — it leaves the `price_list`, nothing is written to Shopee or to a link, and a crash replay of a landed send reads the same way — so folding too much drops a real price edit behind a green run. The fold is the definer’s, applied verbatim (no pre-rounding, no tolerance of its own). Equal: the same centavo after rounding — `10.004` ≡ `10`. Distinct: one centavo apart — `49.99` ≠ `50` is SENT; a `null` current price (unreadable on Shopee) never equals, so it reaches the decrease guard (`preco-atual-ilegivel`) or, with `baixarPreco`, is sent. The decrease guard and the ratio beside it compare `centavosDeReais`, not the fold. Near-miss: `decisaoPreco.test.ts` — "⚠️ QUASE-IGUAL — atual `49.99` e alvo `50` ficam a UM centavo ⇒ ENVIADO (uma dobra larga demais engoliria a edição)", paired with "⚠️ PAR — atual `10.004` e alvo `10` caem no MESMO centavo ⇒ `pulado preco-igual`, sem corpo"; the null arm is "⚠️ (M30) — preço atual ILEGÍVEL com a guarda ligada ⇒ `pulado preco-atual-ilegivel`, sem corpo".',
  'apps/shopee/lib/shopee/precos/verificacaoPreco.ts':
    'CALLS `mesmoPrecoEmReais(eco, precoAlvo)` to decide whether Shopee CONFIRMED the price we sent (Shopee step 13, #1521): a `true` certifies an accepted `update_price`, a `false` answers `falha preco-nao-atualizado` WITHOUT a link stamp — so folding too much certifies a price Shopee does not show, and folding too little fails a landed write. Equal: exactly the definer\'s reach — the echo (or, under `releitura`, the fresh shelf price) and the target agree after `roundReais`: `"12.5"` (already read `12.5` by the package) ≡ `12.5`, `20.004` ≡ `20`. Distinct: one centavo apart — `12.49` ≠ `12.5`, `12.01` ≠ `12`, and ⚠️ `49.991` ≠ `50` (a `< 0.01` tolerance would equate them); a `null` ECHO price is never compared (counted in `ecosNulos`, never a divergence), while a `null` or absent READ-BACK price IS a divergence (the fold\'s own `null` rule). ⚠️ The file also decides WHICH echo row is compared (seam C-4, `modeloDoEco`): a no-model echo is matched by its ABSENT `model_id` (measured) or the page sample `0` (ruling D-10 — a no-model send carries one entry), and a `null` or `0` echo on a has-model send is matched to no sent model. Near-miss: `verificacaoPreco.test.ts` — "NEAR-MISS: UM centavo de diferença é DIVERGENTE — 12.49 vs 12.5, e 49.991 vs 50 (0.009 apart, que uma tolerância < 0.01 igualaria)" and "NEAR-MISS: a read-back ONE centavo off diverges (12.49 vs 12.5), even beside an echo that agrees", paired with "EQUAL PAIR: o eco igual confirma — 12.5 enviado vs o eco "12.5" (já lido 12.5 pelo pacote), e 20 vs 20.004 pela dobra em reais"; the row matcher is pinned by "EQUAL PAIR (C-4): o eco SEM `model_id` de um item SEM modelo é o eco do `0` enviado — igual confirma, diferente DIVERGE (prova que casou)" against "NEAR-MISS (C-4): um eco SEM `model_id` quando DOIS modelos foram enviados não casa com NENHUM — nunca adivinhado, mesmo com um preço que divergiria".',
  'apps/shopee/lib/shopee/produtos/mapeamento.ts':
    'CALLS `mesmoPrecoEmReais(v, primeiro)` in `planejarPrecoDaFamilia`, the Shopee IMPORT’s family price rule (step 9 under Lucas’s 2026-09-28 decisions, #1521), which runs ONLY when the import FORMS the family — it CREATES the parent (under `importarPreco`), or the parent is an existing produto with no children yet, the create-race arm’s unlinked document included (under both price options) — while a re-import of a parent that already has children writes it neither a price nor the flag: every model of a has-model listing is compared against the FIRST, and "all the same in reais" makes the PARENT take that price with `propagatePriceToChildren: true`, while anything else writes `false` and leaves each child its own. The fold is the definer’s, applied verbatim, so a family this rule calls one-priced is one the price sync would call already in sync. Folding too much writes ONE price over models Shopee prices apart, and the first sync then REPRICES every model whose price differs from the first; folding too little only turns propagation off (each child keeps its own, still correct). Equal: the same centavo after rounding — `10` ≡ `10.004` (the parent takes the FIRST model’s raw `valor`). Distinct: one centavo apart — `10.00` ≠ `10.01`; a model with no usable BRL price never equals anything — beside priced ones it turns propagation off (never borrows its siblings’ price), and with none priced no flag is written at all. Near-miss: `precoDaFamilia.test.ts` — "⚠️ QUASE-IGUAL — `10.00` e `10.01` ficam a UM centavo ⇒ preços DIFERENTES: pai sem preço, propagação DESLIGADA", paired with "⚠️ PAR — `10` e `10.004` caem no MESMO centavo ⇒ um preço só: o pai leva o do PRIMEIRO model e propaga"; the whole-path consequence is pinned by the round-trip rows "CRIAÇÃO, família PAR na dobra" / "CRIAÇÃO, família QUASE-IGUAL na dobra" (import, then the sync’s `precificarItem` and the publish’s `prepararPublicacao` give every model its own shelf price).',

  'apps/shopee/lib/shopee/produtos/kitShopee.ts':
    'CALLS `chaveReceitaKitErp` for step 9\'s KIT import, in its step-19 R-t decision (#1527, Lucas L10(2)): per kit child, `decidirReceitaDoFilho` compares the fingerprint of Shopee\'s resolved recipe (summed by `componentesKitDaReceitaShopee`) with that of the child\'s STORED `componentesKit`, and then each counted row\'s `receitaKitConferida` (its rows on every ACTIVE native-kit link of the kit for the conta) with the stored one. Shopee equal ⇒ the import proceeds and PRE-STAMPS, so the aviso resolves `importado`; different with any counted stamp ≠ the current one ⇒ the ERP map is KEPT, nothing is stamped and `receita-divergente` is reported; otherwise Shopee\'s recipe wins. Folding too much makes a real ERP edit read as "Shopee already holds it": the import stamps a recipe it never verified, the aviso closes, and Shopee keeps deriving the kit\'s stock from the OLD recipe; folding too little only keeps an edit and leaves the aviso open (the safe direction). The fold is the definer\'s, applied verbatim. Equal: key order, `limitarEstoque`, the entry `timestamp` (the import\'s own stamp carry-forward never reaches it), passthrough extras — and a #1450 repoint once Shopee\'s component resolves to the same member. Distinct: any `quantidade` (1 vs 3), a component added, removed or renamed; a `null` stamp never equals a fingerprint. The CONTENT is compared before any stamp. Near-miss: `kitShopee.test.ts` — "⛔ NEAR-MISS: um carimbo igual à receita da SHOPEE (não à atual) ainda é edição pendente" and "(M49) aviso aberto + re-import ⇒ o mapa do ERP fica, o aviso continua ABERTO e o import diz `receita-divergente`", paired with "PAR IGUAL: o conteúdo decide primeiro — receitas iguais são `igual` MESMO com carimbos velhos" and "(M59) decide pelo CONTEÚDO: um repoint #1450 abriu o aviso, e o re-import que já lê o membro pré-carimba e fecha `importado`". ⚠️ Two more decisions ride that fingerprint (the step-19 review fixes). (R1-RT7-01) A família de um ALSO compares the WRAPPER K\'s stored fingerprint (`chaveDoPaiDaFamiliaDeUm`): K ≠ its member means K holds an edit the unretried sole-member mirror has not delivered, so Shopee is `igual` only when it folds to K\'s, else the child is KEPT whatever the stamps say. Near-miss: "só K editado (3×A), a Shopee e o membro em 2×A ⇒ K NÃO é revertido, nada é carimbado e o import diz `receita-divergente`" paired with "⛔ NEAR-MISS: só K editado (3×A) e a Shopee JÁ em 3×A ⇒ `igual` — o import completa o espelho e carimba 3" and "⛔ NEAR-MISS: K e o membro IGUAIS (espelho em dia) ⇒ a regra de sempre — a Shopee vence sem nada pendente". (R2-F2) The produto-level fingerprint is coarser than the address fold, so the import stamps only when `receitaFielAosEnderecos` holds, which CALLS `mesmoEnderecoDeComponente` (literal) to ask whether the component rows that resolved to ONE produto share ONE address. Equal: the same (item, model) on two rows (the address fold sums them). Distinct: another item, or another model of the same item, onto one produto ⇒ the map is still written but the stamp is CLEARED and the aviso opens. Near-miss: "⛔ NEAR-MISS: DOIS endereços no MESMO produto (A ×2 + B ×3) ⇒ o MESMO {comp-a: 5}, mas o carimbo é LIMPO e o aviso ABRE" paired with "PAR IGUAL: UM endereço (A ×5) ⇒ {comp-a: 5}, carimbado e o aviso resolvido", plus the pure pair under "receitaFielAosEnderecos (R2-F2)". Also CALLS `modeloDoComponenteKit` (OP-4) to turn each wire `component_model_id` into the model the component cascade is ASKED for (`?? 0`), with the component item\'s `has_model`. Equal: Shopee\'s hidden default id on a plain item ≡ no model (the listing rung binds). Distinct: model A vs B of an item with variations; an item whose `has_model` is UNKNOWN keeps its wire id VERBATIM (never folded to 0). Near-miss: "(M42) has_model false ⇒ o componente B liga pelo `prodshopee`, e o kit NÃO é recusado" paired with "⛔ NEAR-MISS: sem o has_model (o caminho de hoje) o MESMO kit é recusado — o id oculto não liga" and "(M43) ⛔ um item AUSENTE do mapa é desconhecido: o id oculto vai VERBATIM e cai nos degraus de SKU".',
  'apps/shopee/lib/shopee/produtos/temModelosDosComponentes.ts':
    'Comment only — the module docblock names `modeloDoComponenteKit` to say this reader only READS `has_model` and the schemas rule turns `(modelId, has_model)` into the model bound (step 19, #1527, R-d, OP-4). It compares nothing; what it decides is the rule\'s INPUT: which ids read as UNKNOWN (absent from the map, never `false`), so the rule keeps their wire id verbatim instead of folding Shopee\'s hidden default id away on no evidence. Near-miss: `temModelosDosComponentes.test.ts` — "(M43) ⛔ uma linha AUSENTE fica FORA do mapa — desconhecido, nunca false" paired with "⚠️ NEAR-MISS: has_model false EXPLÍCITO entra no mapa como false (não é ausência)"; the batch verdict is pinned by "(R6-M11) ⛔ o MESMO código num erro TRANSITÓRIO (um 5xx) SOBE — só o kind `other` é o veredito do lote".',
  'packages/data/src/admin/avisos/receitaKitShopee.ts':
    'CALLS `chaveReceitaKitErp(<child\'s CURRENT componentesKit>)` in `reavaliarAvisoDeReceitaKit`, the ONE IO twin of the Shopee native-kit recipe aviso decision (step 19, #1527, R-4): each bound kit-model row\'s `receitaKitConferida` is compared by plain equality with its child\'s current fingerprint, and ONE unequal row OPENS the (conta, kit) aviso while all-equal RESOLVES it. Folding too much resolves an aviso over a kit Shopee still sells with the old recipe (its stock wrong, silently); folding too little only keeps it open. The fold is the definer\'s, applied verbatim to the stored value (a non-map reads as `null`). Equal: whatever `chaveReceitaKitErp` folds — key order, `limitarEstoque`, the entry `timestamp`, passthrough extras. Distinct: any `quantidade` change; a key added, removed or renamed; a `null` or non-string stamp is DIVERGENT. Near-miss: `apps/shopee/lib/shopee/produtos/reavaliarAvisoReceitaKit.test.ts` — "M54: um salvamento do filho ENTRE o recarimbo e a reavaliação mantém o aviso ABERTO — ela relê a receita" and "um carimbo NULL é divergente — uma linha nova que não dobrou igual abre".',
  'packages/schemas/src/produto/collection/shopeeLink.ts':
    'Comment only — the writer inventory names `chaveReceitaKitErp` to state the ONE rule every `receitaKitConferida` writer follows (step 19, #1527, R-4): stamp the fingerprint of the ERP recipe a READ-BACK of Shopee\'s live kit just folded EQUAL to. The file compares nothing; the fold\'s scope is the definer\'s (`packages/schemas/src/receitaKitShopee.ts`, pinned by `receitaKitShopee.test.ts` §fingerprint) and each writer\'s own row says what it treats as equal — step 9\'s kit import (`apps/shopee/lib/shopee/produtos/kitShopee.ts`, near-miss "⛔ NEAR-MISS: um carimbo igual à receita da SHOPEE (não à atual) ainda é edição pendente") and the kit completion after a create (`apps/shopee/lib/shopee/kits/aplicarKit.ts`, near-miss "(M91) EQUAL pair stamped — the hidden B id folds equal to \\"no model\\" — and a QUANTITY near-miss is NOT stamped").',
  // ---- Step 19 PR 5 (#1527), the native-kit core `apps/shopee/lib/shopee/kits/` ----
  'apps/shopee/lib/shopee/kits/aplicarKit.ts':
    "CALLS `mesmaReceitaKitShopee(<the plan's projection of a child>, <its kit model's READ-BACK rows>, <has_model>)` as the stamp gate of the native-kit completion (step 19, #1527, R-4): EQUAL ⇒ the child's row gets `receitaKitConferida = chaveReceitaArmazenadaDoFilho(<the child's STORED componentesKit>)` — the UNPARSED map every reader folds (`reavaliarAvisoDeReceitaKit`, the trigger, step 9's import), never the parsed one, or an entry stored WITHOUT `quantidade` stamps a fingerprint no reader computes and the aviso opens after a verified create (R1-RT7-02 / R3-03); DISTINCT ⇒ a `null` stamp (an existing row keeps its old one, R-4) and the warning `receita-divergente`, so the shared aviso decision OPENS. Folding too much stamps a recipe Shopee does not hold — a create Shopee half-applied (a 200 proves nothing, P2-c) would close the aviso while Shopee derives the kit's stock from another recipe; folding too little only leaves the aviso open (the safe direction). It also CALLS `opcaoDoTierKit` on BOTH sides of the resume binding's option pass (R2-F1): a child binds the live model whose tier option equals the option the create SENT for it. Equal: `'Azul '` ≡ `'Azul'` ≡ `' Azul'` (trim). Distinct: case (`'azul'` ≢ `'Azul'`); a lone child takes a single free model only as a família de um or when its live option is the `'Padrão'` sentinel — never one whose option names another variante (R3-01). And it CALLS `mesmoEnderecoDeComponente` to map the RESOLVED `--principal` back to a component produtoId for the `incerto` re-run command only when the operator's TYPED id is absent (OP-8: the typed id wins) — any id resolving to that one address names the same principal, so the lexically-first is printed. The folds are the definers', applied verbatim, and BOTH sides of the recipe fold read ONE `has_model` authority (the context's, filled by the read-back's). Equal: row order, duplicate addresses summed, a plain component's HIDDEN model id vs no model when its item has no variations, the main flag. Distinct: a quantity, a component added or removed, model A vs B of a varied item, and a hidden id whose item's `has_model` is UNKNOWN (compared literally). Near-miss: `aplicarKit.test.ts` — \"(M91) EQUAL pair stamped — the hidden B id folds equal to \\\"no model\\\" — and a QUANTITY near-miss is NOT stamped\", \"the REAL probe kit (one model, B’s hidden id) folds EQUAL for a família de um and stamps the member\" (its has_model-UNKNOWN half stamps nothing), \"(R1-RT7-02 / R3-03) a stored entry WITHOUT quantidade: the stamp is the STORED fingerprint, so the aviso decision resolves after a verified create\", \"(R2-F1) the option pass compares through the SENT fold: a padded variante binds the trimmed live option (EQUAL); a case-different one does not (near-miss)\" and \"(R3-01) a lone NON-família child binds the 'Padrão' sentinel model the create sent for it; near-miss: a lone child never takes a model whose option names another variante\".",
  'apps/shopee/lib/shopee/kits/componentesKit.ts':
    'CALLS `modeloDoComponenteKit({ modelId: <the ERP row\'s stored model>, itemTemModelos: <has_model> })` in `resolucaoFinal` to decide the model the native-kit create and republish SEND for each ERP component (step 19, #1527, R-d, OP-4). Its output becomes `endereco.modelId`, which feeds the projection\'s address sums (`componentesShopeeDoKit`), the principal comparisons and `mesmaReceitaKitShopee`. Folding too much (a varied item read as plain) sends NO model for an item with variations and merges its models into one address; folding too little sends Shopee\'s hidden default id on a plain item, which is meaningless on a request. The fold is the definer\'s, applied verbatim. Equal: a plain item sends no model even over a stale stored hidden id. Distinct: the same row on an item that HAS variations keeps its model; a `0` row on an item with variations is no model ⇒ `componente-sem-modelo`. Near-miss: `componentesKit.test.ts` — "⛔ NEAR-MISS: the same row on an item that HAS variations keeps its model" paired with "PAR IGUAL: a plain item sends NO model even when a stale row stores the hidden id", plus "a `model_id: 0` row on an item with variations is no model ⇒ componente-sem-modelo".',
  'apps/shopee/lib/shopee/kits/vinculosKit.ts':
    "Comment only — the docblock names `chaveReceitaKitErp` and `mesmaReceitaKitShopee` to say the `receitaKitConferida` it writes is the CALLER's decision (step 19, #1527, R-4): this writer stores the value handed to it, writes nothing on an existing row handed `null`, and compares nothing. The fold's scope is the definer's (`packages/schemas/src/receitaKitShopee.ts`) and the deciding row is `apps/shopee/lib/shopee/kits/aplicarKit.ts`'s. Pinned by `vinculosKit.test.ts` — \"near-miss: an existing row with a DISTINCT read-back (null stamp) is left untouched — the old stamp stays\".",
  'apps/shopee/lib/shopee/kits/localizarKitPorSku.ts':
    'CALLS `skuDoItemShopee(base) === sku` as the identity of the L6 same-SKU kit scan (step 19, #1527, R-14): a hit REFUSES the create (`kit-ja-existe-na-shopee`, "importe-o"), so folding too little lets a create mint a SECOND kit with the SKU step 9\'s import keys on, and folding too much refuses a create over an unrelated listing. The fold is the definer\'s (`apps/shopee/lib/shopee/produtos/resolveProduto.ts`, step 9\'s parent-SKU rung), so the scan finds exactly the kits the import would land on K. Equal: leading/trailing whitespace only (`\' KIT-1 \'` hits `KIT-1`). Distinct: case and inner whitespace; an absent `item_sku` is never a hit. Near-miss: `localizarKitPorSku.test.ts` — "⛔ NEAR-MISS: case, inner whitespace and an absent item_sku are NOT hits" (under "the SKU fold is step 9\'s parent rung (M80)").',
  'apps/shopee/lib/shopee/kits/planoKit.ts':
    "DEFINES three of the kit arms' folds and calls two more (step 19, #1527). (1) `chaveReceitaArmazenadaDoFilho` = `chaveReceitaKitErp(<the child's STORED map>)` (via `mapaDeKitArmazenado`, the tolerant UNPARSED reader; the parsed map only when no stored one was carried) — the fingerprint every reader folds, so the completion's stamp and the família de um's mirror check compare like with like (R1-RT7-02 / R3-03). The mirror check (R-8) compares K's STORED map against the member's STORED map: DISTINCT ⇒ the member's recipe is sent and the warning `receita-espelho-divergente` is raised; it decides nothing else, so folding too much only hides that warning. Equal: key order, `limitarEstoque`, the entry `timestamp`, passthrough extras. Distinct: any quantity, a key added, removed or renamed; an entry stored WITHOUT `quantidade` ≢ one stored with `quantidade: 1` (the readers fold the raw value). (2) `opcaoDoTierKit` — the ONE variante → tier option text the create SENDS (`planejarTier`, `combinacao-duplicada`) and every binder compares with (R2-F1, #1369). Equal: surrounding whitespace (`' Azul '` ≡ `'Azul'`). Distinct: case (`'azul'` ≢ `'Azul'`), inner text; blank ⇒ `null` (no option). Folding too much merges two children onto one option (`combinacao-duplicada`, a refused create); folding too little leaves a resumed child unbound. (3) `situacaoDoSkuDoKit` CALLS `skuDoItemShopee({ item_sku: <K's stored SKU> })` (R2-F3): K's SKU must be a FIXED POINT of step 9's rung-2 fold, and every SKU guard asks it — phase A `kit-sem-sku` / `kit-sku-com-espacos`, `skuEnviavel`, the republish's `sku-do-kit-nao-enviado`, prepararKit's rung-2 read. Equal: a trim-clean SKU (`'KIT-1'`, `'KIT  1'`, `'kit-1'` are each `ok`). Distinct: a padded SKU (`com-espacos`), a blank one (`sem-sku`). It also CALLS `mesmoEnderecoDeComponente` to name the principal's component in the `principal-invalido` sentence — display only. Near-miss: `planoKit.test.ts` — \"M94 (escopo) — ordem das chaves e limitarEstoque NÃO divergem; uma chave a mais diverge\", \"M94 (escopo armazenado) — K e o membro guardados SEM quantidade são o MESMO espelho; quantidade 2 em K diverge\", \"a impressão gravada é a do mapa ARMAZENADO: sem quantidade ≢ quantidade 1 (o que os leitores dobram)\", \"opcaoDoTierKit: aparada e com a caixa — par IGUAL e quase-par DISTINTO\", \"situacaoDoSkuDoKit (R2-F3): o SKU é um ponto fixo da dobra do degrau 2 — pares IGUAIS e quase-pares DISTINTOS\" and \"(R2-F3) cada guarda de SKU PERGUNTA à dobra do degrau 2: alargada (espaços internos), a fase A recusa, a republicação avisa e o corpo não manda o SKU\".",
  'apps/shopee/lib/shopee/kits/prepararKit.ts':
    "CALLS `principalDoKitShopee(<the live kit's model rows>, <has_model>)` to READ BACK the kit's main component on `kit-atualizar` (step 19, #1527, L1: a republish never takes a `--principal`, it reads Shopee's), which then picks the kit-limits category and is what `principal-diferente` compares. The fold is the definer's, applied verbatim. Equal: the same address flagged on several models is ONE main; a plain component's hidden model id folds to no model when its item has no variations. Distinct: two DIFFERENT flagged addresses read as no main at all (`null`, never a pick). Also CALLS `situacaoDoSkuDoKit` (`planoKit.ts`'s row) to skip the rung-2 root read for a SKU phase A refuses anyway (R2-F3) — it decides no sameness here — and carries each child's STORED map (`mapaDeKitArmazenado`) as `componentesKitArmazenado`, the input of `chaveReceitaArmazenadaDoFilho` (R1-RT7-02). Near-miss: `prepararKit.test.ts` — \"lê o kit VIVO e o principal VOLTA da Shopee (L1); o --principal pedido fica para comparar\" and \"(OP-8 / OP-9 / R1-RT7-02) the context carries the RAW --principal, the --status, and each child’s STORED recipe beside the parsed one\"; the scope table itself is `receitaKitShopee.test.ts`'s.",
  'apps/shopee/lib/shopee/kits/resultadoKit.ts':
    "Comment only — the `ContextoKit.principal` docblock names `principalDoKitShopee` to say where a republish's principal comes from (step 19, #1527, L1), and the `FilhoDoKit.componentesKitArmazenado` docblock names `chaveReceitaArmazenadaDoFilho` to say the stamp is computed from that stored map (R1-RT7-02). The file holds types and one pure command renderer, and compares nothing; the call sites are `apps/shopee/lib/shopee/kits/prepararKit.ts`'s and `planoKit.ts`'s rows.",
  'apps/shopee/lib/shopee/kits/republicarKit.ts':
    "CALLS `mesmaReceitaKitShopee(<the plan's projection of a BOUND child>, <its LIVE kit model's rows, read before the update>, <has_model>)` in the native-kit REPUBLISH (step 19, #1527, §2.6, L4(3)) to raise the warning `receita-divergente` — never a refusal, and never a stamp: the update resends the LIVE rows verbatim (Shopee silently ignores a recipe change, P2-c), and the stamp is decided afterwards on the READ-BACK by `aplicarKit.ts`'s completion (its own row). So this fold decides ONLY a warning: folding too much hides an ERP recipe edit from the operator's answer (the aviso still opens from the unchanged stamp); folding too little tells the operator to `--recriar` a kit that already matches. A child whose recipe cannot reach Shopee at all (a recipe row of the plan) is never compared — it warns `receita-nao-publicavel` instead. Also CALLS `mesmoEnderecoDeComponente(<the --principal resolved>, <the live main>)` for the warning `principal-diferente` (L1: the main is frozen, a republish never applies a principal), and to label an address with its ERP component in that sentence (display only). Both folds are the definer's, applied verbatim, over ONE `has_model` authority (the context's). Equal: row order, duplicate addresses summed, a plain component's HIDDEN model id vs no model when its item has no variations, the main flag (moved or not); for the principal, the same (item, model). Distinct: a quantity (2 vs 3), a component added or removed, model A vs B of a varied item; for the principal, another component. Near-miss: `republicarKit.test.ts` — \"(M102, M103) uma quantidade mudou no ERP ⇒ AVISO receita-divergente, o update SAI com a quantidade VIVA, e a linha NÃO é recarimbada — o aviso segue ABERTO\", paired with \"liga cada modelo vivo pela LINHA, zero anexados, nenhuma linha nova; reenvia os componentes VIVOS — o id oculto de B incluso (M101)\" (the hidden-id EQUAL pair: no warning); the principal by \"(M109) um --principal que NÃO é o principal vivo ⇒ AVISO principal-diferente e o update SAI; ⚠️ near-miss: nomear o próprio principal vivo não avisa\". Also CALLS `opcaoDoTierKit` (`planoKit.ts`'s definer) for an APPENDED child's tier option, the live options already used and the tier's readability: two new children whose variantes fold to ONE option append only the first (the second warns `variacao-nao-anexada`), so folding too much drops a real variation and folding too little sends a tier that repeats an option. Equal: surrounding whitespace (`'Roxo'` ≡ `' Roxo '`). Distinct: case (`'Roxo'` ≢ `'roxo'`). Near-miss: \"(R6-M04) dois filhos NOVOS cujas variantes dobram ao MESMO texto ('Roxo' ≡ ' Roxo ') ⇒ só o primeiro é anexado, o segundo variacao-nao-anexada (semOpcao), e o tier nunca repete uma opção\" paired with \"⚠️ NEAR-MISS (R6-M04): 'Roxo' vs 'roxo' — a dobra mantém a CAIXA ⇒ os DOIS são anexados, em [2] e [3], nenhum aviso\".",
  // ---- The helpers themselves --------------------------------------------
  'packages/schemas/src/produto/pureLogic/familia.ts':
    'DEFINES the pair. `skuDoMembroUnico` derives a sole member sku as `<paiSku>-UN`; `skuPaiDoMembroUnico` is its inverse. The fold that matters is the MIRROR one: `planejarSincronizacaoDoMembroUnico` compares a stored member sku against `skuDoMembroUnico(paiAntes.sku)`, and a mismatch reads as "the operator diverged this field" — permanent, so an over-eager fold silently stops `sku` propagating for ever. Equal: leading/trailing whitespace on the parent value, since both sides trim; exactly one trailing suffix on the inverse. Distinct: `CAM-UNI` vs `CAM-UN`, and a base whose own code ends in `-UN` (parent `PARAFUSO-UN` gives member `PARAFUSO-UN-UN`, and the inverse gives `PARAFUSO-UN` — ONE suffix, never two). The inverse is genuinely AMBIGUOUS for a legacy member stored before the derivation existed, and the test pins that as a known limitation rather than hiding it. Near-miss: "strips at most one suffix" plus "leaves a sku that carries no suffix alone", and the ambiguity itself is pinned by "cannot tell a legacy member from a derived one when the parent sku ends in the suffix".',
  'packages/data/src/admin/produtos/resolveProdutoPorSku.ts':
    '⚠️ Re-pointed by #1513: this is the SKU stage promoted out of `apps/mercado-livre/lib/marketplace/pedidos/orderProdutoResolve.ts`, so Shopee ends on the same rungs instead of a second copy — the ML file no longer names the helper and its entry moved here with the fold. Uses the INVERSE to ask whether the marketplace `seller_sku` is a sole member one. The fold alone is NOT the decision: stripping also matches a variation child of a familia de MUITOS, because `cartesianVariations` builds `parentSku + codigo` and a codigo of `-UN` produces the identical string — binding its parent would move stock on a produto that owns no estoque rows. The rung is gated on `ehFamiliaDeUm`, i.e. on `filhoUnicoId`; the fold only proposes a candidate. Equal: a sole member sku and its parent one, for a root that really is a familia de um. Distinct: a variation child of a familia de muitos whose codigo is `-UN`, and a root that OWNS a sku ending in the suffix (the unstripped rung above matches it first). Near-miss: `resolveProdutoPorSku.test.ts` — "⛔ NEAR-MISS: NÃO vincula o pai quando o sku é de uma variação de uma família de MUITOS", with the same near-miss still pinned unedited on the ML side by `orderProdutoResolve.test.ts` — "does NOT bind the parent when the sku belongs to a variation of a familia de MUITOS".',
  'apps/mercado-livre/lib/marketplace/importacao/import.ts':
    'Uses the INVERSE for rung 3 of the User-Products parent-sku cascade, and deliberately does not trust it alone: `skuPaiDeMembroUnicoExistente` strips only when a root produto really carries the stripped value, because rung 3 mostly serves familias this app never published. Equal: a member sku derived from an existing root. Distinct: a seller code that merely ends in `-UN`, where blind stripping mints a SECOND parent produto on re-import. Near-miss: "rung 3 — keeps a seller code that merely ENDS in the suffix".',
  'apps/web/app/(app)/despacho/checkout/_components/resolveScan.ts':
    'Uses the INVERSE to index a familia-de-um member under the sku printed on the box, which is the parent one. Gated on `paiId`, never on the sku shape: a ROOT whose own code ends in `-UN` would otherwise claim the stripped code, and scanning some OTHER produto sku would check off this line. Equal: a member derived sku and its parent one. Distinct: an own-sku match always wins, via two passes and last-wins. Near-miss: "registers no parent form for a ROOT whose own sku ends in the suffix".',
  'apps/web/app/(app)/produtos/_components/VariationManager.tsx':
    'Uses the DERIVE only, to stage the promoted survivor sku when the last variation is deleted and that row becomes the sole member. Not a comparison — it produces the value written, and the document takes the same value from the `espelhoDoPai` spread.',
  'packages/core/src/decimal/index.ts':
    'Defines `localizarDecimal` / `parseDecimalPtBr` / `parseCentesimos`. Own tests carry both directions, incl. the ambiguous forms each REFUSES to fold (`1.234,5`, three decimals).',
  'packages/schemas/src/produto/pureLogic/precoCalculo.ts':
    'DEFINES `mesmoPrecoEmReais(atual, alvo)`, the skip-if-equal fold of SHOPEE’s price sync (step 13, #1521) — not of every channel that sends a price: Mercado Livre’s price sender keeps its own equivalent copy in `apps/mercado-livre/lib/marketplace/preco/precoDraftSend.ts` — `priceFieldMatches` (`roundReais(raw) === preco`, behind its gate-2 variations skip and its gate-7 verifier), plus the single-price gate 2’s `currentListingPrice(item) === draft.preco` — equivalent today only because ML’s target is already rounded by `precoDaTabela`. That file does not name this helper, so a change to this fold’s reach does NOT move ML’s; routing ML through the helper is a follow-up, and would earn it a line here. A `true` means "the marketplace already shows this price" and the send is SKIPPED, so folding too much drops a real price edit behind a green run. Equal: two numbers whose `roundReais` agree — `10.004` ≡ `10`, `0.1 + 0.2` ≡ `0.3`, `49.999` ≡ `50`, `24.015` ≡ `24.02` (the rounding reads the double, so the up-lean counts). Distinct: anything one centavo apart after rounding — `49.99` ≠ `50`, `11.10` ≠ `11.11`, `24.015` ≠ `24.01`, and ⚠️ `49.991` ≠ `50`, which a `< 0.01` tolerance would equate (0.009 apart, different centavos); a `null` current price never equals anything. `roundReais` itself does NOT join the pattern (≈46 importers, the rejected band), and neither does `precoDaTabela` defined beside it — a transform (reads + rounds), not an equality. Near-miss: `precoCalculo.test.ts` — "NEAR-MISS: 49.991 ≠ 50 — 0.009 apart, yet different centavos (a `< 0.01` tolerance would equate them)" and "NEAR-MISS: one centavo apart stays DISTINCT — 49.99 ≠ 50, 11.10 ≠ 11.11", paired with "EQUAL pair: 10.004 ≡ 10 and 0.1 + 0.2 ≡ 0.3 (float residue is not an edit)" and "EQUAL pair across a rounding UP: 49.999 ≡ 50 and 10.006 ≡ 10.01 (a truncating fold would split them)".',
  'packages/ai/src/text.ts':
    'Defines `normalizeLoose` (trim, pt-BR lowercase, NFD, strip diacritics). The one place the fold’s exact reach is specified.',
  'packages/schemas/src/receitaKitShopee.ts':
    'DEFINES the Shopee native-kit recipe folds (step 19, #1527) — the ONE module the create, the republish, the recriar, the step-9 import and the recipe trigger call (#1369), with the EQUAL/DISTINCT tables in its docblocks. Three scopes, kept apart on purpose. (1) `mesmaReceitaKitShopee(erp, shopee, temModelosPorItem)` is the per-MODEL recipe fold: a `true` re-stamps the kit row’s fingerprint and lets the L4 aviso resolve, so folding too much hides a recipe Shopee does not hold while Shopee derives the kit’s stock from it. Equal: a plain component (ERP side absent model) vs Shopee’s hidden non-zero default `component_model_id` when the item has NO variations; row order; duplicate keys SUMMED (2 + 3 ≡ 5); `main_component` and every display field. Distinct: quantity (2 vs 3); a component added or removed; model A vs model B of an item WITH variations; a `null` model vs a model on an item that HAS variations (a resolution hole, never a plain item); an item whose `has_model` is unknown compares its model ids literally. (2) `principalDoKitShopee` / `mesmoEnderecoDeComponente` read the kit-level MAIN, outside fold (1) so "main moved" and "quantity changed" stay distinguishable; the main is folded by the same default-model rule, and two components or model A vs B stay distinct. (3) `chaveReceitaKitErp` is an ERP-side FINGERPRINT compared by plain equality with the stored stamp. Equal: key order, `limitarEstoque`, `timestamp`, passthrough extras; `null` ≡ `{}`; and every `quantidade` that is not a positive safe int, which reads `null` — `0` ≡ `-1` ≡ absent, `1.5` ≡ `2.5` (legacy rows only: `kitSchema` is `int().min(1)`, so no writer stores one, and an edit between two such values is accepted as no change). Distinct: any change of a valid `quantidade`, and a valid one vs a malformed one (`1` vs `0`); a key added, removed or renamed (a #1450 repoint included — accepted: a republish that reads Shopee equal re-stamps it); `{p1: 12}` vs `{p11: 2}` (no separator collision). Near-miss: `receitaKitShopee.test.ts` §fold (M12 quantity, M13 reorder, M14 summed duplicate, M15 the hidden id on a plain item, M16 a `null` model on an item with variations, M17 the main moved) and §fingerprint (M18 the `limitarEstoque`/`timestamp` equal pair, M19 `{p1: 12}` vs `{p11: 2}`, and the malformed-quantidade fold: "EQUAL pair (legacy-only fold): 0 ≡ -1 and 1.5 ≡ 2.5 — every malformed quantidade reads null" paired with "NEAR-MISS of the legacy-only fold: a VALID quantidade never folds with a malformed one"). (4) `modeloDoComponenteKit` DEFINES the default-model rule underneath (1) and (2) and the create\'s address (OP-4). Equal: `has_model` false ⇒ `null` whatever the wire id (Shopee\'s hidden default); `has_model` true with a non-usable id (0, negative, fractional, absent) ⇒ `null`. Distinct: `has_model` true keeps a positive id (model A vs B stay apart); `has_model` UNKNOWN keeps the id VERBATIM — `0` stays `0`, a hidden id stays itself, never a guess. Near-miss: "(M3) has_model UNKNOWN ⇒ the model id VERBATIM, never a guess" paired with "(M1) has_model false ⇒ null: the plain B hidden id is meaningless" and "(M4) has_model true + a non-usable id (0, negative, fractional, absent) ⇒ null".',
  'apps/shopee/lib/shopee/produtos/resolveProduto.ts':
    "DEFINES `skuDoItemShopee(base)` = `(item_sku ?? '').trim()`, the fold of step 9's PARENT-SKU rung (rung 2: `produtos where sku == … and paiId == null`, accepted on EXACTLY one), which calls it — exported so step 19's same-SKU kit scan (`localizarKitsPorSku`) and its `kit-sku-repetido` refusal key on the SAME string the import does (#1527, R-14): an unlinked created kit must be re-imported onto the produto that created it. Folding too much would make the scan call two different kits the same and refuse a create; folding too little would let a create pass a SKU the import then matches to ANOTHER produto (or mints one). Equal: leading and trailing whitespace (`' KIT-1 '` ≡ `'KIT-1'`); `null`/absent ≡ `''` (no SKU — the rung is skipped). Distinct: case (`kit-1` vs `KIT-1` — the rung's `where` is case-sensitive) and inner whitespace (`KIT 1` vs `KIT1`). Near-miss: `resolveProduto.test.ts` — \"⛔ NEAR-MISS: caixa e espaço INTERNO continuam distintos (o `where` é sensível)\", paired with \"PAR IGUAL: espaços nas pontas caem; null/ausente ≡ vazio\".",
  'packages/data/src/pipeline-queries.ts':
    'Defines `sanitizeSearchDsl`, which turns operator input into a Firestore search-DSL string — so it decides which two terms issue the SAME text query. Equal: the DSL operator characters (`" ( ) + : ~ ^ * ? -`) collapsed to spaces, runs of whitespace collapsed, ends trimmed — `Porta-lápis` ≡ `Porta lápis`, because a raw `-` NEGATES and would ask for "Porta but NOT lápis" and return nothing with no error. Distinct: singular vs plural (`Camiseta` / `Camisetas`), accented vs unaccented (`Leão` / `Leao`), and case — all three are the pt-BR ANALYZER’s business at query time, and folding them here would replace a measured, partial backend behaviour with a total one (accent folding was measured INCONSISTENT: `Leao` reaches `Leão`, `Ceramica` does not reach `Cerâmica`). Also distinct from a match: a term of pure operators returns `undefined`, never the empty DSL string. Near-miss: `pipeline-queries.test.ts` — "folds a term whose operators the DSL would have read as syntax" paired with "keeps NEAR-MISSES distinct — the analyzer relates them, not this".',
  'packages/ui/src/table/TableView.tsx':
    'The SOLE caller of `sanitizeSearchDsl`, applied to whatever `search.toTextQuery` returns before it becomes a `textSearch` stage. Sanitising lives here rather than in each page deliberately: a caller that forgot would get a silently empty widened result instead of an error. Not itself a comparison — it produces the query string, and the fold’s reach is specified where it is defined. Near-miss: `TableView.test.tsx` — "sanitises the term, so a DSL operator is not read as syntax" plus "issues nothing when the term sanitises away entirely".',

  // ---- Not a comparison ---------------------------------------------------
  'apps/web/app/(app)/medidas/_components/SizeChartGrid.tsx':
    'Uses `localizarDecimal` as an INPUT transform on a numeric cell (typed `10.5` becomes `10,5`), never to compare. Nothing decides sameness here.',
  'packages/ai/src/index.ts': 'Barrel re-export of `normalizeLoose`. No fold.',
  'packages/data/src/index.ts': 'Barrel re-export of `sanitizeSearchDsl`. No fold.',
  'apps/web/app/(app)/produtos/page.tsx':
    'Comment only — `produtoSearch.toTextQuery` returns the RAW term and its docblock names `sanitizeSearchDsl` to say why it must not pre-quote (quoting neutralises the DSL operators but also suppresses the pt-BR analyzer, so `Leao` stops reaching `Leão`). The call itself is in `TableView`, above. Nothing here decides sameness.',
  'packages/ai/src/cells.ts':
    'Comment only — names `normalizeLoose` when explaining a neighbouring trade. No fold.',
  'packages/data/src/produto/usecases.ts':
    'Comment only — names `skuDoMembroUnico` to explain why `FilhoParaDuplicar.novoSku` is DISCARDED for a sole member (the sku is derived from the parent, not minted per child). The file never calls it: `buildDuplicarProdutoWriteOps` delegates to `montarMembroUnico`, so the derived value arrives already built and is written verbatim. Nothing here decides sameness — the family-of-one branch keys on `filhoUnicoId`, never on a sku.',
};

/** Files matching the pattern, over the index + untracked-but-not-ignored. */
function ficheirosComFold() {
  return gitGrep({ patterns: PATTERN, pathspecs: PATHSPECS, mode: 'extended' });
}

describe('every file folding a value to decide sameness is inventoried', () => {
  it('has no UNLISTED file using an equivalence-key helper', () => {
    const naoListados = ficheirosComFold().filter((f) => !(f in INVENTARIO));
    expect(
      naoListados,
      [
        'These files use a shared equivalence-key helper — a transform whose OUTPUT can',
        'decide whether two values are "the same". #1372 shipped one that collapsed',
        "`'90,5'` with `'90,50'` and `'01'` with `'1'`; the edit reached neither Mercado",
        'Livre nor Firestore and the operator saw a success toast.',
        '',
        'Add the file to INVENTARIO with a one-liner saying:',
        '',
        '  - what the fold DELIBERATELY treats as equal;',
        '  - what must stay DISTINCT, naming the near-miss test that pins it;',
        '  - or "not a comparison" when the helper is used for display/input only.',
        '',
        '⭐ A test that the fold APPLIES is not a test of its SCOPE. If you cannot name',
        'a near-miss test, write one first — that is the check this guard exists for.',
        '',
        'Offending files:',
        ...naoListados.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no STALE entry for a file that no longer uses one', () => {
    const atuais = new Set(ficheirosComFold());
    const obsoletos = Object.keys(INVENTARIO).filter((f) => !atuais.has(f));
    expect(
      obsoletos,
      [
        'These INVENTARIO entries no longer match anything — the file was renamed,',
        'deleted, or stopped using an equivalence-key helper. Remove them, so the',
        'inventory keeps being read as current rather than decoration:',
        ...obsoletos.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ matches the real helpers and NOT their lookalikes', () => {
    // A checker needs two controls: the known-bad must match and the known-good
    // must not. Without the negative half, widening the pattern until it caught
    // everything would go unnoticed — and a guard with false positives trains
    // people to add files without reading them, which defeats it entirely.
    const regex = new RegExp(PATTERN);

    expect(regex.test('normalizeLoose(row.size)')).toBe(true);
    expect(regex.test('const v = parseCentesimos(s.value_name);')).toBe(true);
    expect(regex.test('return canonicalMeasureNames(stripNullsDeep(copy));')).toBe(true);
    expect(regex.test('!deepEqual(rowDiffShape(row), rowDiffShape(storedRow))')).toBe(true);

    expect(regex.test('denormalizeLoosely(x)')).toBe(false);
    expect(regex.test('deepEqualityHint')).toBe(false);
    expect(regex.test('parseDecimalPtBrasil(x)')).toBe(false);
    expect(regex.test('localizarDecimalPlaces(x)')).toBe(false);
  });

  it('⚠️ matches the price fold `mesmoPrecoEmReais` and NOT its lookalikes or `roundReais`', () => {
    // The same two controls for the step-13 addition: the helper must match, a
    // longer name built on it must not, and `roundReais` must stay OUT — its
    // ≈46 importers are the false-positive band this guard refuses.
    const regex = new RegExp(PATTERN);

    expect(regex.test('if (mesmoPrecoEmReais(atual, alvo)) return pulado;')).toBe(true);

    expect(regex.test('mesmoPrecoEmReaisOuCentavos(x)')).toBe(false);
    expect(regex.test('const r = roundReais(valor);')).toBe(false);
    expect(regex.test('precoDaTabela(produto.precos, tabelaId)')).toBe(false);
  });

  it('⚠️ matches the four Shopee kit-recipe folds and NOT their lookalikes or the stamp field', () => {
    // The same two controls for the step-19 addition (#1527). The negative half
    // matters more than usual here: `receitaKitConferida` (the stored stamp) is
    // written by every kit writer, and `chaveAvisoReceitaKitShopee` /
    // `componentesKitDaReceitaShopee` / `escolherPrincipalDoKit` live beside the
    // folds in the same module — none of them decides sameness, and a pattern
    // that caught them would inventory every writer of the stamp.
    const regex = new RegExp(PATTERN);

    expect(
      regex.test('if (!mesmaReceitaKitShopee(erp, vivo, temModelos)) divergentes.push(id);'),
    ).toBe(true);
    expect(regex.test('const chave = chaveReceitaKitErp(filho.componentesKit);')).toBe(true);
    expect(regex.test('const vivo = principalDoKitShopee(modelos, temModelos);')).toBe(true);
    expect(regex.test('mesmoEnderecoDeComponente(nomeado, vivo)')).toBe(true);

    expect(regex.test('mesmaReceitaKitShopeeLegada(x)')).toBe(false);
    expect(regex.test('chaveReceitaKitErpV2(x)')).toBe(false);
    expect(regex.test('{ receitaKitConferida: null }')).toBe(false);
    expect(regex.test('chaveAvisoReceitaKitShopee(integracaoId, kitProdutoId)')).toBe(false);
    expect(regex.test('componentesKitDaReceitaShopee(linhas)')).toBe(false);
    expect(regex.test('escolherPrincipalDoKit(modelos, principal)')).toBe(false);
    expect(regex.test('mesmoEnderecoDeComponentes(a, b)')).toBe(false);
  });

  it('⚠️ matches the default-model rule `modeloDoComponenteKit` and NOT its lookalikes or the field it fills', () => {
    // The same two controls for the step-19 review's addition (OP-4): the rule's
    // output becomes an address and a cascade key outside its definer, so every
    // caller must say what it folds. The negative half keeps OUT the field the
    // import stores it in (`modelIdDoComponente`), written on every kit line.
    const regex = new RegExp(PATTERN);

    expect(
      regex.test('const modelId = modeloDoComponenteKit({ modelId, itemTemModelos: temModelos });'),
    ).toBe(true);

    expect(regex.test('modeloDoComponenteKitLegado(x)')).toBe(false);
    expect(regex.test('modeloDoComponente(x)')).toBe(false);
    expect(regex.test('readonly modelIdDoComponente: number;')).toBe(false);
  });

  it('⚠️ matches the step-9 SKU fold `skuDoItemShopee` and NOT its lookalikes', () => {
    // The same two controls for step 19's export (#1527, R-14): the parent-SKU
    // rung's fold became shared with the native-kit create's duplicate scan, so
    // every new caller must say what it treats as the same SKU.
    const regex = new RegExp(PATTERN);

    expect(regex.test('const sku = skuDoItemShopee(entrada.base);')).toBe(true);

    expect(regex.test('skuDoItemShopeeLegado(base)')).toBe(false);
    expect(regex.test('const sku = (base.item_sku ?? "").trim();')).toBe(false);
    expect(regex.test('skuDoItem(base)')).toBe(false);
  });

  it('⚠️ matches the five kit-arm folds the step-19 review added and NOT their lookalikes', () => {
    // The same two controls for the review's app-local helpers (#1527): the
    // option text a create SENDS (R2-F1), the SKU fixed point (R2-F3), the
    // STORED-map fingerprint (R1-RT7-02), K's fingerprint for a família de um
    // (R1-RT7-01) and the address-fidelity check (R2-F2). The negative half
    // keeps OUT their neighbours: the tier reader `opcoesDoTier`, the sentinel
    // `OPCAO_TIER_KIT_UNICO`, the stored map's FIELD and its tolerant reader.
    const regex = new RegExp(PATTERN);

    expect(regex.test('const opcao = opcaoDoTierKit(filho.variante);')).toBe(true);
    expect(regex.test("if (situacaoDoSkuDoKit(sku) !== 'ok') return null;")).toBe(true);
    expect(regex.test('carimbo: chaveReceitaArmazenadaDoFilho(filho),')).toBe(true);
    expect(regex.test('chaveDoPai: chaveDoPaiDaFamiliaDeUm(pai, filhoId, n),')).toBe(true);
    expect(regex.test('} else if (receitaFielAosEnderecos(componentes)) {')).toBe(true);

    expect(regex.test('const opcoes = opcoesDoTier(kit);')).toBe(false);
    expect(regex.test('OPCAO_TIER_KIT_UNICO')).toBe(false);
    expect(regex.test('componentesKitArmazenado: mapaDeKitArmazenado(raw),')).toBe(false);
    expect(regex.test('opcaoDoTierKitLegada(x)')).toBe(false);
    expect(regex.test('situacaoDoSku(x)')).toBe(false);
  });

  it('⚠️ still covers the file the guard was written for', () => {
    // The regression control. #1372's defect lived in `sizeChartSync.ts`; a
    // pattern that stopped matching it would leave the guard green over the very
    // bug it exists to prevent.
    expect(ficheirosComFold()).toContain(
      'apps/mercado-livre/lib/marketplace/size-charts/sizeChartSync.ts',
    );
  });
});
