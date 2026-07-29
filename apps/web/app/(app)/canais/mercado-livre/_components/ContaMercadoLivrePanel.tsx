'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';

import { usePermission } from '@/lib/auth';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreMassImportStatus,
  type MercadoLivrePriceSyncSkip,
  type MercadoLivrePriceSyncStatus,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';

/**
 * Mercado Livre account panel on /canais/mercado-livre/[id] — shows the
 * connection status (`/users/me`) and a Conectar / Reautenticar button that
 * kicks off the server-side OAuth flow on apps/mercado-livre. Mounted beside
 * the integracao editor. The browser never sees a Mercado Livre token.
 * Mirrors the Melhor Envio ContaPanel.
 */
export function ContaMercadoLivrePanel({ integracaoId }: { integracaoId: string }) {
  const client = useMercadoLivreClient();
  // The backend oauth/start route is PERM.integracao.write-gated — gate the
  // button by the same bit so a viewer isn't offered an action that will 403.
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const [connecting, setConnecting] = useState(false);
  const searchParams = useSearchParams();

  // Toast the OAuth callback outcome (?ml=connected|error&reason=…).
  useEffect(() => {
    const ml = searchParams.get('ml');
    if (ml === 'connected') {
      notifications.show({ color: 'green', message: 'Conta Mercado Livre conectada.' });
    } else if (ml === 'error') {
      notifications.show({
        color: 'red',
        message: `Falha ao conectar a conta Mercado Livre (${searchParams.get('reason') ?? 'erro'}).`,
      });
    }
  }, [searchParams]);

  const query = useQuery({
    queryKey: ['mercado-livre-conta', integracaoId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.conta(integracaoId);
    },
    enabled: Boolean(client),
    retry: false,
  });

  async function handleConnect() {
    if (!client) return;
    setConnecting(true);
    try {
      const { authorizeUrl } = await client.oauthStart(integracaoId);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setConnecting(false);
      if (err instanceof MercadoLivreClientHttpError) {
        notifications.show({ color: 'red', message: err.message });
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        notifications.show({ color: 'red', message: 'Falha de rede ao iniciar a conexão.' });
        return;
      }
      throw err;
    }
  }

  const connected = query.data?.connected === true;
  const me = query.data?.me ?? null;

  // --- Mass import ("Importar todos os anúncios", #621) ---
  const [massImportOpened, setMassImportOpened] = useState(false);
  const [massImportBusy, setMassImportBusy] = useState(false);
  const [massImportJobId, setMassImportJobId] = useState<string | null>(null);
  const [importarEstoque, setImportarEstoque] = useState(true);
  const [sobrescreverEstoque, setSobrescreverEstoque] = useState(false);
  const [importarPreco, setImportarPreco] = useState(true);
  const [sobrescreverPreco, setSobrescreverPreco] = useState(true);
  const [importarFotos, setImportarFotos] = useState(true);
  const [importarCategorias, setImportarCategorias] = useState(true);
  const [atualizarProdutoPai, setAtualizarProdutoPai] = useState(true);
  const [atualizarCadastrados, setAtualizarCadastrados] = useState(false);

  const massImportQuery = useQuery({
    queryKey: ['ml-mass-import', integracaoId, massImportJobId],
    queryFn: () => {
      if (!client || !massImportJobId) throw new Error('not ready');
      return client.massImportStatus({ integracaoId, jobId: massImportJobId });
    },
    enabled: Boolean(client) && Boolean(massImportJobId),
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 3000 : false),
  });

  async function handleStartMassImport() {
    if (!client) return;
    setMassImportBusy(true);
    try {
      const { jobId } = await client.startMassImport({
        integracaoId,
        options: {
          importarEstoque,
          sobrescreverEstoque,
          importarPreco,
          sobrescreverPreco,
          importarFotos,
          importarCategorias,
          atualizarProdutoPai,
          atualizarCadastrados,
        },
      });
      setMassImportJobId(jobId);
      setMassImportOpened(false);
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        if (err.code === 'ML_MASS_IMPORT_RUNNING') {
          notifications.show({
            color: 'yellow',
            message: 'Já existe uma importação em andamento.',
          });
        } else {
          notifications.show({ color: 'red', message: err.message });
        }
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        notifications.show({ color: 'red', message: 'Falha de rede ao iniciar a importação.' });
        return;
      }
      throw err;
    } finally {
      setMassImportBusy(false);
    }
  }

  const massImport = massImportQuery.data;

  // --- Manual price sync ("Atualizar preços", Step 11 PR-D) ---
  const [priceSyncOpened, setPriceSyncOpened] = useState(false);
  const [priceSyncBusy, setPriceSyncBusy] = useState(false);
  const [priceSyncJobId, setPriceSyncJobId] = useState<string | null>(null);
  const [baixarPreco, setBaixarPreco] = useState(false);

  const priceSyncQuery = useQuery({
    queryKey: ['ml-price-sync', integracaoId, priceSyncJobId],
    queryFn: () => {
      if (!client || !priceSyncJobId) throw new Error('not ready');
      return client.priceSyncStatus({ integracaoId, jobId: priceSyncJobId });
    },
    enabled: Boolean(client) && Boolean(priceSyncJobId),
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 3000 : false),
  });

  async function handleStartPriceSync() {
    if (!client) return;
    setPriceSyncBusy(true);
    try {
      const { jobId } = await client.startPriceSync({ integracaoId, baixarPreco });
      setPriceSyncJobId(jobId);
      setPriceSyncOpened(false);
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        if (err.code === 'ML_PRICE_SYNC_RUNNING') {
          notifications.show({
            color: 'yellow',
            message: 'Já existe um envio de preços em andamento para esta conta.',
          });
        } else if (err.code === 'SEM_TABELA_NORMAL') {
          notifications.show({
            color: 'red',
            message: 'Configure a tabela de preços normal da conta antes de enviar.',
          });
        } else {
          notifications.show({ color: 'red', message: err.message });
        }
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        notifications.show({
          color: 'red',
          message: 'Falha de rede ao iniciar o envio de preços.',
        });
        return;
      }
      throw err;
    } finally {
      setPriceSyncBusy(false);
    }
  }

  const priceSync = priceSyncQuery.data;

  return (
    <Card withBorder padding="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Conta Mercado Livre</Text>
          {query.isLoading ? (
            <Loader size="sm" />
          ) : connected ? (
            <Badge color="green">Conectada</Badge>
          ) : (
            <Badge color="gray">Não conectada</Badge>
          )}
        </Group>

        {query.error != null && <ContaError error={query.error} />}

        {connected && me && (
          <Text size="sm">
            {me.nickname ?? `Usuário ${me.id}`}
            {me.email ? ` · ${me.email}` : ''}
          </Text>
        )}

        <Group align="center" gap="sm">
          <Button
            type="button"
            variant={connected ? 'light' : 'filled'}
            onClick={handleConnect}
            loading={connecting}
            disabled={!client || !canWrite}
          >
            {connected ? 'Reautenticar' : 'Conectar conta'}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => setMassImportOpened(true)}
            disabled={!client || !canWrite}
          >
            Importar todos os anúncios
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => {
              // Every open re-arms the SAFE default — a stale "permitir baixar
              // precos" from a previous run must never leak into a new opt-in.
              setBaixarPreco(false);
              setPriceSyncOpened(true);
            }}
            disabled={!client || !canWrite}
          >
            Atualizar preços
          </Button>
          {!canWrite && (
            <Text size="xs" c="dimmed">
              Requer permissão de escrita em integrações.
            </Text>
          )}
        </Group>

        {massImportJobId && <MassImportProgress query={massImportQuery} data={massImport} />}

        {priceSyncJobId && <PriceSyncProgress query={priceSyncQuery} data={priceSync} />}
      </Stack>

      <Modal
        opened={massImportOpened}
        onClose={() => setMassImportOpened(false)}
        title="Importar todos os anúncios"
        centered
      >
        <Stack>
          <Text size="sm" c="dimmed">
            Varre todos os anúncios da conta e importa (ou atualiza) cada um. Pode levar alguns
            minutos — acompanhe o progresso neste painel.
          </Text>
          <Checkbox
            label="Importar estoque"
            checked={importarEstoque}
            onChange={(e) => setImportarEstoque(e.currentTarget.checked)}
          />
          <Checkbox
            label="Sobrescrever estoque existente"
            checked={sobrescreverEstoque}
            onChange={(e) => setSobrescreverEstoque(e.currentTarget.checked)}
            disabled={!importarEstoque}
          />
          <Checkbox
            label="Importar preço"
            checked={importarPreco}
            onChange={(e) => setImportarPreco(e.currentTarget.checked)}
          />
          <Checkbox
            label="Sobrescrever preço existente"
            checked={sobrescreverPreco}
            onChange={(e) => setSobrescreverPreco(e.currentTarget.checked)}
            disabled={!importarPreco}
          />
          <Checkbox
            label="Importar fotos"
            checked={importarFotos}
            onChange={(e) => setImportarFotos(e.currentTarget.checked)}
          />
          <Checkbox
            label="Importar categorias"
            checked={importarCategorias}
            onChange={(e) => setImportarCategorias(e.currentTarget.checked)}
          />
          <Checkbox
            label="Completar dados do produto pai"
            checked={atualizarProdutoPai}
            onChange={(e) => setAtualizarProdutoPai(e.currentTarget.checked)}
          />
          <Checkbox
            label="Atualizar anúncios já cadastrados"
            checked={atualizarCadastrados}
            onChange={(e) => setAtualizarCadastrados(e.currentTarget.checked)}
          />
          <Button onClick={handleStartMassImport} loading={massImportBusy} disabled={!client}>
            Iniciar importação
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={priceSyncOpened}
        onClose={() => setPriceSyncOpened(false)}
        title="Atualizar preços"
        centered
      >
        <Stack>
          <Text size="sm" c="dimmed">
            Envia o preço da tabela de preços normal de cada produto vinculado ao Mercado Livre
            desta conta. Preços iguais são pulados; preços menores que o atual no Mercado Livre só
            são enviados com a opção abaixo.
          </Text>
          <Checkbox
            label="Permitir baixar preços"
            checked={baixarPreco}
            onChange={(e) => setBaixarPreco(e.currentTarget.checked)}
          />
          <Text size="xs" c="dimmed">
            Sem esta opção, reduções de preço são puladas com o código PRECO_ANTIGO_MAIOR.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPriceSyncOpened(false)}>
              Cancelar
            </Button>
            <Button onClick={handleStartPriceSync} loading={priceSyncBusy} disabled={!client}>
              Enviar preços
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}

/** Progress/outcome section for the running-or-finished mass-import job. */
function MassImportProgress({
  query,
  data,
}: {
  query: { isLoading: boolean; error: unknown };
  data: MercadoLivreMassImportStatus | undefined;
}) {
  if (query.error != null) {
    const message =
      query.error instanceof MercadoLivreClientHttpError
        ? query.error.message
        : query.error instanceof MercadoLivreClientNetworkError
          ? 'Falha de rede ao consultar a importação.'
          : 'Não foi possível consultar a importação.';
    return (
      <Alert color="yellow" variant="light">
        {message}
      </Alert>
    );
  }
  if (!data) {
    return query.isLoading ? <Loader size="sm" /> : null;
  }

  return (
    <Card withBorder padding="sm">
      <Stack gap={4}>
        <Group justify="space-between">
          <Text size="sm" fw={500}>
            Importação em massa
          </Text>
          {data.status === 'running' && <Loader size="xs" />}
        </Group>
        <Text size="sm">
          {data.scanned} anúncios encontrados · {data.imported} importados · {data.skipped} pulados
          · {data.failureCount} falhas
        </Text>
        {data.status === 'completed' && (
          <Alert color="green" variant="light">
            Importação concluída.
          </Alert>
        )}
        {data.status === 'failed' && (
          <Alert color="red" variant="light">
            Falha na importação{data.erro ? `: ${data.erro}` : '.'}
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

/** Progress/outcome section for the running-or-finished price-sync job. */
function PriceSyncProgress({
  query,
  data,
}: {
  query: { isLoading: boolean; error: unknown };
  data: MercadoLivrePriceSyncStatus | undefined;
}) {
  if (query.error != null) {
    const message =
      query.error instanceof MercadoLivreClientHttpError
        ? query.error.message
        : query.error instanceof MercadoLivreClientNetworkError
          ? 'Falha de rede ao consultar o envio de preços.'
          : 'Não foi possível consultar o envio de preços.';
    return (
      <Alert color="yellow" variant="light">
        {message}
      </Alert>
    );
  }
  if (!data) {
    return query.isLoading ? <Loader size="sm" /> : null;
  }

  return (
    <Card withBorder padding="sm">
      <Stack gap={4}>
        <Group justify="space-between">
          <Text size="sm" fw={500}>
            Envio de preços
          </Text>
          {data.status === 'running' && <Loader size="xs" />}
        </Group>
        <Text size="sm">
          {data.enviados} / {data.planejados} enviados · {data.pulados} pulados · {data.falhas}{' '}
          falhas
          {data.pausas > 0 ? ` · ${data.pausas} pausas` : ''}
        </Text>
        {data.status === 'completed' && (
          <Alert color="green" variant="light">
            Envio de preços concluído: {data.enviados} enviados, {data.pulados} pulados,{' '}
            {data.falhas} falhas.
          </Alert>
        )}
        {data.status === 'failed' && (
          <Alert color="red" variant="light">
            Falha no envio de preços{data.erro ? `: ${data.erro}` : '.'}
          </Alert>
        )}
        <PriceSyncEntryList label="Pulados" entries={data.skips} total={data.pulados} />
        <PriceSyncEntryList label="Falhas" entries={data.failures} total={data.falhas} />
      </Stack>
    </Card>
  );
}

/** How many skip/failure sample entries the progress card lists before "+N mais". */
const PRICE_SYNC_LIST_LIMIT = 8;

/**
 * Compact dimmed-monospace list of a price-sync job's skip/failure sample.
 * `total` is the exact counter (`pulados`/`falhas`) — the entries themselves
 * are a server-capped sample, so the "+N mais" tail counts against it.
 */
function PriceSyncEntryList({
  label,
  entries,
  total,
}: {
  label: string;
  entries: Array<MercadoLivrePriceSyncSkip & { error?: string }>;
  total: number;
}) {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, PRICE_SYNC_LIST_LIMIT);
  const rest = total - shown.length;
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed" fw={500}>
        {label}
      </Text>
      {shown.map((entry, i) => (
        <Text key={`${entry.itemId ?? entry.produtoId}-${i}`} size="xs" c="dimmed" ff="monospace">
          {entry.itemId ?? entry.produtoId} · {entry.code}
          {entry.error ? ` · ${errorSnippet(entry.error)}` : ''}
        </Text>
      ))}
      {rest > 0 && (
        <Text size="xs" c="dimmed">
          +{rest} mais
        </Text>
      )}
    </Stack>
  );
}

/** Keep a failure's error text a one-line snippet in the compact list. */
function errorSnippet(error: string): string {
  return error.length > 80 ? `${error.slice(0, 80)}…` : error;
}

/** Render a conta query error, keeping unknown failures generic. */
function ContaError({ error }: { error: unknown }) {
  const message =
    error instanceof MercadoLivreClientHttpError
      ? error.message
      : error instanceof MercadoLivreClientNetworkError
        ? 'Falha de rede ao consultar a conta.'
        : 'Não foi possível consultar a conta.';
  return (
    <Alert color="yellow" variant="light">
      {message}
    </Alert>
  );
}
