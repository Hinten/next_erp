'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Group,
  Modal,
  Radio,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { skipToken, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  INTEGRACAO_TIPO,
  MODO_BUSCA_ANUNCIO_SHOPEE,
  buscaAnuncioShopeeTermoSchema,
  type ModoBuscaAnuncioShopee,
} from '@delfrance/schemas';

import type { UseIntegracoesResult } from '@/lib/data/useIntegracoes';
import { useShopeeClient } from '@/lib/shopee/client';
import { descreverFalhaShopee } from '@/lib/shopee/erros';

const ROTULOS: Record<ModoBuscaAnuncioShopee, string> = {
  [MODO_BUSCA_ANUNCIO_SHOPEE.id]: 'ID do anúncio',
  [MODO_BUSCA_ANUNCIO_SHOPEE.sku]: 'SKU do anúncio',
  [MODO_BUSCA_ANUNCIO_SHOPEE.nome]: 'Nome',
};

export function ImportarShopeeModal({
  integracoes,
  status,
  onClose,
}: {
  integracoes: UseIntegracoesResult['rows'];
  status: UseIntegracoesResult['status'];
  onClose: () => void;
}) {
  const router = useRouter();
  const client = useShopeeClient();
  const queryClient = useQueryClient();
  const enviando = useRef(false);
  const [integracaoId, setIntegracaoId] = useState<string | null>(null);
  const [modo, setModo] = useState<ModoBuscaAnuncioShopee>(MODO_BUSCA_ANUNCIO_SHOPEE.id);
  const [termo, setTermo] = useState('');
  const [busca, setBusca] = useState<{
    integracaoId: string;
    modo: ModoBuscaAnuncioShopee;
    termo: string;
  } | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);

  const contas = integracoes
    .filter(({ data }) => data.tipo === INTEGRACAO_TIPO.shopee && data.ativo)
    .map(({ id, data }) => ({ value: id, label: data.nome }));
  const contaValida = integracaoId !== null && contas.some((conta) => conta.value === integracaoId);
  const termoValido = buscaAnuncioShopeeTermoSchema.safeParse({ modo, termo }).success;

  const chaveBusca = ['shopee-busca-anuncios', busca];
  const consulta = useInfiniteQuery({
    queryKey: chaveBusca,
    queryFn:
      client && busca && contaValida
        ? ({ pageParam, signal }) =>
            client.buscarAnuncios({ ...busca, cursor: pageParam ?? undefined, signal })
        : skipToken,
    initialPageParam: null as string | null,
    getNextPageParam: (ultima, _paginas, _cursor, cursores) =>
      cursores.includes(ultima.proximoCursor) ? null : ultima.proximoCursor,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const resultados = new Map(
    consulta.data?.pages.flatMap((pagina) =>
      pagina.resultados.map((item) => [String(item.itemId), item]),
    ),
  );
  const anuncio = selecionado === null ? undefined : resultados.get(selecionado);

  const importacao = useMutation({
    retry: false,
    mutationFn: (input: { integracaoId: string; itemId: number }) => {
      if (!client) throw new Error('A sessão Shopee não está disponível.');
      return client.importarAnuncio({ ...input, options: { sobrescreverPreco: false } });
    },
    onSuccess: ({ produtoId, criado, nome }) => {
      notifications.show({
        color: 'green',
        title: criado ? 'Produto importado' : 'Produto atualizado',
        message: nome,
      });
      onClose();
      router.push(`/produtos/${encodeURIComponent(produtoId)}/editar`);
    },
    onSettled: () => {
      enviando.current = false;
    },
  });

  function limparBusca() {
    setBusca(null);
    setSelecionado(null);
    importacao.reset();
  }

  const podeBuscar = client !== null && contaValida && termoValido && !importacao.isPending;
  const podeImportar =
    client !== null &&
    contaValida &&
    !!busca &&
    !!anuncio &&
    !consulta.isFetching &&
    !consulta.isError &&
    !importacao.isPending;

  return (
    <Modal
      opened
      onClose={() => {
        if (!enviando.current && !importacao.isPending) onClose();
      }}
      closeOnEscape={!importacao.isPending}
      closeOnClickOutside={!importacao.isPending}
      withCloseButton={!importacao.isPending}
      closeButtonProps={{ 'aria-label': 'Fechar' }}
      title="Importar da Shopee"
      centered
    >
      <Stack>
        {status === 'error' && (
          <Alert color="red">Não foi possível carregar as contas de venda.</Alert>
        )}
        {status === 'success' && contas.length === 0 && (
          <Alert color="yellow">
            Nenhuma conta Shopee ativa. Configure uma conta em Canais de venda.
          </Alert>
        )}
        <Select
          label="Conta"
          placeholder={status === 'pending' ? 'Carregando contas…' : 'Selecione a conta Shopee'}
          data={contas}
          value={integracaoId}
          onChange={(valor) => {
            setIntegracaoId(valor);
            limparBusca();
          }}
          disabled={contas.length === 0 || importacao.isPending}
          searchable
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!podeBuscar || integracaoId === null || consulta.isFetching) return;
            setSelecionado(null);
            importacao.reset();
            if (busca) {
              void queryClient.resetQueries({ queryKey: chaveBusca, exact: true });
            } else {
              setBusca({ integracaoId, modo, termo: termo.trim() });
            }
          }}
        >
          <Stack gap="sm">
            <Radio.Group
              label="Buscar por"
              value={modo}
              onChange={(valor) => {
                const novoModo = Object.values(MODO_BUSCA_ANUNCIO_SHOPEE).find(
                  (opcao) => opcao === valor,
                );
                if (novoModo === undefined) return;
                setModo(novoModo);
                setTermo('');
                limparBusca();
              }}
            >
              <Group gap="sm" mt="xs">
                {Object.values(MODO_BUSCA_ANUNCIO_SHOPEE).map((opcao) => (
                  <Radio
                    key={opcao}
                    value={opcao}
                    label={ROTULOS[opcao]}
                    disabled={importacao.isPending}
                  />
                ))}
              </Group>
            </Radio.Group>
            <TextInput
              label={ROTULOS[modo]}
              value={termo}
              inputMode={modo === MODO_BUSCA_ANUNCIO_SHOPEE.id ? 'numeric' : undefined}
              error={
                modo === MODO_BUSCA_ANUNCIO_SHOPEE.id && termo.trim() && !termoValido
                  ? 'Informe um ID de anúncio válido.'
                  : undefined
              }
              onChange={(event) => {
                setTermo(event.currentTarget.value);
                limparBusca();
              }}
              disabled={importacao.isPending}
            />
            <Button
              type="submit"
              variant="default"
              disabled={!podeBuscar}
              loading={consulta.isFetching && !consulta.isFetchingNextPage}
            >
              Buscar
            </Button>
          </Stack>
        </form>

        {consulta.isError && (
          <Alert color="red" role="alert">
            {
              descreverFalhaShopee(consulta.error, {
                desconhecido: 'Não foi possível buscar os anúncios.',
              }).mensagem
            }
          </Alert>
        )}
        {consulta.isSuccess && resultados.size === 0 && (
          <Text c="dimmed" size="sm" role="status">
            {consulta.hasNextPage
              ? 'Nenhum anúncio nesta página.'
              : 'Nenhum anúncio encontrado nesta conta.'}
          </Text>
        )}
        {busca && !consulta.isError && resultados.size > 0 && (
          <Radio.Group
            label="Anúncios encontrados"
            value={selecionado ?? ''}
            onChange={setSelecionado}
          >
            <ScrollArea.Autosize mah={260} mt="xs">
              <Stack gap="sm">
                {[...resultados].map(([id, item]) => (
                  <Radio
                    key={id}
                    value={id}
                    disabled={importacao.isPending}
                    label={
                      <>
                        <Text component="span" display="block" size="sm">
                          {item.nome || 'Anúncio sem nome'}
                        </Text>
                        <Text component="span" display="block" size="xs" c="dimmed">
                          ID {id}
                          {item.sku && ` · SKU ${item.sku}`}
                        </Text>
                      </>
                    }
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          </Radio.Group>
        )}
        {consulta.hasNextPage && (
          <Button
            variant="subtle"
            disabled={consulta.isFetching || importacao.isPending}
            loading={consulta.isFetchingNextPage}
            onClick={() => {
              setSelecionado(null);
              void consulta.fetchNextPage();
            }}
          >
            Carregar mais
          </Button>
        )}
        {importacao.isError && (
          <Alert color="red" role="alert">
            {
              descreverFalhaShopee(importacao.error, {
                desconhecido: 'Não foi possível importar o anúncio.',
              }).mensagem
            }
          </Alert>
        )}
        <Button
          disabled={!podeImportar}
          loading={importacao.isPending}
          onClick={() => {
            if (podeImportar && busca && anuncio && !enviando.current) {
              enviando.current = true;
              importacao.mutate({ integracaoId: busca.integracaoId, itemId: anuncio.itemId });
            }
          }}
        >
          Importar anúncio
        </Button>
      </Stack>
    </Modal>
  );
}
