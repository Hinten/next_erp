import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { lerRespostaJson, resumirCampos } from './index';

/**
 * Each case below is one of the ways `return parsed as T` used to answer
 * "success". None of them threw, none of them logged, and the caller could not
 * tell any of them apart from a good response — which is how a stale backend's
 * 200 was reported as a completed mint (#1295 → #1302).
 */

const conta = z.object({
  connected: z.boolean(),
  nickname: z.string().nullable(),
});

describe('the three ways a 2xx body used to lie', () => {
  it('⭐ names the fields when the body is JSON of the WRONG shape', () => {
    // The cast case. `{}` typed as `Conta` gave `connected === undefined`,
    // which is falsy, so the screen said "not connected" for an account that
    // was fine and the operator reconnected it.
    const r = lerRespostaJson(JSON.stringify({ connected: 'sim' }), conta);

    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.motivo === 'formato' ? r.campos : []).toEqual(['connected', 'nickname']);
  });

  it('⭐ refuses an EMPTY body, and calls it VAZIO — not a format problem', () => {
    // `null as T` is the quietest of the three: nothing fails here, it fails
    // later at the first property access, in a stack that names neither the
    // endpoint nor the response.
    //
    // ⚠️ The motivo matters as much as the refusal. This used to fall into
    // `safeParse(null)` and come back `'formato'`, so the ML client told the
    // operator "o backend e esta tela estão em versões diferentes — faça o
    // deploy" and named `Campos inválidos: (raiz)`. An empty body is not
    // version skew; it is the HTML case without the HTML, and sending someone
    // to deploy a backend that was never the problem is the defect this module
    // exists to remove, surviving in the branch that looked handled.
    const r = lerRespostaJson('', conta);

    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.motivo).toBe('vazio');
  });

  it('⭐ separates a NON-JSON body from a wrong-shaped one', () => {
    // A proxy login page or an App Hosting 502 arriving with status 200 means
    // the request never reached a route that answers JSON — a different cause
    // and a different remedy, so it must not collapse into "invalid format".
    const r = lerRespostaJson('<!DOCTYPE html><html><body>502</body></html>', conta);

    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.motivo).toBe('nao-json');
  });

  it('passes a well-formed body straight through', () => {
    // The control. A reader that only ever refuses is indistinguishable from a
    // broken endpoint, and every assertion above would still pass.
    const r = lerRespostaJson(JSON.stringify({ connected: true, nickname: 'LOJA' }), conta);

    expect(r.ok).toBe(true);
    expect(r.ok ? r.data : null).toEqual({ connected: true, nickname: 'LOJA' });
  });
});

describe('an empty body is opt-in, not a special case', () => {
  it('⭐ accepts it when — and only when — the schema admits null', () => {
    // This is what makes the rule enforceable rather than a convention: a route
    // that legitimately answers 204/empty says so in its schema, and every
    // other route rejects the same body without anyone remembering to check.
    // ⚠️ The `'vazio'` check runs AFTER the parse for exactly this reason: a
    // route that legitimately answers empty says so in its schema, and moving
    // the check earlier would silently break that opt-in.
    expect(lerRespostaJson('', z.null()).ok).toBe(true);
    expect(lerRespostaJson('', z.unknown()).ok).toBe(true);
    const rejeitado = lerRespostaJson('', z.object({ ok: z.boolean() }));
    expect(rejeitado.ok).toBe(false);
    expect(rejeitado.ok ? null : rejeitado.motivo).toBe('vazio');
  });
});

describe('campos — paths only, never values', () => {
  it('⚠️ never echoes the offending VALUE', () => {
    // A response body is a live credential often enough that this cannot be
    // left to the call site: an ML test user's `password` is one, and ML
    // reissues none. These strings reach err.message, the console, an
    // operator's screen, and the durable failure doc on the server clients.
    const segredo = 'qatest328-uma-senha-real';
    const r = lerRespostaJson(
      JSON.stringify({ password: segredo }),
      z.object({ password: z.number() }),
    );

    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(segredo);
    expect(r.ok ? [] : r.motivo === 'formato' ? r.campos : []).toEqual(['password']);
  });

  it('reports a root-level mismatch as (raiz) rather than an empty string', () => {
    // An array where an object belongs produces an issue with an EMPTY path, so
    // the message would otherwise read "Campos inválidos: ." and name nothing.
    const r = lerRespostaJson('[]', conta);

    expect(r.ok ? [] : r.motivo === 'formato' ? r.campos : []).toEqual(['(raiz)']);
  });

  it('⭐ collapses array indices, so one bad column in 200 rows names it ONCE', () => {
    // ⚠️ This case is the reason the paths are rewritten before de-duplicating.
    // `issue.path` carries the index, so these are 200 DISTINCT paths and a
    // plain `new Set` collapses none of them — the message would name one field
    // two hundred times and bury every other failure in it. On the server
    // clients that message is the durable record of the failure.
    const linhas = Array.from({ length: 200 }, () => ({ id: 'nao-e-numero' }));
    const r = lerRespostaJson(
      JSON.stringify({ linhas }),
      z.object({ linhas: z.array(z.object({ id: z.number() })) }),
    );

    expect(r.ok ? [] : r.motivo === 'formato' ? r.campos : []).toEqual(['linhas[].id']);
  });

  it('still tells two DIFFERENT columns apart after the collapse', () => {
    // The control for the case above. Collapsing indices must not collapse
    // fields — a rewrite that returned `linhas[]` for everything would satisfy
    // the previous assertion and report nothing useful ever again.
    const r = lerRespostaJson(
      JSON.stringify({ linhas: [{ id: 'x', nome: 1 }] }),
      z.object({ linhas: z.array(z.object({ id: z.number(), nome: z.string() })) }),
    );

    expect(r.ok ? [] : r.motivo === 'formato' ? r.campos : []).toEqual([
      'linhas[].id',
      'linhas[].nome',
    ]);
  });

  it('⚠️ `campos` stays PURE paths — the cap belongs to the message', () => {
    // The cap used to append `…e mais 28` into this array, which is the same
    // array that becomes `RespostaInvalidaError.campos` — documented as field
    // paths. Harmless while only the message read it, wrong the moment anything
    // else does (telemetry, highlighting the offending inputs, a retry
    // predicate). `resumirCampos` caps the SENTENCE instead.
    const forma: Record<string, z.ZodType> = {};
    const corpo: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) {
      forma[`campo${String(i)}`] = z.number();
      corpo[`campo${String(i)}`] = 'nao-e-numero';
    }
    const r = lerRespostaJson(JSON.stringify(corpo), z.object(forma));

    const campos = r.ok ? [] : r.motivo === 'formato' ? r.campos : [];
    expect(campos).toHaveLength(40);
    expect(campos.every((c) => !c.includes('e mais'))).toBe(true);
  });

  it('⚠️ …and the MESSAGE is still capped — forty fields is one fact, not forty', () => {
    const campos = Array.from({ length: 40 }, (_v, i) => `campo${String(i)}`);

    const texto = resumirCampos(campos);

    expect(texto.endsWith('…e mais 28')).toBe(true);
    // The first twelve are named; the thirteenth onward are only counted.
    expect(texto).toContain('campo11');
    expect(texto).not.toContain('campo12');
  });

  it('leaves a short list alone', () => {
    // The control: the cap must not rewrite a message that was already fine.
    expect(resumirCampos(['a', 'b'])).toBe('a, b');
  });
});

describe('what it deliberately does NOT do', () => {
  it('lets a schema that throws escape instead of reporting it as a bad body', () => {
    // ⚠️ This covers the SAFEPARSE path, not the `instanceof SyntaxError`
    // narrowing above it — that throw is not inside any `try`, so deleting the
    // narrowing leaves this green. The narrowing is genuinely untestable
    // (`JSON.parse` throws nothing but `SyntaxError`); what this pins is that a
    // schema whose own refinement throws is not reported as a malformed
    // response, which would send the operator to check a healthy backend.
    const explode = z.custom(() => {
      throw new RangeError('boom');
    });

    expect(() => lerRespostaJson('{}', explode)).toThrow(RangeError);
  });

  it('keeps the raw text on the non-JSON result for the caller to log', () => {
    // The caller decides what reaches the operator. `apps/web`'s ML client caps
    // this at 500 chars on the console and shows a written message instead,
    // because dumping a whole HTML document into an alert buried the real cause
    // behind a wall of markup (#818).
    const html = '<!DOCTYPE html>' + 'x'.repeat(50_000);
    const r = lerRespostaJson(html, conta);

    expect(r.ok ? null : r.motivo === 'nao-json' ? r.texto : null).toBe(html);
  });
});
