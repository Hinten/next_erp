'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Code, Group, Stack, Text } from '@mantine/core';
import { CheckoutScreen } from '../_components/CheckoutScreen';
import { staticFixture } from '../_components/fixtures';
import { buildFixturePedido, fixtureBarcodes } from './buildFixture';

/**
 * DEV-ONLY perf/leak harness for the checkout screen (PR 7).
 *
 * Builds a fully in-memory 1000-line-item pedido via `buildFixturePedido` and
 * drives the REAL `CheckoutScreen` through its fixture seam — no staging
 * round-trip. Two controls exercise the two things a big pedido stresses:
 *  - "Auto-scan all" bips every barcode through the real `ScanInput` and reports
 *    the wall-time (also stashed on `window.__harnessLastScanMs`);
 *  - "Cycle pedido" rebuilds the fixture with fresh ids and remounts the screen
 *    (via a bumped React `key`), exercising reload + leak-freedom.
 *
 * The automated consumer is the LOCAL Playwright spec
 * `e2e/despacho-checkout-1000.local.spec.ts` (project `local-perf`, never run in
 * CI — see playwright.config.ts).
 */

const ITEM_COUNT = 1000;

// The real inputs, matched by their placeholder prefixes (see PedidoFinder /
// ScanInput). The two are disambiguated by the char after "Bipe o"/"Bipe ou".
const FINDER_SELECTOR = 'input[placeholder^="Bipe ou digite"]';
const SCAN_SELECTOR = 'input[placeholder^="Bipe o código"]';

type HarnessWindow = Window & { __harnessLastScanMs?: number };

/**
 * Set a React-CONTROLLED input's value the way a wedge scanner / paste would:
 * go through the native value setter (so React's change tracker registers the
 * mutation) and dispatch a bubbling `input` event so React's `onChange` fires.
 */
function driveInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Dispatch a bubbling Enter keydown — how a wedge scanner terminates a code. */
function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

/**
 * A fast macrotask yield (MessageChannel — no 4 ms `setTimeout` clamp). REQUIRED
 * between the `input` event and the Enter keydown: both `ScanInput` and
 * `PedidoFinder` are CONTROLLED inputs whose Enter handler reads the value from
 * React STATE, not the DOM. React must flush the batched state update from the
 * `input` event before Enter fires, or the handler closes over the stale (empty)
 * value and drops the submission. This yield gives React that flush boundary.
 */
function yieldToReact(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

/** Type + submit one code into a controlled input, flushing React between steps. */
async function submitCode(input: HTMLInputElement, code: string): Promise<void> {
  driveInput(input, code);
  await yieldToReact(); // flush: the Enter handler now sees `code` in state
  pressEnter(input);
  await yieldToReact(); // flush: the field clears before the next code
}

/** Poll (rAF) for an element that mounts inside the freshly-rendered child. */
function waitForElement<T extends Element>(
  selector: string,
  isCancelled: () => boolean,
  maxFrames = 120,
): Promise<T | null> {
  return new Promise((resolve) => {
    let frames = 0;
    const tick = (): void => {
      if (isCancelled()) return resolve(null);
      const el = document.querySelector<T>(selector);
      if (el) return resolve(el);
      if (frames++ >= maxFrames) return resolve(null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export default function CheckoutHarnessPage() {
  // `process.env.NODE_ENV` is a build-time constant: in a production build this
  // branch is the ENTIRE component (no hooks below ever run), so the harness is
  // stripped to a notice and never ships as a usable route. Split into two
  // components so `CheckoutHarnessPage` calls no hooks and `CheckoutHarness`
  // calls them unconditionally (no rules-of-hooks hazard around the guard).
  if (process.env.NODE_ENV === 'production') {
    return (
      <Text p="md" c="dimmed">
        Harness disponível apenas em desenvolvimento.
      </Text>
    );
  }
  return <CheckoutHarness />;
}

function CheckoutHarness() {
  const [seed, setSeed] = useState(0);
  const [cycles, setCycles] = useState(0);
  const [scanMs, setScanMs] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(false);

  // Rebuilt only when the seed changes (a "Cycle pedido"). `key={seed}` on the
  // screen forces a full unmount/remount each cycle — the leak surface the spec
  // measures — while this memo keeps the fixture stable within a cycle.
  const data = useMemo(() => buildFixturePedido({ count: ITEM_COUNT, seed }), [seed]);
  const fixture = useMemo(() => staticFixture(data), [data]);

  // Auto-load on (re)mount: type the pedido id into the finder and submit, so
  // the screen reaches its `loaded` state without an operator click.
  // `staticFixture.find` ignores the text, so any value loads this fixture.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const finder = await waitForElement<HTMLInputElement>(FINDER_SELECTOR, () => cancelled);
      if (!finder || cancelled) return;
      await submitCode(finder, data.pedidoId);
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  const autoScanAll = useCallback(async () => {
    if (scanningRef.current) return;
    const input = document.querySelector<HTMLInputElement>(SCAN_SELECTOR);
    if (!input) return; // screen not in the loaded state yet
    scanningRef.current = true;
    setScanning(true);
    const win = window as HarnessWindow;
    delete win.__harnessLastScanMs;
    try {
      const codes = fixtureBarcodes(data);
      performance.mark('scan:start');
      for (const code of codes) {
        await submitCode(input, code);
      }
      performance.mark('scan:end');
      const measure = performance.measure('checkout-scan-1000', 'scan:start', 'scan:end');
      win.__harnessLastScanMs = measure.duration;
      setScanMs(measure.duration);
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  }, [data]);

  const cyclePedido = useCallback(() => {
    delete (window as HarnessWindow).__harnessLastScanMs;
    setScanMs(null);
    setCycles((c) => c + 1);
    setSeed((s) => s + 1); // fresh ids → new fixture → CheckoutScreen remounts
  }, []);

  return (
    <Stack gap="md">
      <Group gap="sm" align="center" wrap="wrap">
        <Badge size="lg" variant="light" color="grape">
          {ITEM_COUNT} itens
        </Badge>
        <Button onClick={autoScanAll} loading={scanning}>
          Auto-scan all
        </Button>
        <Button variant="light" onClick={cyclePedido} disabled={scanning}>
          Cycle pedido
        </Button>
        <Text size="sm" c="dimmed">
          Ciclos: <Code>{cycles}</Code>
        </Text>
        <Text size="sm" c="dimmed">
          Último scan: <Code>{scanMs === null ? '—' : `${Math.round(scanMs)} ms`}</Code>
        </Text>
      </Group>
      <CheckoutScreen key={seed} fixture={fixture} />
    </Stack>
  );
}
