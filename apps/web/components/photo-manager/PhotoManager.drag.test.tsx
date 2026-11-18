import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import {
  fotoSchema,
  grupoDeVariacoesSchema,
  grupoOuterRef,
  varianteFakePath,
} from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { PhotoManager } from './PhotoManager';

vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: null, loading: false, error: undefined }),
}));

vi.mock('@delfrance/storage', () => ({
  arquivoCollection: { docRef: vi.fn() },
  StorageUploadError: class StorageUploadError extends Error {},
}));

const colorGroupId = 'cores';
const colors = [
  { id: 'az', nome: 'Azul' },
  { id: 'vd', nome: 'Verde' },
  { id: 'vm', nome: 'Vermelho' },
];
const bluePath = varianteFakePath(colorGroupId, 'az');
const greenPath = varianteFakePath(colorGroupId, 'vd');
const redPath = varianteFakePath(colorGroupId, 'vm');
const grupos = [
  {
    id: colorGroupId,
    data: grupoDeVariacoesSchema.parse({ nome: 'Cores', permiteFotos: true, variacoes: colors }),
  },
];
const parentPhoto = fotoSchema.parse({ arquivoOuterRef: 'arquivos/parent' });
const bluePhoto = fotoSchema.parse({
  arquivoOuterRef: 'arquivos/shared',
  grupoDeVariacoesOuterRef: grupoOuterRef(colorGroupId),
  variantePath: bluePath,
});
const redPhoto = { ...bluePhoto, variantePath: redPath };
const db = {} as Firestore;
const onChange = vi.fn();

function GalleryForm() {
  const form = useForm({ defaultValues: { variacoesUid: [bluePath, greenPath, redPath] } });
  return (
    <FormProvider {...form}>
      <PhotoManager
        db={db}
        uploadFoto={async () => parentPhoto}
        grupos={grupos}
        value={[parentPhoto, bluePhoto, redPhoto]}
        onChange={onChange}
      />
    </FormProvider>
  );
}

function renderGalleries() {
  render(<GalleryForm />, { wrapper: MantineTestProvider });
  const parent = screen.getByRole('group', { name: 'Galeria principal' });
  const blue = screen.getByRole('group', { name: 'Cores: Azul' });
  const green = screen.getByRole('group', { name: 'Cores: Verde' });
  const red = screen.getByRole('group', { name: 'Cores: Vermelho' });

  // Supply geometry in jsdom so the real PointerSensor and collision detection run.
  for (const [index, gallery] of [parent, blue, green, red].entries()) {
    const top = 20 + index * 180;
    vi.spyOn(gallery, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, top, 300, 130));
    if (gallery !== green) {
      const grip = within(gallery).getByRole('button', { name: 'Reordenar' });
      const card = grip.closest('.mantine-Paper-root')!;
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(30, top + 10, 100, 100));
    }
  }
  return { parent, blue, green, red };
}

function movePointer(clientX: number, clientY: number) {
  fireEvent.pointerMove(document, { clientX, clientY, isPrimary: true });
}

function startDrag(blue: HTMLElement) {
  fireEvent.pointerDown(within(blue).getByRole('button', { name: 'Reordenar' }), {
    button: 0,
    clientX: 115,
    clientY: 220,
    isPrimary: true,
  });
  movePointer(100, 220);
}

function dropState(gallery: HTMLElement): string | null {
  return gallery.getAttribute('data-photo-drop-state');
}

afterEach(() => {
  onChange.mockClear();
  vi.restoreAllMocks();
});

describe('PhotoManager transfer highlights', () => {
  it('highlights valid galleries and follows the pointer over empty grids and thumbnails', () => {
    const { parent, blue, green, red } = renderGalleries();
    expect([parent, blue, green, red].map(dropState)).toEqual([null, null, null, null]);

    startDrag(blue);
    expect([parent, blue, green, red].map(dropState)).toEqual([
      'available',
      null,
      'available',
      null,
    ]);

    movePointer(55, 415);
    expect(dropState(green)).toBe('target');

    movePointer(55, 55);
    expect(dropState(parent)).toBe('target');
    expect(dropState(green)).toBe('available');

    movePointer(55, 595);
    expect(dropState(red)).toBeNull();
    expect(dropState(parent)).toBe('available');
    expect(onChange).not.toHaveBeenCalled();

    movePointer(55, 415);
    fireEvent.pointerUp(document);

    expect([parent, blue, green, red].map(dropState)).toEqual([null, null, null, null]);
    expect(onChange).toHaveBeenCalledExactlyOnceWith([
      parentPhoto,
      { ...bluePhoto, variantePath: greenPath },
      redPhoto,
    ]);
  });

  it('clears every highlight and leaves the photos in place on Escape', () => {
    const { parent, blue, green, red } = renderGalleries();
    startDrag(blue);
    movePointer(55, 55);
    expect(dropState(parent)).toBe('target');

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

    expect([parent, blue, green, red].map(dropState)).toEqual([null, null, null, null]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
