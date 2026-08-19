'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Autocomplete,
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
  type ChartCellKind,
  type ChartMeasureType,
  type ChartSpecValue,
  chartLevelAttributes,
  detectMeasureTypes,
  draftChartAttributeValue,
  extractColumns,
  extractGridTemplates,
  mainAttributeCandidates,
  maxRows as gridMaxRows,
  resolveChartAttributeValue,
} from '@/lib/mercado-livre/chartSpec';
import { SizeChartConflictError } from '@/lib/mercado-livre/chartConflict';
import { buildChartAiGrid, chartAiGridIsFillable } from '@/lib/mercado-livre/chartAiGrid';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreChartValidationError,
  type MercadoLivreClient,
  type MercadoLivreMedidasFatos,
  type MercadoLivreMedidasSugestao,
} from '@/lib/mercado-livre/client';
import {
  describeMercadoLivreFailure,
  mercadoLivreErrorMessage,
  mercadoLivreQueryRetry,
} from '@/lib/mercado-livre/errors';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';
import { SizeChartAiModal } from './SizeChartAiModal';
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
  /** The tabela this guia belongs to — the AI agent reads its photo and descrição. */
  tabMediId: string;
  /**
   * The tabela's fields as the FORM has them, read at click time.
   *
   * ⚠️ A getter, not values. The AI request must see a descrição typed but not
   * saved — the stored document does not have it — and passing the values down
   * would re-render this modal on every keystroke anywhere in the ObjectView.
   */
  getFatos: () => MercadoLivreMedidasFatos;
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
  tabMediId,
  getFatos,
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

  /**
   * AI fill. `aiOpen` with a null `aiResult` is the loading state — the modal
   * opens immediately so the operator sees the call is running, and fills in
   * when it answers.
   */
  const [aiOpen, setAiOpen] = useState(false);
  const [aiResult, setAiResult] = useState<MercadoLivreMedidasSugestao | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  /**
   * Bumped per run and used as the review modal's `key`, so each run gets a
   * FRESH component.
   *
   * ⚠️ The modal is rendered unconditionally — only Mantine's `Modal` body
   * unmounts on close — so its checkbox state survived close → re-open. On a
   * second run in the same editor session that state was still in force, and a
   * cell the operator had meanwhile filled arrived **pre-checked** with the
   * "será substituída" badge: exactly what the modal's own contract says must
   * never happen. Remounting is cheaper and harder to get wrong than syncing.
   */
  const [aiRun, setAiRun] = useState(0);

  /* -------------------------------- specs -------------------------------- */

  const domainsQuery = useQuery({
    queryKey: ['ml-chart-domains', integracaoId],
    queryFn: () => client.sizeChartDomains(integracaoId),
    enabled: opened,
    retry: mercadoLivreQueryRetry,
  });

  // Step 1: the DOMAIN spec names the questions (GENDER, …) ML wants answered.
  const domainSpecsQuery = useQuery({
    queryKey: ['ml-chart-domain-specs', integracaoId, domainId],
    queryFn: () => client.sizeChartSpecs({ integracaoId, domainId: domainId! }),
    enabled: opened && domainId != null,
    retry: mercadoLivreQueryRetry,
  });

  const templates = useMemo(
    () => (domainSpecsQuery.data ? extractGridTemplates(domainSpecsQuery.data) : []),
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
    retry: mercadoLivreQueryRetry,
  });

  /**
   * The chart-level questions to RENDER and to send in the chart body.
   *
   * ⚠️ BOTH specs go in, and the split matters: the domain spec supplies the
   * templates and every attribute's rendering metadata, while the GRID spec is
   * what decides which OTHER attributes belong at chart level at all. Deriving
   * that from the domain spec offered a "Modelo" field ML rejects outright —
   * `grid_filter` is the chart-search vocabulary there, not the chart's own
   * attributes. So the non-template fields (Marca, …) appear once the grid spec
   * lands, which is exactly ML's own order.
   *
   * `specAttributes` above stays templates-only on purpose — that is the body ML
   * wants for the `?section=grids` lookup, and feeding it `chartLevel` would
   * make the query depend on its own result.
   */
  const chartLevel = useMemo(
    () => chartLevelAttributes(domainSpecsQuery.data ?? null, gridSpecsQuery.data ?? null),
    [domainSpecsQuery.data, gridSpecsQuery.data],
  );

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

  /* ---------------------------------- IA --------------------------------- */

  /**
   * The grid, in the wire shape the suggestion route understands.
   *
   * A `LINKED_BY_CONNECTOR_INPUT` column contributes TWO entries — one per part
   * — because the model answers per attribute id, and a range whose `_FROM` and
   * `_TO` were folded into one entry could not be filled at all.
   */
  /**
   * The grid as the request will describe it.
   *
   * ⚠️ Derived ONCE and used by both the button's enable-guard and the payload.
   * They used to disagree: the guard counted `rows`/`columns` while this filtered
   * deleted rows and the main-attribute column out, so a grid that looked
   * populated could send an empty one and come back
   * "Monte a grade da guia antes de pedir sugestões".
   */
  const aiGrid = useMemo(
    () => buildChartAiGrid({ rows, columns, units, mainAttributeId: effectiveMainId }),
    [rows, columns, units, effectiveMainId],
  );

  async function runAi() {
    setAiBusy(true);
    setAiResult(null);
    setAiRun((n) => n + 1);
    setAiOpen(true);
    try {
      setAiResult(
        await client.sugerirMedidas({
          tabMediId,
          rows: aiGrid.rows,
          columns: aiGrid.columns,
          measureType: effectiveMeasureType,
          mainAttributeId: effectiveMainId,
          // So the chart being edited is never offered back to the model as its
          // own reference.
          chartId: chart?.id ?? null,
          // The tabela's fields as the FORM has them — unsaved edits included.
          fatos: getFatos(),
        }),
      );
    } catch (err) {
      // Close rather than leave the modal spinning forever; the message carries
      // the backend's own wording, including the kill-switch and timeout cases.
      setAiOpen(false);
      if (
        err instanceof MercadoLivreClientHttpError ||
        err instanceof MercadoLivreClientNetworkError
      ) {
        notifications.show({
          color: 'red',
          title: 'Não foi possível preencher com IA',
          // This route answers 409 for AI_DESATIVADA, AI_PROVEDOR_NAO_SUPORTADO
          // and AI_JA_EM_ANDAMENTO, so the backend's own wording has to survive.
          // Safe through the shared mapper because it keys the reconnect copy on
          // ML_REAUTH_REQUIRED rather than on the 409 status.
          message: mercadoLivreErrorMessage(err, {
            unknown: 'Não foi possível preencher a guia com IA.',
          }),
        });
        return;
      }
      throw err;
    } finally {
      setAiBusy(false);
    }
  }

  /** Which widget each attribute renders as — the cell shape depends on it. */
  const partKindById = useMemo(() => {
    const out = new Map<string, ChartCellKind>();
    for (const column of allColumns) {
      for (const part of column.parts) out.set(part.attributeId, part.kind);
    }
    return out;
  }, [allColumns]);

  /**
   * A suggestion in the cell shape its column actually reads.
   *
   * ⚠️ `SizeChartGrid`'s inputs read a DIFFERENT field per kind — `select` takes
   * `value_id`, `multiselect` takes `valueList`, text/number take `value_name`.
   * Writing one shape for all of them left a confirmed multiselect suggestion
   * rendering as an empty field while `toWireAttributes` still shipped it to ML,
   * in the single-valued shape.
   */
  function aiCellValue(s: MercadoLivreMedidasSugestao['sugestoes'][number]): ChartCellValue {
    if (partKindById.get(s.attributeId) === 'multiselect') {
      return {
        value_id: null,
        value_name: null,
        valueList: [{ id: s.value_id ?? '', name: s.value_name }],
      };
    }
    return { value_id: s.value_id, value_name: s.value_name, valueList: null };
  }

  /**
   * Whether a suggestion can actually be shown in its cell once applied.
   *
   * A `select` renders from `value_id`, so a free-text value the applier could
   * not match to an option would land as a visibly EMPTY cell that nonetheless
   * ships to ML. Offering it would be worse than dropping it: the operator ticks
   * a row, sees nothing change, and only finds out at send time.
   */
  function aiApplicable(s: MercadoLivreMedidasSugestao['sugestoes'][number]): boolean {
    return partKindById.get(s.attributeId) !== 'select' || s.value_id != null;
  }

  /** Write the accepted cells in, reusing the same path a typed edit takes. */
  function applyAi(aceitas: MercadoLivreMedidasSugestao['sugestoes']) {
    const byRow = new Map<string, typeof aceitas>();
    for (const s of aceitas) {
      byRow.set(s.rowKey, [...(byRow.get(s.rowKey) ?? []), s]);
    }
    setRows((prev) =>
      prev.map((row) => {
        const mine = byRow.get(row.key);
        if (!mine) return row;
        const cells = { ...row.cells };
        for (const s of mine) {
          cells[s.attributeId] = aiCellValue(s);
        }
        return { ...row, cells };
      }),
    );
    // Clear any ML error on a cell we just changed — same rule as a typed edit,
    // where a stale red message on a corrected cell is worse than none.
    const touched = new Set(aceitas.map((s) => `${s.rowKey}::${s.attributeId}`));
    setValidationErrors((prev) =>
      prev.filter((e) => {
        const row = e.rowIndex == null ? null : rows[e.rowIndex];
        if (row == null) return true;
        return !e.attributeIds.some((id) => touched.has(`${row.key}::${id}`));
      }),
    );
  }

  /* ------------------------------- assembly ------------------------------ */

  function buildChart(): MlSizeChart {
    // `chartLevel` is already deduplicated by id, so no second pass is needed.
    const attributes = chartLevel.flatMap((t) => {
      const draft = templateValues[t.id];
      if (!draft) return [];
      // A free-text draft is still RAW here: the field keeps what the operator
      // typed so a space is typeable, and blur resolving it is only a
      // convenience — sending from an unblurred field would otherwise ship the
      // untrimmed text. An id-bearing pick came from the Select and is already
      // ML's own value.
      const picked = draft.id === '' ? resolveChartAttributeValue(t, draft.name) : draft;
      if (!picked) return [];
      // A free-text value carries no id — sending an invented `value_id` is
      // rejected, so it goes up as a name only.
      return [
        {
          id: t.id,
          ...(picked.id === '' ? {} : { value_id: picked.id }),
          value_name: picked.name,
        },
      ];
    });
    return {
      ...(chart ?? {}),
      id: chart?.id ?? null,
      nome: nome.trim(),
      domain_id: domainId ?? '',
      tipo: effectiveMeasureType,
      main_attribute_id: effectiveMainId,
      grupoDeVariacoesUid: grupoId == null ? null : `documents/grupoDeVariacoes/${grupoId}`,
      attributes,
      main_attribute: chart?.main_attribute ?? [],
      rows: toChartRows(rows, allColumns, units, chart),
    };
  }

  // ML requires BRAND alongside GENDER in the chart body, so a required
  // chart-level attribute left blank is a rejection waiting to happen — block
  // it here rather than after the round trip.
  const missingRequired = chartLevel.find((t) => t.required && templateValues[t.id] == null);

  const blockingError =
    validateChartName(nome) ??
    (domainId == null ? 'Selecione o domínio.' : null) ??
    (answered ? null : 'Responda os atributos da guia.') ??
    (missingRequired ? `Informe ${missingRequired.name}.` : null) ??
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
          message: mercadoLivreErrorMessage(err, {
            unknown: 'Falha ao salvar a guia de tamanhos.',
          }),
        });
      } else {
        throw err;
      }
    } finally {
      setBusy(null);
    }
  }

  /* -------------------------------- render ------------------------------- */

  /*
    In chain order — a grid-spec failure is usually a consequence of the domain
    one, so the operator hears about the first link first. `queryRetry` re-runs
    ONLY the link that failed: `refetch()` ignores `enabled`, so retrying all
    three would fire `sizeChartSpecs` with a null `domainId`.
  */
  const specs = queryRetry(domainsQuery, domainSpecsQuery, gridSpecsQuery);
  const specsFailure =
    specs.error == null
      ? null
      : describeMercadoLivreFailure(specs.error, {
          unknown: 'Não foi possível carregar as especificações do domínio.',
        });
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

            {chartLevel.map((template) => {
              const setValue = (picked: ChartSpecValue | null) => {
                setTemplateValues((prev) => {
                  const next = { ...prev };
                  if (picked) next[template.id] = picked;
                  else delete next[template.id];
                  return next;
                });
              };

              // A CLOSED list (GENDER) gets a Select; everything else is free
              // text with ML's known values as suggestions — BRAND accepts any
              // brand, and a Select there blocks every one ML has not seen.
              return template.kind === 'select' ? (
                <Select
                  key={template.id}
                  label={template.name}
                  placeholder={`Selecione: ${template.name}`}
                  data={template.values.map((v) => ({ value: v.id, label: v.name }))}
                  value={templateValues[template.id]?.id ?? null}
                  onChange={(id) => {
                    setValue(template.values.find((v) => v.id === id) ?? null);
                  }}
                  disabled={sent}
                  required={template.required}
                  searchable
                />
              ) : (
                <Autocomplete
                  key={template.id}
                  label={template.name}
                  placeholder={`Informe ${template.name}`}
                  description={
                    template.values.length > 0
                      ? 'Escolha uma das sugestões ou digite outro valor.'
                      : undefined
                  }
                  data={template.values.map((v) => v.name)}
                  value={templateValues[template.id]?.name ?? ''}
                  // Raw while typing, resolved on blur — resolving on change
                  // rewrites the text under the caret and eats every space.
                  onChange={(typed) => {
                    setValue(draftChartAttributeValue(typed));
                  }}
                  onBlur={() => {
                    const current = templateValues[template.id];
                    if (!current || current.id !== '') return; // nothing typed / already an ML value
                    const resolved = resolveChartAttributeValue(template, current.name);
                    if (resolved?.id === current.id && resolved.name === current.name) return;
                    setValue(resolved);
                  }}
                  disabled={sent}
                  required={template.required}
                />
              );
            })}

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

        {specsFailure && (
          <RetryAlert
            title="Não foi possível carregar os dados do Mercado Livre"
            message={specsFailure.message}
            onRetry={specsFailure.retryable ? specs.retry : undefined}
            retrying={specs.retrying}
          />
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

        {/*
          Outside the `allColumns.length > 0` block on purpose. The grid loads
          from Mercado Livre, so gating the control on it would hide the feature
          entirely whenever that call has not answered — the operator would never
          learn it exists, and the affordance would be untestable without a live
          backend. Rendering it always, disabled until there is something to
          fill, says "this exists, it is not ready yet".
        */}
        <Group justify="space-between" align="flex-end">
          <Text size="sm" c="dimmed">
            Preencha a grade a partir da foto da tabela do fornecedor.
          </Text>
          <Button
            size="compact-sm"
            variant="light"
            onClick={() => void runAi()}
            loading={aiBusy}
            // Nothing to fill without a grid, and the route rejects an empty one
            // anyway — better to disable than to spend a round trip on a
            // guaranteed 422. ⚠️ Reads `aiGrid`, the SAME derivation the request
            // sends: counting `rows`/`columns` here let a grid that looks
            // populated (every row deleted, or only the size column visible)
            // enable the button and come back "Monte a grade da guia antes de
            // pedir sugestões".
            disabled={!canWrite || busy !== null || !chartAiGridIsFillable(aiGrid)}
            data-testid="ml-size-chart-ai-fill"
          >
            Preencher com IA
          </Button>
        </Group>

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

      <SizeChartAiModal
        key={aiRun}
        opened={aiOpen}
        onClose={() => setAiOpen(false)}
        resultado={
          aiResult == null
            ? null
            : { ...aiResult, sugestoes: aiResult.sugestoes.filter(aiApplicable) }
        }
        rows={rows}
        columns={columns}
        mainAttributeId={effectiveMainId}
        onApply={applyAi}
      />
    </Modal>
  );
}

/* ------------------------------- helpers --------------------------------- */

/** The chart-level attribute answers a stored guia already carries. */
function seedTemplateValues(chart: MlSizeChart | null): Record<string, ChartSpecValue> {
  const out: Record<string, ChartSpecValue> = {};
  for (const attr of chart?.attributes ?? []) {
    const name = attr.value_name ?? attr.value_id;
    if (name == null) continue;
    // ⚠️ An ABSENT `value_id` stays absent (''), never backfilled from the name.
    // A free-text value (BRAND) has no id, and inventing one would send it back
    // to ML as a `value_id` it has never heard of.
    out[attr.id] = { id: attr.value_id ?? '', name };
  }
  return out;
}

/** The bare grupo id behind the stored `documents/grupoDeVariacoes/<id>` path. */
function grupoIdOf(chart: MlSizeChart | null): string | null {
  const uid = chart?.grupoDeVariacoesUid;
  if (uid == null || uid === '') return null;
  return uid.split('/').filter(Boolean).pop() ?? null;
}
