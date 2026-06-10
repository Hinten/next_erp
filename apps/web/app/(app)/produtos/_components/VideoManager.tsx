'use client';

import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { Dropzone, type FileWithPath } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconGripVertical, IconTrash, IconVideoPlus } from '@tabler/icons-react';
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
import { arquivoCollection, StorageUploadError, uploadProductVideo } from '@delfrance/storage';
import { ARQUIVOS_COLLECTION, type Video, type VideoFormato } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { DELETE_MARK } from '@delfrance/ui';

const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/mpeg', 'video/x-msvideo'];
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
const ARQUIVOS_PREFIX = `${ARQUIVOS_COLLECTION}/`;

/** A `Video` plus the transient staged-deletion marker (keyed by `DELETE_MARK`). */
type EditableVideo = Video & { [DELETE_MARK]?: boolean };

/** `arquivos/<id>` → `<id>` (or `null` for an absent ref). */
function idFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const id = ref.startsWith(ARQUIVOS_PREFIX) ? ref.slice(ARQUIVOS_PREFIX.length) : ref;
  return id || null;
}

interface VideoMeta {
  formato: VideoFormato;
  duracaoSegundos: number;
  larguraPx: number;
  alturaPx: number;
  usarMercadoLivre: boolean;
  usarShopee: boolean;
}

/**
 * Read dimensions + duration from a video file via a hidden `<video>`, then
 * derive `formato` + marketplace-compat flags exactly like the Flutter
 * `widgets/video/video.dart`: aspect 0.8–1.2 ⇒ `quadrado`; Mercado Livre ≤180s;
 * Shopee 10–60s and ≤1280×1280.
 */
function extractVideoMeta(file: Blob): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const larguraPx = el.videoWidth;
      const alturaPx = el.videoHeight;
      const duracaoSegundos = Number.isFinite(el.duration) ? Math.round(el.duration) : 0;
      URL.revokeObjectURL(url);
      const aspect = alturaPx > 0 ? larguraPx / alturaPx : 0;
      const formato: VideoFormato = aspect >= 0.8 && aspect <= 1.2 ? 'quadrado' : 'retangular';
      const usarMercadoLivre = duracaoSegundos > 0 && duracaoSegundos <= 180;
      const usarShopee =
        duracaoSegundos >= 10 && duracaoSegundos <= 60 && larguraPx <= 1280 && alturaPx <= 1280;
      resolve({ formato, duracaoSegundos, larguraPx, alturaPx, usarMercadoLivre, usarShopee });
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new StorageUploadError('Não foi possível ler os metadados do vídeo.'));
    };
    el.src = url;
  });
}

export interface VideoManagerProps {
  /**
   * Owning product id — uploads are scoped to `produtos/<produtoId>/…`. `null`
   * in create mode (the product isn't saved yet): the manager then renders a
   * "save first" message instead of a dropzone that can't work.
   */
  produtoId: string | null;
  db: Firestore;
  storage: FirebaseStorage;
  /** Current `Produto.videos` value from the form. */
  value: Video[] | null;
  /** Push a new `videos` array back into the form (RHF tracks it as dirty). */
  onChange: (next: Video[]) => void;
  disabled?: boolean;
}

/**
 * Product video gallery wired into the Produto ObjectView's "Vídeos" tab.
 *
 * Uploads go through `uploadProductVideo` (videos are NOT resized — the original
 * is played back directly); the `Video` entry (with client-extracted metadata)
 * is appended to the form's `videos` array and persisted on save. Delete is
 * staged (see `DELETE_MARK` / the app-wide staged-deletion convention) and
 * applied on save via the field's `prepareForSave`.
 */
export function VideoManager({
  produtoId,
  db,
  storage,
  value,
  onChange,
  disabled,
}: VideoManagerProps) {
  const videos = useMemo<EditableVideo[]>(() => value ?? [], [value]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // No product id yet (create mode): uploads can't be scoped, so prompt to save.
  if (!produtoId) {
    return (
      <Alert color="blue" variant="light">
        Salve o produto para poder enviar vídeos.
      </Alert>
    );
  }

  // Non-null past the guard; capture as string so the upload closure keeps it.
  const ownerId: string = produtoId;

  async function handleDrop(files: FileWithPath[]) {
    setError(null);
    setUploading(true);
    try {
      const seen = new Set(videos.map((v) => v.arquivoOuterRef));
      const added: Video[] = [];
      for (const file of files) {
        const meta = await extractVideoMeta(file);
        const { id } = await uploadProductVideo({
          storage,
          db,
          produtoId: ownerId,
          bytes: file,
          contentType: file.type,
          originalFilename: file.name,
        });
        const arquivoOuterRef = `${ARQUIVOS_COLLECTION}/${id}`;
        if (seen.has(arquivoOuterRef)) continue; // dedup identical uploads
        seen.add(arquivoOuterRef);
        added.push({ arquivoOuterRef, ...meta, nomeArquivo: file.name, dataCadastro: Date.now() });
      }
      if (added.length > 0) {
        onChange([...videos, ...added]);
        notifications.show({ color: 'green', message: `${added.length} vídeo(s) enviado(s).` });
      } else {
        notifications.show({ color: 'gray', message: 'Vídeo(s) já adicionado(s).' });
      }
    } catch (err) {
      console.error('[VideoManager] upload failed', err);
      if (err instanceof FirebaseError) {
        setError(`Falha ao enviar o vídeo (${err.code}). ${err.message}`);
      } else if (err instanceof StorageUploadError) {
        setError(err.message);
      } else {
        throw err;
      }
    } finally {
      setUploading(false);
    }
  }

  // Staged deletion: mark the video (kept visible with undo) instead of removing
  // it; ObjectView strips marked items on save via prepareForSave.
  function toggleDelete(index: number) {
    onChange(videos.map((v, i) => (i === index ? { ...v, [DELETE_MARK]: !v[DELETE_MARK] } : v)));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = videos.findIndex((v) => v.arquivoOuterRef === active.id);
    const to = videos.findIndex((v) => v.arquivoOuterRef === over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(videos, from, to));
  }

  return (
    <Stack>
      {!disabled && (
        <Dropzone
          onDrop={handleDrop}
          accept={VIDEO_MIME}
          maxSize={MAX_VIDEO_BYTES}
          loading={uploading}
          multiple
        >
          <Group justify="center" gap="sm" mih={100} style={{ pointerEvents: 'none' }}>
            <IconVideoPlus size={32} />
            <div>
              <Text size="sm">Arraste vídeos aqui ou clique para selecionar</Text>
              <Text size="xs" c="dimmed">
                MP4, MOV, MPEG ou AVI · até 30 MB
              </Text>
            </div>
          </Group>
        </Dropzone>
      )}

      {error && <Alert color="red">{error}</Alert>}

      {videos.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nenhum vídeo.
        </Text>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={videos.map((v) => v.arquivoOuterRef)}
            strategy={rectSortingStrategy}
          >
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
              {videos.map((video, index) => (
                <SortableVideo
                  key={video.arquivoOuterRef}
                  video={video}
                  db={db}
                  marked={!!video[DELETE_MARK]}
                  disabled={disabled}
                  onToggleDelete={() => toggleDelete(index)}
                />
              ))}
            </SimpleGrid>
          </SortableContext>
        </DndContext>
      )}
    </Stack>
  );
}

interface SortableVideoProps {
  video: Video;
  db: Firestore;
  /** Marked for deletion — rendered dimmed with an undo button. */
  marked: boolean;
  disabled?: boolean;
  onToggleDelete: () => void;
}

function SortableVideo({ video, db, marked, disabled, onToggleDelete }: SortableVideoProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: video.arquivoOuterRef,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : marked ? 0.55 : 1,
    borderColor: marked ? 'var(--mantine-color-red-6)' : undefined,
  };

  const ref = useMemo(() => {
    const id = idFromRef(video.arquivoOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, video.arquivoOuterRef]);
  const snap = useDocSnapshot(ref);
  const url = snap.data?.data?.url ?? null;

  return (
    <Paper ref={setNodeRef} style={style} withBorder p={4} pos="relative">
      <Box pos="relative">
        {url ? (
          <video
            src={url}
            controls
            preload="metadata"
            aria-label="Vídeo do produto"
            style={{
              width: '100%',
              height: 160,
              objectFit: 'cover',
              borderRadius: 4,
              background: '#000',
            }}
          />
        ) : (
          <Group justify="center" h={160}>
            <Loader size="sm" />
          </Group>
        )}
        {marked && (
          <Badge color="red" size="xs" pos="absolute" top={4} left={4}>
            Será excluído
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
      <Group justify="space-between" mt={4} gap={4} wrap="nowrap">
        <Group gap={4}>
          {video.formato && (
            <Badge size="xs" variant="light">
              {video.formato === 'quadrado' ? 'Quadrado' : 'Retangular'}
            </Badge>
          )}
          {typeof video.duracaoSegundos === 'number' && (
            <Badge size="xs" variant="light" color="gray">
              {video.duracaoSegundos}s
            </Badge>
          )}
          {video.usarMercadoLivre && (
            <Badge size="xs" variant="light" color="yellow">
              Mercado Livre
            </Badge>
          )}
          {video.usarShopee && (
            <Badge size="xs" variant="light" color="orange">
              Shopee
            </Badge>
          )}
        </Group>
        {!disabled &&
          (marked ? (
            <ActionIcon
              variant="subtle"
              color="blue"
              size="sm"
              onClick={onToggleDelete}
              aria-label="Desfazer exclusão"
            >
              <IconArrowBackUp size={14} />
            </ActionIcon>
          ) : (
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              onClick={onToggleDelete}
              aria-label="Remover vídeo"
            >
              <IconTrash size={14} />
            </ActionIcon>
          ))}
      </Group>
    </Paper>
  );
}
