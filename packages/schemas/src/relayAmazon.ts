/* -------------------------------------------------------------------------- */
/*            Amazon relay ⇄ receiver: the wire contract (step 3)             */
/* -------------------------------------------------------------------------- */

/**
 * What the AWS relay (`infra/amazon-relay`, an EventBridge Pipe behind an API
 * destination) and the HTTPS receiver in `apps/amazon` must agree on. ONE
 * definition, imported by both sides: the relay is a CDK app and the receiver a
 * Next route, and nothing else would tell them they drifted apart. A header
 * renamed on one side only is a 401 on every delivery; a wrapper key renamed on
 * one side only is a 200 + drop on every delivery, invisible to every AWS alarm.
 *
 * Pure constants: no clock, no network, no Firestore. Not a collection, so no
 * meta and nothing to register.
 */

/**
 * The header the Pipe's `API_KEY` Connection sends the relay secret in.
 *
 * Lowercase, because HTTP field names are case-insensitive and the receiver
 * reads `Headers`, which lowercases them. A custom `x-` header on purpose: never
 * `Authorization`, and never one of Google's own prefixes (`x-goog-`,
 * `x-google-`), since the receiver runs behind Google's front end.
 */
export const CABECALHO_CHAVE_RELAY_AMAZON = 'x-erp-relay-key';

/** The key of the one-field object the Pipe's input template wraps the SQS body in. */
export const CAMPO_CORPO_RELAY_AMAZON = 'body';

/**
 * The Pipe's `InputTemplate`, BUILT from the field constant above.
 *
 * The wrapper is what keeps the body JSON: a bare `<$.body>` template strips the
 * quotes of a JSON body (EventBridge Pipes input transformation), so the
 * receiver would get text that is no longer JSON. The receiver also accepts the
 * wrapper's value as a JSON STRING, parsed once (an undocumented Pipes corner).
 */
export const MODELO_ENTRADA_RELAY_AMAZON = `{"${CAMPO_CORPO_RELAY_AMAZON}": <$.${CAMPO_CORPO_RELAY_AMAZON}>}`;

/**
 * The receiver's path, appended to the relay's `ReceiverUrl` parameter pattern.
 *
 * Outside `/api/marketplace/`, which is the CORS matcher in `apps/amazon/proxy.ts`
 * (browser calls from `apps/web`): the relay is a server-to-server POST.
 */
export const CAMINHO_RECEPTOR_AMAZON = '/api/webhooks/amazon';
