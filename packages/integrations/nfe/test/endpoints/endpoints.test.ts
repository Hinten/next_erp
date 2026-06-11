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

  it('maps the SVC-RS UFs to svc-rs', () => {
    for (const uf of ['AM', 'BA', 'GO', 'MA', 'MS', 'MT', 'PE', 'PI', 'PR']) {
      expect(svcAuthorizerForUF(uf)).toBe('svc-rs');
    }
  });

  it('covers all 27 UFs with disjoint SVC sets', () => {
    const all = [
      'AC',
      'AL',
      'AM',
      'AP',
      'BA',
      'CE',
      'DF',
      'ES',
      'GO',
      'MA',
      'MG',
      'MS',
      'MT',
      'PA',
      'PB',
      'PE',
      'PI',
      'PR',
      'RJ',
      'RN',
      'RO',
      'RR',
      'RS',
      'SC',
      'SE',
      'SP',
      'TO',
    ];
    // Uniqueness too — a duplicate + an omission would keep the length at 27.
    expect(new Set(all).size).toBe(27);
    for (const uf of all) {
      expect(['svc-an', 'svc-rs']).toContain(svcAuthorizerForUF(uf));
    }
  });

  it("throws for a UF that isn't an emitter ('EX')", () => {
    expect(() => svcAuthorizerForUF('EX')).toThrow(NFeContingencyEndpointError);
  });
});

describe('getSvcEndpoints', () => {
  it('serves the official SVC-AN URL set per ambiente (sefazvirtual hosts)', () => {
    const prod = getSvcEndpoints('svc-an', 'producao');
    expect(prod.NfeAutorizacao).toBe(
      'https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
    );
    expect(prod.NfeStatusServico).toBe(
      'https://www.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
    );
    const hom = getSvcEndpoints('svc-an', 'homologacao');
    expect(hom.NfeRetAutorizacao).toBe(
      'https://hom.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
    );
    expect(hom.RecepcaoEvento).toBe(
      'https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
    );
  });

  it('has no Inutilizacao key — SVC does not offer inutilização', () => {
    const urls = getSvcEndpoints('svc-an', 'producao');
    expect('NfeInutilizacao' in urls).toBe(false);
  });

  it('serves the official SVC-RS (SVRS) URL set per ambiente', () => {
    const prod = getSvcEndpoints('svc-rs', 'producao');
    expect(prod.NfeAutorizacao).toBe(
      'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    );
    expect(prod.RecepcaoEvento).toBe(
      'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    );
    const hom = getSvcEndpoints('svc-rs', 'homologacao');
    expect(hom.NfeConsultaProtocolo).toBe(
      'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    );
    expect('NfeInutilizacao' in hom).toBe(false);
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
