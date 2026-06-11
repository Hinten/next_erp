import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Importing the barrel is what wires the pt-BR locale (module side effect) —
// this test locks that wiring against accidental removal and against a Zod
// upgrade renaming/removing the `pt` locale.
import { clienteSchema } from './index';

describe('Zod pt-BR locale (configured by the schemas barrel)', () => {
  it('renders default validation messages in Portuguese', () => {
    const result = z.string().min(1).safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/^Muito pequeno/);
    }
  });

  it('renders type errors in Portuguese for domain schemas', () => {
    // `{}` is valid (fields are `.nullable().default(null)` per repo
    // convention) — force a type error with a wrong-typed value.
    const result = clienteSchema.safeParse({ nome: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.startsWith('Tipo inválido'))).toBe(true);
      // No issue fell back to a Zod English default.
      expect(messages.some((m) => /^(Invalid|Too small|Too big|Required)/.test(m))).toBe(false);
    }
  });

  it('keeps schema-level custom messages over the locale', () => {
    const result = clienteSchema.shape.cpf_cnpj.safeParse('12a45');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('apenas números');
    }
  });
});
