'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Group, Loader, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { MlSizeChart } from '@delfrance/schemas';

import {
  type GridTemplateAttribute,
  buildNewChart,
  extractGridTemplate,
} from '@/lib/mercado-livre/chartForm';
import {
  type MercadoLivreChartDomain,
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreClient,
} from '@/lib/mercado-livre/client';

/** A size variation group (tipo 1) the chart's rows bind to. */
export interface SizeGroupOption {
  grupoId: string;
  nome: string;
  variantes: Array<{ id: string; nome: string }>;
}

/**
 * Create-a-chart modal (Step 5c MVP): pick a domain → the editor fetches its
 * specs and surfaces the domain's single grid template (GENDER) → pick the
 * gender + a size group → one row per variante is generated with its size
 * label. Measurement columns are deferred (the server synthesizes the SIZE
 * main attribute from the rows). The built chart is handed to `onAdd`; the
 * parent sends it to ML with the account's other charts.
 */
export function CreateSizeChartModal({
  opened,
  onClose,
  client,
  integracaoId,
  grupos,
  onAdd,
}: {
  opened: boolean;
  onClose: () => void;
  client: MercadoLivreClient;
  integracaoId: string;
  grupos: SizeGroupOption[];
  onAdd: (chart: MlSizeChart) => void;
}) {
  const [nome, setNome] = useState('');
  const [domains, setDomains] = useState<MercadoLivreChartDomain[] | null>(null);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [domainId, setDomainId] = useState<string | null>(null);
  const [specsLoading, setSpecsLoading] = useState(false);
  const [template, setTemplate] = useState<GridTemplateAttribute | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [genderValueId, setGenderValueId] = useState<string | null>(null);
  const [grupoId, setGrupoId] = useState<string | null>(null);

  // Reset everything each time the modal opens (a fresh chart per session).
  useEffect(() => {
    if (!opened) return;
    setNome('');
    setDomains(null);
    setDomainId(null);
    setTemplate(null);
    setTemplateError(null);
    setGenderValueId(null);
    setGrupoId(null);

    let cancelled = false;
    setDomainsLoading(true);
    client
      .sizeChartDomains(integracaoId)
      .then((res) => {
        if (!cancelled) setDomains(res.domains);
      })
      .catch((err) => {
        if (cancelled) return;
        reportClientError(err, 'Falha ao carregar os domínios do Mercado Livre.');
        setDomains([]);
      })
      .finally(() => {
        if (!cancelled) setDomainsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, client, integracaoId]);

  // On domain pick, fetch its specs and extract the grid template (GENDER).
  useEffect(() => {
    if (!domainId) {
      setTemplate(null);
      setTemplateError(null);
      setGenderValueId(null);
      return;
    }
    let cancelled = false;
    setSpecsLoading(true);
    setTemplate(null);
    setTemplateError(null);
    setGenderValueId(null);
    client
      .sizeChartSpecs({ integracaoId, domainId })
      .then((specs) => {
        if (cancelled) return;
        const res = extractGridTemplate(specs);
        if (res.ok) {
          setTemplate(res.template);
        } else if (res.reason === 'none') {
          setTemplateError('Este domínio não exige guia de tamanhos.');
        } else {
          setTemplateError(
            'Este domínio tem uma configuração de guia não suportada aqui — cadastre pelo app antigo.',
          );
        }
      })
      .catch((err) => {
        if (cancelled) return;
        reportClientError(err, 'Falha ao carregar as especificações do domínio.');
        setTemplateError('Não foi possível carregar as especificações do domínio.');
      })
      .finally(() => {
        if (!cancelled) setSpecsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [domainId, client, integracaoId]);

  const grupo = grupos.find((g) => g.grupoId === grupoId) ?? null;
  const genderValue = template?.values.find((v) => v.id === genderValueId) ?? null;
  const canAdd =
    nome.trim().length > 0 &&
    domainId != null &&
    template != null &&
    genderValue != null &&
    grupo != null &&
    grupo.variantes.length > 0;

  function handleAdd() {
    if (!canAdd || !domainId || !template || !genderValue || !grupo) return;
    onAdd(
      buildNewChart({
        nome,
        domainId,
        templateId: template.id,
        templateValue: genderValue,
        grupoId: grupo.grupoId,
        variantes: grupo.variantes,
      }),
    );
    onClose();
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Nova guia de tamanhos" size="lg">
      <Stack gap="md">
        <TextInput
          label="Nome da guia"
          description="Como a guia aparece no Mercado Livre (até 60 caracteres)."
          value={nome}
          maxLength={60}
          onChange={(e) => setNome(e.currentTarget.value)}
          required
        />

        <Select
          label="Domínio"
          placeholder={domainsLoading ? 'Carregando…' : 'Selecione o domínio'}
          data={(domains ?? []).map((d) => ({
            value: d.domain_id,
            label: d.name ? `${d.name} (${d.domain_id})` : d.domain_id,
          }))}
          value={domainId}
          onChange={setDomainId}
          disabled={domainsLoading}
          searchable
          required
        />

        {specsLoading && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Carregando especificações do domínio…
            </Text>
          </Group>
        )}

        {templateError && (
          <Alert color="yellow" variant="light">
            {templateError}
          </Alert>
        )}

        {template && (
          <Select
            label={template.name}
            placeholder={`Selecione: ${template.name}`}
            data={template.values.map((v) => ({ value: v.id, label: v.name }))}
            value={genderValueId}
            onChange={setGenderValueId}
            required
          />
        )}

        <Select
          label="Grupo de tamanhos"
          description="As linhas da guia são geradas a partir dos tamanhos deste grupo."
          placeholder="Selecione o grupo de variações (Tamanho)"
          data={grupos.map((g) => ({
            value: g.grupoId,
            label: `${g.nome} (${g.variantes.length} tamanhos)`,
          }))}
          value={grupoId}
          onChange={setGrupoId}
          searchable
          required
        />

        {grupo && grupo.variantes.length === 0 && (
          <Alert color="yellow" variant="light">
            Este grupo não tem tamanhos cadastrados.
          </Alert>
        )}

        {grupo && grupo.variantes.length > 0 && (
          <Text size="sm" c="dimmed">
            Linhas: {grupo.variantes.map((v) => v.nome).join(', ')}.
          </Text>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleAdd} disabled={!canAdd}>
            Adicionar guia
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Toast a client error, keeping unknown failures generic. */
function reportClientError(err: unknown, fallback: string): void {
  if (err instanceof MercadoLivreClientHttpError) {
    if (err.status === 409) {
      notifications.show({
        color: 'red',
        message: 'Conta Mercado Livre não conectada — reconecte em Canais de venda.',
      });
      return;
    }
    notifications.show({ color: 'red', message: err.message });
    return;
  }
  if (err instanceof MercadoLivreClientNetworkError) {
    notifications.show({ color: 'red', message: 'Não foi possível contatar o Mercado Livre.' });
    return;
  }
  notifications.show({ color: 'red', message: fallback });
}
