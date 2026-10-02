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
import { MantineTestProvider } from '../testing/mantine';
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
import { useObjectViewTransactionDocuments } from './ObjectViewTransactionDocuments';
import type { TransactionDocumentGuard, TransactionDocumentConflict } from './saveRecord';
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
 * `MantineTestProvider` renders the `Modal` inline rather than through a portal,
 * which is what keeps its content inside this tree. It is no longer what stops
 * the Transition hanging — `vitest.setup.ts` drives every transition duration to
 * 0 (#1150).
 */
function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <MantineTestProvider>
      <Notifications />
      {children}
    </MantineTestProvider>
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

/**
 * The "Salvar e continuar" path — the one that leaves the form MOUNTED, so the
 * same record can be saved twice without the listener ever being torn down.
 * `editAndSave` cannot stand in for it: the plain "Salvar" navigates away in
 * `onSaved`, which is precisely why the stale baseline below never showed up.
 */
async function editAndSaveContinue(field: string, value: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(field), { target: { value } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar' }));
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

  it('re-bases the baseline onto a successful save, so saving twice is not a false conflict', async () => {
    // ⚠️ The mirror image of the `#791` case above, and it only became reachable
    // once the listener started delivering `fromCache: false` at all: with the
    // baseline permanently null the guard was skipped, so this could not fire.
    // Arm it and the ORDINARY "Salvar e continuar" path breaks — the baseline
    // keeps the pre-save version while the server holds the post-save one, so a
    // second edit of the same field collides with the operator's OWN write.
    //
    // `useServerTruthSeed` cannot repair it: it corrects once per record id, and
    // that already happened on open. The echo re-emitted below proves exactly
    // that — a fresh server snapshot arrives and changes nothing.
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: { nome: 'Alicia' } });
    renderView();

    await editAndSaveContinue('Nome', 'Alicia');
    // The form stays mounted (no navigation), and the server echoes the write.
    docState.current = {
      data: { id: 'EXISTING', data: { ...LOADED, nome: 'Alicia' } },
      loading: false,
      error: undefined,
      fromCache: false,
    };

    await editAndSave('Nome', 'Alicia Segunda');

    expect(saveRecordMock).toHaveBeenCalledTimes(2);
    const second = saveRecordMock.mock.calls[1]![0] as { baseline?: Record<string, unknown> };
    // The version the operator last knew is the one THEY just wrote.
    expect(second.baseline?.nome).toBe('Alicia');
    // Untouched fields still come from the server seed — the re-base merges the
    // patch in, it does not replace the baseline with it.
    expect(second.baseline?.email).toBe('a@x.com');
  });

  it('does NOT let a successful save ARM a baseline that server truth never seeded', async () => {
    // The null check on that re-base, which is easy to read as a mere
    // null-safety nicety. It is the `#791` safeguard again, one step later.
    //
    // On a cache paint that no server snapshot has corrected, the baseline is
    // deliberately null — fail open, because a version nobody displayed cannot be
    // used to raise a conflict the operator could act on. A re-base that skipped
    // this check would MANUFACTURE a baseline out of the patch, claiming server
    // truth for a record we never read from the server, and every later save
    // would be judged against it.
    docState.current = {
      data: { id: 'EXISTING', data: { ...LOADED } },
      loading: false,
      error: undefined,
      fromCache: true,
    };
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: { nome: 'Alicia' } });
    renderView();

    await editAndSaveContinue('Nome', 'Alicia');
    await editAndSave('Nome', 'Alicia Segunda');

    expect(saveRecordMock).toHaveBeenCalledTimes(2);
    const second = saveRecordMock.mock.calls[1]![0] as { baseline?: Record<string, unknown> };
    expect(second.baseline).toBeUndefined();
  });
});

const EXTRA_PATH = 'clientes/EXISTING/extra/singleton';
const EXTRA_LOADED = { descricao: 'Original', marca: 'Marca' };
const extraSchema = schema.extend({
  extraData: z.object({ descricao: z.string(), marca: z.string() }).nullable().default(null),
});
const extraGuard = (
  baseline: Record<string, unknown> | null | undefined,
): TransactionDocumentGuard => ({
  baseline,
  label: 'Descrição do produto',
  formField: 'extraData',
  toFormValue: (data) => data,
});

function ExtraInput({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const documents = useObjectViewTransactionDocuments();
  React.useEffect(() => {
    if (value !== null) return;
    documents?.seedBaseline(EXTRA_PATH, EXTRA_LOADED);
    documents?.seedFormField('extraData', EXTRA_LOADED);
    onChange(EXTRA_LOADED);
  }, [value, documents, onChange]);
  const data = (value as typeof EXTRA_LOADED | null) ?? EXTRA_LOADED;
  return (
    <label>
      Descrição
      <input
        value={data.descricao}
        onChange={(e) => onChange({ ...data, descricao: e.target.value })}
      />
    </label>
  );
}
function renderExtraView() {
  return render(
    <Wrap>
      <ObjectView
        schema={extraSchema}
        collection={fakeCollection()}
        db={{} as never}
        recordId="EXISTING"
        currentUserUid="u1"
        transientFields={['extraData']}
        fields={{
          extraData: {
            renderInput: (props) => <ExtraInput value={props.value} onChange={props.onChange} />,
          },
        }}
        transactionWrites={(_id, values, context) => [
          {
            type: 'set',
            ref: { path: EXTRA_PATH } as never,
            data: values.extraData as Record<string, unknown>,
            guard: extraGuard(context.getBaseline(EXTRA_PATH)),
          },
        ]}
      />
    </Wrap>,
  );
}
function extraConflict(
  current: Record<string, unknown> | null,
  baseline: Record<string, unknown> | null = EXTRA_LOADED,
): RecordConflictError {
  const doc: TransactionDocumentConflict = {
    path: EXTRA_PATH,
    current,
    fields: current === null || baseline === null ? ['@exists'] : ['descricao'],
    guard: extraGuard(baseline),
  };
  return new RecordConflictError(LOADED, [], false, [doc]);
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('ObjectView — sibling conflicts', () => {
  it('does not acknowledge a parent conflict when Cancel is clicked', async () => {
    saveRecordMock.mockRejectedValue(
      new RecordConflictError({ ...LOADED, nome: 'Remote' }, ['nome']),
    );
    renderView();
    await editAndSave('Nome', 'Local');
    await click('Cancelar');
    await click('Salvar');
    expect(saveRecordMock.mock.calls[1]?.[0].baseline).toEqual(LOADED);
    expect(screen.getByText('Registro alterado')).toBeTruthy();
  });

  it('passes the sibling baseline through the third transactionWrites argument', async () => {
    saveRecordMock.mockImplementation((input) => {
      expect(input.siblingWrites('EXISTING')[0].guard.baseline).toEqual(EXTRA_LOADED);
      return Promise.resolve({ id: 'EXISTING', patch: {}, documents: [] });
    });
    renderExtraView();
    await editAndSave('Descrição', 'Local');
    expect(saveRecordMock).toHaveBeenCalledOnce();
  });

  it('names the document and preserves its baseline after Cancel', async () => {
    saveRecordMock.mockRejectedValue(extraConflict({ ...EXTRA_LOADED, descricao: 'Remote' }));
    renderExtraView();
    await editAndSave('Descrição', 'Local');
    expect(screen.getByText('Descrição do produto — descricao')).toBeTruthy();
    await click('Cancelar');
    await click('Salvar');
    const second = saveRecordMock.mock.calls[1]?.[0].siblingWrites('EXISTING')[0];
    expect(second.guard.baseline).toEqual(EXTRA_LOADED);
    expect((screen.getByLabelText('Descrição') as HTMLInputElement).value).toBe('Local');
  });

  it('reloads the contested document while retaining a dirty parent field', async () => {
    saveRecordMock.mockRejectedValueOnce(extraConflict({ ...EXTRA_LOADED, descricao: 'Remote' }));
    renderExtraView();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Local name' } });
    });
    await editAndSave('Descrição', 'Local');
    await click('Recarregar do servidor');
    expect((screen.getByLabelText('Descrição') as HTMLInputElement).value).toBe('Remote');
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Local name');
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: {}, documents: [] });
    await click('Salvar');
    expect(saveRecordMock.mock.calls[1]?.[0].dirtyFields).toMatchObject({ nome: true });
    expect(
      saveRecordMock.mock.calls[1]?.[0].siblingWrites('EXISTING')[0].guard.baseline,
    ).toMatchObject({ descricao: 'Remote' });
  });

  it('acknowledges only the reviewed document and detects another conflict on override', async () => {
    const reviewed = { ...EXTRA_LOADED, descricao: 'Reviewed' };
    saveRecordMock
      .mockRejectedValueOnce(extraConflict(reviewed))
      .mockRejectedValueOnce(
        extraConflict({ ...EXTRA_LOADED, descricao: 'Third writer' }, reviewed),
      );
    renderExtraView();
    await editAndSave('Descrição', 'Local');
    await click('Salvar mesmo assim');
    expect(saveRecordMock.mock.calls[1]?.[0].siblingWrites('EXISTING')[0].guard.baseline).toEqual(
      reviewed,
    );
    expect(screen.getByText('Third writer')).toBeTruthy();
  });

  it('rebases committed siblings for a second save without accepting later listener data', async () => {
    const committed = { ...EXTRA_LOADED, descricao: 'Saved' };
    saveRecordMock.mockResolvedValueOnce({
      id: 'EXISTING',
      patch: {},
      documents: [{ path: EXTRA_PATH, data: committed, guard: extraGuard(EXTRA_LOADED) }],
    });
    renderExtraView();
    await editAndSaveContinue('Descrição', 'Saved');
    saveRecordMock.mockRejectedValueOnce(
      extraConflict({ ...committed, descricao: 'Remote' }, committed),
    );
    await editAndSave('Descrição', 'Second edit');
    expect(saveRecordMock.mock.calls[1]?.[0].siblingWrites('EXISTING')[0].guard.baseline).toEqual(
      committed,
    );
  });
});
