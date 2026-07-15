'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Group,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { setDoc } from 'firebase/firestore';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  ESTADO_ENVIO,
  ESTADO_ENVIO_LABELS,
  type EstadoEnvioMensagem,
  type Mensagem,
} from '@delfrance/schemas';
import { mensagemCollection } from '@/lib/data/conversaCollection';
import { newDocId } from '@/lib/data/newDocId';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

const PAGE_SIZE = 200;

interface OptimisticMensagem extends Mensagem {
  _optimistic: true;
  /**
   * The Firestore doc id pre-minted for this send (see `handleSend`) — NOT a
   * throwaway local token. The write uses this exact id, so the optimistic
   * entry and its eventual server snapshot share one identity and can be
   * reconciled/keyed by doc id. `mid` stays `null`: the #529 outbound sender
   * contract requires `mid == null` on a fresh operator reply so its
   * `sendOutbound` trigger picks the message up (see
   * apps/whatsapp/lib/whatsapp/outbound.ts header).
   */
  _docId: string;
}

interface ServerMensagem extends Mensagem {
  _id: string;
}

type AnyMensagem = OptimisticMensagem | ServerMensagem;

/**
 * Real-time thread for one conversa. New messages stream in via
 * onSnapshot; outgoing messages render immediately (optimistic UI),
 * then are reconciled by the pre-minted Firestore doc id once the
 * server snapshot picks up the write (see `handleSend`).
 */
export function MensagemThread({ conversaId }: { conversaId: string }) {
  const { user } = useAuth();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<OptimisticMensagem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const q = useMemo(() => {
    const base = mensagemCollection.ref(getFirebaseFirestore(), { conversaId });
    return buildQuery(base, [orderByField('timestamp', 'desc'), limit(PAGE_SIZE)]);
  }, [conversaId]);

  const { data, loading, error } = useSnapshot<Mensagem>(q);

  const messages: AnyMensagem[] = useMemo(() => {
    const server: ServerMensagem[] = (data ?? [])
      .map(({ id, data: m }) => ({ ...m, _id: id }))
      // we ordered desc to limit server-side; reverse for chronological view.
      .reverse();
    // Drop optimistic entries whose pre-minted doc id now appears in server
    // data (the write lands under that exact id — see `handleSend`).
    const seenIds = new Set(server.map((m) => m._id));
    const pending = optimistic.filter((m) => !seenIds.has(m._docId));
    return [...server, ...pending];
  }, [data, optimistic]);

  // PRUNE reconciled optimistic entries from state once the server snapshot
  // includes their pre-minted doc id. The memo above only HIDES a lingering
  // optimistic copy while its server row is in the 200-doc window; without this
  // prune the ghost RESURRECTS out-of-order the moment that row ages out. An
  // effect (not setState-in-render) watching `data` is the idiomatic sync point;
  // the length guard keeps the reference stable when nothing was pruned (no loop),
  // so this is a one-shot converge, not a cascade.
  useEffect(() => {
    if (!data) return;
    const seenIds = new Set(data.map((d) => d.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing optimistic state to the Firestore snapshot; guarded, converges
    setOptimistic((prev) => {
      const next = prev.filter((m) => !seenIds.has(m._docId));
      return next.length === prev.length ? prev : next;
    });
  }, [data]);

  // Scroll to the bottom whenever the message list grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSendError(null);
    const db = getFirebaseFirestore();
    // Pre-mint the doc id so the optimistic entry and the eventual write
    // share one identity (reconciled by doc id above), and so the write can
    // go through `setDoc` with `mid: null` — the #529 outbound sender
    // (apps/whatsapp/lib/whatsapp/outbound.ts) only picks up a freshly
    // created mensagem whose `mid` is `null`; a client-only placeholder
    // value there would make the trigger skip every manual reply.
    const docId = newDocId();
    const now = new Date().toISOString();
    const pending: OptimisticMensagem = {
      _optimistic: true,
      _docId: docId,
      mid: null,
      conteudo: text,
      tipo: 'c',
      canal: 0,
      estadoEnvio: ESTADO_ENVIO.enviando,
      user_id: user?.uid ?? null,
      timestamp: now,
      resposta: null,
      usarioMensagemOuterRef: null,
      urlAvatar: null,
      midGroup: null,
      error: null,
      visualizado: null,
      transcription: null,
      anexo: null,
      anexo_url: null,
    };
    setOptimistic((prev) => [...prev, pending]);
    setDraft('');
    setSending(true);
    try {
      await setDoc(mensagemCollection.docRef(db, { conversaId }, docId), {
        mid: null,
        conteudo: text,
        tipo: 'c',
        canal: 0,
        estadoEnvio: ESTADO_ENVIO.salva,
        user_id: user?.uid ?? null,
        timestamp: now,
        resposta: null,
        usarioMensagemOuterRef: null,
        urlAvatar: null,
        midGroup: null,
        error: null,
        visualizado: null,
        transcription: null,
        anexo: null,
        anexo_url: null,
      });
      // Server snapshot will include this doc id on the next tick; the
      // memoized merge above drops the optimistic copy automatically.
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSendError(err.message);
        setOptimistic((prev) =>
          prev.map((m) => (m._docId === docId ? { ...m, estadoEnvio: ESTADO_ENVIO.erro } : m)),
        );
      } else {
        throw err;
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Stack h="100%" gap={0}>
      {error && <Alert color="red">{error.message}</Alert>}
      <ScrollArea viewportRef={scrollRef} style={{ flex: 1, minHeight: 0 }} offsetScrollbars>
        <Stack p="md" gap="sm">
          {loading && (
            <Stack>
              <Skeleton height={48} />
              <Skeleton height={48} />
              <Skeleton height={48} />
            </Stack>
          )}
          {!loading && messages.length === 0 && (
            <Text c="dimmed" ta="center" py="xl">
              Sem mensagens nesta conversa.
            </Text>
          )}
          {messages.map((m) => (
            <MensagemBubble
              key={'_id' in m ? (m as ServerMensagem)._id : (m as OptimisticMensagem)._docId}
              mensagem={m}
              isLocal={'_optimistic' in m}
            />
          ))}
        </Stack>
      </ScrollArea>

      {sendError && (
        <Alert color="red" m="md">
          {sendError}
        </Alert>
      )}

      <Box p="sm" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
        <Group align="flex-end" gap="xs">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Digite uma mensagem (⌘/Ctrl + Enter envia)…"
            autosize
            minRows={1}
            maxRows={6}
            style={{ flex: 1 }}
            disabled={sending}
          />
          <Tooltip label="Enviar (⌘/Ctrl + Enter)">
            <ActionIcon
              size="lg"
              variant="filled"
              color="blue"
              disabled={sending || draft.trim().length === 0}
              onClick={handleSend}
              aria-label="Enviar"
            >
              ➤
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>
    </Stack>
  );
}

function MensagemBubble({ mensagem, isLocal }: { mensagem: AnyMensagem; isLocal: boolean }) {
  const { user } = useAuth();
  const isOwn = isLocal || (mensagem.user_id && mensagem.user_id === user?.uid);
  return (
    <Group justify={isOwn ? 'flex-end' : 'flex-start'} align="flex-end">
      <Box
        p="xs"
        style={(theme) => ({
          maxWidth: 480,
          background: isOwn ? theme.colors.blue[0] : theme.colors.gray[1],
          border: `1px solid ${isOwn ? theme.colors.blue[2] : theme.colors.gray[3]}`,
          borderRadius: theme.radius.md,
        })}
      >
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {mensagem.conteudo ?? '(sem conteúdo)'}
        </Text>
        <Group gap={4} mt={4} justify="flex-end">
          {mensagem.timestamp && (
            <Text size="xs" c="dimmed">
              {new Date(mensagem.timestamp).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
          )}
          {isOwn && (
            <Badge
              size="xs"
              variant="light"
              color={
                mensagem.estadoEnvio === ESTADO_ENVIO.erro
                  ? 'red'
                  : mensagem.estadoEnvio === ESTADO_ENVIO.enviado ||
                      mensagem.estadoEnvio === ESTADO_ENVIO.recebido
                    ? 'green'
                    : 'gray'
              }
            >
              {ESTADO_ENVIO_LABELS[mensagem.estadoEnvio as EstadoEnvioMensagem]}
            </Badge>
          )}
        </Group>
      </Box>
    </Group>
  );
}
