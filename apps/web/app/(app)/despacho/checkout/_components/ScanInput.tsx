'use client';

import { forwardRef, useState } from 'react';
import { TextInput } from '@mantine/core';
import { IconBarcode } from '@tabler/icons-react';

export interface ScanInputProps {
  /** Called once per completed scan (Enter), with the raw code. */
  onScan: (code: string) => void;
  disabled?: boolean;
}

/**
 * The barcode-wedge scan field. A wedge scanner types the code then sends Enter;
 * we submit + clear on Enter ONLY. Two robustness details:
 *
 *  - the value is LOCAL `useState`, so keystrokes re-render only this input, not
 *    the (potentially 1000-row) panes beside it;
 *  - Enter is ignored while an IME composition is active
 *    (`isComposing` / legacy `keyCode === 229`), so composing a name in the
 *    field never fires a spurious scan.
 *
 * `autoComplete="off"` keeps the browser from popping a history dropdown over
 * the field between rapid scans.
 */
export const ScanInput = forwardRef<HTMLInputElement, ScanInputProps>(function ScanInput(
  { onScan, disabled },
  ref,
) {
  const [value, setValue] = useState('');

  return (
    <TextInput
      ref={ref}
      label="Escanear produto"
      placeholder="Bipe o código de barras ou digite o SKU/ID"
      leftSection={<IconBarcode size={18} />}
      value={value}
      disabled={disabled}
      autoComplete="off"
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        // Ignore the Enter that COMMITS an IME composition — not a scan.
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        const code = value.trim();
        // Clear synchronously so the next wedge scan starts from empty even if
        // React batches; submit only a non-empty code.
        setValue('');
        if (code) onScan(code);
      }}
    />
  );
});
