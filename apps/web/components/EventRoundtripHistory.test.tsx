import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Badge, Text } from '@mantine/core';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { FirestoreError } from 'firebase/firestore';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';

import type { EventRoundtripRecord } from './EventRoundtripHistory';

/** A test record with a `summary` field distinct from the panel's `xMotivo`. */
interface TestRec extends EventRoundtripRecord {
  summary: string;
}

// Hoisted mutable snapshot state so each test swaps what useSnapshot returns
// before rendering (mirrors apps/web/.../PedidoCells.test.tsx).
const { snapState } = vi.hoisted(() => ({
  snapState: {
    current: { data: undefined, loading: true, error: undefined } as SnapshotState<
      SnapshotRow<TestRec>[]
    >,
  },
}));

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useSnapshot: () => snapState.current };
});

import { EventRoundtripHistory } from './EventRoundtripHistory';

function row(id: string, data: TestRec): SnapshotRow<TestRec> {
  return { id, path: `x/${id}`, data };
}

function setSnap(state: Partial<SnapshotState<SnapshotRow<TestRec>[]>>) {
  snapState.current = { data: undefined, loading: false, error: undefined, ...state };
}

function wrap(node: React.ReactNode) {
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

const baseProps = {
  query: null,
  loadingLabel: 'Carregando…',
  emptyLabel: 'Nada registrado.',
  renderBadge: (m: TestRec) => (
    <Badge color={m.error ? 'red' : 'teal'}>{m.error ? 'erro' : 'ok'}</Badge>
  ),
  renderSummary: (m: TestRec) => <Text>{m.summary}</Text>,
};

afterEach(() => {
  snapState.current = { data: undefined, loading: true, error: undefined };
});

describe('EventRoundtripHistory', () => {
  it('shows the loading label while the snapshot is loading', () => {
    setSnap({ loading: true });
    wrap(<EventRoundtripHistory {...baseProps} />);
    expect(screen.getByText('Carregando…')).toBeTruthy();
  });

  it('shows the empty label when there are no rows', () => {
    setSnap({ data: [] });
    wrap(<EventRoundtripHistory {...baseProps} />);
    expect(screen.getByText('Nada registrado.')).toBeTruthy();
  });

  it('surfaces a subscription error instead of the empty label', () => {
    setSnap({
      error: {
        name: 'FirebaseError',
        code: 'permission-denied',
        message: 'Permissão negada',
      } as FirestoreError,
    });
    wrap(<EventRoundtripHistory {...baseProps} />);
    expect(screen.getByText(/Permissão negada/)).toBeTruthy();
    expect(screen.queryByText('Nada registrado.')).toBeNull();
  });

  it('renders rows newest-first by timestamp', () => {
    setSnap({
      data: [
        row('older', {
          timestamp: new Date('2026-01-01T00:00:00.000Z').getTime(),
          summary: 'OLDER',
        }),
        row('newer', {
          timestamp: new Date('2026-02-01T00:00:00.000Z').getTime(),
          summary: 'NEWER',
        }),
      ],
    });
    wrap(<EventRoundtripHistory {...baseProps} />);
    const newer = screen.getByText('NEWER');
    const older = screen.getByText('OLDER');
    // NEWER must appear before OLDER in document order.
    expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the badge + summary and reveals nProt + sent/received XML on expand', () => {
    setSnap({
      data: [
        row('r1', {
          timestamp: new Date('2026-02-01T00:00:00.000Z').getTime(),
          summary: 'sumario-1',
          xMotivo: 'Evento registrado',
          nProt: '135200000099999',
          xml_enviado: '<evento>SENT</evento>',
          xml_retorno: '<retEvento>RECV</retEvento>',
        }),
      ],
    });
    wrap(<EventRoundtripHistory {...baseProps} />);

    expect(screen.getByText('ok')).toBeTruthy(); // badge
    expect(screen.getByText('sumario-1')).toBeTruthy(); // summary

    // Expand the row, then the panel reveals detail (xMotivo) + protocolo + XML.
    fireEvent.click(screen.getByText('sumario-1'));
    expect(screen.getByText('Evento registrado')).toBeTruthy();
    expect(screen.getByText('135200000099999')).toBeTruthy();
    expect(screen.getByText('<evento>SENT</evento>')).toBeTruthy();
    expect(screen.getByText('<retEvento>RECV</retEvento>')).toBeTruthy();
  });

  it('renders a title wrapper only when `title` is provided', () => {
    setSnap({ data: [] });
    const { rerender } = wrap(<EventRoundtripHistory {...baseProps} title="Histórico" />);
    expect(screen.getByText('Histórico')).toBeTruthy();

    rerender(
      <MantineTestProvider>
        <EventRoundtripHistory {...baseProps} />
      </MantineTestProvider>,
    );
    expect(screen.queryByText('Histórico')).toBeNull();
  });
});
