import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { DEFAULT_THEME } from '@mantine/core';

/**
 * #1150 — the leaked Mantine transition timer.
 *
 * `Transition` calls `useTransition` BEFORE its `env === 'test'` early return, so
 * `env="test"` does NOT stop the timer — it only changes what gets rendered. The
 * lever that does stop it is `theme.respectReducedMotion`: it forces the duration
 * to 0, which takes `handleStateChange`'s synchronous branch — no
 * `requestAnimationFrame`, no `window.setTimeout`, and so nothing left to call a
 * React setter after jsdom has been torn down (`ReferenceError: window is not
 * defined`, reported with every test green).
 *
 * `DEFAULT_THEME` is not frozen and `MantineThemeProvider` merges it at render
 * time, so this reaches every provider in every test with no per-file opt-in. It
 * only bites together with the `matchMedia` shim below, which is what answers the
 * `prefers-reduced-motion` query `useReducedMotion()` consults.
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// Checked on the DESCRIPTOR rather than on the result of the assignment: this
// file is an ES module, so in strict mode assigning to a frozen property throws
// a bare TypeError and the message below would never be printed.
if (!Object.getOwnPropertyDescriptor(DEFAULT_THEME, 'respectReducedMotion')?.writable) {
  throw new Error(
    '@mantine/core DEFAULT_THEME.respectReducedMotion is no longer writable. Move the ' +
      'lever into MantineTestProvider as `theme={{ respectReducedMotion: true }}` — a ' +
      'frozen DEFAULT_THEME silently restores the leaked-transition-timer flake (#1150).',
  );
}
DEFAULT_THEME.respectReducedMotion = true;

afterEach(() => {
  cleanup();
});

// JSDOM lacks `ResizeObserver`, which Mantine's ScrollArea and Tooltip touch
// on mount. Provide a no-op shim — tests don't depend on observation callbacks.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverShim {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverShim }).ResizeObserver =
    ResizeObserverShim;
}

// JSDOM lacks `IntersectionObserver`, which `useIntersection` constructs on ref
// attach — the NF column's viewport gate (#1216) and anything else that lazily
// mounts on visibility. The shim never fires its callback, so `entry` stays
// `null` and consumers see "not in view"; a test that needs the observed state
// mocks `useIntersection` itself rather than driving this.
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class IntersectionObserverShim {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: ReadonlyArray<number> = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  (
    globalThis as unknown as { IntersectionObserver: typeof IntersectionObserverShim }
  ).IntersectionObserver = IntersectionObserverShim;
}

// JSDOM lacks `Element.prototype.scrollIntoView`, which Mantine's Combobox
// calls from a `setTimeout` when its dropdown opens. Because it fires on a
// timer, the TypeError surfaces as an *unhandled* error attributed to whatever
// test happens to be running, long after the one that opened the dropdown —
// and it leaves the combobox store wedged so later dropdowns never open.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// JSDOM lacks `window.matchMedia`, which Mantine providers query during render.
// Every query answers `false` EXCEPT `prefers-reduced-motion`, which must answer
// `true` so `useReducedMotion()` pairs with `DEFAULT_THEME.respectReducedMotion`
// above and drives every transition duration to 0 (#1150).
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query === REDUCED_MOTION_QUERY,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Mantine's Textarea autosize subscribes to `document.fonts.loadingdone`.
if (typeof document !== 'undefined' && !(document as { fonts?: unknown }).fonts) {
  Object.defineProperty(document, 'fonts', {
    writable: true,
    value: {
      ready: Promise.resolve(),
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    },
  });
}

// Mantine's Textarea autosize listens on `window.visualViewport`.
if (typeof window !== 'undefined' && !window.visualViewport) {
  Object.defineProperty(window, 'visualViewport', {
    writable: true,
    value: {
      width: 1024,
      height: 768,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onresize: null,
      onscroll: null,
    },
  });
}
