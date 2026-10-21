'use client';

import { FirebaseError } from 'firebase/app';
import {
  CHAVE_RETORNO_OAUTH_AMAZON,
  MOTIVO_RETORNO_OAUTH_AMAZON,
  type MotivoRetornoOAuthAmazon,
} from '@delfrance/schemas';

import type { ConnectionFailure } from '@/components/oauth/ConnectionPanel';
import {
  AmazonBackendError,
  AmazonRedeError,
  mensagemErroAmazon,
  repetivelAmazon,
} from '@/lib/amazon/erros';
import type { OAuthCallbackToastConfig } from '@/lib/oauth/useOAuthCallbackToast';

/**
 * The panel's connect button, named by BOTH of its labels.
 *
 * `ConnectionPanel` labels it "Reautenticar" on a connected conta and "Conectar
 * conta" otherwise, and a failed REAUTHORIZATION — the yearly renewal, or the
 * reconnection of a parked conta — lands back on a conta that is still
 * connected. Copy naming one label alone would send the operator after a button
 * that is not on the screen.
 */
const BOTAO_DE_CONEXAO = 'Conectar conta (ou Reautenticar, se a conta já estiver conectada)';

/**
 * Everything the Amazon connect panel narrows, in one place: the copy for the
 * OAuth callback's return (`?amazon=connected|error&reason=…`), and the two
 * describers `ConnectionPanel` takes.
 *
 * ## The callback's reasons
 *
 * The callback on `apps/amazon` redirects back with a `reason` from a CLOSED set
 * that lives in the shared contract (`motivoRetornoOAuthAmazonSchema`,
 * `@delfrance/schemas`). The map below is a `Record` over that type, so a reason
 * the backend gains fails typecheck HERE until it has a sentence — never a
 * `Motivo não reconhecido (…)` in front of an operator.
 *
 * ⚠️ Two of the sixteen land on the LIST page, not on the conta page: the
 * callback redirects to `/canais/amazon` whenever it has no trustworthy conta id
 * (`config`, `bad_state`). That is why `AmazonCallbackToast` is mounted on the
 * list as well as inside the panel — the same constant serves both, so the two
 * screens cannot drift apart.
 *
 * ⚠️ Where the copy says what to click, it names the panel's OWN button
 * ({@link BOTAO_DE_CONEXAO}, by both of its labels), never Seller Central's
 * "Re-Authorize": that one loads a log-in URI this ERP does not serve.
 */
export const MENSAGENS_RETORNO_OAUTH_AMAZON: Readonly<Record<MotivoRetornoOAuthAmazon, string>> = {
  // --- list page (no trustworthy conta id) ---
  [MOTIVO_RETORNO_OAUTH_AMAZON.config]:
    'O backend da Amazon está sem a configuração da conexão (credenciais do aplicativo, endereço ' +
    'de retorno ou chave de assinatura do state). Avise quem cuida do deploy.',
  // The state is signed AND single-use: reloading the callback URL, or opening
  // the same consent link twice, lands here with everything configured right.
  // The copy has to say so, or it reads as a broken deploy.
  [MOTIVO_RETORNO_OAUTH_AMAZON.badState]:
    'A tentativa de conexão não confere, já foi usada ou expirou — cada tentativa vale uma vez só, ' +
    `por até 10 minutos. Recomece pela tela da conta, clicando em ${BOTAO_DE_CONEXAO}.`,

  // --- conta page (a trustworthy conta id came back in the state) ---
  [MOTIVO_RETORNO_OAUTH_AMAZON.integracaoDesligada]:
    'A integração com a Amazon fica desligada até a virada. Nada foi salvo, e a tentativa não foi ' +
    'gasta.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.missingParams]:
    'A Amazon não devolveu o código de autorização: o consentimento foi cancelado ou não terminou. ' +
    `Clique em ${BOTAO_DE_CONEXAO} e refaça o consentimento.`,
  [MOTIVO_RETORNO_OAUTH_AMAZON.vendedorInvalido]:
    'A Amazon devolveu um identificador de vendedor que o ERP não aceita. Nada foi salvo; tente ' +
    'conectar de novo e, se continuar, avise o suporte.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.conta]:
    'Esta conta não existe mais, ou não é uma conta da Amazon. Volte à lista de contas.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.vendedorDiferente]:
    'Esta conta já está ligada a outro vendedor da Amazon; para trocar de vendedor, crie outra conta.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.vendedorEmOutraConta]:
    'Este vendedor da Amazon já está ligado a outra conta ativa do ERP. Use aquela conta, ou ' +
    'desative-a antes de conectar esta. Nada foi salvo.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.codigoInvalido]:
    'A Amazon recusou o código de autorização: ele expirou (vale poucos minutos) ou já foi usado. ' +
    `Clique em ${BOTAO_DE_CONEXAO} para recomeçar.`,
  [MOTIVO_RETORNO_OAUTH_AMAZON.serverConfig]:
    'A Amazon recusou as credenciais do aplicativo deste backend (o client id ou o client secret ' +
    'do LWA), ou a configuração do backend é inválida. Avise quem cuida do deploy.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.amazonIndisponivel]:
    'A Amazon está limitando as chamadas ou instável neste momento. Tente conectar de novo em ' +
    'alguns minutos.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.tempoEsgotado]:
    'A Amazon demorou demais para responder, e o código de autorização pode ter sido gasto. ' +
    `Clique em ${BOTAO_DE_CONEXAO} para recomeçar.`,
  [MOTIVO_RETORNO_OAUTH_AMAZON.rede]:
    'Não foi possível falar com a Amazon. Tente novamente em alguns instantes.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.respostaInvalida]:
    'A Amazon respondeu num formato inesperado. Nada foi salvo; avise o suporte — o detalhe está ' +
    'nos logs do backend.',
  [MOTIVO_RETORNO_OAUTH_AMAZON.conflito]:
    'A conta foi alterada por outra operação ao mesmo tempo, e a conexão não pôde ser gravada. ' +
    `Nada foi salvo; clique em ${BOTAO_DE_CONEXAO} de novo.`,
  // The honest catch-all: every exchange failure the backend could not tell
  // apart lands here, so the copy promises no diagnosis it does not have.
  [MOTIVO_RETORNO_OAUTH_AMAZON.exchange]:
    'Falha ao trocar o código de autorização com a Amazon. Tente conectar de novo; se continuar, o ' +
    'motivo exato está nos logs do backend.',
};

/**
 * The callback toast's whole config — a MODULE CONSTANT on purpose.
 *
 * ⚠️ `mensagens` must be referentially STABLE: `useOAuthCallbackToast`
 * destructures the config and lists `mensagens` (not the config object) among
 * its effect dependencies, so a fresh message map per render would re-fire the
 * notification on every render (`ConnectionPanel`'s mounting trap 2). A
 * module-level constant is the simplest guarantee; `ContaAmazonPanel.test.tsx`
 * pins it with a render counter.
 */
export const AMAZON_CALLBACK_TOAST = {
  chave: CHAVE_RETORNO_OAUTH_AMAZON,
  sucesso: 'Conta Amazon conectada.',
  tituloErro: 'Falha ao conectar a conta Amazon',
  mensagens: MENSAGENS_RETORNO_OAUTH_AMAZON,
} as const satisfies OAuthCallbackToastConfig;

const MENSAGEM_SESSAO =
  'Não foi possível confirmar sua sessão para falar com o backend da Amazon. Recarregue a página.';

/**
 * A failed conta read, as operator copy plus a retryability verdict.
 *
 * `AmazonRespostaInvalidaError` (a 2xx this build cannot read) is an
 * {@link AmazonBackendError} and needs no branch of its own here: the guarantee
 * that it keeps the client's sentence and is never retryable lives in
 * `mensagemErroAmazon` / `repetivelAmazon`, which narrow it first and are where
 * `erros.test.ts` pins it.
 *
 * TOTAL by contract: `ConnectionPanel` renders a query error state and has
 * nowhere to rethrow to, so every input produces copy.
 */
export function describeAmazonContaFailure(err: unknown): ConnectionFailure {
  if (err instanceof AmazonBackendError) {
    return { message: mensagemErroAmazon(err), retryable: repetivelAmazon(err) };
  }
  if (err instanceof AmazonRedeError) {
    return { message: 'Não foi possível contatar o backend da Amazon.', retryable: true };
  }
  if (err instanceof FirebaseError) {
    // `getIdToken()` failed before any request: nothing reached the backend.
    return { message: MENSAGEM_SESSAO, retryable: true };
  }
  return { message: 'Não foi possível consultar a conexão desta conta.', retryable: false };
}

/**
 * A failed Conectar / Reautenticar click, as operator copy — or `null` when the
 * failure is not one of this channel's, which makes `ConnectionPanel` rethrow it
 * (root `CLAUDE.md` rule 6).
 *
 * While the backend's read switch is off, the button still renders and the
 * start answers 503 `AMAZON_CHAMADAS_DESLIGADAS`: that is mapped HERE, to copy
 * that says nothing was sent, rather than hidden by the panel.
 */
export function describeAmazonConnectFailure(err: unknown): string | null {
  if (err instanceof AmazonBackendError) return mensagemErroAmazon(err);
  if (err instanceof AmazonRedeError) {
    return 'Falha de rede ao iniciar a conexão com a Amazon. Tente de novo.';
  }
  if (err instanceof FirebaseError) return MENSAGEM_SESSAO;
  return null;
}
