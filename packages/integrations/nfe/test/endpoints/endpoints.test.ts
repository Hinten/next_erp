import { describe, expect, it } from 'vitest';

import {
  NFeContingencyEndpointError,
  NFeEndpointError,
  getAnEndpoints,
  getConsultaCadastroEndpoint,
  getEndpoints,
  getSvcEndpoints,
  supportedUFs,
  svcAuthorizerForUF,
} from '../../src/endpoints';

const ALL_UFS = [
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

// The 10 UFs with their own dedicated authorizer host (not SVRS/SVAN).
const OWN_HOST_UFS = ['AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP'];

describe('getEndpoints (home SEFAZ)', () => {
  it('resolves SP for both ambientes', () => {
    expect(getEndpoints('SP', 'producao').NfeAutorizacao).toContain('nfe.fazenda.sp.gov.br');
    expect(getEndpoints('SP', 'homologacao').NfeAutorizacao).toContain(
      'homologacao.nfe.fazenda.sp.gov.br',
    );
  });

  it('throws NFeEndpointError for a non-emitter UF', () => {
    expect(() => getEndpoints('EX', 'producao')).toThrow(NFeEndpointError);
  });

  it('covers all 27 UFs with a concrete authorizer + endpoint set, both ambientes', () => {
    expect(new Set(ALL_UFS).size).toBe(27);
    for (const uf of ALL_UFS) {
      for (const ambiente of ['producao', 'homologacao'] as const) {
        const urls = getEndpoints(uf, ambiente);
        expect(urls.NfeAutorizacao).toMatch(/^https:\/\//);
        expect(urls.NfeRetAutorizacao).toMatch(/^https:\/\//);
        expect(urls.NfeConsultaProtocolo).toMatch(/^https:\/\//);
        expect(urls.NfeStatusServico).toMatch(/^https:\/\//);
        expect(urls.NfeInutilizacao).toMatch(/^https:\/\//);
        expect(urls.RecepcaoEvento).toMatch(/^https:\/\//);
      }
    }
  });

  it('resolves lowercase UFs too', () => {
    expect(getEndpoints('rs', 'producao').NfeAutorizacao).toContain('nfe.sefazrs.rs.gov.br');
  });

  it('each own-host UF resolves to its dedicated host, not SVRS/SVAN', () => {
    for (const uf of OWN_HOST_UFS) {
      const prod = getEndpoints(uf, 'producao').NfeAutorizacao;
      expect(prod).not.toContain('svrs.rs.gov.br');
      expect(prod).not.toContain('sefazvirtual.fazenda.gov.br');
    }
  });

  it('does NOT port the legacy GO→MG copy-paste bug — GO and MG resolve to different hosts', () => {
    expect(getEndpoints('GO', 'producao').NfeAutorizacao).toContain('sefaz.go.gov.br');
    expect(getEndpoints('MG', 'producao').NfeAutorizacao).toContain('fazenda.mg.gov.br');
  });

  it('the 16 SVRS-delegated UFs share the SVRS host, distinct from RS itself', () => {
    const svrsUfs = [
      'AC',
      'AL',
      'AP',
      'CE',
      'DF',
      'ES',
      'PA',
      'PB',
      'PI',
      'RJ',
      'RN',
      'RO',
      'RR',
      'SC',
      'SE',
      'TO',
    ];
    for (const uf of svrsUfs) {
      expect(getEndpoints(uf, 'producao').NfeAutorizacao).toBe(
        'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      );
    }
    // RS runs its own host — not the same URL as the UFs it authorizes for.
    expect(getEndpoints('RS', 'producao').NfeAutorizacao).not.toBe(
      'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    );
  });

  it('MA delegates to SVAN (sefazvirtual.fazenda.gov.br), not SVRS', () => {
    expect(getEndpoints('MA', 'producao').NfeAutorizacao).toBe(
      'https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
    );
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

describe('getConsultaCadastroEndpoint', () => {
  it('resolves SP at the cadconsultacadastro4.asmx path for both ambientes', () => {
    expect(getConsultaCadastroEndpoint('SP', 'producao')).toBe(
      'https://nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx',
    );
    expect(getConsultaCadastroEndpoint('sp', 'homologacao')).toBe(
      'https://homologacao.nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx',
    );
  });

  it('resolves MG now that it is wired', () => {
    expect(getConsultaCadastroEndpoint('MG', 'producao')).toBe(
      'https://nfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4',
    );
  });

  it('returns null (never throws) for a non-emitter UF', () => {
    expect(getConsultaCadastroEndpoint('EX', 'homologacao')).toBeNull();
  });

  it('returns null for AM and MA — neither offers Consulta Cadastro', () => {
    expect(getConsultaCadastroEndpoint('AM', 'producao')).toBeNull();
    expect(getConsultaCadastroEndpoint('MA', 'producao')).toBeNull();
  });

  it('resolves the SVRS-delegated UFs at the shared cad.svrs.rs.gov.br host', () => {
    expect(getConsultaCadastroEndpoint('AC', 'producao')).toBe(
      'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
    );
  });
});

describe('supportedUFs', () => {
  it('lists all 27 UFs, no duplicates', () => {
    const ufs = supportedUFs();
    expect(new Set(ufs).size).toBe(27);
    expect(ufs).toHaveLength(27);
    for (const uf of ALL_UFS) expect(ufs).toContain(uf);
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
