import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { cssVariablesResolver, theme } from './theme';

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
