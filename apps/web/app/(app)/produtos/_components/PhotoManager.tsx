'use client';

import '@mantine/dropzone/styles.css';

import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Group,
  Image,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE, type FileWithPath } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import {
  IconGripVertical,
  IconPhotoPlus,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '@tabler/icons-react';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import { arquivoCollection, StorageUploadError, uploadProductImage } from '@delfrance/storage';
import { buildFotoRefs, type Foto } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';

const ARQUIVOS_PREFIX = 'arquivos/';

/** `arquivos/<id>` → `<id>` (or `null` for an absent ref). */
function idFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const id = ref.startsWith(ARQUIVOS_PREFIX) ? ref.slice(ARQUIVOS_PREFIX.length) : ref;
  return id || null;
}

export interface PhotoManagerProps {
  /**
   * Owning product id — uploads are scoped to `produtos/<produtoId>/…`. `null`
   * in create mode (the product isn't saved yet): the manager then renders a
   * "save first" message instead of a dead dropzone.
   */
  produtoId: string | null;
  db: Firestore;
  storage: FirebaseStorage;
  /** Current `Produto.fotos` value from the form. */
  value: Foto[] | null;
  /** Push a new `fotos` array back into the form (RHF tracks it as dirty). */
  onChange: (next: Foto[]) => void;
  disabled?: boolean;
}

/**
 * Product photo gallery wired into the Produto ObjectView's "Fotos" tab.
 *
 * Uploads go straight to Storage via `uploadProductImage` (which writes the
 * original `Arquivo` doc and triggers the resize Cloud Function); the matching
 * `Foto` ref strings are appended to the form's `fotos` array and persisted on
 * the product save. Order is the array position (first = capa) — reorder with
 * drag-and-drop. Each thumbnail prefers the 200px derivative and falls back to
 * the original while the resize function is still running (or not yet deployed).
 */
export function PhotoManager({
  produtoId,
  db,
  storage,
  value,
  onChange,
  disabled,
}: PhotoManagerProps) {
  const fotos = useMemo(() => value ?? [], [value]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // No product id yet (create mode): uploads can't be scoped to a product, so
  // prompt the user to save first instead of showing a dropzone that can't work.
  if (!produtoId) {
    return (
      <Alert color="blue" variant="light">
        Salve o produto para poder enviar fotos.
      </Alert>
    );
  }

  // produtoId is non-null past the guard; capture it as a string so the upload
  // closure below keeps the narrowing (TS doesn't carry it into nested fns).
  const ownerId: string = produtoId;

  async function handleDrop(files: FileWithPath[]) {
    setError(null);
    setUploading(true);
    try {
      const seen = new Set(fotos.map((f) => f.arquivoOuterRef));
      const added: Foto[] = [];
      for (const file of files) {
        const { id } = await uploadProductImage({
          storage,
          db,
          produtoId: ownerId,
          bytes: file,
          contentType: file.type,
          originalFilename: file.name,
        });
        // `id` is `<produtoId>_<hash>`; recover the hash to build the refs.
        const hash = id.startsWith(`${ownerId}_`) ? id.slice(ownerId.length + 1) : id;
        const refs = buildFotoRefs(ownerId, hash);
        if (seen.has(refs.arquivoOuterRef)) continue; // dedup identical uploads
        seen.add(refs.arquivoOuterRef);
        added.push({ ...refs, grupoDeVariacoesOuterRef: null, variantePath: null });
      }
      if (added.length > 0) {
        onChange([...fotos, ...added]);
        notifications.show({ color: 'green', message: `${added.length} foto(s) enviada(s).` });
      } else {
        notifications.show({ color: 'gray', message: 'Foto(s) já adicionada(s).' });
      }
    } catch (err) {
      // Always log so a failed upload is traceable — the dropzone otherwise just
      // drops its spinner with no trace. Surface a message for the known cases.
      console.error('[PhotoManager] upload failed', err);
      if (err instanceof FirebaseError) {
        setError(`Falha ao enviar a foto (${err.code}). ${err.message}`);
      } else if (err instanceof StorageUploadError) {
        setError(err.message);
      } else {
        setError('Falha inesperada ao enviar a foto. Veja o console para detalhes.');
        throw err;
      }
    } finally {
      setUploading(false);
    }
  }

  function makeCover(index: number) {
    if (index > 0) onChange(arrayMove(fotos, index, 0));
  }

  function remove(index: number) {
    onChange(fotos.filter((_, i) => i !== index));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = fotos.findIndex((f) => f.arquivoOuterRef === active.id);
    const to = fotos.findIndex((f) => f.arquivoOuterRef === over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(fotos, from, to));
  }

  return (
    <Stack>
      {!disabled && (
        <Dropzone onDrop={handleDrop} accept={IMAGE_MIME_TYPE} loading={uploading} multiple>
          <Group justify="center" gap="sm" mih={100} style={{ pointerEvents: 'none' }}>
            <IconPhotoPlus size={32} />
            <div>
              <Text size="sm">Arraste imagens aqui ou clique para selecionar</Text>
              <Text size="xs" c="dimmed">
                JPG, PNG, GIF ou WEBP
              </Text>
            </div>
          </Group>
        </Dropzone>
      )}

      {error && <Alert color="red">{error}</Alert>}

      {fotos.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nenhuma foto.
        </Text>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={fotos.map((f) => f.arquivoOuterRef)}
            strategy={rectSortingStrategy}
          >
            <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }}>
              {fotos.map((foto, index) => (
                <SortableFoto
                  key={foto.arquivoOuterRef}
                  foto={foto}
                  db={db}
                  isCover={index === 0}
                  disabled={disabled}
                  onCover={() => makeCover(index)}
                  onRemove={() => remove(index)}
                />
              ))}
            </SimpleGrid>
          </SortableContext>
        </DndContext>
      )}
    </Stack>
  );
}

interface SortableFotoProps {
  foto: Foto;
  db: Firestore;
  isCover: boolean;
  disabled?: boolean;
  onCover: () => void;
  onRemove: () => void;
}

function SortableFoto({ foto, db, isCover, disabled, onCover, onRemove }: SortableFotoProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: foto.arquivoOuterRef,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Prefer the 200px derivative; fall back to the original while the resize
  // Cloud Function is still generating it (or not yet deployed).
  const derivRef = useMemo(() => {
    const id = idFromRef(foto.arquivo200pxOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, foto.arquivo200pxOuterRef]);
  const originalRef = useMemo(() => {
    const id = idFromRef(foto.arquivoOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, foto.arquivoOuterRef]);
  const deriv = useDocSnapshot(derivRef);
  const original = useDocSnapshot(originalRef);
  // Prefer the 200px derivative when it exists; otherwise show the original.
  // The live snapshot upgrades the thumbnail automatically if/when the resize
  // function later produces the derivative — no "processing" badge needed.
  const url = deriv.data?.data?.url ?? original.data?.data?.url ?? null;

  return (
    <Paper ref={setNodeRef} style={style} withBorder p={4} pos="relative">
      <Box pos="relative">
        {url ? (
          <Image src={url} alt="" h={140} fit="cover" radius="sm" />
        ) : (
          <Group justify="center" h={140}>
            <Loader size="sm" />
          </Group>
        )}
        {isCover && (
          <Badge color="blue" size="xs" pos="absolute" top={4} left={4}>
            Capa
          </Badge>
        )}
        {!disabled && (
          <ActionIcon
            variant="default"
            size="sm"
            pos="absolute"
            top={4}
            right={4}
            style={{ cursor: 'grab' }}
            aria-label="Reordenar"
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={14} />
          </ActionIcon>
        )}
      </Box>
      {!disabled && (
        <Group justify="space-between" mt={4} gap={4}>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={onCover}
            disabled={isCover}
            aria-label="Definir como capa"
          >
            {isCover ? <IconStarFilled size={14} /> : <IconStar size={14} />}
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            onClick={onRemove}
            aria-label="Remover foto"
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      )}
    </Paper>
  );
}
