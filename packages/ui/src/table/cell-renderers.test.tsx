import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { FieldDescriptor } from '../schema/types';
import { renderCell } from './cell-renderers';
import { z } from 'zod';

// Each rendered cell goes inside a `data-testid="cell"` div so we can scope
// queries to it — MantineProvider injects a `<style>` tag into the same
// container which would otherwise pollute `textContent` assertions.
function wrap(node: React.ReactNode) {
  return render(
    <MantineProvider>
      <div data-testid="cell">{node}</div>
    </MantineProvider>,
  );
}

const stringDesc: FieldDescriptor = {
  key: 's',
  kind: 'string',
  optional: true,
  nullable: true,
  label: 'S',
  zodType: z.string(),
};
const enumDesc: FieldDescriptor = {
  key: 't',
  kind: 'enum',
  optional: false,
  nullable: false,
  label: 'T',
  enumValues: [{ value: '0', label: 'Pessoa Física' }],
  zodType: z.enum(['0']),
};
const currencyDesc: FieldDescriptor = {
  key: 'c',
  kind: 'currency',
  optional: false,
  nullable: false,
  label: 'C',
  zodType: z.number(),
};
const boolDesc: FieldDescriptor = {
  key: 'b',
  kind: 'boolean',
  optional: false,
  nullable: false,
  label: 'B',
  zodType: z.boolean(),
};
const dateDesc: FieldDescriptor = {
  key: 'd',
  kind: 'date',
  optional: false,
  nullable: false,
  label: 'D',
  zodType: z.string().datetime(),
};

function cellText() {
  return within(screen.getByTestId('cell')).getByText(/.+/, { selector: ':not(style)' })
    .textContent;
}

describe('renderCell', () => {
  it('renders em-dash for null/undefined/empty string', () => {
    wrap(renderCell(null, stringDesc));
    expect(cellText()).toBe('—');
  });

  it('renders enum as Badge with mapped label', () => {
    wrap(renderCell('0', enumDesc));
    expect(within(screen.getByTestId('cell')).getByText('Pessoa Física')).toBeTruthy();
  });

  it('formats currency as BRL from cents', () => {
    wrap(renderCell(12345, currencyDesc));
    expect(within(screen.getByTestId('cell')).getByText(/R\$\s*123,45/)).toBeTruthy();
  });

  it('renders boolean as ✓ or —', () => {
    wrap(renderCell(true, boolDesc));
    expect(within(screen.getByTestId('cell')).getByText('✓')).toBeTruthy();
  });

  it('formats date strings', () => {
    wrap(renderCell('2026-01-15T10:30:00.000Z', dateDesc));
    // pt-BR short date includes a slash.
    expect(within(screen.getByTestId('cell')).getByText(/\//)).toBeTruthy();
  });
});
