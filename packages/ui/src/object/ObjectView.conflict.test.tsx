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
import { RecordConflictError, acknowledgedSiblingBaseline } from './saveRecord';
import { valuesEqual } from './diff';
import type { ConflictRebaseInput, ConflictRebaseResult } from '../schema/types';

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
function renderExtraView(
  validate?: React.ComponentProps<typeof ObjectView<typeof extraSchema>>['validate'],
) {
  return render(
    <Wrap>
      <ObjectView
        schema={extraSchema}
        collection={fakeCollection()}
        db={{} as never}
        recordId="EXISTING"
        currentUserUid="u1"
        validate={validate}
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

  it('hands validate() the same sibling baselines transactionWrites reads', async () => {
    // A transient field seeded from a sibling doc is judged against what the
    // save would write, which only the registry's baseline can answer.
    const visto: unknown[] = [];
    renderExtraView((values, context) => {
      const baseline = context.getBaseline(EXTRA_PATH);
      visto.push(baseline);
      const descricao = (values.extraData as { descricao?: unknown } | null)?.descricao;
      return baseline != null && descricao !== baseline.descricao && descricao === 'Proibida'
        ? [{ path: 'extraData', message: 'Descrição proibida' }]
        : [];
    });
    saveRecordMock.mockResolvedValue({ id: 'EXISTING', patch: {}, documents: [] });
    await editAndSave('Descrição', 'Proibida');
    expect(visto.at(-1)).toEqual(EXTRA_LOADED);
    expect(saveRecordMock).not.toHaveBeenCalled();
    expect(notifyShow).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
    await editAndSave('Descrição', 'Permitida');
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

  it('"Salvar mesmo assim" acknowledges ONLY the sibling fields the modal showed', async () => {
    // A partial update compares only what it writes, so a remote change to
    // another field is never listed. Taking the whole server copy as the new
    // baseline would accept it unseen: a form field still showing the old value
    // would then read as an edit and be written back over it.
    const shown: TransactionDocumentConflict = {
      path: EXTRA_PATH,
      current: { descricao: 'Remote', marca: 'Remote marca' },
      fields: ['descricao'],
      guard: extraGuard(EXTRA_LOADED),
    };
    saveRecordMock
      .mockRejectedValueOnce(new RecordConflictError(LOADED, [], false, [shown]))
      .mockResolvedValueOnce({ id: 'EXISTING', patch: {}, documents: [] });
    renderExtraView();
    await editAndSave('Descrição', 'Local');
    await click('Salvar mesmo assim');
    expect(saveRecordMock.mock.calls[1]?.[0].siblingWrites('EXISTING')[0].guard.baseline).toEqual({
      descricao: 'Remote',
      marca: 'Marca',
    });
  });
});

describe('acknowledgedSiblingBaseline — what an override accepts', () => {
  const conflictOf = (
    current: Record<string, unknown> | null,
    fields: string[],
    baseline: Record<string, unknown> | null = EXTRA_LOADED,
  ): TransactionDocumentConflict => ({
    path: EXTRA_PATH,
    current,
    fields,
    guard: extraGuard(baseline),
  });

  it('moves the shown fields to the server value and keeps every other one as loaded', () => {
    expect(
      acknowledgedSiblingBaseline(
        conflictOf({ descricao: 'Remote', marca: 'Remote marca', nova: 1 }, ['descricao']),
      ),
    ).toEqual({ descricao: 'Remote', marca: 'Marca' });
  });

  it('a shown field the server REMOVED is removed from the baseline too', () => {
    expect(acknowledgedSiblingBaseline(conflictOf({ descricao: 'Original' }, ['marca']))).toEqual({
      descricao: 'Original',
    });
  });

  it('a deletion or a creation (@exists) takes the server copy whole', () => {
    expect(acknowledgedSiblingBaseline(conflictOf(null, ['@exists']))).toBeNull();
    const created = { descricao: 'Nova', marca: 'Nova' };
    expect(acknowledgedSiblingBaseline(conflictOf(created, ['@exists'], null))).toEqual(created);
  });
});

describe('ObjectView — a sibling shown in SEVERAL form fields', () => {
  const twoFieldSchema = extraSchema.extend({
    marcaExtra: z.string().nullable().default(null),
  });
  const twoFieldGuard = (
    baseline: Record<string, unknown> | null | undefined,
  ): TransactionDocumentGuard => ({
    ...extraGuard(baseline),
    extraFormFields: [
      {
        formField: 'marcaExtra',
        toFormValue: (data) => (data === null ? null : (data.marca as string)),
      },
    ],
  });

  function MarcaInput({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
    const documents = useObjectViewTransactionDocuments();
    React.useEffect(() => {
      if (value !== null) return;
      documents?.seedFormField('marcaExtra', EXTRA_LOADED.marca);
      onChange(EXTRA_LOADED.marca);
    }, [value, documents, onChange]);
    return (
      <>
        <label>
          Marca
          <input
            value={(value as string | null) ?? ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        {/* What the NEXT reload starts this field's defaults from. */}
        <span data-testid="marca-baseline">{String(documents?.getFormBaseline('marcaExtra'))}</span>
      </>
    );
  }

  function renderTwoFieldView() {
    return render(
      <Wrap>
        <ObjectView
          schema={twoFieldSchema}
          collection={fakeCollection()}
          db={{} as never}
          recordId="EXISTING"
          currentUserUid="u1"
          transientFields={['extraData', 'marcaExtra']}
          fields={{
            extraData: {
              renderInput: (props) => <ExtraInput value={props.value} onChange={props.onChange} />,
            },
            marcaExtra: {
              renderInput: (props) => <MarcaInput value={props.value} onChange={props.onChange} />,
            },
          }}
          transactionWrites={(_id, values, context) => [
            {
              type: 'update',
              ref: { path: EXTRA_PATH } as never,
              data: { descricao: (values.extraData as { descricao: string }).descricao },
              guard: twoFieldGuard(context.getBaseline(EXTRA_PATH)),
            },
          ]}
        />
      </Wrap>,
    );
  }
  const marca = () => (screen.getByLabelText('Marca') as HTMLInputElement).value;

  it('a commit re-projects EVERY field showing the document, not only the first', async () => {
    const stored = { descricao: 'Saved', marca: 'Remote marca' };
    saveRecordMock.mockResolvedValueOnce({
      id: 'EXISTING',
      patch: {},
      documents: [{ path: EXTRA_PATH, data: stored, guard: twoFieldGuard(EXTRA_LOADED) }],
    });
    renderTwoFieldView();
    await editAndSaveContinue('Descrição', 'Saved');
    expect(marca()).toBe('Remote marca');
  });

  it('"Recarregar do servidor" re-projects EVERY field showing the document', async () => {
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError(LOADED, [], false, [
        {
          path: EXTRA_PATH,
          current: { descricao: 'Remote', marca: 'Remote marca' },
          fields: ['descricao'],
          guard: twoFieldGuard(EXTRA_LOADED),
        },
      ]),
    );
    renderTwoFieldView();
    await editAndSave('Descrição', 'Local');
    await click('Recarregar do servidor');
    expect((screen.getByLabelText('Descrição') as HTMLInputElement).value).toBe('Remote');
    expect(marca()).toBe('Remote marca');
    // …and its form baseline with it, which the next reload's defaults start from.
    expect(screen.getByTestId('marca-baseline').textContent).toBe('Remote marca');
  });
});

/*
 * `FieldConfig.rebaseOnConflict` — a list field that MERGES on a tier-3
 * conflict instead of one side winning wholesale. The merge itself is the
 * field's own (here a test double keyed by `id`); what this file pins is the
 * WIRING: which fields reach it, with which three values, what each button does
 * with the answer, and that the merged value is validated before it is written.
 *
 * Every case comes as a pair: the field WITH the hook is merged, and its
 * near-miss — a field without the hook, or a field with the hook that did not
 * collide — keeps the behaviour above exactly.
 */
interface Item {
  readonly id: string;
  readonly v: number;
}
const listaSchema = schema.extend({
  itens: z.array(z.json()).nullable().optional().describe('Itens'),
});
const ITENS_CARREGADOS: Item[] = [{ id: 'a', v: 1 }];
/** Another operator added `b` after this form loaded. */
const ITENS_SERVIDOR: Item[] = [
  { id: 'a', v: 1 },
  { id: 'b', v: 1 },
];
const LISTA_CARREGADA = { nome: 'Alice', itens: ITENS_CARREGADOS };

/**
 * The test double: the server's list is the base and each item the operator
 * added or changed (by value against `loaded`, keyed by `id`) is re-applied on
 * it; an item BOTH sides changed keeps the server's version and collides.
 */
function mesclarPorId({ loaded, server, mine }: ConflictRebaseInput): ConflictRebaseResult {
  const carregados = new Map(((loaded as Item[] | null) ?? []).map((i) => [i.id, i]));
  const saida = [...((server as Item[] | null) ?? [])];
  let collided = false;
  for (const meu of (mine as Item[] | null) ?? []) {
    const antes = carregados.get(meu.id);
    if (antes !== undefined && valuesEqual(antes, meu)) continue;
    const i = saida.findIndex((s) => s.id === meu.id);
    if (antes !== undefined && !valuesEqual(saida[i], antes)) {
      collided = true;
      continue;
    }
    if (i >= 0) saida[i] = meu;
    else saida.push(meu);
  }
  return { value: saida, collided };
}
const mesclar = vi.fn(mesclarPorId);

function ItensInput({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const itens = (value as Item[] | null) ?? [];
  return (
    <div>
      <span data-testid="itens">{itens.map((i) => `${i.id}=${String(i.v)}`).join(',')}</span>
      <button type="button" onClick={() => onChange([...itens, { id: 'c', v: 1 }])}>
        Adicionar c
      </button>
      <button
        type="button"
        onClick={() => onChange(itens.map((i) => (i.id === 'a' ? { ...i, v: i.v + 1 } : i)))}
      >
        Alterar a
      </button>
    </div>
  );
}

const CAMPOS_COM_MESCLA = {
  itens: {
    renderInput: (p: { value: unknown; onChange: (next: unknown) => void }) => (
      <ItensInput value={p.value} onChange={p.onChange} />
    ),
    rebaseOnConflict: { label: 'mescla por item', merge: mesclar },
  },
};
const CAMPOS_SEM_MESCLA = {
  itens: {
    renderInput: (p: { value: unknown; onChange: (next: unknown) => void }) => (
      <ItensInput value={p.value} onChange={p.onChange} />
    ),
  },
};

function renderLista(
  opcoes: {
    fields?: typeof CAMPOS_COM_MESCLA | typeof CAMPOS_SEM_MESCLA;
    validate?: React.ComponentProps<typeof ObjectView<typeof listaSchema>>['validate'];
  } = {},
) {
  return render(
    <Wrap>
      <ObjectView
        schema={listaSchema}
        collection={fakeCollection() as never}
        db={{} as never}
        currentUserUid="u1"
        recordId="EXISTING"
        fields={opcoes.fields ?? CAMPOS_COM_MESCLA}
        validate={opcoes.validate}
      />
    </Wrap>,
  );
}

const itensNaTela = () => screen.getByTestId('itens').textContent;
const chamadaDoSave = (n: number) =>
  saveRecordMock.mock.calls[n]?.[0] as {
    values: Record<string, unknown>;
    dirtyFields: Record<string, unknown>;
    baseline?: Record<string, unknown>;
  };
async function esperarEfeitos() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('ObjectView — a field that merges on conflict (rebaseOnConflict)', () => {
  beforeEach(() => {
    mesclar.mockClear();
    docState.current = {
      data: { id: 'EXISTING', data: structuredClone(LISTA_CARREGADA) },
      loading: false,
      error: undefined,
      fromCache: false,
    };
  });

  it('the modal row of a merging field reads its label; a field without the hook still reads "Sobrescreve"', async () => {
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError({ nome: 'Alexandra', itens: ITENS_SERVIDOR }, ['nome', 'itens']),
    );
    renderLista();
    await click('Adicionar c');
    await editAndSave('Nome', 'Alicia');

    expect(screen.getByText('mescla por item')).toBeTruthy();
    // NEAR-MISS: `nome` has no hook, so its row still overwrites.
    expect(screen.getAllByText('Sobrescreve')).toHaveLength(1);
  });

  it('"Recarregar do servidor" applies the merge over the server value and WAITS — nothing is saved', async () => {
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError({ nome: 'Alice', itens: ITENS_SERVIDOR }, ['itens']),
    );
    renderLista();
    await click('Adicionar c');
    await click('Salvar');
    await click('Recarregar do servidor');

    expect(mesclar).toHaveBeenCalledWith({
      loaded: ITENS_CARREGADOS,
      server: ITENS_SERVIDOR,
      mine: [...ITENS_CARREGADOS, { id: 'c', v: 1 }],
    });
    expect(itensNaTela()).toBe('a=1,b=1,c=1');
    expect(saveRecordMock).toHaveBeenCalledOnce();

    // The next save writes the merged list, judged against the SERVER's version.
    saveRecordMock.mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    await click('Salvar');
    expect(chamadaDoSave(1).values.itens).toEqual([...ITENS_SERVIDOR, { id: 'c', v: 1 }]);
    expect(chamadaDoSave(1).dirtyFields).toMatchObject({ itens: true });
    expect(chamadaDoSave(1).baseline?.itens).toEqual(ITENS_SERVIDOR);
  });

  it('NEAR-MISS: "Recarregar do servidor" on a field WITHOUT the hook takes the server list wholesale', async () => {
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError({ nome: 'Alice', itens: ITENS_SERVIDOR }, ['itens']),
    );
    renderLista({ fields: CAMPOS_SEM_MESCLA });
    await click('Adicionar c');
    await click('Salvar');
    await click('Recarregar do servidor');

    expect(itensNaTela()).toBe('a=1,b=1');
    expect(mesclar).not.toHaveBeenCalled();
  });

  it('"Salvar mesmo assim" with nothing collided saves the MERGED list, validated, against the server baseline', async () => {
    saveRecordMock
      .mockRejectedValueOnce(
        new RecordConflictError({ nome: 'Alice', itens: ITENS_SERVIDOR }, ['itens']),
      )
      .mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    const validate = vi.fn((_values: Record<string, unknown>) => []);
    renderLista({ validate });
    await click('Adicionar c');
    await click('Salvar');
    const validacoesAntes = validate.mock.calls.length;
    await click('Salvar mesmo assim');
    await esperarEfeitos();

    expect(saveRecordMock).toHaveBeenCalledTimes(2);
    expect(chamadaDoSave(1).values.itens).toEqual([...ITENS_SERVIDOR, { id: 'c', v: 1 }]);
    expect(chamadaDoSave(1).baseline?.itens).toEqual(ITENS_SERVIDOR);
    // The merged list went through validation before it was written.
    expect(validate.mock.calls.length).toBeGreaterThan(validacoesAntes);
    expect(validate.mock.lastCall?.[0]).toMatchObject({
      itens: [...ITENS_SERVIDOR, { id: 'c', v: 1 }],
    });
  });

  it('NEAR-MISS: "Salvar mesmo assim" on a field WITHOUT the hook re-saves the operator list wholesale', async () => {
    saveRecordMock
      .mockRejectedValueOnce(
        new RecordConflictError({ nome: 'Alice', itens: ITENS_SERVIDOR }, ['itens']),
      )
      .mockResolvedValueOnce({ id: 'EXISTING', patch: {} });
    renderLista({ fields: CAMPOS_SEM_MESCLA });
    await click('Adicionar c');
    await click('Salvar');
    await click('Salvar mesmo assim');
    await esperarEfeitos();

    expect(chamadaDoSave(1).values.itens).toEqual([...ITENS_CARREGADOS, { id: 'c', v: 1 }]);
  });

  it('"Salvar mesmo assim" with a collision does NOT save: the merged list waits in the form', async () => {
    // Both sides changed `a`: the server's version stays, and the operator looks first.
    const servidor: Item[] = [{ id: 'a', v: 9 }];
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError({ nome: 'Alice', itens: servidor }, ['itens']),
    );
    renderLista();
    await click('Alterar a');
    await click('Salvar');
    await click('Salvar mesmo assim');
    await esperarEfeitos();

    expect(saveRecordMock).toHaveBeenCalledOnce();
    expect(screen.queryByText('Registro alterado')).toBeNull();
    expect(itensNaTela()).toBe('a=9');
  });

  it('a merging field that did NOT collide is not merged: the reload keeps the operator edit', async () => {
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError({ nome: 'Alexandra', itens: ITENS_CARREGADOS }, ['nome']),
    );
    renderLista();
    await click('Adicionar c');
    await editAndSave('Nome', 'Alicia');
    await click('Recarregar do servidor');

    expect(mesclar).not.toHaveBeenCalled();
    expect(itensNaTela()).toBe('a=1,c=1');
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Alexandra');
  });

  it('a validate refusing the MERGED list blocks the override: nothing more is written', async () => {
    saveRecordMock.mockRejectedValueOnce(
      new RecordConflictError({ nome: 'Alice', itens: ITENS_SERVIDOR }, ['itens']),
    );
    // Refuses only the list the merge produces (it carries the server's `b`).
    renderLista({
      validate: (values) =>
        ((values.itens as Item[] | null) ?? []).some((i) => i.id === 'b')
          ? [{ path: 'itens', message: 'b não pode' }]
          : [],
    });
    await click('Adicionar c');
    await click('Salvar');
    await click('Salvar mesmo assim');
    await esperarEfeitos();

    expect(saveRecordMock).toHaveBeenCalledOnce();
    expect(notifyShow).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
  });

  it('a THIRD write landing during the merged override raises the modal again', async () => {
    saveRecordMock
      .mockRejectedValueOnce(
        new RecordConflictError({ nome: 'Alice', itens: ITENS_SERVIDOR }, ['itens']),
      )
      .mockRejectedValueOnce(
        new RecordConflictError({ nome: 'Alice', itens: [...ITENS_SERVIDOR, { id: 'd', v: 1 }] }, [
          'itens',
        ]),
      );
    renderLista();
    await click('Adicionar c');
    await click('Salvar');
    await click('Salvar mesmo assim');
    await esperarEfeitos();

    expect(saveRecordMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Registro alterado')).toBeTruthy();
  });
});
