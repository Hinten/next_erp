import { ORIGEM_CONVERSA, type OrigemConversa } from '@delfrance/schemas';

/**
 * How a reply physically LEAVES this app, per origem.
 *
 * - `'rota'` — an authenticated HTTP call to the channel backend, synchronous.
 *   The operator sees the real refusal with their text still on screen.
 * - `'trigger'` — write a mensagem and let a Firestore trigger transmit it,
 *   which buys free retries.
 * - `null` — the origem has no sender in this app at all.
 *
 * ⚠️ **This table is the transport decision, and it is deliberately TOTAL.**
 * `satisfies Record<OrigemConversa, …>` means a new origem does not compile
 * until someone classifies it, and `transporteEnvio.test.ts` then checks the
 * classification agrees with `ORIGEM_RULES[origem].temEnvio`.
 *
 * It exists because the previous shape — a hand-kept `ORIGENS_ROTA` set inside
 * `ChatComposer` — could not do either. #768 gave `mlclaims` a backend route
 * (`chatOutbound.ts`'s `ORIGENS_COM_ENVIO`) and set `temEnvio: true`, but never
 * added it to that set. `enviaPorRota` stayed false, so every claim reply took
 * the Firestore branch and landed `estadoEnvio: 'salva'` — a state only
 * WhatsApp's `sendOutbound` trigger consumes. The replies were never
 * transmitted, and nothing failed: #817 with the arrow reversed. The comment
 * above the old set even claimed the value was "derived from the origem … so
 * the day a fourth surface gains a route it changes here and nowhere else",
 * which is precisely what a literal set cannot do. Now it is derived.
 */
export type TransporteEnvio = 'rota' | 'trigger';

export const TRANSPORTE_ENVIO = {
  [ORIGEM_CONVERSA.site]: null,
  [ORIGEM_CONVERSA.facebook]: null,
  [ORIGEM_CONVERSA.comentarioFacebook]: null,
  // WhatsApp is the one sender that goes through a trigger: its failures are
  // TRANSIENT, so the free retries are worth the indirection.
  [ORIGEM_CONVERSA.whatsapp]: 'trigger',
  // The three Mercado Livre surfaces are single-shot and their refusals are
  // terminal and operator-actionable (already answered, thread blocked,
  // mediation open, grant dead), so they go synchronously (#533, #768).
  [ORIGEM_CONVERSA.mercadoLivrePerguntas]: 'rota',
  [ORIGEM_CONVERSA.mercadoLivrePedido]: 'rota',
  [ORIGEM_CONVERSA.mercadoLivreReclamacoes]: 'rota',
} as const satisfies Record<OrigemConversa, TransporteEnvio | null>;

/**
 * Whether this origem's reply leaves through the channel BACKEND rather than by
 * writing a mensagem for a trigger to pick up.
 *
 * ⚠️ Takes `OrigemConversa`, deliberately NOT a widened `string`. It briefly took
 * a string, reasoning that the migrated corpus carries origens these schemas do
 * not model (true — `parseSoftRead` returns the raw document on a parse failure)
 * and that an unknown one should fall back to the Firestore path. **That fallback
 * does not exist**: `composerGate` (`composerGate.ts:64`) and `ChatComposer`
 * (`:205`) both index `ORIGEM_RULES[origem]` unguarded and throw first, so an
 * unmodelled origem is a `TypeError` on the thread page long before this function
 * is reached. The widening bought a safety the call path does not have, and cost
 * the one guarantee this module exists for — `enviaPorRota('mlclaim')` (typo)
 * would compile and silently answer `false`, which is exactly the failure class
 * #768 shipped.
 */
export function enviaPorRota(origem: OrigemConversa): boolean {
  return TRANSPORTE_ENVIO[origem] === 'rota';
}
