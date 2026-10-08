/**
 * The µs boundary module, through the REAL `escreverAviso` / `resolverAviso`
 * against the fake.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chaveDeAviso, TIPO_AVISO } from '@delfrance/schemas';

import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, DIA_MS, caminhoAviso } from '../testing/fixtures';
import {
  MOTIVO_AVISO_LI,
  agoraUsDe,
  avisarExpiracaoToken,
  avisarReconexaoPendente,
  chaveExpiracao,
  chaveReconexao,
  prazoUsDe,
  relogioDoDocumentoUs,
  resolverAvisoDeContaRemovida,
  resolverExpiracaoToken,
  resolverReconexaoPendente,
  sincronizarAvisoDeExpiracao,
} from './avisos';

const ID = 'conta-li-1';
const deps = { increment, nowMs: AGORA_MS };
/** 23:59:59 São Paulo, 20 days after AGORA_MS's civil day (2027-01-15). */
const EXPIRA_20_DIAS = Date.UTC(2027, 1, 5, 2, 59, 59);

describe('the conversions', () => {
  it('relogioDoDocumentoUs pins the vector', () => {
    expect(relogioDoDocumentoUs({ seconds: 1_800_000_000, nanoseconds: 123_456_789 })).toBe(
      1_800_000_000_123_456,
    );
    expect(Number.isSafeInteger(1_800_000_000_123_456)).toBe(true);
  });

  it('agoraUsDe and prazoUsDe are ms × 1000, against fixed values', () => {
    expect(agoraUsDe({ nowMs: 1_790_000_000_123 })).toBe(1_790_000_000_123_000);
    expect(prazoUsDe(1_790_000_000_999)).toBe(1_790_000_000_999_000);
    expect(prazoUsDe(0)).toBe(0);
  });
});

describe('the keys', () => {
  it('producer key = resolver key, with no janela and no entidade', () => {
    expect(chaveExpiracao(ID)).toBe(
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaTokenExpirando, conta: ID }),
    );
    expect(chaveReconexao(ID)).toBe(
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente, conta: ID }),
    );
  });

  it('near-miss: two contas → two keys; two tipos → two keys', () => {
    expect(chaveExpiracao(ID)).not.toBe(chaveExpiracao('conta-li-2'));
    expect(chaveExpiracao(ID)).not.toBe(chaveReconexao(ID));
  });

  it('a raise is closed by the resolver of the SAME key', async () => {
    const db = new FakeDb();
    const { chave } = await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: EXPIRA_20_DIAS },
      deps,
    );
    expect(chave).toBe(chaveExpiracao(ID));
    expect(await resolverExpiracaoToken(asDb(db), ID, MOTIVO_AVISO_LI.tokenValidado, deps)).toBe(
      true,
    );
    expect(db.ler(caminhoAviso(chave))?.resolucaoMotivo).toBe('token-validado');
  });
});

describe('the expiry aviso', () => {
  it('stores exactly loja, dias (a number) and expiraEm (the São Paulo civil date), prazo in µs, no clock', async () => {
    const db = new FakeDb();
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja Teste', tokenExpiraEmMs: EXPIRA_20_DIAS },
      deps,
    );
    const row = db.ler(caminhoAviso(chaveExpiracao(ID)));
    expect(row).toMatchObject({
      tipo: 'lojaIntegradaTokenExpirando',
      severidade: 'atencao',
      canal: 'lojaIntegrada',
      // 23:59:59 SP on 2027-02-04 — the UTC instant is already the 5th.
      params: { loja: 'Loja Teste', dias: 20, expiraEm: '2027-02-04' },
      prazo: EXPIRA_20_DIAS * 1000,
      relogioEvento: null,
      criadoEm: AGORA_MS * 1000,
      urlInterna: { rota: `/canais/loja-integrada/${ID}`, campo: null },
    });
  });

  it('a repeat refreshes dias without moving criadoEm', async () => {
    const db = new FakeDb();
    const evento = { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: EXPIRA_20_DIAS };
    await avisarExpiracaoToken(asDb(db), evento, deps);
    const r = await avisarExpiracaoToken(asDb(db), evento, {
      increment,
      nowMs: AGORA_MS + 2 * DIA_MS,
    });
    expect(r.resultado).toBe('repetido');
    const row = db.ler(caminhoAviso(chaveExpiracao(ID)));
    expect(row?.params).toMatchObject({ dias: 18 });
    expect(row?.criadoEm).toBe(AGORA_MS * 1000);
    expect(row?.ocorrencias).toBe(2);
  });

  it('sincronizarAvisoDeExpiracao: 30 days raises, 31 resolves (the threshold is <=)', async () => {
    const db = new FakeDb();
    const em = (dias: number) => AGORA_MS + dias * DIA_MS + 1000;
    const s30 = await sincronizarAvisoDeExpiracao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: em(30) },
      MOTIVO_AVISO_LI.tokenValidado,
      deps,
    );
    expect(s30).toMatchObject({ acao: 'avisado', dias: 30, resultado: 'criado' });
    const s31 = await sincronizarAvisoDeExpiracao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: em(31) },
      MOTIVO_AVISO_LI.tokenValidado,
      deps,
    );
    expect(s31).toEqual({ acao: 'resolvido', dias: 31, fechou: true });
  });
});

describe('the reconexão aviso clock (commit time, µs)', () => {
  const alvo = { integracaoId: ID, lojaNome: 'Loja' };

  it('after a clocked resolve, a late raise with an OLDER document clock stays resolved', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(asDb(db), { ...alvo, status: 401, relogioUs: 1_000 }, deps);
    await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_LI.tokenValidado, deps, {
      relogioUs: 3_000,
      lojaNome: 'Loja',
    });
    const r = await avisarReconexaoPendente(
      asDb(db),
      { ...alvo, status: 401, relogioUs: 2_000 },
      deps,
    );
    expect(r.resultado).toBe('ignorado');
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))?.resolvidoEm).not.toBeNull();
  });

  it('near-miss: a NEWER raise reopens', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(asDb(db), { ...alvo, status: 401, relogioUs: 1_000 }, deps);
    await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_LI.tokenValidado, deps, {
      relogioUs: 3_000,
      lojaNome: 'Loja',
    });
    const r = await avisarReconexaoPendente(
      asDb(db),
      { ...alvo, status: 403, relogioUs: 4_000 },
      deps,
    );
    expect(r.resultado).toBe('reaberto');
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolvidoEm: null,
      relogioEvento: 4_000,
      params: { loja: 'Loja', status: 403 },
    });
  });

  it('a clocked resolve with NO row seeds a resolved one, so an older raise arriving later is dropped', async () => {
    const db = new FakeDb();
    expect(
      await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_LI.tokenValidado, deps, {
        relogioUs: 5_000,
        lojaNome: 'Loja',
      }),
    ).toBe(false);
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      tipo: 'lojaIntegradaReconexaoPendente',
      severidade: 'critico',
      canal: 'lojaIntegrada',
      relogioEvento: 5_000,
    });
    const r = await avisarReconexaoPendente(
      asDb(db),
      { ...alvo, status: 401, relogioUs: 4_999 },
      deps,
    );
    expect(r.resultado).toBe('ignorado');
  });

  it('a clockless resolve of an absent row writes nothing', async () => {
    const db = new FakeDb();
    expect(
      await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_LI.credencialRemovida, deps),
    ).toBe(false);
    expect(db.escritas).toEqual([]);
  });

  it('resolverAvisoDeContaRemovida closes a row by its id, as conta-removida', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(asDb(db), { ...alvo, status: 401, relogioUs: 1 }, deps);
    expect(await resolverAvisoDeContaRemovida(asDb(db), chaveReconexao(ID), deps)).toBe(true);
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))?.resolucaoMotivo).toBe('conta-removida');
  });
});

/* -------------------------------------------------------------------------- */
/*            The µs promise, counted as raw source text                       */
/* -------------------------------------------------------------------------- */

const RAIZ_LIB = fileURLToPath(new URL('..', import.meta.url));

/** Every non-test `.ts` under `lib/lojaIntegrada`, outside `testing/`. */
function fontes(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'testing') saida.push(...fontes(caminho));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      saida.push(caminho);
    }
  }
  return saida;
}

function contar(texto: string, agulha: string): number {
  return texto.split(agulha).length - 1;
}

describe('⚠️ the µs boundary: exactly two ms → µs calls and one Timestamp → µs read', () => {
  const arquivos = fontes(RAIZ_LIB);
  const avisos = fileURLToPath(new URL('./avisos.ts', import.meta.url));

  it('the scan found the lib', () => {
    expect(arquivos.length).toBeGreaterThan(5);
    expect(arquivos).toContain(avisos);
  });

  it('this module calls the ms → µs converter exactly twice (agoraUsDe, prazoUsDe)', () => {
    expect(contar(readFileSync(avisos, 'utf8'), 'millisToMicros(')).toBe(2);
  });

  it('no other module converts: no ms → µs call, no nanosecond read, no toMillis, no coercion', () => {
    for (const arquivo of arquivos) {
      const texto = readFileSync(arquivo, 'utf8');
      const ehAvisos = arquivo === avisos;
      expect(contar(texto, 'millisToMicros('), arquivo).toBe(ehAvisos ? 2 : 0);
      expect(contar(texto, '.nanoseconds'), arquivo).toBe(ehAvisos ? 1 : 0);
      expect(contar(texto, 'toMillis('), arquivo).toBe(0);
      expect(contar(texto, 'coerceToMicros'), arquivo).toBe(0);
    }
  });
});
