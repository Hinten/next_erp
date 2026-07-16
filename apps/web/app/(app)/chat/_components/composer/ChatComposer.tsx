'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  FileButton,
  Group,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconLogin2, IconPaperclip, IconSend } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { setDoc, writeBatch } from 'firebase/firestore';
import {
  ORIGEM_RULES,
  WHATSAPP_ANEXO_LIMITS,
  type Conversa,
  type Filetype,
  toOuterRef,
} from '@delfrance/schemas';
import { StorageUploadError, uploadFile } from '@delfrance/storage';
import { mensagemCollection } from '@/lib/data/conversaCollection';
import { newDocId } from '@/lib/data/newDocId';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { composerGate } from '@/lib/chat/composerGate';
import { enterConversa, resolveActor } from '@/lib/chat/conversaActions';
import { clearDraft, getDraft, setDraft } from '@/lib/chat/draft';
import { getSendKey, sendKeyAction, setSendKey, type SendKey } from '@/lib/chat/sendKey';
import { buildMediaMensagem, buildTextMensagem, makeOptimistic } from '@/lib/chat/mensagemWrite';
import type { OptimisticMensagem } from '@/lib/chat/mensagemWrite';
import { EmojiButton } from './EmojiButton';
import { SendKeySettings } from './SendKeySettings';
import { AttachmentChips, type PendingAttachment } from './AttachmentChips';

const DRAFT_SAVE_DEBOUNCE_MS = 400;

export interface ChatComposerProps {
  conversaId: string;
  conversa: Conversa;
  addOptimistic: (entry: OptimisticMensagem) => void;
  markOptimisticError: (docId: string) => void;
}

/** WhatsApp per-media-type byte cap (legacy `verificarTamanhoAnexoWhatsapp`). */
function whatsappCap(contentType: string): number {
  const mime = contentType.toLowerCase();
  if (mime === 'image/webp') return WHATSAPP_ANEXO_LIMITS.sticker;
  if (mime.startsWith('image/')) return WHATSAPP_ANEXO_LIMITS.image;
  if (mime.startsWith('video/')) return WHATSAPP_ANEXO_LIMITS.video;
  if (mime.startsWith('audio/')) return WHATSAPP_ANEXO_LIMITS.audio;
  if (mime.startsWith('text/')) return WHATSAPP_ANEXO_LIMITS.text;
  return WHATSAPP_ANEXO_LIMITS.application;
}

export function ChatComposer({
  conversaId,
  conversa,
  addOptimistic,
  markOptimisticError,
}: ChatComposerProps) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const gate = composerGate({
    usuarios: conversa.usuarios,
    estadoConversa: conversa.estadoConversa,
    uid,
  });

  if (gate === 'no-uid') return null;
  if (gate === 'enter') {
    return <EntrarNaConversa conversaId={conversaId} />;
  }
  return (
    <ComposerInput
      conversaId={conversaId}
      conversa={conversa}
      uid={uid}
      addOptimistic={addOptimistic}
      markOptimisticError={markOptimisticError}
    />
  );
}

/* --------------------------- "Entrar na conversa" -------------------------- */

function EntrarNaConversa({ conversaId }: { conversaId: string }) {
  const { user } = useAuth();
  const [entering, setEntering] = useState(false);

  async function handleEnter() {
    const actor = resolveActor(user);
    if (!actor) return;
    setEntering(true);
    const db = getFirebaseFirestore();
    const now = Date.now();
    const batch = writeBatch(db);
    // The shared `enterConversa` writer: a converter-stripped conversa patch
    // (usuarios arrayUnion + estado emResposta + bumped ultima_modificacao) plus
    // the entry event (tipo 'e', excluded from the #529 sender). Same impl the
    // ConversaActionsMenu drives, so both surfaces write identical events.
    enterConversa({ batch, db, conversaId, actor, now });
    try {
      await batch.commit();
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({ color: 'red', title: 'Falha ao entrar', message: err.message });
      } else {
        throw err;
      }
    } finally {
      setEntering(false);
    }
  }

  return (
    <Box p="sm" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
      <Button
        fullWidth
        variant="light"
        leftSection={<IconLogin2 size={16} />}
        loading={entering}
        onClick={handleEnter}
      >
        Entrar na conversa
      </Button>
    </Box>
  );
}

/* ------------------------------ full composer ----------------------------- */

function ComposerInput({
  conversaId,
  conversa,
  uid,
  addOptimistic,
  markOptimisticError,
}: {
  conversaId: string;
  conversa: Conversa;
  uid: string | null;
  addOptimistic: (entry: OptimisticMensagem) => void;
  markOptimisticError: (docId: string) => void;
}) {
  const rules = ORIGEM_RULES[conversa.origem];
  const [text, setText] = useState(() => getDraft(conversaId));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sendKey, setSendKeyState] = useState<SendKey>('ctrlEnter');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resetFileRef = useRef<() => void>(null);

  // Restore the persisted send-key preference on mount (client-only).
  useEffect(() => {
    setSendKeyState(getSendKey());
  }, []);

  // Debounced draft persistence (legacy `setRascunhoMensagem`).
  useEffect(() => {
    const t = setTimeout(() => setDraft(conversaId, text), DRAFT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [conversaId, text]);

  const uploading = attachments.some((a) => a.status === 'uploading');
  const doneAttachments = attachments.filter(
    (a) => a.status === 'done' && a.arquivoRef && a.filetype,
  );
  const canSend = !sending && !uploading && (text.trim() !== '' || doneAttachments.length > 0);
  // The Graph API drops audio captions (outbound.ts `performSend`), so a typed
  // caption alongside an audio attachment won't reach WhatsApp — only the thread.
  const audioCaptionDropped = attachments.some((a) => a.filetype === 'audio') && text.trim() !== '';

  function insertAtCursor(insert: string) {
    const el = textareaRef.current;
    if (!el) {
      setText((t) => t + insert);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(next);
    // Restore caret after the inserted emoji on the next tick.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function validateAndAdd(files: File[]) {
    if (!rules.permiteAnexo) {
      notifications.show({ color: 'red', message: 'Este canal não permite anexos.' });
      return;
    }
    const remaining = rules.maximoAnexos - attachments.length;
    if (files.length > remaining) {
      notifications.show({
        color: 'red',
        message: `Limite de ${rules.maximoAnexos} anexo(s) para este canal.`,
      });
      return;
    }
    const isWhatsapp = conversa.origem === 'whatsapp';
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (rules.formatosAnexo && !rules.formatosAnexo.includes(ext)) {
        notifications.show({ color: 'red', message: `Formato .${ext} não permitido.` });
        continue;
      }
      const cap = isWhatsapp ? whatsappCap(file.type) : rules.maxTamanhoAnexoBytes;
      if (file.size > cap) {
        notifications.show({
          color: 'red',
          message: `${file.name} excede o limite de ${(cap / 1_000_000).toFixed(1)} MB.`,
        });
        continue;
      }
      void startUpload(file);
    }
    resetFileRef.current?.();
  }

  async function startUpload(file: File) {
    const localId = newDocId();
    setAttachments((prev) => [
      ...prev,
      { id: localId, name: file.name, size: file.size, status: 'uploading' },
    ]);
    try {
      const contentType = file.type || 'application/octet-stream';
      const result = await uploadFile({
        storage: getFirebaseStorage(),
        db: getFirebaseFirestore(),
        bytes: file,
        contentType,
        filepath: 'chat',
        originalFilename: file.name,
      });
      const arquivoRef = toOuterRef(`arquivos/${result.id}`);
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === localId
            ? { ...a, status: 'done', arquivoRef, filetype: result.arquivo.filetype }
            : a,
        ),
      );
    } catch (err) {
      // Upload helpers reject with StorageUploadError (bad input / failed fetch)
      // or a Firebase Storage FirebaseError; narrow to those and rethrow the rest
      // (repo rule 6 — a base-`Error` clause would swallow unrelated bugs).
      if (!(err instanceof StorageUploadError || err instanceof FirebaseError)) throw err;
      setAttachments((prev) =>
        prev.map((a) => (a.id === localId ? { ...a, status: 'error', error: err.message } : a)),
      );
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function handleSend() {
    if (!canSend) return;
    const body = text.trim();
    const attachmentsToSend = doneAttachments;
    const db = getFirebaseFirestore();
    const sentIds: string[] = [];
    setSendError(null);
    setSending(true);
    try {
      if (attachmentsToSend.length === 0) {
        // Text-only — the #529 outbound contract write (salva / tipo 'c' / mid null).
        const docId = newDocId();
        const write = buildTextMensagem({ text: body, uid, now: Date.now() });
        sentIds.push(docId);
        addOptimistic(makeOptimistic(docId, write));
        await setDoc(mensagemCollection.docRef(db, { conversaId }, docId), write);
      } else {
        // Media — the caption (composer text) rides on the FIRST attachment; the
        // rest carry no caption. Each attachment is its own outbound mensagem
        // (anexoStorage dual-write so the #529 sender transmits the file).
        for (let i = 0; i < attachmentsToSend.length; i++) {
          const a = attachmentsToSend[i]!;
          const caption = i === 0 && body !== '' ? body : null;
          const docId = newDocId();
          const write = buildMediaMensagem({
            arquivoRef: a.arquivoRef!,
            filetype: a.filetype as Filetype,
            caption,
            uid,
            now: Date.now(),
          });
          sentIds.push(docId);
          addOptimistic(makeOptimistic(docId, write));
          await setDoc(mensagemCollection.docRef(db, { conversaId }, docId), write);
        }
      }
      // Clear the composer ONLY after the awaited writes succeed. The optimistic
      // bubbles already carry the content, so this still empties the input on a
      // normal send — but on a FirebaseError below we restore NOTHING (the text
      // is still in state), keeping the operator's message recoverable after an
      // unmount. A retry pre-mints a NEW doc id, so there is no dedupe risk.
      setText('');
      clearDraft(conversaId);
      setAttachments([]);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSendError(err.message);
        for (const id of sentIds) markOptimisticError(id);
      } else {
        throw err;
      }
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const action = sendKeyAction(sendKey, {
      key: e.key,
      ctrlOrMeta: e.ctrlKey || e.metaKey,
      shift: e.shiftKey,
      // Skip sending mid-IME-composition — Enter confirms the candidate, it must
      // not fire the send (nativeEvent carries the composition flag).
      isComposing: e.nativeEvent.isComposing,
    });
    if (action === 'send') {
      e.preventDefault();
      void handleSend();
    }
    // 'newline' / 'ignore' → default textarea behaviour.
  }

  const overLimit = text.length > rules.limiteCaracteres;
  const acceptAttr = rules.formatosAnexo
    ? rules.formatosAnexo.map((e) => `.${e}`).join(',')
    : undefined;

  return (
    <Box
      p="sm"
      style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}
      onDragOver={(e) => {
        if (rules.permiteAnexo) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!rules.permiteAnexo) return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) validateAndAdd(files);
      }}
    >
      {sendError && (
        <Alert color="red" mb="xs" withCloseButton onClose={() => setSendError(null)}>
          {sendError}
        </Alert>
      )}

      <AttachmentChips attachments={attachments} onRemove={removeAttachment} />

      <Group align="flex-end" gap="xs" wrap="nowrap">
        {rules.permiteAnexo && (
          <FileButton
            resetRef={resetFileRef}
            multiple
            accept={acceptAttr}
            onChange={(files) => files.length > 0 && validateAndAdd(files)}
          >
            {(props) => (
              <Tooltip label="Anexar arquivo">
                <ActionIcon {...props} variant="subtle" color="gray" aria-label="Anexar">
                  <IconPaperclip size={20} />
                </ActionIcon>
              </Tooltip>
            )}
          </FileButton>
        )}

        <EmojiButton onSelect={insertAtCursor} disabled={sending} />

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="Digite uma mensagem…"
          autosize
          minRows={1}
          maxRows={10}
          maxLength={rules.limiteCaracteres}
          style={{ flex: 1 }}
          disabled={sending}
          error={overLimit}
        />

        <SendKeySettings
          value={sendKey}
          onChange={(v) => {
            setSendKeyState(v);
            setSendKey(v);
          }}
        />

        <Tooltip label={sendKey === 'enter' ? 'Enviar (Enter)' : 'Enviar (⌘/Ctrl + Enter)'}>
          <ActionIcon
            size="lg"
            variant="filled"
            color="blue"
            disabled={!canSend}
            onClick={() => void handleSend()}
            aria-label="Enviar"
          >
            <IconSend size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {audioCaptionDropped && (
        <Text size="xs" c="dimmed" mt={4}>
          Áudio não leva legenda no WhatsApp — o texto será exibido apenas aqui.
        </Text>
      )}

      <Group justify="flex-end" mt={4}>
        <Text size="xs" c={overLimit ? 'red' : 'dimmed'}>
          {text.length}/{rules.limiteCaracteres}
        </Text>
      </Group>
    </Box>
  );
}
