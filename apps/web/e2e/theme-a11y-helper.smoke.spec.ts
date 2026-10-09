import { expect, test, type Page } from '@playwright/test';
import { auditThemeReadability } from './helpers/theme-a11y';

// Synthetic paint fixtures exercise the checker, without replacing application
// behavior coverage. Every defect below must be detected by the shared helper.
test.use({ storageState: { cookies: [], origins: [] } });

async function fixture(page: Page): Promise<void> {
  await page.setContent(`<!doctype html><html data-mantine-color-scheme="light"><head>
    <style>
      body { margin: 24px; background: white; color: black; font: 16px Arial; }
      button { color: black; background: white; border: 1px solid black; padding: 12px; }
      button:focus-visible { outline: 3px solid black; outline-offset: 3px; }
      svg { width: 20px; height: 20px; vertical-align: middle; }
    </style>
    </head><body><h1>Readable theme fixture</h1>
    <p id="copy">This required content must remain readable.</p>
    <div id="parent"><button id="action" type="button" aria-label="Fixture action">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 10h16M10 2v16" /></svg>
      <span>Continue</span>
    </button></div>
    <button type="button">Next control</button></body></html>`);
}

function targets(page: Page) {
  const action = page.getByRole('button', { name: 'Fixture action' });
  return {
    scheme: 'light' as const,
    required: [page.locator('#copy'), action],
    icons: [action],
    focus: [action],
  };
}

async function shortTextLineBox(page: Page, overflow: 'visible' | 'hidden') {
  return page.locator('#copy').evaluate((element, clipping) => {
    element.style.cssText = `font:12px/normal Arial;overflow:${clipping}`;
    const range = document.createRange();
    range.selectNodeContents(element);
    // Font metric boxes differ across OS/font fallbacks. Derive the deliberately
    // shorter line box from the browser's actual glyph geometry on this host.
    element.style.lineHeight = `${range.getBoundingClientRect().height / 2}px`;
    return {
      box: element.getBoundingClientRect().height,
      ink: range.getBoundingClientRect().height,
    };
  }, overflow);
}

async function opaquePopupFixture(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<!doctype html><html data-mantine-color-scheme="light"><style>
    * { box-sizing: border-box; } body { margin: 0; background: white; color: black; font: 12px/1.4 "Segoe UI", Arial; }
    #toolbar { position: absolute; top: 145px; left: 16px; width: 1408px; height: 35px; background: transparent; }
    #popup { position: absolute; left: 660px; top: 54px; width: 380px; padding: 22px; background: white; z-index: 300; }
    .scroll-root { position: relative; overflow: hidden; } .viewport { overflow: auto; width: 100%; height: 100%; } .content { display: table; min-width: 100%; }
    #message { margin: 0; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; color: #495057; }
    </style><body><div id="toolbar">Underlying toolbar</div><div id="popup"><div style="height:65px">Avisos</div>
    <div class="scroll-root"><div class="viewport"><div class="content"><p id="message">A autorização da loja e2e-theme-check-1791554838923-w0-theme-readability-shop expira em 3 dia(s). Reautorize escolhendo 365 dias para não repetir o processo em breve.</p></div></div></div></div></body></html>`);
}

function popupTargets(page: Page) {
  return { scheme: 'light' as const, scope: '#popup', required: [page.locator('#message')] };
}

async function shadowPopupFixture(page: Page): Promise<void> {
  await opaquePopupFixture(page);
  await page.locator('#popup .scroll-root').evaluate((outer) => {
    const host = document.createElement('shadow-fixture');
    host.style.display = 'block';
    const content = outer.outerHTML;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>.scroll-root {position:relative;overflow:hidden}.viewport {overflow:auto;width:100%;height:100%}.content {display:table;min-width:100%}#message {margin:0;font:12px/1.4 "Segoe UI",Arial;overflow-wrap:anywhere;color:#495057}</style>${content}`;
    outer.replaceWith(host);
  });
}

function shadowTargets(page: Page) {
  return {
    scheme: 'light' as const,
    scope: '#popup',
    required: [page.locator('shadow-fixture').locator('#message')],
  };
}

async function chartFixture(page: Page): Promise<void> {
  await page.setContent(`<!doctype html><html data-mantine-color-scheme="light"><style>
    body {margin:24px;background:white;color:black;font:16px Arial}
    #chart {position:relative;width:480px;height:240px;background:white}
    svg {display:block} text {font:12px Arial;fill:currentColor;color:#495057}
    #center-layer {position:absolute;left:260px;top:0}
    </style><body><h1>Populated chart fixture</h1><div id="chart">
    <svg width="480" height="240" role="application" viewBox="0 0 480 240">
      <defs><clipPath id="unused-clip"><rect width="480" height="240"/></clipPath>
        <linearGradient id="gradient"><stop stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient></defs>
      <rect id="bar" x="80" y="20" width="100" height="90" fill="#1971c2"/>
      <path id="ring" fill="#1971c2" fill-rule="evenodd" d="M280 90a70 70 0 1 0 140 0a70 70 0 1 0-140 0M300 90a50 50 0 1 0 100 0a50 50 0 1 0-100 0"/>
      <text x="20" y="170"><tspan id="axis" x="20">Produto CI</tspan></text>
      <text x="20" y="210"><tspan id="count" x="20">2</tspan></text>
    </svg><svg id="center-layer" width="180" height="180">
      <text id="center" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" style="font-size:14px">500 pedidos</text>
    </svg></div></body></html>`);
}

function chartTargets(page: Page) {
  return {
    scheme: 'light' as const,
    required: [page.locator('#axis'), page.locator('#count'), page.locator('#center')],
  };
}

test.describe('Theme readability checker rejects rendering defects', () => {
  test.beforeEach(async ({ page }) => fixture(page));

  test('accepts the corrected text, icon, and keyboard focus paint', async ({ page }) => {
    expect((await auditThemeReadability(page, targets(page))).issues).toEqual([]);
  });

  test('rejects low-contrast text', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.style.color = '#dddddd';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues.some((issue) => issue.code === 'text-contrast')).toBe(true);
  });

  test('rejects 1:1 text even when axe marks it incomplete', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.style.color = 'white';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.axe.incomplete.some((result) => result.id === 'color-contrast')).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'text-contrast-incomplete')).toBe(true);
  });

  test('rejects missing required content', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => el.remove());
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'missing-or-ambiguous',
      ),
    ).toBe(true);
  });

  test('rejects required content hidden with display none', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.style.display = 'none';
    });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'hidden',
      ),
    ).toBe(true);
  });

  test('rejects an otherwise visible control inside a zero-opacity ancestor', async ({ page }) => {
    await page.locator('#parent').evaluate((el) => {
      el.style.opacity = '0';
    });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'zero-opacity',
      ),
    ).toBe(true);
  });

  test('rejects low-contrast icon paint while its button text remains readable', async ({
    page,
  }) => {
    await page.locator('#action svg').evaluate((el) => {
      el.style.stroke = '#dddddd';
    });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'icon-contrast',
      ),
    ).toBe(true);
  });

  test('rejects an essential SVG with no painted shape', async ({ page }) => {
    await page.locator('#action svg').evaluate((el) => {
      el.style.stroke = 'none';
    });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'unpainted-icon',
      ),
    ).toBe(true);
  });

  test('rejects a fill-only SVG path with no enclosed area', async ({ page }) => {
    await page.locator('#action svg').evaluate((el) => {
      el.setAttribute('fill', 'black');
      el.setAttribute('stroke', 'none');
      el.querySelector('path')?.setAttribute('d', 'M2 10h16');
    });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'unpainted-icon',
      ),
    ).toBe(true);
  });

  test('accepts a stroked SVG line with zero fill area', async ({ page }) => {
    await page.locator('#action svg path').evaluate((el) => el.setAttribute('d', 'M2 10h16'));
    expect((await auditThemeReadability(page, targets(page))).issues).toEqual([]);
  });

  test('rejects an imperceptible keyboard focus outline', async ({ page }) => {
    await page.addStyleTag({ content: 'button:focus-visible { outline-color: white; }' });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'focus-contrast',
      ),
    ).toBe(true);
  });

  test('accepts currentColor on composited translucent dark surfaces', async ({ page }) => {
    await page
      .locator('html')
      .evaluate((el) => el.setAttribute('data-mantine-color-scheme', 'dark'));
    await page.addStyleTag({
      content:
        'body { background: #111; color: white; } #parent { background: rgba(255,255,255,.1); } button { color: white; background: rgba(255,255,255,.1); } button:focus-visible { outline-color: white; }',
    });
    expect(
      (await auditThemeReadability(page, { ...targets(page), scheme: 'dark' })).issues,
    ).toEqual([]);
  });

  test('rejects transparent icon paint that cannot meet contrast', async ({ page }) => {
    await page.addStyleTag({ content: '#action svg { stroke-opacity: .05; }' });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'icon-contrast',
      ),
    ).toBe(true);
  });

  test('rejects missing keyboard focus outlines', async ({ page }) => {
    await page.addStyleTag({ content: 'button:focus-visible { outline: none; }' });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'missing-focus-indicator',
      ),
    ).toBe(true);
  });

  test('rejects required content clipped by its parent', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      const clip = document.createElement('div');
      clip.style.cssText = 'width: 30px; overflow: hidden';
      el.replaceWith(clip);
      clip.append(el);
      el.style.width = '300px';
    });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'clipped',
      ),
    ).toBe(true);
  });

  test('rejects a disabled essential control', async ({ page }) => {
    await page.locator('#action').evaluate((el) => el.setAttribute('disabled', ''));
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'disabled',
      ),
    ).toBe(true);
  });

  test('rejects an empty contrast scan instead of passing vacuously', async ({ page }) => {
    await page.locator('#action span').evaluate((el) => el.remove());
    const action = page.locator('#action');
    const report = await auditThemeReadability(page, {
      scheme: 'light',
      scope: '#action',
      required: [action],
      icons: [action],
    });
    expect(report.issues.some((issue) => issue.code === 'empty-contrast-scan')).toBe(true);
  });

  test('detects zero opacity across an open shadow boundary', async ({ page }) => {
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'shadow-host';
      host.style.opacity = '0';
      host.attachShadow({ mode: 'open' }).innerHTML =
        '<p id="shadow-copy">Required shadow content</p>';
      document.body.append(host);
    });
    const report = await auditThemeReadability(page, {
      scheme: 'light',
      required: [page.locator('#shadow-copy')],
    });
    expect(report.issues.some((issue) => issue.code === 'zero-opacity')).toBe(true);
  });

  test('measures a readable monochrome status glyph that axe defers', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.textContent = '✓';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.axe.incomplete.some((rule) => rule.id === 'color-contrast')).toBe(true);
    expect(report.resolvedGlyphTargets).toContain('#copy');
    expect(report.issues).toEqual([]);
  });

  for (const color of ['#dddddd', 'white']) {
    test(`rejects ${color} monochrome status glyph paint on white`, async ({ page }) => {
      await page.locator('#copy').evaluate((el, textColor) => {
        el.textContent = '✓';
        el.style.color = textColor;
      }, color);
      const report = await auditThemeReadability(page, targets(page));
      expect(report.issues.some((issue) => issue.code === 'glyph-contrast')).toBe(true);
      expect(report.resolvedGlyphTargets).not.toContain('#copy');
    });
  }

  test('does not treat a native colour emoji as a monochrome status glyph', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.textContent = '😀';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.resolvedGlyphTargets).not.toContain('#copy');
    // Axe may omit native colour emoji from the text rule on this platform;
    // regardless, the CSS foreground fallback must never claim to measure it.
    expect(report.resolvedGlyphTargets).toEqual([]);
  });

  test('accepts a short numeric badge meeting the normal-text contrast threshold', async ({
    page,
  }) => {
    await page.locator('#copy').evaluate((el) => {
      el.textContent = '1';
      el.style.cssText =
        'display: inline-flex; align-items: center; justify-content: center; font-size: 12px; width: 16px; height: 16px; background: #c92a2a; color: white; pointer-events: none';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues).toEqual([]);
  });

  test('rejects low contrast on short numeric badges', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.textContent = '1';
      el.style.cssText =
        'display: inline-flex; font-size: 12px; width: 16px; height: 16px; background: white; color: #eeeeee; pointer-events: none';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(
      report.issues.some(
        (issue) => issue.code === 'glyph-contrast' || issue.code === 'text-contrast',
      ),
    ).toBe(true);
    expect(report.resolvedGlyphTargets).not.toContain('#copy');
  });

  test('rejects 1:1 short numeric text', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.textContent = '1';
      el.style.cssText =
        'display: inline-flex; font-size: 12px; width: 16px; height: 16px; background: white; color: white; pointer-events: none';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(
      report.issues.some((issue) =>
        ['glyph-contrast', 'text-contrast', 'text-contrast-incomplete'].includes(issue.code),
      ),
    ).toBe(true);
    expect(report.resolvedGlyphTargets).not.toContain('#copy');
  });

  test('measures pointer-disabled status paint and restores its inline rule', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.textContent = '✓';
      el.style.setProperty('pointer-events', 'none', 'important');
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues).toEqual([]);
    expect(report.resolvedGlyphTargets).toContain('#copy');
    expect(
      await page
        .locator('#copy')
        .evaluate((el) => [
          el.style.getPropertyValue('pointer-events'),
          el.style.getPropertyPriority('pointer-events'),
        ]),
    ).toEqual(['none', 'important']);
  });

  test('rejects an overlay obscuring pointer-disabled status text', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.textContent = '✓';
      el.style.pointerEvents = 'none';
      const rect = el.getBoundingClientRect();
      const overlay = document.createElement('div');
      overlay.style.cssText = `position: fixed; top: ${rect.y}px; left: ${rect.x}px; width: ${rect.width}px; height: ${rect.height}px; background: white; z-index: 99`;
      document.body.append(overlay);
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues.some((issue) => issue.code === 'unreachable-glyph')).toBe(true);
    expect(report.resolvedGlyphTargets).not.toContain('#copy');
  });

  test('rejects essential SVG gradient paint instead of guessing a CSS color', async ({ page }) => {
    await page.locator('#action svg').evaluate((el) => {
      el.innerHTML =
        '<defs><linearGradient id="fixture-gradient"><stop stop-color="black"/><stop offset="1" stop-color="white"/></linearGradient></defs><path d="M2 2h16v16H2Z" fill="url(#fixture-gradient)" stroke="none"/>';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues.some((issue) => issue.code === 'unsupported-paint')).toBe(true);
  });

  test('measures the settled foreground after a finite fade', async ({ page }) => {
    await page.addStyleTag({
      content:
        '@keyframes readable-fade { from { opacity: .2; } to { opacity: 1; } } #copy { color: white; background: black; animation: readable-fade 150ms linear forwards; }',
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues).toEqual([]);
    expect(await page.locator('#copy').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });

  test('keeps stable partial-opacity icon surfaces unresolved', async ({ page }) => {
    await page.locator('#parent').evaluate((el) => {
      el.style.opacity = '.6';
    });
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues.some((issue) => issue.code === 'unsupported-paint')).toBe(true);
  });

  test('measures unobscured text above varying elements behind an opaque popup', async ({
    page,
  }) => {
    await opaquePopupFixture(page);
    const report = await auditThemeReadability(page, popupTargets(page));
    expect(
      report.axe.incomplete.some((rule) =>
        rule.nodes.some((node) =>
          node.any.some((check) => check.data?.messageKey === 'elmPartiallyObscuring'),
        ),
      ),
    ).toBe(true);
    expect(report.resolvedTextTargets).toEqual([
      { target: '#message', reason: 'elmPartiallyObscuring' },
    ]);
    expect(report.issues).toEqual([]);
  });

  test('rejects low-contrast text despite the opaque-popup review reason', async ({ page }) => {
    await opaquePopupFixture(page);
    await page.locator('#message').evaluate((el) => {
      el.style.color = '#eeeeee';
    });
    const report = await auditThemeReadability(page, popupTargets(page));
    expect(report.issues.some((issue) => issue.code === 'glyph-contrast')).toBe(true);
    expect(report.resolvedTextTargets).toEqual([]);
  });

  test('rejects a real foreground occluder over popup text', async ({ page }) => {
    await opaquePopupFixture(page);
    await page.locator('#message').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rect = range.getClientRects()[0]!;
      const occluder = document.createElement('div');
      occluder.style.cssText = `position: fixed; z-index: 400; left: ${rect.x + 10}px; top: ${rect.y}px; width: 80px; height: ${rect.height}px; background: white`;
      document.body.append(occluder);
    });
    const report = await auditThemeReadability(page, popupTargets(page));
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.resolvedTextTargets).toEqual([]);
  });

  test('resolves a deferred selector only inside its scan scope', async ({ page }) => {
    await page.locator('#copy').evaluate((el) => {
      el.textContent = '✓';
      const scope = document.createElement('section');
      scope.id = 'scan-scope';
      el.replaceWith(scope);
      scope.append(el);
      const outside = el.cloneNode(true);
      document.body.append(outside);
    });
    expect(await page.locator('#copy').count()).toBe(2);
    const scope = page.locator('#scan-scope');
    const report = await auditThemeReadability(page, {
      scheme: 'light',
      scope: '#scan-scope',
      required: [scope.locator('#copy')],
    });
    expect(report.issues).toEqual([]);
    expect(report.resolvedGlyphTargets).toHaveLength(1);
  });

  test('resolves verified open-shadow review chains and measures opaque paint', async ({
    page,
  }) => {
    await shadowPopupFixture(page);
    const report = await auditThemeReadability(page, shadowTargets(page));
    expect(
      report.axe.incomplete.some((rule) =>
        rule.nodes.some((node) => Array.isArray(node.target[0])),
      ),
    ).toBe(true);
    expect(report.resolvedTextTargets).toHaveLength(1);
    expect(report.issues).toEqual([]);
  });

  test('rejects low contrast inside an open-shadow foreground', async ({ page }) => {
    await shadowPopupFixture(page);
    await page
      .locator('shadow-fixture')
      .locator('#message')
      .evaluate((el) => {
        el.style.color = '#eeeeee';
      });
    const report = await auditThemeReadability(page, shadowTargets(page));
    expect(report.issues.some((issue) => issue.code === 'glyph-contrast')).toBe(true);
    expect(report.resolvedTextTargets).toEqual([]);
  });

  test('preserves external occluders above a shadow host in hit stacks', async ({ page }) => {
    await shadowPopupFixture(page);
    await page
      .locator('shadow-fixture')
      .locator('#message')
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rect = range.getClientRects()[0]!;
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;z-index:400;left:${rect.x + 10}px;top:${rect.y}px;width:80px;height:${rect.height}px;background:white`;
        document.body.append(overlay);
      });
    const report = await auditThemeReadability(page, shadowTargets(page));
    expect(report.issues.some((issue) => issue.code === 'unreachable-glyph')).toBe(true);
    expect(report.resolvedTextTargets).toEqual([]);
  });

  test('rejects an occluder within the same shadow root', async ({ page }) => {
    await shadowPopupFixture(page);
    await page
      .locator('shadow-fixture')
      .locator('#message')
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rect = range.getClientRects()[0]!;
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;z-index:400;left:${rect.x + 10}px;top:${rect.y}px;width:80px;height:${rect.height}px;background:white`;
        el.getRootNode().appendChild(overlay);
      });
    const report = await auditThemeReadability(page, shadowTargets(page));
    expect(report.issues.some((issue) => issue.code === 'unreachable-glyph')).toBe(true);
    expect(report.resolvedTextTargets).toEqual([]);
  });

  test('ignores a pseudo-element with zero opacity while measuring actual icon paint', async ({
    page,
  }) => {
    await page.addStyleTag({
      content:
        '#action {position:relative;overflow:hidden} #action::before {content:"";position:absolute;inset:0;background:black;opacity:0;transform:translateY(-100%)}',
    });
    expect((await auditThemeReadability(page, targets(page))).issues).toEqual([]);
  });

  test('keeps nonzero painted pseudo-elements unsupported', async ({ page }) => {
    await page.addStyleTag({
      content:
        '#action {position:relative} #action::before {content:"";position:absolute;inset:0;background:black;opacity:.1}',
    });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'unsupported-paint',
      ),
    ).toBe(true);
  });

  test('does not infer solid paint through translucent backdrop blur', async ({ page }) => {
    await page.addStyleTag({
      content: '#parent {background:rgba(255,255,255,.9);backdrop-filter:blur(4px)}',
    });
    expect(
      (await auditThemeReadability(page, targets(page))).issues.some(
        (issue) => issue.code === 'unsupported-paint',
      ),
    ).toBe(true);
  });

  test('measures SVG chart labels and a donut center against verified solid paint', async ({
    page,
  }) => {
    await chartFixture(page);
    const report = await auditThemeReadability(page, chartTargets(page));
    expect(report.issues).toEqual([]);
    expect(report.resolvedSvgTextTargets.length).toBeGreaterThan(0);
    expect(report.resolvedSvgTextTargets.some(({ target }) => target.includes('#count'))).toBe(
      true,
    );
  });

  test('rejects low-contrast SVG text fill even when CSS text color is readable', async ({
    page,
  }) => {
    await chartFixture(page);
    await page.addStyleTag({ content: '#count {fill:#dddddd}' });
    const report = await auditThemeReadability(page, chartTargets(page));
    expect(report.issues.some((issue) => issue.code === 'svg-text-contrast')).toBe(true);
  });

  test('rejects SVG text genuinely covered by a foreground overlay', async ({ page }) => {
    await chartFixture(page);
    await page.locator('#axis').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const overlay = document.createElement('div');
      overlay.style.cssText = `position:fixed;z-index:10;left:${rect.left + 4}px;top:${rect.top}px;width:20px;height:${rect.height}px;background:white`;
      document.body.append(overlay);
    });
    const report = await auditThemeReadability(page, chartTargets(page));
    expect(report.issues.some((issue) => issue.code === 'unreachable-glyph')).toBe(true);
  });

  test('rejects unsupported SVG text gradient fill', async ({ page }) => {
    await chartFixture(page);
    await page.addStyleTag({ content: '#count {fill:url(#gradient)}' });
    const report = await auditThemeReadability(page, chartTargets(page));
    expect(report.issues.some((issue) => issue.code === 'unsupported-paint')).toBe(true);
  });

  test('rejects SVG background paint with pointer events disabled and restores its rule', async ({
    page,
  }) => {
    await chartFixture(page);
    await page.locator('#bar').evaluate((element) => {
      element.setAttribute('x', '15');
      element.setAttribute('y', '190');
      element.setAttribute('height', '35');
      element.setAttribute('style', 'pointer-events:none !important');
    });
    const report = await auditThemeReadability(page, chartTargets(page));
    expect(report.issues.some((issue) => issue.code === 'unsupported-svg-background')).toBe(true);
    expect(await page.locator('#bar').getAttribute('style')).toBe(
      'pointer-events: none !important;',
    );
  });

  test('does not mistake an adjacent SVG label guide for paint under the glyph cells', async ({
    page,
  }) => {
    await chartFixture(page);
    await page.locator('#axis').evaluate((element) => {
      if (!(element instanceof SVGTextContentElement))
        throw new Error('Expected an SVG text label');
      const cell = element.getExtentOfChar(0);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(cell.x - 12));
      line.setAttribute('x2', String(cell.x - 1));
      line.setAttribute('y1', String(cell.y + cell.height / 2));
      line.setAttribute('y2', String(cell.y + cell.height / 2));
      line.setAttribute('stroke', 'black');
      line.setAttribute('stroke-width', '1');
      element.closest('svg')?.append(line);
    });
    expect((await auditThemeReadability(page, chartTargets(page))).issues).toEqual([]);
  });

  test('rejects SVG text clipped by its viewport', async ({ page }) => {
    await chartFixture(page);
    await page
      .locator('#chart > svg')
      .first()
      .evaluate((element) => {
        element.removeAttribute('viewBox');
        element.setAttribute('width', '35');
        element.style.overflow = 'hidden';
        element.style.width = '35px';
      });
    const clipping = await page.locator('#axis').evaluate((element) => ({
      inkRight: element.getBoundingClientRect().right,
      viewportRight: element.closest('svg')!.getBoundingClientRect().right,
    }));
    expect(clipping.inkRight).toBeGreaterThan(clipping.viewportRight);
    const report = await auditThemeReadability(page, chartTargets(page));
    expect(
      report.issues.some((issue) =>
        ['clipped', 'clipped-text', 'unreachable-glyph'].includes(issue.code),
      ),
    ).toBe(true);
  });

  test('rejects an unsupported SVG image beneath chart text with pointer events disabled', async ({
    page,
  }) => {
    await chartFixture(page);
    await page.locator('#count').evaluate((element) => {
      const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      image.setAttribute('x', '15');
      image.setAttribute('y', '190');
      image.setAttribute('width', '40');
      image.setAttribute('height', '35');
      image.setAttribute('style', 'pointer-events:none');
      image.setAttribute(
        'href',
        `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="35"><rect width="40" height="35" fill="white"/></svg>')}`,
      );
      element.closest('svg')?.insertBefore(image, element.parentElement);
    });
    const report = await auditThemeReadability(page, chartTargets(page));
    expect(report.issues.some((issue) => issue.code === 'unsupported-svg-background')).toBe(true);
  });

  for (const zeroLength of [false, true]) {
    test(`does not infer empty SVG background from ${zeroLength ? 'zero-length' : 'nonzero'} geometry with marker paint`, async ({
      page,
    }) => {
      await chartFixture(page);
      await page.locator('#count').evaluate((element, emptyGeometry) => {
        const svg = element.closest('svg')!;
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.id = 'marker';
        marker.setAttribute('viewBox', '0 0 20 20');
        marker.setAttribute('refX', '0');
        marker.setAttribute('refY', '10');
        marker.setAttribute('markerWidth', '20');
        marker.setAttribute('markerHeight', '20');
        marker.setAttribute('markerUnits', 'userSpaceOnUse');
        marker.innerHTML = '<path d="M0 0L20 10L0 20Z" fill="blue"/>';
        svg.querySelector('defs')!.append(marker);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', emptyGeometry ? '18' : '0');
        line.setAttribute('x2', '18');
        line.setAttribute('y1', '205');
        line.setAttribute('y2', '205');
        line.setAttribute('stroke', 'blue');
        line.setAttribute('marker-end', 'url(#marker)');
        svg.insertBefore(line, element.parentElement);
      }, zeroLength);
      const report = await auditThemeReadability(page, chartTargets(page));
      expect(report.issues.some((issue) => issue.code === 'unsupported-svg-background')).toBe(true);
    });
  }

  test('rejects zero-length SVG stroke caps painting behind text with pointer events disabled', async ({
    page,
  }) => {
    await chartFixture(page);
    await page.locator('#count').evaluate((element) => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '23');
      line.setAttribute('x2', '23');
      line.setAttribute('y1', '203');
      line.setAttribute('y2', '203');
      line.setAttribute('stroke', 'blue');
      line.setAttribute('stroke-width', '20');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('style', 'pointer-events:none');
      element.closest('svg')?.insertBefore(line, element.parentElement);
    });
    const report = await auditThemeReadability(page, chartTargets(page));
    expect(report.issues.some((issue) => issue.code === 'unsupported-svg-background')).toBe(true);
  });

  test('waits for a JS-delayed incidental tooltip exit before measuring', async ({ page }) => {
    await page.addStyleTag({
      content:
        'body {background:#242424;color:white} #action {color:black;background:white} button:focus-visible {outline-color:white}',
    });
    await page.locator('#action').evaluate((button) => {
      let close: ReturnType<typeof setTimeout>;
      button.addEventListener('mouseenter', () => {
        clearTimeout(close);
        if (document.querySelector('[role="tooltip"]')) return;
        const tooltip = document.createElement('div');
        tooltip.id = 'delayed-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = 'Incidental help';
        tooltip.style.cssText =
          'position:fixed;top:200px;left:24px;color:black;background:#e9ecef;padding:8px;pointer-events:none;transition:opacity 150ms linear';
        document.body.append(tooltip);
      });
      button.addEventListener('mouseleave', () => {
        close = setTimeout(() => {
          const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
          if (!tooltip) return;
          tooltip.style.opacity = '0';
          setTimeout(() => tooltip.remove(), 170);
        }, 1_000);
      });
    });
    const action = page.locator('#action');
    await action.hover();
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues).toEqual([]);
    await expect(page.locator('#delayed-tooltip')).toHaveCount(0);
  });

  test('still rejects solid low contrast when a tooltip is explicitly audited', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const tooltip = document.createElement('div');
      tooltip.id = 'declared-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = 'This declared help has insufficient contrast';
      tooltip.style.cssText = 'color:#dddddd;background:white;padding:8px';
      document.body.append(tooltip);
      document.querySelector('#action')?.addEventListener('mouseleave', () => tooltip.remove());
    });
    await page.locator('#action').hover();
    const report = await auditThemeReadability(page, {
      scheme: 'light',
      scope: '#declared-tooltip',
      required: [page.locator('#declared-tooltip')],
    });
    expect(report.issues.some((issue) => issue.code === 'text-contrast')).toBe(true);
    await expect(page.locator('#declared-tooltip')).toBeVisible();
  });

  for (const readable of [true, false]) {
    test(`${readable ? 'accepts readable' : 'rejects low-contrast'} help retained by the focused trigger`, async ({
      page,
    }) => {
      await page.locator('#action').evaluate((button, hasContrast) => {
        button.addEventListener('focus', () => {
          const tooltip = document.createElement('div');
          tooltip.id = 'focused-tooltip';
          tooltip.setAttribute('role', 'tooltip');
          tooltip.textContent = 'Help remains open while its trigger has focus';
          tooltip.style.cssText = `position:fixed;top:240px;left:24px;color:${hasContrast ? 'black' : '#dddddd'};background:white;padding:8px;pointer-events:none`;
          document.body.append(tooltip);
          button.setAttribute('aria-describedby', 'focused-tooltip');
        });
        button.addEventListener('mouseleave', () => {
          if (document.activeElement !== button)
            document.querySelector('#focused-tooltip')?.remove();
        });
        button.addEventListener('blur', () => document.querySelector('#focused-tooltip')?.remove());
      }, readable);
      const action = page.locator('#action');
      await action.click();
      const report = await auditThemeReadability(page, {
        scheme: 'light',
        required: [page.locator('#copy'), action],
        icons: [action],
      });
      await expect(action).toBeFocused();
      await expect(page.locator('#focused-tooltip')).toBeVisible();
      expect(report.issues.some((issue) => issue.code === 'unsettled-tooltip')).toBe(false);
      if (readable) {
        expect(report.issues).toEqual([]);
        expect(
          report.axe.passes.some((rule) =>
            rule.nodes.some((node) => node.target.includes('#focused-tooltip')),
          ),
        ).toBe(true);
      } else {
        expect(
          report.issues.some(
            (issue) => issue.code === 'text-contrast' && issue.target.includes('#focused-tooltip'),
          ),
        ).toBe(true);
      }
    });
  }

  test('accepts visible font ink extending beyond a short line box', async ({ page }) => {
    const metrics = await shortTextLineBox(page, 'visible');
    expect(metrics.ink).toBeGreaterThan(metrics.box);
    expect((await auditThemeReadability(page, targets(page))).issues).toEqual([]);
  });

  test('rejects font ink clipped by the element own overflow boundary', async ({ page }) => {
    const metrics = await shortTextLineBox(page, 'hidden');
    expect(metrics.ink).toBeGreaterThan(metrics.box);
    const report = await auditThemeReadability(page, targets(page));
    expect(report.issues.some((issue) => issue.code === 'clipped-text')).toBe(true);
  });

  test('rejects clipped text lines rather than resolving their overlap review', async ({
    page,
  }) => {
    await opaquePopupFixture(page);
    await page.locator('#message').evaluate((el) => {
      el.style.maxHeight = '30px';
      el.style.overflow = 'hidden';
    });
    await page.locator('#toolbar').evaluate((el) => {
      el.style.height = '8px';
    });
    const report = await auditThemeReadability(page, popupTargets(page));
    expect(report.issues.some((issue) => issue.code === 'clipped-text')).toBe(true);
    expect(report.resolvedTextTargets).toEqual([]);
  });
});
