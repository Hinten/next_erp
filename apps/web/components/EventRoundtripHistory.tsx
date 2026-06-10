'use client';

/**
 * Shared "SEFAZ round-trip history" list — the append-only log of NF-e
 * communications (emission/consult/cancelamento, inutilização, carta de
 * correção). Each row shows a badge + a one-line summary + the timestamp, and
 * expands to the sent / received XML (+ protocolo when present), newest first.
 *
 * Purely presentational over the common `EventRoundtripRecord` shape: the
 * caller passes a (memoized) Firestore query and the two bits that actually
 * differ between screens — `renderBadge` and `renderSummary`. The three NF-e
 * history screens (`NfeHistory`, `InutilizacaoHistory`, `CartaCorrecaoHistory`)
 * all fold onto this (issue #84).
 */
import { useMemo, type ReactNode } from 'react';
import { Accordion, Code, Group, Stack, Text, Title } from '@mantine/core';
import type { Query } from 'firebase/firestore';
import { useSnapshot } from '@delfrance/data/hooks';

/** The fields every persisted SEFAZ round-trip record shares. */
export interface EventRoundtripRecord {
  timestamp?: string | null;
  xml_enviado?: string | null;
  xml_retorno?: string | null;
  xMotivo?: string | null;
  error?: string | null;
  nProt?: string | null;
}

export interface EventRoundtripHistoryProps<T extends EventRoundtripRecord> {
  /**
   * Firestore query/ref to subscribe to. **Memoize it in the parent** (e.g.
   * `useMemo(() => collection.ref(db, ctx), deps)`) so `useSnapshot` doesn't
   * re-subscribe every render. Rows are sorted newest-first by `timestamp`.
   */
  query: Query<T> | null;
  /** Optional section title — omit when embedding inside an existing card. */
  title?: string;
  loadingLabel: string;
  emptyLabel: string;
  /** Per-row badge (color + label). */
  renderBadge: (m: T) => ReactNode;
  /** Per-row one-line summary shown next to the badge. */
  renderSummary: (m: T) => ReactNode;
  /** Override the panel's detail line. Default: `xMotivo ?? error ?? '—'`. */
  renderPanelDetail?: (m: T) => ReactNode;
  /**
   * Per-row actions rendered at the bottom of the expanded panel (gets the
   * record + its Firestore doc id) — e.g. a "Baixar PDF" button. Omit for the
   * read-only history screens.
   */
  renderActions?: (m: T, id: string) => ReactNode;
  /** Max width of the titled wrapper (ignored when `title` is omitted). */
  maw?: number;
}

function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('pt-BR');
}

function XmlBlock({ label, xml }: { label: string; xml: string }) {
  return (
    <>
      <Text size="xs" fw={500}>
        {label}
      </Text>
      <Code block style={{ maxHeight: 240, overflow: 'auto' }}>
        {xml}
      </Code>
    </>
  );
}

export function EventRoundtripHistory<T extends EventRoundtripRecord>({
  query,
  title,
  loadingLabel,
  emptyLabel,
  renderBadge,
  renderSummary,
  renderPanelDetail,
  renderActions,
  maw = 720,
}: EventRoundtripHistoryProps<T>) {
  const { data, loading, error } = useSnapshot(query);

  // Sort newest-first client-side (these per-entity lists are small → no index).
  const rows = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) =>
        String(b.data.timestamp ?? '').localeCompare(String(a.data.timestamp ?? '')),
      ),
    [data],
  );

  // Surface a subscription failure explicitly — otherwise `error` (with
  // `data` undefined) would fall through to the empty state and misreport the
  // failure as "no history".
  let body: ReactNode;
  if (error) {
    body = (
      <Text size="sm" c="red">
        Falha ao carregar o histórico: {error.message}
      </Text>
    );
  } else if (loading) {
    body = (
      <Text size="sm" c="dimmed">
        {loadingLabel}
      </Text>
    );
  } else if (rows.length === 0) {
    body = (
      <Text size="sm" c="dimmed">
        {emptyLabel}
      </Text>
    );
  } else {
    body = (
      <Accordion variant="separated" chevronPosition="left">
        {rows.map((row) => {
          const m = row.data;
          return (
            <Accordion.Item key={row.id} value={row.id}>
              <Accordion.Control>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                    {renderBadge(m)}
                    {renderSummary(m)}
                  </Group>
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    {formatTs(m.timestamp)}
                  </Text>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap="xs">
                  {renderPanelDetail ? (
                    renderPanelDetail(m)
                  ) : (
                    <Text size="sm">{m.xMotivo ?? m.error ?? '—'}</Text>
                  )}
                  {m.nProt && (
                    <Text size="sm">
                      Protocolo:{' '}
                      <Text span ff="monospace">
                        {m.nProt}
                      </Text>
                    </Text>
                  )}
                  {m.xml_enviado && <XmlBlock label="Enviado" xml={m.xml_enviado} />}
                  {m.xml_retorno && <XmlBlock label="Retorno" xml={m.xml_retorno} />}
                  {renderActions && <Group gap="xs">{renderActions(m, row.id)}</Group>}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
    );
  }

  // No title → bare body (e.g. embedded inside an NF-e card).
  if (title === undefined) return body;
  return (
    <Stack gap="sm" maw={maw}>
      <Title order={4}>{title}</Title>
      {body}
    </Stack>
  );
}
