import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MercadoLivreBackendDesatualizadoError,
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  MercadoLivreClientRespostaInvalidaError,
  type MercadoLivreUsuarioTeste,
  createMercadoLivreClient,
  mercadoLivreHttpFallbackMessage,
} from './client';
import { isRetryableMercadoLivreError } from './errors';

/**
 * The regression these pin: a non-2xx response whose body is NOT our JSON
 * `{error}` envelope must NEVER put that body in `err.message`.
 *
 * It used to. When the apps/mercado-livre backend answered with its Next.js 404
 * page, the whole HTML document became the error message and the size-chart
 * editor rendered it verbatim in an alert — burying the real cause (the backend
 * was not serving that route) under a wall of markup.
 */

function client(fetchImpl: typeof globalThis.fetch) {
  return createMercadoLivreClient({
    baseUrl: 'http://localhost:3006',
    getAuthToken: async () => 'token',
    fetch: fetchImpl,
  });
}

function response(body: string, init: { status: number; contentType?: string }): Response {
  return new Response(body, {
    status: init.status,
    headers: { 'content-type': init.contentType ?? 'text/html' },
  });
}

const NEXT_404 = `<!DOCTYPE html><html lang="en"><head><title>404: This page could not be found.</title></head><body><h1>404</h1><h2>This page could not be found.</h2></body></html>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('non-JSON error bodies', () => {
  it('never leaks an HTML 404 page into the error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => response(NEXT_404, { status: 404 }));

    const err = await c.sizeChartDomains('int-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreClientHttpError);
    const httpErr = err as MercadoLivreClientHttpError;
    expect(httpErr.status).toBe(404);
    expect(httpErr.message).not.toContain('<!DOCTYPE');
    expect(httpErr.message).not.toContain('<html');
    expect(httpErr.message).toBe(mercadoLivreHttpFallbackMessage(404));
  });

  it('keeps the discarded body reachable on the console for debugging', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => response(NEXT_404, { status: 502 }));

    await c.sizeChartDomains('int-1').catch(() => undefined);

    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[1])).toContain('404: This page could not be found.');
  });

  it('caps the logged body so a huge page cannot flood the console', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => response('x'.repeat(50_000), { status: 500 }));

    await c.sizeChartDomains('int-1').catch(() => undefined);

    expect(String(spy.mock.calls[0]?.[1]).length).toBeLessThanOrEqual(500);
  });

  it('still uses OUR message when the backend sent its JSON envelope', async () => {
    const c = client(
      async () =>
        new Response(
          JSON.stringify({ error: 'Conta não conectada.', code: 'ML_REAUTH_REQUIRED' }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const err = (await c
      .sizeChartDomains('int-1')
      .catch((e: unknown) => e)) as MercadoLivreClientHttpError;

    expect(err.message).toBe('Conta não conectada.');
    expect(err.code).toBe('ML_REAUTH_REQUIRED');
  });

  it('a JSON body that is an ARRAY is not mistaken for the envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(
      async () =>
        new Response('[1,2,3]', { status: 500, headers: { 'content-type': 'application/json' } }),
    );

    const err = (await c
      .sizeChartDomains('int-1')
      .catch((e: unknown) => e)) as MercadoLivreClientHttpError;

    expect(err.message).toBe(mercadoLivreHttpFallbackMessage(500));
  });

  it('a genuine network failure is still a network error, not an HTTP one', async () => {
    const c = client(async () => {
      throw new TypeError('Failed to fetch');
    });

    const err = await c.sizeChartDomains('int-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreClientNetworkError);
  });
});

describe('mercadoLivreHttpFallbackMessage', () => {
  it('tells the operator what to DO, and carries the status for support', () => {
    // Every route in apps/mercado-livre answers JSON, so a non-JSON 404 means
    // the request never reached one — but an operator cannot inspect that.
    const message = mercadoLivreHttpFallbackMessage(404);
    expect(message).toMatch(/Atualize a página/);
    expect(message).toMatch(/HTTP 404/);
  });

  it('separates permission, server and everything-else', () => {
    expect(mercadoLivreHttpFallbackMessage(403)).toMatch(/Sem permissão/);
    expect(mercadoLivreHttpFallbackMessage(500)).toMatch(/falhou/);
    expect(mercadoLivreHttpFallbackMessage(418)).toMatch(/HTTP 418/);
  });

  it('never returns an empty message', () => {
    for (const status of [400, 401, 403, 404, 409, 418, 500, 502, 503]) {
      expect(mercadoLivreHttpFallbackMessage(status).length).toBeGreaterThan(10);
    }
  });
});

describe('sugerirMedidas — the body', () => {
  /**
   * Captures the JSON body of the single request the call makes.
   *
   * ⚠️ The stub answers a REAL `MedidasSugestao`. It used to answer `'{}'`,
   * which was accepted only because `call()` cast instead of validating — the
   * fixture claimed a type it did not have, and these two tests passed against
   * a response no route could ever send. That is the same defect the client
   * change fixes, one layer up.
   */
  async function bodyOf(input: Parameters<ReturnType<typeof client>['sugerirMedidas']>[0]) {
    let sent: Record<string, unknown> = {};
    const c = client(async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          sugestoes: [],
          celulas: 0,
          contexto: {
            fotos: 0,
            anexadas: 0,
            descricao: false,
            codigo: false,
            referencia: false,
          },
          truncado: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await c.sugerirMedidas(input);
    return sent;
  }

  const grid = { tabMediId: 'tm1', rows: [{ key: 'k', size: 'P' }], columns: [] };

  it('renames `fatos` to `facts` on the wire', async () => {
    // The browser-facing API is Portuguese like the rest of this client; the
    // route's vocabulary is English. A mismatch here is silent — the route
    // simply ignores an unknown key and reads the stale stored document, which
    // is the exact bug `fatos` exists to fix.
    const sent = await bodyOf({ ...grid, fatos: { descricao: 'recém digitada' } });
    expect(sent.facts).toEqual({ descricao: 'recém digitada' });
    expect(sent.fatos).toBeUndefined();
  });

  it('omits `facts` entirely when the caller has none', async () => {
    // Not `facts: undefined`: the route falls back per field only when the key
    // is absent, and `JSON.stringify` would drop it anyway — pinning it keeps
    // that accident from becoming load-bearing silently.
    const sent = await bodyOf(grid);
    expect('facts' in sent).toBe(false);
    expect(sent.tabMediId).toBe('tm1');
  });
});

/**
 * `criarUsuarioTesteAvulso` — the post-condition, and why it lives in the browser.
 *
 * ⭐ The bug it closes was reported as "creating a new buyer deletes the old
 * one". It did not. `apps/web` calls the DEPLOYED apps/mercado-livre, and before
 * the single-role mint existed that route **ignored its body entirely** and
 * always ran the pair bootstrap. So a `{role: 'comprador'}` POST against a stale
 * deployment reused both stored accounts, minted nothing, wiped the conta's
 * credential anyway — and answered **200**.
 *
 * `call<T>()` casts rather than validates, so all of that arrived as a success:
 * the list did not change, and the reveal modal showed `usuarios[0]`, which for
 * the pair is the SELLER, under a "Comprador" badge with the seller's password.
 *
 * ⚠️ These cannot move to the backend. The half that is wrong is the half that
 * is not running this code.
 */
describe('criarUsuarioTesteAvulso — the stale-backend post-condition', () => {
  function ok(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function registro(
    role: 'vendedor' | 'comprador',
    over: Partial<MercadoLivreUsuarioTeste> = {},
  ): MercadoLivreUsuarioTeste {
    return {
      role,
      docId: role,
      id: role === 'vendedor' ? 1 : 2,
      nickname: 'TEST-' + role,
      password: 'senha-' + role,
      site_id: 'MLB',
      site_status: 'active',
      email: null,
      createdAt: 1_700_000_000_000,
      createdByUserId: 999,
      codigosVerificacaoEmail: { quatro: '0001', seis: '000001' },
      ...over,
    };
  }

  /** Exactly what a backend predating the single-role mint answers. */
  const RESPOSTA_ANTIGA = {
    usuarios: [registro('vendedor'), registro('comprador')],
    criados: [],
    reaproveitados: ['vendedor', 'comprador'],
    credenciaisRemovidas: 2,
    conta: { id: 999, nickname: 'LOJA-REAL' },
  };

  async function recusa(body: unknown): Promise<MercadoLivreBackendDesatualizadoError> {
    const c = client(async () => ok(body));
    try {
      await c.criarUsuarioTesteAvulso('i1', 'comprador');
    } catch (err) {
      if (err instanceof MercadoLivreBackendDesatualizadoError) return err;
      throw err;
    }
    throw new Error('esperava uma recusa');
  }

  it('⭐ refuses the pre-#1295 shape and names the deploy', async () => {
    // `credencialRevogada` is the capability probe: the field did not exist
    // before the single-role mint, so its ABSENCE dates the backend. Nothing
    // else in the payload distinguishes the two versions.
    const err = await recusa(RESPOSTA_ANTIGA);

    expect(err.motivo).toBe('backend-desatualizado');
    expect(err.message).toContain('deploy');
    expect(err.message).toContain('apps/mercado-livre');
  });

  it('⭐ refuses BEFORE the seller could be handed back as the new buyer', async () => {
    // The decisive assertion. Without the guard this RESOLVES, and
    // `usuarios[0]` — the seller — is what the panel reveals as the new
    // comprador's credential.
    const c = client(async () => ok(RESPOSTA_ANTIGA));

    await expect(c.criarUsuarioTesteAvulso('i1', 'comprador')).rejects.toBeInstanceOf(
      MercadoLivreBackendDesatualizadoError,
    );
  });

  it('says the credential was wiped anyway, because it was', async () => {
    // The revocation is the mint's LAST step and unconditional on the old route,
    // so a refusal here is not "nothing happened" — the conta is disconnected
    // now, and the next attempt 409s on ML_REAUTH_REQUIRED for a reason that
    // looks unrelated.
    const err = await recusa(RESPOSTA_ANTIGA);

    expect(err.message).toContain('credenciais');
  });

  it('refuses a current backend that minted nothing', async () => {
    // The field is present, so this is not a version problem — the run reused
    // instead of minting, which the single-role mint never does. Different
    // cause, different remedy, so a different `motivo`.
    const err = await recusa({
      usuarios: [registro('comprador')],
      criados: [],
      reaproveitados: ['comprador'],
      credenciaisRemovidas: 0,
      credencialRevogada: true,
      conta: { id: 999, nickname: 'LOJA-REAL' },
    });

    expect(err.motivo).toBe('contrato-violado');
    expect(err.message).toContain('vaga permanente');
  });

  it('refuses a single account of the WRONG role', async () => {
    // A seller returned for a buyer request is the credential-confusion case
    // reduced to one record — a `usuarios.length === 1` check alone passes it.
    const err = await recusa({
      usuarios: [registro('vendedor')],
      criados: ['vendedor'],
      reaproveitados: [],
      credenciaisRemovidas: 2,
      credencialRevogada: true,
      conta: { id: 999, nickname: 'LOJA-REAL' },
    });

    expect(err.motivo).toBe('contrato-violado');
  });

  it('refuses TWO accounts even when both were freshly minted', async () => {
    // The other stale-deployment branch: on an integração holding only
    // `comprador-<id>` docs the old route finds neither bare role doc and mints
    // BOTH — two permanent slots for one click, one of them a seller nobody
    // asked for.
    const err = await recusa({
      usuarios: [registro('vendedor'), registro('comprador')],
      criados: ['vendedor', 'comprador'],
      reaproveitados: [],
      credenciaisRemovidas: 2,
      credencialRevogada: true,
      conta: { id: 999, nickname: 'LOJA-REAL' },
    });

    expect(err.motivo).toBe('contrato-violado');
  });

  it('passes a well-formed single mint through untouched', async () => {
    // The control. A guard that only ever refuses is indistinguishable from a
    // broken button.
    const corpo = {
      usuarios: [registro('comprador', { docId: 'comprador-2' })],
      criados: ['comprador'],
      reaproveitados: [],
      credenciaisRemovidas: 2,
      credencialRevogada: true,
      conta: { id: 999, nickname: 'LOJA-REAL' },
    };
    const c = client(async () => ok(corpo));

    expect(await c.criarUsuarioTesteAvulso('i1', 'comprador')).toEqual(corpo);
  });

  it('lets a deliberate manterCredencial through — false is a real value', async () => {
    // `credencialRevogada: false` is legitimate and falsy. A probe written as a
    // truthiness check rather than a `typeof` would reject exactly the opt-out
    // the panel offers.
    const corpo = {
      usuarios: [registro('comprador', { docId: 'comprador-2' })],
      criados: ['comprador'],
      reaproveitados: [],
      credenciaisRemovidas: 0,
      credencialRevogada: false,
      conta: { id: 999, nickname: 'LOJA-REAL' },
    };
    const c = client(async () => ok(corpo));

    await expect(
      c.criarUsuarioTesteAvulso('i1', 'comprador', { manterCredencial: true }),
    ).resolves.toEqual(corpo);
  });
});

/**
 * `usuariosTeste` — the READ side of the same deployment skew, and why it
 * degrades where the mint refuses.
 *
 * ⚠️ The asymmetry is deliberate. The mint's post-condition throws, because a
 * wrong answer there means one account's password is about to be presented as
 * another's. This read must never throw: the stored passwords are the single
 * copy that exists — ML reissues none — and this list is the only surface that
 * shows them, so failing it on a stale backend destroys more than it protects.
 *
 * What it may not do is degrade SILENTLY. `undefined` reaching the panel meant a
 * blank chip where the doc id should be and `key={undefined}` on every card,
 * which is the same silent-nothing the mint guard exists to remove.
 */
describe('usuariosTeste — a backend that reports no docId', () => {
  function okList(usuarios: unknown[]): Response {
    return new Response(JSON.stringify({ usuarios }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const SEM_DOC_ID = {
    role: 'comprador',
    id: 2,
    nickname: 'TEST-comprador',
    password: 'qatest328',
    site_id: 'MLB',
    site_status: 'active',
    email: null,
    createdAt: 1_700_000_000_000,
    createdByUserId: 999,
    codigosVerificacaoEmail: { quatro: '0002', seis: '000002' },
  };

  it('⭐ resolves — the stored password is the only copy there is', async () => {
    const c = client(async () => okList([SEM_DOC_ID]));

    const { usuarios } = await c.usuariosTeste('i1');

    expect(usuarios).toHaveLength(1);
    expect(usuarios[0]?.password).toBe('qatest328');
  });

  it('⭐ normalises the absence to null, never leaves it undefined', async () => {
    // `call<T>()` casts rather than validates, so without this the panel gets
    // `undefined` for a field its type declares present — a blank chip and no
    // React key. `null` is a value the panel can render as "this backend does
    // not say".
    const c = client(async () => okList([SEM_DOC_ID]));

    const { usuarios } = await c.usuariosTeste('i1');

    expect(usuarios[0]?.docId).toBeNull();
  });

  it('treats an empty string the same as absent', async () => {
    // `doc ⟨empty⟩` renders identically to the bug being fixed.
    const c = client(async () => okList([{ ...SEM_DOC_ID, docId: '' }]));

    expect((await c.usuariosTeste('i1')).usuarios[0]?.docId).toBeNull();
  });

  it('leaves a real doc id untouched', async () => {
    // The control. A normaliser that flattened everything to null would pass
    // every assertion above and delete the feature.
    const c = client(async () => okList([{ ...SEM_DOC_ID, docId: 'comprador-2' }]));

    expect((await c.usuariosTeste('i1')).usuarios[0]?.docId).toBe('comprador-2');
  });
});

/**
 * The three ways a 2xx used to be reported as a success, now that `call()`
 * validates instead of casting.
 *
 * ⭐ Every one of these previously RESOLVED. That is the whole defect: the
 * caller could not tell a good response from an empty one, an HTML one, or a
 * body describing a different endpoint's answer — which is how a stale backend
 * reported a mint that never happened and the panel revealed the seller's
 * password under a "Comprador" badge (#1295 → #1302).
 */
describe('a 2xx whose body is not what we claimed', () => {
  function ok(body: string, contentType = 'application/json'): Response {
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  }

  it('⭐ throws instead of handing back a WRONG-SHAPED object', async () => {
    // Used to resolve with `{}` cast to `MercadoLivreConta`, so `connected` read
    // `undefined` — falsy — and the screen told the operator to reconnect an
    // account that was perfectly connected.
    const c = client(async () => ok('{}'));

    const err = await c.conta('i1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreClientRespostaInvalidaError);
    expect((err as MercadoLivreClientRespostaInvalidaError).campos).toEqual(['connected', 'me']);
  });

  it('⭐ throws instead of handing back null for an EMPTY body', async () => {
    // The quietest of the three: `null as T` fails later, at the first property
    // access, in a stack naming neither the endpoint nor the response.
    const c = client(async () => ok(''));

    await expect(c.conta('i1')).rejects.toBeInstanceOf(MercadoLivreClientRespostaInvalidaError);
  });

  it('⭐ throws AND logs when a 200 carries HTML', async () => {
    // ⚠️ The strictest regression here. `nonJsonBody` was captured and then read
    // only inside the `!res.ok` branch, so a 200 with a proxy's HTML returned
    // `null as T` and logged NOTHING, anywhere.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok(NEXT_404, 'text/html'));

    const err = await c.conta('i1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreClientRespostaInvalidaError);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[1])).toContain('404: This page could not be found.');
  });

  it('caps the logged body on the 2xx path too', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok('x'.repeat(50_000), 'text/html'));

    await c.conta('i1').catch(() => undefined);

    expect(String(spy.mock.calls[0]?.[1]).length).toBeLessThanOrEqual(500);
  });

  it('⚠️ never puts the offending VALUE in the message', async () => {
    // A response body is a live credential often enough that this cannot be left
    // to the call site: the ML test-user list carries passwords ML never
    // reissues. `campos` is field PATHS, and the message is built from those.
    const senha = 'qatest328-uma-senha-real';
    const c = client(async () =>
      ok(
        JSON.stringify({
          usuarios: [
            {
              role: 'comprador',
              docId: 'comprador-2',
              // `id` is what fails; `password` is the field that must not leak.
              id: { nao: 'um numero' },
              nickname: 'TEST-comprador',
              password: senha,
              site_id: 'MLB',
              site_status: 'active',
              email: null,
              createdAt: 1,
              createdByUserId: 1,
              codigosVerificacaoEmail: { quatro: '0002', seis: '000002' },
            },
          ],
        }),
      ),
    );

    const err = await c.usuariosTeste('i1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreClientRespostaInvalidaError);
    expect((err as Error).message).not.toContain(senha);
  });

  it('names the deploy, because that is what actually fixes it', async () => {
    // The skew is the usual cause: apps/web calls the DEPLOYED backend, never
    // the one in this checkout. An error that says only "invalid format" sends
    // the operator to support instead of to a deploy.
    const c = client(async () => ok('{}'));

    const err = await c.conta('i1').catch((e: unknown) => e);

    expect((err as Error).message).toContain('deploy');
    expect((err as Error).message).toContain('apps/mercado-livre');
  });

  it('⭐ is caught by the 27 call sites that narrow to MercadoLivreClientHttpError', async () => {
    // ⚠️ THE reason this class is a subclass rather than a sibling. Those sites
    // `throw err` for anything else, and ~24 are imperative handlers with no
    // TanStack error state — a sibling class would land as an unhandled
    // rejection: spinner stops, no alert, button looks untouched, operator
    // clicks the irreversible action again.
    const c = client(async () => ok('{}'));

    const err = await c.conta('i1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreClientHttpError);
    expect((err as MercadoLivreClientHttpError).code).toBe('RESPOSTA_INVALIDA');
  });

  it('carries the REAL 2xx it arrived on, not a hardcoded 200', async () => {
    // `enviarNfe` answers 202. A hardcoded status would make the error lie about
    // which response it came from, and `code` already does the discriminating.
    const c = client(async () => new Response('{}', { status: 202 }));

    const err = await c.enviarNfe({ pedidoId: 'p1', nfeId: 'n1' }).catch((e: unknown) => e);

    expect((err as MercadoLivreClientHttpError).status).toBe(202);
  });

  it('still passes a well-formed body straight through', async () => {
    // The control. A client that only ever throws is indistinguishable from a
    // backend that is down, and every assertion above would still pass.
    const c = client(async () => ok(JSON.stringify({ connected: true, me: null })));

    await expect(c.conta('i1')).resolves.toEqual({ connected: true, me: null });
  });

  it('does not retry a shape mismatch — the same backend answers the same way', async () => {
    const err = new MercadoLivreClientRespostaInvalidaError('x', 200, ['a']);

    expect(isRetryableMercadoLivreError(err)).toBe(false);
  });
});

/**
 * `etiqueta` is the one success path a schema cannot reach: the body is bytes.
 * What can still go wrong is the same thing — a 200 that is not the artifact.
 */
describe('fetchArtifact — a 200 that is not a label', () => {
  it('⭐ refuses an HTML page instead of handing it over as a "label"', async () => {
    // Without this the operator "prints" it: a blank label, or a label printer
    // fed a chunk of markup. The route answers PDF or ZPL and never HTML.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(
      async () => new Response(NEXT_404, { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    await expect(c.etiqueta('p1', 'pdf')).rejects.toBeInstanceOf(
      MercadoLivreClientRespostaInvalidaError,
    );
  });

  it('still returns a real artifact', async () => {
    // The control, and it also pins that a MISSING content-type is tolerated —
    // the proxy does not CORS-expose every header.
    const c = client(
      async () =>
        new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );

    const art = await c.etiqueta('p1', 'pdf');

    expect(art.contentType).toBe('application/pdf');
  });
});
