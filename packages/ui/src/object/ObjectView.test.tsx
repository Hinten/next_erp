import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineTestProvider } from '../testing/mantine';
import { Notifications } from '@mantine/notifications';
import { z } from 'zod';
import { useWatch } from 'react-hook-form';
import type { CollectionHandle } from '@delfrance/data';

// Default to "no existing doc" — individual tests can override.
const docState: {
  current: {
    data: undefined | null | { id: string; data: unknown };
    loading: boolean;
    error: undefined;
    fromCache?: boolean;
  };
} = {
  current: { data: null, loading: false, error: undefined },
};
vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    useDocSnapshot: () => docState.current,
  };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { ObjectView } from './ObjectView';

const schema = z.object({
  nome: z.string().nullable().optional().describe('Nome'),
  tipo: z.enum(['0', '1']).nullable().optional().describe('Tipo'),
  obs: z
    .string()
    .nullable()
    .optional()
    .describe('{"label":"Observações","kind":"longText","section":"Notas"}'),
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
  // `MantineTestProvider` renders overlays (Modal) inline instead of through a
  // portal, so they are queryable here.
  return (
    <MantineTestProvider>
      <Notifications />
      {children}
    </MantineTestProvider>
  );
}

describe('ObjectView', () => {
  it('renders one input per non-excluded field', () => {
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
    expect(screen.getByRole('textbox', { name: 'Nome' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Observações' })).toBeTruthy();
  });

  // The produto editor's heading is a node handed to `title` that calls
  // `useWatch` to follow `nome`/`sku` as they are typed. That only works
  // because `title` is rendered INSIDE the FormProvider — a detail no type
  // signature carries, and one that a refactor lifting the header above the
  // form would break silently (the heading would throw for want of a control,
  // or freeze at its first value).
  it('renders `title` inside the form context, so a title node can track field values', async () => {
    function TitleProbe() {
      const nome = useWatch({ name: 'nome' });
      return <h2>{`Editar ${(nome as string | null) || 'sem nome'}`}</h2>;
    }
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          title={<TitleProbe />}
        />
      </Wrap>,
    );
    expect(screen.getByRole('heading', { name: 'Editar sem nome' })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Nome' }), {
      target: { value: 'Camiseta Azul' },
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Editar Camiseta Azul' })).toBeTruthy(),
    );
  });

  it('hides excluded fields', () => {
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          excludedFields={['obs']}
        />
      </Wrap>,
    );
    expect(screen.queryByRole('textbox', { name: 'Observações' })).toBeNull();
  });

  it('renders nested object fields inside a fieldset', () => {
    const nestedSchema = z.object({
      nome: z.string().describe('Nome'),
      endereco: z
        .object({
          rua: z.string().describe('Rua'),
          cidade: z.string().describe('Cidade'),
        })
        .describe('Endereço'),
    });
    render(
      <Wrap>
        <ObjectView
          schema={nestedSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
        />
      </Wrap>,
    );
    // Leaf inputs of the nested object are bound and labelled.
    expect(screen.getByRole('textbox', { name: 'Rua' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Cidade' })).toBeTruthy();
    // The fieldset legend carries the object field's label.
    expect(screen.getByText('Endereço')).toBeTruthy();
  });

  it('renders Mantine tabs when `sections` is set', () => {
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          sections={['Geral', 'Notas']}
        />
      </Wrap>,
    );
    expect(screen.getByRole('tab', { name: 'Geral' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Notas' })).toBeTruthy();
  });

  it('renders the pager when `pager` is provided', () => {
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          pager={{ ids: ['a', 'b', 'c'], current: 'b', onChange: () => {} }}
        />
      </Wrap>,
    );
    expect(screen.getByText('2 / 3')).toBeTruthy();
  });

  it('delete modal requires typing "excluir" before it calls onDelete', () => {
    docState.current = { data: { id: 'rec-1', data: {} }, loading: false, error: undefined };
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <Wrap>
        <ObjectView
          schema={schema}
          collection={fakeCollection()}
          db={{} as never}
          currentUserUid="u1"
          recordId="rec-1"
          onDelete={onDelete}
        />
      </Wrap>,
    );

    // Open the modal via the row-action delete button.
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));

    // Scope queries to the modal dialog so the row's own "Excluir" button
    // doesn't get matched.
    const dialog = screen.getByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: 'Excluir',
    }) as HTMLButtonElement;
    expect(confirmBtn.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Digite "excluir"/), {
      target: { value: 'excluir' },
    });
    expect(confirmBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(confirmBtn);
    expect(onDelete).toHaveBeenCalledWith('rec-1');

    docState.current = { data: null, loading: false, error: undefined };
  });

  // Persistent-cache convergence: `useDocSnapshot` emits a stale `fromCache:
  // true` doc first (a transactional save has no latency compensation, so the
  // cache lags the server right after editing this record), then the
  // authoritative `fromCache: false` doc. The form must paint the first and
  // then converge to server truth — without clobbering in-progress edits.
  const editSchema = z.object({
    numero: z.string().nullable().optional().describe('Número'),
  });

  function numeroInput(): HTMLInputElement {
    return screen.getByRole('textbox', { name: 'Número' }) as HTMLInputElement;
  }

  /**
   * Which snapshot the form advertises it painted from. `ObjectView` derives it
   * from `fromCache` and hangs it on the `<form>` because the distinction is
   * invisible in the rendered values alone — a field holding the stale cached
   * copy looks exactly like one holding a write that never landed.
   */
  function snapshotSource(): string | null {
    return (
      document.querySelector('form[data-snapshot-source]')?.getAttribute('data-snapshot-source') ??
      null
    );
  }

  it('re-seeds from the server snapshot after a stale cache emission (pristine form)', async () => {
    // First emission: the stale cached doc (pre-save value).
    docState.current = {
      data: { id: 'e1', data: { numero: '100' } },
      loading: false,
      error: undefined,
      fromCache: true,
    };
    const { rerender } = render(
      <Wrap>
        <ObjectView
          schema={editSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          recordId="e1"
        />
      </Wrap>,
    );
    // Cache paint: instant feedback with the (stale) cached value.
    await waitFor(() => expect(numeroInput().value).toBe('100'));
    expect(snapshotSource()).toBe('cache');

    // Second emission: the server confirms the freshly-saved value.
    docState.current = {
      data: { id: 'e1', data: { numero: '250' } },
      loading: false,
      error: undefined,
      fromCache: false,
    };
    rerender(
      <Wrap>
        <ObjectView
          schema={editSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          recordId="e1"
        />
      </Wrap>,
    );
    // Converged to server truth.
    await waitFor(() => expect(numeroInput().value).toBe('250'));
    expect(snapshotSource()).toBe('server');
    // The literal selector `waitForServerSnapshot` waits on in
    // `apps/web/e2e/helpers/object-view.ts`. Spelled out rather than derived, so
    // renaming the attribute or its values fails HERE — in a unit test that runs
    // on every PR — instead of silently in the e2e lanes, which are the only
    // other thing that reads it.
    expect(document.querySelector('form[data-snapshot-source="server"]')).not.toBeNull();

    docState.current = { data: null, loading: false, error: undefined };
  });

  it('never clobbers in-progress edits when the server snapshot arrives', async () => {
    docState.current = {
      data: { id: 'e2', data: { numero: '100' } },
      loading: false,
      error: undefined,
      fromCache: true,
    };
    const { rerender } = render(
      <Wrap>
        <ObjectView
          schema={editSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          recordId="e2"
        />
      </Wrap>,
    );
    await waitFor(() => expect(numeroInput().value).toBe('100'));

    // The user starts editing (form becomes dirty) BEFORE the server snapshot.
    fireEvent.change(numeroInput(), { target: { value: '999' } });
    expect(numeroInput().value).toBe('999');

    // A late `fromCache: false` emission arrives — it must NOT overwrite the
    // user's unsaved edit.
    docState.current = {
      data: { id: 'e2', data: { numero: '250' } },
      loading: false,
      error: undefined,
      fromCache: false,
    };
    rerender(
      <Wrap>
        <ObjectView
          schema={editSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          recordId="e2"
        />
      </Wrap>,
    );
    // Still the user's value — the edit was preserved.
    await waitFor(() => expect(numeroInput().value).toBe('999'));
    // ...and the form still says `server`, because the attribute reports which
    // snapshot ARRIVED, not that the fields agree with it. `useServerTruthSeed`
    // withheld the re-seed on purpose (dirty form), so the two legitimately
    // disagree here. Anything treating `server` as "converged" breaks on this.
    expect(snapshotSource()).toBe('server');

    docState.current = { data: null, loading: false, error: undefined };
  });

  it('reports `pending` while no snapshot has arrived at all', async () => {
    // The third state, and the one that makes a failure diagnosable. `cache`
    // says "a correction is still owed"; `pending` says the listener has not
    // produced anything — an unresolved subscription, a load error, or an id
    // that does not exist. Without it, both look like an empty form.
    docState.current = { data: undefined, loading: true, error: undefined };
    render(
      <Wrap>
        <ObjectView
          schema={editSchema}
          collection={fakeCollection() as never}
          db={{} as never}
          currentUserUid="u1"
          recordId="e3"
        />
      </Wrap>,
    );

    await waitFor(() => expect(snapshotSource()).toBe('pending'));
    // The form element carrying the attribute exists even while the fields are
    // still skeletons — which is what lets a reader wait on it from the outside
    // instead of racing the first paint.
    expect(screen.queryByRole('textbox', { name: 'Número' })).toBeNull();

    docState.current = { data: null, loading: false, error: undefined };
  });
});
