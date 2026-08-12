import {
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride,
  createTheme,
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
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  defaultRadius: 'md',
  colors: {
    entrada,
  },
});

/**
 * Emits `--erp-entrada-surface`, the page-surface background for "entrada"
 * (inbound orders) screens. Entrada screens must read this CSS variable
 * instead of a hardcoded hex so the tint stays theme-owned and stays correct
 * across light/dark color scheme.
 */
export const cssVariablesResolver: CSSVariablesResolver = (t) => {
  // `theme.colors` is typed with an open string index (custom color names),
  // so `noUncheckedIndexedAccess` treats `.entrada` as possibly undefined even
  // though `theme` above always defines it; fall back to the same ramp.
  const shades = t.colors.entrada ?? entrada;
  return {
    variables: {},
    light: {
      '--erp-entrada-surface': shades[0],
    },
    dark: {
      '--erp-entrada-surface': shades[9],
    },
  };
};
