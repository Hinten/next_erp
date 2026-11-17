/**
 * The NF-e upload's TWO Delivery-API calls (step 14, PR 14-c): the ONE module of
 * this app that calls `consultarStatusNotaFiscal` and `enviarNotaFiscal`
 * (`estrutura.test.ts` pins both single callers, across `lib/`, `app/`,
 * `functions/src` and `scripts/`). The NF-e task (`processarNfe.ts`) reaches
 * Amazon's invoice state through here and nowhere else, so a W10 verification
 * script cannot spend the Delivery budget on its own (1.133 rps, burst 25,
 * shared with the task).
 *
 * ## The status read ({@link lerStatusNfeNaAmazon})
 *
 * `getInvoiceStatus` through the context's READ client and the
 * forced-refresh-once rule (`core/renovacaoUnica.ts`): a 401/403 refreshes once
 * and reads once more. Its answer is read by `statusNfe.ts`:
 *
 * - a 2xx body ⇒ {@link lerStatusNfeAmazon} (the closed reading);
 * - a REFUSED read that is still a reading ⇒ `leituraDaFalhaDeStatusNfeAmazon`
 *   (a 404 or a 400 `EntityNotFound` on an order the live gate just proved ⇒
 *   `sem-nota`; another 4xx or a 2xx off its schema ⇒ `indeterminado`);
 * - anything else — a second 401/403, a 429, a 5xx, a cut connection, a refused
 *   input, a credential refusal, a bug — is RETHROWN untouched: the caller's
 *   transient, pause and refusal rules decide it (nothing was written).
 *
 * ## The submit ({@link enviarNfeNaAmazon})
 *
 * `submitInvoice` through the WRITE client the engine built (`core/escrita.ts`)
 * — this function is the engine's `escrever`, so it runs ONCE per dispatch,
 * inside the engine's own forced-refresh-once rule. ⚠️ It never wraps itself in
 * that rule a second time: two nested rules would turn one 401 into two
 * refreshes and up to four POSTs. Its outcome is RETURNED or THROWN untouched;
 * a cut, 5xx or schema-failing submit MAY HAVE LANDED and is never repeated
 * here (the caller's verification chain re-reads instead).
 *
 * ⚠️ PII: `conteudo` is a whole fiscal document with buyer data and its digest.
 * It crosses this module into the package's request body and nowhere else — no
 * line, no aviso, no payload, no response (the write client's call event has
 * no request-body field, by construction).
 */
import {
  consultarStatusNotaFiscal,
  enviarNotaFiscal,
  type ResultadoEnvioNotaFiscal,
  type SpApiEscritaClient,
} from '@delfrance/integrations-amazon-sp-api';

import type { ContextoAmazon } from '../core/contexto';
import { executarComRenovacaoUnica } from '../core/renovacaoUnica';
import type { ConteudoNfeAmazon } from './conteudoNfe';
import {
  type LeituraStatusNfe,
  leituraDaFalhaDeStatusNfeAmazon,
  lerStatusNfeAmazon,
} from './statusNfe';

/** What the status read needs of a context: its read client and the access getter. */
export type ContextoDaEntregaAmazon = Pick<ContextoAmazon, 'cliente' | 'obterAcesso'>;

/**
 * Amazon's invoice state for ONE order, as a closed reading (module header).
 *
 * @throws every failure that is not a reading, untouched (module header).
 */
export async function lerStatusNfeNaAmazon(
  contexto: ContextoDaEntregaAmazon,
  orderId: string,
): Promise<LeituraStatusNfe> {
  try {
    const resposta = await executarComRenovacaoUnica(contexto, () =>
      consultarStatusNotaFiscal(contexto.cliente, orderId),
    );
    return lerStatusNfeAmazon(resposta.dados);
  } catch (err) {
    // Rule 6: the classifier narrows by the package's own classes; `null` is
    // "not a reading" — the caller's to decide.
    const leitura = leituraDaFalhaDeStatusNfeAmazon(err);
    if (leitura === null) throw err;
    return leitura;
  }
}

/**
 * ONE `submitInvoice` of the stored proc (module header): the engine's
 * `escrever`. Outcome returned or thrown untouched.
 */
export function enviarNfeNaAmazon(
  escritor: SpApiEscritaClient,
  orderId: string,
  conteudo: ConteudoNfeAmazon,
): Promise<ResultadoEnvioNotaFiscal> {
  return enviarNotaFiscal(escritor, {
    orderId,
    invoiceContent: conteudo.invoiceContent,
    contentMD5Value: conteudo.contentMD5Value,
  });
}
