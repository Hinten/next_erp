'use client';

/**
 * The variation linker's reads of a Loja Integrada store's catalogue (master
 * plan step 10): the store's grade list and one grade's options, as React Query
 * hooks over the backend client, plus the linker's OWN copy for every way such a
 * read fails ({@link descreverFalhaCatalogoLi}).
 *
 * The category and brand reads come with their first screen (step 11).
 *
 * ## When a read happens
 *
 * Only while the linker's tab is the active one (`habilitado`), so opening a
 * variation group makes no catalogue read at all; and never without a client.
 * A failure is shown, never retried behind the operator (`retry: false`), and
 * nothing refreshes in the background (`refetchOnReconnect: false`; focus
 * refetch is off app-wide).
 *
 * ## Freshness
 *
 * The backend caches each list for 15 minutes and stamps every answer with when
 * the STORE was read (`lidaEmMs`). The browser counts its own freshness from that
 * same instant ({@link staleTimeDoCatalogoLi}), never from when the answer
 * arrived, so a copy the backend served from its cache 14 minutes in is fresh
 * here for one more minute — the two caches never stack.
 *
 * "Atualizar" asks the backend for a fresh read of the store (`atualizar: true`)
 * exactly once; the next automatic read is a plain one again.
 */
import { useRef } from 'react';
import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { nowMillis } from '@delfrance/core/datetime';
import { CODIGO_ERRO_LI, type RespostaGradeLi, type RespostaGradesLi } from '@delfrance/schemas';

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
  type LojaIntegradaClient,
  type MotivoBackendLiIndisponivel,
  type OpcoesCatalogoLi,
  useBackendLojaIntegrada,
} from './client';

/** How long a copy stays fresh in the browser, counted from `lidaEmMs`: 15 min. */
export const VALIDADE_CATALOGO_LI_MS = 15 * 60_000;

/**
 * The React Query `staleTime` of a catalogue answer read from the store at
 * `lidaEmMs`, at `agoraMs`: what is left of {@link VALIDADE_CATALOGO_LI_MS}, never
 * negative. No data yet ⇒ 0.
 */
export function staleTimeDoCatalogoLi(lidaEmMs: number | undefined, agoraMs: number): number {
  if (lidaEmMs === undefined) return 0;
  return Math.max(0, lidaEmMs + VALIDADE_CATALOGO_LI_MS - agoraMs);
}

/** The query key of a conta's grade list. */
export function chaveGradesLi(contaId: string) {
  return ['loja-integrada', 'catalogo', contaId, 'grades'] as const;
}

/** The query key of one grade of a conta. */
export function chaveGradeLi(contaId: string, gradeId: number) {
  return ['loja-integrada', 'catalogo', contaId, 'grade', gradeId] as const;
}

export interface OpcoesLeituraCatalogoLi {
  /** Whether the read may run: the linker's tab is the active one. */
  readonly habilitado: boolean;
}

export interface LeituraCatalogoLi<T> {
  /** The answer, or `undefined` while there is none. */
  readonly dados: T | undefined;
  /** A first read is in flight. */
  readonly carregando: boolean;
  /** Any read (the first, or an "Atualizar") is in flight. */
  readonly lendo: boolean;
  /** The last read's failure, or `null`. Describe it with {@link descreverFalhaCatalogoLi}. */
  readonly erro: unknown;
  /** Why there is no client although someone is logged in, else `null`. */
  readonly indisponivel: MotivoBackendLiIndisponivel | null;
  /** Read the store again NOW, bypassing the backend's cached copy. */
  readonly atualizar: () => void;
  /** The underlying query, for its tests. */
  readonly consulta: UseQueryResult<T>;
}

function useLeituraCatalogoLi<T extends { readonly lidaEmMs: number }>(
  queryKey: readonly unknown[],
  ler: (client: LojaIntegradaClient, opcoes: OpcoesCatalogoLi) => Promise<T>,
  habilitado: boolean,
): LeituraCatalogoLi<T> {
  const { client, indisponivel } = useBackendLojaIntegrada();
  // Set by "Atualizar", consumed by the very next read — so a fresh read is
  // asked for once, and a later automatic read never inherits it.
  const proximaFresca = useRef(false);
  const consulta = useQuery({
    queryKey,
    queryFn:
      client === null
        ? skipToken
        : ({ signal }) => {
            const atualizar = proximaFresca.current;
            proximaFresca.current = false;
            return ler(client, { atualizar, sinal: signal });
          },
    enabled: habilitado,
    retry: false,
    refetchOnReconnect: false,
    staleTime: (q) => staleTimeDoCatalogoLi(q.state.data?.lidaEmMs, nowMillis()),
  });
  return {
    dados: consulta.data,
    carregando: consulta.isLoading,
    lendo: consulta.isFetching,
    erro: consulta.error,
    indisponivel,
    atualizar: () => {
      if (client === null) return;
      proximaFresca.current = true;
      void consulta.refetch();
    },
    consulta,
  };
}

/** The store's grade list for the conta, while `habilitado`. */
export function useGradesLi(
  contaId: string,
  opcoes: OpcoesLeituraCatalogoLi,
): LeituraCatalogoLi<RespostaGradesLi> {
  return useLeituraCatalogoLi(
    chaveGradesLi(contaId),
    (client, leitura) => client.grades(contaId, leitura),
    opcoes.habilitado,
  );
}

/** One grade of the conta and its options, while `habilitado`. */
export function useGradeLi(
  contaId: string,
  gradeId: number,
  opcoes: OpcoesLeituraCatalogoLi,
): LeituraCatalogoLi<RespostaGradeLi> {
  return useLeituraCatalogoLi(
    chaveGradeLi(contaId, gradeId),
    (client, leitura) => client.grade(contaId, gradeId, leitura),
    opcoes.habilitado,
  );
}

/** A Mantine colour name, which is what the linker's `Alert` takes. */
export type CorDaFalhaCatalogoLi = 'red' | 'yellow' | 'orange';

export interface FalhaCatalogoLi {
  /** What to show the operator — pt-BR, saying what to DO. */
  readonly mensagem: string;
  readonly cor: CorDaFalhaCatalogoLi;
  /** Whether reading again could plausibly help (offer "Tentar de novo"). */
  readonly repetivel: boolean;
}

const falha = (mensagem: string, cor: CorDaFalhaCatalogoLi, repetivel: boolean) => ({
  mensagem,
  cor,
  repetivel,
});

/** The stored links stay usable whatever the read answered. */
const VINCULOS_CONTINUAM =
  'Os vínculos já guardados aparecem abaixo e podem ser editados e salvos.';

/** The copy for a coded envelope, or `null` when this code has none of its own. */
function falhaPorCodigo(err: LojaIntegradaClientHttpError): FalhaCatalogoLi | null {
  if (err.code === null) return null;
  switch (err.code) {
    case CODIGO_ERRO_LI.chamadasDesligadas:
      // The backend's read switch is not the exact `on`: every environment until
      // the migration, and after it a switch turned off or mis-set — the same
      // code, so the copy names both causes (as the credential copy does).
      return falha(
        'As listas da Loja Integrada não podem ser lidas agora: as chamadas estão desligadas ' +
          'neste backend (até a migração para este sistema, ou por configuração; se a migração ' +
          `já ocorreu, avise o suporte). ${VINCULOS_CONTINUAM}`,
        'yellow',
        false,
      );
    case CODIGO_ERRO_LI.gradeAusenteNaLoja:
      return falha(
        'Esta grade não existe mais na Loja Integrada (ou o token desta conta é de outra loja). ' +
          'O vínculo guardado continua abaixo: remova-o se a grade foi excluída no painel.',
        'orange',
        false,
      );
    case CODIGO_ERRO_LI.catalogoExcedeLimite:
      return falha(
        'A loja tem mais grades do que esta tela consegue ler de uma vez; nada foi cortado, a ' +
          'lista inteira foi recusada. Avise o suporte.',
        'red',
        false,
      );
    case CODIGO_ERRO_LI.recursoNaoPermitido:
      return falha(
        'A Loja Integrada não permitiu ler esta lista com o token desta conta (HTTP 403). ' +
          'Confira as permissões do token no painel da Loja Integrada.',
        'red',
        false,
      );
    case CODIGO_ERRO_LI.reconexaoPendente:
      return falha(
        'A Loja Integrada recusou o token desta conta. Reconecte-a em Canais › Loja Integrada.',
        'orange',
        false,
      );
    case CODIGO_ERRO_LI.credencialAusente:
      return falha(
        'Esta conta não tem um token salvo. Salve um Personal Token em Canais › Loja Integrada.',
        'orange',
        false,
      );
    case CODIGO_ERRO_LI.credencialInvalida:
      return falha(
        'A credencial salva desta conta está ilegível. Remova o token e salve-o de novo em ' +
          'Canais › Loja Integrada.',
        'red',
        false,
      );
    case CODIGO_ERRO_LI.contaNaoEncontrada:
      return falha(
        'O backend da Loja Integrada não encontrou esta conta (ou ela não é uma conta da Loja ' +
          'Integrada).',
        'red',
        false,
      );
    case CODIGO_ERRO_LI.contaInativa:
      return falha('Esta conta da Loja Integrada está inativa.', 'orange', false);
    case CODIGO_ERRO_LI.estacionamentoEmConflito:
      return falha(
        'A conta está sendo atualizada por outra operação neste momento. Tente de novo em ' +
          'instantes.',
        'yellow',
        true,
      );
    case CODIGO_ERRO_LI.limiteDeChamadas:
      return falha(
        'A Loja Integrada limitou as chamadas desta loja agora. Tente de novo em um minuto.',
        'yellow',
        true,
      );
    case CODIGO_ERRO_LI.tempoEsgotadoLoja:
      return falha(
        'A Loja Integrada demorou demais para responder. Tente de novo.',
        'yellow',
        true,
      );
    case CODIGO_ERRO_LI.lojaIndisponivel:
      return falha(
        'A Loja Integrada não respondeu como esperado (fora do ar, ou uma resposta ilegível). ' +
          'Tente de novo em instantes.',
        'yellow',
        true,
      );
    case CODIGO_ERRO_LI.idInvalido:
      return falha('O id da conta ou da grade não é válido.', 'red', false);
    default:
      return null;
  }
}

/**
 * The copy for a failed catalogue read. TOTAL by contract: the linker renders it
 * in an `Alert` and has nowhere to rethrow to, so every input produces copy (an
 * unknown error gets a generic, non-repeatable sentence).
 *
 * ⚠️ Keyed on the backend's `code`, never on the status alone; a 404 with NO
 * code is a backend older than these routes. MOST-DERIVED class first: a 2xx
 * this build cannot read is also an HTTP error, and a deadline is also a
 * network error.
 */
export function descreverFalhaCatalogoLi(err: unknown): FalhaCatalogoLi {
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) {
    return falha(err.message, 'red', false);
  }
  if (err instanceof LojaIntegradaClientHttpError) {
    const porCodigo = falhaPorCodigo(err);
    if (porCodigo !== null) return porCodigo;
    if (err.code === null && err.status === 404) {
      return falha(
        'O backend da Loja Integrada é anterior a esta tela: este backend ainda não oferece a ' +
          `leitura das grades da loja. ${VINCULOS_CONTINUAM}`,
        'yellow',
        false,
      );
    }
    if (err.status === 401) {
      return falha(
        'O backend da Loja Integrada não aceitou sua sessão (HTTP 401). Recarregue a página e ' +
          'entre de novo.',
        'red',
        false,
      );
    }
    if (err.status === 403) {
      return falha(
        'Você está sem permissão para ler a loja: o seu cargo precisa da permissão de leitura ' +
          'de Integrações.',
        'red',
        false,
      );
    }
    if (err.status === 499) {
      return falha('A leitura foi interrompida antes de terminar. Tente de novo.', 'yellow', true);
    }
    return falha(err.message, 'red', err.status >= 500 && err.status !== 501);
  }
  if (err instanceof LojaIntegradaClientTempoEsgotadoError) {
    return falha(
      'O backend da Loja Integrada não respondeu a tempo. Tente de novo.',
      'yellow',
      true,
    );
  }
  if (err instanceof LojaIntegradaClientNetworkError) {
    return falha(
      'Não foi possível contatar o backend da Loja Integrada (falha de rede). Tente de novo.',
      'yellow',
      true,
    );
  }
  if (err instanceof FirebaseError) {
    return falha(
      'Não foi possível confirmar sua sessão. Recarregue a página e entre de novo.',
      'red',
      true,
    );
  }
  return falha('Não foi possível ler as listas da Loja Integrada.', 'red', false);
}

/** The copy when this page may not talk to the backend at all. */
export function mensagemBackendCatalogoIndisponivel(motivo: MotivoBackendLiIndisponivel): string {
  return motivo === 'inseguro'
    ? 'Esta página é servida por https e o endereço do backend da Loja Integrada deste build é ' +
        'http: as listas da loja não são lidas por uma conexão sem criptografia. ' +
        VINCULOS_CONTINUAM
    : 'O endereço do backend da Loja Integrada deste build não é um endereço http(s) válido. ' +
        VINCULOS_CONTINUAM;
}
