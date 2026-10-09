/**
 * Every `instanceof` narrowing for a failed Loja Integrada conta call, in one
 * place: the copy the operator reads, where it goes, what happens to the
 * Personal Token typed in the field, and whether the panel must re-read the
 * status. The `lib/shopee/erros.ts` shape, for this channel's client.
 *
 * ⚠️ Keyed on the backend's `code` (`CODIGO_ERRO_LI`, the shared contract),
 * NEVER on the status alone. A 422 is "Loja Integrada refused the token"
 * (`LI_TOKEN_RECUSADO`), "malformed, nothing was sent" (`LI_TOKEN_INVALIDO`) or
 * a refused date (`LI_VALIDADE_*`), a 409 is four different things, and a 503 is
 * either a transient park conflict (try again) or the backend's read switch
 * being off — until the cutover, or mis-set after it (`LI_CHAMADAS_DESLIGADAS`:
 * trying again cannot help) — each asks the operator for something else.
 *
 * ## The token field after a failure
 *
 * Cleared by default: a live credential should not sit in a form field longer
 * than the request needs it. KEPT only where sending the SAME token again is the
 * point — the validation could not conclude (`LI_VALIDACAO_INCONCLUSIVA`, a
 * network failure, a transient conflict, an interrupted request) — or where the
 * token was never the problem (a refused date, a credential that changed
 * underneath, an unreadable stored credential).
 *
 * ## Re-reading the status
 *
 * Only when the failure itself says the stored credential differs from what the
 * panel shows, or when our own write may have landed. Re-reading after any
 * other failure would quietly swap in a version another operator wrote, and the
 * next save would then overwrite their token without the 409 that exists to stop
 * exactly that (root `CLAUDE.md` rule 7, tier 3).
 */
import { FirebaseError } from 'firebase/app';
import { CODIGO_ERRO_LI } from '@delfrance/schemas';
import { resumirCampos } from '@delfrance/core/wire';

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
} from './client';

/** Where a failure's copy is shown. */
export type CampoDaFalhaLi = 'expiraEm' | null;

/** A Mantine colour name, which is what the panel's `Alert` takes. */
export type CorDaFalhaLi = 'red' | 'yellow' | 'orange';

export interface FalhaCredencialLi {
  /** What to show the operator — pt-BR, saying what to DO. */
  readonly mensagem: string;
  /** `expiraEm` puts the copy on the date field; `null` in the panel. */
  readonly campo: CampoDaFalhaLi;
  /** Whether the Personal Token typed in the field stays after this failure. */
  readonly manterToken: boolean;
  /** Whether the panel must re-read the status before the next write. */
  readonly recarregarStatus: boolean;
  readonly cor: CorDaFalhaLi;
}

/** The backend's `code` on a failed call, or `null` (a network failure, a foreign error). */
export function codigoDaFalhaLi(err: unknown): string | null {
  return err instanceof LojaIntegradaClientHttpError ? err.code : null;
}

const MENSAGEM_REDE =
  'Não foi possível contatar o backend da Loja Integrada (falha de rede). Tente de novo.';

/** ` (HTTP 401)` when Loja Integrada answered with a status, else nothing. */
function sufixoStatusLi(err: LojaIntegradaClientHttpError): string {
  return err.statusLi === null ? '' : ` (HTTP ${String(err.statusLi)})`;
}

function falha(
  mensagem: string,
  opcoes: Partial<Omit<FalhaCredencialLi, 'mensagem'>> = {},
): FalhaCredencialLi {
  return {
    mensagem,
    campo: opcoes.campo ?? null,
    manterToken: opcoes.manterToken ?? false,
    recarregarStatus: opcoes.recarregarStatus ?? false,
    cor: opcoes.cor ?? 'red',
  };
}

/** The copy for a coded envelope, or `null` when this code has none of its own. */
function falhaPorCodigo(err: LojaIntegradaClientHttpError): FalhaCredencialLi | null {
  if (err.code === null) return null;
  switch (err.code) {
    case CODIGO_ERRO_LI.tokenRecusado:
      return falha(
        `A Loja Integrada recusou este token${sufixoStatusLi(err)}. Confira se ele foi copiado ` +
          'inteiro, se o plano da loja dá acesso à API e se o token não foi removido nem expirou no ' +
          'painel da Loja Integrada. Nada foi salvo.',
      );
    case CODIGO_ERRO_LI.tokenInvalido:
      return falha(
        'O texto colado não tem o formato de um Personal Token (curto demais, ou com espaço ou ' +
          'caractere inválido no meio). Nada foi enviado à Loja Integrada nem salvo.',
      );
    case CODIGO_ERRO_LI.tokenDeOutraConta:
      return falha(
        'Este token já está salvo em outra conta da Loja Integrada (ativa ou inativa). Cada conta ' +
          'usa o token da sua própria loja. Nada foi salvo.',
      );
    case CODIGO_ERRO_LI.validacaoInconclusiva:
      return falha(
        `Não foi possível validar o token agora: a Loja Integrada não respondeu de forma ` +
          `conclusiva${sufixoStatusLi(err)}. Nada foi salvo. Tente de novo em instantes.`,
        { manterToken: true, cor: 'yellow' },
      );
    case CODIGO_ERRO_LI.validadeInvalida:
      return falha('Escolha uma data válida para a validade do token.', {
        campo: 'expiraEm',
        manterToken: true,
      });
    case CODIGO_ERRO_LI.validadePassada:
      return falha('A validade não pode ser anterior a hoje.', {
        campo: 'expiraEm',
        manterToken: true,
      });
    case CODIGO_ERRO_LI.validadeDistante:
      return falha('A validade passa do máximo aceito a partir de hoje: confira o ano.', {
        campo: 'expiraEm',
        manterToken: true,
      });
    case CODIGO_ERRO_LI.credencialAlterada:
      return falha(
        'A credencial desta conta mudou depois que esta tela a leu: outro operador salvou ou ' +
          'removeu o token, a Loja Integrada recusou o token salvo, ou uma tentativa anterior ' +
          'chegou a salvar. A situação acima foi recarregada; confira e salve de novo.',
        { manterToken: true, recarregarStatus: true, cor: 'orange' },
      );
    case CODIGO_ERRO_LI.credencialInvalida:
      return falha(
        'A credencial salva desta conta está ilegível' +
          (err.campos.length === 0 ? '' : ` (campos: ${resumirCampos(err.campos)})`) +
          '. Remova o token e salve-o de novo.',
        { manterToken: true, recarregarStatus: true },
      );
    case CODIGO_ERRO_LI.credencialAusente:
      return falha(
        'Não há token salvo nesta conta para renovar. Salve um Personal Token primeiro.',
        { manterToken: true, recarregarStatus: true, cor: 'orange' },
      );
    case CODIGO_ERRO_LI.contaNaoEncontrada:
      return falha(
        'Esta conta não existe mais, ou não é uma conta da Loja Integrada. Volte à lista de contas.',
      );
    case CODIGO_ERRO_LI.estacionamentoEmConflito:
      return falha(
        'A conta está sendo atualizada por outra operação neste momento. Tente de novo em instantes.',
        { manterToken: true, recarregarStatus: true, cor: 'yellow' },
      );
    case CODIGO_ERRO_LI.chamadasDesligadas:
      // The backend's read switch is not the exact `on`: the state of every
      // environment until the cutover, and after it a mis-set value (`ON`,
      // ` on`, `true`) answers the same code — so the copy names both causes.
      // Nothing was sent or written, so the token goes (hygiene default —
      // resending it cannot help until the switch is fixed) and the status on
      // screen still stands.
      return falha(
        'As chamadas à Loja Integrada estão desligadas neste backend: até a migração para este ' +
          'sistema, ou por configuração. Nada foi enviado à Loja Integrada nem salvo. Se a ' +
          'migração já ocorreu, avise o suporte.',
        { cor: 'orange' },
      );
    case CODIGO_ERRO_LI.corpoInvalido:
      return falha(
        'O backend recusou a requisição como malformada' +
          (err.campos.length === 0 ? '' : ` (campos: ${resumirCampos(err.campos)})`) +
          '. Atualize a página; se continuar, avise o suporte.',
      );
    case CODIGO_ERRO_LI.idInvalido:
      return falha('O endereço desta página não traz um id de conta válido. Volte à lista.');
    default:
      return null;
  }
}

/**
 * The copy for a failed save, renewal or removal — or `null` when the error is
 * not one this module knows, which the caller RETHROWS (root `CLAUDE.md` rule 6).
 *
 * ⚠️ MOST-DERIVED FIRST: {@link LojaIntegradaClientRespostaInvalidaError} extends
 * {@link LojaIntegradaClientHttpError}, so testing the base first would report a
 * 2xx this build cannot read as an ordinary failure — and a 2xx means the write
 * most likely LANDED.
 */
export function descreverFalhaCredencialLi(err: unknown): FalhaCredencialLi | null {
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) {
    // The backend answered 2xx: the write most likely happened. The token is
    // not needed again, and the status must be re-read to show what is stored.
    return falha(err.message, { recarregarStatus: true });
  }
  if (err instanceof LojaIntegradaClientHttpError) {
    const porCodigo = falhaPorCodigo(err);
    if (porCodigo !== null) return porCodigo;
    if (err.status === 499) {
      return falha(
        'A validação foi interrompida antes de terminar. Nada foi salvo. Tente de novo.',
        {
          manterToken: true,
          cor: 'yellow',
        },
      );
    }
    if (err.status === 401) {
      return falha(
        'O backend da Loja Integrada não aceitou sua sessão (HTTP 401). Recarregue a página e ' +
          'entre de novo.',
      );
    }
    if (err.status === 403) {
      return falha('Você não tem permissão para alterar a credencial desta conta.');
    }
    if (err.status >= 500) {
      // A 5xx can come AFTER the write (an aviso failing once the credential is
      // stored), so what is stored is unknown: re-read it before anything else.
      return falha(
        `O backend da Loja Integrada falhou (HTTP ${String(err.status)}). O token pode ou não ter ` +
          'sido salvo: confira a situação acima antes de tentar de novo.',
        { recarregarStatus: true },
      );
    }
    return falha(err.message);
  }
  if (err instanceof LojaIntegradaClientNetworkError) {
    return falha(MENSAGEM_REDE, { manterToken: true, cor: 'yellow' });
  }
  if (err instanceof FirebaseError) {
    // `getIdToken()` failed before any request: nothing reached the backend.
    return falha(
      'Não foi possível confirmar sua sessão para falar com o backend da Loja Integrada. ' +
        'Recarregue a página e entre de novo.',
    );
  }
  return null;
}

export interface FalhaStatusLi {
  readonly mensagem: string;
  /** Whether offering "Tentar novamente" for the same read could plausibly help. */
  readonly repetivel: boolean;
}

/**
 * The copy for a failed STATUS read, plus whether a retry is worth offering.
 * TOTAL by contract: the panel renders it in a `RetryAlert` and has nowhere to
 * rethrow to, so every input produces copy (an unknown error gets a generic,
 * non-repeatable sentence).
 */
export function descreverFalhaStatusLi(err: unknown): FalhaStatusLi {
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) {
    return { mensagem: err.message, repetivel: false };
  }
  if (err instanceof LojaIntegradaClientHttpError) {
    if (err.code === CODIGO_ERRO_LI.credencialInvalida) {
      return {
        mensagem:
          'A credencial salva desta conta está ilegível' +
          (err.campos.length === 0 ? '' : ` (campos: ${resumirCampos(err.campos)})`) +
          '. Remova o token (botão abaixo) e salve-o de novo.',
        repetivel: false,
      };
    }
    if (err.code === CODIGO_ERRO_LI.contaNaoEncontrada) {
      return {
        mensagem:
          'O backend da Loja Integrada não encontrou esta conta (ou ela não é uma conta da Loja ' +
          'Integrada).',
        repetivel: false,
      };
    }
    // A 4xx is a verdict about this request and will answer the same way
    // again; a 5xx may not. `501` is as permanent as a 4xx.
    return { mensagem: err.message, repetivel: err.status >= 500 && err.status !== 501 };
  }
  if (err instanceof LojaIntegradaClientNetworkError) {
    return {
      mensagem: 'Não foi possível contatar o backend da Loja Integrada.',
      repetivel: true,
    };
  }
  if (err instanceof FirebaseError) {
    return {
      mensagem: 'Não foi possível confirmar sua sessão. Recarregue a página.',
      repetivel: true,
    };
  }
  return { mensagem: 'Não foi possível consultar a credencial desta conta.', repetivel: false };
}
