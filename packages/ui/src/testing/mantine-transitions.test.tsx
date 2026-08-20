import { MantineProvider, Transition, useMantineTheme } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

/**
 * #1150 — proves `vitest.setup.ts` actually neutralises Mantine's transition
 * timer, mechanically rather than observationally.
 *
 * The bug it guards: `useTransition` schedules
 * `window.setTimeout(() => setStatus(...), duration)` whenever a `Transition`'s
 * `mounted` toggles. If that timer survives jsdom teardown its React setter
 * reaches for `window` and reds `lint-typecheck-test` with EVERY TEST GREEN and
 * one unattributable `ReferenceError`. It cost #1025 and #1089 a full
 * investigation each.
 *
 * `env="test"` never fixed this — `Transition` calls `useTransition` *before*
 * its `env === 'test'` early return. Only `theme.respectReducedMotion` does, by
 * forcing the duration to 0 so `handleStateChange` takes its synchronous branch.
 *
 * ⚠️ These tests therefore render a BARE `<MantineProvider>` on purpose. Under
 * `env="test"` the third assertion would pass vacuously, because the early
 * return renders the child immediately whether or not a timer was scheduled.
 * This file is the single documented exemption in
 * `packages/config-eslint/rules/mantine-test-provider.test.js`.
 */

function Bare({ children }: { children: ReactNode }) {
  return <MantineProvider>{children}</MantineProvider>;
}

function ThemeProbe() {
  return <span data-testid="respects">{String(useMantineTheme().respectReducedMotion)}</span>;
}

function Fading({ mounted }: { mounted: boolean }) {
  return (
    <Transition mounted={mounted} transition="fade" duration={250}>
      {(styles) => <div data-testid="panel" style={styles} />}
    </Transition>
  );
}

describe('Mantine transitions are inert under test', () => {
  it('answers the prefers-reduced-motion media query', () => {
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  });

  it('carries respectReducedMotion into the provider theme', () => {
    render(
      <Bare>
        <ThemeProbe />
      </Bare>,
    );
    expect(screen.getByTestId('respects').textContent).toBe('true');
  });

  it('settles a toggled transition synchronously, so no timer outlives the test', () => {
    const { rerender } = render(
      <Bare>
        <Fading mounted={false} />
      </Bare>,
    );
    expect(screen.queryByTestId('panel')).toBeNull();

    rerender(
      <Bare>
        <Fading mounted />
      </Bare>,
    );

    // Deliberately no `await` / `findBy*`. With duration 0 `handleStateChange`
    // sets the status inline, so the panel is already here. The timer path
    // needs two `requestAnimationFrame` ticks before it even schedules the
    // `setTimeout`, and reports `exited` (→ `null`) until then — so this line
    // is what goes red if either half of the setup fix is reverted.
    const panel = screen.getByTestId('panel');
    expect(panel).toBeTruthy();
    expect(panel.style.transitionDuration).toBe('');
  });
});
