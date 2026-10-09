import AxeBuilder from '@axe-core/playwright';
import {
  errors,
  expect,
  type JSHandle,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';

export interface ThemeReadabilityOptions {
  scheme: 'light' | 'dark';
  scope?: string;
  required: Locator[];
  /** Essential enabled controls containing SVG icons, rather than decorative artwork. */
  icons?: Locator[];
  /** Focusable controls whose keyboard focus indicator must remain perceptible. */
  focus?: Locator[];
}

export interface ThemeReadabilityIssue {
  code: string;
  target: string;
  detail: string;
}

export interface ThemeReadabilityReport {
  scheme: ThemeReadabilityOptions['scheme'];
  issues: ThemeReadabilityIssue[];
  axe: Awaited<ReturnType<AxeBuilder['analyze']>>;
  /** Monochrome status glyphs/counts that axe deferred and solid paint measured. */
  resolvedGlyphTargets: string[];
  resolvedTextTargets: Array<{ target: string; reason: 'elmPartiallyObscuring' }>;
  resolvedSvgTextTargets: Array<{
    target: string;
    reason: 'imgNode' | 'bgOverlap' | 'shortTextContent' | 'elmPartiallyObscuring';
  }>;
}

async function resolveAxeTarget(
  page: Page,
  scope: string | undefined,
  raw: unknown,
): Promise<Locator | null> {
  const chain =
    typeof raw === 'string'
      ? [raw]
      : Array.isArray(raw) &&
          raw.length > 0 &&
          raw.every((part: unknown): part is string => typeof part === 'string')
        ? raw
        : null;
  if (!chain) return null;
  const scopeRoot = page.locator(scope ?? 'body');
  const globalTarget = page.locator(chain[0]!);
  let target = scopeRoot
    .locator(chain[0]!)
    .or(scopeRoot.locator('*').and(globalTarget))
    .or(scopeRoot.and(globalTarget));
  for (const selector of chain.slice(1)) {
    if ((await target.count()) !== 1) return target;
    const host = await target.elementHandle();
    if (!host) return null;
    try {
      if (!(await host.evaluate((element) => element.shadowRoot !== null))) return null;
      const nested = target.locator(selector);
      if (
        (await nested.count()) === 1 &&
        !(await nested.evaluate((element, expectedHost) => {
          const root = element.getRootNode();
          return root instanceof ShadowRoot && root.host === expectedHost;
        }, host))
      )
        return null;
      target = nested;
    } finally {
      await host.dispose();
    }
  }
  return target;
}

async function settleFiniteMotion(page: Page): Promise<ThemeReadabilityIssue[]> {
  const settled = await page.evaluate(async () => {
    const deadline = performance.now() + 5_000;
    for (;;) {
      // React can commit a hover/focus response on the next frame. Observe two
      // frames before deciding that no transition remains, including cleanup.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const finite = document
        .getAnimations()
        .filter(
          (animation) =>
            (animation.playState === 'running' || animation.pending) &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
        );
      if (finite.length === 0) return true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      let timeout = 0;
      const completed = await Promise.race([
        Promise.all(
          finite.map(async (animation) => {
            try {
              await animation.finished;
            } catch (err) {
              // A closing overlay can unmount before its transition finishes.
              if (!(err instanceof DOMException) || err.name !== 'AbortError') throw err;
            }
          }),
        ).then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = window.setTimeout(() => resolve(false), remaining);
        }),
      ]);
      window.clearTimeout(timeout);
      if (!completed) return false;
    }
  });
  return settled
    ? []
    : [
        {
          code: 'unsettled-motion',
          target: 'document',
          detail: 'Finite animation/transition did not settle within five seconds',
        },
      ];
}

async function settleIncidentalTooltips(
  page: Page,
  options: ThemeReadabilityOptions,
): Promise<ThemeReadabilityIssue[]> {
  const preserved: JSHandle<Element | null>[] = [];
  try {
    for (const target of options.required) {
      if ((await target.count()) === 1)
        preserved.push(
          await target.evaluateHandle((element) => element.closest('[role="tooltip"]')),
        );
    }
    if (options.scope) {
      const scope = page.locator(options.scope);
      if ((await scope.count()) === 1)
        preserved.push(
          await scope.evaluateHandle((element) => element.closest('[role="tooltip"]')),
        );
    }
    const explicitTooltip = await page.evaluate(
      (nodes) => nodes.some((node) => node !== null),
      preserved,
    );
    // A caller can deliberately audit a hovered tooltip. Retain that hover;
    // every other tooltip here was incidental to helper trial clicks/focus.
    if (explicitTooltip) return [];
    preserved.push(
      await page.evaluateHandle(() => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        for (let element = active; element; ) {
          const tooltip = element.closest('[role="tooltip"]');
          if (tooltip) return tooltip;
          const root = element.getRootNode();
          for (const id of (element.getAttribute('aria-describedby') ?? '').split(/\s+/)) {
            const described =
              root instanceof Document || root instanceof ShadowRoot
                ? root.getElementById(id)
                : null;
            if (described?.getAttribute('role') === 'tooltip') return described;
          }
          element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return null;
      }),
    );
    // A clicked/focused trigger can keep its described tooltip open while the
    // pointer leaves. Preserve that real state; axe still measures its text.
    await page.mouse.move(0, 0);
    try {
      await page.waitForFunction(
        (nodes) => {
          const keep = new Set(nodes.filter((node) => node !== null));
          return Array.from(document.querySelectorAll('[role="tooltip"]')).every((tooltip) => {
            if (keep.has(tooltip)) return true;
            const style = getComputedStyle(tooltip);
            const rect = tooltip.getBoundingClientRect();
            // Opacity alone is insufficient: a JS-delayed exit may not have
            // started its CSS fade yet. Wait for detach or a hidden surface.
            return (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              rect.width === 0 ||
              rect.height === 0
            );
          });
        },
        preserved,
        { timeout: 5_000 },
      );
    } catch (err) {
      if (!(err instanceof errors.TimeoutError)) throw err;
      const remaining = await page.locator('[role="tooltip"]').evaluateAll((nodes) => ({
        active: document.activeElement?.outerHTML,
        tooltips: nodes.map((node) => ({
          id: node.id,
          text: node.textContent,
          opacity: getComputedStyle(node).opacity,
          transition: getComputedStyle(node).transitionDuration,
          triggers: Array.from(document.querySelectorAll('[aria-describedby]'))
            .filter((trigger) =>
              (trigger.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(node.id),
            )
            .map((trigger) => trigger.outerHTML),
        })),
      }));
      return [
        {
          code: 'unsettled-tooltip',
          target: '[role="tooltip"]',
          detail: `${err.message}\n${JSON.stringify(remaining)}`,
        },
      ];
    }
    return [];
  } finally {
    await Promise.all(preserved.map((handle) => handle.dispose()));
  }
}

async function inspectTarget(target: Locator): Promise<ThemeReadabilityIssue[]> {
  const name = target.toString();
  const count = await target.count();
  if (count !== 1) {
    return [
      {
        code: 'missing-or-ambiguous',
        target: name,
        detail: `Expected one element, found ${count}`,
      },
    ];
  }
  if (!(await target.isVisible())) {
    return [{ code: 'hidden', target: name, detail: 'Required element is not visible' }];
  }
  const zeroOpacity = await target.evaluate((element) => {
    const parent = (node: Element): Element | null => {
      const root = node.getRootNode();
      return node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    };
    for (let node: Element | null = element; node; node = parent(node)) {
      if (Number(getComputedStyle(node).opacity) === 0) return true;
    }
    return false;
  });
  if (zeroOpacity) {
    return [{ code: 'zero-opacity', target: name, detail: 'Element or ancestor has zero opacity' }];
  }
  try {
    await target.scrollIntoViewIfNeeded({ timeout: 5_000 });
    const inViewport = await target.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          const observer = new IntersectionObserver(([entry]) => {
            observer.disconnect();
            resolve((entry?.intersectionRatio ?? 0) >= 0.9);
          });
          observer.observe(element);
        }),
    );
    if (!inViewport) {
      return [
        {
          code: 'clipped',
          target: name,
          detail: 'Less than 90% of required element is visible after scrolling',
        },
      ];
    }
    const actionable = await target.evaluate((element) =>
      element.matches(
        'button, input:not([type="hidden"]), select, textarea, a[href], [role="button"], [role="link"], [role="checkbox"], [role="switch"]',
      ),
    );
    if (actionable) {
      if (!(await target.isEnabled())) {
        return [
          { code: 'disabled', target: name, detail: 'Required actionable control is disabled' },
        ];
      }
      await target.click({ trial: true, timeout: 5_000 });
    }
  } catch (err) {
    if (!(err instanceof errors.TimeoutError)) throw err;
    return [{ code: 'unreachable', target: name, detail: err.message }];
  }
  return [];
}

/**
 * Inspect paint in the browser, where currentColor and CSS variables are resolved.
 * Only solid surfaces are accepted: guessing a gradient/image/pseudo-element's
 * background would turn an unsupported measurement into a silent pass.
 */
async function inspectPaint(
  target: Locator,
  mode:
    | 'icon'
    | 'focus'
    | 'glyph'
    | 'short-text'
    | 'plain-text'
    | 'plain-text-visibility'
    | 'svg-text',
): Promise<ThemeReadabilityIssue[]> {
  const issues = await target.evaluate((element, paintMode) => {
    type Rgba = [number, number, number, number];
    const problems: Array<{ code: string; detail: string }> = [];
    const parent = (node: Element): Element | null => {
      const root = node.getRootNode();
      return node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx)
      return [{ code: 'unsupported-paint', detail: 'Canvas color resolution is unavailable' }];
    const color = (value: string): Rgba => {
      if (value === '') return [0, 0, 0, 0];
      if (!CSS.supports('color', value)) {
        problems.push({
          code: 'unsupported-paint',
          detail: `Paint cannot be resolved to a CSS color: ${value}`,
        });
        return [0, 0, 0, 0];
      }
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const bytes = ctx.getImageData(0, 0, 1, 1).data;
      return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, (bytes[3] ?? 0) / 255];
    };
    const blend = (front: Rgba, back: Rgba): Rgba => [
      front[0] * front[3] + back[0] * (1 - front[3]),
      front[1] * front[3] + back[1] * (1 - front[3]),
      front[2] * front[3] + back[2] * (1 - front[3]),
      1,
    ];
    const luminance = (rgba: Rgba) => {
      const channel = (value: number) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgba[0]) + 0.7152 * channel(rgba[1]) + 0.0722 * channel(rgba[2]);
    };
    const contrast = (front: Rgba, back: Rgba) => {
      const a = luminance(blend(front, back));
      const b = luminance(back);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    let opaqueSurface: Element | null = null;
    const background = (node: Element | null, requireOpaque = false): Rgba | null => {
      opaqueSurface = null;
      const ancestors: Element[] = [];
      for (let current = node; current; current = parent(current)) ancestors.unshift(current);
      let result: Rgba = [255, 255, 255, 1];
      for (const ancestor of ancestors) {
        const style = getComputedStyle(ancestor);
        if (
          style.backgroundImage !== 'none' ||
          style.filter !== 'none' ||
          style.backdropFilter !== 'none' ||
          style.mixBlendMode !== 'normal' ||
          Number(style.opacity) !== 1
        ) {
          problems.push({
            code: 'unsupported-paint',
            detail: 'Paint uses an image, gradient, filter, blend mode, or partial opacity',
          });
          return null;
        }
        for (const pseudo of ['::before', '::after']) {
          const p = getComputedStyle(ancestor, pseudo);
          if (
            p.content !== 'none' &&
            p.content !== 'normal' &&
            p.display !== 'none' &&
            Number(p.opacity) !== 0 &&
            (p.backgroundImage !== 'none' ||
              p.filter !== 'none' ||
              p.backdropFilter !== 'none' ||
              color(p.backgroundColor)[3] > 0)
          ) {
            problems.push({
              code: 'unsupported-paint',
              detail: 'Painted pseudo-element requires an explicit measurement',
            });
            return null;
          }
        }
        const paint = color(style.backgroundColor);
        if (paint[3] === 1) opaqueSurface = ancestor;
        result = blend(paint, result);
      }
      if (requireOpaque && !opaqueSurface) {
        problems.push({
          code: 'unsupported-paint',
          detail: 'Plain text has no verified opaque background ancestor',
        });
        return null;
      }
      return result;
    };

    if (
      paintMode === 'glyph' ||
      paintMode === 'short-text' ||
      paintMode === 'plain-text' ||
      paintMode === 'plain-text-visibility' ||
      paintMode === 'svg-text'
    ) {
      const svgText = paintMode === 'svg-text';
      const plain = svgText || paintMode === 'plain-text' || paintMode === 'plain-text-visibility';
      const visibilityOnly = paintMode === 'plain-text-visibility';
      // Native colour emoji do not inherit text colour. Only existing plain
      // status glyphs with direct text can be measured from computed CSS paint.
      const text = element.textContent?.trim() ?? '';
      const supportedText =
        paintMode === 'glyph'
          ? /^[✓✔✗✘×—–…]+$/u.test(text)
          : paintMode === 'short-text'
            ? /^[A-Za-z0-9]{1,4}\+?$/u.test(text)
            : text.length > 0 &&
              (visibilityOnly ||
                !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(text));
      if (
        !(svgText
          ? element instanceof SVGTextContentElement && element.matches('text, tspan')
          : element instanceof HTMLElement) ||
        element.children.length > 0 ||
        !supportedText
      ) {
        return [
          {
            code: 'unsupported-glyph',
            detail:
              'Only direct monochrome status glyphs or short ASCII counts have a measurable foreground',
          },
        ];
      }
      if (!(element instanceof HTMLElement || element instanceof SVGTextContentElement))
        return [{ code: 'unsupported-glyph', detail: 'Text is not a supported painted leaf' }];
      const svgMatrix = element instanceof SVGTextContentElement ? element.getScreenCTM() : null;
      const svgCells: Array<{ rect: DOMRect; character: string | null }> = [];
      if (svgText && element instanceof SVGTextContentElement) {
        const style = getComputedStyle(element);
        if (
          !svgMatrix ||
          svgMatrix.is2D === false ||
          ![svgMatrix.a, svgMatrix.b, svgMatrix.c, svgMatrix.d, svgMatrix.e, svgMatrix.f].every(
            Number.isFinite,
          ) ||
          svgMatrix.a <= 0 ||
          svgMatrix.d <= 0 ||
          svgMatrix.b !== 0 ||
          svgMatrix.c !== 0 ||
          style.writingMode !== 'horizontal-tb' ||
          style.stroke !== 'none' ||
          style.textShadow !== 'none'
        )
          return [{ code: 'unsupported-paint', detail: 'SVG text requires unrotated solid fill' }];
        for (let ancestor: Element | null = element; ancestor; ancestor = parent(ancestor)) {
          const paint = getComputedStyle(ancestor);
          if (
            paint.clipPath !== 'none' ||
            paint.maskImage !== 'none' ||
            paint.perspective !== 'none' ||
            paint.transform.startsWith('matrix3d(') ||
            (ancestor instanceof SVGElement && paint.boxShadow !== 'none')
          )
            return [
              {
                code: 'unsupported-paint',
                detail: 'SVG text uses clipping, masking, 3D transform, or a box shadow',
              },
            ];
        }
        // SVG DOM indexes address UTF-16 units. getExtentOfChar supplies each
        // rendered glyph cell; CTM converts its coordinates into viewport space.
        for (let index = 0; index < element.getNumberOfChars(); index++) {
          if (element.getRotationOfChar(index) !== 0)
            return [{ code: 'unsupported-paint', detail: 'SVG glyph rotation is unsupported' }];
          const cell = element.getExtentOfChar(index);
          const start = new DOMPoint(cell.x, cell.y).matrixTransform(svgMatrix);
          const end = new DOMPoint(cell.x + cell.width, cell.y + cell.height).matrixTransform(
            svgMatrix,
          );
          svgCells.push({
            rect: new DOMRect(start.x, start.y, end.x - start.x, end.y - start.y),
            character: element.textContent?.[index] ?? null,
          });
        }
      }
      const surface = visibilityOnly ? null : background(element, plain);
      if (!visibilityOnly && !surface) return problems;
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = svgText
        ? svgCells.map(({ rect }) => rect)
        : plain
          ? Array.from(range.getClientRects())
          : [range.getBoundingClientRect()];
      if (rects.length === 0)
        return [{ code: 'unreachable-glyph', detail: 'Text has no rendered line rectangles' }];
      const tolerance = 0.5;
      for (const rect of rects) {
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.left < -tolerance ||
          rect.top < -tolerance ||
          rect.right > innerWidth + tolerance ||
          rect.bottom > innerHeight + tolerance
        ) {
          return [{ code: 'clipped-text', detail: 'A text line extends outside the viewport' }];
        }
        if (plain) {
          // Font ink can extend beyond a short line box when overflow is
          // visible. Only actual overflow clipping creates a paint boundary.
          for (let ancestor: Element | null = element; ancestor; ancestor = parent(ancestor)) {
            const style = getComputedStyle(ancestor);
            const clip = ancestor.getBoundingClientRect();
            const left = clip.left + ancestor.clientLeft;
            const top = clip.top + ancestor.clientTop;
            if (
              (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX) &&
                (rect.left < left - tolerance ||
                  rect.right > left + ancestor.clientWidth + tolerance)) ||
              (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY) &&
                (rect.top < top - tolerance ||
                  rect.bottom > top + ancestor.clientHeight + tolerance))
            ) {
              return [{ code: 'clipped-text', detail: 'An ancestor clips a rendered text line' }];
            }
          }
        }
      }
      // Non-interactive badges can legitimately opt out of pointer targeting.
      // Enable hit testing synchronously, then restore their exact inline rule;
      // this still rejects another element covering the displayed text.
      const previousPointerEvents = element.style.getPropertyValue('pointer-events');
      const previousPriority = element.style.getPropertyPriority('pointer-events');
      const hadStyleAttribute = element.hasAttribute('style');
      let unobscured = true;
      const hitBox = element.getBoundingClientRect();
      type HitNode = {
        tag: string;
        className: string | null;
        label: string | null;
        opacity: string;
        pointerEvents: string;
      };
      let firstObstruction: {
        x: number;
        y: number;
        character: string | null;
        targetBox: { x: number; y: number; width: number; height: number };
        front: HitNode[];
      } | null = null;
      const ancestors = new Set<Element>();
      for (let node: Element | null = element; node; node = parent(node)) ancestors.add(node);
      const shadowRoots = new Set<ShadowRoot>();
      for (const node of ancestors) {
        const root = node.getRootNode();
        if (root instanceof ShadowRoot) shadowRoots.add(root);
      }
      const hitStack = (x: number, y: number): Element[] => {
        const seenRoots = new Set<Document | ShadowRoot>();
        const seenNodes = new Set<Element>();
        const stack: Element[] = [];
        const visit = (root: Document | ShadowRoot) => {
          if (seenRoots.has(root)) return;
          seenRoots.add(root);
          for (const node of root.elementsFromPoint(x, y)) {
            if (node.shadowRoot && shadowRoots.has(node.shadowRoot)) visit(node.shadowRoot);
            if (!seenNodes.has(node)) {
              seenNodes.add(node);
              stack.push(node);
            }
          }
        };
        visit(document);
        return stack;
      };
      const hitRects: Array<{ rect: DOMRect; character: string | null }> = svgText
        ? svgCells
        : rects.map((rect) => ({ rect, character: null }));
      if (plain && !svgText) {
        // Line edges/centre alone can miss an occluder between those points.
        // Include each rendered character rectangle, keeping surrogate pairs
        // together, so a covered word cannot slip between coarse probes.
        for (const child of element.childNodes) {
          if (!(child instanceof Text)) continue;
          let offset = 0;
          for (const character of child.data) {
            const end = offset + character.length;
            if (character.trim() !== '') {
              const glyphRange = document.createRange();
              glyphRange.setStart(child, offset);
              glyphRange.setEnd(child, end);
              hitRects.push(
                ...Array.from(glyphRange.getClientRects())
                  .filter((rect) => rect.width > 0 && rect.height > 0)
                  .map((rect) => ({ rect, character })),
              );
            }
            offset = end;
          }
        }
      }
      const svgPaint = new Map<
        SVGGraphicsElement,
        {
          at: (x: number, y: number) => boolean;
          pointerEvents: string;
          priority: string;
          hadStyle: boolean;
        }
      >();
      if (svgText) {
        // A chart path can paint behind text while opting out of pointer events.
        // Probe actual fill/stroke geometry, including donut holes, rather than
        // assuming every point in a path's rectangular bbox is painted.
        for (const root of [document, ...shadowRoots]) {
          for (const node of root.querySelectorAll(
            'svg path, svg rect, svg circle, svg ellipse, svg line, svg polyline, svg polygon, svg image, svg use, svg foreignObject, svg text',
          )) {
            if (
              !(node instanceof SVGGraphicsElement) ||
              ancestors.has(node) ||
              node.closest('defs, clipPath, mask, pattern, symbol, marker')
            )
              continue;
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            if (style.display === 'none' || style.visibility !== 'visible') continue;
            let opacity = 1;
            let displayed = true;
            let unboundedPaint = node instanceof SVGForeignObjectElement;
            for (let ancestor: Element | null = node; ancestor; ancestor = parent(ancestor)) {
              const paint = getComputedStyle(ancestor);
              opacity *= Number(paint.opacity);
              displayed &&= paint.display !== 'none';
              unboundedPaint ||=
                paint.filter !== 'none' ||
                paint.backdropFilter !== 'none' ||
                paint.textShadow !== 'none' ||
                paint.perspective !== 'none' ||
                paint.transform.startsWith('matrix3d(') ||
                (ancestor instanceof SVGElement && paint.boxShadow !== 'none') ||
                ['marker-start', 'marker-mid', 'marker-end'].some((property) => {
                  const marker = paint.getPropertyValue(property);
                  return marker !== '' && marker !== 'none';
                });
            }
            if (!displayed || opacity === 0) continue;
            if (
              unboundedPaint &&
              ((element instanceof SVGTextContentElement &&
                node.ownerSVGElement === element.ownerSVGElement) ||
                (box.left <= hitBox.right &&
                  box.right >= hitBox.left &&
                  box.top <= hitBox.bottom &&
                  box.bottom >= hitBox.top))
            )
              return [
                {
                  code: 'unsupported-svg-background',
                  detail: 'SVG filter, shadow, marker, or foreign content has unbounded paint',
                },
              ];
            const matrix = node.getScreenCTM();
            if (!matrix || matrix.a * matrix.d - matrix.b * matrix.c === 0) continue;
            const inverse = matrix.inverse();
            const visiblePaint = (paint: string, alpha: string) =>
              paint !== 'none' &&
              Number(alpha) > 0 &&
              (!CSS.supports('color', paint) || color(paint)[3] > 0);
            const fill = visiblePaint(style.fill, style.fillOpacity);
            const stroke =
              Number.parseFloat(style.strokeWidth) > 0 &&
              visiblePaint(style.stroke, style.strokeOpacity);
            // A zero-length path can still paint round/square stroke caps.
            // Markers/foreign paint were classified before this geometry prune.
            if (box.width === 0 && box.height === 0 && !stroke) continue;
            const at = (x: number, y: number) => {
              const point = new DOMPoint(x, y).matrixTransform(inverse);
              return node instanceof SVGGeometryElement
                ? (fill && node.isPointInFill(point)) || (stroke && node.isPointInStroke(point))
                : x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
            };
            svgPaint.set(node, {
              at,
              pointerEvents: node.style.getPropertyValue('pointer-events'),
              priority: node.style.getPropertyPriority('pointer-events'),
              hadStyle: node.hasAttribute('style'),
            });
          }
        }
      }
      const transparentSvgViewports = new Map<Element, boolean>();
      const neutralSvgViewport = (node: Element) => {
        if (!svgText || !(node instanceof SVGSVGElement)) return false;
        const cached = transparentSvgViewports.get(node);
        if (cached !== undefined) return cached;
        const style = getComputedStyle(node);
        const neutral =
          color(style.backgroundColor)[3] === 0 &&
          style.backgroundImage === 'none' &&
          style.filter === 'none' &&
          style.backdropFilter === 'none' &&
          style.mixBlendMode === 'normal' &&
          style.boxShadow === 'none' &&
          Number(style.opacity) === 1 &&
          [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ].every((width) => Number.parseFloat(width) === 0) &&
          (style.outlineStyle === 'none' || Number.parseFloat(style.outlineWidth) === 0);
        transparentSvgViewports.set(node, neutral);
        return neutral;
      };
      try {
        element.style.setProperty('pointer-events', 'auto', 'important');
        for (const node of svgPaint.keys())
          node.style.setProperty('pointer-events', 'all', 'important');
        for (const { rect, character } of hitRects) {
          const dx = Math.min(0.5, rect.width / 4);
          const dy = Math.min(0.5, rect.height / 4);
          const xs = plain
            ? [rect.left + dx, rect.left + rect.width / 2, rect.right - dx]
            : [rect.left + rect.width / 2];
          const ys = plain
            ? [rect.top + dy, rect.top + rect.height / 2, rect.bottom - dy]
            : [rect.top + rect.height / 2];
          for (const x of xs)
            for (const y of ys) {
              const stack = hitStack(x, y).filter(
                (node) =>
                  !(node instanceof SVGGraphicsElement) ||
                  !svgPaint.has(node) ||
                  svgPaint.get(node)!.at(x, y),
              );
              const opaqueIndex = opaqueSurface ? stack.indexOf(opaqueSurface) : -1;
              if (
                svgText &&
                stack
                  .slice(0, opaqueIndex < 0 ? stack.length : opaqueIndex)
                  .some((node) => node instanceof SVGGraphicsElement && svgPaint.has(node))
              )
                return [
                  {
                    code: 'unsupported-svg-background',
                    detail: 'SVG paint intersects a text glyph cell above its solid background',
                  },
                ];
              const top = stack[0];
              const outsideLineBox =
                x < hitBox.left || x > hitBox.right || y < hitBox.top || y > hitBox.bottom;
              // A Range includes empty font-metric space around ink. Outside
              // a visible-overflow line box, that space can target a parent.
              // An unrelated sibling/overlay is never accepted as that parent.
              const fontOverflowHit =
                plain && outsideLineBox && top !== undefined && ancestors.has(top);
              if (top !== element && !fontOverflowHit) {
                unobscured = false;
                if (!firstObstruction) {
                  const front: HitNode[] = [];
                  for (let node = top; node && front.length < 6; node = parent(node) ?? undefined) {
                    const style = getComputedStyle(node);
                    front.push({
                      tag: node.tagName,
                      className: node.getAttribute('class'),
                      label: node.getAttribute('aria-label'),
                      opacity: style.opacity,
                      pointerEvents: style.pointerEvents,
                    });
                  }
                  firstObstruction = {
                    x,
                    y,
                    character,
                    targetBox: {
                      x: hitBox.x,
                      y: hitBox.y,
                      width: hitBox.width,
                      height: hitBox.height,
                    },
                    front,
                  };
                }
              }
              if (!visibilityOnly && plain) {
                if (
                  opaqueIndex < 0 ||
                  stack
                    .slice(0, opaqueIndex + 1)
                    .some((node) => !ancestors.has(node) && !neutralSvgViewport(node))
                )
                  unobscured = false;
              }
            }
        }
      } finally {
        for (const [node, original] of svgPaint) {
          if (original.pointerEvents)
            node.style.setProperty('pointer-events', original.pointerEvents, original.priority);
          else node.style.removeProperty('pointer-events');
          if (!original.hadStyle && node.getAttribute('style') === '')
            node.removeAttribute('style');
        }
        if (previousPointerEvents)
          element.style.setProperty('pointer-events', previousPointerEvents, previousPriority);
        else element.style.removeProperty('pointer-events');
        if (!hadStyleAttribute && element.getAttribute('style') === '')
          element.removeAttribute('style');
      }
      if (!unobscured) {
        return [
          {
            code: 'unreachable-glyph',
            detail: `Text has no unobscured rendered area: ${JSON.stringify(firstObstruction)}`,
          },
        ];
      }
      if (visibilityOnly) return problems;
      if (!surface) return problems;
      const style = getComputedStyle(element);
      const size = Number.parseFloat(style.fontSize) * (svgText ? (svgMatrix?.d ?? 1) : 1);
      const large = size >= 24 || (size >= 56 / 3 && Number(style.fontWeight) >= 700);
      const requiredRatio = large ? 3 : 4.5;
      if (svgText && style.fill === 'none')
        return [{ code: 'unpainted-text', detail: 'SVG text has no foreground fill' }];
      const foreground = color(
        svgText ? (style.fill === 'currentcolor' ? style.color : style.fill) : style.color,
      );
      if (svgText) foreground[3] *= Number(style.fillOpacity);
      const ratio = contrast(foreground, surface);
      if (ratio < requiredRatio)
        problems.push({
          code: svgText ? 'svg-text-contrast' : 'glyph-contrast',
          detail: `Text contrast is ${ratio}:1; expected at least ${requiredRatio}:1`,
        });
      return problems;
    }

    if (paintMode === 'focus') {
      const style = getComputedStyle(element);
      const surface = background(parent(element));
      if (!surface) return problems;
      if (
        !element.matches(':focus') ||
        style.outlineStyle === 'none' ||
        Number.parseFloat(style.outlineWidth) <= 0
      ) {
        return [
          { code: 'missing-focus-indicator', detail: 'Keyboard focus has no visible outline' },
        ];
      }
      const ratio = contrast(color(style.outlineColor), surface);
      if (ratio < 3)
        problems.push({
          code: 'focus-contrast',
          detail: `Focus outline contrast is ${ratio}:1; expected at least 3:1`,
        });
      return problems;
    }

    const svgs = element.matches('svg') ? [element] : Array.from(element.querySelectorAll('svg'));
    let painted = 0;
    for (const svg of svgs) {
      if (
        !(svg instanceof SVGGraphicsElement) ||
        svg.getBoundingClientRect().width === 0 ||
        svg.getBoundingClientRect().height === 0
      )
        continue;
      if (
        getComputedStyle(svg).display === 'none' ||
        getComputedStyle(svg).visibility !== 'visible'
      )
        continue;
      const shapes = svg.querySelectorAll(
        'path, rect, circle, ellipse, line, polyline, polygon, text, use',
      );
      for (const shape of shapes) {
        if (!(shape instanceof SVGGraphicsElement)) continue;
        const box = shape.getBBox();
        const paintedBox = shape.getBoundingClientRect();
        const style = getComputedStyle(shape);
        if (
          (box.width === 0 && box.height === 0) ||
          (paintedBox.width === 0 && paintedBox.height === 0) ||
          style.display === 'none' ||
          style.visibility !== 'visible'
        )
          continue;
        const surface = background(shape);
        if (!surface) continue;
        for (const [paint, opacity] of [
          [box.width > 0 && box.height > 0 ? style.fill : 'none', style.fillOpacity],
          [Number.parseFloat(style.strokeWidth) > 0 ? style.stroke : 'none', style.strokeOpacity],
        ]) {
          if (!paint || paint === 'none') continue;
          const rgba = color(paint === 'currentcolor' ? style.color : paint);
          rgba[3] *= Number(opacity);
          if (rgba[3] === 0) continue;
          painted++;
          const ratio = contrast(rgba, surface);
          if (ratio < 3)
            problems.push({
              code: 'icon-contrast',
              detail: `SVG paint contrast is ${ratio}:1; expected at least 3:1`,
            });
        }
      }
    }
    if (painted === 0)
      problems.push({
        code: 'unpainted-icon',
        detail: 'Essential control has no visible painted SVG shape',
      });
    return problems;
  }, mode);
  return issues.map((issue) => ({ ...issue, target: target.toString() }));
}

export async function auditThemeReadability(
  page: Page,
  options: ThemeReadabilityOptions,
): Promise<ThemeReadabilityReport> {
  const issues: ThemeReadabilityIssue[] = [];
  const scheme = await page.locator('html').getAttribute('data-mantine-color-scheme');
  if (scheme !== options.scheme)
    issues.push({
      code: 'wrong-scheme',
      target: 'html',
      detail: `Expected ${options.scheme}, found ${scheme}`,
    });
  await page.evaluate(() => document.fonts.ready);
  issues.push(...(await settleIncidentalTooltips(page, options)));
  issues.push(...(await settleFiniteMotion(page)));
  if (options.required.length === 0)
    issues.push({
      code: 'empty-targets',
      target: options.scope ?? 'body',
      detail: 'At least one required element must be declared',
    });
  for (const target of options.required) {
    const targetIssues = await inspectTarget(target);
    issues.push(...targetIssues);
    if (targetIssues.length === 0) {
      const directText = await target.evaluate((element) => {
        if (element.children.length > 0 || (element.textContent?.trim() ?? '') === '') return null;
        if (element instanceof SVGTextContentElement && element.matches('text, tspan'))
          return 'svg-text' as const;
        if (
          element instanceof HTMLElement &&
          !element.matches(
            'button, input, select, textarea, a[href], [role="button"], [role="link"], [role="checkbox"], [role="switch"]',
          )
        )
          return 'plain-text-visibility' as const;
        return null;
      });
      // Axe can omit genuinely covered/clipped text entirely. Required text
      // must satisfy line visibility independently of whether axe tests it.
      if (directText) issues.push(...(await inspectPaint(target, directText)));
    }
  }
  for (const target of options.icons ?? []) {
    const targetIssues = await inspectTarget(target);
    issues.push(...targetIssues);
    if (targetIssues.length === 0) issues.push(...(await inspectPaint(target, 'icon')));
  }
  for (const target of options.focus ?? []) {
    const targetIssues = await inspectTarget(target);
    issues.push(...targetIssues);
    if (targetIssues.length > 0) continue;
    // Enter keyboard modality, then traverse away and back: :focus-visible is
    // measured after a real keyboard transition rather than a mouse click.
    await target.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    issues.push(...(await inspectPaint(target, 'focus')));
    await target.blur();
  }
  // Trial clicks deliberately exercise hit testing, but also hover controls.
  // Close those incidental tooltips and let their finite fades finish while
  // retaining explicitly opened dialogs, menus, and popovers.
  issues.push(...(await settleIncidentalTooltips(page, options)));
  issues.push(...(await settleFiniteMotion(page)));
  const axe = await new AxeBuilder({ page })
    .include(options.scope ?? 'body')
    .withRules(['color-contrast'])
    .analyze();
  const resolvedGlyphTargets: string[] = [];
  const resolvedTextTargets: ThemeReadabilityReport['resolvedTextTargets'] = [];
  const resolvedSvgTextTargets: ThemeReadabilityReport['resolvedSvgTextTargets'] = [];
  for (const [code, results] of [
    ['text-contrast', axe.violations],
    ['text-contrast-incomplete', axe.incomplete],
  ] as const) {
    for (const rule of results) {
      for (const node of rule.nodes) {
        const check = node.any[0];
        const checkData: unknown = check?.data;
        const selector = node.target[0];
        if (
          code === 'text-contrast-incomplete' &&
          rule.id === 'color-contrast' &&
          node.any.length === 1 &&
          node.all.length === 0 &&
          node.none.length === 0 &&
          check?.id === 'color-contrast' &&
          checkData !== null &&
          typeof checkData === 'object' &&
          'messageKey' in checkData &&
          (checkData.messageKey === 'nonBmp' ||
            checkData.messageKey === 'shortTextContent' ||
            checkData.messageKey === 'elmPartiallyObscuring' ||
            checkData.messageKey === 'imgNode' ||
            checkData.messageKey === 'bgOverlap') &&
          node.target.length === 1
        ) {
          const glyph = await resolveAxeTarget(page, options.scope, selector);
          if (!glyph) {
            issues.push({
              code: 'unresolved-target',
              target: JSON.stringify(node.target),
              detail: 'Review target is not a unique DOM or verified open-shadow chain',
            });
            continue;
          }
          const svgText =
            checkData.messageKey !== 'nonBmp' &&
            (await glyph.count()) === 1 &&
            (await glyph.evaluate(
              (element) =>
                element instanceof SVGTextContentElement && element.matches('text, tspan'),
            ));
          // Image-node and background-overlap reviews are resolved only for
          // SVG text with independently verified glyph/background geometry.
          if (
            !svgText &&
            (checkData.messageKey === 'imgNode' || checkData.messageKey === 'bgOverlap')
          ) {
            issues.push({
              code,
              target: JSON.stringify(node.target),
              detail: node.failureSummary ?? rule.help,
            });
            continue;
          }
          const targetIssues = await inspectTarget(glyph);
          const glyphIssues =
            targetIssues.length > 0
              ? targetIssues
              : await inspectPaint(
                  glyph,
                  svgText
                    ? 'svg-text'
                    : checkData.messageKey === 'nonBmp'
                      ? 'glyph'
                      : checkData.messageKey === 'shortTextContent'
                        ? 'short-text'
                        : 'plain-text',
                );
          if (glyphIssues.length === 0) {
            if (svgText && checkData.messageKey !== 'nonBmp')
              resolvedSvgTextTargets.push({
                target: typeof selector === 'string' ? selector : JSON.stringify(selector),
                reason: checkData.messageKey,
              });
            else if (checkData.messageKey === 'elmPartiallyObscuring')
              resolvedTextTargets.push({
                target: typeof selector === 'string' ? selector : JSON.stringify(selector),
                reason: 'elmPartiallyObscuring',
              });
            else
              resolvedGlyphTargets.push(
                typeof selector === 'string' ? selector : JSON.stringify(selector),
              );
            continue;
          }
          issues.push(...glyphIssues);
        }
        issues.push({
          code,
          target: JSON.stringify(node.target),
          detail: node.failureSummary ?? rule.help,
        });
      }
    }
  }
  const tested = [...axe.passes, ...axe.violations, ...axe.incomplete]
    .filter((result) => result.id === 'color-contrast')
    .reduce((total, result) => total + result.nodes.length, 0);
  if (tested === 0)
    issues.push({
      code: 'empty-contrast-scan',
      target: options.scope ?? 'body',
      detail: 'No text node was tested for color contrast',
    });
  return {
    scheme: options.scheme,
    issues,
    axe,
    resolvedGlyphTargets,
    resolvedTextTargets,
    resolvedSvgTextTargets,
  };
}

export async function expectThemeReadable(
  page: Page,
  testInfo: TestInfo,
  options: ThemeReadabilityOptions,
): Promise<void> {
  const report = await auditThemeReadability(page, options);
  if (report.issues.length > 0) {
    await testInfo.attach(`theme-${options.scheme}-readability.json`, {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach(`theme-${options.scheme}-readability.png`, {
      body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
      contentType: 'image/png',
    });
  }
  expect(
    report.issues,
    `Unreadable ${options.scheme} theme:\n${JSON.stringify(report.issues, null, 2)}`,
  ).toEqual([]);
}

export const collectThemeAudit = auditThemeReadability;
