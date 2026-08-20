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
 * never registered. Revisit only if bulk conversa deletion ever becomes a
 * feature; that, not subtree width, is what the factory cannot absorb.
 *
 * What the volume DOES buy is the budget. Alone among the four, this cascade may
 * not finish in one invocation, so it gets `budgetMs`/`timeoutSeconds` and the
 * redelivery contract that comes with them (`../lib/cascadeCaroGenerico.ts`):
 * stop cleanly, commit what was reached, throw, resume on the next delivery. The
 * other three are left unbudgeted on purpose — a two-document subtree cannot
 * truncate, and `retry: true` there would only redeliver permanent failures.
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
