/**
 * Local Astro integration: adds pan + zoom to the diagrams that
 * `astro-mermaid` renders. That package turns ```mermaid fences into
 * `<pre class="mermaid">` and, client-side, replaces their contents with an
 * `<svg>` and stamps `data-processed="true"` (see its integration source). It
 * has no zoom affordance of its own, so we layer one on top:
 *
 *  - a small ⛶ button in the corner of every rendered diagram;
 *  - clicking it (or the diagram) opens a full-screen overlay holding a clone
 *    of the SVG, with mouse-wheel zoom (centred on the cursor), drag-to-pan,
 *    and +/−/reset/close controls (Esc and backdrop-click also close).
 *
 * The enhancer is idempotent and driven by a MutationObserver, so it re-applies
 * after astro-mermaid re-renders on a theme toggle (which wipes the diagram's
 * innerHTML, and hence our button) and after Astro view transitions.
 *
 * Injected as a `page` script + `page` style, mirroring how astro-mermaid ships
 * its own client code — no extra runtime dependency.
 */
export default function mermaidZoom() {
  return {
    name: 'mermaid-zoom',
    hooks: {
      'astro:config:setup': ({ injectScript }) => {
        injectScript('page', CLIENT_SCRIPT);
        // Wrapped in an IIFE: Astro concatenates all `injectScript('page', …)`
        // blocks into one scope, so a top-level `const style` would clash with
        // the identical declaration astro-mermaid injects for its own CSS
        // ("Identifier 'style' has already been declared"), throwing and killing
        // the whole bundle — including mermaid's render script.
        injectScript('page', `
          (() => {
            const style = document.createElement('style');
            style.textContent = ${JSON.stringify(CLIENT_CSS)};
            document.head.appendChild(style);
          })();
        `);
      },
    },
  };
}

const CLIENT_CSS = `
.mermaid-zoom-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  border-radius: 0.375rem;
  border: 1px solid var(--sl-color-gray-5, #888);
  background: var(--sl-color-bg, #fff);
  color: var(--sl-color-text, #000);
  opacity: 0;
  transition: opacity 0.15s ease;
}
pre.mermaid:hover .mermaid-zoom-btn,
.mermaid-zoom-btn:focus-visible {
  opacity: 1;
}
.mermaid-zoom-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: none;
  background: rgba(0, 0, 0, 0.72);
  cursor: grab;
  touch-action: none;
  overscroll-behavior: contain;
}
.mermaid-zoom-overlay.open { display: block; }
.mermaid-zoom-overlay.dragging { cursor: grabbing; }
.mermaid-zoom-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.mermaid-zoom-content {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.mermaid-zoom-content svg {
  display: block;
  max-width: none !important;
  height: auto;
  /* mermaid draws on a light canvas; keep it readable over the dark backdrop */
  background: #fff;
  border-radius: 0.5rem;
}
.mermaid-zoom-toolbar {
  position: absolute;
  top: 1rem;
  right: 1rem;
  z-index: 1;
  display: flex;
  gap: 0.375rem;
}
.mermaid-zoom-toolbar button {
  min-width: 2.25rem;
  height: 2.25rem;
  padding: 0 0.5rem;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  border-radius: 0.375rem;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(30, 30, 30, 0.9);
  color: #fff;
}
.mermaid-zoom-toolbar button:hover { background: rgba(60, 60, 60, 0.95); }
.mermaid-zoom-hint {
  position: absolute;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.35rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.8rem;
  color: #fff;
  background: rgba(30, 30, 30, 0.8);
  pointer-events: none;
}
`;

const CLIENT_SCRIPT = `
(() => {
  const MIN = 0.2, MAX = 12;
  let overlay, stage, content, scale = 1, tx = 0, ty = 0;
  let dragging = false, moved = false, startX = 0, startY = 0, baseTx = 0, baseTy = 0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const apply = () => {
    if (content) content.style.transform =
      'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  };

  function buildOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'mermaid-zoom-overlay';
    overlay.innerHTML =
      '<div class="mermaid-zoom-toolbar">' +
        '<button type="button" data-act="out" aria-label="Zoom out">\\u2212</button>' +
        '<button type="button" data-act="reset" aria-label="Reset">Reset</button>' +
        '<button type="button" data-act="in" aria-label="Zoom in">+</button>' +
        '<button type="button" data-act="close" aria-label="Close">\\u2715</button>' +
      '</div>' +
      '<div class="mermaid-zoom-stage"><div class="mermaid-zoom-content"></div></div>' +
      '<div class="mermaid-zoom-hint">Scroll to zoom \\u00b7 drag to pan \\u00b7 Esc to close</div>';
    stage = overlay.querySelector('.mermaid-zoom-stage');
    content = overlay.querySelector('.mermaid-zoom-content');
    document.body.appendChild(overlay);

    overlay.querySelector('.mermaid-zoom-toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'close') return close();
      if (act === 'reset') return fit();
      zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, act === 'in' ? 1.3 : 1 / 1.3);
    });

    overlay.addEventListener('click', (e) => {
      // A pan ends with a synthetic click on the stage; don't treat that as a
      // click-on-backdrop (which would close). Only a click without a preceding
      // drag closes.
      if (moved) { moved = false; return; }
      if (e.target === overlay || e.target === stage) close();
    });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    stage.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; startX = e.clientX; startY = e.clientY; baseTx = tx; baseTy = ty;
      overlay.classList.add('dragging');
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      // Ignore sub-pixel jitter so a plain click still closes; any real drag
      // sets the moved flag and suppresses the trailing click-to-close.
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      tx = baseTx + dx;
      ty = baseTy + dy;
      apply();
    });
    const endDrag = () => { dragging = false; overlay.classList.remove('dragging'); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    document.addEventListener('keydown', (e) => {
      if (overlay.classList.contains('open') && e.key === 'Escape') close();
    });
  }

  function zoomAt(px, py, factor) {
    const next = clamp(scale * factor, MIN, MAX);
    tx = px - ((px - tx) / scale) * next;
    ty = py - ((py - ty) / scale) * next;
    scale = next;
    apply();
  }

  function fit() {
    const svg = content.querySelector('svg');
    if (!svg) { scale = 1; tx = 0; ty = 0; return apply(); }
    const sw = svg.getBoundingClientRect().width / scale;
    const sh = svg.getBoundingClientRect().height / scale;
    scale = clamp(Math.min(stage.clientWidth / sw, stage.clientHeight / sh) * 0.92, MIN, MAX);
    tx = (stage.clientWidth - sw * scale) / 2;
    ty = (stage.clientHeight - sh * scale) / 2;
    apply();
  }

  function open(svg) {
    buildOverlay();
    content.innerHTML = '';
    content.appendChild(svg.cloneNode(true));
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(fit);
  }
  function close() {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    content.innerHTML = '';
  }

  function enhance() {
    document.querySelectorAll('pre.mermaid[data-processed]').forEach((pre) => {
      if (pre.dataset.zoomReady === '1' && pre.querySelector('.mermaid-zoom-btn')) return;
      const svg = pre.querySelector('svg');
      if (!svg) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mermaid-zoom-btn';
      btn.title = 'Expand diagram';
      btn.setAttribute('aria-label', 'Expand diagram');
      btn.textContent = '\\u26F6';
      btn.addEventListener('click', (e) => { e.stopPropagation(); open(svg); });
      pre.appendChild(btn);
      pre.style.cursor = 'zoom-in';
      pre.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // don't hijack links inside a diagram
        open(svg);
      });
      pre.dataset.zoomReady = '1';
    });
  }

  const observer = new MutationObserver(() => enhance());
  const start = () => {
    enhance();
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['data-processed'],
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
  document.addEventListener('astro:after-swap', () => { close(); enhance(); });
})();
`;
