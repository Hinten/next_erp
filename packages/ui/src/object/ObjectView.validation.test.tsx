import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';

const { docState, saveRecordMock, NothingChanged, notifyShow } = vi.hoisted(() => {
  class NothingChanged extends Error {}
  return {
    docState: {
      current: { data: null, loading: false, error: undefined } as {
        data: undefined | null | { id: string; data: unknown };
        loading: boolean;
        error: Error | undefined;
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
  nome: z.string().min(1, 'Informe o nome').describe('Nome'),
  obs: z.string().min(1, 'Informe a observação').describe('Observações'),
});

const SECTIONS = ['Geral', 'Notas'];
const FIELDS = { nome: { section: 'Geral' }, obs: { section: 'Notas' } };

function fakeCollection(): CollectionHandle<typeof schema> {
  return {
    resolvePath: () => 'tests',
    ref: () => ({}) as never,
    docRef: () => ({}) as never,
    converter: {} as never,
  };
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <MantineProvider env="test">{children}</MantineProvider>;
}

function renderTabbed(extra?: { excludedFields?: string[] }) {
  return render(
    <Wrap>
      <ObjectView
        schema={schema}
        collection={fakeCollection()}
        db={{} as never}
        currentUserUid="u1"
        sections={SECTIONS}
        fields={FIELDS}
        {...extra}
      />
    </Wrap>,
  );
}

beforeEach(() => {
  saveRecordMock.mockReset();
  notifyShow.mockReset();
  docState.current = { data: null, loading: false, error: undefined };
});

describe('ObjectView validation feedback across tabs', () => {
  it('keeps inactive-tab fields mounted (Mantine keepMounted default)', () => {
    renderTabbed();
    // "Geral" is active; the "Notas" panel must still be in the DOM so its
    // Controllers stay registered and errors survive — a `keepMounted={false}`
    // regression would break the whole feature.
    expect(screen.getByRole('tab', { name: 'Geral' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Observações')).toBeTruthy();
  });

  it('switches to the first erroring tab and names it in a red toast', async () => {
    renderTabbed();
    const nome = screen.getByRole('textbox', { name: 'Nome' });
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Alice' } });
      fireEvent.blur(nome);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(saveRecordMock).not.toHaveBeenCalled();
    expect(notifyShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        message: expect.stringContaining('Notas') as string,
      }),
    );
    expect(screen.getByRole('tab', { name: /Notas/ }).getAttribute('aria-selected')).toBe('true');
    // The inline field error is now visible on the activated tab.
    expect(screen.getByText('Informe a observação')).toBeTruthy();
  });

  it('marks the erroring tab with the error icon until the field is fixed', async () => {
    renderTabbed();
    const nome = screen.getByRole('textbox', { name: 'Nome' });
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Alice' } });
      fireEvent.blur(nome);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    const tabNotas = screen.getByRole('tab', { name: /Notas/ });
    expect(within(tabNotas).getByRole('img', { name: 'contém campos inválidos' })).toBeTruthy();

    // Fix the field — RHF revalidates on change after a failed submit and
    // the indicator clears.
    const obs = screen.getByRole('textbox', { name: 'Observações' });
    await act(async () => {
      fireEvent.change(obs, { target: { value: 'tudo certo' } });
      fireEvent.blur(obs);
    });
    expect(within(screen.getByRole('tab', { name: 'Notas' })).queryByRole('img')).toBeNull();
  });

  it('does not switch tabs when the active tab also has an error', async () => {
    renderTabbed();
    // Both fields empty → errors on "Geral" (active) and "Notas".
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(screen.getByRole('tab', { name: /Geral/ }).getAttribute('aria-selected')).toBe('true');
    expect(notifyShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        message: expect.stringContaining('Geral, Notas') as string,
      }),
    );
  });

  it('shows a generic red toast in flat layout (no sections)', async () => {
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
        />
      </Wrap>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(notifyShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        message: 'Corrija os campos inválidos antes de salvar.',
      }),
    );
  });

  it('reports errors on excluded fields instead of failing silently', async () => {
    // `obs` is excluded from the form but still required by the schema —
    // zodResolver reports it even though no tab renders it.
    renderTabbed({ excludedFields: ['obs'] });
    const nome = screen.getByRole('textbox', { name: 'Nome' });
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Alice' } });
      fireEvent.blur(nome);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(notifyShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        message: expect.stringContaining('fora do formulário (obs)') as string,
      }),
    );
  });
});
