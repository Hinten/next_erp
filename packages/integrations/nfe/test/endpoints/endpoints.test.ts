import { describe, expect, it } from 'vitest';

import {
  NFeContingencyEndpointError,
  NFeEndpointError,
  getAnEndpoints,
  getEndpoints,
  getSvcEndpoints,
  svcAuthorizerForUF,
} from '../../src/endpoints';

describe('getEndpoints (home SEFAZ)', () => {
  it('resolves SP for both ambientes', () => {
    expect(getEndpoints('SP', 'producao').NfeAutorizacao).toContain('nfe.fazenda.sp.gov.br');
    expect(getEndpoints('SP', 'homologacao').NfeAutorizacao).toContain(
      'homologacao.nfe.fazenda.sp.gov.br',
    );
  });

  it('throws NFeEndpointError for an unwired UF', () => {
    expect(() => getEndpoints('MG', 'producao')).toThrow(NFeEndpointError);
  });
});

describe('svcAuthorizerForUF', () => {
  it('maps SP (and the other SVC-AN UFs) to svc-an', () => {
    expect(svcAuthorizerForUF('SP')).toBe('svc-an');
    expect(svcAuthorizerForUF('sp')).toBe('svc-an');
    for (const uf of ['MG', 'RJ', 'RS', 'SC', 'ES', 'DF']) {
      expect(svcAuthorizerForUF(uf)).toBe('svc-an');
    }
  });

  it('throws for SVC-RS UFs until the svc-rs PR lands', () => {
    for (const uf of ['PR', 'BA', 'MT', 'PE']) {
      expect(() => svcAuthorizerForUF(uf)).toThrow(NFeContingencyEndpointError);
    }
  });
});

describe('getSvcEndpoints', () => {
  it('serves the official SVC-AN URL set per ambiente', () => {
    const prod = getSvcEndpoints('svc-an', 'producao');
    expect(prod.NfeAutorizacao).toBe(
      'https://www.svc.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
    );
    expect(prod.NfeStatusServico).toBe(
      'https://www.svc.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
    );
    const hom = getSvcEndpoints('svc-an', 'homologacao');
    expect(hom.NfeRetAutorizacao).toBe(
      'https://hom.svc.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
    );
    expect(hom.RecepcaoEvento).toBe(
      'https://hom.svc.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
    );
  });

  it('has no Inutilizacao key — SVC does not offer inutilização', () => {
    const urls = getSvcEndpoints('svc-an', 'producao');
    expect('NfeInutilizacao' in urls).toBe(false);
  });

  it('throws for svc-rs until the svc-rs PR lands', () => {
    expect(() => getSvcEndpoints('svc-rs', 'producao')).toThrow(NFeContingencyEndpointError);
  });
});

describe('getAnEndpoints (EPEC drop-box)', () => {
  it('serves only RecepcaoEvento, per ambiente', () => {
    expect(getAnEndpoints('producao').RecepcaoEvento).toBe(
      'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
    );
    expect(getAnEndpoints('homologacao').RecepcaoEvento).toBe(
      'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
    );
  });
});
