import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ColumnFilterValue } from '@delfrance/ui';
import type { Integracao } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { IntegracaoRow } from '@/lib/data/useIntegracoes';

import { IntegracaoColumnFilter } from './IntegracaoColumnFilter';
import {
  SEM_CANAL_LABEL,
  formatIntegracaoFilterValue,
  integracaoIdFromOuterRef,
  integracaoOuterRef,
} from './integracaoLookup';

function row(id: string, nome: string, tipo: number, ativo: boolean): IntegracaoRow {
  return { id, data: { nome, tipo, ativo } as unknown as Integracao };
}

const ROWS: IntegracaoRow[] = [
  row('ml-1', 'ML Principal', 1, true),
  row('shp-1', 'Shopee Loja', 5, false),
];

function renderFilter(opts?: {
  value?: ColumnFilterValue;
  status?: 'pending' | 'error' | 'success';
  rows?: IntegracaoRow[];
}) {
  const onChange = vi.fn<(next: ColumnFilterValue | undefined) => void>();
  render(
    <MantineTestProvider>
      <IntegracaoColumnFilter
        integracoes={opts?.rows ?? ROWS}
        status={opts?.status ?? 'success'}
        value={opts?.value}
        onChange={onChange}
      />
    </MantineTestProvider>,
  );
  return onChange;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('IntegracaoColumnFilter', () => {
  it('emits the full stored doc path, not a bare id', () => {
    // ⚠️ The value IS the where clause. A bare id would compare a 5-character
    // string against `documents/integracao/<id>` and match nothing, behind a
    // filter icon that looks active.
    const onChange = renderFilter();
    fireEvent.click(screen.getByRole('combobox', { name: 'Canal' }));
    fireEvent.click(screen.getByRole('option', { name: 'ML Principal (Mercado Livre)' }));
    expect(onChange).toHaveBeenCalledWith({
      op: 'eq',
      value: 'documents/integracao/ml-1',
    });
  });

  it('keeps a deactivated conta selectable, and says why it is listed', () => {
    // A pedido created before the conta was deactivated still carries it, so
    // dropping the option would make those pedidos unreachable by this filter.
    renderFilter();
    fireEvent.click(screen.getByRole('combobox', { name: 'Canal' }));
    expect(screen.getByRole('option', { name: 'Shopee Loja (Shopee) — inativo' })).toBeTruthy();
  });

  it('Limpar drops the filter rather than emitting an empty one', () => {
    const onChange = renderFilter({ value: { op: 'eq', value: integracaoOuterRef('ml-1') } });
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('explains a denied read instead of showing an empty dropdown', () => {
    // "No options" and "you may not read this collection" look identical on
    // screen and are not the same problem — `useIntegracoes` documents exactly
    // this ambiguity.
    renderFilter({ status: 'error', rows: [] });
    expect(screen.getByText('Sem permissão para ler os canais de venda.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Canal' })).toBeNull();
  });

  it('does not offer a stale-looking empty list while the read is in flight', () => {
    renderFilter({ status: 'pending', rows: [] });
    expect((screen.getByRole('combobox', { name: 'Canal' }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});

describe('integracaoOuterRef / integracaoIdFromOuterRef', () => {
  it('round-trips an id through the stored path shape', () => {
    expect(integracaoOuterRef('ml-1')).toBe('documents/integracao/ml-1');
    expect(integracaoIdFromOuterRef(integracaoOuterRef('ml-1'))).toBe('ml-1');
  });

  it('leaves a value with no separator verbatim rather than mangling it', () => {
    expect(integracaoIdFromOuterRef('ml-1')).toBe('ml-1');
  });
});

describe('formatIntegracaoFilterValue', () => {
  const lookup = {
    rows: ROWS,
    byId: new Map(ROWS.map((r) => [r.id, r.data])),
    status: 'success' as const,
  };

  it('names the channel, so the chip is readable', () => {
    expect(formatIntegracaoFilterValue(integracaoOuterRef('ml-1'), lookup)).toBe('ML Principal');
  });

  it('degrades to the bare id, never the stored path', () => {
    // Reachable only when the lookup was denied; a raw id still beats printing
    // `documents/integracao/<id>`.
    const denied = { rows: [], byId: new Map(), status: 'error' as const };
    expect(formatIntegracaoFilterValue(integracaoOuterRef('ml-1'), denied)).toBe('ml-1');
  });

  it('names the empty state instead of printing the word "null"', () => {
    // ⚠️ Dead today — nothing emits `isNull` on this column — and pinned anyway.
    // Without the guard, `String(null)` is `'null'`, which has no slash, so the
    // id extractor hands it back verbatim, `byId` misses and `?? id` prints it:
    // the chip would read `Canal: null` the day a "sem canal" option ships.
    // `describeFilter` cannot cover for it either — it short-circuits on
    // `formatValue` above its own `isNull` branch.
    expect(formatIntegracaoFilterValue(null, lookup)).toBe(SEM_CANAL_LABEL);
  });

  it('never folds the empty state onto a channel whose id is the word "null"', () => {
    // The near-miss. An id is a string and could be anything; discriminating on
    // `value === null` — the type, not the text — is what keeps them apart.
    const rows = [row('null', 'Canal Chamado Null', 1, true)];
    const odd = {
      rows,
      byId: new Map(rows.map((r) => [r.id, r.data])),
      status: 'success' as const,
    };
    expect(formatIntegracaoFilterValue(integracaoOuterRef('null'), odd)).toBe('Canal Chamado Null');
    expect(formatIntegracaoFilterValue(null, odd)).toBe(SEM_CANAL_LABEL);
  });

  it('keeps two channels with the same id prefix distinct', () => {
    // The near-miss: the fold is the trailing path segment, and it must be the
    // WHOLE segment — a prefix match would label `ml-10` as `ml-1`.
    const rows = [row('ml-1', 'ML Principal', 1, true), row('ml-10', 'ML Outlet', 1, true)];
    const two = {
      rows,
      byId: new Map(rows.map((r) => [r.id, r.data])),
      status: 'success' as const,
    };
    expect(formatIntegracaoFilterValue(integracaoOuterRef('ml-1'), two)).toBe('ML Principal');
    expect(formatIntegracaoFilterValue(integracaoOuterRef('ml-10'), two)).toBe('ML Outlet');
  });
});
