'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';

import { PERM } from '@delfrance/auth';
import { usePermission } from '@/lib/auth';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
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

export function ReclamacaoMlPanel({ claimId, integracaoId }: ReclamacaoMlPanelProps) {
  const client = useMercadoLivreClient();
  const { allowed: podeConsultar } = usePermission(PERM.incidenteResolucao.read);
  const [aberto, setAberto] = useState(false);

  const estado = useQuery({
    queryKey: ['mlReclamacao', integracaoId, claimId],
    enabled: aberto && client != null,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => client!.reclamacaoEstado({ integracaoId, claimId }),
  });

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

  if (!podeConsultar) return null;

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
            <Stack gap={2}>
              <Text size="xs" fw={500}>
                Ações disponíveis no Mercado Livre
              </Text>
              {estado.data.acoesDisponiveis.length === 0 ? (
                <Text size="xs" c="dimmed">
                  {estado.data.motivoSemResposta ??
                    'O Mercado Livre não oferece nenhuma ação nesta reclamação.'}
                </Text>
              ) : (
                <Group gap="xs">
                  {estado.data.acoesDisponiveis.map((a) => (
                    <Badge key={a} size="sm" variant="outline">
                      {rotuloAcao(a)}
                    </Badge>
                  ))}
                </Group>
              )}
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  );
}
