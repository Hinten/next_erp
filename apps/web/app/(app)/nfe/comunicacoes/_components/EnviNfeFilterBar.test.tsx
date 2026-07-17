import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { PERM } from '@delfrance/auth';

const { permState } = vi.hoisted(() => ({
  permState: { allowed: new Set<string>() },
}));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({
    allowed: permState.allowed.has(bit.toString()),
    loading: false,
  }),
}));

import { EnviNfeFilterBar } from './EnviNfeFilterBar';

function wrap(node: React.ReactNode) {
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

function grantAll() {
  permState.allowed = new Set([PERM.nfe.read.toString(), PERM.pedido.read.toString()]);
}

const VALID_CHAVE = '4'.repeat(44);

beforeEach(() => {
  grantAll();
});

describe('EnviNfeFilterBar', () => {
  it('chave regex gates Aplicar; a valid chave emits { mode, term }', () => {
    const onApply = vi.fn();
    wrap(<EnviNfeFilterBar onApply={onApply} />);

    const aplicar = screen.getByRole('button', { name: 'Aplicar' });
    const input = screen.getByPlaceholderText('44 dígitos');

    expect(aplicar).toHaveProperty('disabled', true);

    fireEvent.change(input, { target: { value: '123' } });
    expect(aplicar).toHaveProperty('disabled', true);
    expect(screen.getByText('A chave tem exatamente 44 dígitos')).toBeDefined();

    fireEvent.change(input, { target: { value: VALID_CHAVE } });
    expect(aplicar).toHaveProperty('disabled', false);

    fireEvent.click(aplicar);
    expect(onApply).toHaveBeenCalledWith({ mode: 'chave', term: VALID_CHAVE });
  });

  it('switching mode resets the term (no filter applied → parent untouched)', () => {
    const onApply = vi.fn();
    wrap(<EnviNfeFilterBar onApply={onApply} />);

    fireEvent.change(screen.getByPlaceholderText('44 dígitos'), {
      target: { value: VALID_CHAVE },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'ID pedido' }));

    const idInput = screen.getByPlaceholderText('id do documento');
    expect((idInput as HTMLInputElement).value).toBe('');
    // Empty term after the reset — Aplicar is gated again.
    expect(screen.getByRole('button', { name: 'Aplicar' })).toHaveProperty('disabled', true);
    // Nothing was applied yet — the mode switch must not ping the parent.
    expect(onApply).not.toHaveBeenCalled();
  });

  it('switching mode with a filter APPLIED clears it (emits null)', () => {
    const onApply = vi.fn();
    wrap(<EnviNfeFilterBar onApply={onApply} />);

    fireEvent.change(screen.getByPlaceholderText('44 dígitos'), {
      target: { value: VALID_CHAVE },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(onApply).toHaveBeenLastCalledWith({ mode: 'chave', term: VALID_CHAVE });

    // Switching mode while a filter constrains the table must clear it —
    // otherwise the stale chave filter keeps filtering behind an empty input.
    fireEvent.click(screen.getByRole('radio', { name: 'nNF' }));
    expect(onApply).toHaveBeenLastCalledWith(null);
    expect(onApply).toHaveBeenCalledTimes(2);

    // A second switch (still nothing applied) stays silent.
    fireEvent.click(screen.getByRole('radio', { name: 'ID pedido' }));
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it('non-chave modes emit the raw string term (pedido numero is never coerced)', () => {
    const onApply = vi.fn();
    wrap(<EnviNfeFilterBar onApply={onApply} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Nº pedido' }));
    fireEvent.change(screen.getByPlaceholderText('ex.: 2026-000123'), {
      target: { value: '0042' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));

    expect(onApply).toHaveBeenCalledWith({ mode: 'pedidoNumero', term: '0042' });
  });

  it('Limpar emits null and clears the term', () => {
    const onApply = vi.fn();
    wrap(<EnviNfeFilterBar onApply={onApply} />);

    const input = screen.getByPlaceholderText('44 dígitos');
    fireEvent.change(input, { target: { value: VALID_CHAVE } });
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));

    expect(onApply).toHaveBeenCalledWith(null);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('modes needing missing permissions are disabled with a dimmed hint', () => {
    permState.allowed = new Set([PERM.nfe.read.toString()]); // no pedido.read
    wrap(<EnviNfeFilterBar onApply={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'Nº pedido' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: 'nNF' })).toHaveProperty('disabled', false);
    expect(screen.getByText(/exigem permissão de leitura/)).toBeDefined();
  });

  it('without nfe.read every resolution mode is disabled (chave stays usable)', () => {
    permState.allowed = new Set<string>();
    wrap(<EnviNfeFilterBar onApply={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'Chave' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('radio', { name: 'nNF' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: 'Nº pedido' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: 'ID pedido' })).toHaveProperty('disabled', true);
  });
});
