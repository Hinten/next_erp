import { integracaoMeta, intFreteMeta, metodoPagamentoMeta } from '@delfrance/schemas';

import { defineCascadeCaroGenerico } from '../lib/cascadeCaroGenerico';

/**
 * The three collections whose delete cascade rides the CARO GENÉRICO factory
 * (`../lib/cascadeCaroGenerico.ts` — read its docblock for the cost model and
 * the `recursiveDelete` prohibition).
 *
 * All three are **credential stores**, which is why they were worth doing first:
 * a deleted parent used to leave a live OAuth `refresh_token` readable behind
 * it, not just clutter.
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
 * ## Deliberately NOT here
 *
 * `pedidos` and `clientes` declare a cascade and will stay orphaned — both
 * carry fiscal data an emitted NF-e still depends on. The reasoning lives at
 * each declaration in `packages/schemas`. `chat` is deferred to its own issue:
 * a conversa's `mensagem` subcollection is exactly the high-volume shape this
 * factory is the wrong tool for.
 */
export const onIntegracaoDeleted = defineCascadeCaroGenerico(integracaoMeta);
export const onIntFreteDeleted = defineCascadeCaroGenerico(intFreteMeta);
export const onMetodoPagamentoDeleted = defineCascadeCaroGenerico(metodoPagamentoMeta);
