import { Badge } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MantineTestProvider } from './testing/mantine';

// theme.test.ts proves the `-outline` tokens are readable on every surface; this
// pins that an outline Badge actually paints from them. Should Mantine move the
// variant onto another token, the resolver's override would go dead while every
// contrast assertion stayed green.
describe('outline variant wiring', () => {
  it('paints the outline Badge label and border from --mantine-color-<color>-outline', () => {
    render(
      <MantineTestProvider>
        <Badge color="green" variant="outline">
          Vinculada
        </Badge>
      </MantineTestProvider>,
    );
    const root = screen.getByText('Vinculada').closest<HTMLElement>('.mantine-Badge-root');
    expect(root?.style.getPropertyValue('--badge-color')).toBe(
      'var(--mantine-color-green-outline)',
    );
    expect(root?.style.getPropertyValue('--badge-bd')).toContain(
      'var(--mantine-color-green-outline)',
    );
  });
});
