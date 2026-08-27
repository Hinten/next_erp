'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { PERM } from '@delfrance/auth';
import { usePermission } from '@/lib/auth';
import { useConfirmDialog } from './ConfirmDialog';
import { ReembolsoParcialModal } from './ReembolsoParcialModal';
import {
  formatarPrazo,
  legendaTipoReclamacao,
  rotuloAcao,
  rotuloPapel,
  rotuloResolucaoEsperada,
  rotuloEtapaReclamacao,
  rotuloStatusExpectativa,
  rotuloStatusReclamacao,
} from '@/lib/mercado-livre/reclamacaoLabels';

/**
 * The live Mercado Livre state of one claim, rendered inside its incidente card
 * (#364).
 *
 * ---- ⚠️ **Why the Incidentes tab and not the chat thread.** A claim whose
 * seller has no send action left — exactly the state where refund, allow-return
 * and mediation are all that remain — gets **no conversa at all**:
 * `claimImport.ts` returns `skipped: 'sem-conversa-acionavel'` and creates
 * nothing. Buttons on the thread would therefore be missing precisely when they
 * matter. The incidente exists for every claim, at a deterministic id, and
 * already carries `externalId`.
 *
 * ---- ⚠️ **Collapsed until asked.** Expanding issues up to three ML calls, so a
 * pedido with several incidentes must not fan out on render. `enabled` is the
 * gate; `staleTime: 0` is the rule below.
 *
 * ---- ⚠️ **Nothing here is cacheable.** `acoesDisponiveis` is ML's answer to
 * "what may this seller do right now" and it empties as the claim closes, so a
 * remembered list offers a button ML has already withdrawn. `staleTime: 0` +
 * `gcTime: 0` — the same rule `EtiquetaComprarModal` follows for a balance.
 */
export interface ReclamacaoMlPanelProps {
  /** The ML claim id, off the incidente's `externalId`. */
  claimId: number;
  /** The ML account the pedido came through. */
  integracaoId: string;
}

/**
 * The verbs that need no amount, so one confirmation is the whole flow.
 *
 * ⚠️ The confirm copy states the CONSEQUENCE, not the verb. "Confirmar
 * reembolso?" tells an operator nothing they did not already know; "the full
 * amount goes back to the buyer and the claim closes, and this cannot be undone
 * from the ERP" is the sentence that makes them stop and read.
 *
 * ⚠️ `verbos` is a LIST because ML publishes two verbs for one outcome —
 * `allow_return` and `allow_return_label`, depending on whether it mints a
 * return label. The operator is taking the same decision either way.
 */
const ACOES_SIMPLES = [
  {
    acao: 'reembolso' as const,
    verbos: ['refund'],
    rotulo: 'Reembolsar integralmente',
    confirmar: 'Confirmar reembolso integral',
    cor: 'red',
    titulo: 'Reembolsar o valor integral?',
    mensagem:
      'O valor integral volta para o comprador e a reclamação é encerrada no Mercado Livre. Não é possível desfazer pelo ERP.',
  },
  {
    acao: 'aceitar_devolucao' as const,
    verbos: ['allow_return', 'allow_return_label'],
    rotulo: 'Aceitar devolução',
    confirmar: 'Confirmar devolução',
    cor: 'orange',
    titulo: 'Aceitar a devolução do produto?',
    mensagem:
      'O Mercado Livre gera a etiqueta de devolução e reembolsa o comprador quando o envio for postado ou entregue. Não é possível desfazer pelo ERP.',
  },
  {
    acao: 'abrir_mediacao' as const,
    verbos: ['open_dispute'],
    rotulo: 'Abrir mediação',
    confirmar: 'Confirmar abertura de mediação',
    cor: 'grape',
    titulo: 'Abrir mediação do Mercado Livre?',
    mensagem:
      'Um mediador do Mercado Livre passa a decidir o caso, e as mensagens diretas ao comprador deixam de ser aceitas — a conversa passa a ser com o mediador. Não é possível desfazer pelo ERP.',
  },
];

type AcaoSimples = (typeof ACOES_SIMPLES)[number];

/** Verbs this panel renders a button for; the rest still show as badges. */
/**
 * Verbs that ALWAYS render a button when offered. Partial refund is deliberately
 * absent: its button also needs offers to pick from, so whether it appears is
 * decided per render — and when it does not, the verb must still show as a badge
 * or the panel silently stops reporting that ML offers it.
 */
const VERBOS_COM_BOTAO = new Set(ACOES_SIMPLES.flatMap((a) => a.verbos));

export function ReclamacaoMlPanel({ claimId, integracaoId }: ReclamacaoMlPanelProps) {
  const client = useMercadoLivreClient();
  const queryClient = useQueryClient();
  const { confirm, element: confirmEl } = useConfirmDialog();
  // ⚠️ TWO bits, and they answer different questions. `read` gates whether the
  // panel exists at all; `write` gates whether it offers buttons. An operator may
  // legitimately hold the first without the second.
  const { allowed: podeConsultar } = usePermission(PERM.incidenteResolucao.read);
  const { allowed: podeExecutar } = usePermission(PERM.incidenteResolucao.write);
  const [aberto, setAberto] = useState(false);
  const [executando, setExecutando] = useState<AcaoSimples['acao'] | null>(null);
  const [acaoErro, setAcaoErro] = useState<string | null>(null);
  const [parcialAberto, setParcialAberto] = useState(false);
  const [enviandoParcial, setEnviandoParcial] = useState(false);
  const [parcialErro, setParcialErro] = useState<string | null>(null);

  const estado = useQuery({
    queryKey: ['mlReclamacao', integracaoId, claimId],
    enabled: aberto && client != null,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => client!.reclamacaoEstado({ integracaoId, claimId }),
  });

  /**
   * Run one no-amount verb.
   *
   * ⚠️ **Writes NOTHING locally on success** — it invalidates and refetches
   * instead. The `claims` importer is the single writer of incidente state, so
   * the confirmation the operator sees is ML's own word: the button they just
   * used disappears because its verb left `available_actions`. Guessing the new
   * state here would race the importer and could disagree with it.
   */
  async function executar(a: AcaoSimples): Promise<void> {
    if (client == null) return;
    const ok = await confirm({
      title: a.titulo,
      message: a.mensagem,
      // ⚠️ Deliberately DIFFERENT from the panel button. The operator must be
      // clicking the modal, not repeating a muscle-memory click on the same
      // label they just pressed.
      confirmLabel: a.confirmar,
      cancelLabel: 'Cancelar',
    });

    if (!ok) return;

    setAcaoErro(null);
    setExecutando(a.acao);
    try {
      await client.reclamacaoAcao({ integracaoId, claimId, acao: a.acao });
      await queryClient.invalidateQueries({ queryKey: ['mlReclamacao', integracaoId, claimId] });
    } catch (err) {
      // ⚠️ Narrow, then show the message verbatim. The backend's 409 body is the
      // only thing that tells the operator what to do next.
      if (err instanceof MercadoLivreClientHttpError) {
        setAcaoErro(err.message);
      } else if (err instanceof MercadoLivreClientNetworkError) {
        setAcaoErro('Não foi possível falar com o Mercado Livre. Tente novamente.');
      } else if (err instanceof FirebaseError) {
        // ⚠️ **The one failure that would render NOTHING.** `useMercadoLivreClient`
        // passes `getAuthToken: () => user.getIdToken()`, and `call()` awaits it
        // OUTSIDE its own try (`client.ts:1132`) — so a failed token refresh
        // (`auth/network-request-failed`, `auth/user-token-expired`) is neither ML
        // error class. Left to `throw err` it becomes an unhandled rejection in a
        // `void`-ed handler, and `apps/web` installs no `unhandledrejection`
        // listener: the operator confirms an IRREVERSIBLE refund, the spinner
        // stops, no alert appears, the button looks untouched — so they click
        // again. `ChatComposer.tsx:419` carries this same branch for the same
        // reason. (The read path is safe; TanStack Query captures it.)
        setAcaoErro(err.message);
      } else {
        throw err;
      }
    } finally {
      setExecutando(null);
    }
  }
  // ⚠️ Gate BEFORE rendering the surface, the convention `EstoqueSyncTab` and
  // `CheckoutTab` follow (apps/web `CLAUDE.md` rule 5). Without this the panel was
  // not "invisible without the grant" as its PR claimed — every operator who can
  // open the pedido saw "Ver situação e ações", and clicking it burned an ML round
  // trip to have `verifyCaller` answer 403 into a red alert. The route is still the
  // enforcement; this only stops offering an action nobody can take.
  // Derived once: the guard and the formatter must agree (see the ⚠️ below).
  const prazosFormatados = (estado.data?.prazos ?? [])
    .map((p) => ({ ...p, texto: formatarPrazo(p.prazo) }))
    .filter((p) => p.texto != null);

  // ⚠️ The picker needs BOTH: the verb, and offers to pick from. Without the
  // second half the operator gets a button whose modal only says ML offers no
  // partial refund — the dead end the comment below claims is prevented.
  const mostraBotaoParcial =
    (estado.data?.acoesDisponiveis.includes('allow_partial_refund') ?? false) &&
    (estado.data?.ofertasParciais?.available_offers.length ?? 0) > 0;

  if (!podeConsultar) return null;

  /**
   * Commit the chosen partial refund.
   *
   * ⚠️ Sends the AMOUNT as the authority plus the percentage the operator saw.
   * The backend refuses the request outright if either is missing, so ML's 50%
   * default has no path to fire even if this component were bypassed.
   */
  async function confirmarParcial(escolha: {
    valorReembolsoMinor: number;
    percentualExibido: number;
  }): Promise<void> {
    if (client == null) return;
    setParcialErro(null);
    setEnviandoParcial(true);
    try {
      await client.reclamacaoAcao({
        integracaoId,
        claimId,
        acao: 'reembolso_parcial',
        valorReembolsoMinor: escolha.valorReembolsoMinor,
        percentualExibido: escolha.percentualExibido,
      });
      setParcialAberto(false);
      await queryClient.invalidateQueries({ queryKey: ['mlReclamacao', integracaoId, claimId] });
    } catch (err) {
      // ⚠️ The modal STAYS OPEN on a refusal. A 409 here names the percentages ML
      // does offer, and closing would throw that away along with the operator's
      // place in the list.
      if (err instanceof MercadoLivreClientHttpError) {
        setParcialErro(err.message);
      } else if (err instanceof MercadoLivreClientNetworkError) {
        setParcialErro('Não foi possível falar com o Mercado Livre. Tente novamente.');
      } else if (err instanceof FirebaseError) {
        // ⚠️ Same hole as `executar`, and worse here: this commit moves a chosen
        // SUM. `getIdToken()` is awaited outside the client's try
        // (`client.ts:1132`), so a failed token refresh is neither ML error class
        // and would rethrow out of a `void`-ed handler into nothing. The modal
        // would close its spinner with no message over a picker the operator
        // already acknowledged.
        setParcialErro(err.message);
      } else {
        throw err;
      }
    } finally {
      setEnviandoParcial(false);
    }
  }

  if (!aberto) {
    return (
      <Card withBorder mt="xs" padding="xs" bg="var(--mantine-color-default-hover)">
        <Group justify="space-between" gap="xs">
          <Text size="xs" c="dimmed">
            Reclamação Mercado Livre #{claimId}
          </Text>
          <Button size="compact-xs" variant="light" onClick={() => setAberto(true)}>
            Ver situação e ações
          </Button>
        </Group>
      </Card>
    );
  }

  return (
    <Card withBorder mt="xs" padding="sm" bg="var(--mantine-color-default-hover)">
      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <Text size="sm" fw={500}>
              Reclamação #{claimId}
            </Text>
            {estado.data?.status && (
              <Badge size="sm" variant="light">
                {rotuloStatusReclamacao(estado.data.status)}
              </Badge>
            )}
            {estado.data?.stage && (
              <Badge size="sm" variant="light" color="grape">
                {rotuloEtapaReclamacao(estado.data.stage)}
              </Badge>
            )}
          </Group>
          <Button
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
              Consultando o Mercado Livre…
            </Text>
          </Group>
        )}

        {estado.isError && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            {/* ⚠️ Verbatim. The backend's 409 body names what the operator can do
                next; paraphrasing it loses exactly that. */}
            {estado.error instanceof Error
              ? estado.error.message
              : 'Não foi possível consultar a reclamação.'}
          </Alert>
        )}

        {estado.data && (
          <>
            {/* ⚠️ Filter on the FORMATTED value, not on `prazo != null`. The two
                disagree: `formatarPrazo` returns null for a non-null string it
                cannot parse, and React renders null as nothing — so the guard
                passed and the row survived with a blank date. A mandatory action
                showing no clock is worse than `Invalid Date`, which is the very
                thing `formatarPrazo` was written to avoid. */}
            {legendaTipoReclamacao(estado.data.tipoReclamacao) && (
              <Text size="xs" c="dimmed">
                {legendaTipoReclamacao(estado.data.tipoReclamacao)}
              </Text>
            )}

            {/* ---- What each side wants. This comes BEFORE any action, because
                choosing between refund, return and partial without it is
                guessing. */}
            <Stack gap={2}>
              <Text size="xs" fw={500}>
                O que cada parte espera
              </Text>
              {estado.data.expectativasIndisponiveis && (
                <Text size="xs" c="dimmed" fs="italic">
                  Não foi possível ler o que cada parte espera.
                </Text>
              )}
              {!estado.data.expectativasIndisponiveis &&
                (estado.data.expectativas?.length ?? 0) === 0 && (
                  <Text size="xs" c="dimmed">
                    Nenhuma expectativa registrada no Mercado Livre.
                  </Text>
                )}
              {estado.data.expectativas?.map((e, i) => (
                <Text size="xs" key={`${e.playerRole ?? 'x'}-${String(i)}`}>
                  {rotuloPapel(e.playerRole)}:{' '}
                  <b>{rotuloResolucaoEsperada(e.expectedResolution)}</b> (
                  {rotuloStatusExpectativa(e.status)})
                </Text>
              ))}
            </Stack>

            {/* ---- The SLA clock, only when ML actually set one. */}
            {prazosFormatados.length > 0 && (
              <Stack gap={2}>
                <Text size="xs" fw={500}>
                  Prazos
                </Text>
                {prazosFormatados.map((p) => (
                  <Text size="xs" key={p.acao}>
                    {rotuloAcao(p.acao)}: {p.texto}
                    {p.obrigatoria && (
                      <Badge size="xs" color="orange" variant="light" ml={6}>
                        obrigatória
                      </Badge>
                    )}
                  </Text>
                ))}
              </Stack>
            )}

            {/* ---- What ML still allows. ⚠️ Rendered from the LIVE list, and a
                verb ML did not offer is ABSENT rather than disabled: a greyed-out
                "Reembolsar" invites a support ticket asking why. */}
            <Stack gap={4}>
              <Text size="xs" fw={500}>
                Ações disponíveis no Mercado Livre
              </Text>
              {estado.data.acoesDisponiveis.length === 0 ? (
                <Text size="xs" c="dimmed">
                  {estado.data.motivoSemMensagem ??
                    'O Mercado Livre não oferece nenhuma ação nesta reclamação.'}
                </Text>
              ) : !podeExecutar ? (
                // The gate is `verifyCaller` on the backend; this is only so the
                // operator learns WHY there are no buttons rather than assuming
                // the claim is closed.
                <Text size="xs" c="dimmed">
                  Você não tem permissão para resolver reclamações. Ações disponíveis:{' '}
                  {estado.data.acoesDisponiveis.map(rotuloAcao).join(', ')}.
                </Text>
              ) : (
                <Group gap="xs">
                  {ACOES_SIMPLES.filter((a) =>
                    a.verbos.some((v) => estado.data.acoesDisponiveis.includes(v)),
                  ).map((a) => (
                    <Button
                      key={a.acao}
                      size="compact-xs"
                      variant="light"
                      color={a.cor}
                      loading={executando === a.acao}
                      disabled={executando !== null || estado.isFetching}
                      onClick={() => void executar(a)}
                    >
                      {a.rotulo}
                    </Button>
                  ))}
                  {/* ⚠️ Partial refund is the ONE verb behind a picker rather
                      than a plain confirm: ML accepts only percentages from its
                      own offer list and reads a MISSING one as 50%. The button
                      appears only when ML offers the verb AND actually returned
                      offers — a picker with nothing to pick is a dead end. The
                      condition now checks BOTH; it used to test only the verb,
                      so the comment described a guard that was not there. When
                      the offers are missing the verb falls through to a badge
                      below, which keeps "ML offers something this screen cannot
                      do" visible instead of silently dropping it. */}
                  {mostraBotaoParcial && (
                    <Button
                      size="compact-xs"
                      variant="light"
                      color="red"
                      disabled={executando !== null}
                      onClick={() => {
                        setAcaoErro(null);
                        setParcialAberto(true);
                      }}
                    >
                      Reembolso parcial…
                    </Button>
                  )}
                  {/* Verbs with no button yet still show, so the operator can
                      see ML offers something this screen cannot do. */}
                  {estado.data.acoesDisponiveis
                    .filter(
                      (v) =>
                        !VERBOS_COM_BOTAO.has(v) &&
                        !(v === 'allow_partial_refund' && mostraBotaoParcial),
                    )
                    .map((v) => (
                      <Badge key={v} size="sm" variant="outline">
                        {rotuloAcao(v)}
                      </Badge>
                    ))}
                </Group>
              )}
              {acaoErro !== null && (
                <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
                  {/* ⚠️ Verbatim, again. A 409 from this route names the real
                      reason — "ML no longer offers that", "not eligible", "no
                      access" — and each one tells the operator something
                      different to do next. */}
                  {acaoErro}
                </Alert>
              )}
            </Stack>
          </>
        )}
      </Stack>
      {confirmEl}
      {/* ⚠️ UNMOUNTED when closed, not merely hidden. Mantine's `opened` only
          toggles the overlay, so a mounted modal keeps its `useState` — and
          closing then reopening restored both the selection AND the
          acknowledgement, arming confirm with one click on a consent given in an
          earlier session of the dialog. Worse, `cienteDe` is keyed on the
          PERCENTAGE, so the amount behind it was re-derived from whatever
          `available_offers` says now: the same-percentage-different-amount case
          the `cienteDe` refactor exists to close, still open across a reopen.
          Unmounting makes the reset structural — no effect, nothing to remember. */}
      {parcialAberto && (
        <ReembolsoParcialModal
          opened={parcialAberto}
          onClose={() => setParcialAberto(false)}
          ofertas={estado.data?.ofertasParciais?.available_offers ?? []}
          recomendacoes={estado.data?.ofertasParciais?.recommendations ?? []}
          restricoes={estado.data?.ofertasParciais?.restrictions ?? []}
          carregando={estado.isFetching}
          enviando={enviandoParcial}
          erro={parcialErro}
          onConfirm={(e) => void confirmarParcial(e)}
        />
      )}
    </Card>
  );
}
