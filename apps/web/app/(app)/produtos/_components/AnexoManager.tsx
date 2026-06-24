'use client';

import { useMemo, useState } from 'react';
import { ActionIcon, Alert, Badge, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { Dropzone, type FileWithPath } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import {
  IconArrowBackUp,
  IconDownload,
  IconFile,
  IconFileText,
  IconFileZip,
  IconGripVertical,
  IconPaperclip,
  IconPhoto,
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
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import { arquivoCollection, StorageUploadError, uploadProductAnexo } from '@delfrance/storage';
import { ARQUIVOS_COLLECTION, type Anexo, buildAnexo } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { DELETE_MARK } from '@delfrance/ui';

// Any file type (the uploader derives `filetype` from the MIME); 25 MB cap to
// match the `produtos/<id>/anexos` storage rule.
const MAX_ANEXO_BYTES = 25 * 1024 * 1024;
const ARQUIVOS_PREFIX = `${ARQUIVOS_COLLECTION}/`;

/** An `Anexo` plus the transient staged-deletion marker (keyed by `DELETE_MARK`). */
type EditableAnexo = Anexo & { [DELETE_MARK]?: boolean };

/** `arquivos/<id>` → `<id>` (or `null` for an absent ref). */
function idFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const id = ref.startsWith(ARQUIVOS_PREFIX) ? ref.slice(ARQUIVOS_PREFIX.length) : ref;
  return id || null;
}

/** A type-suggestive icon for an attachment, by content type. */
function iconForContentType(contentType: string | null | undefined) {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('image/')) return <IconPhoto size={20} />;
  if (ct === 'application/pdf' || ct.startsWith('text/')) return <IconFileText size={20} />;
  if (
    ct.includes('zip') ||
    ct.includes('compressed') ||
    ct.includes('x-rar') ||
    ct.includes('x-7z')
  )
    return <IconFileZip size={20} />;
  return <IconFile size={20} />;
}

export interface AnexoManagerProps {
  /**
   * Owning product id — uploads are scoped to `produtos/<produtoId>/anexos`.
   * `null` in create mode (the product isn't saved yet): the manager renders a
   * "save first" message instead of a dropzone that can't work.
   */
  produtoId: string | null;
  db: Firestore;
  storage: FirebaseStorage;
  /** Current `Produto.anexos` value from the form. */
  value: Anexo[] | null;
  /** Push a new `anexos` array back into the form (RHF tracks it as dirty). */
  onChange: (next: Anexo[]) => void;
  disabled?: boolean;
}

/**
 * Product attachments gallery wired into the Produto ObjectView's "Anexos" tab.
 *
 * Uploads go through `uploadProductAnexo` (any content type, product-scoped, not
 * resized); the `Anexo` ref (`buildAnexo`) is appended to the form's `anexos`
 * array and persisted on save. Delete is staged (see `DELETE_MARK` / the
 * app-wide staged-deletion convention) and applied on save via the field's
 * `prepareForSave`; the eager reaper (`onProdutoMediaChanged`) then frees the
 * arquivo doc + Storage object once the produto write drops the ref.
 */
export function AnexoManager({
  produtoId,
  db,
  storage,
  value,
  onChange,
  disabled,
}: AnexoManagerProps) {
  const anexos = useMemo<EditableAnexo[]>(() => value ?? [], [value]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // No product id yet (create mode): uploads can't be scoped, so prompt to save.
  if (!produtoId) {
    return (
      <Alert color="blue" variant="light">
        Salve o produto para poder enviar anexos.
      </Alert>
    );
  }

  // Non-null past the guard; capture as string so the upload closure keeps it.
  const ownerId: string = produtoId;

  async function handleDrop(files: FileWithPath[]) {
    setError(null);
    setUploading(true);
    try {
      const seen = new Set(anexos.map((a) => a.arquivoOuterRef));
      const added: Anexo[] = [];
      for (const file of files) {
        const { id } = await uploadProductAnexo({
          storage,
          db,
          produtoId: ownerId,
          bytes: file,
          contentType: file.type || 'application/octet-stream',
          originalFilename: file.name,
        });
        const anexo = buildAnexo(id);
        if (seen.has(anexo.arquivoOuterRef)) continue; // dedup identical uploads
        seen.add(anexo.arquivoOuterRef);
        added.push(anexo);
      }
      if (added.length > 0) {
        onChange([...anexos, ...added]);
        notifications.show({ color: 'green', message: `${added.length} anexo(s) enviado(s).` });
      } else {
        notifications.show({ color: 'gray', message: 'Anexo(s) já adicionado(s).' });
      }
    } catch (err) {
      console.error('[AnexoManager] upload failed', err);
      if (err instanceof FirebaseError) {
        setError(`Falha ao enviar o anexo (${err.code}). ${err.message}`);
      } else if (err instanceof StorageUploadError) {
        setError(err.message);
      } else {
        throw err;
      }
    } finally {
      setUploading(false);
    }
  }

  // Staged deletion: mark the anexo (kept visible with undo) instead of removing
  // it; ObjectView strips marked items on save via prepareForSave.
  function toggleDelete(index: number) {
    onChange(anexos.map((a, i) => (i === index ? { ...a, [DELETE_MARK]: !a[DELETE_MARK] } : a)));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = anexos.findIndex((a) => a.arquivoOuterRef === active.id);
    const to = anexos.findIndex((a) => a.arquivoOuterRef === over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(anexos, from, to));
  }

  return (
    <Stack>
      {!disabled && (
        <Dropzone onDrop={handleDrop} maxSize={MAX_ANEXO_BYTES} loading={uploading} multiple>
          <Group justify="center" gap="sm" mih={100} style={{ pointerEvents: 'none' }}>
            <IconPaperclip size={32} />
            <div>
              <Text size="sm">Arraste arquivos aqui ou clique para selecionar</Text>
              <Text size="xs" c="dimmed">
                Qualquer tipo de arquivo · até 25 MB
              </Text>
            </div>
          </Group>
        </Dropzone>
      )}

      {error && <Alert color="red">{error}</Alert>}

      {anexos.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nenhum anexo.
        </Text>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={anexos.map((a) => a.arquivoOuterRef)}
            strategy={verticalListSortingStrategy}
          >
            <Stack gap="xs">
              {anexos.map((anexo, index) => (
                <SortableAnexo
                  key={anexo.arquivoOuterRef}
                  anexo={anexo}
                  db={db}
                  marked={!!anexo[DELETE_MARK]}
                  disabled={disabled}
                  onToggleDelete={() => toggleDelete(index)}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}
    </Stack>
  );
}

interface SortableAnexoProps {
  anexo: Anexo;
  db: Firestore;
  /** Marked for deletion — rendered dimmed with an undo button. */
  marked: boolean;
  disabled?: boolean;
  onToggleDelete: () => void;
}

function SortableAnexo({ anexo, db, marked, disabled, onToggleDelete }: SortableAnexoProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: anexo.arquivoOuterRef,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : marked ? 0.55 : 1,
    borderColor: marked ? 'var(--mantine-color-red-6)' : undefined,
  };

  const ref = useMemo(() => {
    const id = idFromRef(anexo.arquivoOuterRef);
    return id ? arquivoCollection.docRef(db, {}, id) : null;
  }, [db, anexo.arquivoOuterRef]);
  const snap = useDocSnapshot(ref);
  const arquivo = snap.data?.data ?? null;
  const url = arquivo?.url ?? null;
  const nome = arquivo?.originalFilename ?? arquivo?.filename ?? 'Arquivo';
  const contentType = arquivo?.contentType ?? null;
  // Created-first: the doc exists before the bytes finalize, so a brief window
  // has no url yet — show a loader and disable the download until it lands.
  const pending = !arquivo || (!url && arquivo.uploadState === 'pending');

  return (
    <Paper ref={setNodeRef} style={style} withBorder p="xs">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          {!disabled && (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              style={{ cursor: 'grab' }}
              aria-label="Reordenar"
              {...attributes}
              {...listeners}
            >
              <IconGripVertical size={16} />
            </ActionIcon>
          )}
          {pending ? <Loader size="xs" /> : iconForContentType(contentType)}
          <div style={{ minWidth: 0 }}>
            <Text size="sm" truncate title={nome}>
              {nome}
            </Text>
            {contentType && (
              <Text size="xs" c="dimmed" truncate>
                {contentType}
              </Text>
            )}
          </div>
          {marked && (
            <Badge color="red" size="xs">
              Será excluído
            </Badge>
          )}
        </Group>

        <Group gap={4} wrap="nowrap">
          <ActionIcon
            variant="subtle"
            color="blue"
            size="sm"
            component="a"
            href={url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            download={nome}
            aria-label="Baixar anexo"
            data-disabled={!url || undefined}
            style={!url ? { pointerEvents: 'none', opacity: 0.4 } : undefined}
          >
            <IconDownload size={16} />
          </ActionIcon>
          {!disabled &&
            (marked ? (
              <ActionIcon
                variant="subtle"
                color="blue"
                size="sm"
                onClick={onToggleDelete}
                aria-label="Desfazer exclusão"
              >
                <IconArrowBackUp size={16} />
              </ActionIcon>
            ) : (
              <ActionIcon
                variant="subtle"
                color="red"
                size="sm"
                onClick={onToggleDelete}
                aria-label="Remover anexo"
              >
                <IconTrash size={16} />
              </ActionIcon>
            ))}
        </Group>
      </Group>
    </Paper>
  );
}
