'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Anchor, Badge, Button, Group, Menu, Stack, TextInput } from '@mantine/core';
import { TableView, type VirtualColumn } from '@delfrance/ui';
import type { PipelineFieldFilter } from '@delfrance/data';
import { PERM } from '@delfrance/auth';
import { type Produto, produtoMeta, produtoSchema } from '@delfrance/schemas';
import { usePermission } from '@/lib/auth';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { ImportarMercadoLivreModal } from './_components/ImportarMercadoLivreModal';

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
   * `produtos(paiId ASC, nome ASC)` index that `produtoMeta.defaultQuery`
   * already depends on, so search costs a seek instead of a table sweep.
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

  return (
    <Stack>
      <ImportarMercadoLivreModal
        db={getFirebaseFirestore()}
        opened={importOpen}
        onClose={() => setImportOpen(false)}
      />

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
        db={getFirebaseFirestore()}
        // The catalog listing (parents only — #119) is declared once on
        // produtoMeta.defaultQuery (`paiId == null`, orderBy nome, limit 50), so
        // the query and its Firestore index stay in lockstep.
        meta={produtoMeta}
        extraFilters={extraFilters}
        defaultColumns={['nomeLink', 'sku', 'gtin', 'publicado']}
        virtualColumns={[nomeColumn]}
        fields={{
          // The schema field is REPLACED by the `nomeLink` virtual column, not
          // merely left out of `defaultColumns`: the ColumnPicker lists every
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
        // TableView owns the header, so the page's existing actions ride in
        // through the "Novo" slot rather than a separate PageHeader.
        renderNewButton={() => (
          <Group gap="sm">
            <Button variant="default" onClick={() => setImportOpen(true)}>
              Importar do Mercado Livre
            </Button>
            {canWritePrecos && (
              <Menu withinPortal position="bottom-end" shadow="md">
                <Menu.Target>
                  <Button variant="default">Preços em massa</Button>
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
            <Button component={Link} href="/produtos/novo">
              Novo produto
            </Button>
          </Group>
        )}
      />
    </Stack>
  );
}
