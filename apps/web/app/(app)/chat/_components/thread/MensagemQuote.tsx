'use client';

import { Box, Skeleton, Text } from '@mantine/core';
import { lastMensagemPreview } from '@/lib/chat/preview';
import { useMensagemRef } from '../../_hooks/useMensagemRef';
import { useAutorNome } from '../../_hooks/useAutorNome';

/**
 * Embedded quote mini-bubble for a replied-to message
 * (`context.mensagemOuterRef`, legacy `MensagemContextWidget`,
 * `mensagem.dart:248-250`). One cached one-shot fetch of the referenced
 * mensagem → author name + a truncated preview (media becomes a placeholder via
 * `lastMensagemPreview`). Click scrolls to the message when it's in the loaded
 * window (`onNavigate`).
 */
export function MensagemQuote({
  refPath,
  onNavigate,
}: {
  refPath: string;
  onNavigate?: (id: string) => void;
}) {
  const { referenced, loading } = useMensagemRef(refPath);
  const autor = useAutorNome(referenced?.mensagem.user_id);

  if (loading) return <Skeleton height={34} radius="sm" />;
  if (!referenced) {
    return (
      <QuoteFrame onClick={undefined}>
        <Text size="xs" c="dimmed" fs="italic">
          Mensagem citada indisponível
        </Text>
      </QuoteFrame>
    );
  }

  const preview = lastMensagemPreview(referenced.mensagem, {});

  return (
    <QuoteFrame onClick={onNavigate ? () => onNavigate(referenced.id) : undefined}>
      <Text size="xs" fw={600} lineClamp={1}>
        {autor}
      </Text>
      <Text size="xs" c="dimmed" lineClamp={2}>
        {preview}
      </Text>
    </QuoteFrame>
  );
}

function QuoteFrame({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <Box
      onClick={onClick}
      style={{
        borderLeft: '3px solid var(--mantine-color-blue-4)',
        background: 'var(--mantine-color-gray-0)',
        borderRadius: 4,
        padding: '4px 8px',
        marginBottom: 4,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {children}
    </Box>
  );
}
