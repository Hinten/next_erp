'use client';

import type { ComponentPropsWithoutRef } from 'react';
import { Button, type ButtonProps, Tooltip } from '@mantine/core';

import type { SizeChartGate } from '@/lib/mercado-livre/sizeChartDisabled';

/**
 * Mantine's own props minus `disabled` — which is the gate's to decide, not the
 * caller's — plus the native `<button>` attributes `ButtonProps` does not carry
 * (`onClick`, `type`). Built by hand rather than from
 * `ComponentPropsWithoutRef<typeof Button>`: `Button` is polymorphic, and that
 * helper resolves its props to `any`-shaped leftovers that drop `variant`,
 * `loading` and `children`.
 */
export interface SizeChartActionButtonProps
  extends
    Omit<ButtonProps, 'disabled'>,
    Omit<ComponentPropsWithoutRef<'button'>, keyof ButtonProps | 'disabled'> {
  /** The verdict from `sizeChartGate` / `sizeChartEditorGate`. */
  gate: SizeChartGate;
}

/**
 * A `Button` that explains itself when it is off.
 *
 * ⚠️ Both outputs come from ONE `gate`: `disabled` is `gate.disabled` and the
 * tooltip is `gate.motivo`, and the gate builds the first from the second. That
 * is the whole point — the bug class here is a tooltip that drifts from the
 * `disabled` expression beside it and starts explaining a state the button is
 * not in. There is no second boolean to keep in step.
 *
 * ⚠️ The `<span>` is load-bearing: Mantine turns pointer events OFF on a
 * disabled `Button`, so a `Tooltip` wrapping one directly never fires — a
 * tooltip nobody can trigger is worse than none, because it looks solved. The
 * inline-block wrapper is the idiom that works (`PermGate`, `AnuncioBlock`).
 *
 * ⚠️ A wrapper does not change the button's accessible name, which
 * `medidas-mercado-livre.cadastros.e2e.spec.ts` locates by role+name. Do not
 * add an `aria-label` here.
 *
 * ⚠️ A `loading` you pass through MUST also be expressed in the gate. Mantine's
 * `Button` computes `disabled: disabled || loading` (`Button.mjs:72`), so a
 * loading button is genuinely disabled in the DOM — and if the gate does not
 * know about that state, `motivo` is null, the `Tooltip` is off, and the control
 * is dead with nothing to say. Every caller mirrors its spinner into the gate
 * (`rowBusy` → `busy: 'estaGuia'`, `aiBusy`, `busy === 'draft' | 'send'`); the
 * one that did not is exactly where the invariant reopened.
 *
 * Known limit: a disabled button is not focusable and a bare `<span>` is not
 * either, so the message is hover-reachable but not keyboard-reachable. The
 * alternative — Mantine's `data-disabled` + `preventDefault` — keeps focus but
 * drops the real `disabled` attribute that the e2e and the can't-click
 * guarantee rely on. The always-visible `<Text c="dimmed">` guidance beside
 * these controls is what covers the keyboard path today.
 */
export function SizeChartActionButton({ gate, children, ...rest }: SizeChartActionButtonProps) {
  return (
    <Tooltip
      label={gate.motivo}
      disabled={gate.motivo == null}
      withArrow
      position="bottom"
      multiline
      w={260}
    >
      <span style={{ display: 'inline-block' }}>
        <Button {...rest} disabled={gate.disabled}>
          {children}
        </Button>
      </span>
    </Tooltip>
  );
}
