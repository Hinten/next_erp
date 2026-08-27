'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconArrowDown, IconHistory, IconSearch } from '@tabler/icons-react';
import { ORIGEM_RULES, idFromRef, type Conversa } from '@delfrance/schemas';
import { useAuth } from '@/lib/auth';
import { mensagemKey, useMensagensWindow, type TargetSpec } from '../_hooks/useMensagensWindow';
import { useThreadSearch } from '../_hooks/useThreadSearch';
import { MensagemBubble } from './thread/MensagemBubble';
import { ChatComposer } from './composer/ChatComposer';
import { ThreadSearchBar } from './search/ThreadSearchBar';

/** Distance (px) from the bottom under which we consider the view "stuck". */
const BOTTOM_THRESHOLD = 80;

/** jsdom-safe `scrollIntoView` (not implemented in the test DOM). */
function scrollIntoView(el: HTMLElement | undefined) {
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/**
 * Real-time thread for one conversa. New messages stream in via a live window
 * (`useMensagensWindow` — orderBy timestamp desc, limit 60); outgoing messages
 * render optimistically then reconcile by the pre-minted doc id (#529). Below
 * the messages sits either the composer or the in-thread search bar (toggled
 * from the header search icon). Rendered with `key={conversaId}` by the page so
 * switching conversa resets the window's paged/optimistic state.
 */
export function MensagemThread({
  conversaId,
  conversa,
}: {
  conversaId: string;
  conversa: Conversa;
}) {
  const { user } = useAuth();

  // Deep-link TARGET (from a global-search match): `?msg=<id>&ts=<epoch>` centres
  // the thread on that message in a one-shot window (no live listener). Parsed
  // here so the window hook can suspend the live query and load around it.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const targetMsgId = searchParams.get('msg');
  const targetTsRaw = searchParams.get('ts');
  const target = useMemo<TargetSpec | null>(() => {
    if (!targetMsgId) return null;
    const ts = targetTsRaw != null ? Number(targetTsRaw) : NaN;
    return Number.isFinite(ts) ? { msgId: targetMsgId, ts } : null;
  }, [targetMsgId, targetTsRaw]);

  const {
    messages,
    loading,
    error,
    exhausted,
    loadingOlder,
    olderError,
    loadOlder,
    addOptimistic,
    markOptimisticError,
    targetMode,
    targetMissing,
  } = useMensagensWindow(conversaId, target);

  const [searchMode, setSearchMode] = useState(false);
  const [term, setTerm] = useState('');
  const search = useThreadSearch(searchMode ? term : '', messages);

  // Clear the deep-link target from the URL → the hook restores the live window.
  const voltarAoPresente = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('msg');
    next.delete('ts');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);

  const customerUid = conversa.usarioOuterRef ? idFromRef(conversa.usarioOuterRef) : null;
  const isHtml = ORIGEM_RULES[conversa.origem].isHtml;

  const viewportRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showFab, setShowFab] = useState(false);

  // Bubble DOM nodes by message key — for scroll-into-view (search + quotes).
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  const registerRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) bubbleRefs.current.set(key, el);
    else bubbleRefs.current.delete(key);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const v = viewportRef.current;
    if (v && typeof v.scrollTo === 'function') v.scrollTo({ top: v.scrollHeight, behavior });
    else if (v) v.scrollTop = v.scrollHeight;
  }, []);

  // Scroll bookkeeping: prepend anchor (maintain position on load-older),
  // initial stick-to-bottom, and stick-to-bottom on a new newest message.
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const initializedRef = useRef(false);
  const lastKeyRef = useRef<string | null>(null);

  const newestKey = messages.length ? mensagemKey(messages[messages.length - 1]!) : null;

  useLayoutEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    if (prependAnchor.current) {
      // Older page prepended → keep the same rows in view (no jump).
      const delta = v.scrollHeight - prependAnchor.current.height;
      v.scrollTop = prependAnchor.current.top + delta;
      prependAnchor.current = null;
      lastKeyRef.current = newestKey;
      return;
    }
    if (!initializedRef.current && messages.length > 0) {
      // Target mode positions on the deep-linked message (below), NOT the bottom.
      if (!(targetMode && target)) v.scrollTop = v.scrollHeight;
      initializedRef.current = true;
      lastKeyRef.current = newestKey;
      return;
    }
    if (newestKey !== lastKeyRef.current) {
      lastKeyRef.current = newestKey;
      if (atBottomRef.current) v.scrollTop = v.scrollHeight;
    }
  }, [messages, newestKey, targetMode, target]);

  // Scroll the active search hit into view as navigation moves.
  useEffect(() => {
    if (!searchMode || !search.currentId) return;
    scrollIntoView(bubbleRefs.current.get(search.currentId));
  }, [searchMode, search.currentId]);

  // Scroll the deep-link target into view ONCE its bubble has rendered.
  const scrolledTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetMode || !target) return;
    if (scrolledTargetRef.current === target.msgId) return;
    const el = bubbleRefs.current.get(target.msgId);
    if (el) {
      scrolledTargetRef.current = target.msgId;
      scrollIntoView(el);
    }
  }, [targetMode, target, messages]);

  // Leaving target mode ("Voltar ao presente") → let the restored live window
  // re-anchor at the bottom instead of holding the historical scroll position.
  const prevTargetModeRef = useRef(targetMode);
  useEffect(() => {
    if (prevTargetModeRef.current && !targetMode) {
      initializedRef.current = false;
      scrolledTargetRef.current = null;
    }
    prevTargetModeRef.current = targetMode;
  }, [targetMode]);

  const navigateTo = useCallback((id: string) => {
    scrollIntoView(bubbleRefs.current.get(id));
  }, []);

  function onScrollPositionChange() {
    const v = viewportRef.current;
    if (!v) return;
    const dist = v.scrollHeight - v.scrollTop - v.clientHeight;
    const bottom = dist < BOTTOM_THRESHOLD;
    atBottomRef.current = bottom;
    setShowFab(!bottom);
    // Auto-load an older page when the operator scrolls to the very top. The
    // ref guard is SYNCHRONOUS: `loadingOlder` is async React state, so rapid
    // scroll events in one frame would otherwise all pass the check and fire
    // overlapping page loads (Copilot, PR #584).
    if (v.scrollTop < 24 && !exhausted && !loadingOlderRef.current) void handleLoadOlder();
  }

  const loadingOlderRef = useRef(false);
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    try {
      const v = viewportRef.current;
      if (v) prependAnchor.current = { height: v.scrollHeight, top: v.scrollTop };
      await loadOlder();
    } finally {
      loadingOlderRef.current = false;
    }
  }, [loadOlder]);

  const closeSearch = useCallback(() => {
    setSearchMode(false);
    setTerm('');
  }, []);

  // The "active" (outlined) bubbles: the in-thread search's current hit AND the
  // deep-link target both reuse the search-active outline.
  const currentId = searchMode ? search.currentId : null;
  const activeSet = useMemo(() => {
    const s = new Set<string>();
    if (currentId) s.add(currentId);
    if (targetMode && target) s.add(target.msgId);
    return s;
  }, [currentId, targetMode, target]);

  return (
    <Stack h="100%" gap={0}>
      <Group
        justify="flex-end"
        px="sm"
        py={4}
        style={{ borderBottom: '1px solid var(--mantine-color-gray-1)' }}
      >
        <Tooltip label={searchMode ? 'Fechar busca' : 'Buscar na conversa'}>
          <ActionIcon
            variant={searchMode ? 'filled' : 'subtle'}
            color={searchMode ? 'blue' : 'gray'}
            onClick={() => (searchMode ? closeSearch() : setSearchMode(true))}
            aria-label="Buscar na conversa"
          >
            <IconSearch size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {error && (
        <Alert color="red" m="sm">
          {error.message}
        </Alert>
      )}

      {targetMissing && (
        <Alert color="yellow" variant="light" m="sm" py={6}>
          <Text size="xs">
            A mensagem buscada não foi encontrada (pode ter sido excluída). Exibindo as mensagens
            recentes.
          </Text>
        </Alert>
      )}

      <Box style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <ScrollArea
          viewportRef={viewportRef}
          h="100%"
          onScrollPositionChange={onScrollPositionChange}
          offsetScrollbars
        >
          <Stack p="md" gap="sm">
            {loading && (
              <Stack>
                <Skeleton height={48} />
                <Skeleton height={48} />
                <Skeleton height={48} />
              </Stack>
            )}

            {!loading && (
              <Box ta="center">
                {olderError ? (
                  <Alert color="red" variant="light" py={6} ta="left">
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                      <Text size="xs">Falha ao carregar mensagens anteriores.</Text>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        loading={loadingOlder}
                        onClick={handleLoadOlder}
                      >
                        Tentar novamente
                      </Button>
                    </Group>
                  </Alert>
                ) : exhausted ? (
                  messages.length > 0 && (
                    <Text size="xs" c="dimmed" py={4}>
                      Não existem mais mensagens
                    </Text>
                  )
                ) : (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    loading={loadingOlder}
                    onClick={handleLoadOlder}
                  >
                    Carregar mensagens anteriores
                  </Button>
                )}
              </Box>
            )}

            {!loading && messages.length === 0 && (
              <Text c="dimmed" ta="center" py="xl">
                Sem mensagens nesta conversa.
              </Text>
            )}

            {messages.map((m) => {
              const key = mensagemKey(m);
              return (
                <MensagemBubble
                  key={key}
                  mensagem={m}
                  myUid={user?.uid}
                  customerUid={customerUid}
                  origem={conversa.origem}
                  isHtml={isHtml}
                  searchRegex={searchMode ? search.regex : null}
                  searchActive={activeSet.has(key)}
                  onNavigate={navigateTo}
                  registerRef={registerRef}
                />
              );
            })}
          </Stack>
        </ScrollArea>

        {targetMode && (
          <Button
            variant="filled"
            color="blue"
            radius="xl"
            size="compact-sm"
            leftSection={<IconHistory size={16} />}
            onClick={voltarAoPresente}
            style={{
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)',
              top: 12,
              boxShadow: 'var(--mantine-shadow-md)',
            }}
          >
            Voltar ao presente
          </Button>
        )}

        {showFab && (
          <ActionIcon
            variant="filled"
            color="blue"
            radius="xl"
            size="lg"
            onClick={() => scrollToBottom()}
            aria-label="Ir para o fim"
            style={{
              position: 'absolute',
              right: 16,
              bottom: 12,
              boxShadow: 'var(--mantine-shadow-md)',
            }}
          >
            <IconArrowDown size={18} />
          </ActionIcon>
        )}
      </Box>

      {searchMode ? (
        <ThreadSearchBar
          term={term}
          onTermChange={setTerm}
          search={search}
          onClose={closeSearch}
          onLoadOlder={handleLoadOlder}
          loadingOlder={loadingOlder}
          exhausted={exhausted}
        />
      ) : (
        <ChatComposer
          conversaId={conversaId}
          conversa={conversa}
          addOptimistic={addOptimistic}
          markOptimisticError={markOptimisticError}
        />
      )}
    </Stack>
  );
}
