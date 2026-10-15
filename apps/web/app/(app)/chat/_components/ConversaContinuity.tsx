'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loader, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useWhatsappClient } from '@/lib/whatsapp/client';
import { getDraft, preserveAliasedDraft } from '@/lib/chat/draft';
import { WHATSAPP_VINCULOS_QUERY } from '../_hooks/useWhatsappVinculos';

export function ConversaAliasRedirect({ conversaId }: { conversaId: string }) {
  const client = useWhatsappClient();
  const router = useRouter();
  const params = useSearchParams();
  const messageId = params.get('msg') ?? undefined;
  const query = useQuery({
    queryKey: ['whatsapp-conversa-alias', conversaId, messageId ?? null],
    queryFn: () => client!.conversaAlias(conversaId, messageId),
    enabled: client !== null,
    retry: false,
  });
  useEffect(() => {
    const alias = query.data;
    if (!alias?.conversaId || alias.conversaId === conversaId) return;
    const next = new URLSearchParams(params.toString());
    if (messageId && alias.mensagemId) next.set('msg', alias.mensagemId);
    if (preserveAliasedDraft(conversaId, alias.conversaId) === 'conflict')
      next.set('rascunhoOrigem', conversaId);
    router.replace(
      `/chat/${encodeURIComponent(alias.conversaId)}${next.size > 0 ? `?${next.toString()}` : ''}`,
    );
  }, [query.data, conversaId, messageId, params, router]);
  if (query.isLoading || (query.data?.conversaId && query.data.conversaId !== conversaId))
    return (
      <Alert color="blue" m="md">
        <Loader size="xs" /> Localizando a conversa…
      </Alert>
    );
  return (
    <Alert color={query.error ? 'red' : 'yellow'} m="md">
      {query.error?.message ?? 'Conversa não encontrada.'}
    </Alert>
  );
}

/** Recover retained inbound messages and local drafts without overwriting either. */
export function ConversaContinuity() {
  const params = useSearchParams();
  const pendingId = params.get('vinculoWhatsapp');
  const draftSource = params.get('rascunhoOrigem');
  const draft = draftSource ? getDraft(draftSource) : '';
  const client = useWhatsappClient();
  const query = useQuery({
    queryKey: [...WHATSAPP_VINCULOS_QUERY, 'replay', pendingId],
    queryFn: () => client!.vinculo(pendingId!),
    enabled: client !== null && pendingId !== null,
    refetchInterval: (q) => (q.state.data?.pendencia.estado === 'resolvido' ? false : 5000),
  });
  const pending = query.data?.pendencia;
  return (
    <Stack gap="xs">
      {pendingId && (query.isLoading || pending?.estado === 'recuperando') && (
        <Alert color="blue">
          Recuperando mensagens recebidas… O histórico aparecerá nesta conversa.
        </Alert>
      )}
      {query.error && (
        <Alert color="red">Não foi possível consultar a recuperação: {query.error.message}</Alert>
      )}
      {pending?.estado === 'erro' && (
        <Alert color="red">
          A recuperação encontrou um erro. O vínculo e as mensagens foram preservados.
        </Alert>
      )}
      {draft && (
        <Alert color="yellow" title="Outro rascunho foi preservado">
          Esta conversa já tinha um rascunho diferente. O texto da conversa anterior continua
          disponível abaixo.
          <Textarea
            label="Rascunho da conversa anterior"
            value={draft}
            readOnly
            autosize
            maxRows={6}
            mt="xs"
          />
          <Button
            variant="subtle"
            onClick={() => {
              if (!navigator.clipboard) return;
              void navigator.clipboard.writeText(draft).then(
                () => notifications.show({ message: 'Rascunho copiado' }),
                () =>
                  notifications.show({
                    message: 'Selecione o texto e copie manualmente.',
                    color: 'yellow',
                  }),
              );
            }}
          >
            Copiar rascunho anterior
          </Button>
        </Alert>
      )}
    </Stack>
  );
}
