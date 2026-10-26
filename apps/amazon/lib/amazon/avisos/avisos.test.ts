import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fimDoDiaNoFuso } from '@delfrance/core/datetime';
import { escreverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  FUSO_FISCAL,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_IMPORTACAO_PARADA_AMAZON,
  MOTIVO_PEDIDO_AMAZON,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, DIA_MS, caminhoAviso } from '../testing/fixtures';
import {
  MOTIVO_AVISO_AMAZON,
  SEVERIDADE_MOTIVO_PEDIDO_AMAZON,
  TIPOS_AVISO_AMAZON,
  TIPOS_AVISO_AMAZON_POR_CONTA,
  agoraUsDe,
  chavePedidoPrecisaAtencao,
  sincronizarAvisosDaContaAmazon,
  sincronizarAvisosDoPedidoAmazon,
  levantarImportacaoParadaAmazon,
  avisarReautorizacao,
  avisarReconexaoPendente,
  avisarSegredoLwaExpirando,
  avisarSegredoLwaRecusado,
  chaveContaPrecisaAtencao,
  chaveImportacaoParada,
  chaveReautorizacao,
  chaveReconexao,
  chaveSegredoExpirando,
  chaveSegredoRecusado,
  chavesContaPrecisaAtencao,
  prazoUsDe,
  relogioDoDocumentoUs,
  resolverAvisoDeContaRemovida,
  resolverImportacaoParadaAmazon,
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
        TIPO_AVISO.amazonImportacaoParada,
        TIPO_AVISO.amazonPedidoPrecisaAtencao,
        TIPO_AVISO.amazonContaPrecisaAtencao,
      ].sort(),
    );
    // The orphan pass's tipos: every PER-CONTA one, the import-stopped row
    // included (PR 4-b) and the order import's per-conta row (step 5) — and
    // never a per-app one, whose key names no conta.
    expect([...TIPOS_AVISO_AMAZON_POR_CONTA].sort()).toEqual(
      [
        TIPO_AVISO.amazonReconexaoPendente,
        TIPO_AVISO.amazonReautorizacaoExpirando,
        TIPO_AVISO.amazonImportacaoParada,
        TIPO_AVISO.amazonContaPrecisaAtencao,
      ].sort(),
    );
  });

  it('★ the per-PEDIDO tipo is never an orphan-pass tipo: its key names an order the pass cannot compute', () => {
    expect(TIPOS_AVISO_AMAZON.has(TIPO_AVISO.amazonPedidoPrecisaAtencao)).toBe(true);
    expect(TIPOS_AVISO_AMAZON_POR_CONTA.has(TIPO_AVISO.amazonPedidoPrecisaAtencao)).toBe(false);
  });

  it("per (conta, motivo) for the order import's conta tipo: one key per motivo, no entidade", () => {
    expect(chaveContaPrecisaAtencao(ID, MOTIVO_CONTA_AMAZON.contaSemOperacao)).toBe(
      `amazonContaPrecisaAtencao:${ID}::conta-sem-operacao`,
    );
    expect(chaveContaPrecisaAtencao(ID, MOTIVO_CONTA_AMAZON.intermediadorDivergente)).toBe(
      `amazonContaPrecisaAtencao:${ID}::intermediador-divergente`,
    );
    // Every motivo's key, read off the enum — and nothing else.
    expect([...chavesContaPrecisaAtencao(ID)].sort()).toEqual(
      motivoContaAmazonSchema.options.map((m) => chaveContaPrecisaAtencao(ID, m)).sort(),
    );
    expect(chavesContaPrecisaAtencao(ID)).toHaveLength(2);
    // NEAR-MISS: another conta's keys are other documents.
    expect(chavesContaPrecisaAtencao('conta-2')).not.toContain(
      chaveContaPrecisaAtencao(ID, MOTIVO_CONTA_AMAZON.contaSemOperacao),
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

  it('★ an import-stopped row is closed CLOCKED by the list readTime; a later run keeps its row (PR 4-b)', async () => {
    // A run whose lease committed at 200 µs raised it; the list was read at 100:
    // a conta created after the list was read keeps its open row…
    await levantarImportacaoParadaAmazon(
      asDb(db),
      {
        integracaoId: ID,
        lojaNome: 'X',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialAusente,
        commit: { seconds: 0, nanoseconds: 200_000 },
      },
      deps(),
    );
    expect(
      await resolverAvisoDeContaRemovida(asDb(db), chaveImportacaoParada(ID), 100, deps()),
    ).toBe(false);
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))?.resolvidoEm).toBeNull();
    // …while a raise OLDER than the read (a run before the deletion) IS closed.
    expect(
      await resolverAvisoDeContaRemovida(asDb(db), chaveImportacaoParada(ID), 300, deps()),
    ).toBe(true);
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      resolucaoMotivo: 'conta-removida',
      relogioEvento: 300,
    });
  });

  it('an import-stopped orphan with no row SEEDS a resolved one with the list clock and no name', async () => {
    expect(
      await resolverAvisoDeContaRemovida(asDb(db), chaveImportacaoParada(ID), 400, deps()),
    ).toBe(false);
    const doc = db.ler(caminhoAviso(chaveImportacaoParada(ID)));
    expect(doc).toMatchObject({
      tipo: TIPO_AVISO.amazonImportacaoParada,
      canal: CANAL_AVISO.amazon,
      urlInterna: { rota: `/canais/amazon/${ID}`, campo: null },
      relogioEvento: 400,
      resolucaoMotivo: 'conta-removida',
    });
    // The conta is gone: the seed names no store.
    expect((doc?.params as { loja?: unknown } | undefined)?.loja).toBeUndefined();
    // A raise from a poll run before the read cannot reopen it…
    const { resultado } = await levantarImportacaoParadaAmazon(
      asDb(db),
      {
        integracaoId: ID,
        lojaNome: 'X',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria,
        commit: { seconds: 0, nanoseconds: 399_000 },
      },
      deps(),
    );
    expect(resultado).toBe('ignorado');
  });

  it('the import-stopped orphan resolve ALWAYS hands resolverAviso the list clock; a key no producer computes, none', async () => {
    await resolverAvisoDeContaRemovida(asDb(db), chaveImportacaoParada(ID), 7, deps());
    // NEAR-MISS: the tipo prefix with an empty conta is no key `chaveImportacaoParada` makes.
    await resolverAvisoDeContaRemovida(
      asDb(db),
      `${TIPO_AVISO.amazonImportacaoParada}:`,
      7,
      deps(),
    );
    const [clocked, semConta] = h.resolverAviso.mock.calls;
    expect((clocked?.[4] as { relogioEvento?: unknown } | undefined)?.relogioEvento).toBe(7);
    expect(semConta?.[4]).toBeUndefined();
  });

  it('★ a conta-precisa-atenção row is closed CLOCKED by the list readTime; a later raise keeps its row (step 5)', async () => {
    const chave = chaveContaPrecisaAtencao(ID, MOTIVO_CONTA_AMAZON.contaSemOperacao);
    // The import's conta read at 200 µs raised it (the step-5 producer's shape);
    // the list was read at 100: a conta created after the list keeps its row…
    await escreverAviso(
      asDb(db),
      {
        tipo: TIPO_AVISO.amazonContaPrecisaAtencao,
        conta: ID,
        janela: MOTIVO_CONTA_AMAZON.contaSemOperacao,
        severidade: SEVERIDADE_AVISO.atencao,
        canal: CANAL_AVISO.amazon,
        params: { motivo: MOTIVO_CONTA_AMAZON.contaSemOperacao },
        motivo: MOTIVO_CONTA_AMAZON.contaSemOperacao,
        urlInterna: { rota: ROTAS_AVISO.canalAmazon.build(ID), campo: null },
        relogioEvento: 200,
      },
      { increment, agoraUs: agoraUsDe(deps()) },
    );
    expect(await resolverAvisoDeContaRemovida(asDb(db), chave, 100, deps())).toBe(false);
    expect(db.ler(caminhoAviso(chave))?.resolvidoEm).toBeNull();
    // …while a raise OLDER than the read IS closed, and the clock is stamped.
    expect(await resolverAvisoDeContaRemovida(asDb(db), chave, 300, deps())).toBe(true);
    expect(db.ler(caminhoAviso(chave))).toMatchObject({
      resolucaoMotivo: 'conta-removida',
      relogioEvento: 300,
    });
  });

  it('a conta-precisa-atenção orphan with no row SEEDS a resolved one naming its motivo', async () => {
    const chave = chaveContaPrecisaAtencao(ID, MOTIVO_CONTA_AMAZON.intermediadorDivergente);
    expect(await resolverAvisoDeContaRemovida(asDb(db), chave, 400, deps())).toBe(false);
    expect(db.ler(caminhoAviso(chave))).toMatchObject({
      tipo: TIPO_AVISO.amazonContaPrecisaAtencao,
      canal: CANAL_AVISO.amazon,
      severidade: SEVERIDADE_AVISO.atencao,
      motivo: MOTIVO_CONTA_AMAZON.intermediadorDivergente,
      params: { motivo: MOTIVO_CONTA_AMAZON.intermediadorDivergente },
      urlInterna: { rota: `/canais/amazon/${ID}`, campo: null },
      relogioEvento: 400,
      resolucaoMotivo: 'conta-removida',
    });
  });

  it('NEAR-MISS: a conta-tipo id no producer computes (unknown motivo, an entidade, no conta, a conta the key fold would rewrite) is resolved clockless', async () => {
    const naoComputadas = [
      `${TIPO_AVISO.amazonContaPrecisaAtencao}:${ID}::motivo-do-futuro`,
      chaveDeAviso({
        tipo: TIPO_AVISO.amazonContaPrecisaAtencao,
        conta: ID,
        entidade: '171-9876543-2109876',
        janela: MOTIVO_CONTA_AMAZON.contaSemOperacao,
      }),
      `${TIPO_AVISO.amazonContaPrecisaAtencao}:::${MOTIVO_CONTA_AMAZON.contaSemOperacao}`,
      // The split alone reads conta `a.b` here, but `chaveDeAviso` folds `.` to
      // `_`, so no producer could have written this id: only the key RECOMPUTE
      // sends it clockless (trusting the split would seed a resolve for `a.b`).
      `${TIPO_AVISO.amazonContaPrecisaAtencao}:a.b::${MOTIVO_CONTA_AMAZON.contaSemOperacao}`,
    ];
    await resolverAvisoDeContaRemovida(
      asDb(db),
      chaveContaPrecisaAtencao(ID, MOTIVO_CONTA_AMAZON.contaSemOperacao),
      9,
      deps(),
    );
    for (const chave of naoComputadas)
      await resolverAvisoDeContaRemovida(asDb(db), chave, 9, deps());
    const [clocked, ...semRelogio] = h.resolverAviso.mock.calls;
    expect((clocked?.[4] as { relogioEvento?: unknown } | undefined)?.relogioEvento).toBe(9);
    expect(semRelogio).toHaveLength(naoComputadas.length);
    for (const chamada of semRelogio) expect(chamada[4], String(chamada[1])).toBeUndefined();
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

describe('amazonImportacaoParada — clocked by the poll document commit time (step 4)', () => {
  /** A Firestore commit stamp: 10 s + 123 456 µs. */
  const COMMIT = { seconds: 10, nanoseconds: 123_456_000 };
  const COMMIT_US = 10_123_456;

  it('keys one row per conta', () => {
    expect(chaveImportacaoParada(ID)).toBe(`amazonImportacaoParada:${ID}`);
    expect(chaveImportacaoParada(ID)).not.toBe(chaveImportacaoParada('conta-2'));
  });

  it('raises critico, in-app, with exactly loja + motivo, clocked by the commit converted HERE', async () => {
    const { resultado } = await levantarImportacaoParadaAmazon(
      asDb(db),
      {
        integracaoId: ID,
        lojaNome: 'Conta Um',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.limiteDeTaxa,
        commit: COMMIT,
      },
      deps(),
    );
    expect(resultado).toBe('criado');
    const doc = db.ler(caminhoAviso(chaveImportacaoParada(ID)));
    expect(doc).toMatchObject({
      tipo: TIPO_AVISO.amazonImportacaoParada,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.amazon,
      params: { loja: 'Conta Um', motivo: 'limite-de-taxa' },
      urlInterna: { rota: `/canais/amazon/${ID}`, campo: null },
      relogioEvento: COMMIT_US,
      resolvidoEm: null,
    });
    expect(Object.keys((doc?.params ?? {}) as object).sort()).toEqual(['loja', 'motivo']);
  });

  it('a clean run resolves it CLOCKED; a late raise from an older run is then dropped', async () => {
    await levantarImportacaoParadaAmazon(
      asDb(db),
      {
        integracaoId: ID,
        lojaNome: 'X',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria,
        commit: COMMIT,
      },
      deps(),
    );
    const posterior = { seconds: 11, nanoseconds: 0 };
    expect(
      await resolverImportacaoParadaAmazon(asDb(db), ID, deps(), {
        commit: posterior,
        lojaNome: 'X',
      }),
    ).toBe(true);
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      resolucaoMotivo: 'importacao-retomada',
      relogioEvento: 11_000_000,
    });
    // A raise from the run before (an earlier lease) can no longer reopen it…
    const { resultado } = await levantarImportacaoParadaAmazon(
      asDb(db),
      {
        integracaoId: ID,
        lojaNome: 'X',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria,
        commit: COMMIT,
      },
      deps(),
    );
    expect(resultado).toBe('ignorado');
    // …while a LATER run's raise does (near-miss).
    const { resultado: reaberto } = await levantarImportacaoParadaAmazon(
      asDb(db),
      {
        integracaoId: ID,
        lojaNome: 'X',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria,
        commit: { seconds: 12, nanoseconds: 0 },
      },
      deps(),
    );
    expect(reaberto).not.toBe('ignorado');
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))?.resolvidoEm).toBeNull();
  });

  it('a resolve with no row SEEDS a resolved one carrying the clock (always clocked)', async () => {
    expect(
      await resolverImportacaoParadaAmazon(asDb(db), ID, deps(), {
        commit: COMMIT,
        lojaNome: 'Conta Um',
      }),
    ).toBe(false); // (step 4's tipo: always seeded — the step-5 producers below are not)
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      relogioEvento: COMMIT_US,
      resolucaoMotivo: 'importacao-retomada',
    });
    const chamada = h.resolverAviso.mock.calls.find(([, c]) => c === chaveImportacaoParada(ID));
    expect((chamada?.[4] as { relogioEvento?: unknown } | undefined)?.relogioEvento).toBe(
      COMMIT_US,
    );
  });
});

describe('step 5 (PR 5-d): the order import producers — clocked on the FIRESTORE timeline', () => {
  const ORDER = '171-9876543-2109876';
  const PEDIDO = 'a'.repeat(64);
  const pedido = { integracaoId: ID, orderId: ORDER, pedidoId: PEDIDO };
  const T1 = { seconds: 20, nanoseconds: 1_000 };
  const T2 = { seconds: 20, nanoseconds: 2_000 };
  type MotivoPedido = (typeof MOTIVO_PEDIDO_AMAZON)[keyof typeof MOTIVO_PEDIDO_AMAZON];
  const chave = (m: MotivoPedido) => caminhoAviso(chavePedidoPrecisaAtencao(ID, ORDER, m));

  it('keys one row per (conta, order, motivo)', () => {
    expect(chavePedidoPrecisaAtencao(ID, ORDER, MOTIVO_PEDIDO_AMAZON.divergenciaItens)).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.amazonPedidoPrecisaAtencao,
        conta: ID,
        entidade: ORDER,
        janela: 'divergencia-itens',
      }),
    );
    expect(chavePedidoPrecisaAtencao(ID, ORDER, MOTIVO_PEDIDO_AMAZON.divergenciaItens)).not.toBe(
      chavePedidoPrecisaAtencao(ID, ORDER, MOTIVO_PEDIDO_AMAZON.statusDesconhecido),
    );
  });

  it('every per-pedido motivo has its severity: four critico, four atencao', () => {
    const criticos = Object.entries(SEVERIDADE_MOTIVO_PEDIDO_AMAZON)
      .filter(([, s]) => s === SEVERIDADE_AVISO.critico)
      .map(([m]) => m)
      .sort();
    expect(criticos).toEqual([
      'aceitar-cancelamento',
      'cancelado-so-no-erp',
      'divergencia-itens',
      'logistica-desconhecida',
    ]);
    expect(Object.keys(SEVERIDADE_MOTIVO_PEDIDO_AMAZON)).toHaveLength(8);
  });

  it('★ raises with exactly pedido + motivo, the pedido route, in-app, the clock converted HERE', async () => {
    const r = await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [MOTIVO_PEDIDO_AMAZON.divergenciaItens, MOTIVO_PEDIDO_AMAZON.statusDesconhecido],
      resolver: [],
      relogio: T1,
    });
    expect(r).toEqual({ levantados: 2, resolvidos: 0 });
    const doc = db.ler(chave(MOTIVO_PEDIDO_AMAZON.divergenciaItens));
    expect(doc).toMatchObject({
      tipo: TIPO_AVISO.amazonPedidoPrecisaAtencao,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.amazon,
      params: { pedido: ORDER, motivo: 'divergencia-itens' },
      motivo: 'divergencia-itens',
      urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO), campo: null },
      relogioEvento: relogioDoDocumentoUs(T1),
      resolvidoEm: null,
    });
    expect(Object.keys((doc?.params ?? {}) as object).sort()).toEqual(['motivo', 'pedido']);
    expect(db.ler(chave(MOTIVO_PEDIDO_AMAZON.statusDesconhecido))?.severidade).toBe(
      SEVERIDADE_AVISO.atencao,
    );
  });

  it('★ a re-import at an EQUAL order clock that no longer derives the motivo resolves it (a newer Firestore clock)', async () => {
    await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado],
      resolver: [],
      relogio: T1,
    });
    const r = await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [],
      resolver: [MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado],
      relogio: T2,
    });
    expect(r).toEqual({ levantados: 0, resolvidos: 1 });
    expect(db.ler(chave(MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado))).toMatchObject({
      resolucaoMotivo: MOTIVO_AVISO_AMAZON.condicaoEncerrada,
      relogioEvento: relogioDoDocumentoUs(T2),
    });
    // A late raise of the OLDER observation can no longer reopen it.
    const tardio = await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado],
      resolver: [],
      relogio: T1,
    });
    expect(tardio.levantados).toBe(0);
    expect(db.ler(chave(MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado))?.resolvidoEm).not.toBeNull();
  });

  it('NEAR-MISS: a resolve at the SAME clock as the raise is stale (an equal clock is dropped)', async () => {
    await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [MOTIVO_PEDIDO_AMAZON.statusDesconhecido],
      resolver: [],
      relogio: T1,
    });
    const r = await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [],
      resolver: [MOTIVO_PEDIDO_AMAZON.statusDesconhecido],
      relogio: T1,
    });
    expect(r.resolvidos).toBe(0);
    expect(db.ler(chave(MOTIVO_PEDIDO_AMAZON.statusDesconhecido))?.resolvidoEm).toBeNull();
  });

  it('★ a resolve touches only a row that EXISTS: no seed for a motivo never raised (one getAll first)', async () => {
    const r = await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [],
      resolver: [MOTIVO_PEDIDO_AMAZON.divergenciaItens, MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp],
      relogio: T2,
    });
    expect(r).toEqual({ levantados: 0, resolvidos: 0 });
    expect(db.escritas).toEqual([]);
    expect(h.resolverAviso).not.toHaveBeenCalled();
    expect(db.leituras).toEqual([
      chave(MOTIVO_PEDIDO_AMAZON.divergenciaItens),
      chave(MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp),
    ]);
  });

  it('a RESOLVED row has its watermark advanced by a newer clock (the shared resolver rule), never reopened', async () => {
    await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [MOTIVO_PEDIDO_AMAZON.aceitarCancelamento],
      resolver: [],
      relogio: T1,
    });
    await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [],
      resolver: [MOTIVO_PEDIDO_AMAZON.aceitarCancelamento],
      relogio: T2,
    });
    const T3 = { seconds: 20, nanoseconds: 3_000 };
    await sincronizarAvisosDoPedidoAmazon(asDb(db), deps(), {
      ...pedido,
      levantar: [],
      resolver: [MOTIVO_PEDIDO_AMAZON.aceitarCancelamento],
      relogio: T3,
    });
    const doc = db.ler(chave(MOTIVO_PEDIDO_AMAZON.aceitarCancelamento));
    expect(doc?.relogioEvento).toBe(relogioDoDocumentoUs(T3));
    expect(doc?.resolvidoEm).not.toBeNull();
  });

  describe('per conta — clocked by the conta read', () => {
    type MotivoConta = (typeof MOTIVO_CONTA_AMAZON)[keyof typeof MOTIVO_CONTA_AMAZON];
    const contaChave = (m: MotivoConta) => caminhoAviso(chaveContaPrecisaAtencao(ID, m));

    it('raises atencao with exactly the motivo, on the conta route', async () => {
      await sincronizarAvisosDaContaAmazon(asDb(db), deps(), {
        integracaoId: ID,
        levantar: [MOTIVO_CONTA_AMAZON.contaSemOperacao],
        resolver: [],
        relogio: T1,
      });
      expect(db.ler(contaChave(MOTIVO_CONTA_AMAZON.contaSemOperacao))).toMatchObject({
        tipo: TIPO_AVISO.amazonContaPrecisaAtencao,
        severidade: SEVERIDADE_AVISO.atencao,
        params: { motivo: 'conta-sem-operacao' },
        urlInterna: { rota: `/canais/amazon/${ID}`, campo: null },
        relogioEvento: relogioDoDocumentoUs(T1),
      });
    });

    it('★ an import whose conta read PREDATES the operator fix cannot reopen the row a later import resolved', async () => {
      await sincronizarAvisosDaContaAmazon(asDb(db), deps(), {
        integracaoId: ID,
        levantar: [MOTIVO_CONTA_AMAZON.contaSemOperacao],
        resolver: [],
        relogio: T1,
      });
      // A later import read the conta after the fix.
      await sincronizarAvisosDaContaAmazon(asDb(db), deps(), {
        integracaoId: ID,
        levantar: [],
        resolver: [MOTIVO_CONTA_AMAZON.contaSemOperacao],
        relogio: { seconds: 30, nanoseconds: 0 },
      });
      // The slower import read it BEFORE the fix (an older read time).
      const r = await sincronizarAvisosDaContaAmazon(asDb(db), deps(), {
        integracaoId: ID,
        levantar: [MOTIVO_CONTA_AMAZON.contaSemOperacao],
        resolver: [],
        relogio: { seconds: 25, nanoseconds: 0 },
      });
      expect(r.levantados).toBe(0);
      expect(db.ler(contaChave(MOTIVO_CONTA_AMAZON.contaSemOperacao))?.resolvidoEm).not.toBeNull();
    });
  });
});
