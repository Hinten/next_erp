/**
 * The marketplace stock-sync compute core, shared.
 *
 * The kit fold, the floor/clamp pair, the window-start reconstruction and the
 * send policy (ADR 0014) were `apps/mercado-livre`'s alone until Shopee's stock
 * sync needed the same answers for `update_stock` and for
 * `init_tier_variation`'s `seller_stock`. `apps/shopee` has no dependency edge
 * to `apps/mercado-livre` and none is possible, so a rule that two surfaces need
 * either moves here or gets written twice — and a second copy of a decision this
 * expensive drifts toward plausible while reading correct (root `CLAUDE.md`,
 * #1369). The precedent is `admin/imposto/`, promoted in step 11 for a strictly
 * weaker reason; the specific hazard here was already counted, as FOUR live kit
 * formulas in this repo before a fifth was proposed.
 *
 * This is a NARROW subpath (`@delfrance/data/admin/estoque`) on purpose: a
 * Cloud-Functions-graph module importing the quantity fold must not drag the
 * notifications, cache, pipelines and reconcile modules in behind it. The
 * `@delfrance/data/admin` barrel does not re-export any of this.
 *
 * ---- What moved, and the rule the move buys. Every function body here is
 * Mercado Livre's, byte-for-byte, with ONE class of change: each tunable it used
 * to read from the ambient environment mid-arithmetic is now a required parameter
 * ({@link OpcoesDeQuantidade}, and `deveEnviarFamiliaCore`'s `limiar`). Nothing
 * under this directory reads the environment except `./env`, whose two helpers
 * exist so each channel can write its OWN reader — ML's `opcoesML`, Shopee's
 * `opcoesShopee`, which pins `pularKitVirtual: false` because "send no quantity"
 * is inexpressible on that wire. A core that resolved one of those itself would
 * be a Mercado Livre module wearing a neutral path.
 *
 * ---- What deliberately did NOT move, each for a reason:
 *  - **the discovery pipelines** (`fetchStockFamilies`,
 *    `fetchStockFamiliesByIds`) and the **ledger aggregate**
 *    (`fetchMovimentosDaJanela`) — only their TYPES are here (`./ledger`).
 *    `packages/data` declares no dependency on the admin Firestore SDK's
 *    Pipelines package at all, and
 *    `admin/adminBundleSafety.test.ts` scans for `firebase-admin` only, so a
 *    pipelines import here would fail NOTHING and break at resolution time in
 *    whichever app imported it next;
 *  - `resolverModoEstoque` and the multiorigem symbols — Mercado Livre account
 *    tags, meaningless elsewhere;
 *  - `podeEnviarEstoque` — the six ML listing statuses; Shopee's gate is its own
 *    field set, and folding both into one predicate is how a channel's status
 *    vocabulary leaks into another's;
 *  - `buildSendTasks`, `SendUnitKind`, `SendSkipReason` — the task SHAPE is per
 *    channel (one item per task here, a bulk item payload there), and the skip
 *    vocabulary is rendered to operators in each app's own pt-BR table;
 *  - the ML env readers themselves (`estoqueMax()`, `limiarEstoqueAlto()`,
 *    `kitIncluiEstoqueProprio()`, `pularKitVirtual()`) — they stay in ML and now
 *    only FEED this core;
 *  - `STOCK_SEND_MAX_ATTEMPTS`, `PAUSE_REENQUEUE_JITTER_MAX_S` — queue
 *    parameters, deployed per channel.
 *
 * ⚠️ `apps/mercado-livre/lib/marketplace/estoque/bulkEstoquePlan.ts` **keeps its
 * path and re-exports every name below byte-compatibly** — `tools/deploy-env`'s
 * preflight reads that file BY PATH, and its four suites (`bulkEstoquePlan`,
 * `estoqueSweep`, `estoqueSend`, `estoqueManual`) stay byte-unedited. Those
 * unedited suites ARE the proof that the promotion changed no behaviour; an edit
 * to one of them to make this compile would destroy the evidence.
 */
export { envFlag, envInt } from './env';
export { chaveMovimento } from './ledger';
export type {
  FetchMovimentosArgs,
  FetchMovimentosDaJanela,
  MovimentoDaJanela,
  MovimentosDaJanela,
} from './ledger';
export {
  componentesNaoResolvidos,
  disponivelByProdutoIdFrom,
  kitNaoVerificavel,
  quantidadeDoMembroCore,
  quantidadeParaEnvioCore,
  quantidadesAnterioresCore,
  quantidadesDaFamiliaCore,
} from './quantidades';
export type {
  LinhaDeFamilia,
  MembroDaFamilia,
  OpcoesDeQuantidade,
  QuantidadeParaEnvioArgs,
  RawEstoqueRow,
} from './quantidades';
export { deveEnviarFamiliaCore, ESTOQUE_MIN } from './politica';
export {
  STOCK_TASK_ENCODED_BODY_BUDGET_BYTES,
  STOCK_TASK_ENCODED_BODY_WARN_BYTES,
  stockTaskEncodedBodyBytes,
} from './tarefas';
