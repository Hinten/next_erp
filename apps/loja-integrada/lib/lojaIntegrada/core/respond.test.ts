import { describe, expect, it } from 'vitest';
import {
  CODIGO_ERRO_LI,
  corpoSalvarCredencialLiSchema,
  erroContaLojaIntegradaSchema,
} from '@delfrance/schemas';

import {
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from './erros';
import {
  MENSAGEM_CORPO_NAO_JSON,
  isLiAppError,
  lerCorpoLi,
  respostaCancelada,
  respostaDeErroLi,
  respostaDeVeredito,
  respostaIdInvalido,
  respostaLi,
  respostaTokenDeOutraConta,
  respostaTokenNaRef,
  respostaValidadeRecusada,
} from './respond';

const ID = 'conta-li-1';

describe('respostaDeErroLi', () => {
  const casos = [
    [new LiContaNaoEncontradaError(ID), 404, CODIGO_ERRO_LI.contaNaoEncontrada],
    [new LiContaInativaError(ID), 409, CODIGO_ERRO_LI.contaInativa],
    [new LiCredencialAusenteError(ID), 409, CODIGO_ERRO_LI.credencialAusente],
    [new LiCredencialAlteradaError(ID), 409, CODIGO_ERRO_LI.credencialAlterada],
    [new LiContaParadaError(ID, 401, 1), 409, CODIGO_ERRO_LI.reconexaoPendente],
    [new LiEstacionamentoEmConflitoError(ID, 3), 503, CODIGO_ERRO_LI.estacionamentoEmConflito],
  ] as const;

  for (const [err, status, code] of casos) {
    it(`${err.name} → ${String(status)} ${code}, no issues`, async () => {
      expect(isLiAppError(err)).toBe(true);
      const res = respostaDeErroLi(err);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: err.message, code });
    });
  }

  it('LiCredencialInvalidaError → 409 with the field PATHS as issues', async () => {
    const res = respostaDeErroLi(
      new LiCredencialInvalidaError(ID, ['tokenFingerprint', 'reconexaoPendente.status']),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: CODIGO_ERRO_LI.credencialInvalida,
      issues: ['tokenFingerprint', 'reconexaoPendente.status'],
    });
  });

  it('isLiAppError rejects anything that is not an app error', () => {
    expect(isLiAppError(new Error('x'))).toBe(false);
    expect(isLiAppError(Object.assign(new Error('x'), { code: 9 }))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                      The request-level answers                              */
/* -------------------------------------------------------------------------- */

const SENTINELA = 'li-token-sentinela-ZZZZ-5555';

function put(body: string): Request {
  return new Request('http://localhost/x', {
    method: 'PUT',
    body,
    headers: { 'content-type': 'application/json' },
  });
}

describe('lerCorpoLi', () => {
  it('a body that is not JSON: a FIXED 400 that never quotes it', async () => {
    const r = await lerCorpoLi(put(`{"token":"${SENTINELA}`), corpoSalvarCredencialLiSchema);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.resposta.status).toBe(400);
    const texto = await r.resposta.text();
    expect(JSON.parse(texto)).toEqual({
      error: MENSAGEM_CORPO_NAO_JSON,
      code: CODIGO_ERRO_LI.corpoInvalido,
    });
    expect(texto).not.toContain(SENTINELA);
  });

  it('a body of the wrong shape: 400 with the PATHS, never the values', async () => {
    const r = await lerCorpoLi(
      put(JSON.stringify({ token: [SENTINELA], expiraEm: 1, versaoEsperada: -1 })),
      corpoSalvarCredencialLiSchema,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const texto = await r.resposta.text();
    expect(JSON.parse(texto)).toMatchObject({
      code: CODIGO_ERRO_LI.corpoInvalido,
      issues: ['token', 'expiraEm', 'versaoEsperada'],
    });
    expect(texto).not.toContain(SENTINELA);
  });

  it('a valid body is parsed (and trimmed)', async () => {
    const r = await lerCorpoLi(
      put(
        JSON.stringify({ token: ` ${SENTINELA}\n`, expiraEm: '2027-01-01', versaoEsperada: null }),
      ),
      corpoSalvarCredencialLiSchema,
    );
    expect(r).toEqual({
      ok: true,
      dados: { token: SENTINELA, expiraEm: '2027-01-01', versaoEsperada: null },
    });
  });

  it('near-miss: anything other than a SyntaxError is rethrown (a body already read)', async () => {
    const req = put('{}');
    await req.text();
    await expect(lerCorpoLi(req, corpoSalvarCredencialLiSchema)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('respostaDeVeredito', () => {
  const base = { motivo: 'motivo do pacote', correlationId: 'c-1' };

  it.each([
    ['recusado', 401, 422, CODIGO_ERRO_LI.tokenRecusado],
    ['invalido', null, 422, CODIGO_ERRO_LI.tokenInvalido],
    ['inconclusivo', 503, 502, CODIGO_ERRO_LI.validacaoInconclusiva],
  ] as const)('%s → %s', async (veredito, status, http, code) => {
    const res = respostaDeVeredito({ ...base, veredito, status });
    expect(res.status).toBe(http);
    expect(await res.json()).toEqual({
      error: 'motivo do pacote',
      code,
      status,
      correlationId: 'c-1',
    });
  });

  it('aceito is never a refusal: a programming error, thrown', () => {
    expect(() => respostaDeVeredito({ ...base, veredito: 'aceito', status: 200 })).toThrow(
      TypeError,
    );
  });
});

describe('the fixed answers', () => {
  it('499 has an EMPTY body', async () => {
    const res = respostaCancelada();
    expect(res.status).toBe(499);
    expect(await res.text()).toBe('');
  });

  it('the id, ref, other-conta and date refusals carry their codes', async () => {
    expect(await respostaIdInvalido().json()).toMatchObject({ code: CODIGO_ERRO_LI.idInvalido });
    expect(respostaTokenNaRef().status).toBe(422);
    expect(await respostaTokenNaRef().json()).toMatchObject({ code: CODIGO_ERRO_LI.tokenInvalido });
    expect(respostaTokenDeOutraConta().status).toBe(409);
    const data = respostaValidadeRecusada({
      ok: false,
      code: CODIGO_ERRO_LI.validadePassada,
      motivo: 'passou',
    });
    expect(data.status).toBe(422);
    expect(await data.json()).toEqual({
      error: 'passou',
      code: CODIGO_ERRO_LI.validadePassada,
      issues: ['expiraEm'],
    });
  });

  it('every refusal parses as the shared error envelope', async () => {
    for (const res of [
      respostaIdInvalido(),
      respostaTokenNaRef(),
      respostaTokenDeOutraConta(),
      respostaDeVeredito({ veredito: 'recusado', status: 403, motivo: 'm', correlationId: 'c' }),
      respostaLi(400, CODIGO_ERRO_LI.corpoInvalido, 'x', { issues: ['a'] }),
    ]) {
      expect(erroContaLojaIntegradaSchema.safeParse(await res.json()).success).toBe(true);
    }
  });
});
