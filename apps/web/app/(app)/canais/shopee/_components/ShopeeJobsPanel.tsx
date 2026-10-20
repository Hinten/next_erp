'use client';

/**
 * Live progress of the two Shopee account-wide jobs (#1529, step 21-5), in the
 * `/canais/shopee` TableView's action rail right under the buttons that start
 * them.
 *
 * A card exists for a (flow, conta) when ANY of three sources has a job for it:
 *  - a start this session (the action hooks' per-conta ledger) — including a busy
 *    start the hooks ATTACHED to the running job through its 409;
 *  - "Acompanhar" on a running row of the price Histórico — a run another operator
 *    (or another tab) started;
 *  - `sessionStorage`, which is what survives a reload: the job docs are durable
 *    server-side, but their `jobId` only ever lived in React state.
 *
 * There is NO running-job lookup (Mercado Livre's `jobs-em-andamento`): the 409
 * names the running job and the Histórico lists the live run, at zero backend
 * cost. The price of that choice is that a job started ELSEWHERE shows up only
 * once this operator clicks start (import) or opens the Histórico (price).
 *
 * Four rules the merge depends on:
 *  - **One JOB card per (flow, conta), newest intent wins.** A start this
 *    session wins over a remembered job; "Acompanhar" replaces both.
 *  - **A failed start shows BESIDE that job card, never instead of it.** The
 *    hooks' ledger keeps one entry per conta, so a failed re-start (a network
 *    error, the 503 of a closed queue, the quota pause a parked price job sits
 *    on) REPLACES the started entry there — which is why every started job is
 *    also folded into the remembered ones. Without that, the failure took the
 *    running job's card, its Cancel and its stored id with it.
 *  - **Terminal cards stay until dismissed** — deliberately unlike Mercado Livre:
 *    the mass import has no Histórico, so a reload would otherwise be the end of
 *    its result.
 *  - **Dismissing a job card forgets the job** for that (flow, conta), in this
 *    tab and in `sessionStorage`; nothing re-adds it except a new start or
 *    "Acompanhar". Dismissing a failed start's card forgets only the failure.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Anchor, Badge, Stack } from '@mantine/core';
import { z } from 'zod';

import { ContaJobErrorCard } from '@/components/contaJobs/JobCardShell';
import type { ContaJobOutcome, ContaRef } from '@/lib/marketplace/contaJobs/types';
import { HistoricoPrecosShopeeModal } from './HistoricoPrecosShopeeModal';
import {
  EnvioPrecoShopeeJobCard,
  ImportacaoShopeeJobCard,
  ROTULO_ATUALIZACAO_PRECOS_SHOPEE,
  ROTULO_IMPORTACAO_SHOPEE,
} from './ShopeeJobCards';

/** Survives a reload; scoped to the tab, like the jobs the operator is watching. */
export const CHAVE_JOBS_RASTREADOS_SHOPEE = 'delfrance:shopee:jobs:rastreados';

export type FluxoJobShopee = 'importacao' | 'precos';

/** One remembered job — exactly what `sessionStorage` holds per card. */
export interface JobRastreadoShopee {
  readonly flow: FluxoJobShopee;
  readonly conta: ContaRef;
  readonly jobId: string;
}

/** What the panel needs from one action hook. */
export interface FluxoDoPainelShopee {
  readonly entries: readonly ContaJobOutcome[];
  readonly reatados: ReadonlySet<string>;
  readonly dismiss: (contaId: string) => void;
}

const FLUXOS: readonly FluxoJobShopee[] = ['importacao', 'precos'];

const ROTULO_DO_FLUXO = {
  importacao: ROTULO_IMPORTACAO_SHOPEE,
  precos: ROTULO_ATUALIZACAO_PRECOS_SHOPEE,
} as const satisfies Record<FluxoJobShopee, string>;

/**
 * One stored entry, read tolerantly: a malformed one is dropped on its own and
 * never costs its siblings. A blank `nome` falls back to the id (it is a label).
 */
const jobRastreadoSchema = z.object({
  flow: z.enum(['importacao', 'precos']),
  conta: z.object({ id: z.string().min(1), nome: z.string() }),
  jobId: z.string().min(1),
});

function chave(flow: FluxoJobShopee, contaId: string): string {
  return `${flow}:${contaId}`;
}

type Cartao =
  | {
      readonly kind: 'erro';
      readonly flow: FluxoJobShopee;
      readonly conta: ContaRef;
      readonly color: 'yellow' | 'red';
      readonly message: string;
    }
  | {
      readonly kind: 'job';
      readonly flow: FluxoJobShopee;
      readonly conta: ContaRef;
      readonly jobId: string;
      readonly reatado: boolean;
    };

export function ShopeeJobsPanel({
  collapsed,
  selecionadas,
  importacao,
  precos,
}: {
  collapsed: boolean;
  /** The rows checked in the table — each gets its Histórico entry point. */
  selecionadas: readonly ContaRef[];
  importacao: FluxoDoPainelShopee;
  precos: FluxoDoPainelShopee;
}) {
  // Read once, at mount. Safe against hydration because the page mounts this
  // panel only for `canWrite`, which is false on the server and on the
  // hydration pass (the claims resolve in an effect).
  const [rastreados, setRastreados] = useState<ReadonlyMap<string, JobRastreadoShopee>>(() =>
    porChave(lerJobsRastreados()),
  );

  // Destructured so every memo below keys on the hooks' STABLE pieces — the
  // state objects themselves are rebuilt on every render.
  const {
    entries: entradasImportacao,
    reatados: reatadosImportacao,
    dismiss: dismissImportacao,
  } = importacao;
  const { entries: entradasPrecos, reatados: reatadosPrecos, dismiss: dismissPrecos } = precos;
  const cartoes = useMemo(
    () =>
      montarCartoes({
        importacao: { entries: entradasImportacao, reatados: reatadosImportacao },
        precos: { entries: entradasPrecos, reatados: reatadosPrecos },
        rastreados,
      }),
    [entradasImportacao, reatadosImportacao, entradasPrecos, reatadosPrecos, rastreados],
  );

  // Remember every job started this session, so a LATER failed start for the
  // same (flow, conta) — which replaces it in the ledger — cannot drop it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- folding the ledger's starts into the remembered jobs; returns `cur` when nothing is new, so it converges
    setRastreados((cur) =>
      lembrarIniciados(cur, { importacao: entradasImportacao, precos: entradasPrecos }),
    );
  }, [entradasImportacao, entradasPrecos]);

  // Persist exactly the cards that poll a job. Keyed on the SERIALISED list, so
  // a render that changed nothing writes nothing.
  const serializados = JSON.stringify(
    cartoes.flatMap((c) =>
      c.kind === 'job' ? [{ flow: c.flow, conta: c.conta, jobId: c.jobId }] : [],
    ),
  );
  useEffect(() => {
    gravarJobsRastreados(serializados);
  }, [serializados]);

  const esquecerDoLedger = useCallback(
    (flow: FluxoJobShopee, contaId: string) =>
      (flow === 'importacao' ? dismissImportacao : dismissPrecos)(contaId),
    [dismissImportacao, dismissPrecos],
  );

  const dispensarJob = useCallback(
    (flow: FluxoJobShopee, contaId: string) => {
      const entradas = flow === 'importacao' ? entradasImportacao : entradasPrecos;
      // A failure in the ledger is the card BESIDE this one, dismissed on its own.
      if (entradas.find((e) => e.conta.id === contaId)?.kind !== 'error') {
        esquecerDoLedger(flow, contaId);
      }
      setRastreados((cur) => semChave(cur, chave(flow, contaId)));
    },
    [entradasImportacao, entradasPrecos, esquecerDoLedger],
  );

  const acompanhar = useCallback(
    (job: JobRastreadoShopee) => {
      // The ledger would otherwise shadow the job just asked for.
      esquecerDoLedger(job.flow, job.conta.id);
      setRastreados((cur) => new Map(cur).set(chave(job.flow, job.conta.id), job));
    },
    [esquecerDoLedger],
  );

  // The collapsed rail is an icon strip: only the count fits, and only when
  // there is something to count.
  if (collapsed) {
    if (cartoes.length === 0) return null;
    return (
      <Badge size="sm" circle variant="filled" aria-label={`${cartoes.length} job(s) em andamento`}>
        {cartoes.length}
      </Badge>
    );
  }

  // The Histórico entry point must survive "no card": a run that finished while
  // the operator was away leaves exactly that state.
  if (cartoes.length === 0 && selecionadas.length === 0) return null;

  return (
    <Stack gap="xs" role="region" aria-label="Jobs em andamento">
      {cartoes.map((c) =>
        c.kind === 'erro' ? (
          <ContaJobErrorCard
            key={`${c.flow}-${c.conta.id}`}
            conta={c.conta}
            flowLabel={ROTULO_DO_FLUXO[c.flow]}
            color={c.color}
            message={c.message}
            // Only the failure: the job card beside it (if any) stays.
            onDismiss={() => esquecerDoLedger(c.flow, c.conta.id)}
          />
        ) : c.flow === 'importacao' ? (
          <ImportacaoShopeeJobCard
            // The jobId is in the key: a NEW job for the same conta is a new
            // card with a fresh query, never the old one re-pointed.
            key={`importacao-${c.conta.id}-${c.jobId}`}
            conta={c.conta}
            jobId={c.jobId}
            reatado={c.reatado}
            onDismiss={() => dispensarJob('importacao', c.conta.id)}
          />
        ) : (
          <EnvioPrecoShopeeJobCard
            key={`precos-${c.conta.id}-${c.jobId}`}
            conta={c.conta}
            jobId={c.jobId}
            reatado={c.reatado}
            onDismiss={() => dispensarJob('precos', c.conta.id)}
          />
        ),
      )}
      {selecionadas.map((conta) => (
        <LinkDoHistorico
          key={`historico-${conta.id}`}
          conta={conta}
          onAcompanhar={(jobId) => acompanhar({ flow: 'precos', conta, jobId })}
        />
      ))}
    </Stack>
  );
}

/**
 * A conta's past price updates. Keyed off the SELECTION, not off the cards: its
 * case is "the run finished while I was away", which by definition has no card.
 * The modal fetches only while open, so an unopened link costs nothing.
 */
function LinkDoHistorico({
  conta,
  onAcompanhar,
}: {
  conta: ContaRef;
  onAcompanhar: (jobId: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      {/* The conta is part of the LABEL: one link per selected conta, and N
          identical names would be indistinguishable on screen and to a reader. */}
      <Anchor component="button" type="button" size="xs" onClick={() => setAberto(true)}>
        Histórico de atualizações de preços — {conta.nome}
      </Anchor>
      <HistoricoPrecosShopeeModal
        conta={conta}
        opened={aberto}
        onClose={() => setAberto(false)}
        onAcompanhar={onAcompanhar}
      />
    </>
  );
}

/**
 * One job card per (flow, conta) with a job to show — plus, before it, the card
 * of a failed start for that (flow, conta) — in a stable order: the contas this
 * session started first, then the remembered ones; per conta, the import before
 * the price update.
 */
function montarCartoes({
  importacao,
  precos,
  rastreados,
}: {
  importacao: Pick<FluxoDoPainelShopee, 'entries' | 'reatados'>;
  precos: Pick<FluxoDoPainelShopee, 'entries' | 'reatados'>;
  rastreados: ReadonlyMap<string, JobRastreadoShopee>;
}): Cartao[] {
  const fluxos = { importacao, precos };
  const contas = new Map<string, ContaRef>();
  for (const e of [...importacao.entries, ...precos.entries]) {
    if (!contas.has(e.conta.id)) contas.set(e.conta.id, e.conta);
  }
  for (const r of rastreados.values()) {
    if (!contas.has(r.conta.id)) contas.set(r.conta.id, r.conta);
  }

  const cartoes: Cartao[] = [];
  for (const [contaId, conta] of contas) {
    for (const flow of FLUXOS) {
      const { entries, reatados } = fluxos[flow];
      const iniciado = entries.find((e) => e.conta.id === contaId);
      if (iniciado?.kind === 'error') {
        cartoes.push({
          kind: 'erro',
          flow,
          conta: iniciado.conta,
          color: iniciado.color,
          message: iniciado.message,
        });
      }
      // Only a STARTED entry shadows the remembered job: a failure falls through.
      const jobId =
        (iniciado?.kind === 'started' ? iniciado.jobId : undefined) ??
        rastreados.get(chave(flow, contaId))?.jobId;
      if (jobId === undefined) continue;
      cartoes.push({ kind: 'job', flow, conta, jobId, reatado: reatados.has(jobId) });
    }
  }
  return cartoes;
}

/**
 * The remembered jobs with every STARTED ledger entry folded in, newest winning.
 * Returns `cur` itself when nothing is new, so the effect that calls it settles.
 */
function lembrarIniciados(
  cur: ReadonlyMap<string, JobRastreadoShopee>,
  entradas: Readonly<Record<FluxoJobShopee, readonly ContaJobOutcome[]>>,
): ReadonlyMap<string, JobRastreadoShopee> {
  let proximo: Map<string, JobRastreadoShopee> | null = null;
  for (const flow of FLUXOS) {
    for (const e of entradas[flow]) {
      if (e.kind !== 'started') continue;
      const k = chave(flow, e.conta.id);
      if (cur.get(k)?.jobId === e.jobId) continue;
      proximo ??= new Map(cur);
      proximo.set(k, { flow, conta: e.conta, jobId: e.jobId });
    }
  }
  return proximo ?? cur;
}

function porChave(jobs: readonly JobRastreadoShopee[]): ReadonlyMap<string, JobRastreadoShopee> {
  // Later entries win, so a duplicated (flow, conta) keeps one card.
  return new Map(jobs.map((j) => [chave(j.flow, j.conta.id), j]));
}

function semChave<V>(mapa: ReadonlyMap<string, V>, k: string): ReadonlyMap<string, V> {
  if (!mapa.has(k)) return mapa;
  const proximo = new Map(mapa);
  proximo.delete(k);
  return proximo;
}

/**
 * Tolerant read of the remembered jobs — a corrupt value, or a storage the
 * browser refuses (`SecurityError` in a locked-down profile), is just no list.
 */
export function lerJobsRastreados(): JobRastreadoShopee[] {
  // Runs during the initial render, which also happens on the server.
  if (typeof window === 'undefined') return [];
  let bruto: string | null;
  try {
    bruto = window.sessionStorage.getItem(CHAVE_JOBS_RASTREADOS_SHOPEE);
  } catch (err) {
    if (err instanceof DOMException) return [];
    throw err;
  }
  if (!bruto) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bruto);
  } catch (err) {
    if (err instanceof SyntaxError) return [];
    throw err;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown) => {
    const lido = jobRastreadoSchema.safeParse(item);
    if (!lido.success) return [];
    const { flow, conta, jobId } = lido.data;
    return [{ flow, jobId, conta: { id: conta.id, nome: conta.nome || conta.id } }];
  });
}

/** Write (or clear) the remembered jobs. A full or refused storage only loses the reload path. */
function gravarJobsRastreados(serializados: string): void {
  try {
    if (serializados === '[]') {
      window.sessionStorage.removeItem(CHAVE_JOBS_RASTREADOS_SHOPEE);
    } else {
      window.sessionStorage.setItem(CHAVE_JOBS_RASTREADOS_SHOPEE, serializados);
    }
  } catch (err) {
    if (err instanceof DOMException) return;
    throw err;
  }
}
