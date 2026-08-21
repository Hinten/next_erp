'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Anchor, Badge, Button, Menu, Stack, TextInput } from '@mantine/core';
import { TableView, type VirtualColumn } from '@delfrance/ui';
import type { PipelineFieldFilter } from '@delfrance/data';
import { PERM } from '@delfrance/auth';
import { type Produto, produtoMeta, produtoSchema } from '@delfrance/schemas';
import { usePermission } from '@/lib/auth';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  ProdutoFotoCell,
  ProdutoPrecoCell,
  useListaPrecoPadraoId,
} from './_components/ProdutoListCells';
import { ImportarMercadoLivreModal } from './_components/ImportarMercadoLivreModal';
import { EnviarEstoqueDialog } from './_components/EnviarEstoqueDialog';
import { EnviarPrecoDialog } from './_components/EnviarPrecoDialog';
import { useEnviarEstoqueAction } from './_components/useEnviarEstoqueAction';
import { useEnviarPrecoAction } from './_components/useEnviarPrecoAction';

// U+F8FF: a very high private-use code point. Appended to the search term it
// bounds a nome prefix range (nome >= term && nome <= term + sentinel).
const PREFIX_SENTINEL = '\uf8ff';

/**
 * The nome column, rendered as a LINK rather than left to the generic cell
 * renderer.
 *
 * It has to be a virtual column: `FieldConfig.renderCell(value, row)` receives
 * only the row DATA, and building `/produtos/<id>/editar` needs the document id,
 * which only a virtual column's `SnapshotRow` carries.
 *
 * ⚠️ `dependsOn` is not decoration — TableView projects only the visible
 * columns' fields, so anything read here that is not declared arrives
 * `undefined` at runtime.
 */
const nomeColumn: VirtualColumn<Produto> = {
  key: 'nomeLink',
  label: 'Nome',
  dependsOn: ['nome', 'paiId', 'ehKit'],
  sortField: 'nome',
  renderCell: (row) => (
    <>
      <Anchor
        component={Link}
        href={`/produtos/${row.id}/editar`}
        onClick={(e) => e.stopPropagation()}
      >
        {row.data.nome}
      </Anchor>
      {row.data.paiId && (
        <Badge ml="xs" size="xs" variant="light" color="gray">
          variação
        </Badge>
      )}
      {row.data.ehKit && (
        <Badge ml="xs" size="xs" variant="light" color="grape">
          kit
        </Badge>
      )}
    </>
  ),
};

export default function ProdutosPage() {
  const { allowed: canWritePrecos } = usePermission(PERM.produto.write);
  // Gate the action by the SAME bit the backend route enforces, so a viewer is
  // never offered something that will 403.
  const { allowed: canWriteIntegracao } = usePermission(PERM.integracao.write);
  const { action: enviarEstoqueAction, modal: enviarEstoqueModal } = useEnviarEstoqueAction();
  const { action: enviarPrecoAction, modal: enviarPrecoModal } = useEnviarPrecoAction();
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const trimmed = search.trim();

  /**
   * The nome search stays a page-owned prefix RANGE rather than becoming a
   * generic column filter.
   *
   * TableView's text filter emits `op: 'contains'` — a substring match, which is
   * not index-seekable. On Enterprise that is a full scan billed by data scanned
   * (root CLAUDE.md rule 1). The range below rides the deployed
   * `produtos(paiId ASC, nome ASC)` index, so search costs a seek instead of a
   * table sweep.
   *
   * ⚠️ That index is no longer the one `produtoMeta.defaultQuery` needs — since
   * #159 the browse order is `ultimaModificacao desc`. It is kept in
   * `firestore.indexes.json` FOR THIS SEARCH (and the Nome column sort), and the
   * `searchSort` below is what keeps the query matching it. The index-coverage
   * meta-test only derives indexes from declared default queries, so it will
   * report this one as "unused" — a warning, never a failure. Do not delete it.
   */
  const extraFilters = useMemo<PipelineFieldFilter[]>(
    () =>
      trimmed === ''
        ? []
        : [
            { field: 'nome', op: 'gte', value: trimmed },
            { field: 'nome', op: 'lte', value: `${trimmed}${PREFIX_SENTINEL}` },
          ],
    [trimmed],
  );

  /**
   * While searching, force the sort back to `nome asc`.
   *
   * `produtoMeta.defaultQuery` orders by `ultimaModificacao desc` (#159), but
   * the range above filters `nome` — and Firestore requires an inequality
   * field to be the FIRST orderBy. Leaving the recency sort in place would
   * throw outright on the classic-query fallback and, on the Pipelines path,
   * silently stop using `produtos(paiId, nome)` — turning the seek this search
   * exists to be into the full scan the comment above warns about.
   *
   * `undefined` (not searching) lets `meta.defaultQuery.orderBy` apply. Same
   * coupling, same fix as `alterar-precos/_components/ProdutoPickerModal.tsx`.
   */
  const searchSort = useMemo(
    () => (trimmed === '' ? undefined : { field: 'nome', direction: 'asc' as const }),
    [trimmed],
  );

  const db = getFirebaseFirestore();
  // One read for the whole table, not one per row — see the hook.
  const listaPadraoId = useListaPrecoPadraoId(db);

  // Foto and Preço are virtual columns because neither renders from a projected
  // scalar: `fotos` holds arquivo REFS that need a second read, and the price is
  // `precos[<default lista id>].valor`, a lookup keyed by state outside the row.
  // Both declare `dependsOn`, which is what keeps the Pipelines projection on.
  const virtualColumns = useMemo<ReadonlyArray<VirtualColumn<Produto>>>(
    () => [
      {
        key: 'foto',
        // Legacy's photo column had no header either (produtoTableView.dart:1571).
        label: '',
        dependsOn: ['fotos'],
        width: 56,
        renderCell: (row) => <ProdutoFotoCell db={db} produto={row.data} />,
      },
      nomeColumn,
      {
        key: 'preco',
        label: 'Preço',
        dependsOn: ['precos'],
        renderCell: (row) => <ProdutoPrecoCell produto={row.data} listaPadraoId={listaPadraoId} />,
      },
    ],
    [db, listaPadraoId],
  );

  return (
    <Stack>
      <ImportarMercadoLivreModal db={db} opened={importOpen} onClose={() => setImportOpen(false)} />

      <TextInput
        placeholder="Buscar por nome…"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />

      <TableView
        title="Produtos"
        description="Catálogo, variações e marketplaces"
        schema={produtoSchema}
        collection={produtoCollection}
        db={db}
        // The catalog listing (parents only — #119), its sort, page size AND its
        // column set are all declared once on produtoMeta.defaultQuery, so the
        // query, its projection and its Firestore index stay in lockstep.
        meta={produtoMeta}
        extraFilters={extraFilters}
        forcedOrderBy={searchSort}
        virtualColumns={virtualColumns}
        fields={{
          // The schema field is REPLACED by the `nomeLink` virtual column, not
          // merely left out of the declared columns: the ColumnPicker lists every
          // schema field, so leaving it visible there put two identical "Nome"
          // checkboxes in the picker and let a user toggle on a plain-text
          // duplicate of the linked column.
          nome: { hidden: true },
          publicado: {
            label: 'Status',
            renderCell: (value) =>
              value === true ? (
                <Badge color="green" variant="light">
                  Publicado
                </Badge>
              ) : (
                <Badge color="gray" variant="light">
                  Oculto
                </Badge>
              ),
          },
        }}
        rowHref={(id) => `/produtos/${id}/editar`}
        selectable
        // Both pushes fan out over EVERY channel a produto is listed on, so the
        // list grows with each integration rather than with each channel screen
        // — see `lib/marketplace/push/README.md`.
        actions={canWriteIntegracao ? [enviarPrecoAction, enviarEstoqueAction] : []}
        // The docked rail rather than the top toolbar — the shape
        // /canais/mercado-livre adopted in #816. This screen carries the most
        // controls of any list in the app (Novo, Importar, Preços em massa,
        // Enviar preços, Enviar estoque), and the rail gives every one of them
        // a labelled full-width button instead of crowding the header. Its
        // `renderActionsPanelExtra` slot is also the only place a push's
        // progress could live on screen, if either ever becomes a background
        // job — today both are synchronous and report inside their dialog.
        // ⚠️ The rail REPLACES the top ActionBar (TableView guards that on
        // `!panelEnabled`), so the buttons below now render INSIDE it — hence
        // the vertical Stack and `fullWidth`.
        actionsPanel={{ width: 300 }}
        renderNewButton={() => (
          <Stack gap="xs">
            <Button fullWidth component={Link} href="/produtos/novo">
              Novo produto
            </Button>
            <Button fullWidth variant="default" onClick={() => setImportOpen(true)}>
              Importar do Mercado Livre
            </Button>
            {canWritePrecos && (
              <Menu withinPortal position="bottom-end" shadow="md">
                <Menu.Target>
                  <Button fullWidth variant="default">
                    Preços em massa
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item component={Link} href="/produtos/recalcular-precos">
                    Recalcular preços
                  </Menu.Item>
                  <Menu.Item component={Link} href="/produtos/alterar-precos">
                    Alterar preços em massa
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
          </Stack>
        )}
      />

      {/* Mounted fresh per run: the dialog's initial state IS its reset, which
          is what re-arms each checkbox to its safe default every time instead
          of remembering the last choice. */}
      {enviarEstoqueModal.opened && (
        <EnviarEstoqueDialog
          key={enviarEstoqueModal.alvos.map((a) => a.produtoId).join(',')}
          opened
          alvos={enviarEstoqueModal.alvos}
          onClose={enviarEstoqueModal.close}
        />
      )}
      {enviarPrecoModal.opened && (
        <EnviarPrecoDialog
          key={enviarPrecoModal.alvos.map((a) => a.produtoId).join(',')}
          opened
          alvos={enviarPrecoModal.alvos}
          onClose={enviarPrecoModal.close}
        />
      )}
    </Stack>
  );
}
