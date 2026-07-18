import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { intFreteSchema } from '@delfrance/schemas';
import type { CollectionHandle } from '@delfrance/data';

/**
 * High-fidelity reproduction of the reported /logistica create-form bug:
 * clicking "Criar" from a non-first tab with required fields empty must
 * toast + jump to the erroring tab. Uses the REAL intFreteSchema, the REAL
 * intFreteFields (editors included) and the REAL slice sections — only the
 * Firebase-dependent FilialPicker is stubbed.
 */

const { saveRecordMock, NothingChanged, notifyShow } = vi.hoisted(() => {
  class NothingChanged extends Error {}
  return { saveRecordMock: vi.fn(), NothingChanged, notifyShow: vi.fn() };
});

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    useDocSnapshot: () => ({ data: null, loading: false, error: undefined }),
  };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@delfrance/ui', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/ui')>('@delfrance/ui');
  return {
    ...actual,
    saveRecord: (input: unknown) => saveRecordMock(input),
    NothingChangedError: NothingChanged,
  };
});

vi.mock('@mantine/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@mantine/notifications')>('@mantine/notifications');
  return { ...actual, notifications: { show: (...args: unknown[]) => notifyShow(...args) } };
});

vi.mock('@/components/pickers/FilialPicker', () => ({
  filialRefRenderInput:
    () =>
    // eslint-disable-next-line react/display-name
    (props: { name: string; label: string; value: unknown; onChange: (v: unknown) => void }) => (
      <input
        aria-label={props.label}
        value={(props.value as string) ?? ''}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      />
    ),
}));

import { ObjectView } from '@delfrance/ui';
import { intFreteFields } from './intFreteFields';
import { LOGISTICA_SLICES, SHARED_EXCLUDED } from './slices';

function fakeCollection(): CollectionHandle<typeof intFreteSchema> {
  return {
    resolvePath: () => 'int_frete',
    ref: () => ({}) as never,
    docRef: () => ({}) as never,
    converter: {} as never,
    merge: () => Promise.resolve(),
  };
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <MantineProvider env="test">{children}</MantineProvider>;
}

beforeEach(() => {
  saveRecordMock.mockReset();
  notifyShow.mockReset();
});

describe('logistica create form — invalid submit from a non-first tab', () => {
  it('toasts and jumps to "Dados gerais" when Nome/Filial are empty', async () => {
    const slice = LOGISTICA_SLICES.motoboy;
    render(
      <Wrap>
        <ObjectView
          schema={intFreteSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          sections={[...slice.sections]}
          fields={intFreteFields}
          excludedFields={[...SHARED_EXCLUDED, ...slice.extraExcluded]}
          defaultValues={{
            tipo: slice.tipo,
            ativo: true,
            prazoExtra: 0,
            dataCadastro: 1718000000000,
          }}
          saveLabel="Criar"
          showSaveAndContinue={false}
        />
      </Wrap>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Horários de corte' }));
    });
    expect(
      screen.getByRole('tab', { name: 'Horários de corte' }).getAttribute('aria-selected'),
    ).toBe('true');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    });

    expect(saveRecordMock).not.toHaveBeenCalled();
    expect(notifyShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        message: expect.stringContaining('Dados gerais') as string,
      }),
    );
    expect(screen.getByRole('tab', { name: /Dados gerais/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});
