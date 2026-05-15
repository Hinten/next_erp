import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Auto-cleanup after each test — testing-library only registers this when
// vitest's `globals: true` mode is on, which we are not using.
afterEach(() => {
  cleanup();
});

// JSDOM lacks `ResizeObserver`, which Mantine's ScrollArea (used internally
// by Notifications, Select, etc.) instantiates on mount. Provide a no-op
// shim — tests don't depend on observation callbacks firing.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverShim {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver: typeof ResizeObserverShim }).ResizeObserver = ResizeObserverShim;
}

// JSDOM lacks `window.matchMedia`, which several Mantine components reach for
// during render. Provide a no-op shim so tests can render Mantine providers.
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

// Mantine 9's Textarea autosize subscribes to `document.fonts.loadingdone`
// to re-measure after font swaps. JSDOM doesn't expose the FontFaceSet API.
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

// Mantine 9's Textarea autosize calls `window.visualViewport.addEventListener`
// unconditionally on mount; JSDOM doesn't define it. Shim a no-op listener.
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
