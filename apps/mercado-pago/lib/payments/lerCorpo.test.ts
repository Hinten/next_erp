import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CODIGO_ERRO_LINK } from '@delfrance/schemas';

import { caminhosDoErro, lerCorpo } from './lerCorpo';

const schema = z.strictObject({
  pedidoId: z.string(),
  valor: z.number(),
  itens: z.array(z.strictObject({ nome: z.string() })),
});

const VALIDO = { pedidoId: 'ped-1', valor: 10, itens: [{ nome: 'a' }] };

function post(corpo: string): Request {
  return new Request('http://localhost:3007/x', { method: 'POST', body: corpo });
}

async function corpoDe(res: Response): Promise<{ error: string; code: string }> {
  return (await res.json()) as { error: string; code: string };
}

describe('lerCorpo', () => {
  it('returns the parsed data for a valid body', async () => {
    const r = await lerCorpo(post(JSON.stringify(VALIDO)), schema);
    expect(r).toEqual({ ok: true, data: VALIDO });
  });

  it('applies the schema defaults (the route hands the PARSED body on, not the raw one)', async () => {
    const comDefault = z.strictObject({ a: z.string(), b: z.boolean().default(false) });
    const r = await lerCorpo(post(JSON.stringify({ a: 'x' })), comDefault);
    expect(r).toEqual({ ok: true, data: { a: 'x', b: false } });
  });

  it.each([['{not json'], [''], ['undefined']])(
    'a body that is not JSON (%j) → 400 LINK_BODY_INVALIDO',
    async (texto) => {
      const r = await lerCorpo(post(texto), schema);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.response.status).toBe(400);
      expect(await corpoDe(r.response)).toEqual({
        error: 'Body JSON inválido.',
        code: CODIGO_ERRO_LINK.corpoInvalido,
      });
    },
  );

  it('rethrows anything that is not a SyntaxError (rule 6 — the catch is narrow)', async () => {
    const quebrado = {
      json: async () => {
        throw new TypeError('body stream broke');
      },
    } as unknown as Request;
    await expect(lerCorpo(quebrado, schema)).rejects.toThrow('body stream broke');
  });

  it('a schema violation → 400 that names the PATHS and never an input value', async () => {
    const r = await lerCorpo(
      post(JSON.stringify({ pedidoId: 'ped-1', valor: 'SEGREDO-123', itens: [{ nome: 42 }] })),
      schema,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(400);
    const corpo = await corpoDe(r.response);
    expect(corpo.code).toBe(CODIGO_ERRO_LINK.corpoInvalido);
    expect(corpo.error).toContain('valor');
    expect(corpo.error).toContain('itens.0.nome');
    expect(corpo.error).not.toContain('SEGREDO-123');
    expect(corpo.error).not.toContain('42');
  });

  it('a strict object names the UNKNOWN KEY, not its value', async () => {
    const r = await lerCorpo(
      post(JSON.stringify({ ...VALIDO, notification_url: 'https://evil.example/hook' })),
      schema,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const corpo = await corpoDe(r.response);
    expect(corpo.error).toContain('notification_url');
    expect(corpo.error).not.toContain('evil.example');
  });

  it.each([['null'], ['[]'], ['"texto"'], ['7']])(
    'a body that is not an object (%s) → 400 naming "corpo"',
    async (texto) => {
      const r = await lerCorpo(post(texto), schema);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.response.status).toBe(400);
      expect((await corpoDe(r.response)).error).toBe('Body inválido: corpo.');
    },
  );
});

describe('caminhosDoErro', () => {
  const analisar = (entrada: unknown): string[] => {
    const r = schema.safeParse(entrada);
    if (r.success) throw new Error('the fixture was supposed to fail');
    return caminhosDoErro(r.error);
  };

  it('joins nested paths with dots, one entry per offending field', () => {
    expect(
      analisar({
        pedidoId: 1,
        valor: 'x',
        itens: [{ nome: 1 }, { nome: 'ok' }, { nome: 2 }],
      }).sort(),
    ).toEqual(['itens.0.nome', 'itens.2.nome', 'pedidoId', 'valor']);
  });

  it('lists each path ONCE even when a field fails several checks', () => {
    const doisChecks = z.strictObject({ n: z.string().min(5).regex(/^\d+$/) });
    const r = doisChecks.safeParse({ n: 'ab' });
    if (r.success) throw new Error('the fixture was supposed to fail');
    expect(r.error.issues.length).toBeGreaterThan(1);
    expect(caminhosDoErro(r.error)).toEqual(['n']);
  });

  it('caps the list so a hostile body cannot inflate the response', () => {
    const muitos = z.array(z.strictObject({ nome: z.string() }));
    const r = muitos.safeParse(Array.from({ length: 40 }, () => ({ nome: 1 })));
    if (r.success) throw new Error('the fixture was supposed to fail');
    expect(caminhosDoErro(r.error)).toHaveLength(10);
  });

  it('truncates a very long unknown key instead of echoing it whole', () => {
    const [caminho] = analisar({ ...VALIDO, ['x'.repeat(500)]: 1 });
    expect(caminho).toHaveLength(80);
  });
});
