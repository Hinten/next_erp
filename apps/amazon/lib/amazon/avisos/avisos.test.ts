import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fimDoDiaNoFuso } from '@delfrance/core/datetime';
import { CANAL_AVISO, FUSO_FISCAL, SEVERIDADE_AVISO, TIPO_AVISO } from '@delfrance/schemas';

import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, DIA_MS, caminhoAviso } from '../testing/fixtures';
import {
  MOTIVO_AVISO_AMAZON,
  TIPOS_AVISO_AMAZON,
  TIPOS_AVISO_AMAZON_POR_CONTA,
  agoraUsDe,
  avisarReautorizacao,
  avisarReconexaoPendente,
  avisarSegredoLwaExpirando,
  avisarSegredoLwaRecusado,
  chaveReautorizacao,
  chaveReconexao,
  chaveSegredoExpirando,
  chaveSegredoRecusado,
  prazoUsDe,
  relogioDoDocumentoUs,
  resolverAvisoDeContaRemovida,
  resolverReautorizacao,
  resolverReconexaoPendente,
  resolverSegredoLwaExpirando,
  resolverSegredoLwaRecusado,
  sincronizarAvisoDeReautorizacao,
} from './avisos';

const h = vi.hoisted(() => ({ resolverAviso: vi.fn() }));

// The REAL writer and resolver run (against the fake); the resolver is wrapped
// only so a test can read the options each call received.
vi.mock('@delfrance/data/admin/avisos', async (original) => {
  const real = await original<typeof import('@delfrance/data/admin/avisos')>();
  h.resolverAviso.mockImplementation(real.resolverAviso);
  return { ...real, resolverAviso: h.resolverAviso };
});

const ID = 'conta-1';
let db: FakeDb;
const deps = () => ({ increment, nowMs: AGORA_MS });

beforeEach(() => {
  db = new FakeDb();
  h.resolverAviso.mockClear();
});

/* -------------------------------------------------------------------------- */

const RAIZ_LIB = fileURLToPath(new URL('..', import.meta.url));

function fontes(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) saida.push(...fontes(caminho));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) saida.push(caminho);
  }
  return saida;
}

const contar = (texto: string, agulha: string) => texto.split(agulha).length - 1;

describe('the µs boundary — exactly three conversion sites, all here', () => {
  it('avisos.ts holds two ms → µs calls and one Timestamp read, and nothing else in lib/amazon does', () => {
    const arquivos = fontes(RAIZ_LIB)
      .map((p) => relative(RAIZ_LIB, p).split(sep).join('/'))
      // The test double models Firestore's stamps; it is not app code.
      .filter((p) => !p.startsWith('testing/'));
    expect(arquivos).toContain('avisos/avisos.ts');
    for (const arquivo of arquivos) {
      const texto = readFileSync(join(RAIZ_LIB, arquivo), 'utf8');
      const esperado = arquivo === 'avisos/avisos.ts';
      expect(contar(texto, 'millisToMicros('), arquivo).toBe(esperado ? 2 : 0);
      expect(contar(texto, 'ts.nanoseconds'), arquivo).toBe(esperado ? 1 : 0);
      expect(contar(texto, 'microsToMillis('), arquivo).toBe(0);
      expect(contar(texto, '.nanoseconds'), arquivo).toBe(esperado ? 1 : 0);
    }
  });

  it('each converts as named', () => {
    expect(agoraUsDe({ nowMs: AGORA_MS })).toBe(AGORA_MS * 1000);
    expect(prazoUsDe(AGORA_MS)).toBe(AGORA_MS * 1000);
    expect(relogioDoDocumentoUs({ seconds: 10, nanoseconds: 123_456_000 })).toBe(10_123_456);
    // µs, never ms: two commits in one millisecond stay distinct.
    expect(relogioDoDocumentoUs({ seconds: 10, nanoseconds: 1_000 })).not.toBe(
      relogioDoDocumentoUs({ seconds: 10, nanoseconds: 2_000 }),
    );
  });
});

describe('the keys', () => {
  it('per conta for the two conta tipos, per app (no conta) for the two secret tipos', () => {
    expect(chaveReconexao(ID)).toBe(`amazonReconexaoPendente:${ID}`);
    expect(chaveReautorizacao(ID)).toBe(`amazonReautorizacaoExpirando:${ID}`);
    expect(chaveSegredoExpirando()).toBe('amazonSegredoLwaExpirando');
    expect(chaveSegredoRecusado()).toBe('amazonSegredoLwaRecusado');
  });

  it('the tipo sets are what the sweep filters on', () => {
    expect([...TIPOS_AVISO_AMAZON].sort()).toEqual(
      [
        TIPO_AVISO.amazonReconexaoPendente,
        TIPO_AVISO.amazonReautorizacaoExpirando,
        TIPO_AVISO.amazonSegredoLwaExpirando,
        TIPO_AVISO.amazonSegredoLwaRecusado,
      ].sort(),
    );
    expect([...TIPOS_AVISO_AMAZON_POR_CONTA].sort()).toEqual(
      [TIPO_AVISO.amazonReconexaoPendente, TIPO_AVISO.amazonReautorizacaoExpirando].sort(),
    );
  });
});

describe('amazonReconexaoPendente — clocked by the credential commit time', () => {
  const evento = {
    integracaoId: ID,
    lojaNome: 'Conta Um',
    status: 400,
    codigoLwa: 'invalid_grant',
    relogioUs: 5_000,
  };

  it('raises critico, in-app, with exactly loja + status, motivo = the LWA code', async () => {
    const { resultado } = await avisarReconexaoPendente(asDb(db), evento, deps());
    expect(resultado).toBe('criado');
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      tipo: TIPO_AVISO.amazonReconexaoPendente,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.amazon,
      params: { loja: 'Conta Um', status: 400 },
      motivo: 'invalid_grant',
      urlInterna: { rota: `/canais/amazon/${ID}`, campo: null },
      relogioEvento: 5_000,
    });
  });

  it('drops a raise whose clock is not newer (a late park after a consent)', async () => {
    await avisarReconexaoPendente(asDb(db), evento, deps());
    await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_AMAZON.consentimento, deps(), {
      relogioUs: 6_000,
      lojaNome: 'Conta Um',
    });
    const { resultado } = await avisarReconexaoPendente(asDb(db), evento, deps());
    expect(resultado).toBe('ignorado');
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))?.resolvidoEm).not.toBeNull();
  });

  it('a clocked resolve with no row SEEDS a resolved one carrying the clock', async () => {
    const fechou = await resolverReconexaoPendente(
      asDb(db),
      ID,
      MOTIVO_AVISO_AMAZON.credencialAusente,
      deps(),
      { relogioUs: 9_000, lojaNome: 'Conta Um' },
    );
    expect(fechou).toBe(false);
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      relogioEvento: 9_000,
      resolucaoMotivo: 'credencial-ausente',
    });
  });

  it('the reconexão resolver ALWAYS hands resolverAviso a clock', async () => {
    await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_AMAZON.consentimento, deps(), {
      relogioUs: 1,
      lojaNome: null,
    });
    await resolverAvisoDeContaRemovida(asDb(db), chaveReconexao(ID), 2, deps());
    const reconexao = h.resolverAviso.mock.calls.filter(
      ([, chave]) => chave === chaveReconexao(ID),
    );
    expect(reconexao).toHaveLength(2);
    for (const chamada of reconexao) {
      expect(typeof (chamada[4] as { relogioEvento?: unknown } | undefined)?.relogioEvento).toBe(
        'number',
      );
    }
  });
});

describe('amazonReautorizacaoExpirando — clockless, no janela', () => {
  /** Authorized 340 civil days before AGORA (São Paulo noon): 25 days left. */
  const autorizadoEmMs = AGORA_MS - 340 * DIA_MS;

  it('raises atencao with loja, dias and expiraEm; prazo = end of that São Paulo day, in µs', async () => {
    await avisarReautorizacao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Conta Um', autorizadoEmMs },
      deps(),
    );
    const doc = db.ler(caminhoAviso(chaveReautorizacao(ID)));
    expect(doc).toMatchObject({
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.amazon,
      params: { loja: 'Conta Um', dias: 25, expiraEm: '2027-02-09' },
      relogioEvento: null,
    });
    expect(doc?.prazo).toBe((fimDoDiaNoFuso('2027-02-09', FUSO_FISCAL) ?? 0) * 1000);
  });

  it('a reconnect (new date) refreshes the SAME row — never a second one', async () => {
    await avisarReautorizacao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Conta Um', autorizadoEmMs },
      deps(),
    );
    const { resultado } = await avisarReautorizacao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Conta Um', autorizadoEmMs: autorizadoEmMs + DIA_MS },
      deps(),
    );
    expect(resultado).toBe('repetido');
    expect(db.ler(caminhoAviso(chaveReautorizacao(ID)))?.params).toMatchObject({ dias: 26 });
    expect(db.caminhos().filter((p) => p.startsWith('avisos/'))).toHaveLength(1);
  });

  it('the resolve is clockless (no seed when absent)', async () => {
    expect(
      await resolverReautorizacao(asDb(db), ID, MOTIVO_AVISO_AMAZON.consentimento, deps()),
    ).toBe(false);
    expect(db.ler(caminhoAviso(chaveReautorizacao(ID)))).toBeUndefined();
  });

  it.each([
    [29, 'avisado'],
    [30, 'avisado'],
    [31, 'resolvido'],
    [0, 'avisado'],
    [-1, 'avisado'],
  ] as const)('%i civil days left → %s', async (dias, acao) => {
    const autorizado = AGORA_MS - (365 - dias) * DIA_MS;
    const r = await sincronizarAvisoDeReautorizacao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Conta Um', autorizadoEmMs: autorizado },
      MOTIVO_AVISO_AMAZON.autorizacaoEmDia,
      deps(),
    );
    expect(r).toMatchObject({ acao, dias });
  });
});

describe('amazonSegredoLwaExpirando — per app, clockless', () => {
  it('raises with dias + expiraEm and the date as prazo; the list route', async () => {
    await avisarSegredoLwaExpirando(asDb(db), { dataCivil: '2027-02-14' }, deps());
    const doc = db.ler(caminhoAviso(chaveSegredoExpirando()));
    expect(doc).toMatchObject({
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.amazon,
      params: { dias: 30, expiraEm: '2027-02-14' },
      urlInterna: { rota: '/canais/amazon', campo: null },
      prazo: (fimDoDiaNoFuso('2027-02-14', FUSO_FISCAL) ?? 0) * 1000,
    });
  });

  it('an unknown date: BOTH params absent and prazo null — and it replaces a dated pair', async () => {
    await avisarSegredoLwaExpirando(asDb(db), { dataCivil: '2027-02-14' }, deps());
    await avisarSegredoLwaExpirando(asDb(db), { dataCivil: null }, deps());
    const doc = db.ler(caminhoAviso(chaveSegredoExpirando()));
    expect(doc?.params).toEqual({});
    expect(doc?.prazo).toBeNull();
  });

  it('resolves clockless', async () => {
    await avisarSegredoLwaExpirando(asDb(db), { dataCivil: null }, deps());
    expect(
      await resolverSegredoLwaExpirando(asDb(db), MOTIVO_AVISO_AMAZON.segredoEmDia, deps()),
    ).toBe(true);
  });
});

describe('amazonSegredoLwaRecusado — per app, clockless, never a park', () => {
  it('raises critico on the list route, motivo = the LWA code, no params', async () => {
    await avisarSegredoLwaRecusado(asDb(db), { codigoLwa: 'invalid_client' }, deps());
    expect(db.ler(caminhoAviso(chaveSegredoRecusado()))).toMatchObject({
      severidade: SEVERIDADE_AVISO.critico,
      params: {},
      motivo: 'invalid_client',
      urlInterna: { rota: '/canais/amazon', campo: null },
      relogioEvento: null,
    });
  });

  it('any accepted exchange resolves it', async () => {
    await avisarSegredoLwaRecusado(asDb(db), { codigoLwa: 'invalid_client' }, deps());
    expect(await resolverSegredoLwaRecusado(asDb(db), deps())).toBe(true);
    expect(db.ler(caminhoAviso(chaveSegredoRecusado()))?.resolucaoMotivo).toBe('troca-aceita');
  });
});

describe('resolverAvisoDeContaRemovida', () => {
  it('a reconexão row is closed CLOCKED by the list readTime; a later park keeps its row', async () => {
    // The list was read at 100; a park on a conta it could not see raised at 200.
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: ID, lojaNome: 'X', status: 400, codigoLwa: null, relogioUs: 200 },
      deps(),
    );
    expect(await resolverAvisoDeContaRemovida(asDb(db), chaveReconexao(ID), 100, deps())).toBe(
      false,
    );
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))?.resolvidoEm).toBeNull();
    // An older park IS closed.
    expect(await resolverAvisoDeContaRemovida(asDb(db), chaveReconexao(ID), 300, deps())).toBe(
      true,
    );
  });

  it('a reauthorization row is closed clockless', async () => {
    await avisarReautorizacao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'X', autorizadoEmMs: AGORA_MS - 340 * DIA_MS },
      deps(),
    );
    expect(await resolverAvisoDeContaRemovida(asDb(db), chaveReautorizacao(ID), 1, deps())).toBe(
      true,
    );
    expect(db.ler(caminhoAviso(chaveReautorizacao(ID)))?.resolucaoMotivo).toBe('conta-removida');
  });
});
