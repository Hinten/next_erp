'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Anchor, Badge, Button, Menu, Stack } from '@mantine/core';
import { TableView, type VirtualColumn } from '@delfrance/ui';
import type { PipelineFieldFilter } from '@delfrance/data';
import { PERM } from '@delfrance/auth';
import { type Produto, produtoMeta, produtoSchema } from '@delfrance/schemas';
import { usePermission } from '@/lib/auth';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { useIntegracoes } from '@/lib/data/useIntegracoes';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useListasDePrecos } from '@/lib/data/useListasDePrecos';
import { resolveProdutoIdsPorTermo } from '@/lib/produtos/buscaProduto';
import {
  ProdutoFotoCell,
  ProdutoIntegracoesCell,
  ProdutoPrecoCell,
} from './_components/ProdutoListCells';
import { IntegracoesColumnFilter } from './_components/IntegracoesColumnFilter';
import { ImportarMercadoLivreModal } from './_components/ImportarMercadoLivreModal';
import { EnviarEstoqueDialog } from './_components/EnviarEstoqueDialog';
import { EnviarPrecoDialog } from './_components/EnviarPrecoDialog';
import { PausarAnunciosDialog } from './_components/PausarAnunciosDialog';
import { useEnviarEstoqueAction } from './_components/useEnviarEstoqueAction';
import { useEnviarPrecoAction } from './_components/useEnviarPrecoAction';
import { usePausarAnunciosAction } from './_components/usePausarAnunciosAction';

// U+F8FF: a very high private-use code point. Appended to the search term it
// bounds a nome prefix range (nome >= term && nome <= term + sentinel).
const PREFIX_SENTINEL = '\uf8ff';

/**
 * The search box — ONE input serving two very different lookups, handed to
 * `TableView` rather than owned by this page.
 *
 * That is what puts the term in the URL as `?q=`, and with it in the sticky
 * list memory — a page-owned `useState` was reset every time an operator opened
 * a produto and came back.
 *
 * The nome search stays a prefix RANGE rather than becoming a generic column
 * filter. TableView's text filter emits `op: 'contains'` — a substring match,
 * which is not index-seekable. On Enterprise that is a full scan billed by data
 * scanned (root CLAUDE.md rule 1). The range below rides the deployed
 * `produtos(paiId ASC, nome ASC)` index, so search costs a seek instead of a
 * table sweep.
 *
 * ⚠️ That index is no longer the one `produtoMeta.defaultQuery` needs — since
 * #159 the browse order is `ultimaModificacao desc`. It is kept in
 * `firestore.indexes.json` FOR THIS SEARCH (and the Nome column sort), and
 * `toForcedOrderBy` below is what keeps the query matching it. The
 * index-coverage meta-test only derives indexes from declared default queries,
 * so it will report this one as "unused" — a warning, never a failure. Do not
 * delete it.
 *
 * ⚠️ `toForcedOrderBy` forces `nome asc` while searching because Firestore
 * requires an inequality field to be the FIRST orderBy. Leaving the recency
 * sort in place would throw outright on the classic-query fallback and, on the
 * Pipelines path, silently stop using `produtos(paiId, nome)` — turning the
 * seek this search exists to be into the full scan above. `undefined` when not
 * searching lets `produtoMeta.defaultQuery.orderBy` apply. Same coupling, same
 * fix as `alterar-precos/_components/ProdutoPickerModal.tsx`.
 *
 * ⚠️ The second lookup is `resolveIds`, and it is what makes the box smart:
 * a marketplace item id (`MLB1234567890`) names no field on `produtos` at all
 * — it lives in a link SUBCOLLECTION — so it has to be resolved to produto
 * ids by query first. `resolveIds` returning `null` is what hands the term
 * back to the nome range above, which is the whole mechanism behind one box
 * doing both. See `resolveProdutoIdsPorTermo`.
 *
 * ⚠️ It also resolves the produto's own DOCUMENT id, and the URL carrying it —
 * `/produtos/<id>/editar` is what every row here links to, so that id is in
 * the address bar of every produto an operator has open. The id is read from
 * the segment after `produtos`, never the last one, or the term resolves to
 * `editar`. A PATH-shaped miss is reported as handled rather than handed back:
 * a URL is an operator naming ONE produto, so its miss is an answer, while a
 * BARE id stays ambiguous — the legacy import wrote seller SKUs in as produto
 * ids, so a bare token can be either.
 *
 * ⚠️ Module-level, and `resolveIds` reaches for the Firestore singleton
 * itself rather than closing over a prop. Its identity is a dependency of the
 * resolution effect: an inline arrow would be a new function every render,
 * re-running the effect, setting state, and re-rendering — a loop, not a
 * slowdown.
 */
const produtoSearch = {
  placeholder: 'Buscar por nome, SKU, ID do produto ou do anúncio…',
  toFilters: (term: string): PipelineFieldFilter[] => {
    const trimmed = term.trim();
    return trimmed === ''
      ? []
      : [
          { field: 'nome', op: 'gte', value: trimmed },
          { field: 'nome', op: 'lte', value: `${trimmed}${PREFIX_SENTINEL}` },
        ];
  },
  toForcedOrderBy: (term: string) =>
    term.trim() === '' ? undefined : { field: 'nome', direction: 'asc' as const },
  resolveIds: (term: string) => resolveProdutoIdsPorTermo(getFirebaseFirestore(), term),
};

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
  const { action: pausarAnunciosAction, modal: pausarAnunciosModal } = usePausarAnunciosAction();
  const [importOpen, setImportOpen] = useState(false);

  const db = getFirebaseFirestore();
  // One read for the whole table, not one per row — see the hook. It serves
  // BOTH halves of the Preço column: the default lista's value inline and the
  // names behind its "ver todos os preços" button.
  const { rows: listasDePrecos, padraoId: listaPadraoId } = useListasDePrecos(db);
  // Same deal for the Canais de venda column: `integracoesComProduto` stores
  // bare integração ids, so the names and colours come from one cached read of
  // the (tiny) `integracao` collection, shared with the pickers.
  const {
    rows: integracoes,
    byId: integracoesById,
    status: integracoesStatus,
  } = useIntegracoes(db);

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
        // ⚠️ `nome` and `sku` are here for the price modal's TITLE, not for the
        // cell. They happen to be projected anyway because their own columns
        // are visible — which is exactly why they must be declared: a column
        // that reads a field it did not declare works right up until the
        // column that did stops being shown, and then reads `undefined`.
        dependsOn: ['precos', 'nome', 'sku'],
        renderCell: (row) => (
          <ProdutoPrecoCell
            produto={row.data}
            listas={listasDePrecos}
            listaPadraoId={listaPadraoId}
          />
        ),
      },
      {
        // Legacy's "Canais de Venda" column, finally joined (#159 deferred it).
        key: 'integracoes',
        label: 'Canais de venda',
        dependsOn: ['integracoesComProduto'],
        renderCell: (row) => (
          <ProdutoIntegracoesCell
            produto={row.data}
            byId={integracoesById}
            status={integracoesStatus}
          />
        ),
        // ⚠️ Deliberately NO `sortField`. Firestore would accept
        // `orderBy('integracoesComProduto')`, but it orders by the ARRAY — i.e.
        // by the first integração's random document id, which is not an order
        // anyone can read. Sorting by NAME needs a join Firestore cannot do, or
        // a denormalized name array kept in sync by a trigger plus a backfill.
        // The badges are sorted by nome inside the cell instead, and the filter
        // below does the grouping work.
        filter: {
          field: 'integracoesComProduto',
          label: 'Canais de venda',
          renderFilter: ({ value, onChange }) => (
            <IntegracoesColumnFilter integracoes={integracoes} value={value} onChange={onChange} />
          ),
          // The stored value is a list of bare integração ids, so the
          // active-filter chip would otherwise read "2 selecionados". Same
          // lookup the cell badges use.
          formatValue: (value) =>
            (Array.isArray(value) ? value : [String(value)])
              .map((id) => integracoesById.get(id)?.nome ?? id)
              .join(', '),
        },
      },
    ],
    [db, listasDePrecos, listaPadraoId, integracoes, integracoesById, integracoesStatus],
  );

  return (
    <Stack>
      <ImportarMercadoLivreModal db={db} opened={importOpen} onClose={() => setImportOpen(false)} />

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
        search={produtoSearch}
        // The column set is FIXED here (`produtoMeta.defaultQuery.columns`),
        // so there is no ⚙ to open. That also takes the per-browser column
        // memory out of play, which is the point rather than a side effect:
        // this screen's read cost is its column set, and a saved set nobody
        // can see or edit would decide it. See the prop's jsdoc.
        showColumnPicker={false}
        virtualColumns={virtualColumns}
        fields={{
          // The schema field is REPLACED by the `nomeLink` virtual column, not
          // merely left out of the declared columns: without `hidden` the
          // ColumnPicker offers every schema field, which put two identical
          // "Nome" checkboxes in the picker and let a user toggle on a
          // plain-text duplicate of the linked column.
          nome: { hidden: true },
          // Same reason as `nome`: the `integracoes` virtual column REPLACES
          // this field. Left visible, the ColumnPicker would offer both — the
          // badge column and a raw "Integracoes Com Produto" duplicate still
          // rendering the generic array cell's `N item(s)`.
          //
          // ⚠️ `hidden` did not reach the picker until #1264 was fixed up: it
          // was consulted only when rendering, so both duplicates were still
          // listed and ticking one silently rendered nothing — and the picker's
          // label search matched "integra" on the dead entry ALONE, never on
          // "Canais de venda". Keep `pickerFields` and `visibleColumns` in
          // TableView applying the same exclusions.
          integracoesComProduto: { hidden: true },
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
        // All three operations fan out over EVERY channel a produto is listed
        // on, so the list grows with each integration rather than with each
        // channel screen — see `lib/marketplace/push/README.md`.
        //
        // ⚠️ "Pausar anúncios" is pause-only on purpose. Reactivating lives in
        // the produto's Mercado Livre tab, where the operator sees the listing
        // they are putting back on air — see `usePausarAnunciosAction`.
        actions={
          canWriteIntegracao ? [enviarPrecoAction, enviarEstoqueAction, pausarAnunciosAction] : []
        }
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
      {pausarAnunciosModal.opened && (
        <PausarAnunciosDialog
          key={pausarAnunciosModal.alvos.map((a) => a.produtoId).join(',')}
          opened
          alvos={pausarAnunciosModal.alvos}
          onClose={pausarAnunciosModal.close}
        />
      )}
    </Stack>
  );
}
