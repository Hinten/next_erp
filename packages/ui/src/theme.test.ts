import { DEFAULT_THEME, darken, mergeMantineTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { cssVariablesResolver, theme } from './theme';

/** `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)` → its RGB channels and alpha. */
function channels(color: string): [number, number, number, number] {
  if (!color.startsWith('#')) {
    const [r, g, b, a = 1] = color.match(/[\d.]+/g)!.map(Number);
    return [r!, g!, b!, a];
  }
  const hex =
    color.length === 4
      ? color
          .slice(1)
          .split('')
          .map((channel) => channel + channel)
          .join('')
      : color.slice(1);
  const [r, g, b] = hex.match(/../g)!.map((channel) => Number.parseInt(channel, 16));
  return [r!, g!, b!, 1];
}

function luminance(color: string): number {
  return channels(color)
    .slice(0, 3)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Source-over composite of a translucent tint on an opaque surface. */
function over(tint: string, surface: string): string {
  const [r, g, b, a] = channels(tint);
  const base = channels(surface);
  return `rgb(${[r, g, b].map((channel, index) => channel * a + base[index]! * (1 - a)).join(', ')})`;
}

describe('theme.colors.entrada', () => {
  it('has exactly 10 non-empty shade strings', () => {
    const entrada = theme.colors?.entrada;
    expect(entrada).toHaveLength(10);
    entrada?.forEach((shade) => {
      expect(typeof shade).toBe('string');
      expect(shade.length).toBeGreaterThan(0);
    });
  });
});

describe('theme readability', () => {
  const merged = mergeMantineTheme(DEFAULT_THEME, theme);
  const variables = cssVariablesResolver(merged);

  it.each(['light', 'dark'] as const)(
    'keeps white filled-button text readable in %s mode',
    (scheme) => {
      const shade =
        typeof merged.primaryShade === 'number' ? merged.primaryShade : merged.primaryShade[scheme];
      expect(contrast('#ffffff', merged.colors.blue[shade]!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('keeps dimmed text readable on every custom light surface', () => {
    for (const background of [
      merged.white,
      merged.colors.gray[0],
      merged.colors.blue[1],
      merged.colors.violet[1],
      merged.colors.yellow[1],
      variables.light['--erp-entrada-surface']!,
    ]) {
      expect(
        contrast(variables.light['--mantine-color-dimmed']!, background),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps dimmed text readable on every custom dark surface', () => {
    for (const background of [
      merged.colors.dark[7],
      merged.colors.dark[6],
      merged.colors.dark[5],
      darken(merged.colors.blue[9], 0.5),
      darken(merged.colors.violet[9], 0.5),
      darken(merged.colors.yellow[9], 0.5),
      variables.dark['--erp-entrada-surface']!,
    ]) {
      expect(
        contrast(variables.dark['--mantine-color-dimmed']!, background),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps light badge/alert text readable across every palette, including its hover surface', () => {
    for (const [name, colors] of Object.entries(merged.colors)) {
      for (const background of [colors[1], colors[2]]) {
        expect(
          contrast(variables.light[`--mantine-color-${name}-light-color`]!, background),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // An outline badge/button has a TRANSPARENT background, so its label sits on
  // whatever surface holds it: the page, a striped or hovered table row
  // (Mantine's Table uses gray-0/gray-1 in light, dark-6/dark-5 in dark), an
  // entrada screen — or, under the pointer, its own 5% hover tint over those.
  // Mantine's defaults failed here on 2026-10-13: the green "Vinculada" badge
  // in /pagamentos/mercado-pago measured 3.44:1 on white.
  it('keeps light outline text readable across every palette on every surface it sits on', () => {
    const surfaces = [
      merged.white,
      merged.colors.gray[0],
      merged.colors.gray[1],
      variables.light['--erp-entrada-surface']!,
    ];
    for (const name of Object.keys(merged.colors)) {
      const foreground = variables.light[`--mantine-color-${name}-outline`]!;
      const hover = variables.light[`--mantine-color-${name}-outline-hover`]!;
      for (const background of [...surfaces, ...surfaces.map((surface) => over(hover, surface))]) {
        expect(contrast(foreground, background), `${name} on ${background}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('keeps dark outline text readable across every accent palette on every surface it sits on', () => {
    const surfaces = [
      merged.colors.dark[7],
      merged.colors.dark[6],
      merged.colors.dark[5],
      variables.dark['--erp-entrada-surface']!,
    ];
    for (const name of Object.keys(merged.colors)) {
      // `dark` is the dark scheme's own surface ramp, not an accent: no shade of
      // it can stand out on itself (Mantine's default outline is 1.5:1 there).
      if (name === 'dark') continue;
      const foreground = variables.dark[`--mantine-color-${name}-outline`]!;
      const hover = variables.dark[`--mantine-color-${name}-outline-hover`]!;
      for (const background of [...surfaces, ...surfaces.map((surface) => over(hover, surface))]) {
        expect(contrast(foreground, background), `${name} on ${background}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('keeps keyboard focus visible against light and dark surrounding surfaces', () => {
    expect(contrast(variables.light['--erp-focus-ring']!, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(
      contrast(variables.dark['--erp-focus-ring']!, merged.colors.dark[5]),
    ).toBeGreaterThanOrEqual(3);
  });

  it('keeps dark accent text and light-variant text readable over actual light/hover surfaces', () => {
    for (const [name, colors] of Object.entries(merged.colors)) {
      for (const background of [darken(colors[9], 0.5), darken(colors[9], 0.3)]) {
        for (const role of ['text', 'light-color']) {
          expect(
            contrast(variables.dark[`--mantine-color-${name}-${role}`]!, background),
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('keeps dark links readable inside status alerts and tinted hover surfaces', () => {
    const backgrounds = [
      merged.colors.dark[7],
      merged.colors.dark[6],
      merged.colors.dark[5],
      variables.dark['--erp-entrada-surface']!,
      ...Object.values(merged.colors).flatMap((colors) => [
        darken(colors[9], 0.5),
        darken(colors[9], 0.3),
      ]),
    ];
    for (const background of backgrounds) {
      expect(
        contrast(variables.dark['--mantine-color-anchor']!, background),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('cssVariablesResolver', () => {
  it('emits --erp-entrada-surface in both light and dark maps, sourced from entrada[0] / entrada[9]', () => {
    const merged = mergeMantineTheme(DEFAULT_THEME, theme);
    const entrada = merged.colors.entrada;
    expect(entrada).toBeDefined();
    const result = cssVariablesResolver(merged);

    expect(result.light['--erp-entrada-surface']).toBe(entrada?.[0]);
    expect(result.dark['--erp-entrada-surface']).toBe(entrada?.[9]);
    // Keep the semantic variable theme-owned: no hardcoded hex duplicated here.
    expect(result.variables).toEqual({});
  });
});
