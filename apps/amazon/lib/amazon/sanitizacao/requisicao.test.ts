import { describe, expect, it } from 'vitest';

import {
  CHAVE_DE_CREDENCIAL_NA_CAPTURA,
  ORIGEM_SP_API,
  type TipoProblemaDoSidecar,
  decodificarUtf8,
  lerSidecar,
} from './requisicao';

const b = (t: string) => new TextEncoder().encode(t);
const GET_ORDER = '/orders/2026-01-01/orders/123-4567890-1234567';
const BULK = '/easyShip/2022-03-23/packages/bulk';

function sidecar(linha1: string, ...resto: string[]) {
  const linhas =
    resto.length > 0 ? resto : ['credencial: token-legado-curl', 'papeis: dtc,tax-invoicing'];
  return lerSidecar(b(`${[linha1, ...linhas].join('\n')}\n`));
}

function tipos(r: ReturnType<typeof lerSidecar>): TipoProblemaDoSidecar[] {
  return r.ok ? [] : r.problemas.map((p) => p.tipo);
}

describe('the sidecar grammar', () => {
  it('a full GET line, credential, roles, date and rate limit', () => {
    const r = sidecar(
      `GET ${ORIGEM_SP_API}${GET_ORDER}?includedData=BUYER,RECIPIENT 200`,
      'credencial: token-legado-curl',
      'papeis: dtc, tax-invoicing',
      'data: 2026-10-20',
      'limite-taxa: 0.0167',
    );
    expect(r).toEqual({
      ok: true,
      requisicao: {
        tipo: 'http',
        metodo: 'GET',
        caminho: GET_ORDER,
        query: [['includedData', 'BUYER,RECIPIENT']],
        status: 200,
        credencial: 'token-legado-curl',
        papeis: ['dtc', 'tax-invoicing'],
        data: '2026-10-20',
        limiteTaxa: 0.0167,
      },
    });
  });

  it('a path-only URL, CRLF line ends and trailing blanks are accepted', () => {
    const r = lerSidecar(
      b(`GET ${GET_ORDER} 404\r\ncredencial: token-legado-curl  \r\npapeis: nenhum\r\n\r\n`),
    );
    expect(r.ok).toBe(true);
  });

  it('★ a header line is refused, by line number', () => {
    const r = sidecar(
      `GET ${GET_ORDER} 200`,
      'credencial: token-legado-curl',
      'papeis: dtc',
      'x-amz-access-token: Atza|segredo',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problemas).toEqual([{ linha: 4, tipo: 'linha-nao-reconhecida' }]);
    // A refusal never carries the line's text.
    expect(JSON.stringify(r)).not.toContain('Atza');
  });

  it.each([
    ['X-Amz-Signature', 'X-Amz-Signature=abc'],
    ['X-Amz-Credential', 'X-Amz-Credential=abc'],
    ['spapi_oauth_code', 'spapi_oauth_code=abc'],
    ['state', 'state=abc'],
    ['selling_partner_id', 'selling_partner_id=AXXXXXXXXXXXXX'],
    ['a pagination token', 'paginationToken=abc'],
    // Without the `x-amz-` prefix: only `signature|credential` catch these.
    ['a bare Signature', 'Signature=abc'],
    ['a bare Credential', 'Credential=abc'],
  ])('★ a credential-shaped query key (%s) is refused', (_caso, query) => {
    expect(tipos(sidecar(`GET ${GET_ORDER}?${query} 200`))).toContain('credencial-na-url');
  });

  it('a credential key prints only when it is an identifier', () => {
    const r = sidecar(`GET ${GET_ORDER}?state=1&X-Amz-Signature=2 200`);
    expect(r.ok ? [] : r.problemas.map((p) => p.chave)).toEqual(['state', '<chave>']);
  });

  it('near-miss: includedData and marketplaceIds pass', () => {
    expect(
      sidecar(
        `GET /orders/2026-01-01/orders?marketplaceIds=A2Q3Y263D00KWC&includedData=BUYER,TAX 200`,
      ).ok,
    ).toBe(true);
  });

  it('the credential-key pattern holds signature and credential (LI missed both)', () => {
    expect(CHAVE_DE_CREDENCIAL_NA_CAPTURA.test('X-Amz-Signature')).toBe(true);
    expect(CHAVE_DE_CREDENCIAL_NA_CAPTURA.test('x-amz-credential')).toBe(true);
    expect(CHAVE_DE_CREDENCIAL_NA_CAPTURA.test('marketplaceIds')).toBe(false);
  });

  it.each([
    ['the LWA host', 'GET https://api.amazon.com/auth/o2/token 200', 'host'],
    ['an S3 host', 'GET https://exemplo.s3.amazonaws.com/doc?x=1 200', 'host'],
    [
      'another SP-API region',
      'GET https://sellingpartnerapi-eu.amazon.com/orders/2026-01-01/orders 200',
      'host',
    ],
    ['plain http', `GET http://sellingpartnerapi-na.amazon.com${GET_ORDER} 200`, 'host'],
    ['userinfo', `GET https://x@sellingpartnerapi-na.amazon.com${GET_ORDER} 200`, 'host'],
    ['a report document', 'GET /reports/2021-06-30/documents/amzn1.doc.1 200', 'segredo'],
    ['a feed document', 'POST /feeds/2021-06-30/documents 201', 'segredo'],
    ['an unknown documents path', 'GET /reports/2021-06-30/documents 200', 'segredo'],
    ['the RDT', 'POST /tokens/2021-03-01/restrictedDataToken 200', 'segredo'],
    [
      'a listings path (no table yet)',
      'GET /listings/2021-08-01/items/AXXXXXXXXXXXXX/SKU-1 200',
      'sem-tabela',
    ],
    ['an unknown path', 'GET /algo/2030-01-01/coisa 200', 'sem-tabela'],
    ['a fragment', `GET ${GET_ORDER}#x 200`, 'url-com-fragmento'],
    ['a dot segment', 'GET /orders/2026-01-01/../orders 200', 'caminho-inseguro'],
    ['an encoded dot segment', 'GET /orders/2026-01-01/%2e%2e/orders 200', 'caminho-nao-canonico'],
    [
      'a query value that is a URL',
      `GET ${GET_ORDER}?x=https%3A%2F%2Fexemplo.invalid%2Fa 200`,
      'url-na-query',
    ],
    ['an unknown method', `HEAD ${GET_ORDER} 200`, 'metodo'],
    ['a bad status', `GET ${GET_ORDER} 99`, 'status'],
    ['four tokens', `GET ${GET_ORDER} 200 extra`, 'linha-de-requisicao'],
  ])('★ refuses %s', (_caso, linha1, tipo) => {
    expect(tipos(sidecar(linha1))).toContain(tipo);
  });

  it('★ token-legado-curl with POST is refused (a write is never curled)', () => {
    expect(tipos(sidecar(`POST ${BULK} 200`))).toEqual(['curl-so-get']);
  });

  it('near-miss: copia-do-legado with POST bulk passes', () => {
    const r = sidecar(`POST ${BULK} 200`, 'credencial: copia-do-legado', 'papeis: dtc');
    expect(r.ok).toBe(true);
  });

  it('★ a missing papeis: is refused, and so is a missing credencial:', () => {
    expect(tipos(sidecar(`GET ${GET_ORDER} 200`, 'credencial: token-legado-curl'))).toEqual([
      'sem-papeis',
    ]);
    expect(tipos(sidecar(`GET ${GET_ORDER} 200`, 'papeis: dtc'))).toEqual(['sem-credencial']);
  });

  it.each([
    ['an unknown role', 'papeis: dtc,admin', 'papeis-invalidos'],
    ['a role twice', 'papeis: dtc,dtc', 'papeis-repetidos'],
    ['nenhum beside a role', 'papeis: nenhum,dtc', 'papeis-invalidos'],
    ['nao-se-aplica on a real capture', 'papeis: nao-se-aplica', 'papeis-incoerentes'],
  ])('the roles: %s', (_caso, linha, tipo) => {
    expect(
      tipos(sidecar(`GET ${GET_ORDER} 200`, 'credencial: token-legado-curl', linha)),
    ).toContain(tipo);
  });

  it('a model example takes nao-se-aplica, and only that', () => {
    expect(
      sidecar(`GET ${GET_ORDER} 200`, 'credencial: modelo-sandbox', 'papeis: nao-se-aplica').ok,
    ).toBe(true);
    expect(
      tipos(sidecar(`GET ${GET_ORDER} 200`, 'credencial: modelo-sandbox', 'papeis: dtc')),
    ).toEqual(['papeis-incoerentes']);
  });

  it.each([
    ['an unknown credential', ['credencial: token-novo', 'papeis: dtc'], 'credencial-desconhecida'],
    [
      'a credential twice',
      ['credencial: token-legado-curl', 'credencial: copia-do-legado', 'papeis: dtc'],
      'credencial-repetida',
    ],
    [
      'a bad date',
      ['credencial: token-legado-curl', 'papeis: dtc', 'data: 2026-02-30'],
      'data-invalida',
    ],
    [
      'a rate limit that is not a decimal',
      ['credencial: token-legado-curl', 'papeis: dtc', 'limite-taxa: 1e3'],
      'limite-taxa-invalido',
    ],
  ])('refuses %s', (_caso, linhas, tipo) => {
    expect(tipos(sidecar(`GET ${GET_ORDER} 200`, ...linhas))).toContain(tipo);
  });

  it('the notification pseudo-line', () => {
    const r = sidecar(
      'NOTIFICACAO ORDER_CHANGE pipe',
      'credencial: documentacao-aws',
      'papeis: nao-se-aplica',
    );
    expect(r).toMatchObject({ ok: true, requisicao: { tipo: 'notificacao', transporte: 'pipe' } });
    expect(
      tipos(
        sidecar(
          'NOTIFICACAO ANY_OFFER_CHANGED sqs',
          'credencial: modelo-sandbox',
          'papeis: nao-se-aplica',
        ),
      ),
    ).toEqual(['notificacao-desconhecida']);
    expect(
      tipos(
        sidecar(
          'NOTIFICACAO ORDER_CHANGE sns',
          'credencial: modelo-sandbox',
          'papeis: nao-se-aplica',
        ),
      ),
    ).toEqual(['transporte']);
    // A notification is never fetched with the owner's curl.
    expect(
      tipos(
        sidecar('NOTIFICACAO ORDER_CHANGE sqs', 'credencial: token-legado-curl', 'papeis: dtc'),
      ),
    ).toEqual(['curl-so-get']);
  });

  it('a query is decoded the way the client builds its pairs (`+` stays `+`)', () => {
    const r = sidecar(
      `GET /orders/2026-01-01/orders?createdAfter=2026-01-01T00%3A00%3A00+00%3A00 200`,
    );
    expect(r.ok && r.requisicao.tipo === 'http' ? r.requisicao.query : null).toEqual([
      ['createdAfter', '2026-01-01T00:00:00+00:00'],
    ]);
  });
});

describe('★ encoding: UTF-16 (with and without a BOM) and invalid UTF-8 are refused', () => {
  const utf16le = (t: string) => {
    const saida = new Uint8Array(t.length * 2);
    for (let i = 0; i < t.length; i++) saida[i * 2] = t.charCodeAt(i);
    return saida;
  };

  it('UTF-16 with a BOM, UTF-16 without one, invalid UTF-8', () => {
    expect(decodificarUtf8(new Uint8Array([0xff, 0xfe, ...utf16le('GET')]))).toEqual({
      ok: false,
      motivo: 'utf16',
    });
    expect(decodificarUtf8(utf16le('GET /x 200'))).toEqual({ ok: false, motivo: 'utf16' });
    expect(decodificarUtf8(new Uint8Array([0x47, 0xc3, 0x28]))).toEqual({
      ok: false,
      motivo: 'utf8-invalido',
    });
    expect(tipos(lerSidecar(utf16le('GET /x 200')))).toEqual(['utf16']);
  });

  it('near-miss: UTF-8 with a BOM is read, the BOM stripped', () => {
    const r = decodificarUtf8(new Uint8Array([0xef, 0xbb, 0xbf, ...b('{"a":"é"}')]));
    expect(r).toEqual({ ok: true, texto: '{"a":"é"}' });
  });
});
