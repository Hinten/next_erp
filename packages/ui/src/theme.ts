import {
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride,
  Indicator,
  createTheme,
  darken,
} from '@mantine/core';

// Violet/plum ramp for the "entradas" (inbound orders) tint — echoes Material's
// secondaryContainer from the legacy Flutter app. Index 0 is light enough to
// use as a light-mode page-surface background; index 9 is deep enough for the
// dark-mode counterpart; the middle shades (5-6) work for
// `<Badge color="entrada" variant="light">`.
const entrada: MantineColorsTuple = [
  '#f6f3f6',
  '#ede5f0',
  '#e1cee9',
  '#d2ade1',
  '#bf85d6',
  '#ac5ccc',
  '#983ebb',
  '#7a3795',
  '#5a2c6d',
  '#361c40',
];

export const theme: MantineThemeOverride = createTheme({
  primaryColor: 'blue',
  // Filled controls use white text; blue[6] misses normal-text contrast in light mode.
  primaryShade: { light: 8, dark: 8 },
  autoContrast: true,
  luminanceThreshold: Math.sqrt(0.0525) - 0.05,
  focusClassName: 'erp-focus',
  respectReducedMotion: true,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  defaultRadius: 'md',
  colors: {
    entrada,
  },
  components: {
    Indicator: Indicator.extend({ classNames: { indicator: 'erp-indicator' } }),
  },
});

/**
 * Owns scheme-aware page surfaces, readable muted/accent foregrounds and focus
 * rings. Entrada screens read `--erp-entrada-surface` instead of duplicating a
 * palette shade, so their tint also follows the active colour scheme.
 */
export const cssVariablesResolver: CSSVariablesResolver = (t) => {
  // `theme.colors` is typed with an open string index (custom color names),
  // so `noUncheckedIndexedAccess` treats `.entrada` as possibly undefined even
  // though `theme` above always defines it; fall back to the same ramp.
  const shades = t.colors.entrada ?? entrada;
  // Several saturated ramps (yellow, orange, green) have no palette shade with
  // enough text contrast over their light variant. Keep the hue and darken the
  // semantic foreground once here instead of patching each badge/alert/link.
  const lightForegrounds = Object.fromEntries(
    Object.entries(t.colors).flatMap(([name, colors]) => [
      [`--mantine-color-${name}-text`, darken(colors[9], 0.3)],
      [`--mantine-color-${name}-light-color`, darken(colors[9], 0.3)],
    ]),
  );
  const darkForegrounds = Object.fromEntries(
    Object.entries(t.colors).flatMap(([name, colors]) => [
      [`--mantine-color-${name}-text`, colors[2]],
      [`--mantine-color-${name}-light-color`, colors[2]],
    ]),
  );
  return {
    variables: {},
    light: {
      ...lightForegrounds,
      '--erp-entrada-surface': shades[0],
      '--mantine-color-dimmed': t.colors.gray[7],
      '--mantine-color-placeholder': t.colors.gray[7],
      '--erp-focus-ring': t.colors.blue[8],
      '--mantine-color-anchor': darken(t.colors.blue[9], 0.3),
      '--mantine-color-error': darken(t.colors.red[9], 0.3),
    },
    dark: {
      ...darkForegrounds,
      '--erp-entrada-surface': shades[9],
      '--mantine-color-dimmed': t.colors.dark[0],
      '--mantine-color-placeholder': t.colors.dark[0],
      '--erp-focus-ring': t.colors.blue[3],
      '--mantine-color-anchor': t.colors.blue[0],
      '--mantine-color-error': t.colors.red[4],
    },
  };
};
