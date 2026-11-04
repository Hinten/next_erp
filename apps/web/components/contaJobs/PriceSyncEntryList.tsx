'use client';

import { Fragment } from 'react';
import { Stack, Text } from '@mantine/core';

/** How many skip/failure sample entries the details modal lists before "+N mais". */
export const PRICE_SYNC_LIST_LIMIT = 8;

/**
 * One entry of a bulk job's skip/failure sample, as every channel's status wire
 * carries it. The id shown is `itemId ?? produtoId ?? '—'`: a plan-time skip has
 * no listing yet, so it names the produto instead.
 */
export interface AmostraDeJob {
  readonly itemId: string | null;
  readonly produtoId?: string;
  readonly code: string;
  readonly error?: string;
  /**
   * Our OWN sentence for `code`, when the channel's backend renders one. Bounded
   * by construction, so it is shown whole on a line of its own — unlike `error`,
   * which is provider text and gets cut to a snippet.
   */
  readonly mensagem?: string;
}

/**
 * Compact dimmed-monospace list of a price-sync job's skip/failure sample.
 * `total` is the exact counter (`pulados`/`falhas`) — the entries themselves
 * are a server-capped sample, so the "+N mais" tail counts against it.
 *
 * Exported so the Histórico modal renders a FINISHED run through exactly this
 * component: the history endpoint returns the same entry shape as the running
 * one, and a second renderer would be free to drift from the "+N mais" maths
 * that keeps the sample honest about the exact counters.
 */
export function PriceSyncEntryList({
  label,
  entries,
  total,
}: {
  label: string;
  entries: readonly AmostraDeJob[];
  total: number;
}) {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, PRICE_SYNC_LIST_LIMIT);
  const rest = total - shown.length;
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed" fw={500}>
        {label}
      </Text>
      {shown.map((entry, i) => {
        const id = entry.itemId ?? entry.produtoId ?? '—';
        return (
          <Fragment key={`${id}-${i}`}>
            <Text size="xs" c="dimmed" ff="monospace">
              {id} · {entry.code}
              {entry.error ? ` · ${errorSnippet(entry.error)}` : ''}
            </Text>
            {entry.mensagem ? (
              <Text size="xs" c="dimmed">
                {entry.mensagem}
              </Text>
            ) : null}
          </Fragment>
        );
      })}
      {rest > 0 && (
        <Text size="xs" c="dimmed">
          +{rest} mais
        </Text>
      )}
    </Stack>
  );
}

/**
 * Keep a failure's error text a one-line snippet in the compact list —
 * whitespace (incl. newlines from stack-trace-shaped backend errors) collapses
 * to single spaces before the length cap.
 */
function errorSnippet(error: string): string {
  const oneLine = error.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}
