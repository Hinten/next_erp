import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import { videoSchema } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

const { docRef } = vi.hoisted(() => ({
  docRef: vi.fn((_db: unknown, _ctx: unknown, id: string) => ({ id })),
}));

vi.mock('@delfrance/storage', () => ({
  arquivoCollection: { docRef },
  StorageUploadError: class StorageUploadError extends Error {},
  uploadProductAnexo: vi.fn(),
  uploadProductVideo: vi.fn(),
}));

vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: (ref: { id: string } | null) => ({
    data:
      ref?.id === 'media'
        ? {
            data: {
              url: 'https://cdn.example/media',
              originalFilename: 'manual.pdf',
              contentType: 'application/pdf',
              uploadState: 'finalized',
            },
          }
        : null,
    loading: false,
    error: undefined,
  }),
}));

import { AnexoManager } from './AnexoManager';
import { VideoManager } from './VideoManager';

const db = {} as Firestore;
const storage = {} as FirebaseStorage;

afterEach(() => vi.clearAllMocks());

describe('product media document refs', () => {
  it.each(['arquivos/media', 'documents/arquivos/media'])(
    'resolves attachment %s to the bare arquivo id and a download link',
    (arquivoOuterRef) => {
      render(
        <MantineTestProvider>
          <AnexoManager
            produtoId="produto"
            db={db}
            storage={storage}
            value={[{ arquivoOuterRef }]}
            onChange={() => {}}
            disabled
          />
        </MantineTestProvider>,
      );
      expect(docRef).toHaveBeenCalledWith(db, {}, 'media');
      expect(screen.getByRole('link', { name: 'Baixar anexo' }).getAttribute('href')).toBe(
        'https://cdn.example/media',
      );
      expect(screen.getByText('manual.pdf')).toBeTruthy();
    },
  );

  it.each(['arquivos/media', 'documents/arquivos/media'])(
    'resolves video %s to the bare arquivo id and playable media',
    (arquivoOuterRef) => {
      render(
        <MantineTestProvider>
          <VideoManager
            produtoId="produto"
            db={db}
            storage={storage}
            value={[
              { ...videoSchema.parse({ arquivoOuterRef: 'arquivos/media' }), arquivoOuterRef },
            ]}
            onChange={() => {}}
            disabled
          />
        </MantineTestProvider>,
      );
      expect(docRef).toHaveBeenCalledWith(db, {}, 'media');
      expect(screen.getByLabelText('Vídeo do produto').getAttribute('src')).toBe(
        'https://cdn.example/media',
      );
    },
  );
});
