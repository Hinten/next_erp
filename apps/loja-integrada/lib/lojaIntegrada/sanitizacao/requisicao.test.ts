import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import { describe, expect, it } from 'vitest';

import { ORIGEM_LI } from '../core/redacao';
import { CREDENCIAIS_CAPTURA_LI } from '../fixtures/wireCorpus';
import { type RequisicaoCapturada, decodificarUtf8, lerSidecar } from './requisicao';

const SENTINELA = 'SENTINELA-91c2';
const b = (t: string) => new TextEncoder().encode(t);
const CRED = 'credencial: personal-token';
const sidecar = (...linhas: string[]) => b(`${linhas.join('\n')}\n`);

function aceito(bytes: Uint8Array): RequisicaoCapturada {
  const r = lerSidecar(bytes);
  if (!r.ok) throw new Error(`refused: ${r.problemas.map((p) => p.tipo).join(', ')}`);
  return r.requisicao;
}

function recusas(bytes: Uint8Array): string[] {
  const r = lerSidecar(bytes);
  return r.ok ? [] : r.problemas.map((p) => `${String(p.linha)}:${p.tipo}`);
}

describe('lerSidecar — the request line', () => {
  it("accepts curl's own sidecar: path with its slash, the raw query, the status", () => {
    const r = aceito(
      sidecar(
        'GET https://api.awsli.com.br/v1/pedido/search/?limit=50&since_atualizado=2026-09-25T00%3A00%3A00 200',
        CRED,
      ),
    );
    expect(r).toEqual({
      metodo: 'GET',
      caminho: '/v1/pedido/search/',
      query: 'limit=50&since_atualizado=2026-09-25T00%3A00%3A00',
      status: 200,
      credencial: 'personal-token',
      data: null,
    });
  });

  it('accepts the `/v1/…` form', () => {
    expect(aceito(sidecar('GET /v1/x/ 200', CRED)).caminho).toBe('/v1/x/');
  });

  it('keeps the trailing slash: `/v1/x/` and `/v1/x` stay distinct', () => {
    expect(aceito(sidecar('GET /v1/x/ 200', CRED)).caminho).toBe('/v1/x/');
    expect(aceito(sidecar('GET /v1/x 200', CRED)).caminho).toBe('/v1/x');
  });

  it.each([
    ['plain http', 'GET http://api.awsli.com.br/v1/x/ 200', '1:origem'],
    ['another host', 'GET https://outro.example/v1/x/ 200', '1:origem'],
    ['a look-alike host', 'GET https://api.awsli.com.br.outro.example/v1/x/ 200', '1:origem'],
    ['userinfo', 'GET https://u:p@api.awsli.com.br/v1/x/ 200', '1:origem'],
    ['an explicit port', 'GET https://api.awsli.com.br:443/v1/x/ 200', '1:origem'],
    ['a scheme-relative URL', 'GET //api.awsli.com.br/v1/x/ 200', '1:origem'],
    ['the /api/v1 form', 'GET /api/v1/x/ 200', '1:caminho-fora-de-v1'],
    ['a webhook path', 'GET /webhooks/v1/pedido 200', '1:webhook'],
    ['dot segments', 'GET /v1/../x/ 200', '1:caminho-inseguro'],
    ['encoded dot segments', 'GET /v1/%2e%2e/x/ 200', '1:caminho-inseguro'],
    ['an encoded separator', 'GET /v1/x%2Fy/ 200', '1:caminho-inseguro'],
    ['a backslash', 'GET /v1/x\\y/ 200', '1:caminho-inseguro'],
    ['a fragment', 'GET /v1/x/#a 200', '1:url-com-fragmento'],
    ['a path the parser rewrites', 'GET /v1/produto/{id} 200', '1:caminho-nao-canonico'],
    ['an unknown verb', 'PATCH /v1/x/ 200', '1:metodo'],
    ['a 2-digit status', 'GET /v1/x/ 20', '1:status'],
    ['a 4-digit status', 'GET /v1/x/ 2000', '1:status'],
    ['a status out of range', 'GET /v1/x/ 700', '1:status'],
    ['a fourth token', 'GET /v1/x/ 200 extra', '1:linha-de-requisicao'],
  ])('refuses %s', (_caso, linha, esperado) => {
    expect(recusas(sidecar(linha, CRED))).toEqual([esperado]);
  });

  it('refuses an empty file, and one with no request line', () => {
    expect(recusas(b(''))).toEqual(['null:vazio']);
    expect(recusas(b('\n\n'))).toEqual(['null:vazio']);
  });

  it('a malformed URL is refused by line number, never thrown, and its text never echoed', () => {
    for (const url of [
      `https://[${SENTINELA}/v1/x/`,
      `${SENTINELA}`,
      `htp:/${SENTINELA}`,
      `https://${SENTINELA}.example/v1/x/`,
    ]) {
      const r = lerSidecar(sidecar(`GET ${url} 200`, CRED));
      expect(r.ok, url).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SENTINELA);
    }
    expect(recusas(sidecar(`GET https://[${SENTINELA}/v1/x/ 200`, CRED))).toEqual([
      '1:url-invalida',
    ]);
  });
});

describe('lerSidecar — a credential in the URL', () => {
  it.each(['chave_api', 'CHAVE_API', 'aplicacao', 'token', 'api_key', 'apikey', 'senha'])(
    'refuses the key %s, naming the key and never the value',
    (chave) => {
      const r = lerSidecar(sidecar(`GET /v1/x/?limit=1&${chave}=${SENTINELA} 200`, CRED));
      expect(r).toEqual({
        ok: false,
        problemas: [{ linha: 1, tipo: 'credencial-na-url', chave }],
      });
      expect(JSON.stringify(r)).not.toContain(SENTINELA);
    },
  );

  it('an encoded or non-identifier credential key is refused too, printed as `<chave>`', () => {
    expect(lerSidecar(sidecar(`GET /v1/x/?chave%5Fapi=${SENTINELA} 200`, CRED))).toEqual({
      ok: false,
      problemas: [{ linha: 1, tipo: 'credencial-na-url', chave: '<chave>' }],
    });
    expect(recusas(sidecar(`GET /v1/x/?x-token=${SENTINELA} 200`, CRED))).toEqual([
      '1:credencial-na-url',
    ]);
  });

  it('near-miss: `limit=1` is not a credential', () => {
    expect(aceito(sidecar('GET /v1/x/?limit=1 200', CRED)).query).toBe('limit=1');
  });
});

describe('lerSidecar — the other lines', () => {
  it.each(CREDENCIAIS_CAPTURA_LI)('accepts `credencial: %s`', (credencial) => {
    expect(aceito(sidecar('GET /v1/x/ 200', `credencial: ${credencial}`)).credencial).toBe(
      credencial,
    );
  });

  it('a missing credencial line is refused: there is no default', () => {
    expect(recusas(sidecar('GET /v1/x/ 200'))).toEqual(['null:sem-credencial']);
    expect(recusas(sidecar('GET /v1/x/ 200', 'data: 2026-10-07'))).toEqual(['null:sem-credencial']);
  });

  it('accepts `data: AAAA-MM-DD`, in any order after line 1', () => {
    expect(aceito(sidecar('GET /v1/x/ 200', 'data: 2026-10-07', CRED)).data).toBe('2026-10-07');
  });

  it.each([
    ['a repeated credencial', ['GET /v1/x/ 200', CRED, CRED], ['3:credencial-repetida']],
    [
      'a repeated data',
      ['GET /v1/x/ 200', CRED, 'data: 2026-10-07', 'data: 2026-10-08'],
      ['4:data-repetida'],
    ],
    ['a Brazilian date', ['GET /v1/x/ 200', CRED, 'data: 07/10/2026'], ['3:data-invalida']],
    ['an impossible date', ['GET /v1/x/ 200', CRED, 'data: 2026-02-30'], ['3:data-invalida']],
    [
      'an unknown credential',
      ['GET /v1/x/ 200', `credencial: ${SENTINELA}`],
      ['2:credencial-desconhecida'],
    ],
    ['a blank line in the middle', ['GET /v1/x/ 200', '', CRED], ['2:linha-nao-reconhecida']],
  ])('refuses %s', (_caso, linhas, esperado) => {
    expect(recusas(sidecar(...linhas))).toEqual(esperado);
  });

  it('an `Authorization:` line is refused by its number, and its text is never echoed', () => {
    const r = lerSidecar(sidecar('GET /v1/x/ 200', CRED, `Authorization: Basic ${SENTINELA}`));
    expect(r).toEqual({ ok: false, problemas: [{ linha: 3, tipo: 'linha-nao-reconhecida' }] });
    expect(JSON.stringify(r)).not.toContain(SENTINELA);
  });
});

describe('encoding', () => {
  it('accepts CRLF, a UTF-8 BOM and trailing blank lines', () => {
    const texto = '\uFEFFGET /v1/x/ 200\r\ncredencial: personal-token\r\n\r\n\r\n';
    expect(aceito(b(texto)).caminho).toBe('/v1/x/');
  });

  it('refuses a UTF-16 BOM in either byte order', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x47, 0x00]);
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x47]);
    expect(recusas(le)).toEqual(['null:utf16']);
    expect(recusas(be)).toEqual(['null:utf16']);
    expect(decodificarUtf8(le).ok).toBe(false);
  });

  it('refuses UTF-16 with no BOM, in either byte order: any NUL byte', () => {
    const linha = 'GET /v1/x/ 200\ncredencial: personal-token\n';
    const le = new Uint8Array(Buffer.from(linha, 'utf16le'));
    const be = new Uint8Array(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1] ?? 0;
      be[i + 1] = le[i] ?? 0;
    }
    expect(recusas(le)).toEqual(['null:utf16']);
    expect(recusas(be)).toEqual(['null:utf16']);
    // One NUL anywhere is enough: no UTF-8 text a capture holds carries a raw NUL.
    expect(decodificarUtf8(new Uint8Array([0x7b, 0x7d, 0x00])).ok).toBe(false);
    expect(decodificarUtf8(b('{"a":"\\u0000"}')).ok).toBe(true);
  });

  it('decodificarUtf8 strips a UTF-8 BOM and nothing else', () => {
    expect(decodificarUtf8(b('\uFEFFabc'))).toEqual({ ok: true, texto: 'abc' });
    expect(decodificarUtf8(b('abc'))).toEqual({ ok: true, texto: 'abc' });
  });
});

describe('the local origin', () => {
  it("is the package's URL_BASE_LI (the sanitizer may not import the package)", () => {
    expect(ORIGEM_LI).toBe(URL_BASE_LI);
  });
});
