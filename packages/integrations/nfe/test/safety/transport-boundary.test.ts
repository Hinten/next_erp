/**
 * Behaviour, not wiring: at each real SOAP boundary, a call aimed at a produção
 * SEFAZ host is refused BEFORE the request is made.
 *
 * `safety.test.ts` counts guard calls against `postSoap(` call sites — that catches
 * a missing guard, but not a guard moved after the POST, or two guards at one
 * boundary and none at the other. Here `soap`'s `HttpClient` is replaced by a spy
 * (nothing can reach the network), and each boundary is driven with a produção URL
 * under the homologação label. The homologação control proves the spy is live, so
 * "zero requests" is a real observation rather than an unwired mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('soap', () => ({
  HttpClient: class {
    request(...args: unknown[]): unknown {
      return request(...args);
    }
  },
}));

import { getConsultaCadastroEndpoint, getEndpoints } from '../../src/endpoints/index';
import { NFeProductionGuardError } from '../../src/safety/index';
import { nfeConsultaCadastro, nfeStatusServico, type SefazCall } from '../../src/soap/index';

const CONS_STAT_SERV =
  '<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
  '<tpAmb>2</tpAmb><cUF>35</cUF><xServ>STATUS</xServ></consStatServ>';

function call(url: string, tpAmb: '1' | '2' = '2'): SefazCall {
  return { url, tpAmb, cert: {} as never, agent: {} as never };
}

beforeEach(() => {
  // Any request that does get through fails like an unreachable host would.
  request.mockImplementation((_url: string, _body: string, cb: (err: unknown) => void) => {
    cb(new Error('offline test: no network'));
  });
});

afterEach(() => {
  request.mockReset();
  vi.unstubAllEnvs();
});

describe('postSoapValidated boundary (nfeStatusServico)', () => {
  const producao = getEndpoints('SP', 'producao').NfeStatusServico;
  const homologacao = getEndpoints('SP', 'homologacao').NfeStatusServico;

  it("refuses tpAmb='2' aimed at a produção host — no request is made", async () => {
    await expect(nfeStatusServico(call(producao), CONS_STAT_SERV)).rejects.toThrow(
      NFeProductionGuardError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('still refuses it with NFE_ALLOW_PRODUCAO=true — the label and URL disagree', async () => {
    vi.stubEnv('NFE_ALLOW_PRODUCAO', 'true');
    await expect(nfeStatusServico(call(producao), CONS_STAT_SERV)).rejects.toThrow(
      /label and the URL disagree/,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('control: the homologação host reaches the (mocked) request exactly once', async () => {
    await expect(nfeStatusServico(call(homologacao), CONS_STAT_SERV)).rejects.toThrow(
      /offline test: no network/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe(homologacao);
  });
});

describe('nfeConsultaCadastro boundary (no XSD gate)', () => {
  const producao = getConsultaCadastroEndpoint('SP', 'producao')!;
  const homologacao = getConsultaCadastroEndpoint('SP', 'homologacao')!;

  it("refuses tpAmb='2' aimed at a produção host — no request is made", async () => {
    await expect(nfeConsultaCadastro(call(producao), '<ConsCad/>', '35')).rejects.toThrow(
      NFeProductionGuardError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('control: the homologação host reaches the (mocked) request exactly once', async () => {
    await expect(nfeConsultaCadastro(call(homologacao), '<ConsCad/>', '35')).rejects.toThrow(
      /offline test: no network/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe(homologacao);
  });
});
