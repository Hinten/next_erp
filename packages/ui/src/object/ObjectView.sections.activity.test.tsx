import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';

/**
 * ⚠️ These tests deliberately render WITHOUT `env="test"`, for the same reason
 * `SectionTabs.persistence.test.tsx` does: under `MantineProvider env="test"`
 * Mantine — and therefore `SectionTabs` — skips `<Activity>` entirely, and
 * `<Activity>` is the whole subject here.
 *
 * ## What this pins (#660)
 *
 * `<Activity mode="hidden">` renders an inactive panel's subtree but unmounts
 * every effect in it, including the subscription each RHF `Controller`
 * registers. So a widget that writes a SIBLING field in a hidden tab hits a
 * silent trap: `setValue` updates the form's values, the input never hears
 * about it, and it does NOT re-sync when its effects mount again — it
 * re-renders from the state it held before the panel was hidden. The operator
 * lands on the right tab still reading the OLD value, with the new one live in
 * the form but invisible.
 *
 * That shipped: the Modificações tab's "Restaurar" staged a value and then
 * jumped, and the emulator e2e caught an input still showing the pre-revert
 * name. `goToSection` commits synchronously so the correct order —
 * jump, THEN write — actually works; the second test is the one that would
 * have caught it.
 */

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    useDocSnapshot: () => ({
      data: { id: 'EXISTING', data: { nome: 'editado', atalho: null } },
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

/** A self-contained tab that stages a value into the field on the OTHER tab. */
function Stager() {
  const form = useFormContext();
  const sections = useObjectViewSections();

  function stage(jumpFirst: boolean) {
    const section = sections?.sectionOfField('nome');
    if (jumpFirst && section) sections?.goToSection(section);
    form?.setValue('nome', 'restaurado', { shouldDirty: true });
    if (!jumpFirst && section) sections?.goToSection(section);
  }

  return (
    <>
      <button type="button" onClick={() => stage(false)}>
        Escrever e depois pular
      </button>
      <button type="button" onClick={() => stage(true)}>
        Pular e depois escrever
      </button>
    </>
  );
}

function renderView() {
  return render(
    <MantineProvider>
      <ObjectView
        schema={schema}
        collection={fakeCollection()}
        db={{} as never}
        currentUserUid="u1"
        recordId="EXISTING"
        sections={['Dados', 'Ferramentas']}
        // The Ferramentas tab is first-rendered inactive; start there so the
        // field being written is the one sitting in a hidden panel.
        fields={{
          nome: { section: 'Dados' },
          atalho: { section: 'Ferramentas', renderInput: () => <Stager /> },
        }}
      />
    </MantineProvider>,
  );
}

function nomeInput(): HTMLInputElement {
  return screen.getByLabelText('Nome') as HTMLInputElement;
}

describe('staging a value into another tab', () => {
  it('a write into a HIDDEN panel never reaches its input, even after switching', async () => {
    renderView();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Ferramentas' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Escrever e depois pular' }));
    });

    // The value IS in the form — a save would write it — but the operator is
    // now looking at the Dados tab and still sees the pre-revert value. This
    // assertion documents the trap; it is not the behaviour we want.
    expect(nomeInput().value).toBe('editado');
  });

  it('switching FIRST puts the value on screen, because goToSection commits', async () => {
    renderView();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Ferramentas' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pular e depois escrever' }));
    });

    expect(nomeInput().value).toBe('restaurado');
  });
});
