'use client';

import { useMemo, useState } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { evaluateFormula, taxaFixaPorPeso, type FormulaCalculoPreco } from '@delfrance/schemas';
import { DecimalInput } from '@delfrance/ui';

/**
 * "Testar Fórmula" dialog — legacy parity with `_TestFormulaDialog`
 * (`.old/packages/produtos/lib/src/pages/listaDePrecosCadastroView.dart:458`).
 * Given a Custo and a Peso, computes the price the row's formula would
 * produce right now, using the SAME engine (`evaluateFormula` +
 * `taxaFixaPorPeso`) the real calculation uses — so what the user sees here
 * matches what saving the formula will actually do.
 */

const money = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * The subset of a `FormulaCalculoPreco` row the dialog needs. Loosely typed
 * (every coefficient optional, `faixasTaxaFixaPeso` unchecked) to match the
 * editor's in-progress `FormulaRow` state — `limiar` and the staged-deletion
 * marker don't matter for a test calc, so they're intentionally omitted.
 */
export interface TestableFormulaRow {
  formula?: string;
  taxaFixa?: number;
  custoFixo?: number;
  margemDeLucro?: number;
  comissaoMarketplace?: number;
  imposto?: number;
  frete?: number;
  marketing?: number;
  faixasTaxaFixaPeso?: unknown;
}

export interface TestarFormulaDialogProps {
  opened: boolean;
  onClose: () => void;
  /** The row under test, or `null` when no row is selected (dialog closed). */
  formula: TestableFormulaRow | null;
}

export function TestarFormulaDialog({ opened, onClose, formula }: TestarFormulaDialogProps) {
  const [custo, setCusto] = useState<number | null>(10);
  const [peso, setPeso] = useState<number | null>(0.25);

  // Null when the row can't be evaluated (unparsable formula or non-finite
  // Custo/Peso input); otherwise the raw computed value (may be ≤ 0).
  const resultado = useMemo(() => {
    if (!formula) return null;
    // `DecimalInput` already hands back a finite number or `null`; an empty box
    // means "no answer", not zero.
    if (custo === null || peso === null) return null;
    const custoNum = custo;
    const pesoNum = peso;
    const row: FormulaCalculoPreco = {
      limiar: 0,
      formula: formula.formula ?? '',
      taxaFixa: formula.taxaFixa ?? 0,
      custoFixo: formula.custoFixo ?? 0,
      margemDeLucro: formula.margemDeLucro ?? 0,
      comissaoMarketplace: formula.comissaoMarketplace ?? 0,
      imposto: formula.imposto ?? 0,
      frete: formula.frete ?? 0,
      marketing: formula.marketing ?? 0,
      // `faixasTaxaFixaPeso` arrives as `unknown` from the editor's loosely
      // typed row state — `taxaFixaPorPeso` only ever reads `pesoMinKg` /
      // `pesoMaxKg` / `taxaFixa` off each entry, so a malformed row (never
      // possible via `FaixaTaxaFixaPesoEditor`, which always writes the full
      // shape) would just fail to match a band instead of crashing.
      faixasTaxaFixaPeso: Array.isArray(formula.faixasTaxaFixaPeso)
        ? (formula.faixasTaxaFixaPeso as FormulaCalculoPreco['faixasTaxaFixaPeso'])
        : null,
    };
    return evaluateFormula(row.formula, {
      C: custoNum,
      c: row.custoFixo,
      T: taxaFixaPorPeso(row, pesoNum),
      L: row.margemDeLucro,
      M: row.comissaoMarketplace,
      I: row.imposto,
      F: row.frete,
      K: row.marketing,
    });
  }, [formula, custo, peso]);

  const resultadoLabel =
    resultado === null ? 'Fórmula inválida' : resultado <= 0 ? '—' : money(resultado);

  return (
    <Modal opened={opened} onClose={onClose} title="Testar fórmula" centered>
      <Stack>
        <DecimalInput
          label="Custo (C)"
          value={custo}
          onChange={setCusto}
          decimalScale={2}
          min={0}
        />
        <DecimalInput label="Peso (kg)" value={peso} onChange={setPeso} decimalScale={3} min={0} />
        <Text size="sm" fw={600}>
          Preço calculado: {resultadoLabel}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Fechar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
