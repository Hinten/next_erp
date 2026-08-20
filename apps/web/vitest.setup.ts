import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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

// JSDOM lacks `Element.prototype.scrollIntoView`, which Mantine's Combobox
// calls from a `setTimeout` when its dropdown opens. Because it fires on a
// timer, the TypeError surfaces as an *unhandled* error attributed to whatever
// test happens to be running, long after the one that opened the dropdown —
// and it leaves the combobox store wedged so later dropdowns never open.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// JSDOM lacks `window.matchMedia`, which Mantine providers query during render.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
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
