'use client';

import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Divider,
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
  IconArrowBackUp,
  IconFolderUp,
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
import { useFormContext } from 'react-hook-form';
import { arquivoCollection, StorageUploadError, uploadProductImage } from '@delfrance/storage';
import {
  type Foto,
  type FotoVariantSection,
  type GrupoComId,
  buildFotoRefs,
  grupoOuterRef,
  splitFotoSections,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { DELETE_MARK } from '@delfrance/ui';

/** A `Foto` plus the transient staged-deletion marker (keyed by `DELETE_MARK`). */
type EditableFoto = Foto & { [DELETE_MARK]?: boolean };

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
  /**
   * Variation groups (live), for the per-variant gallery sections. Optional —
   * without it every foto renders in the single parent-level gallery.
   */
  grupos?: GrupoComId[];
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
 *
 * Per-variant galleries (port of the Flutter `Fotos2ProdutoWidget`): the
 * parent's selected variants whose group has `permiteFotos` each get their own
 * section — uploads there tag the foto with `grupoDeVariacoesOuterRef` +
 * `variantePath`; untagged/orphaned fotos stay in the parent-level section.
 */
export function PhotoManager({
  produtoId,
  db,
  storage,
  grupos = [],
  value,
  onChange,
  disabled,
}: PhotoManagerProps) {
  const fotos = useMemo<EditableFoto[]>(() => value ?? [], [value]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live sibling field via the ObjectView FormProvider: the variant sections
  // follow the parent's CURRENT `variacoesUid` (even unsaved edits from the
  // Variações tab). Null outside a form (defensive) → no variant sections.
  const formCtx = useFormContext();
  const watchedUids = formCtx?.watch('variacoesUid') as string[] | null | undefined;

  const sections = useMemo(
    () => splitFotoSections({ fotos, parentUids: watchedUids ?? [], grupos }),
    [fotos, watchedUids, grupos],
  );

  const taggedIndexes = useMemo(
    () => fotos.map((f, i) => (f.variantePath ? i : -1)).filter((i) => i >= 0),
    [fotos],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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

  /** Upload dropped files; `section` tags them to a variant gallery. */
  async function handleDrop(files: FileWithPath[], section?: FotoVariantSection) {
    setError(null);
    setUploading(true);
    try {
      // Dedup per section: the same image may legitimately appear in both the
      // parent gallery and a variant gallery, but not twice in the same one.
      const dedupKey = (ref: string, variantePath: string | null | undefined) =>
        `${ref}|${variantePath ?? ''}`;
      const seen = new Set(fotos.map((f) => dedupKey(f.arquivoOuterRef, f.variantePath)));
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
        const key = dedupKey(refs.arquivoOuterRef, section?.uid ?? null);
        if (seen.has(key)) continue; // dedup identical uploads in the same gallery
        seen.add(key);
        added.push({
          ...refs,
          grupoDeVariacoesOuterRef: section ? grupoOuterRef(section.grupoId) : null,
          variantePath: section?.uid ?? null,
        });
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
        // Unexpected (non-Firebase) error: already logged above; rethrow so it
        // isn't silently swallowed.
        throw err;
      }
    } finally {
      setUploading(false);
    }
  }

  function makeCover(index: number) {
    if (index > 0) onChange(arrayMove(fotos, index, 0));
  }

  // Staged deletion: mark the foto (kept in the array, shown struck-through with
  // an undo) instead of removing it. ObjectView strips marked items on save via
  // the `prepareForSave: stripMarkedForDeletion` wired on the `fotos` field.
  function toggleDelete(index: number) {
    onChange(fotos.map((f, i) => (i === index ? { ...f, [DELETE_MARK]: !f[DELETE_MARK] } : f)));
  }

  /** Flutter's per-section deleteAll: any marked → unmark all, else mark all. */
  function toggleDeleteSection(indexes: number[]) {
    const set = new Set(indexes);
    const anyMarked = indexes.some((i) => fotos[i]?.[DELETE_MARK]);
    onChange(fotos.map((f, i) => (set.has(i) ? { ...f, [DELETE_MARK]: !anyMarked } : f)));
  }

  /** Move every variant-tagged foto to the parent gallery (staged on save). */
  function moveAllToParent() {
    if (taggedIndexes.length === 0) {
      notifications.show({ color: 'gray', message: 'As variações não possuem fotos para mover.' });
      return;
    }
    onChange(
      fotos.map((f) =>
        f.variantePath ? { ...f, grupoDeVariacoesOuterRef: null, variantePath: null } : f,
      ),
    );
    notifications.show({
      color: 'green',
      message: 'Fotos movidas para o produto pai — salve para gravar.',
    });
  }

  /** Stage-delete every variant-tagged foto (undo per item or save to apply). */
  function deleteAllVariantFotos() {
    if (taggedIndexes.length === 0) {
      notifications.show({
        color: 'gray',
        message: 'As variações não possuem fotos para excluir.',
      });
      return;
    }
    const set = new Set(taggedIndexes);
    onChange(fotos.map((f, i) => (set.has(i) ? { ...f, [DELETE_MARK]: true } : f)));
    notifications.show({
      color: 'yellow',
      message: 'Fotos das variações marcadas para exclusão — salve para aplicar.',
    });
  }

  /**
   * Reorder inside one section: the section's fotos move among their own
   * positions; the global array is rebuilt as general + variant sections in
   * display order (sections partition the array, so the rebuild is exact).
   */
  function handleSectionDragEnd(event: DragEndEvent, indexes: number[]) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const sectionFotos = indexes.map((i) => fotos[i]!);
    const from = sectionFotos.findIndex((f) => f.arquivoOuterRef === active.id);
    const to = sectionFotos.findIndex((f) => f.arquivoOuterRef === over.id);
    if (from < 0 || to < 0) return;
    const reordered = new Map(
      arrayMove(indexes, from, to).map((globalIndex, pos) => [indexes[pos]!, globalIndex]),
    );
    // Rebuild: every position keeps its foto except inside this section, where
    // positions take the moved order.
    onChange(fotos.map((f, i) => (reordered.has(i) ? fotos[reordered.get(i)!]! : f)));
  }

  function renderGrid(indexes: number[], withCover: boolean) {
    if (indexes.length === 0) {
      return (
        <Text size="sm" c="dimmed">
          Nenhuma foto.
        </Text>
      );
    }
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(e) => handleSectionDragEnd(e, indexes)}
      >
        <SortableContext
          items={indexes.map((i) => fotos[i]!.arquivoOuterRef)}
          strategy={rectSortingStrategy}
        >
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }}>
            {indexes.map((index) => {
              const foto = fotos[index]!;
              return (
                <SortableFoto
                  key={foto.arquivoOuterRef}
                  foto={foto}
                  db={db}
                  isCover={withCover && index === 0}
                  showCover={withCover}
                  marked={!!foto[DELETE_MARK]}
                  disabled={disabled}
                  onCover={() => makeCover(index)}
                  onToggleDelete={() => toggleDelete(index)}
                />
              );
            })}
          </SimpleGrid>
        </SortableContext>
      </DndContext>
    );
  }

  function sectionDeleteLabel(indexes: number[]) {
    return indexes.some((i) => fotos[i]?.[DELETE_MARK]) ? 'Desfazer exclusões' : 'Excluir todas';
  }

  return (
    <Stack>
      {!disabled && (
        <Dropzone
          onDrop={(files) => handleDrop(files)}
          accept={IMAGE_MIME_TYPE}
          loading={uploading}
          multiple
        >
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

      {!disabled && sections.variants.length > 0 && taggedIndexes.length > 0 && (
        <Group justify="flex-end" gap="xs">
          <Button
            variant="default"
            size="xs"
            leftSection={<IconFolderUp size={14} />}
            onClick={moveAllToParent}
          >
            Mover fotos para o produto pai
          </Button>
          <Button variant="subtle" color="red" size="xs" onClick={deleteAllVariantFotos}>
            Excluir fotos das variações
          </Button>
        </Group>
      )}

      {renderGrid(sections.general, true)}

      {sections.variants.map((section) => (
        <Stack key={section.uid} gap="xs">
          <Divider
            label={
              <Group gap="xs">
                <Text size="sm" fw={600}>
                  {section.grupoNome}: {section.varianteNome}
                </Text>
                {!disabled && section.fotoIndexes.length > 0 && (
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-xs"
                    onClick={() => toggleDeleteSection(section.fotoIndexes)}
                  >
                    {sectionDeleteLabel(section.fotoIndexes)}
                  </Button>
                )}
              </Group>
            }
            labelPosition="left"
          />
          {renderGrid(section.fotoIndexes, false)}
          {!disabled && (
            <Dropzone
              onDrop={(files) => handleDrop(files, section)}
              accept={IMAGE_MIME_TYPE}
              loading={uploading}
              multiple
            >
              <Group justify="center" gap="xs" mih={48} style={{ pointerEvents: 'none' }}>
                <IconPhotoPlus size={20} />
                <Text size="xs" c="dimmed">
                  Adicionar fotos para {section.varianteNome}
                </Text>
              </Group>
            </Dropzone>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

interface SortableFotoProps {
  foto: Foto;
  db: Firestore;
  isCover: boolean;
  /** Cover actions only exist in the parent-level gallery. */
  showCover: boolean;
  /** Marked for deletion — rendered dimmed with an undo button. */
  marked: boolean;
  disabled?: boolean;
  onCover: () => void;
  onToggleDelete: () => void;
}

function SortableFoto({
  foto,
  db,
  isCover,
  showCover,
  marked,
  disabled,
  onCover,
  onToggleDelete,
}: SortableFotoProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: foto.arquivoOuterRef,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : marked ? 0.55 : 1,
    borderColor: marked ? 'var(--mantine-color-red-6)' : undefined,
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
  // Prefer the 200px derivative when it exists; otherwise show the original.
  // Once the derivative is available the original listener is redundant, so we
  // pass `null` to release it (one live listener per thumbnail, not two). The
  // live snapshot still upgrades the thumbnail automatically when the resize
  // function later produces the derivative.
  const original = useDocSnapshot(deriv.data ? null : originalRef);
  const url = deriv.data?.data?.url ?? original.data?.data?.url ?? null;

  return (
    <Paper ref={setNodeRef} style={style} withBorder p={4} pos="relative">
      <Box pos="relative">
        {url ? (
          <Image src={url} alt="Foto do produto" h={140} fit="cover" radius="sm" />
        ) : (
          <Group justify="center" h={140}>
            <Loader size="sm" />
          </Group>
        )}
        {isCover && !marked && (
          <Badge color="blue" size="xs" pos="absolute" top={4} left={4}>
            Capa
          </Badge>
        )}
        {marked && (
          <Badge color="red" size="xs" pos="absolute" top={4} left={4}>
            Será excluída
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
          {showCover ? (
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={onCover}
              disabled={isCover || marked}
              aria-label="Definir como capa"
            >
              {isCover ? <IconStarFilled size={14} /> : <IconStar size={14} />}
            </ActionIcon>
          ) : (
            <span />
          )}
          {marked ? (
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
              aria-label="Remover foto"
            >
              <IconTrash size={14} />
            </ActionIcon>
          )}
        </Group>
      )}
    </Paper>
  );
}
