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
import { IconInfoCircle, IconLogin2, IconPaperclip, IconSend } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { setDoc, writeBatch } from 'firebase/firestore';
import {
  ORIGEM_CONVERSA,
  ORIGEM_RULES,
  WHATSAPP_ANEXO_LIMITS,
  type Conversa,
  type Filetype,
  idFromRef,
  toOuterRef,
} from '@delfrance/schemas';
import { StorageUploadError, uploadFile } from '@delfrance/storage';
import { mensagemCollection } from '@/lib/data/conversaCollection';
import { newDocId } from '@/lib/data/newDocId';
import { getFirebaseFirestore, getFirebaseStorage } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { useConfirmDialog } from '@/app/(app)/pedidos/_components/ConfirmDialog';
import { composerGate } from '@/lib/chat/composerGate';
import { confirmacaoEnvio } from '@/lib/chat/confirmacaoEnvio';
import { enviaPorRota } from '@/lib/chat/transporteEnvio';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
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
    origem: conversa.origem,
    respostaBloqueada: conversa.respostaBloqueada,
  });

  if (gate.kind === 'no-uid') return null;
  // Say WHY rather than rendering nothing — and note this arm also suppresses
  // "Entrar na conversa", which would otherwise reopen a dead thread into a
  // fully enabled composer (#817).
  if (gate.kind === 'somente-leitura') {
    return <SomenteLeitura motivo={gate.motivo} />;
  }
  if (gate.kind === 'enter') {
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

/* ------------------------------ read-only notice --------------------------- */

/**
 * Shown in place of the composer when nothing we write could reach the contact.
 *
 * The whole point of #817 is that the previous behaviour was a fully enabled
 * composer whose messages sat at `estadoEnvio: 'salva'` forever while the
 * provider's SLA clock ran — no error, no hint. An explicit notice is the fix;
 * silently hiding the input would only replace one confusion with another.
 */
function SomenteLeitura({ motivo }: { motivo: string }) {
  return (
    <Alert
      variant="light"
      color="gray"
      icon={<IconInfoCircle size={16} />}
      data-testid="composer-somente-leitura"
      styles={{ root: { borderRadius: 0 } }}
    >
      {motivo}
    </Alert>
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
  const mlClient = useMercadoLivreClient();
  /**
   * The awaitable confirm bridge, for the sends that cannot be taken back.
   *
   * It has to be promise-based rather than a state-driven modal because the gate
   * belongs INSIDE `handleSend` — that is what makes the keyboard path (Enter /
   * ⌘+Enter, `onKeyDown` below) go through it for free. A guard wired to the send
   * button's `onClick` would leave the faster, more dangerous path wide open.
   *
   * Safe to mount here: the composer is not itself inside a `<Modal>`, so the
   * `keepMounted` hazard that stranded a pending promise in #1096 does not apply.
   */
  const { confirm, element: confirmElement } = useConfirmDialog();
  /**
   * Whether this origem sends through the channel BACKEND rather than by
   * writing a mensagem for a trigger to pick up.
   *
   * ⚠️ Genuinely derived now — `TRANSPORTE_ENVIO` is total over the origens, so
   * the day a fifth surface gains a route it is classified there and nowhere
   * else. It used to be a hand-kept set right here, and #768 gave `mlclaims` a
   * route without updating it: every claim reply took the Firestore branch and
   * was never transmitted.
   */
  const porRota = enviaPorRota(conversa.origem);
  /**
   * ⚠️ NARROWER than `rules.permiteAnexo` on purpose. That flag states what the
   * CHANNEL accepts (mlped takes one 25 MB file); this states what the composer
   * can actually deliver, and the #533 responder route sends text only. Leaving
   * the paperclip enabled would let an operator stage a file that `handleSend`
   * then silently drops — the exact #817 failure mode, one layer down.
   * Post-sale attachment upload is tracked separately.
   */
  const podeAnexar = rules.permiteAnexo && !porRota;
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
  // The Textarea's maxLength blocks TYPING past the origem limit, but a
  // restored draft (or programmatic state) can exceed it — gate sending too
  // so an over-limit body never reaches the outbound write (Copilot, PR #584).
  const overLimit = text.length > rules.limiteCaracteres;
  const canSend =
    !sending && !uploading && !overLimit && (text.trim() !== '' || doneAttachments.length > 0);
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
    if (!podeAnexar) {
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
    const isWhatsapp = conversa.origem === ORIGEM_CONVERSA.whatsapp;
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
      if (porRota) {
        // ⚠️ Mercado Livre does NOT go through the Firestore-write path. The
        // reply is single-shot and its refusals are terminal, so the route
        // sends to ML first and only then appends the mensagem — a write here
        // would leave a phantom reply whenever ML says no.
        //
        // No optimistic bubble either: the server writes the real one, and an
        // optimistic twin would have to be reconciled against a doc id only
        // the server knows.
        const integracaoId = conversa.integracaoOuterRef
          ? idFromRef(conversa.integracaoOuterRef)
          : null;
        if (!mlClient || !integracaoId) {
          setSendError('Conta do Mercado Livre não resolvida para esta conversa.');
          return;
        }
        // ⚠️ AFTER the guard above, deliberately: never make an operator confirm
        // a send that cannot happen anyway. And after `setSending(true)`, which
        // means `canSend` is already false while the dialog is open — a second
        // Enter cannot stack a second confirmation on the same draft.
        //
        // Only `mlperg` is configured (see `confirmacaoEnvio.ts`): a Mercado
        // Livre question takes exactly ONE answer, published on the anúncio with
        // no edit and no retract, and the successful send closes the atendimento.
        const confirmacao = confirmacaoEnvio(conversa.origem);
        if (confirmacao) {
          const ok = await confirm({
            title: confirmacao.titulo,
            // The body is shown back verbatim. It is the last moment the text is
            // still private, and re-reading it is the whole point of stopping.
            message: (
              <Stack gap="xs">
                <Text>{confirmacao.aviso}</Text>
                <Box
                  p="xs"
                  style={{
                    border: '1px solid var(--mantine-color-gray-3)',
                    borderRadius: 'var(--mantine-radius-sm)',
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {body}
                  </Text>
                </Box>
              </Stack>
            ),
            confirmLabel: confirmacao.confirmar,
            cancelLabel: 'Cancelar',
          });
          if (!ok) {
            // Nothing was written and `setText('')` only runs on success, so the
            // draft survives untouched; the outer `finally` re-enables the input.
            //
            // ⚠️ Focus must WAIT for that re-render. `sending` is still true on
            // this line — `setSending(false)` lives in the `finally` below and
            // React has not flushed it yet — so the Textarea is still
            // `disabled`, and a disabled element cannot take focus. A bare
            // `focus()` here silently leaves the caret on <body>, making cancel
            // cost a click that the pre-gate Enter path never charged. Same
            // deferral `insertAtCursor` uses above, for the same reason.
            requestAnimationFrame(() => textareaRef.current?.focus());
            return;
          }
        }
        await mlClient.responderConversa({ integracaoId, conversaId, texto: body });
      } else if (attachmentsToSend.length === 0) {
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
      // A route refusal (409) carries the operator-facing reason ML gave — an
      // already-answered question, a blocked thread, an expired window. It is
      // shown verbatim, because paraphrasing it would lose the only thing that
      // tells the operator what to do next.
      if (
        err instanceof MercadoLivreClientHttpError ||
        err instanceof MercadoLivreClientNetworkError
      ) {
        setSendError(err.message);
        for (const id of sentIds) markOptimisticError(id);
      } else if (err instanceof FirebaseError) {
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

  const acceptAttr = rules.formatosAnexo
    ? rules.formatosAnexo.map((e) => `.${e}`).join(',')
    : undefined;

  return (
    <Box
      p="sm"
      style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}
      onDragOver={(e) => {
        if (podeAnexar) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!podeAnexar) return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) validateAndAdd(files);
      }}
    >
      {/*
        ⚠️ Mounted inside the composer, so it unmounts with it. Known, benign:
        if another operator answers the same question while this dialog is open,
        the snapshot flips `respostaBloqueada`, `ChatComposer` takes the
        read-only arm and this promise never settles. Nothing user-visible — the
        thread correctly goes read-only and no send is attempted.
      */}
      {confirmElement}

      {sendError && (
        <Alert color="red" mb="xs" withCloseButton onClose={() => setSendError(null)}>
          {sendError}
        </Alert>
      )}

      <AttachmentChips attachments={attachments} onRemove={removeAttachment} />

      <Group align="flex-end" gap="xs" wrap="nowrap">
        {podeAnexar && (
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
