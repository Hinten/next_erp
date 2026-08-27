'use client';

import { useMemo, useState } from 'react';
import { ActionIcon, Box, Center, Group, Image, Loader, Modal, Stack, Text } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight, IconPhotoOff } from '@tabler/icons-react';
import type { Firestore } from 'firebase/firestore';
import type { Foto } from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { idFromRef } from './arquivoRef';

/** Accessible label for the placeholder shown when the photo can't be displayed. */
const UNAVAILABLE_LABEL = 'Foto indisponível';

export interface FotoViewerModalProps {
  db: Firestore;
  /**
   * The foto being viewed, or `null` when the viewer is closed — passing `null`
   * is what releases the arquivo listener, so a closed viewer costs nothing.
   */
  foto: Foto | null;
  /** 0-based position of `foto` within its gallery. */
  pos: number;
  /** Size of the gallery being paged through; `<= 1` hides the arrows. */
  total: number;
  /** Move `delta` photos within the gallery (already clamped by the caller). */
  onNavigate: (delta: -1 | 1) => void;
  onClose: () => void;
}

/**
 * Fullscreen viewer for one gallery of `PhotoManager`.
 *
 * Unlike the gallery card — which shows the **200px derivative** — this resolves
 * the **original** `arquivoOuterRef`, which is the whole point of opening a photo
 * fullscreen. There is deliberately no derivative fallback: a blurry "fullscreen"
 * photo is worse than an explicit placeholder.
 *
 * ⚠️ Mount it from `PhotoManager`'s top level, never inside another `<Modal>` —
 * `keepMounted` defaults to `false`, so a parent closing unmounts this one
 * mid-interaction (see `despacho/checkout/_components/useConfirm.tsx`, #1096).
 */
export function FotoViewerModal({
  db,
  foto,
  pos,
  total,
  onNavigate,
  onClose,
}: FotoViewerModalProps) {
  // Track failed loads BY url, not a single boolean: paging to another photo
  // must not inherit the previous one's broken state.
  const [erroredUrls, setErroredUrls] = useState<ReadonlySet<string>>(() => new Set());
  const markErrored = (u: string) => setErroredUrls((prev) => new Set(prev).add(u));

  const originalRef = useMemo(() => {
    const id = idFromRef(foto?.arquivoOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, foto?.arquivoOuterRef]);
  const original = useDocSnapshot(originalRef);
  const url = original.data?.data?.url ?? null;

  const hasPrev = pos > 0;
  const hasNext = pos < total - 1;

  // The hook stays mounted while the viewer is closed (so Mantine keeps its
  // open/close transition), hence the `foto` guard — arrow keys must not steal
  // events from the surrounding form.
  useHotkeys([
    ['ArrowLeft', () => foto !== null && hasPrev && onNavigate(-1)],
    ['ArrowRight', () => foto !== null && hasNext && onNavigate(1)],
  ]);

  let content: React.ReactNode;
  if (url !== null && !erroredUrls.has(url)) {
    content = (
      <Image
        src={url}
        alt={`Foto ${pos + 1}`}
        fit="contain"
        mah="calc(100vh - 160px)"
        onError={() => markErrored(url)}
      />
    );
  } else if (original.loading) {
    content = (
      <Center h={240}>
        <Loader />
      </Center>
    );
  } else {
    content = (
      <Center h={240} role="img" aria-label={UNAVAILABLE_LABEL}>
        <Stack align="center" gap="xs">
          <IconPhotoOff size={64} color="var(--mantine-color-gray-5)" aria-hidden />
          <Text size="sm" c="dimmed">
            {UNAVAILABLE_LABEL}
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Modal
      opened={foto !== null}
      onClose={onClose}
      fullScreen
      title={total > 0 ? `Foto ${pos + 1} de ${total}` : ''}
    >
      {/*
        ⚠️ The test id lives HERE, not on `Modal`. Mantine forwards unknown props
        to Modal.Root, a zero-box wrapper around the overlay and the content —
        `getByTestId(...)` resolves it but `toBeVisible()` never passes.
      */}
      <Stack data-testid="foto-viewer">
        <Group justify="center" align="center" wrap="nowrap" gap="md">
          {total > 1 && (
            <ActionIcon
              variant="default"
              size="lg"
              radius="xl"
              onClick={() => onNavigate(-1)}
              disabled={!hasPrev}
              aria-label="Foto anterior"
            >
              <IconChevronLeft size={20} />
            </ActionIcon>
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>{content}</Box>
          {total > 1 && (
            <ActionIcon
              variant="default"
              size="lg"
              radius="xl"
              onClick={() => onNavigate(1)}
              disabled={!hasNext}
              aria-label="Próxima foto"
            >
              <IconChevronRight size={20} />
            </ActionIcon>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
