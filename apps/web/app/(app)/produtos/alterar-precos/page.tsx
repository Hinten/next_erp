'use client';

/**
 * Bulk manual price editor (#545) — port of the Flutter
 * `alterarPrecoMassa.dart` screen (`AlterarPrecoMassaView`). The user hand-picks
 * a produto set (search + add-selected / add-filtered via `ProdutoPickerModal`),
 * ONE target lista de preços, ONE strategy (the issue drops legacy's
 * regra-stacking loop), previews old→new per produto live, and applies with
 * aumentar/baixar direction toggles (legacy default: aumentar=true,
 * baixar=false — never lowers an existing price unless opted in; a produto
 * with no existing price always applies).
 *
 * Gated on `produto.write` (this writes every selected produto's `precos`
 * map) — matches the sibling #544 recalculation screen's gating.
 *
 * All top-level state lives here (rather than a separate `*Screen.tsx` like
 * the #544 sibling) — this route has no `?listaId=` deep-link, so there's no
 * `useSearchParams`/`Suspense` boundary to isolate, and the module is scoped
 * to exactly four files (this page + `RegraForm` + `PreviewList` +
 * `AplicarDialog`). The stateful body is split into `AlterarPrecosContent`
 * so its hooks only ever run once `RequirePerm` has actually granted access
 * (mirrors `RecalcularPrecosPage`'s split, just inlined into one file).
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Checkbox, Group, Paper, Select, Stack, Text } from '@mantine/core';
import { IconDownload, IconPlus } from '@tabler/icons-react';
import { PageHeader } from '@delfrance/ui';
import { PERM } from '@delfrance/auth';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';

import { RequirePerm } from '@/lib/auth';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { saveBlob } from '@/lib/nfe/saveBlob';
import type { ProdutoPrecoRow } from '@/lib/produtos/bulkPreco/loadCatalogo';
import {
  defaultsFor,
  regraSchema,
  type RegraInput,
  type RegraOutput,
} from '@/lib/produtos/bulkPreco/regraSchema';
import { buildPreviewRows } from '@/lib/produtos/bulkPreco/strategies';

import { AplicarDialog } from './_components/AplicarDialog';
import { alterarPrecoCsvFilename, buildAlterarPrecoCsv } from './_components/alterarPrecoCsv';
import { PreviewList } from './_components/PreviewList';
import { ProdutoPickerModal } from './_components/ProdutoPickerModal';
import { RegraForm } from './_components/RegraForm';

function AlterarPrecosContent() {
  const db = useMemo(() => getFirebaseFirestore(), []);

  // Every ACTIVE lista de preços, nome-ordered — the same SERVER-side
  // `ativo == true` filter the legacy `SeletorTabelaDePrecosWidget` applies
  // (`.old/lib/pedido/widgets.dart:65`: `ativo__isEqualTo(true)`). Filtering
  // client-side AFTER `limit(200)` could silently hide active listas whose
  // nome sorts past 200 inactive ones; Enterprise Firestore runs the
  // unindexed equality as a scan (tiny collection), never throws.
  const listasQuery = useMemo(
    () =>
      buildQuery(listaDePrecosCollection.ref(db, {}), [
        whereEqual('ativo', true),
        orderByField('nome'),
        limit(200),
      ]),
    [db],
  );
  const listasSnap = useSnapshot(listasQuery);
  const listasAtivas = useMemo(() => listasSnap.data ?? [], [listasSnap.data]);
  const listaOptions = useMemo(
    () => listasAtivas.map((r) => ({ value: r.id, label: r.data.nome })),
    [listasAtivas],
  );

  // Insertion-ordered (a `Map` preserves insertion order) — legacy dedup:
  // `handleInclude` skips ids already present rather than replacing them.
  const [selecionados, setSelecionados] = useState<Map<string, ProdutoPrecoRow>>(new Map());
  const [targetListaId, setTargetListaId] = useState<string | null>(null);
  const [pickerOpened, setPickerOpened] = useState(false);
  const [aplicarOpened, setAplicarOpened] = useState(false);
  // Legacy defaults: aumentar=true, baixar=false (`alterarPrecoMassa.dart:149-150`).
  const [aumentar, setAumentar] = useState(true);
  const [baixar, setBaixar] = useState(false);

  const form = useForm<RegraInput, unknown, RegraOutput>({
    resolver: zodResolver(regraSchema),
    defaultValues: defaultsFor('detalhado'),
    mode: 'onChange',
  });
  // Watch the WHOLE object rather than a single named field — react-hook-form's
  // `Path<T>` doesn't resolve per-branch field names cleanly for a Zod
  // discriminated union (`RegraInput`), but the plain object shape is
  // unambiguous. `tipo` is then a simple property read off it.
  const regraValues = useWatch({ control: form.control });
  const tipo = regraValues.tipo;
  const isValid = form.formState.isValid;

  // RHF doesn't re-validate on `reset()`/mount by itself — trigger explicitly
  // whenever the strategy (and therefore the whole default set) changes, so
  // `formState.isValid` (and the live preview it gates) is correct immediately,
  // without requiring the user to touch a field first.
  useEffect(() => {
    void form.trigger();
  }, [tipo, form]);

  const produtosArray = useMemo(() => Array.from(selecionados.values()), [selecionados]);

  // Defer both the regra parse and the (potentially large) preview build so
  // fast typing in the regra form never blocks the input itself.
  const deferredRegraValues = useDeferredValue(regraValues);
  const deferredIsValid = useDeferredValue(isValid);

  const regra = useMemo(() => {
    if (!deferredIsValid) return null;
    const parsed = regraSchema.safeParse(deferredRegraValues);
    return parsed.success ? parsed.data : null;
    // Keyed on the STRINGIFIED value on purpose: `useWatch()` hands back a new
    // object reference on every keystroke even when the resolved value is
    // unchanged (e.g. toggling focus in/out of an already-valid field) —
    // stringifying avoids re-parsing (and, downstream, rebuilding the whole
    // preview) for a no-op change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredIsValid, JSON.stringify(deferredRegraValues)]);

  const previewRows = useMemo(() => {
    if (!targetListaId || !regra) return [];
    return buildPreviewRows(produtosArray, targetListaId, regra);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [produtosArray, targetListaId, JSON.stringify(regra)]);

  const handleInclude = useCallback((rows: ProdutoPrecoRow[]) => {
    setSelecionados((prev) => {
      const next = new Map(prev);
      for (const row of rows) {
        if (!next.has(row.id)) next.set(row.id, row);
      }
      return next;
    });
  }, []);

  const handleRemove = useCallback((produtoId: string) => {
    setSelecionados((prev) => {
      if (!prev.has(produtoId)) return prev;
      const next = new Map(prev);
      next.delete(produtoId);
      return next;
    });
  }, []);

  const selectedLista = listasAtivas.find((r) => r.id === targetListaId)?.data ?? null;

  const handleBaixarRelatorio = useCallback(() => {
    saveBlob(
      new Blob([buildAlterarPrecoCsv(previewRows)], { type: 'text/csv;charset=utf-8' }),
      alterarPrecoCsvFilename(selectedLista?.nome ?? 'lista', new Date()),
    );
  }, [previewRows, selectedLista]);

  const handleApplied = useCallback(() => {
    setSelecionados(new Map());
  }, []);

  const podeAplicar = selecionados.size > 0 && targetListaId !== null && isValid;

  return (
    <Stack>
      <PageHeader
        title="Alterar Preço em Massa"
        description="Aplica uma estratégia de preço a um conjunto de produtos"
      />

      <Paper withBorder p="md" radius="md">
        <Stack>
          <Group align="flex-end" justify="space-between" wrap="wrap">
            <Select
              label="Lista de preços"
              placeholder={listasSnap.loading ? 'Carregando…' : 'Selecione uma lista de preços'}
              data={listaOptions}
              value={targetListaId}
              onChange={setTargetListaId}
              searchable
              clearable
              style={{ minWidth: 260 }}
            />
            <Group>
              <Text size="sm" c="dimmed">
                {selecionados.size} produto(s) selecionado(s)
              </Text>
              <Button leftSection={<IconPlus size={16} />} onClick={() => setPickerOpened(true)}>
                Adicionar produtos
              </Button>
            </Group>
          </Group>

          {listasSnap.error && (
            <Text size="sm" c="red">
              Erro ao carregar listas de preços: {listasSnap.error.message}
            </Text>
          )}

          <RegraForm form={form} listaOptions={listaOptions} targetListaId={targetListaId} />
        </Stack>
      </Paper>

      <PreviewList
        rows={previewRows}
        targetListaId={targetListaId}
        isValid={isValid}
        totalSelecionados={selecionados.size}
        onRemove={handleRemove}
      />

      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <Group gap="lg">
            <Checkbox
              label="Aumentar preços"
              checked={aumentar}
              onChange={(e) => setAumentar(e.currentTarget.checked)}
            />
            <Checkbox
              label="Baixar preços"
              checked={baixar}
              onChange={(e) => setBaixar(e.currentTarget.checked)}
            />
          </Group>
          <Stack gap={4} align="flex-end">
            {!podeAplicar && (
              <Text size="xs" c="dimmed">
                Selecione produtos, uma tabela de preços e complete a regra para aplicar.
              </Text>
            )}
            <Group>
              <Button
                variant="default"
                leftSection={<IconDownload size={16} />}
                disabled={previewRows.length === 0}
                onClick={handleBaixarRelatorio}
              >
                Baixar Relatório
              </Button>
              <Button disabled={!podeAplicar} onClick={() => setAplicarOpened(true)}>
                Aplicar
              </Button>
            </Group>
          </Stack>
        </Group>
      </Paper>

      <ProdutoPickerModal
        opened={pickerOpened}
        onClose={() => setPickerOpened(false)}
        onInclude={handleInclude}
      />

      {targetListaId && (
        <AplicarDialog
          opened={aplicarOpened}
          onClose={() => setAplicarOpened(false)}
          db={db}
          targetListaId={targetListaId}
          listaNome={selectedLista?.nome ?? 'lista'}
          rows={previewRows}
          aumentar={aumentar}
          baixar={baixar}
          onApplied={handleApplied}
        />
      )}
    </Stack>
  );
}

export default function AlterarPrecosPage() {
  return (
    <RequirePerm bit={PERM.produto.write} redirectTo="/produtos">
      <AlterarPrecosContent />
    </RequirePerm>
  );
}
