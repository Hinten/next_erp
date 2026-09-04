import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { intFreteSchema, UF_SIGLA, type Endereco } from '@delfrance/schemas';
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

/**
 * `ObjectView` imports `saveRecord` from inside `@delfrance/ui`, not through the
 * barrel, so the `vi.mock('@delfrance/ui')` above cannot intercept it — the REAL
 * one runs. Stub the three `firebase/firestore` primitives it touches instead
 * (partially: everything else stays real, `@delfrance/data/hooks` needs it), and
 * the create path lands its full document on `tx.set` where it can be asserted.
 */
const { txSet } = vi.hoisted(() => ({ txSet: vi.fn() }));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<void>) => {
    await fn({ set: txSet, update: vi.fn(), get: vi.fn() });
  },
  doc: () => ({ id: 'NEW_ID' }),
  collection: () => ({ withConverter: () => 'COLL_REF' }),
}));

vi.mock('@/components/pickers/FilialPicker', () => ({
  filialRefRenderInput:
    () =>
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
  return <MantineTestProvider>{children}</MantineTestProvider>;
}

beforeEach(() => {
  saveRecordMock.mockReset();
  notifyShow.mockReset();
  txSet.mockReset();
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

    // `saveRecordMock` is the barrel export, which ObjectView does not use (see
    // the firestore stub above) — `txSet` is what actually proves nothing was
    // written.
    expect(txSet).not.toHaveBeenCalled();
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

describe('logistica create form — freight-origin telefone', () => {
  const ORIGEM: Endereco = {
    cep: '01310100',
    logradouro: 'Av Paulista',
    numero: '1000',
    bairro: 'Bela Vista',
    complemento: null,
    codigoMunicipio: null,
    cidade: 'São Paulo',
    estado: UF_SIGLA.SP,
    cPais: '1058',
    pais: 'Brasil',
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: '',
    idExterno: null,
    timestamp: null,
  };

  function renderMelhorEnvios(telefone: string) {
    const slice = LOGISTICA_SLICES['melhor-envios'];
    return render(
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
            nome: 'Conta ME',
            filialIntegracaoFreteOuterRef: 'documents/filiais/f1',
            enderecoDeOrigem: { ...ORIGEM, telefone },
          }}
          saveLabel="Criar"
          showSaveAndContinue={false}
        />
      </Wrap>,
    );
  }

  function writtenOrigem(): Record<string, unknown> {
    expect(txSet).toHaveBeenCalledOnce();
    const values = txSet.mock.calls[0]![1] as Record<string, unknown>;
    return values.enderecoDeOrigem as Record<string, unknown>;
  }

  /**
   * The end-to-end shape #870 unblocked: `enderecoDeOrigem.telefone` is a
   * NESTED `fields` override, so before the fix this transform typechecked and
   * did nothing. Asserted on the document that reaches `tx.set`.
   */
  it('normalizes the nested telefone to the 55 wire format on save', async () => {
    renderMelhorEnvios('');

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Endereço de origem' }));
    });
    const telefone = screen.getByRole('textbox', { name: 'Telefone' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(telefone, { target: { value: '11999998888' } });
      fireEvent.blur(telefone);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    });

    const origem = writtenOrigem();
    expect(origem.telefone).toBe('5511999998888');
    // The sibling sub-fields ride along untouched.
    expect(origem.cidade).toBe('São Paulo');
  });

  it('leaves an already-normalized telefone alone (the transform is idempotent)', async () => {
    renderMelhorEnvios('5511999998888');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    });

    expect(writtenOrigem().telefone).toBe('5511999998888');
  });
});
