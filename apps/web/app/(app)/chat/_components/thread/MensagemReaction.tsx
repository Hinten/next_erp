'use client';

import { Group, Text } from '@mantine/core';
import type { Mensagem } from '@delfrance/schemas';
import { MensagemQuote } from './MensagemQuote';

/**
 * Reaction bubble (`reaction.emoji` + optional `reaction.mensagemOuterRef`) —
 * legacy `ReactionWidget` (`mensagem.dart:265-267`): "<emoji> reagiu" with the
 * reacted-to message embedded as a mini-quote when the reference resolved.
 */
export function MensagemReaction({
  reaction,
  onNavigate,
}: {
  reaction: NonNullable<Mensagem['reaction']>;
  onNavigate?: (id: string) => void;
}) {
  return (
    <div>
      {reaction.mensagemOuterRef && (
        <MensagemQuote refPath={reaction.mensagemOuterRef} onNavigate={onNavigate} />
      )}
      <Group gap={6} wrap="nowrap" align="center">
        <Text size="lg" component="span" aria-hidden>
          {reaction.emoji}
        </Text>
        <Text size="sm" c="dimmed">
          reagiu
        </Text>
      </Group>
      {reaction.observacao && reaction.observacao.trim() !== '' && (
        <Text size="xs" c="dimmed" fs="italic">
          {reaction.observacao}
        </Text>
      )}
    </div>
  );
}
