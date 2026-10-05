'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';

import { PERM } from '@delfrance/auth';
import { centavosDeReais, formatReais } from '@delfrance/core/money';
import { usePermission } from '@/lib/auth';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  useShopeeClient,
  type ReclamacaoAcaoShopeeInput,
} from '@/lib/shopee/client';
import {
  rotuloMotivoDevolucaoShopee,
  rotuloPendenciaForaDoErp,
  rotuloPrazo,
  rotuloSolucaoDevolucao,
  rotuloStatusCompensacao,
  rotuloStatusDevolucaoShopee,
  rotuloStatusNegociacao,
  rotuloStatusProva,
  rotuloTipoRequisicao,
} from '@/lib/shopee/reclamacaoLabels';
import {
  ACAO_RECLAMACAO_SHOPEE,
  type AcaoReclamacaoShopee,
  type ShopeeReclamacaoAcaoResposta,
  type ShopeeReclamacaoEstado,
  type SolucaoDevolucaoShopee,
} from '@/lib/shopee/wire';
import { useConfirmDialog } from './ConfirmDialog';
import { OfertaDevolucaoShopeeModal } from './OfertaDevolucaoShopeeModal';

/**
 * The live Shopee state of one return, rendered inside its incidente card
 * (#1525, step 17) — the Shopee twin of `ReclamacaoMlPanel`, on the same
 * discipline.
 *
 * ---- ⚠️ **Collapsed until asked.** Expanding costs the backend one or two
 * Shopee calls (`get_return_detail`, plus `get_available_solutions` for a
 * return still open), so a pedido with several returns must not fan out on
 * render. `enabled` is the gate.
 *
 * ---- ⚠️ **Nothing here is cacheable.** `acoesDisponiveis` is the backend's
 * answer to "what may the seller do right now", and it changes the moment the
 * buyer counter-offers or Shopee moves the return on. `staleTime: 0` +
 * `gcTime: 0` override the app's 30-second default (`QUERY_DEFAULT_OPTIONS`):
 * a remembered list offers a button Shopee has already withdrawn.
 *
 * ---- ⚠️ **The web holds NO availability rule (#1369).** Every button comes
 * from the backend's `acoesDisponiveis`, which `devolucoes/estadoDevolucao.ts`
 * computes from the live detail — request type, validation type, status,
 * negotiation. Recomputing any of it here would be the second copy that drifts.
 * A listed code this build has no button for renders as a badge, so "Shopee
 * offers something this screen cannot do" stays visible. The same holds for
 * the Seller Centre lines: `pendenciasForaDoErp` is the backend's list, this
 * panel only labels it.
 *
 * ---- ⚠️ **Writes nothing locally.** An action invalidates the estado and
 * refetches; the returns importer is the single writer of the incidente, and
 * the card updates through its own snapshot once the synthetic code 29 the
 * route enqueues is imported.
 */
export interface ReclamacaoShopeePanelProps {
  /** The Shopee conta the pedido came through. */
  integracaoId: string;
  /**
   * The pedido the operator is LOOKING AT — sent on every action as the
   * cross-check (R-15): the backend refuses (409 `pedido-divergente`) when the
   * return's order maps to another pedido. ⚠️ Never the estado's own `pedidoId`,
   * which is derived from the return and would agree with itself.
   */
  pedidoId: string;
  /** The Shopee `return_sn`, off the incidente's `externalId`. */
  returnSn: string;
}

/** The query key — per RETURN, so two returns on one pedido never share state. */
function chaveDoEstado(integracaoId: string, returnSn: string) {
  return ['shopeeReclamacao', integracaoId, returnSn] as const;
}

/**
 * The panel's own button copy, by action code. A `Map` because the codes come
 * off the wire: `'constructor'` must not resolve to a function.
 */
const ROTULO_ACAO: ReadonlyMap<string, string> = new Map(
  (
    [
      [ACAO_RECLAMACAO_SHOPEE.confirmar, 'Reembolsar sem devolução'],
      [ACAO_RECLAMACAO_SHOPEE.aceitarOferta, 'Aceitar proposta do comprador'],
      [ACAO_RECLAMACAO_SHOPEE.ofertar, 'Fazer proposta'],
    ] as const satisfies readonly (readonly [AcaoReclamacaoShopee, string])[]
  ).map(([acao, rotulo]): [string, string] => [acao, rotulo]),
);

/** A listed code this build has no copy for comes back raw, never blank. */
function rotuloAcao(acao: string): string {
  return ROTULO_ACAO.get(acao) ?? acao;
}

/** What one confirmation says, and the exact body it commits to. */
interface PedidoConfirmado {
  readonly titulo: string;
  readonly mensagem: string;
  readonly confirmar: string;
  readonly input: ReclamacaoAcaoShopeeInput;
}

interface Alvo {
  readonly integracaoId: string;
  readonly pedidoId: string;
  readonly returnSn: string;
}

/** The amount as displayed, and the same amount as the echo the backend checks. */
function exibido(valor: number | null): { texto: string | null; minor: number | null } {
  // ⚠️ ONE conversion for both halves: `formatReais` and `centavosDeReais`
  // round through the same `roundReais`, so the sentence the operator reads and
  // the `valorExibidoMinor` the route compares cannot disagree by a centavo.
  return valor == null
    ? { texto: null, minor: null }
    : { texto: formatReais(valor), minor: centavosDeReais(valor) };
}

/**
 * The two actions that need no input beyond a confirmation.
 *
 * ⚠️ The copy states the CONSEQUENCE, with the amount in it — "the buyer keeps
 * the product and Shopee refunds R$ x" is the sentence that makes an operator
 * stop; "Confirmar?" is not. `confirmar` is deliberately DIFFERENT from the
 * panel button, so the commit is a click on the dialog, never a repeated
 * muscle-memory click on the label just pressed.
 *
 * ⚠️ `montar` derives the sentence AND the "what you saw" echo from ONE estado
 * snapshot, taken before the dialog opens. The backend re-reads the return live
 * and refuses (409 `valor-mudou` / `proposta-mudou`) when it no longer matches —
 * so a buyer counter-offer landing between the read and the click is never
 * accepted unseen (R-15).
 */
const ACOES_COM_CONFIRMACAO: readonly {
  readonly acao:
    | typeof ACAO_RECLAMACAO_SHOPEE.confirmar
    | typeof ACAO_RECLAMACAO_SHOPEE.aceitarOferta;
  readonly cor: string;
  readonly montar: (d: ShopeeReclamacaoEstado, alvo: Alvo) => PedidoConfirmado;
}[] = [
  {
    acao: ACAO_RECLAMACAO_SHOPEE.confirmar,
    cor: 'red',
    montar: (d, alvo) => {
      const v = exibido(d.valorReembolso);
      return {
        titulo: v.texto
          ? `Reembolsar ${v.texto} sem pedir o produto de volta?`
          : 'Reembolsar sem pedir o produto de volta?',
        mensagem: `A Shopee reembolsa ${v.texto ?? 'o valor da devolução'} ao comprador, que fica com o produto, e a devolução passa a aceita. Não é possível desfazer pelo ERP.`,
        confirmar: v.texto ? `Confirmar reembolso de ${v.texto}` : 'Confirmar reembolso',
        input: { ...alvo, acao: ACAO_RECLAMACAO_SHOPEE.confirmar, valorExibidoMinor: v.minor },
      };
    },
  },
  {
    acao: ACAO_RECLAMACAO_SHOPEE.aceitarOferta,
    cor: 'orange',
    montar: (d, alvo) => {
      const v = exibido(d.negociacao?.valorOfertado ?? null);
      const solucao: SolucaoDevolucaoShopee | null = d.negociacao?.solucaoOfertada ?? null;
      const proposta = solucao ? `"${rotuloSolucaoDevolucao(solucao)}"` : 'uma solução';
      return {
        titulo: 'Aceitar a proposta do comprador?',
        mensagem: `O comprador propôs ${proposta}${v.texto ? ` com reembolso de ${v.texto}` : ''}. Ao aceitar, a Shopee aplica essa solução. Não é possível desfazer pelo ERP.`,
        confirmar: v.texto ? `Aceitar proposta de ${v.texto}` : 'Aceitar a proposta',
        input: {
          ...alvo,
          acao: ACAO_RECLAMACAO_SHOPEE.aceitarOferta,
          valorExibidoMinor: v.minor,
          solucaoExibida: solucao,
        },
      };
    },
  },
];

type AcaoComConfirmacao = (typeof ACOES_COM_CONFIRMACAO)[number];

/**
 * Said when the outcome of an action is UNKNOWN — the request may have reached
 * Shopee. ⚠️ A gateway timeout reaches the browser as a network error (no CORS
 * headers on the platform's 504), so "falhou" would be a lie that invites the
 * repeat; the operator is told to look before acting again.
 */
export const FRASE_DESFECHO_INCERTO =
  'A resposta da Shopee não chegou — a ação pode ter sido feita. Clique em Atualizar e confira antes de repetir.';

/** Said when the estado READ cannot reach the backend. */
const FRASE_LEITURA_SEM_REDE =
  'Não foi possível falar com a integração da Shopee. Clique em Atualizar para tentar de novo.';

/** How the panel reacts to one failed action. */
export interface FalhaDaAcaoShopee {
  /** The sentence shown inline — the backend's own, verbatim, whenever it sent one. */
  readonly mensagem: string;
  /** Refetch the estado (the action list, the bounds or the status may have moved). */
  readonly invalidar: boolean;
  /** The request may have been carried out: never offer the same click as a retry. */
  readonly incerto: boolean;
}

/**
 * The two 5xx codes of the `reclamacao/acao` route whose outcome IS known —
 * nothing was carried out at Shopee. Matched EXACTLY: a code this set does not
 * name, absent or garbled included, falls to the unknown-outcome side, which
 * is the side that can only cost a refresh.
 *
 * - `SHOPEE_RECLAMACAO_FALHA_SHOPEE` (502): Shopee ANSWERED the write with an
 *   error envelope the route's classifier does not know — a refusal.
 * - `SHOPEE_REFRESH_EM_ANDAMENTO` (503): another instance holds the token
 *   lease; the route gives up while acquiring a token, before the write's
 *   request is built.
 */
const CODIGOS_5XX_DE_DESFECHO_CONHECIDO: ReadonlySet<string> = new Set([
  'SHOPEE_RECLAMACAO_FALHA_SHOPEE',
  'SHOPEE_REFRESH_EM_ANDAMENTO',
]);

/**
 * Narrow one action failure (root rule 6). `null` = not an error this panel
 * knows — the caller rethrows it.
 *
 * - ⚠️ {@link ShopeeClientRespostaInvalidaError} FIRST: it is a SUBCLASS of
 *   the HTTP error, and its status is the backend's 2xx — the route answers
 *   2xx only after Shopee accepted, so the outcome is unknown, not refused.
 * - ⚠️ {@link ShopeeClientHttpError} with a status >= 500 is an UNKNOWN outcome
 *   unless its code is in {@link CODIGOS_5XX_DE_DESFECHO_CONHECIDO}. The route
 *   answers a 5xx AFTER the write may have reached Shopee: 503
 *   `SHOPEE_NETWORK_ERROR` (the socket died after the request left), 502
 *   `SHOPEE_BAD_RESPONSE` (Shopee answered 2xx with a body we cannot read), 502
 *   `SHOPEE_HTTP_ERROR`, and a bare 500 with no envelope at all (a rethrown
 *   bug, a gateway). Read as a refusal, each one re-armed the button with
 *   "tente novamente" — the second refund or the second proposal (#1525 R4 F1).
 * - Any other {@link ShopeeClientHttpError}: the backend's sentence verbatim (a
 *   409 names the next step). 409 and 5xx refetch — the list or the bounds
 *   changed.
 * - {@link ShopeeClientNetworkError}: outcome unknown; refetch, NEVER retry.
 * - `FirebaseError`: ⚠️ the one failure that would otherwise render NOTHING.
 *   `getAuthToken()` is awaited OUTSIDE the client's try (`client.ts`), so a
 *   failed token refresh is none of the client's classes; rethrown from a
 *   `void`-ed handler it becomes an unhandled rejection with no alert, after an
 *   irreversible confirm — and the operator clicks again. The request was never
 *   sent, so the message is shown as-is.
 */
export function falhaDaAcaoShopee(err: unknown): FalhaDaAcaoShopee | null {
  if (err instanceof ShopeeClientRespostaInvalidaError) {
    return { mensagem: FRASE_DESFECHO_INCERTO, invalidar: true, incerto: true };
  }
  if (err instanceof ShopeeClientHttpError) {
    if (err.status >= 500 && !CODIGOS_5XX_DE_DESFECHO_CONHECIDO.has(err.code ?? '')) {
      return { mensagem: FRASE_DESFECHO_INCERTO, invalidar: true, incerto: true };
    }
    return {
      mensagem: err.message,
      invalidar: err.status === 409 || err.status >= 500,
      incerto: false,
    };
  }
  if (err instanceof ShopeeClientNetworkError) {
    return { mensagem: FRASE_DESFECHO_INCERTO, invalidar: true, incerto: true };
  }
  if (err instanceof FirebaseError) {
    return { mensagem: err.message, invalidar: false, incerto: false };
  }
  return null;
}

/**
 * A deadline in the operator's own wall clock, or `null` when there is nothing
 * honest to show — the row is then dropped (ML's lesson: filter on the
 * FORMATTED value, never on `!= null`, or a row survives with a blank date).
 */
function formatarPrazoMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The success toast; `atualizacao` only changes the sentence. */
function avisarSucesso(r: ShopeeReclamacaoAcaoResposta): void {
  notifications.show({
    color: 'green',
    message:
      r.atualizacao === 'nao-enfileirada'
        ? 'Enviado à Shopee. O incidente se atualiza quando a Shopee notificar a mudança.'
        : 'Enviado à Shopee.',
  });
}

export function ReclamacaoShopeePanel({
  integracaoId,
  pedidoId,
  returnSn,
}: ReclamacaoShopeePanelProps) {
  const client = useShopeeClient();
  const queryClient = useQueryClient();
  const { confirm, element: confirmEl } = useConfirmDialog();
  // ⚠️ TWO bits, two questions: `read` decides whether the panel exists at all,
  // `write` whether it offers buttons. An operator may hold the first alone.
  const { allowed: podeConsultar } = usePermission(PERM.incidenteResolucao.read);
  const { allowed: podeExecutar } = usePermission(PERM.incidenteResolucao.write);
  const [aberto, setAberto] = useState(false);
  const [executando, setExecutando] = useState<AcaoComConfirmacao['acao'] | null>(null);
  const [acaoErro, setAcaoErro] = useState<string | null>(null);
  const [ofertaAberta, setOfertaAberta] = useState(false);
  const [enviandoOferta, setEnviandoOferta] = useState(false);
  const [ofertaErro, setOfertaErro] = useState<string | null>(null);

  const chave = chaveDoEstado(integracaoId, returnSn);
  const estado = useQuery({
    queryKey: chave,
    enabled: aberto && client != null,
    staleTime: 0,
    gcTime: 0,
    // Each read costs the backend one or two Shopee calls; the operator's
    // "Atualizar" is the retry, so a failed read is shown at once rather than
    // repeated behind a spinner.
    retry: false,
    queryFn: () => client!.reclamacaoEstado({ integracaoId, returnSn }),
  });

  async function invalidar(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: chave });
  }

  const alvo: Alvo = { integracaoId, pedidoId, returnSn };

  /** Run one confirm-only action on the snapshot the operator is looking at. */
  async function executar(a: AcaoComConfirmacao, dados: ShopeeReclamacaoEstado): Promise<void> {
    if (client == null) return;
    const pedido = a.montar(dados, alvo);
    const ok = await confirm({
      title: pedido.titulo,
      message: pedido.mensagem,
      confirmLabel: pedido.confirmar,
      cancelLabel: 'Cancelar',
    });
    if (!ok) return;

    setAcaoErro(null);
    setExecutando(a.acao);
    try {
      const resposta = await client.reclamacaoAcao(pedido.input);
      avisarSucesso(resposta);
      await invalidar();
    } catch (err) {
      const falha = falhaDaAcaoShopee(err);
      if (falha === null) throw err;
      setAcaoErro(falha.mensagem);
      if (falha.invalidar) await invalidar();
    } finally {
      setExecutando(null);
    }
  }

  /**
   * Commit the offer the modal assembled.
   *
   * ⚠️ A refusal keeps the modal OPEN with the verbatim sentence (and refetches,
   * so the bounds it shows are Shopee's current ones). An UNKNOWN outcome closes
   * it instead: a confirm button still armed under "may have been sent" is the
   * double proposal this panel exists to prevent, so the warning moves to the
   * panel, where the refetched state is.
   */
  async function confirmarOferta(escolha: {
    solucao: SolucaoDevolucaoShopee;
    valorReembolsoMinor?: number;
  }): Promise<void> {
    // ⚠️ The panel's own rule (`bloqueado` below), restated here: while the
    // estado's last read failed, the modal's list is the one from BEFORE the
    // failure — a proposal is irreversible, so it never leaves from a list the
    // panel would not let its own buttons use. The modal blocks it too
    // (`estadoComErro`); this is the backstop if that ever drifts.
    if (client == null || estado.isError) return;
    setOfertaErro(null);
    setAcaoErro(null);
    setEnviandoOferta(true);
    try {
      const resposta = await client.reclamacaoAcao({
        ...alvo,
        acao: ACAO_RECLAMACAO_SHOPEE.ofertar,
        solucao: escolha.solucao,
        // ⚠️ ABSENT, never `0`, for a non-adjustable solução: Shopee refuses an
        // amount there, and the route's body is strict.
        ...(escolha.valorReembolsoMinor === undefined
          ? {}
          : { valorReembolsoMinor: escolha.valorReembolsoMinor }),
      });
      setOfertaAberta(false);
      avisarSucesso(resposta);
      await invalidar();
    } catch (err) {
      const falha = falhaDaAcaoShopee(err);
      if (falha === null) throw err;
      if (falha.incerto) {
        setOfertaAberta(false);
        setAcaoErro(falha.mensagem);
      } else {
        setOfertaErro(falha.mensagem);
      }
      if (falha.invalidar) await invalidar();
    } finally {
      setEnviandoOferta(false);
    }
  }

  // ⚠️ Gate BEFORE rendering the surface (apps/web rule 5, the ML panel's
  // #1228 finding): without `read` there is no button to expand, so no Shopee
  // round trip ends in a 403. The route stays the enforcement.
  if (!podeConsultar) return null;

  if (!aberto) {
    return (
      <Card withBorder mt="xs" padding="xs" bg="var(--mantine-color-default-hover)">
        <Group justify="space-between" gap="xs">
          <Text size="xs" c="dimmed">
            Devolução Shopee #{returnSn}
          </Text>
          <Button type="button" size="compact-xs" variant="light" onClick={() => setAberto(true)}>
            Ver situação e ações
          </Button>
        </Group>
      </Card>
    );
  }

  const dados = estado.data;
  // Derived once: the guard and the formatter must agree (see formatarPrazoMs).
  const prazos = (dados?.prazos ?? [])
    .map((p) => ({ ...p, texto: formatarPrazoMs(p.prazoMs) }))
    .filter((p) => p.texto != null);
  const ocupado = executando !== null || enviandoOferta || estado.isFetching;
  // ⚠️ A failed REFETCH keeps the last data (TanStack does not drop it on an
  // error), so without `isError` the list from BEFORE the failure would stay
  // clickable beside the read-error alert — the remembered list the header
  // warns about. The buttons come back only with a read that succeeded.
  const bloqueado = ocupado || estado.isError;

  return (
    <Card withBorder mt="xs" padding="sm" bg="var(--mantine-color-default-hover)">
      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <Text size="sm" fw={500}>
              Devolução Shopee #{returnSn}
            </Text>
            {dados?.status && (
              <Badge size="sm" variant="light">
                {rotuloStatusDevolucaoShopee(dados.status)}
              </Badge>
            )}
            {dados?.solucao && (
              <Badge size="sm" variant="light" color="grape">
                {rotuloSolucaoDevolucao(dados.solucao)}
              </Badge>
            )}
          </Group>
          <Button
            type="button"
            size="compact-xs"
            variant="subtle"
            leftSection={<IconRefresh size={14} />}
            onClick={() => void estado.refetch()}
            loading={estado.isFetching}
          >
            Atualizar
          </Button>
        </Group>

        {estado.isPending && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              Consultando a Shopee…
            </Text>
          </Group>
        )}

        {estado.isError && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            {/* ⚠️ Verbatim: the backend's sentence names the next step. Only a
                transport failure is reworded — its message is the browser's
                ("Failed to fetch"), not ours. */}
            {estado.error instanceof ShopeeClientNetworkError
              ? FRASE_LEITURA_SEM_REDE
              : estado.error instanceof Error
                ? estado.error.message
                : 'Não foi possível consultar a devolução.'}
          </Alert>
        )}

        {dados && (
          <>
            {/* ---- Legends: labels of fields, never gates. They explain why a
                button the operator expected is missing, without deciding it. */}
            {dados.tipoRequisicao != null && dados.tipoRequisicao !== 0 && (
              <Text size="xs" c="dimmed">
                Tipo de devolução: {rotuloTipoRequisicao(dados.tipoRequisicao)}
              </Text>
            )}
            {dados.tipoValidacao === 'warehouse_validation' && (
              <Text size="xs" c="dimmed">
                Validação pelo armazém da Shopee — o reembolso direto não está disponível.
              </Text>
            )}

            <Stack gap={2}>
              <Text size="xs">
                Motivo: <b>{rotuloMotivoDevolucaoShopee(dados.motivo)}</b>
              </Text>
              {dados.motivoReavaliado != null && (
                <Text size="xs">
                  Motivo reavaliado pela Shopee:{' '}
                  <b>{rotuloMotivoDevolucaoShopee(dados.motivoReavaliado)}</b>
                </Text>
              )}
              {dados.valorReembolso != null && (
                <Text size="xs">Reembolso solicitado: {formatReais(dados.valorReembolso)}</Text>
              )}
              {dados.valorAntesDesconto != null && (
                <Text size="xs">
                  Valor antes do desconto: {formatReais(dados.valorAntesDesconto)}
                </Text>
              )}
            </Stack>

            {prazos.length > 0 && (
              <Stack gap={2}>
                <Text size="xs" fw={500}>
                  Prazos
                </Text>
                {prazos.map((p, i) => (
                  <Text size="xs" key={`${p.tipo}-${String(i)}`}>
                    {rotuloPrazo(p.tipo)}: {p.texto}
                    {p.reembolsoAutomatico && (
                      <Badge size="xs" color="orange" variant="light" ml={6}>
                        reembolso automático
                      </Badge>
                    )}
                  </Text>
                ))}
              </Stack>
            )}

            {dados.negociacao && (
              <Stack gap={2}>
                <Text size="xs" fw={500}>
                  Negociação: {rotuloStatusNegociacao(dados.negociacao.status)}
                </Text>
                {(dados.negociacao.solucaoOfertada != null ||
                  dados.negociacao.valorOfertado != null) && (
                  <Text size="xs">
                    Última proposta: {rotuloSolucaoDevolucao(dados.negociacao.solucaoOfertada)}
                    {dados.negociacao.valorOfertado != null &&
                      ` — ${formatReais(dados.negociacao.valorOfertado)}`}
                  </Text>
                )}
                {dados.negociacao.contrapropostasRestantes != null && (
                  <Text size="xs">
                    Contrapropostas restantes: {dados.negociacao.contrapropostasRestantes}
                  </Text>
                )}
              </Stack>
            )}

            {dados.prova?.status != null && (
              <Text size="xs">Evidências: {rotuloStatusProva(dados.prova.status)}</Text>
            )}

            {dados.compensacao && (
              <Text size="xs">
                Compensação: {rotuloStatusCompensacao(dados.compensacao.status)}
                {dados.compensacao.valor != null && ` — ${formatReais(dados.compensacao.valor)}`}
              </Text>
            )}

            {/* ---- What only the Seller Centre can do. The backend's list, this
                panel's sentences: a step the ERP cannot take is never a dead
                end, and never a rule recomputed here. */}
            {dados.pendenciasForaDoErp.length > 0 && (
              <Alert color="yellow" variant="light" p="xs">
                <Stack gap={2}>
                  {dados.pendenciasForaDoErp.map((c) => (
                    <Text size="xs" key={c}>
                      {rotuloPendenciaForaDoErp(c)}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}

            {/* ---- What Shopee still allows. ⚠️ From the LIVE list, and an
                action not listed is ABSENT rather than disabled: a greyed-out
                "Reembolsar" invites the question why. */}
            <Stack gap={4}>
              <Text size="xs" fw={500}>
                Ações disponíveis na Shopee
              </Text>
              {dados.acoesDisponiveis.length === 0 ? (
                <Text size="xs" c="dimmed">
                  {dados.motivoSemAcao ??
                    'A Shopee não oferece nenhuma ação a esta devolução agora.'}
                </Text>
              ) : !podeExecutar ? (
                <Text size="xs" c="dimmed">
                  Você não tem permissão para resolver reclamações. Ações disponíveis:{' '}
                  {dados.acoesDisponiveis.map(rotuloAcao).join(', ')}.
                </Text>
              ) : (
                <Group gap="xs">
                  {ACOES_COM_CONFIRMACAO.filter((a) => dados.acoesDisponiveis.includes(a.acao)).map(
                    (a) => (
                      <Button
                        type="button"
                        key={a.acao}
                        size="compact-xs"
                        variant="light"
                        color={a.cor}
                        loading={executando === a.acao}
                        disabled={bloqueado}
                        onClick={() => void executar(a, dados)}
                      >
                        {rotuloAcao(a.acao)}
                      </Button>
                    ),
                  )}
                  {dados.acoesDisponiveis.includes(ACAO_RECLAMACAO_SHOPEE.ofertar) && (
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="light"
                      color="grape"
                      disabled={bloqueado}
                      onClick={() => {
                        setAcaoErro(null);
                        setOfertaErro(null);
                        setOfertaAberta(true);
                      }}
                    >
                      {rotuloAcao(ACAO_RECLAMACAO_SHOPEE.ofertar)}…
                    </Button>
                  )}
                  {/* A code with no button in this build still shows. */}
                  {dados.acoesDisponiveis
                    .filter((c) => !ROTULO_ACAO.has(c))
                    .map((c) => (
                      <Badge key={c} size="sm" variant="outline">
                        {rotuloAcao(c)}
                      </Badge>
                    ))}
                </Group>
              )}
              {acaoErro !== null && (
                <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
                  {/* ⚠️ Verbatim: a 409 names the reason — the amount moved, the
                      buyer answered, the return is in dispute — and each one
                      asks for something different next. */}
                  {acaoErro}
                </Alert>
              )}
            </Stack>
          </>
        )}
      </Stack>
      {confirmEl}
      {/* ⚠️ UNMOUNTED when closed, not merely hidden: a mounted modal keeps its
          `useState`, and reopening would restore a selection AND an
          acknowledgement given in an earlier session of the dialog (the
          `ReembolsoParcialModal` scar). Unmounting makes the reset structural. */}
      {ofertaAberta && (
        <OfertaDevolucaoShopeeModal
          solucoes={dados?.solucoes ?? []}
          carregando={estado.isFetching}
          estadoComErro={estado.isError}
          enviando={enviandoOferta}
          erro={ofertaErro}
          onConfirm={(e) => void confirmarOferta(e)}
          onClose={() => setOfertaAberta(false)}
        />
      )}
    </Card>
  );
}
