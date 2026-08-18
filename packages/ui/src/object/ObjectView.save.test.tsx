import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import { useWatch } from 'react-hook-form';
import { z, ZodError } from 'zod';
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

// PARTIAL mock: `saveRecord` itself is stubbed, but every other export —
// `RecordConflictError` and whatever comes next — stays real. A full replacement
// silently drops new exports, and `ObjectView` then dies on an `instanceof`
// against `undefined` inside a catch, which surfaces as an unrelated
// "expected vi.fn() to be called" three tests away.
vi.mock('./saveRecord', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./saveRecord')>()),
  saveRecord: (input: unknown) => saveRecordMock(input),
  NothingChangedError: NothingChanged,
}));

vi.mock('@mantine/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@mantine/notifications')>('@mantine/notifications');
  return { ...actual, notifications: { show: (...args: unknown[]) => notifyShow(...args) } };
});

import { ObjectView } from './ObjectView';
import { AfterSaveBlockedError } from './afterSaveBlocked';
import { DELETE_MARK, stripMarkedForDeletion } from './markForDeletion';

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

  it('applies prepareForSave to a dirty field before saving (transformed value reaches saveRecord)', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: { nome: 'Updated!' } });
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          fields={{ nome: { prepareForSave: (v) => `${v as string}!` } }}
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
    const arg = saveRecordMock.mock.calls[0]![0] as { values: Record<string, unknown> };
    expect(arg.values.nome).toBe('Updated!');
  });

  it('deriveOnSave adds a derived field to the patch and marks it dirty when its source changed', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice', email: 'a@x.com' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          deriveOnSave={(v) => ({ email: `${v.nome as string}@x.com` })}
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
    const arg = saveRecordMock.mock.calls[0]![0] as {
      values: Record<string, unknown>;
      dirtyFields: Record<string, unknown>;
    };
    expect(arg.values.email).toBe('Updated@x.com');
    expect(arg.dirtyFields.email).toBe(true);
  });

  it('deriveOnSave leaves an unchanged derived field out of the dirty set', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'alice', email: 'alice@x.com' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          deriveOnSave={(v) => ({ email: `${v.nome as string}@x.com` })}
        />
      </Wrap>,
    );
    // Pristine submit: the derived `email` equals the loaded value, so it must
    // not be marked dirty (a no-op update still short-circuits downstream).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    const arg = saveRecordMock.mock.calls[0]![0] as {
      values: Record<string, unknown>;
      dirtyFields: Record<string, unknown>;
    };
    expect(arg.values.email).toBe('alice@x.com');
    expect(arg.dirtyFields.email).toBeUndefined();
  });

  it('deriveOnSave skips keys whose derived value is undefined (never written, never dirty)', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice', email: 'a@x.com' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          deriveOnSave={() => ({ email: undefined as unknown as string })}
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
    const arg = saveRecordMock.mock.calls[0]![0] as {
      values: Record<string, unknown>;
      dirtyFields: Record<string, unknown>;
    };
    // Firestore rejects undefined: the derived key must keep its form value
    // and must not be marked dirty.
    expect(arg.values.email).toBe('a@x.com');
    expect(arg.dirtyFields.email).toBeUndefined();
  });

  it('awaits onAfterSave on both save paths and a FirebaseError from it skips onSaved', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: {} });
    const onAfterSave = vi.fn().mockResolvedValueOnce(undefined);
    const onSaved = vi.fn();
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          onAfterSave={onAfterSave}
          onSaved={onSaved}
        />
      </Wrap>,
    );
    const nome = screen.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Once' } });
      fireEvent.blur(nome);
    });
    // Path 1: "Salvar e continuar" → onAfterSave runs, green toast, no onSaved.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar' }));
    });
    // The transformed save values are handed through as the second argument.
    expect(onAfterSave).toHaveBeenCalledWith('EXISTING', expect.objectContaining({ nome: 'Once' }));
    expect(onSaved).not.toHaveBeenCalled();

    // Path 2: "Salvar" with onAfterSave rejecting → alert shown, onSaved skipped.
    onAfterSave.mockRejectedValueOnce(
      new FirebaseError('permission-denied', 'Falha ao salvar as variações.'),
    );
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Twice' } });
      fireEvent.blur(nome);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(onAfterSave).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Falha ao salvar as variações.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('AfterSaveBlockedError surfaces in the alert and never navigates away', async () => {
    // The record IS saved by the time onAfterSave runs; this error means the
    // sibling step paused on purpose and put something in front of the operator
    // (a write conflict to review). Calling onSaved would navigate off the very
    // screen holding it.
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: {} });
    const onSaved = vi.fn();
    const onAfterSave = vi
      .fn()
      .mockRejectedValue(new AfterSaveBlockedError('O anúncio foi alterado por outra pessoa.'));
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          onAfterSave={onAfterSave}
          onSaved={onSaved}
        />
      </Wrap>,
    );
    const nome = screen.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Bloqueado' } });
      fireEvent.blur(nome);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(screen.getByText('O anúncio foi alterado por outra pessoa.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('AfterSaveBlockedError is handled on the pristine (NothingChanged) path too', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockRejectedValue(new NothingChanged('Nada alterado.'));
    const onSaved = vi.fn();
    const onAfterSave = vi
      .fn()
      .mockRejectedValue(new AfterSaveBlockedError('Conflito no anúncio.'));
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          onAfterSave={onAfterSave}
          onSaved={onSaved}
        />
      </Wrap>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(onAfterSave).toHaveBeenCalled();
    expect(screen.getByText('Conflito no anúncio.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('runs onAfterSave on a pristine form (NothingChanged) and treats it as a save', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockRejectedValueOnce(new NothingChanged('Nenhuma alteração para salvar'));
    const onAfterSave = vi.fn().mockResolvedValueOnce(undefined);
    const onSaved = vi.fn();
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          onAfterSave={onAfterSave}
          onSaved={onSaved}
        />
      </Wrap>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    // Sibling writes still flush and the action counts as a save — no yellow toast.
    // The pristine path passes the (unchanged) values through too.
    expect(onAfterSave).toHaveBeenCalledWith(
      'EXISTING',
      expect.objectContaining({ nome: 'Alice' }),
    );
    expect(onSaved).toHaveBeenCalledWith('EXISTING');
    expect(notifyShow).not.toHaveBeenCalledWith(expect.objectContaining({ color: 'yellow' }));
  });

  it('formats a ZodError from onAfterSave on the pristine path as joined issue messages', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockRejectedValueOnce(new NothingChanged('Nenhuma alteração para salvar'));
    // Sibling flushes abort with contextualized custom issues (e.g. duplicate
    // SKUs / blocked deletions in the variations manager) — the alert must
    // show the human messages, not ZodError's serialized-issues `message`.
    const onAfterSave = vi
      .fn()
      .mockRejectedValueOnce(
        new ZodError([
          { code: 'custom', path: [], message: 'SKU duplicado entre as variações: X.' } as never,
        ]),
      );
    const onSaved = vi.fn();
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          onAfterSave={onAfterSave}
          onSaved={onSaved}
        />
      </Wrap>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(screen.getByText('SKU duplicado entre as variações: X.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('surfaces a FirebaseError from saveRecord in the form alert', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockRejectedValueOnce(
      new FirebaseError('permission-denied', 'Missing or insufficient permissions.'),
    );
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
    const nome = screen.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Updated' } });
      fireEvent.blur(nome);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(screen.getByText('Missing or insufficient permissions.')).toBeTruthy();
  });

  it('exposes the RHF context to custom renderInput (live sibling-field reads)', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice', email: 'a@x.com' } },
      loading: false,
      error: undefined,
    };
    // A custom widget reading a SIBLING field live through the FormProvider —
    // the mechanism the VariationManager uses to generate child SKUs from the
    // parent's unsaved `sku`.
    function SiblingEcho() {
      const nome = useWatch({ name: 'nome' });
      return <div data-testid="echo">{String(nome)}</div>;
    }
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          fields={{ email: { renderInput: () => <SiblingEcho /> } }}
        />
      </Wrap>,
    );
    expect(screen.getByTestId('echo').textContent).toBe('Alice');
    const nome = screen.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Unsaved edit' } });
    });
    // Live (unsaved) edits propagate to the sibling widget.
    expect(screen.getByTestId('echo').textContent).toBe('Unsaved edit');
  });

  it('shows a "não encontrado" alert and hides save in edit mode when the doc is missing', () => {
    docState.current = { data: null, loading: false, error: undefined };
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="MISSING"
        />
      </Wrap>,
    );
    expect(screen.getByText('Registro não encontrado.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  });

  it('shows a load-error alert and hides save in edit mode when the snapshot errors', () => {
    docState.current = { data: undefined, loading: false, error: new Error('boom') };
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
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  });
});

describe('transientFields (aggregate page-model extras kept out of the doc write)', () => {
  const transientSchema = z.object({
    nome: z.string().nullable().optional().describe('Nome'),
    anotacao: z.string().nullable().optional().describe('Anotação'),
  });

  it('strips transient fields from the document write but delivers them to onAfterSave', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    const onAfterSave = vi.fn().mockResolvedValueOnce(undefined);
    render(
      <Wrap>
        <ObjectView
          schema={transientSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          transientFields={['anotacao']}
          onAfterSave={onAfterSave}
        />
      </Wrap>,
    );
    const nome = screen.getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    const anotacao = screen.getByRole('textbox', { name: 'Anotação' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nome, { target: { value: 'Updated' } });
      fireEvent.blur(nome);
      fireEvent.change(anotacao, { target: { value: 'oculto' } });
      fireEvent.blur(anotacao);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    const arg = saveRecordMock.mock.calls[0]![0] as {
      values: Record<string, unknown>;
      dirtyFields: Record<string, unknown>;
    };
    // The transient key never reaches the document write (values + dirty set)…
    expect(arg.values).not.toHaveProperty('anotacao');
    expect(arg.values.nome).toBe('Updated');
    expect(arg.dirtyFields).not.toHaveProperty('anotacao');
    expect(arg.dirtyFields.nome).toBe(true);
    // …but the FULL values (transient included) flow to onAfterSave for the
    // sibling write.
    expect(onAfterSave).toHaveBeenCalledWith(
      'EXISTING',
      expect.objectContaining({ nome: 'Updated', anotacao: 'oculto' }),
    );
  });

  it('a save touching ONLY a transient field leaves an empty doc patch yet still runs onAfterSave', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    // With the transient key stripped, the doc patch is empty — real saveRecord
    // throws NothingChanged; the mock emulates that so we can assert the sibling
    // write still runs and the action counts as a save.
    saveRecordMock.mockRejectedValueOnce(new NothingChanged('Nenhuma alteração para salvar'));
    const onAfterSave = vi.fn().mockResolvedValueOnce(undefined);
    const onSaved = vi.fn();
    render(
      <Wrap>
        <ObjectView
          schema={transientSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          transientFields={['anotacao']}
          onAfterSave={onAfterSave}
          onSaved={onSaved}
        />
      </Wrap>,
    );
    const anotacao = screen.getByRole('textbox', { name: 'Anotação' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(anotacao, { target: { value: 'oculto' } });
      fireEvent.blur(anotacao);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    const arg = saveRecordMock.mock.calls[0]![0] as { dirtyFields: Record<string, unknown> };
    expect(arg.dirtyFields).not.toHaveProperty('anotacao');
    expect(Object.keys(arg.dirtyFields)).toHaveLength(0);
    expect(onAfterSave).toHaveBeenCalledWith(
      'EXISTING',
      expect.objectContaining({ anotacao: 'oculto' }),
    );
    expect(onSaved).toHaveBeenCalledWith('EXISTING');
  });

  it('forwards transactionWrites to saveRecord as siblingWrites keyed by the record id', async () => {
    docState.current = {
      data: { id: 'EXISTING', data: { nome: 'Alice' } },
      loading: false,
      error: undefined,
    };
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    const fakeRef = { id: 'sibling-doc' } as never;
    render(
      <Wrap>
        <ObjectView
          schema={transientSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          recordId="EXISTING"
          transientFields={['anotacao']}
          transactionWrites={(id, values) => [
            { type: 'set', ref: fakeRef, data: { id, anotacao: values.anotacao } },
          ]}
        />
      </Wrap>,
    );
    const anotacao = screen.getByRole('textbox', { name: 'Anotação' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(anotacao, { target: { value: 'oculto' } });
      fireEvent.blur(anotacao);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    // ObjectView hands saveRecord a `siblingWrites(id)` closure that resolves the
    // transactionWrites hook with the record id + the FULL values (transient
    // included), so the sibling rides the same transaction.
    const arg = saveRecordMock.mock.calls[0]![0] as {
      siblingWrites?: (id: string) => unknown[];
    };
    expect(typeof arg.siblingWrites).toBe('function');
    expect(arg.siblingWrites!('EXISTING')).toEqual([
      { type: 'set', ref: fakeRef, data: { id: 'EXISTING', anotacao: 'oculto' } },
    ]);
  });
});

describe('validate-what-you-save resolver (prepareForSave before validation)', () => {
  const stagedSchema = z.object({
    nome: z.string().min(1).describe('Nome'),
    itens: z
      .array(z.object({ cep: z.string().regex(/^\d{8}$/) }).passthrough())
      .nullable()
      .default(null)
      .describe('Itens'),
  });
  const stagedFields = {
    itens: { hidden: true, prepareForSave: stripMarkedForDeletion },
  };

  it('a schema-invalid row marked for deletion does NOT block the save', async () => {
    saveRecordMock.mockResolvedValueOnce({ id: 'NEW', patch: {} });
    render(
      <Wrap>
        <ObjectView
          schema={stagedSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          defaultValues={{
            nome: 'ok',
            itens: [{ cep: '01000000' }, { cep: '1', [DELETE_MARK]: true }],
          }}
          fields={stagedFields}
        />
      </Wrap>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(saveRecordMock).toHaveBeenCalledTimes(1);
  });

  it('a schema-invalid UNMARKED row still blocks the save', async () => {
    render(
      <Wrap>
        <ObjectView
          schema={stagedSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          defaultValues={{
            nome: 'ok',
            itens: [{ cep: '1' }],
          }}
          fields={stagedFields}
        />
      </Wrap>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(saveRecordMock).not.toHaveBeenCalled();
  });
});
