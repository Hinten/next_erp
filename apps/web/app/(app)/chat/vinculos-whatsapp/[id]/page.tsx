'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { idFromRef } from '@delfrance/schemas';
import { formatTelefoneInternacional } from '@delfrance/core/phone';
import { usePermission } from '@/lib/auth';
import { ClientePicker } from '@/components/pickers/ClientePicker';
import { ClienteQuickCreateForm } from '@/components/pickers/ClienteQuickCreateModal';
import { isHttpUrl } from '@/lib/chat/safeUrl';
import { stashEnderecoForCliente } from '@/lib/clientes/pendingEndereco';
import { newDocId } from '@/lib/data/newDocId';
import {
  useWhatsappClient,
  WhatsappClientHttpError,
  WhatsappClientNetworkError,
  type WhatsappVinculoChoice,
} from '@/lib/whatsapp/client';
import { WHATSAPP_VINCULOS_QUERY } from '../../_hooks/useWhatsappVinculos';
import { motivoVinculo, estadoVinculo } from '../motivoVinculo';

function VinculoConflictActions({
  error,
  onSelect,
  disabled,
}: {
  error: unknown;
  onSelect: (clienteId: string) => void;
  disabled: boolean;
}) {
  if (!(error instanceof WhatsappClientHttpError) || error.status !== 409 || !error.vinculo)
    return null;
  const { clienteId, conversaId } = error.vinculo;
  return (
    <Group mt="xs">
      {clienteId && (
        <Button variant="light" disabled={disabled} onClick={() => onSelect(clienteId)}>
          Selecionar cliente já vinculado
        </Button>
      )}
      {conversaId && (
        <Anchor
          component={Link}
          href={`/chat/${encodeURIComponent(conversaId)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Abrir conversa já vinculada
        </Anchor>
      )}
    </Group>
  );
}

export default function WhatsappVinculoPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const client = useWhatsappClient();
  const queryClient = useQueryClient();
  const read = usePermission(PERM.chat.read | PERM.cliente.read);
  const write = usePermission(PERM.chat.write | PERM.cliente.read);
  const create = usePermission(PERM.cliente.write);
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  const [selected, setSelected] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<
    WhatsappClientHttpError | WhatsappClientNetworkError | null
  >(null);
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const query = useInfiniteQuery({
    queryKey: [...WHATSAPP_VINCULOS_QUERY, 'detail', id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => client!.vinculo(id, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: read.allowed && client !== null,
    refetchInterval: 10_000,
  });
  const detail = query.data?.pages[0];
  const pending = detail?.pendencia;
  const selectedId = typeof selected === 'string' ? idFromRef(selected) : null;
  const preview = useQuery({
    queryKey: [...WHATSAPP_VINCULOS_QUERY, 'preview', id, selectedId, pending?.revision],
    queryFn: () => client!.previsaoVinculo(id, selectedId!),
    enabled:
      read.allowed &&
      client !== null &&
      mode === 'existing' &&
      !!selectedId &&
      !!pending &&
      pending.conversaId === null,
    retry: false,
  });
  // A response for an earlier selection must never authorize the current choice.
  const confirmedPreview = preview.data?.cliente.id === selectedId ? preview.data : undefined;
  const canConfirmExisting = !!confirmedPreview && !preview.isFetching && !preview.error;

  function selectLinkedCliente(clienteId: string) {
    setSelected(`documents/clientes/${clienteId}`);
    setSaveError(null);
    if (clienteId === selectedId) void preview.refetch();
  }

  async function resolve(choice: WhatsappVinculoChoice) {
    if (!client || !pending)
      throw new WhatsappClientHttpError(
        'Contato indisponível. Atualize a página.',
        409,
        'WA_VINCULO_INDISPONIVEL',
      );
    const fingerprint = JSON.stringify(choice);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, requestId: newDocId() };
    const result = await client.resolverVinculo(id, {
      requestId: attempt.current.requestId,
      revision: pending.revision,
      choice,
    });
    await queryClient.invalidateQueries({ queryKey: WHATSAPP_VINCULOS_QUERY });
    router.replace(
      `/chat/${encodeURIComponent(result.conversaId)}?vinculoWhatsapp=${encodeURIComponent(id)}`,
    );
    return result;
  }

  async function linkExisting() {
    if (!selectedId || saving || !canConfirmExisting) return;
    setSaving(true);
    setSaveError(null);
    try {
      await resolve({ kind: 'existing', clienteId: selectedId });
    } catch (err) {
      if (err instanceof WhatsappClientHttpError || err instanceof WhatsappClientNetworkError) {
        setSaveError(err);
        if (err instanceof WhatsappClientHttpError && err.status === 409) await query.refetch();
      } else throw err;
    } finally {
      setSaving(false);
    }
  }

  if (read.loading || query.isLoading) return <Loader />;
  if (!read.allowed)
    return <Alert color="yellow">Você não tem permissão para consultar contatos e clientes.</Alert>;
  if (query.error)
    return (
      <Alert color="red">
        {query.error.message}
        <Button variant="subtle" onClick={() => void query.refetch()}>
          Tentar novamente
        </Button>
      </Alert>
    );
  if (!detail || !pending) return <Text>Contato indisponível.</Text>;
  const messages = query.data?.pages.flatMap((page) => page.messages) ?? [];
  const decided = pending.conversaId !== null;

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Vincular contato</Title>
        <Anchor component={Link} href="/chat/vinculos-whatsapp">
          Voltar aos contatos
        </Anchor>
      </Group>
      <Title order={3}>{pending.nome ?? 'Contato sem nome'}</Title>
      <Text>
        {pending.telefone
          ? formatTelefoneInternacional(pending.telefone)
          : 'Telefone não informado'}{' '}
        · {pending.integracaoNome}
      </Text>
      <Badge color={pending.estado === 'erro' ? 'red' : 'blue'} style={{ alignSelf: 'flex-start' }}>
        {estadoVinculo(pending.estado)}
      </Badge>
      <Text>{motivoVinculo(pending.motivo)}</Text>
      {pending.bsuid && (
        <details>
          <summary>Identificação do WhatsApp</summary>
          <Text size="xs">{pending.bsuid}</Text>
        </details>
      )}
      <Group align="flex-start" grow>
        <Stack style={{ minWidth: 280, flex: 1 }}>
          <Title order={4}>Mensagens recebidas</Title>
          {messages.map((message) => (
            <Stack
              key={message.id}
              gap={4}
              p="sm"
              style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8 }}
            >
              {message.conteudo && (
                <Text style={{ whiteSpace: 'pre-wrap' }}>{message.conteudo}</Text>
              )}
              {message.anexoUrl && isHttpUrl(message.anexoUrl) && (
                <Anchor href={message.anexoUrl} target="_blank" rel="noopener noreferrer">
                  Abrir anexo{message.anexoTipo ? ` (${message.anexoTipo})` : ''}
                </Anchor>
              )}
              {!message.anexoUrl && message.anexoTipo && (
                <Text c="dimmed">Anexo em recuperação ({message.anexoTipo})</Text>
              )}
              {message.timestamp !== null && (
                <Text size="xs" c="dimmed">
                  {new Date(message.timestamp).toLocaleString('pt-BR')}
                </Text>
              )}
            </Stack>
          ))}
          {query.hasNextPage && (
            <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Carregar mais mensagens
            </Button>
          )}
        </Stack>
        <Stack style={{ minWidth: 280, flex: 1 }}>
          {decided ? (
            <Alert color={pending.estado === 'erro' ? 'red' : 'blue'} title="Contato vinculado">
              {pending.estado === 'resolvido'
                ? 'Mensagens recuperadas.'
                : pending.estado === 'erro'
                  ? 'A recuperação encontrou um erro. O vínculo e as mensagens foram preservados.'
                  : 'Recuperando mensagens recebidas…'}
              <Button
                component={Link}
                href={`/chat/${pending.conversaId!}?vinculoWhatsapp=${encodeURIComponent(id)}`}
                variant="subtle"
              >
                Abrir conversa
              </Button>
            </Alert>
          ) : (
            <>
              {!write.allowed && (
                <Alert color="yellow">
                  Você pode consultar o contato, mas não tem permissão para vinculá-lo.
                </Alert>
              )}
              <Group>
                <Button
                  variant={mode === 'existing' ? 'filled' : 'light'}
                  disabled={saving}
                  onClick={() => setMode('existing')}
                >
                  Cliente existente
                </Button>
                {write.allowed && create.allowed && (
                  <Button
                    variant={mode === 'create' ? 'filled' : 'light'}
                    disabled={saving}
                    onClick={() => setMode('create')}
                  >
                    Criar cliente e vincular
                  </Button>
                )}
              </Group>
              {mode === 'existing' ? (
                <>
                  {detail.candidates.length > 0 && (
                    <Stack gap="xs">
                      <Text fw={500}>Clientes candidatos</Text>
                      {detail.candidates.map((candidate) => (
                        <Group key={candidate.id} justify="space-between">
                          <Stack gap={0}>
                            <Anchor
                              component={Link}
                              href={`/clientes/${candidate.id}`}
                              target="_blank"
                            >
                              {candidate.nome ?? 'Cliente sem nome'}
                            </Anchor>
                            <Text size="xs">
                              {[
                                candidate.cpf_cnpj,
                                candidate.telefone &&
                                  formatTelefoneInternacional(candidate.telefone),
                                candidate.email,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </Text>
                          </Stack>
                          <Button
                            variant="subtle"
                            disabled={!write.allowed || saving}
                            onClick={() => setSelected(`documents/clientes/${candidate.id}`)}
                          >
                            Selecionar
                          </Button>
                        </Group>
                      ))}
                    </Stack>
                  )}
                  <ClientePicker
                    fieldName="whatsappVinculoCliente"
                    value={selected}
                    onChange={setSelected}
                    allowCreate={false}
                    disabled={!write.allowed || saving}
                    label="Cliente a vincular"
                  />
                  {selectedId && preview.isFetching && (
                    <Text size="sm">Consultando cliente e conversa…</Text>
                  )}
                  {selectedId && preview.error && (
                    <Alert color="red" title="Não foi possível conferir o vínculo">
                      {preview.error.message}
                      <VinculoConflictActions
                        error={preview.error}
                        onSelect={selectLinkedCliente}
                        disabled={saving}
                      />
                      <Button variant="subtle" onClick={() => void preview.refetch()}>
                        Tentar novamente
                      </Button>
                    </Alert>
                  )}
                  {confirmedPreview && !preview.error && !preview.isFetching && (
                    <Alert title="Confira antes de vincular">
                      <Text fw={500}>{confirmedPreview.cliente.nome ?? 'Cliente sem nome'}</Text>
                      <Text size="sm">
                        {[
                          confirmedPreview.cliente.cpf_cnpj,
                          confirmedPreview.cliente.telefone
                            ? formatTelefoneInternacional(confirmedPreview.cliente.telefone)
                            : 'Sem telefone principal',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                      <Text size="sm">
                        Contato WhatsApp: {pending.nome ?? 'Contato sem nome'} ·{' '}
                        {pending.telefone
                          ? formatTelefoneInternacional(pending.telefone)
                          : 'Telefone não informado'}
                        {' · '}
                        {pending.integracaoNome}
                      </Text>
                      {confirmedPreview.conversaId ? (
                        <Anchor
                          component={Link}
                          href={`/chat/${encodeURIComponent(confirmedPreview.conversaId)}`}
                          target="_blank"
                        >
                          Ver conversa que será continuada
                        </Anchor>
                      ) : (
                        <Text size="sm">
                          Será criada uma conversa para este cliente nesta integração.
                        </Text>
                      )}
                      <Text size="sm">O telefone principal do cadastro será mantido.</Text>
                      {confirmedPreview.avisoIdentidade && (
                        <Alert color="yellow" mt="sm">
                          {confirmedPreview.avisoIdentidade}
                        </Alert>
                      )}
                    </Alert>
                  )}
                  {saveError && (
                    <Alert color="red">
                      {saveError.message}
                      <VinculoConflictActions
                        error={saveError}
                        onSelect={selectLinkedCliente}
                        disabled={saving}
                      />
                    </Alert>
                  )}
                  <Button
                    loading={saving}
                    disabled={!write.allowed || !selectedId || !canConfirmExisting}
                    onClick={() => void linkExisting()}
                  >
                    Vincular e abrir conversa
                  </Button>
                </>
              ) : (
                <ClienteQuickCreateForm
                  key={id}
                  initialValues={{
                    nome: pending.nome ?? '',
                    telefone: pending.telefone ? `+${pending.telefone}` : null,
                  }}
                  saveLabel="Criar cliente e vincular"
                  onCancel={() => setMode('existing')}
                  onCreate={async (cliente) => {
                    const result = await resolve({ kind: 'create', cliente });
                    return { id: result.clienteId };
                  }}
                  onResolved={(picked) => {
                    if (picked.endereco) stashEnderecoForCliente(picked.id, picked.endereco);
                    setSelected(`documents/clientes/${picked.id}`);
                    setMode('existing');
                  }}
                />
              )}
            </>
          )}
        </Stack>
      </Group>
    </Stack>
  );
}
