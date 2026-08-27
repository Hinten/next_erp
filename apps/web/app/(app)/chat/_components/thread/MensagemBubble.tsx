'use client';

import { useCallback } from 'react';
import {
  ActionIcon,
  Box,
  Group,
  Menu,
  Stack,
  Text,
  Tooltip,
  type MantineTheme,
} from '@mantine/core';
import { useHover } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconArrowForward, IconCopy, IconDots, IconFileText } from '@tabler/icons-react';
import type { Mensagem } from '@delfrance/schemas';
import { ESTADO_ENVIO, TIPO_MENSAGEM, ehEstadoDeSaida } from '@delfrance/schemas';
import { formatMensagemTime } from '@/lib/chat/mensagemTime';
import { HighlightedText } from '@/lib/chat/highlight';
import { type AnyMensagem, isOptimistic, mensagemKey } from '../../_hooks/useMensagensWindow';
import { useAutorNome } from '../../_hooks/useAutorNome';
import { MensagemContent } from './MensagemContent';
import { MensagemMedia, hasMedia } from './MensagemMedia';
import { MensagemQuote } from './MensagemQuote';
import { MensagemReaction } from './MensagemReaction';
import { MensagemStatusIcon } from './MensagemStatusIcon';
import { ReferralCard } from './ReferralCard';

export interface MensagemBubbleProps {
  mensagem: AnyMensagem;
  myUid: string | null | undefined;
  /** The conversa's customer usuario id (from `usarioOuterRef`), for alignment. */
  customerUid: string | null;
  /** Whether this origem renders HTML bodies (ORIGEM_RULES[origem].isHtml). */
  isHtml: boolean;
  searchRegex: RegExp | null;
  /** True when this bubble is the active search hit. */
  searchActive: boolean;
  onNavigate?: (id: string) => void;
  /** Register the bubble's DOM node by key for scroll-into-view. */
  registerRef: (key: string, el: HTMLDivElement | null) => void;
}

function copyToClipboard(text: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text).then(
    () => notifications.show({ message: 'Mensagem copiada', color: 'gray' }),
    () => notifications.show({ message: 'Não foi possível copiar', color: 'red' }),
  );
}

export function MensagemBubble(props: MensagemBubbleProps) {
  const {
    mensagem,
    myUid,
    customerUid,
    isHtml,
    searchRegex,
    searchActive,
    onNavigate,
    registerRef,
  } = props;
  const key = mensagemKey(mensagem);
  const rootRef = useCallback(
    (el: HTMLDivElement | null) => registerRef(key, el),
    [key, registerRef],
  );
  const time = formatMensagemTime(mensagem.data_cadastro ?? mensagem.timestamp);

  // Event (tipo 'e') → centered dimmed line; error (tipo '!') → centered red line.
  if (mensagem.tipo === TIPO_MENSAGEM.evento) {
    return (
      <Box ref={rootRef} ta="center" py={4}>
        <Text size="xs" c="dimmed">
          <HighlightedText
            text={mensagem.conteudo ?? ''}
            regex={searchRegex}
            active={searchActive}
          />
          {time && ` · ${time}`}
        </Text>
      </Box>
    );
  }
  if (mensagem.tipo === TIPO_MENSAGEM.erro) {
    return (
      <Box ref={rootRef} ta="center" py={4}>
        <Text size="xs" c="red">
          <HighlightedText
            text={mensagem.conteudo ?? 'Erro'}
            regex={searchRegex}
            active={searchActive}
          />
          {time && ` · ${time}`}
        </Text>
      </Box>
    );
  }

  // ⚠️ An author, when there is one, decides the side — it names WHICH operator,
  // which a send state cannot. But every message the marketplace importers write
  // is AUTHORLESS (identity is a `cliente` now, so nothing stamps `user_id`,
  // #768), and for those the side is the send state. Without that second arm
  // `mine` was unreachable for them: every ML reply we sent rendered on the
  // customer's side, grey and with no tick, indistinguishable from the buyer's.
  const semAutor = !mensagem.user_id;
  const mine =
    isOptimistic(mensagem) ||
    (!semAutor && mensagem.user_id === myUid) ||
    (semAutor && ehEstadoDeSaida(mensagem.estadoEnvio));
  const isCustomer =
    !mine &&
    (mensagem.estadoEnvio === ESTADO_ENVIO.recebido ||
      (!!customerUid && mensagem.user_id === customerUid));
  const isOtherAgent = !mine && !isCustomer && !!mensagem.user_id;

  return (
    <Group
      ref={rootRef}
      // The side is a CSS custom property once Mantine renders it, so nothing
      // could assert alignment — which is why this bug had no failing test.
      data-side={mine ? 'saida' : 'entrada'}
      justify={mine ? 'flex-end' : 'flex-start'}
      align="flex-end"
      gap={4}
    >
      <BubbleBody
        mensagem={mensagem}
        variant={mine ? 'mine' : isCustomer ? 'customer' : isOtherAgent ? 'agent' : 'customer'}
        showAuthor={isOtherAgent}
        isHtml={isHtml}
        searchRegex={searchRegex}
        searchActive={searchActive}
        onNavigate={onNavigate}
        time={time}
        showStatus={mine}
      />
    </Group>
  );
}

type Variant = 'mine' | 'customer' | 'agent';

function bubbleColors(variant: Variant) {
  return (theme: MantineTheme) => {
    const [bg, border] =
      variant === 'mine'
        ? [theme.colors.blue[0], theme.colors.blue[2]]
        : variant === 'agent'
          ? [theme.colors.violet[0], theme.colors.violet[2]]
          : [theme.colors.gray[1], theme.colors.gray[3]];
    return {
      maxWidth: 480,
      background: bg,
      border: `1px solid ${border}`,
      borderRadius: theme.radius.md,
    };
  };
}

function BubbleBody({
  mensagem,
  variant,
  showAuthor,
  isHtml,
  searchRegex,
  searchActive,
  onNavigate,
  time,
  showStatus,
}: {
  mensagem: Mensagem;
  variant: Variant;
  showAuthor: boolean;
  isHtml: boolean;
  searchRegex: RegExp | null;
  searchActive: boolean;
  onNavigate?: (id: string) => void;
  time: string;
  showStatus: boolean;
}) {
  const { hovered, ref } = useHover<HTMLDivElement>();
  const autor = useAutorNome(showAuthor ? mensagem.user_id : null);
  const forwarded = mensagem.context?.forwarded || mensagem.context?.frequently_forwarded;
  const media = hasMedia(mensagem);
  const hasText = typeof mensagem.conteudo === 'string' && mensagem.conteudo.trim() !== '';

  return (
    <Box ref={ref} p="xs" style={bubbleColors(variant)} pos="relative">
      {searchActive && (
        <Box
          pos="absolute"
          style={{
            inset: -2,
            borderRadius: 10,
            outline: '2px solid var(--mantine-color-orange-5)',
          }}
        />
      )}
      <Stack gap={2}>
        {showAuthor && (
          <Text size="xs" fw={600} c="violet">
            {autor}
          </Text>
        )}

        {forwarded && (
          <Group gap={2} c="dimmed">
            <IconArrowForward size={12} />
            <Text size="xs" fs="italic">
              {mensagem.context?.frequently_forwarded
                ? 'Encaminhada com frequência'
                : 'Encaminhada'}
            </Text>
          </Group>
        )}

        {mensagem.referral && <ReferralCard referral={mensagem.referral} />}

        {mensagem.context?.mensagemOuterRef && (
          <MensagemQuote refPath={mensagem.context.mensagemOuterRef} onNavigate={onNavigate} />
        )}

        {mensagem.reaction ? (
          <MensagemReaction reaction={mensagem.reaction} onNavigate={onNavigate} />
        ) : (
          <>
            {media && (
              <MensagemMedia
                mensagem={mensagem}
                searchRegex={searchRegex}
                searchActive={searchActive}
              />
            )}
            {/* The caption for media rides in the media component; render the text
                body only when there is no media OR the body differs from a caption. */}
            {hasText && !media && (
              <MensagemContent
                conteudo={mensagem.conteudo as string}
                isHtml={isHtml}
                regex={searchRegex}
                active={searchActive}
              />
            )}
          </>
        )}

        <Group gap={4} mt={2} justify="flex-end" wrap="nowrap" align="center">
          {mensagem.transcription && mensagem.transcription.trim() !== '' && (
            <Tooltip label={mensagem.transcription} withArrow multiline w={260}>
              <IconFileText
                size={13}
                color="var(--mantine-color-dimmed)"
                aria-label="Transcrição"
              />
            </Tooltip>
          )}
          {time && (
            <Text size="xs" c="dimmed">
              {time}
            </Text>
          )}
          {showStatus && <MensagemStatusIcon mensagem={mensagem} />}
        </Group>
      </Stack>

      {hasText && (
        <Box pos="absolute" style={{ top: 2, right: 2, opacity: hovered ? 1 : 0 }}>
          <Menu withinPortal position="bottom-end" shadow="sm">
            <Menu.Target>
              <ActionIcon variant="subtle" size="xs" color="gray" aria-label="Opções da mensagem">
                <IconDots size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconCopy size={14} />}
                onClick={() => copyToClipboard(mensagem.conteudo as string)}
              >
                Copiar
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Box>
      )}
    </Box>
  );
}
