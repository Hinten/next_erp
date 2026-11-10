'use client';

/**
 * The product imports (master plan step 9) in `/canais/loja-integrada`'s action
 * rail, right under the button that starts them: one card per conta.
 *
 * ## Which contas
 *
 * Every conta the action started (or tried to start) this session, then every
 * conta selected in the table. A selected conta is how an operator finds an
 * import started elsewhere — another tab, another operator, before a reload:
 * the backend's list route answers a conta's newest jobs (`useImportacoesLi`,
 * once per view), so there is nothing to remember in the browser. A conta with
 * no import yet shows nothing.
 *
 * ## Which job, per conta
 *
 * - **A start this session wins** over the list: it is the job the operator
 *   just asked for (a busy start's 409 included — the action attached to it).
 * - Otherwise the list's NEWEST job. The list is re-read after every start, so
 *   a start's job and the newest one are normally the same.
 * - **A failed start shows BESIDE the job card, never instead of it** — the
 *   Shopee rule: the fan-out's ledger keeps one entry per conta, so a failed
 *   re-start replaces the started entry there, and the card falls back to the
 *   list's newest job, which still names it.
 * - **Dismissing a job card hides that job** for this session; a newer job of
 *   the same conta (a new start, the list's next newest) shows again.
 *   Dismissing a failed start's card forgets only the failure.
 *
 * Nothing here polls by itself: each job card owns its polling query
 * (`CartaoImportacaoLi.tsx`), because hooks cannot be looped over a dynamic
 * list.
 */
import { useCallback, useState } from 'react';
import { Badge, Card, Stack, Text } from '@mantine/core';

import { ContaJobErrorCard } from '@/components/contaJobs/JobCardShell';
import { RetryAlert } from '@/components/feedback/RetryAlert';
import {
  descreverFalhaLeituraImportacaoLi,
  useImportacoesLi,
} from '@/lib/loja-integrada/importacao';
import type { ContaJobOutcome, ContaRef } from '@/lib/marketplace/contaJobs/types';
import { queryRetry } from '@/lib/query/queryRetry';
import {
  type AlvoResultadoImportacaoLi,
  CartaoImportacaoLi,
  ROTULO_IMPORTACAO_PRODUTOS_LI,
} from './CartaoImportacaoLi';

/** What the panel needs from the action hook. */
export interface FluxoDoPainelLi {
  readonly entries: readonly ContaJobOutcome[];
  readonly reatados: ReadonlySet<string>;
  readonly dismiss: (contaId: string) => void;
}

export interface ImportacoesLiPanelProps {
  readonly collapsed: boolean;
  /** The rows checked in the table — each shows its newest import. */
  readonly selecionadas: readonly ContaRef[];
  readonly importacao: FluxoDoPainelLi;
  /** The viewer may cancel (`PERM.integracao.write`). */
  readonly podeCancelar: boolean;
  /** Opens an ended job's result (the result view). Absent ⇒ no card offers a way in. */
  readonly onAbrirResultado?: (alvo: AlvoResultadoImportacaoLi) => void;
}

/**
 * The contas with a card, in a stable order: the ones this session started
 * (the ledger's order), then the selected ones not already there.
 */
export function contasDoPainelLi(
  entries: readonly ContaJobOutcome[],
  selecionadas: readonly ContaRef[],
): ContaRef[] {
  const contas = new Map<string, ContaRef>();
  for (const e of entries) if (!contas.has(e.conta.id)) contas.set(e.conta.id, e.conta);
  for (const c of selecionadas) if (!contas.has(c.id)) contas.set(c.id, c);
  return [...contas.values()];
}

export function ImportacoesLiPanel({
  collapsed,
  selecionadas,
  importacao,
  podeCancelar,
  onAbrirResultado,
}: ImportacoesLiPanelProps) {
  const [dispensados, setDispensados] = useState<ReadonlySet<string>>(new Set());
  const { entries, reatados, dismiss } = importacao;

  const dispensarJob = useCallback(
    (contaId: string, jobId: string) => {
      // A failure in the ledger is the card BESIDE this one, dismissed on its own.
      const entrada = entries.find((e) => e.conta.id === contaId);
      if (entrada?.kind === 'started' && entrada.jobId === jobId) dismiss(contaId);
      setDispensados((cur) => new Set(cur).add(jobId));
    },
    [entries, dismiss],
  );

  // The collapsed rail is an icon strip: only the session's count fits, and only
  // when there is something to count.
  if (collapsed) {
    if (entries.length === 0) return null;
    return (
      <Badge
        size="sm"
        circle
        variant="filled"
        aria-label={`${String(entries.length)} importação(ões) de produtos no painel`}
      >
        {entries.length}
      </Badge>
    );
  }

  const contas = contasDoPainelLi(entries, selecionadas);
  if (contas.length === 0) return null;

  return (
    <Stack gap="xs" role="region" aria-label="Importações de produtos">
      {contas.map((conta) => (
        <ImportacoesDaContaLi
          key={conta.id}
          conta={conta}
          entrada={entries.find((e) => e.conta.id === conta.id) ?? null}
          reatados={reatados}
          dispensados={dispensados}
          podeCancelar={podeCancelar}
          onDismissFalha={() => dismiss(conta.id)}
          onDismissJob={(jobId) => dispensarJob(conta.id, jobId)}
          onAbrirResultado={onAbrirResultado}
        />
      ))}
    </Stack>
  );
}

/** One conta's cards: a failed start (if any), then its job. */
function ImportacoesDaContaLi({
  conta,
  entrada,
  reatados,
  dispensados,
  podeCancelar,
  onDismissFalha,
  onDismissJob,
  onAbrirResultado,
}: {
  conta: ContaRef;
  entrada: ContaJobOutcome | null;
  reatados: ReadonlySet<string>;
  dispensados: ReadonlySet<string>;
  podeCancelar: boolean;
  onDismissFalha: () => void;
  onDismissJob: (jobId: string) => void;
  onAbrirResultado: ((alvo: AlvoResultadoImportacaoLi) => void) | undefined;
}) {
  const lista = useImportacoesLi(conta.id);
  const importacoes = lista.dados?.importacoes ?? [];
  // Only a STARTED entry shadows the list: a failure falls through to it.
  const jobId =
    (entrada?.kind === 'started' ? entrada.jobId : undefined) ?? importacoes[0]?.jobId ?? null;
  const visivel = jobId !== null && !dispensados.has(jobId);

  return (
    <>
      {entrada?.kind === 'error' && (
        <ContaJobErrorCard
          conta={conta}
          flowLabel={ROTULO_IMPORTACAO_PRODUTOS_LI}
          color={entrada.color}
          message={entrada.message}
          onDismiss={onDismissFalha}
        />
      )}
      {visivel ? (
        <CartaoImportacaoLi
          // The jobId is in the key: a NEW job for the same conta is a new card
          // with a fresh query, never the old one re-pointed.
          key={jobId}
          conta={conta}
          jobId={jobId}
          jobDaLista={importacoes.find((j) => j.jobId === jobId) ?? null}
          reatado={reatados.has(jobId)}
          podeCancelar={podeCancelar}
          onDismiss={() => onDismissJob(jobId)}
          onAbrirResultado={onAbrirResultado}
        />
      ) : (
        jobId === null && lista.erro != null && <FalhaDaListaLi conta={conta} leitura={lista} />
      )}
    </>
  );
}

/**
 * The conta's list could not be read, and there is no job to show instead.
 * No X: the card belongs to the selection, and leaves with it. A backend older
 * than the import lands here too, with its own copy.
 */
function FalhaDaListaLi({
  conta,
  leitura,
}: {
  conta: ContaRef;
  leitura: ReturnType<typeof useImportacoesLi>;
}) {
  const falha = descreverFalhaLeituraImportacaoLi(leitura.erro);
  const retry = queryRetry(leitura.consulta);
  return (
    <Card withBorder padding="xs">
      <Stack gap={4}>
        <Text size="sm" fw={600} lineClamp={1} title={conta.nome}>
          {conta.nome}
        </Text>
        <Text size="xs" c="dimmed">
          {ROTULO_IMPORTACAO_PRODUTOS_LI}
        </Text>
        <RetryAlert
          variant="compact"
          color="yellow"
          message={falha.mensagem}
          onRetry={falha.repetivel ? retry.retry : undefined}
          retrying={retry.retrying}
        />
      </Stack>
    </Card>
  );
}
