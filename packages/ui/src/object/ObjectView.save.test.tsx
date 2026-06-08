import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';

const { docState, saveRecordMock, NothingChanged, notifyShow } = vi.hoisted(() => {
  class NothingChanged extends Error {}
  return {
    docState: {
      current: { data: null, loading: false, error: undefined } as {
        data: undefined | null | { id: string; data: unknown };
        loading: boolean;
        error: undefined;
      },
    },
    saveRecordMock: vi.fn(),
    NothingChanged,
    notifyShow: vi.fn(),
  };
});

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useDocSnapshot: () => docState.current };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('./saveRecord', () => ({
  saveRecord: (input: unknown) => saveRecordMock(input),
  NothingChangedError: NothingChanged,
}));

vi.mock('@mantine/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@mantine/notifications')>('@mantine/notifications');
  return { ...actual, notifications: { show: (...args: unknown[]) => notifyShow(...args) } };
});

import { ObjectView } from './ObjectView';

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
  };
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider>
      <Notifications />
      {children}
    </MantineProvider>
  );
}

beforeEach(() => {
  saveRecordMock.mockReset();
  notifyShow.mockReset();
  docState.current = { data: null, loading: false, error: undefined };
});

describe('ObjectView save flow', () => {
  it('submit on a pristine update form skips saveRecord and shows a yellow toast', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice', email: 'a@x.com' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockRejectedValueOnce(new NothingChanged('Nenhuma alteração para salvar'));
    render(
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(notifyShow).toHaveBeenCalledWith(expect.objectContaining({ color: 'yellow' }));
  });

  it('submit with a dirty field calls saveRecord exactly once with the patch and fires onSaved', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: { nome: 'Updated' } });
    const onSaved = vi.fn();
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          onSaved={onSaved}
        />
      </Wrap>,
    );
    const nome = screen.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Updated' } });
      fireEvent.blur(nome);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(saveRecordMock).toHaveBeenCalledOnce();
    const arg = saveRecordMock.mock.calls[0]![0] as { dirtyFields: Record<string, unknown> };
    expect(arg.dirtyFields.nome).toBe(true);
    expect(onSaved).toHaveBeenCalledWith('EXISTING');
  });

  it('"Salvar e continuar" stays on the form (no onSaved) and clears dirty', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: { nome: 'Updated' } });
    const onSaved = vi.fn();
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          onSaved={onSaved}
        />
      </Wrap>,
    );
    const nome = screen.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Updated' } });
      fireEvent.blur(nome);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar' }));
    });
    expect(saveRecordMock).toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(notifyShow).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
  });
});
