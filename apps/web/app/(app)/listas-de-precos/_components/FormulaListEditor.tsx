'use client';

import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Fieldset,
  Group,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { DELETE_MARK } from '@delfrance/ui';
import { FaixaTaxaFixaPesoEditor } from './FaixaTaxaFixaPesoEditor';
import { TestarFormulaDialog } from './TestarFormulaDialog';
import { rowFieldError, validatedIndices } from './editorErrors';

/**
 * Coerce Mantine's `NumberInput` onChange payload to a number, or `null` when
 * the field is cleared — mirrors `CurrencyInput`'s `parseBrl`
 * (`apps/web/app/(app)/produtos/_components/CurrencyInput.tsx`). Never forces
 * an empty input back to `0`: a truly-blank limiar must surface the "maior
 * que zero" validation error instead of silently parsing as a valid-looking 0.
 */
function parseLimiar(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Characters the legacy formula input accepts (digits, the four arithmetic
 * operators, the decimal comma, parentheses, and the single-letter
 * variables). Mirrors the legacy `TextInputFormatter` allow-list —
 * `.old/packages/produtos/lib/src/pages/listaDePrecosCadastroView.dart:454`
 * (confirmed: no `.`, no `^` there either — legacy never let either through
 * its input formatter) — stripped on every change so an invalid character
 * never lands in the field to begin with.
 */
const FORMULA_DISALLOWED_CHARS = /[^0-9+\-*/,CcTFLMIK()]/g;

/**
 * `.` is the natural decimal separator a user types (`C*1.5`), but the
 * formula wire format — and this allow-list — only accepts the comma
 * (`evaluateFormula` itself does `replaceAll(',', '.')` before parsing). If
 * `.` were simply stripped by {@link FORMULA_DISALLOWED_CHARS} like any other
 * disallowed character, `C*1.5` would silently become `C*15`: still a
 * perfectly parseable formula, so no validation error ever surfaces — a
 * silent 10x price error. Auto-convert instead of dropping, so the user's
 * intended decimal survives (as `C*1,5`).
 */
function normalizeFormulaInput(raw: string): string {
  return raw.replaceAll('.', ',').replace(FORMULA_DISALLOWED_CHARS, '');
}

/**
 * One editable `FormulaCalculoPreco` row. Rows marked with `DELETE_MARK` stay
 * visible (dimmed, "Será excluída") with an undo affordance; the actual
 * removal happens at save time via the field's `prepareForSave`
 * (`stripFormulasCalculoPreco`) — CLAUDE.md rule 7.
 */
interface FormulaRow {
  /** `null` while the input is cleared — never silently coerced to 0. */
  limiar?: number | null;
  formula?: string;
  taxaFixa?: number;
  custoFixo?: number;
  margemDeLucro?: number;
  comissaoMarketplace?: number;
  imposto?: number;
  frete?: number;
  marketing?: number;
  faixasTaxaFixaPeso?: unknown;
  [DELETE_MARK]?: boolean;
  [key: string]: unknown;
}

/** A blank formula — every numeric coefficient defaults to 0, faixas unset. */
const EMPTY_ROW: FormulaRow = {
  limiar: 0,
  formula: '',
  taxaFixa: 0,
  custoFixo: 0,
  margemDeLucro: 0,
  comissaoMarketplace: 0,
  imposto: 0,
  frete: 0,
  marketing: 0,
  faixasTaxaFixaPeso: null,
};

/** The seven optional coefficients rendered in the grid (label + key). */
const COEFFICIENTS: ReadonlyArray<{ key: keyof FormulaRow; label: string }> = [
  { key: 'taxaFixa', label: 'Taxa fixa' },
  { key: 'custoFixo', label: 'Custo fixo' },
  { key: 'margemDeLucro', label: 'Margem de lucro' },
  { key: 'comissaoMarketplace', label: 'Comissão marketplace' },
  { key: 'imposto', label: 'Imposto' },
  { key: 'frete', label: 'Frete' },
  { key: 'marketing', label: 'Marketing' },
];

function toRows(value: unknown): FormulaRow[] {
  return Array.isArray(value) ? (value as FormulaRow[]) : [];
}

export interface FormulaListEditorProps {
  label?: string;
  hint?: string;
  value: unknown;
  onChange: (next: FormulaRow[]) => void;
  disabled?: boolean;
  error?: string;
  errorTree?: unknown;
  /**
   * Suffix appended to every aria-label so two editors on the same page (top
   * level + one per category) stay unique. Empty at the top level.
   */
  scope?: string;
}

export function FormulaListEditor({
  label,
  hint,
  value,
  onChange,
  disabled,
  errorTree,
  scope = '',
}: FormulaListEditorProps) {
  const rows = toRows(value);
  // The row currently open in the "Testar Fórmula" dialog (F6, legacy
  // `_TestFormulaDialog`) — a frozen snapshot, not an index, so the dialog
  // keeps showing the row it was opened for even if the list reorders.
  const [testingRow, setTestingRow] = useState<FormulaRow | null>(null);

  const patchRow = (index: number, patch: Partial<FormulaRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  // Marked rows are stripped before validation, so a visible row's error index
  // is the count of unmarked rows before it (marked rows → -1, no errors).
  const errIndices = validatedIndices(rows, DELETE_MARK);

  const body = (
    <Stack gap="sm">
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
      {rows.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhuma fórmula cadastrada.
        </Text>
      )}
      {rows.map((row, i) => {
        const marked = row[DELETE_MARK] === true;
        const errIdx = errIndices[i] ?? -1;
        return (
          <Fieldset key={i} p="sm" opacity={marked ? 0.5 : 1}>
            <Stack gap="sm">
              <Group align="flex-end" gap="sm" wrap="nowrap">
                <NumberInput
                  label="Limiar"
                  aria-label={`Limiar ${i + 1}${scope}`}
                  value={row.limiar ?? ''}
                  onChange={(v) => patchRow(i, { limiar: parseLimiar(v) })}
                  disabled={disabled || marked}
                  error={rowFieldError(errorTree, errIdx, 'limiar')}
                  decimalScale={2}
                  w={140}
                />
                <TextInput
                  label="Fórmula"
                  aria-label={`Fórmula ${i + 1}${scope}`}
                  value={row.formula ?? ''}
                  onChange={(e) =>
                    patchRow(i, {
                      formula: normalizeFormulaInput(e.currentTarget.value),
                    })
                  }
                  disabled={disabled || marked}
                  error={rowFieldError(errorTree, errIdx, 'formula')}
                  style={{ flex: 1 }}
                />
                <Button
                  type="button"
                  variant="subtle"
                  size="xs"
                  aria-label={`Testar fórmula ${i + 1}${scope}`}
                  onClick={() => setTestingRow(row)}
                  disabled={disabled || marked}
                  mb={4}
                >
                  Testar
                </Button>
                {marked ? (
                  <Group gap={4} wrap="nowrap" pb={4}>
                    <Text size="xs" c="red" fw={500}>
                      Será excluída
                    </Text>
                    <ActionIcon
                      type="button"
                      variant="subtle"
                      aria-label={`Desfazer exclusão da fórmula ${i + 1}${scope}`}
                      onClick={() => patchRow(i, { [DELETE_MARK]: false })}
                      disabled={disabled}
                    >
                      <IconArrowBackUp size={16} />
                    </ActionIcon>
                  </Group>
                ) : (
                  <ActionIcon
                    type="button"
                    variant="subtle"
                    color="red"
                    aria-label={`Excluir fórmula ${i + 1}${scope}`}
                    onClick={() => patchRow(i, { [DELETE_MARK]: true })}
                    disabled={disabled}
                    mb={4}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                )}
              </Group>
              <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
                {COEFFICIENTS.map((c) => (
                  <NumberInput
                    key={String(c.key)}
                    label={c.label}
                    aria-label={`${c.label} ${i + 1}${scope}`}
                    value={(row[c.key] as number | undefined) ?? 0}
                    onChange={(v) => patchRow(i, { [c.key]: typeof v === 'number' ? v : 0 })}
                    disabled={disabled || marked}
                    decimalScale={2}
                  />
                ))}
              </SimpleGrid>
              <FaixaTaxaFixaPesoEditor
                value={row.faixasTaxaFixaPeso}
                onChange={(faixas) => patchRow(i, { faixasTaxaFixaPeso: faixas })}
                disabled={disabled || marked}
                scope={` da fórmula ${i + 1}${scope}`}
              />
            </Stack>
          </Fieldset>
        );
      })}
      <Group>
        <Button
          type="button"
          variant="light"
          size="xs"
          onClick={() => onChange([...rows, { ...EMPTY_ROW }])}
          disabled={disabled}
        >
          {scope ? `Adicionar fórmula${scope}` : 'Adicionar fórmula'}
        </Button>
      </Group>
    </Stack>
  );

  return (
    <>
      {/* Top-level use gets a titled Fieldset; embedded use (inside a category
          card) omits the extra frame — the caller already provides one. */}
      {label ? <Fieldset legend={label}>{body}</Fieldset> : body}
      <TestarFormulaDialog
        opened={testingRow !== null}
        onClose={() => setTestingRow(null)}
        formula={testingRow}
      />
    </>
  );
}
