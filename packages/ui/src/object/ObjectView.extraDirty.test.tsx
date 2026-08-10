import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';

const { docState, guardSpy } = vi.hoisted(() => ({
  docState: {
    current: { data: null, loading: false, error: undefined } as {
      data: undefined | null | { id: string; data: unknown };
      loading: boolean;
      error: Error | undefined;
    },
  },
  guardSpy: vi.fn(),
}));

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useDocSnapshot: () => docState.current };
});

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

// The guard's real behaviour (beforeunload + a document-level click listener)
// is covered by useUnsavedChangesGuard.test.tsx; here we only care that
// ObjectView ARMS it with the right value.
vi.mock('./useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: (dirty: boolean) => guardSpy(dirty),
}));

import { ObjectView } from './ObjectView';

const schema = z.object({ nome: z.string().nullable().optional().describe('Nome') });

function fakeCollection(): CollectionHandle<typeof schema> {
  return {
    resolvePath: () => 'clientes',
    ref: () => ({}) as never,
    docRef: () => ({}) as never,
    converter: {} as never,
    merge: () => Promise.resolve(),
  };
}

function renderWith(extraDirty?: boolean) {
  render(
    <MantineProvider>
      <ObjectView
        schema={schema}
        collection={fakeCollection()}
        db={{} as never}
        currentUserUid="u1"
        recordId="EXISTING"
        {...(extraDirty === undefined ? {} : { extraDirty })}
      />
    </MantineProvider>,
  );
}

beforeEach(() => {
  guardSpy.mockReset();
  docState.current = {
    data: { id: 'EXISTING', data: { nome: 'Alice' } },
    loading: false,
    error: undefined,
  };
});

describe('ObjectView extraDirty', () => {
  it('leaves the guard disarmed when the form is pristine and nothing else is dirty', () => {
    renderWith();
    expect(guardSpy).toHaveBeenCalledWith(false);
    expect(guardSpy).not.toHaveBeenCalledWith(true);
  });

  it('arms the guard for a self-contained tab holding unsaved edits', () => {
    // The Mercado Livre tab owns its own document, so `form.formState.isDirty`
    // cannot see its pending edits — without this the page reports itself clean
    // and the operator loses them on navigation.
    renderWith(true);
    expect(guardSpy).toHaveBeenCalledWith(true);
  });

  it('treats an explicit false as not dirty', () => {
    renderWith(false);
    expect(guardSpy).not.toHaveBeenCalledWith(true);
  });
});
