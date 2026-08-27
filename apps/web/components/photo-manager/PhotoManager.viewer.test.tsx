import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { Firestore } from 'firebase/firestore';
import { type GrupoComId, varianteFakePath } from '@delfrance/schemas';
import type { Foto } from '@delfrance/schemas';
import type { SnapshotState } from '@delfrance/data/hooks';

type Snap = SnapshotState<{ id: string; data: { url: string | null } } | null>;

// Every `useDocSnapshot` call is keyed by doc id — the mocked
// `arquivoCollection.docRef` returns `{ id }` — which is stable across re-renders,
// unlike call order (the number of calls changes as cards mount and the viewer
// opens). A `null` ref (a released listener) yields the empty default.
const { snapById } = vi.hoisted(() => ({
  snapById: { current: {} as Record<string, Snap> },
}));

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    useDocSnapshot: (ref: { id: string } | null) => {
      const empty: Snap = { data: undefined, loading: false, error: undefined };
      if (!ref) return empty;
      return snapById.current[ref.id] ?? empty;
    },
  };
});

vi.mock('@delfrance/storage', () => ({
  arquivoCollection: {
    docRef: (_db: unknown, _scope: unknown, id: string) => ({ id }),
  },
  // PhotoManager narrows its upload catch on this class, so the mock must carry it.
  StorageUploadError: class StorageUploadError extends Error {},
}));

import { PhotoManager } from './PhotoManager';

function loaded(url: string | null): Snap {
  return { data: { id: 'x', data: { url } }, loading: false, error: undefined };
}
const MISSING: Snap = { data: null, loading: false, error: undefined };

const db = {} as Firestore;

function foto(tag: string): Foto {
  return {
    arquivoOuterRef: `arquivos/orig${tag}`,
    arquivo200pxOuterRef: `arquivos/deriv${tag}`,
    arquivo400pxOuterRef: null,
    arquivoJpegOuterRef: null,
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  };
}

/**
 * ⚠️ The derivative and the original resolve to DIFFERENT urls on purpose. If
 * they matched, "the viewer shows the original" would pass for a viewer that
 * merely re-renders the 200px thumbnail — a vacuous assertion.
 */
function seedSnaps(tags: string[]) {
  snapById.current = Object.fromEntries(
    tags.flatMap((t) => [
      [`deriv${t}`, loaded(`https://cdn/deriv${t}-200.jpg`)],
      [`orig${t}`, loaded(`https://cdn/orig${t}-full.jpg`)],
    ]),
  );
}

function renderManager(fotos: Foto[], opts: { disabled?: boolean } = {}) {
  return render(
    <MantineTestProvider>
      <PhotoManager
        db={db}
        uploadFoto={async () => foto('Z')}
        value={fotos}
        onChange={() => {}}
        disabled={opts.disabled}
      />
    </MantineTestProvider>,
  );
}

/** The `<img>` currently shown by the fullscreen viewer. */
function viewerImage(): HTMLImageElement {
  const dialog = screen.getByRole('dialog');
  return within(dialog).getByRole('img') as HTMLImageElement;
}

/** Dispatch a cancelable keydown the way a browser would, to read back `defaultPrevented`. */
function pressKey(key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(ev);
  return ev;
}

/** "Cores" allows photos and has Azul selected; "Tamanhos" does not. */
function grupos(): GrupoComId[] {
  return [
    {
      id: 'CORES',
      data: {
        nome: 'Cores',
        ordem: 1,
        permiteFotos: true,
        variacoesIds: ['az'],
        variacoes: [{ id: 'az', nome: 'Azul', codigo: 'AZ' }],
      },
    },
  ] as unknown as GrupoComId[];
}

/**
 * PhotoManager reads `variacoesUid` off the ObjectView FormProvider, so the
 * variant galleries only exist inside one.
 */
function WithVariantGallery({ fotos, uids }: { fotos: Foto[]; uids: string[] }) {
  const form = useForm({ defaultValues: { variacoesUid: uids } });
  return (
    <FormProvider {...form}>
      <PhotoManager
        db={db}
        uploadFoto={async () => foto('Z')}
        grupos={grupos()}
        value={fotos}
        onChange={() => {}}
      />
    </FormProvider>
  );
}

afterEach(() => {
  snapById.current = {};
  vi.clearAllMocks();
});

describe('PhotoManager fullscreen viewer', () => {
  it('opens the ORIGINAL photo, not the 200px thumbnail the card shows', () => {
    seedSnaps(['A', 'B', 'C']);
    renderManager([foto('A'), foto('B'), foto('C')]);

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));

    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origA-full.jpg');
    expect(screen.getByText('Foto 1 de 3')).toBeTruthy();
  });

  it('does not submit the surrounding form when a photo is opened', () => {
    // The gallery lives inside ObjectView's <form>: a submit-typed zoom control
    // would SAVE the record on every click.
    seedSnaps(['A']);
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <MantineTestProvider>
        <form onSubmit={onSubmit}>
          <PhotoManager
            db={db}
            uploadFoto={async () => foto('Z')}
            value={[foto('A')]}
            onChange={() => {}}
          />
        </form>
      </MantineTestProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('pages through the gallery and disables the arrows at both ends', () => {
    seedSnaps(['A', 'B', 'C']);
    renderManager([foto('A'), foto('B'), foto('C')]);
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));

    const prev = () => screen.getByRole('button', { name: 'Foto anterior' });
    const next = () => screen.getByRole('button', { name: 'Próxima foto' });

    expect(prev().hasAttribute('disabled')).toBe(true);
    fireEvent.click(next());
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origB-full.jpg');
    expect(prev().hasAttribute('disabled')).toBe(false);

    fireEvent.click(next());
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origC-full.jpg');
    expect(screen.getByText('Foto 3 de 3')).toBeTruthy();
    expect(next().hasAttribute('disabled')).toBe(true);

    fireEvent.click(prev());
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origB-full.jpg');
  });

  it('pages with the arrow keys, clamped at the last photo', () => {
    seedSnaps(['A', 'B']);
    renderManager([foto('A'), foto('B')]);
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));

    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origB-full.jpg');

    // Already at the end — the clamp keeps the hotkey from running off the array.
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origB-full.jpg');

    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origA-full.jpg');
  });

  it('hides the arrows in a one-photo gallery', () => {
    seedSnaps(['A']);
    renderManager([foto('A')]);
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));

    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origA-full.jpg');
    expect(screen.queryByRole('button', { name: 'Foto anterior' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Próxima foto' })).toBeNull();
  });

  it('still opens in read-only mode, where the editing actions are gone', () => {
    seedSnaps(['A']);
    renderManager([foto('A')], { disabled: true });

    // The zoom affordance sits OUTSIDE the `!disabled` guards; the editors do not.
    expect(screen.queryByRole('button', { name: 'Remover foto' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Definir como capa' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origA-full.jpg');
  });

  it('shows a placeholder when the original arquivo doc is missing', () => {
    snapById.current = {
      derivA: loaded('https://cdn/derivA-200.jpg'),
      origA: MISSING,
    };
    renderManager([foto('A')]);
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Foto indisponível')).toBeTruthy();
  });

  it('closes the viewer', () => {
    seedSnaps(['A']);
    renderManager([foto('A')]);
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves the arrow keys alone while the viewer is CLOSED', () => {
    // `useHotkeys` calls preventDefault BEFORE the handler, so a handler-only
    // guard would swallow every arrow key on the page for as long as the Fotos
    // tab is mounted. The open case below is the control: the guard must not
    // be so wide that it never prevents anything either.
    seedSnaps(['A', 'B']);
    renderManager([foto('A'), foto('B')]);

    expect(pressKey('ArrowRight').defaultPrevented).toBe(false);
    expect(pressKey('ArrowLeft').defaultPrevented).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));
    expect(pressKey('ArrowRight').defaultPrevented).toBe(true);
  });

  it('retries a photo that failed to load once the viewer is reopened', () => {
    // The component never unmounts, so an un-pruned errored-url set would pin a
    // transient failure to "indisponível" for the life of the produto screen.
    seedSnaps(['A']);
    renderManager([foto('A')]);
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));

    fireEvent.error(viewerImage());
    expect(within(screen.getByRole('dialog')).getByLabelText('Foto indisponível')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1' }));
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origA-full.jpg');
  });

  it('scopes the zoom label to its gallery so variant sections do not collide', () => {
    const az = varianteFakePath('CORES', 'az');
    const tagged: Foto = { ...foto('B'), variantePath: az, grupoDeVariacoesOuterRef: null };
    seedSnaps(['A', 'B']);
    render(
      <MantineTestProvider>
        <WithVariantGallery fotos={[foto('A'), tagged]} uids={[az]} />
      </MantineTestProvider>,
    );

    // Both galleries hold their own photo #1; the labels must still differ.
    expect(screen.getByRole('button', { name: 'Ampliar foto 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ampliar foto 1 (Cores: Azul)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto 1 (Cores: Azul)' }));
    expect(viewerImage().getAttribute('src')).toBe('https://cdn/origB-full.jpg');
    expect(screen.getByText('Foto 1 de 1')).toBeTruthy();
  });
});
