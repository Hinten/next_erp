'use client';

/**
 * Live progress for the two Mercado Livre bulk jobs, rendered inside the
 * TableView's action rail (#816) right under the buttons that start them.
 *
 * It shows a card for a conta when EITHER source has a job for it:
 *  - a start this session (the action hooks' per-conta outcome ledger), or
 *  - the running-job lookup (`GET jobs-em-andamento`), which is what closes
 *    the reload gap: both jobs are durable server-side checkpoints, but their
 *    `jobId` only ever lived in React state, so a refresh used to orphan a
 *    running job with no way back to it. The contas that have a card are
 *    remembered in `sessionStorage`, so a reload re-queries them and the cards
 *    come back with no click.
 *
 * Two rules the merge depends on:
 *  - **Latch, never un-render.** The lookup is running-only (that is what lets
 *    it ride the existing `(integracaoId, status)` indexes). Once a job has
 *    been seen, its card keeps polling by `jobId` — otherwise the terminal
 *    "concluída" card would vanish the moment the job left `running`.
 *  - **Dismissal is keyed by `jobId`, not by conta.** So a dismissed card stays
 *    dismissed across refetches, while a NEW job for the same conta still
 *    shows up.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import {
  type MercadoLivreMassImportStatus,
  type MercadoLivrePriceSyncStatus,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { ContaJobErrorCard, MassImportJobCard, PriceSyncJobCard } from './MercadoLivreJobCards';
import type { ContaJobOutcome, ContaRef } from './startJobsForContas';

/** Survives a reload; scoped to the tab, like the jobs the operator is watching. */
const TRACKED_STORAGE_KEY = 'delfrance:ml:jobs:tracked';

/**
 * The lookup is cheap (two indexed equality queries) but it is not a poller —
 * a job's own card polls it. This only has to be fresh enough to catch a job
 * started in another tab when the operator comes back to this one.
 */
const LOOKUP_STALE_MS = 15_000;

interface FlowState {
  readonly entries: readonly ContaJobOutcome[];
  readonly dismiss: (contaId: string) => void;
}

interface DiscoveredJob<S> {
  readonly jobId: string;
  readonly initialStatus: S;
}

interface Discovered {
  readonly massImport: Readonly<Record<string, DiscoveredJob<MercadoLivreMassImportStatus>>>;
  readonly priceSync: Readonly<Record<string, DiscoveredJob<MercadoLivrePriceSyncStatus>>>;
}

const NO_JOBS: Discovered = { massImport: {}, priceSync: {} };

export function MercadoLivreJobsPanel({
  collapsed,
  selecionadas,
  massImport,
  priceSync,
}: {
  collapsed: boolean;
  /** The rows checked in the table — progress follows the selection. */
  selecionadas: readonly ContaRef[];
  massImport: FlowState;
  priceSync: FlowState;
}) {
  const client = useMercadoLivreClient();
  const [discovered, setDiscovered] = useState<Discovered>(NO_JOBS);
  const [dismissedJobIds, setDismissedJobIds] = useState<ReadonlySet<string>>(new Set());
  // Read once, at mount, straight into the initial state. Hydration-safe
  // because a restored id changes no output on the first paint: it only feeds
  // the lookup's query key, and a card needs the lookup to have answered.
  const [restored] = useState<readonly ContaRef[]>(readTrackedContas);

  // Contas worth asking about: the current selection, anything started this
  // session, and whatever the previous page load was watching.
  const tracked = useMemo(() => {
    const byId = new Map<string, ContaRef>();
    for (const conta of [
      ...selecionadas,
      ...massImport.entries.map((e) => e.conta),
      ...priceSync.entries.map((e) => e.conta),
      ...restored,
    ]) {
      if (!byId.has(conta.id)) byId.set(conta.id, conta);
    }
    return byId;
  }, [selecionadas, massImport.entries, priceSync.entries, restored]);

  // Sorted so the query key is stable regardless of selection order.
  const trackedIds = useMemo(() => [...tracked.keys()].sort(), [tracked]);

  const lookup = useQuery({
    queryKey: ['ml-jobs-atuais', trackedIds.join(',')],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.jobsEmAndamento({ integracaoIds: trackedIds });
    },
    enabled: Boolean(client) && trackedIds.length > 0,
    retry: false,
    staleTime: LOOKUP_STALE_MS,
  });

  // Latch every newly-seen job. Never drops one: see the docblock. This is
  // the one place a setState-in-effect is right — the lookup is an external
  // system whose answers accumulate here, and the merge is a no-op (returns
  // `prev`) for a job already latched, so it settles after one pass.
  useEffect(() => {
    const data = lookup.data;
    if (!data) return;
    setDiscovered((prev) => {
      const massImportJobs = { ...prev.massImport };
      const priceSyncJobs = { ...prev.priceSync };
      let changed = false;
      for (const job of data.importacoes) {
        if (massImportJobs[job.integracaoId]?.jobId === job.jobId) continue;
        massImportJobs[job.integracaoId] = { jobId: job.jobId, initialStatus: job };
        changed = true;
      }
      for (const job of data.enviosPreco) {
        if (priceSyncJobs[job.integracaoId]?.jobId === job.jobId) continue;
        priceSyncJobs[job.integracaoId] = { jobId: job.jobId, initialStatus: job };
        changed = true;
      }
      return changed ? { massImport: massImportJobs, priceSync: priceSyncJobs } : prev;
    });
  }, [lookup.data]);

  const cards = useMemo(
    () => buildCards({ tracked, discovered, dismissedJobIds, massImport, priceSync }),
    [tracked, discovered, dismissedJobIds, massImport, priceSync],
  );

  // Persist exactly the contas that HAVE a card — which is also what prunes
  // the restored list: a remembered conta whose job is gone simply stops being
  // written back. Clearing the key is gated on a successful lookup, so the
  // first render (before the lookup answers) cannot wipe what we just
  // restored, and neither can a lookup that failed.
  const lookupSettled = trackedIds.length === 0 || lookup.isSuccess;
  useEffect(() => {
    const contas = dedupeById(cards.map((c) => c.conta));
    if (contas.length > 0) {
      window.sessionStorage.setItem(TRACKED_STORAGE_KEY, JSON.stringify(contas));
    } else if (lookupSettled) {
      window.sessionStorage.removeItem(TRACKED_STORAGE_KEY);
    }
  }, [cards, lookupSettled]);

  const dismiss = useCallback(
    (flow: 'massImport' | 'priceSync', contaId: string, jobId: string | null) => {
      if (jobId) setDismissedJobIds((prev) => new Set(prev).add(jobId));
      setDiscovered((prev) => {
        if (!(contaId in prev[flow])) return prev;
        const next = { ...prev[flow] };
        delete next[contaId];
        return { ...prev, [flow]: next };
      });
      (flow === 'massImport' ? massImport : priceSync).dismiss(contaId);
    },
    [massImport, priceSync],
  );

  if (cards.length === 0) {
    // A lookup that cannot reach the backend is reported quietly: it says
    // nothing about the jobs themselves, and an Alert here would shout on
    // every page load whenever apps/mercado-livre is down.
    if (!collapsed && lookup.error != null) {
      return (
        <Text size="xs" c="dimmed">
          Não foi possível consultar os jobs em andamento.
        </Text>
      );
    }
    return null;
  }

  if (collapsed) {
    return (
      <Badge size="sm" circle variant="filled" aria-label={`${cards.length} job(s) em andamento`}>
        {cards.length}
      </Badge>
    );
  }

  return (
    <Stack gap="xs" role="region" aria-label="Jobs em andamento">
      {cards.map((card) =>
        card.kind === 'error' ? (
          <ContaJobErrorCard
            key={`${card.flow}-${card.conta.id}`}
            conta={card.conta}
            flowLabel={card.flowLabel}
            color={card.color}
            message={card.message}
            onDismiss={() => dismiss(card.flow, card.conta.id, null)}
          />
        ) : card.flow === 'massImport' ? (
          <MassImportJobCard
            key={`massImport-${card.conta.id}`}
            conta={card.conta}
            jobId={card.jobId}
            initialStatus={card.initialStatus}
            onDismiss={() => dismiss('massImport', card.conta.id, card.jobId)}
          />
        ) : (
          <PriceSyncJobCard
            key={`priceSync-${card.conta.id}`}
            conta={card.conta}
            jobId={card.jobId}
            initialStatus={card.initialStatus}
            onDismiss={() => dismiss('priceSync', card.conta.id, card.jobId)}
          />
        ),
      )}
    </Stack>
  );
}

const FLOW_LABEL = {
  massImport: 'Importação em massa',
  priceSync: 'Envio de preços',
} as const;

type Flow = keyof typeof FLOW_LABEL;

type Card =
  | {
      kind: 'error';
      flow: Flow;
      flowLabel: string;
      conta: ContaRef;
      color: 'yellow' | 'red';
      message: string;
    }
  | {
      kind: 'massImport';
      flow: 'massImport';
      conta: ContaRef;
      jobId: string;
      initialStatus?: MercadoLivreMassImportStatus;
    }
  | {
      kind: 'priceSync';
      flow: 'priceSync';
      conta: ContaRef;
      jobId: string;
      initialStatus?: MercadoLivrePriceSyncStatus;
    };

/**
 * One card per (conta, flow) that has something to show. A start from this
 * session wins over the lookup: it is the newer fact, and it is the only
 * source that can report a conta whose job never started at all.
 */
function buildCards({
  tracked,
  discovered,
  dismissedJobIds,
  massImport,
  priceSync,
}: {
  tracked: ReadonlyMap<string, ContaRef>;
  discovered: Discovered;
  dismissedJobIds: ReadonlySet<string>;
  massImport: FlowState;
  priceSync: FlowState;
}): Card[] {
  const massImportByConta = new Map(massImport.entries.map((e) => [e.conta.id, e]));
  const priceSyncByConta = new Map(priceSync.entries.map((e) => [e.conta.id, e]));
  const cards: Card[] = [];

  for (const [contaId, conta] of tracked) {
    const started = massImportByConta.get(contaId);
    if (started?.kind === 'error') {
      cards.push({
        kind: 'error',
        flow: 'massImport',
        flowLabel: FLOW_LABEL.massImport,
        conta,
        color: started.color,
        message: started.message,
      });
    } else if (started?.kind === 'started') {
      cards.push({ kind: 'massImport', flow: 'massImport', conta, jobId: started.jobId });
    } else {
      const found = discovered.massImport[contaId];
      if (found && !dismissedJobIds.has(found.jobId)) {
        cards.push({
          kind: 'massImport',
          flow: 'massImport',
          conta,
          jobId: found.jobId,
          initialStatus: found.initialStatus,
        });
      }
    }

    const sent = priceSyncByConta.get(contaId);
    if (sent?.kind === 'error') {
      cards.push({
        kind: 'error',
        flow: 'priceSync',
        flowLabel: FLOW_LABEL.priceSync,
        conta,
        color: sent.color,
        message: sent.message,
      });
    } else if (sent?.kind === 'started') {
      cards.push({ kind: 'priceSync', flow: 'priceSync', conta, jobId: sent.jobId });
    } else {
      const found = discovered.priceSync[contaId];
      if (found && !dismissedJobIds.has(found.jobId)) {
        cards.push({
          kind: 'priceSync',
          flow: 'priceSync',
          conta,
          jobId: found.jobId,
          initialStatus: found.initialStatus,
        });
      }
    }
  }

  return cards;
}

function dedupeById(contas: readonly ContaRef[]): ContaRef[] {
  const byId = new Map(contas.map((c) => [c.id, c]));
  return [...byId.values()];
}

/** Tolerant read of the persisted watch list — a corrupt value is just no list. */
function readTrackedContas(): ContaRef[] {
  // Runs during the initial render, which also happens on the server.
  if (typeof window === 'undefined') return [];
  const raw = window.sessionStorage.getItem(TRACKED_STORAGE_KEY);
  if (!raw) return [];
  return parseContaRefs(raw);
}

function parseContaRefs(raw: string): ContaRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return [];
    throw err;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (item === null || typeof item !== 'object') return [];
    const { id, nome } = item as { id?: unknown; nome?: unknown };
    if (typeof id !== 'string' || id.length === 0) return [];
    return [{ id, nome: typeof nome === 'string' && nome.length > 0 ? nome : id }];
  });
}
