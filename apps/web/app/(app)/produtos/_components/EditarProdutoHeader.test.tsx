import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { MantineTestProvider } from '@/lib/testing/mantine';

// Render next/link as a plain anchor (no App Router context in the test).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import {
  EditarProdutoHeader,
  buildEditarProdutoTitle,
  isProdutoPending,
} from './EditarProdutoHeader';

describe('buildEditarProdutoTitle', () => {
  it.each([
    ['Camiseta Azul', 'CAM-001', 'Editar Camiseta Azul - CAM-001'],
    ['', 'CAM-001', 'Editar produto sem nome - CAM-001'],
    ['Camiseta Azul', null, 'Editar Camiseta Azul - sem sku'],
    ['Camiseta Azul', '', 'Editar Camiseta Azul - sem sku'],
    ['', null, 'Editar produto sem nome - sem sku'],
    // Whitespace-only is "empty" too — a heading reading "Editar   - CAM-001"
    // names nothing.
    ['   ', '  ', 'Editar produto sem nome - sem sku'],
    [undefined, undefined, 'Editar produto sem nome - sem sku'],
    // Non-strings can't reach the heading raw (a `[object Object]` title).
    [42, { sku: 'x' }, 'Editar produto sem nome - sem sku'],
    ['  Camiseta Azul  ', ' CAM-001 ', 'Editar Camiseta Azul - CAM-001'],
  ])('%o + %o → %s', (nome, sku, expected) => {
    expect(buildEditarProdutoTitle(nome, sku)).toBe(expected);
  });
});

describe('isProdutoPending', () => {
  const doc = { id: 'p1', data: { nome: 'Camiseta Azul' } };

  it('is pending while the listener has not emitted', () => {
    expect(isProdutoPending({ loading: true, data: undefined })).toBe(true);
  });

  // The regression this suite exists for: a produto id that does not exist is
  // `loading: false, data: null` for as long as the operator stays on the page,
  // so a gate reading only `loading` puts "Editar produto sem nome - sem sku"
  // above ObjectView's "Registro não encontrado.".
  it('is pending when the id resolves to nothing', () => {
    expect(isProdutoPending({ loading: false, data: null })).toBe(true);
  });

  it('is pending when the read errored', () => {
    expect(isProdutoPending({ loading: false, data: undefined })).toBe(true);
  });

  // `useDocSnapshot` flips `loading` back to true on a ref change but KEEPS the
  // previous document's data, so a gate reading only `!data` would leave the
  // PREVIOUS produto's name in the heading while the next one loads.
  it('is pending while a new ref loads over a previous document', () => {
    expect(isProdutoPending({ loading: true, data: doc })).toBe(true);
  });

  it('is not pending once the document has resolved', () => {
    expect(isProdutoPending({ loading: false, data: doc })).toBe(false);
  });
});

/**
 * The header inside a form, mirroring its real position under `ObjectView`'s
 * `FormProvider`. The buttons stand in for the Nome/SKU inputs: what matters is
 * that the form value changed, not which control changed it.
 */
function Harness({
  pending = false,
  nome = 'Camiseta Azul',
  sku = 'CAM-001' as string | null,
}: {
  pending?: boolean;
  nome?: string;
  sku?: string | null;
}) {
  const form = useForm({ defaultValues: { nome, sku } });
  return (
    <MantineTestProvider>
      <FormProvider {...form}>
        <EditarProdutoHeader pending={pending} />
        <button type="button" onClick={() => form.setValue('nome', 'Camiseta Vermelha')}>
          renomear
        </button>
        <button type="button" onClick={() => form.setValue('sku', '')}>
          limpar sku
        </button>
      </FormProvider>
    </MantineTestProvider>
  );
}

describe('EditarProdutoHeader', () => {
  it('names the produto from the form values', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'Editar Camiseta Azul - CAM-001' })).toBeTruthy();
  });

  it('follows the form as it is edited, with no save in between', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'renomear' }));
    expect(
      screen.getByRole('heading', { name: 'Editar Camiseta Vermelha - CAM-001' }),
    ).toBeTruthy();
  });

  it('falls back per field, keeping the half that is filled in', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'limpar sku' }));
    expect(screen.getByRole('heading', { name: 'Editar Camiseta Azul - sem sku' })).toBeTruthy();
  });

  it('shows the neutral title while there is no produto to name', () => {
    // Seeded values on purpose: a component that ignored `pending` would pass
    // this against an empty form by accident.
    render(<Harness pending />);
    expect(screen.getByRole('heading', { name: 'Editar produto' })).toBeTruthy();
  });

  it('keeps the Cancelar link back to the list', () => {
    render(<Harness />);
    expect(screen.getByRole('link', { name: 'Cancelar' }).getAttribute('href')).toBe('/produtos');
  });
});
