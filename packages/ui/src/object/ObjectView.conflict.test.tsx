/**
 * #824 / ADR 0011 tier 3 — what the operator actually sees when their save
 * loses, and what each of the three ways out does.
 *
 * The mechanism itself is proven in `saveRecord.race.test.ts` against a real
 * OCC engine; this file covers the wiring: that the baseline comes from SERVER
 * TRUTH (not a cache paint), that the modal names the right fields, and that
 * "Recarregar do servidor" keeps the edits which did not collide.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';

const { docState, saveRecordMock, notifyShow } = vi.hoisted(() => ({
  docState: {
    current: { data: null, loading: false, error: undefined } as {
      data: { id: string; data: Record<string, unknown> } | null;
      loading: boolean;
      error: undefined;
      fromCache?: boolean;
    },
  },
  saveRecordMock: vi.fn(),
  notifyShow: vi.fn(),
}));

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useDocSnapshot: () => docState.current };
});

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

// PARTIAL mock — `RecordConflictError` must stay the real class, or the
// `instanceof` in ObjectView's catch would never match.
vi.mock('./saveRecord', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./saveRecord')>()),
  saveRecord: (input: unknown) => saveRecordMock(input),
}));

vi.mock('@mantine/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@mantine/notifications')>('@mantine/notifications');
  return { ...actual, notifications: { show: (...args: unknown[]) => notifyShow(...args) } };
});

import { ObjectView } from './ObjectView';
import { RecordConflictError } from './saveRecord';

const schema = z.object({
  nome: z.string().nullable().optional().describe('Nome'),
  email: z.string().nullable().optional().describe('Email'),
});

function fakeCollection(): CollectionHandle<typeof schema> {
  return {
    resolvePath: () => 'clientes',
    ref: () => ({}) as never,
    docRef: () => ({}) as never,
    converter: {} as never,
    merge: () => Promise.resolve(),
  };
}

/**
 * ⚠️ `env="test"` is load-bearing, not decoration. Without it Mantine's `Modal`
 * keeps its Transition pending forever in jsdom: the Root element renders (and
 * `<body>` even gets `data-scroll-locked`), but it stays EMPTY, so every query
 * for the modal's own content fails while the modal is genuinely open. The repo
 * convention throughout `apps/web`'s component tests.
 */
function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider env="test">
      <Notifications />
      {children}
    </MantineProvider>
  );
}

const LOADED = { nome: 'Alice', email: 'a@x.com' };

function renderView() {
  return render(
    <Wrap>
      <ObjectView
        schema={schema}
        collection={fakeCollection()}
        db={{} as never}
        currentUserUid="u1"
        recordId="EXISTING"
      />
    </Wrap>,
  );
}

async function editAndSave(field: string, value: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(field), { target: { value } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  });
}

beforeEach(() => {
  saveRecordMock.mockReset();
  notifyShow.mockReset();
  docState.current = {
    data: { id: 'EXISTING', data: { ...LOADED } },
    loading: false,
    error: undefined,
    fromCache: false,
  };
});

describe('ObjectView — tier-3 conflict (#824)', () => {
  it('passes the server-truth baseline to saveRecord', async () => {
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: {} });
    renderView();
    await editAndSave('Nome', 'Alicia');

    expect(saveRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseline: expect.objectContaining(LOADED) }),
    );
  });

  it('does NOT pass a baseline seeded from a cache paint', async () => {
    // ⚠️ The whole safeguard. A baseline taken from the IndexedDB snapshot is
    // stale by construction right after an edit, so the guard would fire on
    // every save and operators would learn to click through it (#791).
    docState.current = {
      data: { id: 'EXISTING', data: { ...LOADED } },
      loading: false,
      error: undefined,
      fromCache: true,
    };
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: {} });
    renderView();
    await editAndSave('Nome', 'Alicia');

    expect(saveRecordMock).toHaveBeenCalledWith(expect.objectContaining({ baseline: undefined }));
  });

  it('omits the baseline when the screen opts out', async () => {
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: {} });
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          disableConcurrencyGuard
        />
      </Wrap>,
    );
    await editAndSave('Nome', 'Alicia');

    expect(saveRecordMock).toHaveBeenCalledWith(expect.objectContaining({ baseline: undefined }));
  });

  it('shows the diff, with the schema label and both values', async () => {
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError({ nome: 'Alexandra', email: 'a@x.com' }, ['nome']),
    );
    renderView();
    await editAndSave('Nome', 'Alicia');

    expect(screen.getByText('Registro alterado')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy(); // Você carregou
    expect(screen.getByText('Alexandra')).toBeTruthy(); // No servidor
    expect(screen.getByText('Sobrescreve')).toBeTruthy();
  });

  it('"Salvar mesmo assim" re-baselines onto the reviewed version — it does NOT disable the guard', async () => {
    saveRecordMock
      .mockRejectedValueOnce(new RecordConflictError({ nome: 'Alexandra' }, ['nome']))
      .mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    renderView();
    await editAndSave('Nome', 'Alicia');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    });

    expect(saveRecordMock).toHaveBeenCalledTimes(2);
    // An earlier revision passed `baseline: undefined` here, which turned the
    // override into a blind write: a THIRD writer landing while the operator
    // read the diff was silently overwritten. The retry must carry the version
    // the modal showed, so the guard runs again against it.
    expect(saveRecordMock.mock.calls[1]?.[0]).toMatchObject({
      baseline: { nome: 'Alexandra' },
    });
  });

  it('a THIRD write during the override raises the modal again, with the newer version', async () => {
    saveRecordMock
      .mockRejectedValueOnce(new RecordConflictError({ nome: 'Alexandra' }, ['nome']))
      // …someone else saved again while the operator was reading the diff.
      .mockRejectedValueOnce(new RecordConflictError({ nome: 'Alexandrina' }, ['nome']));
    renderView();
    await editAndSave('Nome', 'Alicia');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    });

    // Still open, now showing the THIRD writer's value rather than swallowing it.
    expect(screen.getByRole('button', { name: 'Salvar mesmo assim' })).toBeTruthy();
    expect(screen.getByText('Alexandrina')).toBeTruthy();
  });

  it('"Recarregar do servidor" takes the server value and KEEPS the uncontested edit', async () => {
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError({ nome: 'Alexandra', email: 'a@x.com' }, ['nome']),
    );
    renderView();

    // The operator changed BOTH fields; only `nome` collided.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Alicia' } });
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'novo@x.com' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recarregar do servidor' }));
    });

    // Contested field: the server wins.
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Alexandra');
    // Uncontested edit: survives, and is still dirty so the next save writes it.
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('novo@x.com');
  });

  it('a deleted record surfaces as an error, not as a modal offering to re-save', async () => {
    saveRecordMock.mockRejectedValueOnce(new RecordConflictError(null, [], true));
    renderView();
    await editAndSave('Nome', 'Alicia');

    expect(screen.queryByRole('button', { name: 'Salvar mesmo assim' })).toBeNull();
    expect(screen.getByText(/excluído por outra pessoa/)).toBeTruthy();
  });
});
