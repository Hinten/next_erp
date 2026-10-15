/**
 * #660 — `ObjectView` publishes its tab layout so a custom `renderInput` widget
 * can move the operator to the tab holding a field it just wrote.
 *
 * The tab state is private to `ObjectView` (an invalid submit jumps to the
 * first erroring tab), and so is the `field key → section` map that routes
 * those errors. Both are now readable through a context mounted beside the
 * `FormProvider`, because writing a sibling field and showing where it landed
 * are two halves of one gesture: a `setValue` into a hidden panel reads as
 * "nothing happened".
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MantineTestProvider } from '../testing/mantine';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    // A loaded record: `ObjectView` renders "não encontrado" instead of the
    // form when an edit-mode snapshot comes back empty.
    useDocSnapshot: () => ({
      data: { id: 'EXISTING', data: { nome: 'Alice', observacao: 'nota', atalho: null } },
      loading: false,
      error: undefined,
      fromCache: false,
    }),
  };
});

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

import { ObjectView } from './ObjectView';
import { useObjectViewSections } from './ObjectViewSectionsContext';

const schema = z.object({
  nome: z.string().nullable().optional().describe('Nome'),
  observacao: z.string().nullable().optional().describe('Observação'),
  atalho: z.string().nullable().optional().describe('Atalho'),
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

/** Stands in for a self-contained tab that jumps the operator elsewhere. */
function NavProbe() {
  const sections = useObjectViewSections();
  return (
    <div>
      <span data-testid="active">{sections?.activeSection ?? 'sem contexto'}</span>
      <span data-testid="secao-de-nome">{sections?.sectionOfField('nome') ?? 'nenhuma'}</span>
      <span data-testid="secao-desconhecida">
        {sections?.sectionOfField('inexistente') ?? 'nenhuma'}
      </span>
      <button type="button" onClick={() => sections?.goToSection('Dados')}>
        Ir para Dados
      </button>
      <button type="button" onClick={() => sections?.goToSection('Inexistente')}>
        Ir para lugar nenhum
      </button>
    </div>
  );
}

function renderView() {
  return render(
    <MantineTestProvider>
      <ObjectView
        schema={schema}
        collection={fakeCollection()}
        db={{} as never}
        currentUserUid="u1"
        recordId="EXISTING"
        sections={['Dados', 'Extras']}
        fields={{
          nome: { section: 'Dados' },
          observacao: { section: 'Extras' },
          atalho: { section: 'Extras', renderInput: () => <NavProbe /> },
        }}
      />
    </MantineTestProvider>,
  );
}

describe('ObjectView section navigation context', () => {
  it('reports the active tab and the tab a field is rendered in', () => {
    renderView();
    expect(screen.getByTestId('active').textContent).toBe('Dados');
    expect(screen.getByTestId('secao-de-nome').textContent).toBe('Dados');
  });

  it('answers "no tab" for a key with no rendered input', () => {
    renderView();
    expect(screen.getByTestId('secao-desconhecida').textContent).toBe('nenhuma');
  });

  it('switches the rendered tab from inside a widget', async () => {
    renderView();
    // Start on Extras (where the probe lives), then jump to Dados.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Extras' }));
    });
    expect(screen.getByTestId('active').textContent).toBe('Extras');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ir para Dados' }));
    });
    expect(screen.getByTestId('active').textContent).toBe('Dados');
  });

  it('ignores a section this view does not render', async () => {
    renderView();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Extras' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ir para lugar nenhum' }));
    });
    // Still Extras — an unknown name must not strand the tab on a value the
    // view would silently discard.
    expect(screen.getByTestId('active').textContent).toBe('Extras');
  });

  it('is null outside an ObjectView, so a widget can render standalone', () => {
    render(
      <MantineTestProvider>
        <NavProbe />
      </MantineTestProvider>,
    );
    expect(screen.getByTestId('active').textContent).toBe('sem contexto');
    expect(screen.getByTestId('secao-de-nome').textContent).toBe('nenhuma');
  });
});
