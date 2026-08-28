'use client';

import { Code, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { FORMULA_REGRAS, FORMULA_VARIAVEIS, LIMIAR_AJUDA } from './formulaVariaveis';

/**
 * The variable legend + syntax rules for the pricing formula, restoring the
 * help block the legacy screen printed above these fields
 * (`.old/lib/produtos/pages/listaDePrecosCadastroView.dart:368-390`) which the
 * port dropped -- leaving the operator to guess what `C`, `c`, `T`, `L`, `M`,
 * `I`, `F` and `K` mean.
 *
 * Rendered once per tab, never once per formula row: `FormulaListEditor` gates
 * it on being the top-level editor, and `FormulasPorCategoriaEditor` renders it
 * itself for the category tab.
 *
 * The legacy version was a 13-line paragraph in the body font. Two changes
 * matter here:
 *
 * - The symbols render as `<Code>` (monospace). `C` (product cost) and `c`
 *   (fixed cost) are DIFFERENT variables separated only by case, and swapping
 *   them produces a silently wrong price rather than a validation error -- a
 *   proportional font makes that distinction easy to miss.
 * - `C` carries a note saying it is supplied at calculation time, so it is not
 *   mistaken for one of the seven inputs rendered directly below.
 */
export function FormulaAjuda() {
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group gap={6} wrap="nowrap">
          <IconInfoCircle size={16} aria-hidden />
          <Text size="sm" fw={600}>
            Como montar a fórmula
          </Text>
        </Group>
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="xs" verticalSpacing={4}>
          {FORMULA_VARIAVEIS.map((v) => (
            <Group key={v.simbolo} gap={6} wrap="nowrap" align="baseline">
              <Code>{v.simbolo}</Code>
              <Text size="xs">
                {v.label}
                {v.nota && (
                  <Text span size="xs" c="dimmed">
                    {' '}
                    ({v.nota})
                  </Text>
                )}
              </Text>
            </Group>
          ))}
        </SimpleGrid>
        <Stack gap={2}>
          {[...FORMULA_REGRAS, LIMIAR_AJUDA].map((regra) => (
            <Text key={regra} size="xs" c="dimmed">
              • {regra}
            </Text>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}
