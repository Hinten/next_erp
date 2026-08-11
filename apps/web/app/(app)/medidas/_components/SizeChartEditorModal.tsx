'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Divider,
  Group,
  List,
  Loader,
  Modal,
  Select,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FirebaseError } from 'firebase/app';
import type { MlSizeChart } from '@delfrance/schemas';

import {
  type ChartCellValue,
  type ChartRowDraft,
  duplicateChart,
  indexCellErrors,
  rowsFromVariantes,
  seedRows,
  seedUnits,
  toChartRows,
  validateChartName,
  CHART_NAME_MAX,
} from '@/lib/mercado-livre/chartRows';
import {
  type ChartMeasureType,
  type ChartSpecValue,
  detectMeasureTypes,
  extractChartAttributes,
  extractColumns,
  extractGridTemplates,
  mainAttributeCandidates,
  maxRows as gridMaxRows,
} from '@/lib/mercado-livre/chartSpec';
import { SizeChartConflictError } from '@/lib/mercado-livre/chartConflict';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreChartValidationError,
  type MercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { SizeChartGrid } from './SizeChartGrid';

/** A size variation group (tipo 1) the chart's rows bind to. */
export interface SizeGroupOption {
  grupoId: string;
  nome: string;
  variantes: Array<{ id: string; nome: string }>;
}

const MEASURE_LABELS: Record<ChartMeasureType, string> = {
  BODY_MEASURE: 'Medidas do corpo',
  CLOTHING_MEASURE: 'Medidas da peça',
};

export interface SizeChartEditorModalProps {
  opened: boolean;
  onClose: () => void;
  client: MercadoLivreClient;
  integracaoId: string;
  /** The guia being edited, or null to create one. */
  chart: MlSizeChart | null;
  /** Its index in the conta's stored list, or null for a new one. */
  chartIndex: number | null;
  grupos: SizeGroupOption[];
  /**
   * `PERM.integracao.write` — the gate the sync route enforces server-side.
   * Without it "Enviar" would only fail after the round trip.
   */
  canWrite: boolean;
  /** Persist the guia on the tabMedi doc without contacting ML. */
  onSaveDraft: (chart: MlSizeChart, chartIndex: number | null) => Promise<void>;
  /** Send this conta's guias to ML; resolves with the problems ML reported. */
  onSend: (
    chart: MlSizeChart,
    chartIndex: number | null,
  ) => Promise<{ validationErrors: MercadoLivreChartValidationError[]; chartIndex: number }>;
  /** Re-open the editor on an unsent copy of the current guia. */
  onDuplicate: (copy: MlSizeChart) => void;
}

/**
 * The size-chart editor — one full-screen modal for both creating and editing.
 *
 * The shape of this screen is dictated by what Mercado Livre actually lets you
 * change after a guia exists: **only its name and the non-main cells of its
 * rows**. Domain, gender/brand, measure type, each row's size and the row set
 * itself are frozen, and rows can never be deleted. So a sent guia renders its
 * whole "Definição" section read-only and offers **Duplicar em nova guia** —
 * the same escape hatch the legacy screen's *Copiar* button provided, and the
 * only thing ML supports for a chart that was created wrong.
 *
 * Two things the legacy screen did that are deliberately not reproduced: the
 * grid appeared only after a manual "Carregar Tabela de Medidas" button (here
 * the columns follow the answers reactively), and a cell error survived until
 * the next full send (here editing a cell clears it).
 */
export function SizeChartEditorModal({
  opened,
  onClose,
  client,
  integracaoId,
  chart,
  chartIndex,
  grupos,
  canWrite,
  onSaveDraft,
  onSend,
  onDuplicate,
}: SizeChartEditorModalProps) {
  const sent = chart?.id != null && chart.id !== '';

  /* ------------------------------- answers ------------------------------- */

  const [nome, setNome] = useState(chart?.nome ?? '');
  const [domainId, setDomainId] = useState<string | null>(chart?.domain_id ?? null);
  const [templateValues, setTemplateValues] = useState<Record<string, ChartSpecValue>>(() =>
    seedTemplateValues(chart),
  );
  const [measureType, setMeasureType] = useState<ChartMeasureType | null>(
    (chart?.tipo as ChartMeasureType | null | undefined) ?? null,
  );
  const [mainAttributeId, setMainAttributeId] = useState<string | null>(
    chart?.main_attribute_id ?? null,
  );
  const [grupoId, setGrupoId] = useState<string | null>(grupoIdOf(chart));

  const [rows, setRows] = useState<ChartRowDraft[]>([]);
  const [units, setUnits] = useState<Record<string, string | null>>({});
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [validationErrors, setValidationErrors] = useState<MercadoLivreChartValidationError[]>([]);
  const [errorChartIndex, setErrorChartIndex] = useState(0);
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const [definicaoOpen, setDefinicaoOpen] = useState(!sent);

  /* -------------------------------- specs -------------------------------- */

  const domainsQuery = useQuery({
    queryKey: ['ml-chart-domains', integracaoId],
    queryFn: () => client.sizeChartDomains(integracaoId),
    enabled: opened,
    retry: false,
  });

  // Step 1: the DOMAIN spec names the questions (GENDER, …) ML wants answered.
  const domainSpecsQuery = useQuery({
    queryKey: ['ml-chart-domain-specs', integracaoId, domainId],
    queryFn: () => client.sizeChartSpecs({ integracaoId, domainId: domainId! }),
    enabled: opened && domainId != null,
    retry: false,
  });

  const templates = useMemo(
    () => (domainSpecsQuery.data ? extractGridTemplates(domainSpecsQuery.data) : []),
    [domainSpecsQuery.data],
  );
  const chartAttributes = useMemo(
    () => (domainSpecsQuery.data ? extractChartAttributes(domainSpecsQuery.data) : []),
    [domainSpecsQuery.data],
  );

  // Every REQUIRED question answered ⇒ ML will describe the grid.
  const answered = templates.length > 0 && templates.every((t) => templateValues[t.id] != null);
  const specAttributes = useMemo(
    () =>
      templates.map((t) => ({
        id: t.id,
        value_id: templateValues[t.id]?.id,
        value_name: templateValues[t.id]?.name,
        values: templateValues[t.id] ? [templateValues[t.id]] : [],
      })),
    [templates, templateValues],
  );

  // Step 2: the GRID spec IS the column list.
  const gridSpecsQuery = useQuery({
    queryKey: ['ml-chart-grid-specs', integracaoId, domainId, JSON.stringify(specAttributes)],
    queryFn: () =>
      client.sizeChartSpecs({ integracaoId, domainId: domainId!, attributes: specAttributes }),
    enabled: opened && domainId != null && answered,
    retry: false,
  });

  const measureOptions = useMemo(
    () => (gridSpecsQuery.data ? detectMeasureTypes(gridSpecsQuery.data) : []),
    [gridSpecsQuery.data],
  );
  const mainCandidates = useMemo(
    () => (gridSpecsQuery.data ? mainAttributeCandidates(gridSpecsQuery.data) : []),
    [gridSpecsQuery.data],
  );
  // Both defaults are DERIVED, not stored: ML only tells us the options once
  // the grid spec lands, and setting state from that in an effect would render
  // twice and fight a stored guia's own frozen value.
  const effectiveMeasureType = measureType ?? measureOptions[0] ?? null;
  // SIZE when the domain has it (apparel); otherwise the first candidate, which
  // is how footwear domains become reachable at all.
  const effectiveMainId =
    mainAttributeId ??
    mainCandidates.find((c) => c.id === 'SIZE')?.id ??
    mainCandidates[0]?.id ??
    'SIZE';

  const allColumns = useMemo(
    () => (gridSpecsQuery.data ? extractColumns(gridSpecsQuery.data, effectiveMeasureType) : []),
    [gridSpecsQuery.data, effectiveMeasureType],
  );
  const rowCap = useMemo(
    () => (gridSpecsQuery.data ? gridMaxRows(gridSpecsQuery.data) : null),
    [gridSpecsQuery.data],
  );

  // Optional columns the operator hid, so a 10-column domain stays readable.
  // Required ones and the main attribute can never be hidden.
  const columns = useMemo(
    () =>
      allColumns.filter(
        (c) => c.required || c.key === effectiveMainId || !hiddenColumns.has(c.key),
      ),
    [allColumns, hiddenColumns, effectiveMainId],
  );

  /* ------------------------------- seeding ------------------------------- */

  const grupo = grupos.find((g) => g.grupoId === grupoId) ?? null;

  /**
   * What the grid is seeded FROM. Deliberately narrow: the stored guia, the
   * chosen size group and its variantes, and the main attribute the rows key on.
   *
   * ⚠️ `allColumns` is NOT part of it. Cells are keyed by attribute id, so a
   * column set that changes (the operator flips the measure type, ML re-derives
   * an identical list) needs no re-seed — and re-seeding there would throw away
   * everything typed so far. `grupos` is out for the same reason: it is a live
   * snapshot whose array identity changes whenever ANY size group is edited,
   * which as an effect dependency would wipe the grid mid-typing.
   */
  const seedKey = [
    chart?.id ?? 'novo',
    grupo?.grupoId ?? '',
    grupo?.variantes.map((v) => v.id).join('|') ?? '',
    effectiveMainId,
  ].join('#');
  const [seededFrom, setSeededFrom] = useState<string | null>(null);

  // Seeding state during render (React's documented "adjusting state when props
  // change" pattern) rather than in an effect: React re-renders immediately
  // without painting the empty grid first, and there is no cascading render.
  if (allColumns.length > 0 && seededFrom !== seedKey) {
    setSeededFrom(seedKey);
    setUnits(seedUnits(allColumns, chart));
    setRows(
      chart != null
        ? seedRows(chart, allColumns)
        : grupo
          ? rowsFromVariantes(grupo.grupoId, grupo.variantes, effectiveMainId)
          : [],
    );
  }

  /* -------------------------------- errors ------------------------------- */

  const errors = useMemo(
    () => indexCellErrors(validationErrors, errorChartIndex),
    [validationErrors, errorChartIndex],
  );
  const nameError = nome.trim().length === 0 ? null : validateChartName(nome);

  /* ------------------------------- assembly ------------------------------ */

  function buildChart(): MlSizeChart {
    const templateWire = templates.concat(chartAttributes).flatMap((t) => {
      const picked = templateValues[t.id];
      if (!picked) return [];
      return [{ id: t.id, value_id: picked.id, value_name: picked.name }];
    });
    // Dedupe: a grid_filter attribute can also be grid_template_required.
    const byId = new Map(templateWire.map((a) => [a.id, a]));
    return {
      ...(chart ?? {}),
      id: chart?.id ?? null,
      nome: nome.trim(),
      domain_id: domainId ?? '',
      tipo: effectiveMeasureType,
      main_attribute_id: effectiveMainId,
      grupoDeVariacoesUid: grupoId == null ? null : `documents/grupoDeVariacoes/${grupoId}`,
      attributes: [...byId.values()],
      main_attribute: chart?.main_attribute ?? [],
      rows: toChartRows(rows, allColumns, units, chart),
    };
  }

  const blockingError =
    validateChartName(nome) ??
    (domainId == null ? 'Selecione o domínio.' : null) ??
    (answered ? null : 'Responda os atributos da guia.') ??
    (rows.filter((r) => !r.deleted).length === 0 ? 'A guia precisa de ao menos um tamanho.' : null);

  const overCap =
    rowCap != null && rows.filter((r) => !r.deleted).length > rowCap
      ? `O Mercado Livre aceita no máximo ${String(rowCap)} tamanhos por guia.`
      : null;

  async function run(kind: 'draft' | 'send'): Promise<void> {
    setBusy(kind);
    try {
      const built = buildChart();
      if (kind === 'draft') {
        await onSaveDraft(built, chartIndex);
        notifications.show({ color: 'green', message: 'Rascunho salvo.' });
        onClose();
        return;
      }
      const result = await onSend(built, chartIndex);
      setErrorChartIndex(result.chartIndex);
      setValidationErrors(result.validationErrors);
      if (result.validationErrors.length === 0) {
        notifications.show({ color: 'green', message: 'Guia enviada ao Mercado Livre.' });
        onClose();
        return;
      }
      notifications.show({
        color: 'yellow',
        message: 'O Mercado Livre recusou parte da guia — veja os campos destacados.',
      });
    } catch (err) {
      // Only the failures this screen owns are rendered; anything else
      // rethrows (root CLAUDE.md rule 6) — a Firestore permission error or a
      // bug in the assembly must not read as "falha ao salvar" and be moved on
      // from.
      if (err instanceof SizeChartConflictError) {
        notifications.show({ color: 'red', message: err.message, autoClose: false });
      } else if (err instanceof FirebaseError) {
        // "Salvar rascunho" writes the tabMedi doc straight from the browser, so
        // a rules rejection lands here as a FirebaseError rather than an ML one.
        notifications.show({
          color: 'red',
          message:
            err.code === 'permission-denied'
              ? 'Sem permissão para salvar nesta tabela de medidas.'
              : `Falha ao salvar a guia: ${err.message}`,
        });
      } else if (
        err instanceof MercadoLivreClientHttpError ||
        err instanceof MercadoLivreClientNetworkError
      ) {
        notifications.show({
          color: 'red',
          message: reportableMessage(err, 'Falha ao salvar a guia de tamanhos.'),
        });
      } else {
        throw err;
      }
    } finally {
      setBusy(null);
    }
  }

  /* -------------------------------- render ------------------------------- */

  const specsError = domainsQuery.error ?? domainSpecsQuery.error ?? gridSpecsQuery.error;
  const loadingColumns = gridSpecsQuery.isFetching || domainSpecsQuery.isFetching;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      title={
        <Group gap="sm">
          <Text fw={600}>{chart == null ? 'Nova guia de tamanhos' : 'Guia de tamanhos'}</Text>
          {sent ? (
            <Badge color="green" variant="light">
              Enviada
            </Badge>
          ) : (
            <Badge color="yellow" variant="light">
              Não enviada
            </Badge>
          )}
        </Group>
      }
    >
      {/*
        ⚠️ The test id lives HERE, not on `Modal`. Mantine forwards unknown props
        to Modal.Root, a zero-box wrapper around the overlay and the content —
        `getByTestId(...)` resolves it but `toBeVisible()` never passes, which is
        exactly how this failed in CI.
      */}
      <Stack gap="md" data-testid="ml-size-chart-editor">
        <TextInput
          label="Nome da guia"
          description={`Como a guia aparece no Mercado Livre (até ${String(CHART_NAME_MAX)} caracteres, apenas letras, números e espaços).`}
          value={nome}
          maxLength={CHART_NAME_MAX}
          onChange={(e) => {
            setNome(e.currentTarget.value);
            if (errors.nameRejected) setValidationErrors([]);
          }}
          error={nameError ?? (errors.nameRejected ? errors.chartLevel.join(' ') : null)}
          required
        />

        {sent && (
          <Alert color="blue" variant="light" title="O que ainda dá para mudar">
            O Mercado Livre só permite alterar o <strong>nome</strong> e as <strong>medidas</strong>{' '}
            de uma guia já enviada. Domínio, gênero, tipo de medida e o tamanho de cada linha são
            definitivos, e linhas não podem ser excluídas. Para corrigir qualquer um deles, duplique
            a guia, ajuste a cópia e envie-a como uma guia nova.
            <Group mt="sm">
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  onDuplicate(duplicateChart(chart!));
                }}
              >
                Duplicar em nova guia
              </Button>
            </Group>
          </Alert>
        )}

        <Group justify="space-between">
          <Text fw={600} size="sm">
            Definição
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => {
              setDefinicaoOpen((v) => !v);
            }}
          >
            {definicaoOpen ? 'Ocultar' : 'Mostrar'}
          </Button>
        </Group>

        <Collapse expanded={definicaoOpen}>
          <Stack gap="sm">
            <Select
              label="Domínio"
              placeholder={domainsQuery.isFetching ? 'Carregando…' : 'Selecione o domínio'}
              data={(domainsQuery.data?.domains ?? []).map((d) => ({
                value: d.domain_id,
                label: d.name ? `${d.name} (${d.domain_id})` : d.domain_id,
              }))}
              value={domainId}
              onChange={setDomainId}
              disabled={sent || domainsQuery.isFetching}
              searchable
              required
            />

            {templates.concat(chartAttributes).map((template) => (
              <Select
                key={template.id}
                label={template.name}
                placeholder={`Selecione: ${template.name}`}
                data={template.values.map((v) => ({ value: v.id, label: v.name }))}
                value={templateValues[template.id]?.id ?? null}
                onChange={(id) => {
                  const picked = template.values.find((v) => v.id === id);
                  setTemplateValues((prev) => {
                    const next = { ...prev };
                    if (picked) next[template.id] = picked;
                    else delete next[template.id];
                    return next;
                  });
                }}
                disabled={sent}
                required={template.required}
                searchable
              />
            ))}

            {measureOptions.length > 1 && (
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Tipo de medida
                </Text>
                <SegmentedControl
                  value={effectiveMeasureType ?? measureOptions[0]!}
                  onChange={(v) => {
                    setMeasureType(v as ChartMeasureType);
                  }}
                  data={measureOptions.map((m) => ({ value: m, label: MEASURE_LABELS[m] }))}
                  disabled={sent}
                />
              </div>
            )}

            {mainCandidates.length > 1 && (
              <Select
                label="Tamanho principal"
                description="A coluna que o Mercado Livre mostra como o tamanho do anúncio."
                data={mainCandidates.map((c) => ({ value: c.id, label: c.name }))}
                value={effectiveMainId}
                onChange={setMainAttributeId}
                disabled={sent}
                allowDeselect={false}
              />
            )}

            {!sent && (
              <Select
                label="Grupo de tamanhos"
                description="As linhas da guia são geradas a partir dos tamanhos deste grupo."
                placeholder="Selecione o grupo de variações (Tamanho)"
                data={grupos.map((g) => ({
                  value: g.grupoId,
                  label: `${g.nome} (${String(g.variantes.length)} tamanhos)`,
                }))}
                value={grupoId}
                onChange={setGrupoId}
                searchable
                required
              />
            )}
          </Stack>
        </Collapse>

        <Divider />

        {specsError && (
          <Alert color="red" variant="light">
            {reportableMessage(
              specsError,
              'Não foi possível carregar as especificações do domínio.',
            )}
          </Alert>
        )}

        {loadingColumns && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Carregando as colunas do domínio…
            </Text>
          </Group>
        )}

        {!loadingColumns && domainId != null && templates.length === 0 && domainSpecsQuery.data && (
          <Alert color="yellow" variant="light">
            Este domínio não usa guia de tamanhos.
          </Alert>
        )}

        {allColumns.length > 0 && (
          <>
            <div>
              <Text size="sm" fw={500} mb={4}>
                Colunas
              </Text>
              <Group gap="md">
                {allColumns.map((column) => {
                  const locked = column.required || column.key === effectiveMainId;
                  return (
                    <Checkbox
                      key={column.key}
                      size="xs"
                      label={column.label}
                      checked={locked || !hiddenColumns.has(column.key)}
                      disabled={locked}
                      onChange={(e) => {
                        const show = e.currentTarget.checked;
                        setHiddenColumns((prev) => {
                          const next = new Set(prev);
                          if (show) next.delete(column.key);
                          else next.add(column.key);
                          return next;
                        });
                      }}
                    />
                  );
                })}
              </Group>
            </div>

            {errors.chartLevel.length > 0 && !errors.nameRejected && (
              <Alert color="red" variant="light" title="Pendências do Mercado Livre">
                <List size="sm">
                  {errors.chartLevel.map((message, i) => (
                    <List.Item key={`${message}-${String(i)}`}>{message}</List.Item>
                  ))}
                </List>
              </Alert>
            )}

            {errors.byCell.size > 0 && (
              <Text size="sm" c="red">
                {errors.byCell.size === 1
                  ? '1 campo recusado pelo Mercado Livre — corrija o campo destacado.'
                  : `${String(errors.byCell.size)} campos recusados pelo Mercado Livre — corrija os campos destacados.`}
              </Text>
            )}

            <SizeChartGrid
              columns={columns}
              rows={rows}
              units={units}
              cellErrors={errors.byCell}
              mainAttributeId={effectiveMainId}
              sent={sent}
              disabled={busy !== null}
              onCellChange={(rowIndex, attributeId, value) => {
                setRows((prev) =>
                  prev.map((r, i) =>
                    i === rowIndex ? { ...r, cells: { ...r.cells, [attributeId]: value } } : r,
                  ),
                );
                // Clear the cell's error the moment it is touched — the legacy
                // screen kept a stale red message until the next full send.
                setValidationErrors((prev) =>
                  prev.filter(
                    (e) => !(e.rowIndex === rowIndex && e.attributeIds.includes(attributeId)),
                  ),
                );
              }}
              onUnitChange={(columnKey, unit) => {
                setUnits((prev) => ({ ...prev, [columnKey]: unit }));
              }}
              onToggleDelete={(rowIndex) => {
                setRows((prev) =>
                  prev.map((r, i) => (i === rowIndex ? { ...r, deleted: !r.deleted } : r)),
                );
              }}
            />

            {overCap && (
              <Alert color="red" variant="light">
                {overCap}
              </Alert>
            )}
          </>
        )}

        <Divider />

        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {canWrite
              ? (blockingError ?? 'Pronto para enviar.')
              : 'Requer permissão de escrita em integrações para enviar ao Mercado Livre.'}
          </Text>
          <Group>
            <Button variant="default" onClick={onClose} disabled={busy !== null}>
              Cancelar
            </Button>
            <Button
              variant="light"
              loading={busy === 'draft'}
              disabled={busy !== null || nome.trim().length === 0 || domainId == null}
              onClick={() => void run('draft')}
            >
              Salvar rascunho
            </Button>
            <Button
              loading={busy === 'send'}
              disabled={busy !== null || !canWrite || blockingError != null || overCap != null}
              onClick={() => void run('send')}
            >
              Enviar ao Mercado Livre
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

/* ------------------------------- helpers --------------------------------- */

/** The chart-level attribute answers a stored guia already carries. */
function seedTemplateValues(chart: MlSizeChart | null): Record<string, ChartSpecValue> {
  const out: Record<string, ChartSpecValue> = {};
  for (const attr of chart?.attributes ?? []) {
    const id = attr.value_id ?? attr.value_name;
    const name = attr.value_name ?? attr.value_id;
    if (id == null || name == null) continue;
    out[attr.id] = { id, name };
  }
  return out;
}

/** The bare grupo id behind the stored `documents/grupoDeVariacoes/<id>` path. */
function grupoIdOf(chart: MlSizeChart | null): string | null {
  const uid = chart?.grupoDeVariacoesUid;
  if (uid == null || uid === '') return null;
  return uid.split('/').filter(Boolean).pop() ?? null;
}

function reportableMessage(err: unknown, fallback: string): string {
  if (err instanceof MercadoLivreClientHttpError) {
    if (err.status === 409) {
      return 'Conta Mercado Livre não conectada — reconecte em Canais de venda.';
    }
    return err.message;
  }
  if (err instanceof MercadoLivreClientNetworkError) {
    return 'Não foi possível contatar o Mercado Livre.';
  }
  return fallback;
}
