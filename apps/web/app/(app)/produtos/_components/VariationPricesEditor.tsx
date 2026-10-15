'use client';

import { Fragment } from 'react';
import { Alert, Badge, Box, Divider, Group, Paper, Stack, Text } from '@mantine/core';
import type { PrecosMap } from '@delfrance/schemas';
import { CurrencyInput } from './CurrencyInput';
import type { ListaComId } from './PrecoCustoManager';
import { PropagatePriceToChildrenField } from './PropagatePriceToChildrenField';
import type { VariationRow } from './VariationManager';

export interface VariationPricesEditorProps {
  rows: readonly VariationRow[];
  listas: readonly ListaComId[];
  listasError?: string;
  disabled?: boolean;
  onPriceChange: (rowKey: string, listaId: string, valor: number | null) => void;
}

/** Active lists first; an inactive list remains visible while this child has a price on it. */
export function variationPriceListRows(
  listas: readonly ListaComId[],
  precos: PrecosMap,
): ListaComId[] {
  return [
    ...listas.filter((lista) => lista.data.ativo),
    ...listas.filter((lista) => !lista.data.ativo && precos?.[lista.id] !== undefined),
  ];
}

/**
 * Compact independent-price matrix for the product's pricing tab. It owns no
 * staged state: edits flow back to the persistent VariationManager so child
 * creates, updates and validation still share its single batch.
 */
export function VariationPricesEditor({
  rows,
  listas,
  listasError,
  disabled,
  onPriceChange,
}: VariationPricesEditorProps) {
  const visibleRows = rows.filter((row) => !row.deleteMark);

  return (
    <Stack gap="xs">
      <Box>
        <Text size="sm" fw={600}>
          Preços por variação
        </Text>
        <Text size="xs" c="dimmed">
          Estes valores serão gravados junto com as demais alterações do produto.
        </Text>
      </Box>

      {listasError && (
        <Alert color="red">Falha ao carregar as listas de preços: {listasError}</Alert>
      )}

      {visibleRows.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nenhuma variação cadastrada.
        </Text>
      ) : (
        <Paper withBorder>
          {visibleRows.map((row, index) => {
            const priceRows = variationPriceListRows(listas, row.precos);
            const displayName = row.nome.trim() || row.sku.trim() || 'Variação sem nome';
            const accessibleName = row.sku.trim() || displayName;
            return (
              <Fragment key={row.key}>
                {index > 0 && <Divider />}
                <Stack gap="xs" p="sm">
                  <Group justify="space-between" align="flex-start" gap="xs">
                    <Box>
                      <Text size="sm" fw={500}>
                        {displayName}
                      </Text>
                      {row.sku.trim() && row.sku.trim() !== displayName && (
                        <Text size="xs" c="dimmed">
                          SKU {row.sku}
                        </Text>
                      )}
                    </Box>
                    <Group gap={6}>
                      {!row.id && (
                        <Badge color="blue" variant="light" size="sm">
                          nova
                        </Badge>
                      )}
                      {row.pricesDiverge && (
                        <Badge
                          color="yellow"
                          variant="light"
                          size="sm"
                          title="Preço diferente do produto pai"
                        >
                          preço diferente
                        </Badge>
                      )}
                    </Group>
                  </Group>

                  {priceRows.length === 0 ? (
                    <Text size="xs" c="dimmed">
                      Nenhuma lista de preços cadastrada.
                    </Text>
                  ) : (
                    <Group align="flex-start" gap="xs">
                      {priceRows.map((lista) => (
                        <Stack key={lista.id} gap={4} style={{ flex: '1 1 180px', maxWidth: 240 }}>
                          <CurrencyInput
                            label={lista.data.nome}
                            ariaLabel={`${lista.data.nome} — ${accessibleName}`}
                            value={row.precos?.[lista.id]?.valor ?? null}
                            onChange={(valor) => onPriceChange(row.key, lista.id, valor)}
                            disabled={disabled}
                          />
                          {!lista.data.ativo && (
                            <Badge color="gray" variant="light" size="xs" w="fit-content">
                              inativa
                            </Badge>
                          )}
                        </Stack>
                      ))}
                    </Group>
                  )}
                </Stack>
              </Fragment>
            );
          })}
        </Paper>
      )}
    </Stack>
  );
}

export interface VariationPricesFieldProps extends VariationPricesEditorProps {
  value: boolean;
  onChange: (next: boolean) => void;
  divergentChildren: number;
}

/** Toggle plus its conditional editor, kept together in the pricing tab. */
export function VariationPricesField({
  value,
  onChange,
  divergentChildren,
  ...editorProps
}: VariationPricesFieldProps) {
  return (
    <Stack gap="md">
      <PropagatePriceToChildrenField
        value={value}
        onChange={onChange}
        disabled={editorProps.disabled}
        divergentChildren={divergentChildren}
      />
      {!value && <VariationPricesEditor {...editorProps} />}
    </Stack>
  );
}
