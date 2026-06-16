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
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
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
  remakeFakePath,
  splitFotoSections,
} from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { DELETE_MARK } from '@delfrance/ui';

/** A `Foto` plus the transient staged-deletion marker (keyed by `DELETE_MARK`). */
type EditableFoto = Foto & { [DELETE_MARK]?: boolean };

/**
 * Unique sortable id — the same arquivo may legitimately live in two galleries
 * (parent + a variant), so the dnd id pairs the ref with the gallery tag. It
 * also appends the foto's global array index `i` so that a duplicate
 * `arquivoOuterRef` within the SAME gallery (legacy Flutter data, #139) still
 * gets a distinct dnd/React id instead of colliding. The index is stable within
 * a render and across a drag (the array only changes on drop), which is all
 * dnd-kit needs.
 */
export const sortableIdOf = (f: EditableFoto, i: number) =>
  `${f.arquivoOuterRef}|${f.variantePath ?? ''}|${i}`;

/** Droppable id prefix for a whole gallery section (drop target when empty). */
const CONTAINER_PREFIX = 'section::';

/** One gallery in display order; `null` grupo/uid = the parent-level gallery. */
interface SectionList {
  key: string;
  grupoId: string | null;
  uid: string | null;
  indexes: number[];
}

/**
 * Multi-container collision detection. `closestCenter` made empty galleries
 * undroppable: their tiny body always lost the center-distance contest to a
 * photo card or a large gallery. Instead: prefer the foto card the pointer is
 * actually over (precise within-section sorting); else the section body the
 * pointer is inside (the empty-gallery drop); else fall back to rectangle
 * intersection.
 */
const galleryCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const itemHits = within.filter((c) => !String(c.id).startsWith(CONTAINER_PREFIX));
  if (itemHits.length > 0) return itemHits;
  if (within.length > 0) return within;
  return rectIntersection(args);
};

/**
 * Alternating section background ("zebra striping") so each gallery reads as
 * its own block. `--mantine-color-default-hover` adapts to light/dark schemes.
 */
function stripeBg(index: number): string | undefined {
  return index % 2 === 1 ? 'var(--mantine-color-default-hover)' : undefined;
}

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
  // Variações tab). NOTE: react-hook-form's `useFormContext` is TYPED non-null
  // but actually returns `null` outside a provider (its context default —
  // verified against v7.75 dist), so the optional chaining is load-bearing:
  // without a form context the manager just renders no variant sections.
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

  // Galleries in display order — the shared structure for rendering and for
  // the cross-section drag handler (sections partition the fotos array).
  const sectionLists = useMemo<SectionList[]>(
    () => [
      { key: 'general', grupoId: null, uid: null, indexes: sections.general },
      ...sections.variants.map((s) => ({
        key: s.uid,
        grupoId: s.grupoId,
        uid: s.uid,
        indexes: s.fotoIndexes,
      })),
    ],
    [sections],
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
      // Tags are canonicalized so Flutter-legacy path forms still dedup.
      const dedupKey = (ref: string, variantePath: string | null | undefined) =>
        `${ref}|${variantePath ? (remakeFakePath(variantePath) ?? variantePath) : ''}`;
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

  /**
   * Move every variant-tagged foto to the parent gallery (staged on save).
   * Merging, not duplicating: a tagged copy whose image already exists in the
   * parent gallery (or in an earlier-stripped copy) is dropped — two untagged
   * fotos with the same `arquivoOuterRef` would collide React keys + dnd ids.
   */
  function moveAllToParent() {
    if (taggedIndexes.length === 0) {
      notifications.show({ color: 'gray', message: 'As variações não possuem fotos para mover.' });
      return;
    }
    const inParent = new Set(fotos.filter((f) => !f.variantePath).map((f) => f.arquivoOuterRef));
    const next: Foto[] = [];
    for (const f of fotos) {
      if (!f.variantePath) {
        next.push(f);
        continue;
      }
      if (inParent.has(f.arquivoOuterRef)) continue; // already in the parent → merge
      inParent.add(f.arquivoOuterRef);
      next.push({ ...f, grupoDeVariacoesOuterRef: null, variantePath: null });
    }
    onChange(next);
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

  /** Find a dragged foto by its sortable id: which gallery + position inside it. */
  function locate(id: string): { list: number; pos: number } | null {
    for (let li = 0; li < sectionLists.length; li += 1) {
      const pos = sectionLists[li]!.indexes.findIndex((i) => sortableIdOf(fotos[i]!, i) === id);
      if (pos >= 0) return { list: li, pos };
    }
    return null;
  }

  /**
   * One drag handler for every gallery: reorder inside a section, or — like
   * the old app's single reorderable list — drop a foto onto ANOTHER section
   * to move it there (retagging `grupoDeVariacoesOuterRef`/`variantePath`,
   * staged like any other edit). The global array is rebuilt section-major;
   * sections partition it, so the rebuild is exact and capa stays the first
   * parent-gallery foto.
   */
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const src = locate(String(active.id));
    if (!src) return;

    const overId = String(over.id);
    let dstList: number;
    let dstPos: number;
    if (overId.startsWith(CONTAINER_PREFIX)) {
      // Dropped on a section body (e.g. an empty gallery) → append at the end.
      dstList = sectionLists.findIndex((l) => `${CONTAINER_PREFIX}${l.key}` === overId);
      if (dstList < 0) return;
      dstPos = sectionLists[dstList]!.indexes.length;
    } else {
      const dst = locate(overId);
      if (!dst) return;
      dstList = dst.list;
      dstPos = dst.pos;
    }

    const listsFotos = sectionLists.map((l) => l.indexes.map((i) => fotos[i]!));
    if (dstList === src.list) {
      listsFotos[src.list] = arrayMove(listsFotos[src.list]!, src.pos, dstPos);
    } else {
      const target = sectionLists[dstList]!;
      const moving = listsFotos[src.list]![src.pos]!;
      if (listsFotos[dstList]!.some((f) => f.arquivoOuterRef === moving.arquivoOuterRef)) {
        notifications.show({
          color: 'gray',
          message: 'Esta foto já existe na galeria de destino.',
        });
        return;
      }
      listsFotos[src.list]!.splice(src.pos, 1);
      listsFotos[dstList]!.splice(dstPos, 0, {
        ...moving,
        grupoDeVariacoesOuterRef: target.grupoId ? grupoOuterRef(target.grupoId) : null,
        variantePath: target.uid,
      });
    }
    onChange(listsFotos.flat());
  }

  function renderGrid(sectionKey: string, indexes: number[], withCover: boolean) {
    return (
      <SectionGrid
        sectionKey={sectionKey}
        indexes={indexes}
        fotos={fotos}
        db={db}
        withCover={withCover}
        disabled={disabled}
        onCover={makeCover}
        onToggleDelete={toggleDelete}
      />
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

      <DndContext sensors={sensors} collisionDetection={galleryCollision} onDragEnd={handleDragEnd}>
        {/* Zebra-striped sections (alternating background) so each gallery
            reads as its own block — the parent gallery is stripe 0. */}
        <Paper p="sm" radius="md" bg={stripeBg(0)}>
          {renderGrid('general', sections.general, true)}
        </Paper>

        {sections.variants.map((section, idx) => (
          <Paper key={section.uid} p="sm" radius="md" bg={stripeBg(idx + 1)}>
            <Stack gap="xs">
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
              {renderGrid(section.uid, section.fotoIndexes, false)}
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
          </Paper>
        ))}
      </DndContext>
    </Stack>
  );
}

interface SectionGridProps {
  sectionKey: string;
  /** Global indexes of this gallery's fotos, in display order. */
  indexes: number[];
  fotos: EditableFoto[];
  db: Firestore;
  withCover: boolean;
  disabled?: boolean;
  onCover: (index: number) => void;
  onToggleDelete: (index: number) => void;
}

/**
 * One gallery's sortable grid. The whole body is a droppable container so a
 * foto can be dragged INTO this section even when it's empty (the drop retags
 * it — see `handleDragEnd`).
 */
function SectionGrid({
  sectionKey,
  indexes,
  fotos,
  db,
  withCover,
  disabled,
  onCover,
  onToggleDelete,
}: SectionGridProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `${CONTAINER_PREFIX}${sectionKey}` });
  return (
    <SortableContext
      items={indexes.map((i) => sortableIdOf(fotos[i]!, i))}
      strategy={rectSortingStrategy}
    >
      <Box
        ref={setNodeRef}
        p={2}
        style={
          isOver
            ? {
                outline: '2px dashed var(--mantine-color-blue-4)',
                outlineOffset: 2,
                borderRadius: 4,
              }
            : undefined
        }
      >
        {indexes.length === 0 ? (
          // A real drop target even when empty — fotos can be dragged INTO
          // this gallery from any other section.
          <Group
            justify="center"
            mih={56}
            style={{
              border: '1px dashed var(--mantine-color-gray-4)',
              borderRadius: 4,
            }}
          >
            <Text size="sm" c="dimmed">
              Nenhuma foto — arraste uma foto para cá.
            </Text>
          </Group>
        ) : (
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }}>
            {indexes.map((index) => {
              const foto = fotos[index]!;
              return (
                <SortableFoto
                  key={sortableIdOf(foto, index)}
                  sortableId={sortableIdOf(foto, index)}
                  foto={foto}
                  db={db}
                  isCover={withCover && index === 0}
                  showCover={withCover}
                  marked={!!foto[DELETE_MARK]}
                  disabled={disabled}
                  onCover={() => onCover(index)}
                  onToggleDelete={() => onToggleDelete(index)}
                />
              );
            })}
          </SimpleGrid>
        )}
      </Box>
    </SortableContext>
  );
}

interface SortableFotoProps {
  /** Unique dnd id (`ref|variantePath|index`) — see `sortableIdOf`. */
  sortableId: string;
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
  sortableId,
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
    id: sortableId,
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
