import {
  conversaMeta,
  integracaoMeta,
  intFreteMeta,
  metodoPagamentoMeta,
} from '@delfrance/schemas';

import {
  BUDGET_MS_PADRAO,
  TIMEOUT_SECONDS_PADRAO,
  defineCascadeCaroGenerico,
} from '../lib/cascadeCaroGenerico';

/**
 * The four collections whose delete cascade rides the CARO GENÉRICO factory
 * (`../lib/cascadeCaroGenerico.ts` — read its docblock for the cost model and
 * the `recursiveDelete` prohibition).
 *
 * The first three are **credential stores**, which is why they were worth doing
 * first: a deleted parent used to leave a live OAuth `refresh_token` readable
 * behind it, not just clutter.
 *
 *  - `integracao`  → credenciais, credenciaisWhatsapp, token6h, tokenDuravel …
 *                    and `brandshopee`, which `integracaoMeta.cascade` forgets
 *                    to declare. The walk finds it because it asks Firestore
 *                    what exists rather than asking the registry.
 *  - `int_frete`   → tokenMelEnv (the Melhor Envio OAuth token).
 *  - `metodo_pgto` → credenciais. Default-deny for clients (no rules match at
 *                    all), so nothing but a trigger could ever reclaim it.
 *
 * All three fit the factory's precondition: deletes are rare (an operator
 * disconnects a channel account, not a batch job) and each subtree is one or two
 * documents, so the per-document `listCollections()` toll is noise.
 *
 * ## And `chat`, which fits only half of it (#980)
 *
 * `conversaMeta` declares `chat/{conversaId}/mensagem` and nothing enforced it,
 * so every deleted conversa left its whole message history orphaned — the
 * biggest of the six unenforced cascades, and permanently invisible.
 *
 * It is the one subtree where the `listCollections()` toll is real rather than
 * noise: `mensagem` documents are LEAVES, and a conversa can hold thousands, so
 * the walk pays a discovery call per message that always returns nothing.
 * #980 proposed a targeted alternative (one kinded paged sweep over the declared
 * path, zero discovery). **Owner call: use the factory anyway** — deleting a
 * conversa is a rare, manual, nobody-is-waiting operation, so the toll is paid
 * once and buys back both the extra machinery and the discovery walk's ability
 * to reclaim whatever the legacy corpus left under a conversa that this repo
 * never registered. Subtree WIDTH is not what would change that answer; delete
 * FLOW is.
 *
 * ⚠️ "Rare" is a claim about the product, and it is true of it: no app exposes
 * any way to delete a conversa (the red `IconTrash` in `ConversaActionsMenu` is
 * a Mercado Livre moderation call that writes nothing locally, and the bulk bar
 * only sets `estadoConversa`/`cor_etiqueta`). It is NOT true of the project this
 * deploys to. Two e2e janitors bulk-delete `chat` on staging every run —
 * `cleanupConversas` (`apps/web/e2e/_helpers/seed-data.ts`, per-spec `afterAll`)
 * and the cross-run `stale-sweep` (`chat` is in `E2E_FIXTURE_TARGETS`, up to 500
 * conversas per pass). Both are benign HERE for a specific reason worth keeping
 * written down: each deletes the `mensagem` subtree FIRST (the sweep through
 * `deleteDocumentSubtree` itself), so by the time `onConversaDeleted` fires the
 * subtree is empty — one `listCollections()` that returns nothing, resolving in
 * milliseconds. `timeoutSeconds` is a CEILING, not a duration, and the codebase
 * is already capped at `maxInstances: 10` globally (`../options.ts`), so the fan-out
 * is bounded regardless. What staging exercises every run is therefore the
 * cheap path — which is also why it is not the load test that would tell us
 * anything about a wide subtree.
 *
 * What the volume DOES buy is the budget. Alone among the four, this cascade may
 * not finish in one invocation, so it gets `budgetMs`/`timeoutSeconds` and the
 * redelivery contract that comes with them (`../lib/cascadeCaroGenerico.ts`):
 * stop cleanly, commit what was reached, throw, resume on the next delivery. The
 * other three are left unbudgeted on purpose — a two-document subtree cannot
 * truncate, and `retry: true` there would only redeliver permanent failures.
 *
 * ## ⚠️ What this cascade does NOT reclaim: the Storage half (#980)
 *
 * It reclaims the Firestore subtree and nothing else. A `mensagem` carries six
 * outer refs into the **top-level** `arquivos` collection (`anexoStorage`, plus
 * `audio.audio`, `image.image`, `video.video`, `sticker.sticker`,
 * `genericDocument.genericDocument`). Those docs are not under the conversa, so
 * the walk never reaches them — and nothing else does either: WhatsApp media
 * lands at `whatsapp/<contaId>/<mediaId>`, while `parseOwnedMediaDir` knows only
 * the `produtos` and `tabMedi` roots, so `reconcileArquivoOrphans` returns
 * `null` on those paths and skips them by construction. This is the `arquivos`
 * skill's §9 step-4 trap, pre-dating this cascade: that media was never
 * auto-reaped.
 *
 * ⚠️ **Do NOT "fix" this by extending the cascade to delete the referenced
 * arquivos.** `arquivoDocId(mediaId)` is deterministic per Meta media id and the
 * cache-hit branch in `apps/whatsapp/lib/whatsapp/media.ts` deliberately reuses
 * ONE doc across messages — and across conversas. A per-message delete would
 * take a live attachment out from under another thread. Reclaiming them needs
 * refcounting (a `chat` collection-group query), which is a sweep feature, not a
 * cascade one — tracked in #1207.
 *
 * What this cascade DOES change is discoverability: the leak already existed,
 * but the `mensagem` docs at least still pointed at the blobs. After this, the
 * pointers are gone and the remainder is unreferenced from anywhere. That is a
 * deliberate, recorded remainder — not an oversight — and the reason it is
 * accepted is that the alternative (keep orphaning entire message histories to
 * preserve a breadcrumb no sweep reads) is strictly worse.
 *
 * ## Deliberately NOT here
 *
 * `pedidos` and `clientes` declare a cascade and will stay orphaned — both
 * carry fiscal data an emitted NF-e still depends on. The reasoning lives at
 * each declaration in `packages/schemas`.
 */
export const onIntegracaoDeleted = defineCascadeCaroGenerico(integracaoMeta);
export const onIntFreteDeleted = defineCascadeCaroGenerico(intFreteMeta);
export const onMetodoPagamentoDeleted = defineCascadeCaroGenerico(metodoPagamentoMeta);
export const onConversaDeleted = defineCascadeCaroGenerico(conversaMeta, {
  budgetMs: BUDGET_MS_PADRAO,
  timeoutSeconds: TIMEOUT_SECONDS_PADRAO,
});
