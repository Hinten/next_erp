/**
 * An inutilização REJECTION whose `dhRecbto` SEFAZ left unfilled.
 *
 * Since 2026-10-22 SEFAZ-SP homologação answers `NfeInutilizacao4` with
 * `<dhRecbto>0001-01-01T00:00:00+00:00</dhRecbto>` — .NET's `DateTime.MinValue`
 * in an element the XSD requires and MOC 7.0 §5.3.2 says is "não preenchido em
 * caso de erro". The response gate used to throw `NFeXsdValidationError` on it,
 * so nobody ever saw the cStat. `validateRetInutNFe` tolerates exactly that
 * shape; every near-miss below must keep throwing.
 *
 * The operation half drives the REAL `postSoapValidated` (request XSD gate,
 * transport guards, response gate) with `soap`'s `HttpClient` replaced, so it
 * pins the wiring as well as the rule.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('soap', () => ({
  HttpClient: class {
    request(...args: unknown[]): unknown {
      return request(...args);
    }
  },
}));

import { getEndpoints } from '../../src/endpoints/index';
import { inutilizarNumeracao } from '../../src/operations/index';
import type { SefazCall } from '../../src/soap/index';
import { NFeXsdValidationError, validateRetInutNFe, validateXsd } from '../../src/xsd/index';
import { certificadoDeTeste, NFE_NS } from '../helpers/evento-fixture';

const SENTINELA = '0001-01-01T00:00:00+00:00';

/** A rejection reply as SEFAZ sends it: no Id, no echoed faixa, no nProt. */
function rejeicao(opts: { cStat?: string; dhRecbto?: string; tpAmb?: string } = {}): string {
  return (
    `<retInutNFe xmlns="${NFE_NS}" versao="4.00"><infInut>` +
    `<tpAmb>${opts.tpAmb ?? '2'}</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic>` +
    `<cStat>${opts.cStat ?? '241'}</cStat>` +
    `<xMotivo>Rejeicao: Um numero da faixa ja foi utilizado</xMotivo>` +
    `<cUF>35</cUF>` +
    `<dhRecbto>${opts.dhRecbto ?? SENTINELA}</dhRecbto>` +
    `</infInut></retInutNFe>`
  );
}

/** A homologada reply (cStat 102) — the faixa echoed and a protocol. */
function homologada(dhRecbto: string): string {
  return (
    `<retInutNFe xmlns="${NFE_NS}" versao="4.00"><infInut>` +
    `<tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><cStat>102</cStat>` +
    `<xMotivo>Inutilizacao de numero homologado</xMotivo>` +
    `<cUF>35</cUF><ano>26</ano><CNPJ>14200166000187</CNPJ><mod>55</mod>` +
    `<serie>9</serie><nNFIni>5</nNFIni><nNFFin>5</nNFFin>` +
    `<dhRecbto>${dhRecbto}</dhRecbto><nProt>135260000088888</nProt>` +
    `</infInut></retInutNFe>`
  );
}

describe('validateRetInutNFe — the unfilled-dhRecbto rejection', () => {
  it('accepts a rejection whose dhRecbto is DateTime.MinValue', async () => {
    await expect(validateRetInutNFe(rejeicao())).resolves.toBeUndefined();
  });

  it('accepts the sentinel under any offset (the server zone picks it)', async () => {
    await expect(
      validateRetInutNFe(rejeicao({ dhRecbto: '0001-01-01T00:00:00-03:00' })),
    ).resolves.toBeUndefined();
  });

  it('leaves the plain XSD gate strict — the tolerance lives in validateRetInutNFe only', async () => {
    await expect(validateXsd('retInutNFe', rejeicao())).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });

  it('still accepts a fully valid reply, either outcome', async () => {
    await expect(
      validateRetInutNFe(rejeicao({ dhRecbto: '2026-10-22T09:41:12-03:00' })),
    ).resolves.toBeUndefined();
    await expect(
      validateRetInutNFe(homologada('2026-10-22T09:41:12-03:00')),
    ).resolves.toBeUndefined();
  });

  // ---- near-misses: each must keep throwing ----

  it('rejects the sentinel on a HOMOLOGADA reply (cStat 102 must carry a real dhRecbto)', async () => {
    await expect(validateRetInutNFe(homologada(SENTINELA))).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });

  it('rejects a date that is merely close to the sentinel', async () => {
    await expect(
      validateRetInutNFe(rejeicao({ dhRecbto: '0001-01-01T00:00:01+00:00' })),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
    await expect(
      validateRetInutNFe(rejeicao({ dhRecbto: '1999-12-31T23:59:59-03:00' })),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects an empty dhRecbto — "unfilled" means the sentinel, not anything', async () => {
    await expect(validateRetInutNFe(rejeicao({ dhRecbto: '' }))).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });

  it('rejects the sentinel when ANOTHER field is invalid too — and reports the original errors', async () => {
    const err = await validateRetInutNFe(rejeicao({ tpAmb: '3' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeXsdValidationError);
    const messages = (err as NFeXsdValidationError).errors.map((e) => e.message).join('\n');
    expect(messages).toContain('dhRecbto');
    expect(messages).toContain('tpAmb');
  });

  it('rejects a reply with no cStat at all', async () => {
    const semCStat = rejeicao().replace(/<cStat>[^<]*<\/cStat>/, '');
    await expect(validateRetInutNFe(semCStat)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});

describe('inutilizarNumeracao over the real SOAP gate', () => {
  const url = getEndpoints('SP', 'homologacao').NfeInutilizacao;
  const call: SefazCall = {
    url,
    tpAmb: '2',
    cert: certificadoDeTeste(),
    agent: {} as never,
  };
  const args = {
    cUF: '35',
    ano: '26',
    cnpj: '14200166000187',
    serie: 9,
    nNFIni: 5,
    nNFFin: 5,
    xJust: 'Inutilizacao de teste de homologacao - faixa nao utilizada',
  } as const;

  function sefazAnswers(retInutNFe: string): void {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>` +
      `<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4">` +
      retInutNFe +
      `</nfeResultMsg></soap:Body></soap:Envelope>`;
    request.mockImplementationOnce(
      (_url: string, _body: string, cb: (err: unknown, res: unknown, body: unknown) => void) => {
        cb(null, { status: 200 }, body);
      },
    );
  }

  afterEach(() => {
    request.mockReset();
  });

  it('surfaces the cStat of a sentinel-dhRecbto rejection instead of an XSD crash', async () => {
    sefazAnswers(rejeicao({ cStat: '241' }));
    const res = await inutilizarNumeracao(call, args);
    expect(request).toHaveBeenCalledTimes(1);
    expect(res.ret.infInut.cStat).toBe('241');
    expect(res.ret.infInut.xMotivo).toContain('faixa');
    expect(res.ret.infInut.nProt).toBeUndefined();
    // The audit copy is SEFAZ's bytes, sentinel included — never rewritten.
    expect(res.rawResponse).toContain(`<dhRecbto>${SENTINELA}</dhRecbto>`);
  });

  it('near-miss: the same sentinel on a cStat 102 reply still fails the gate', async () => {
    sefazAnswers(homologada(SENTINELA));
    await expect(inutilizarNumeracao(call, args)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});
