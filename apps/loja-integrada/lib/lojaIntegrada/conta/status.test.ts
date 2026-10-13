import { describe, expect, it } from 'vitest';
import { statusContaLojaIntegradaSchema } from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import { fingerprintDoToken, refDaCredencial } from '../core/credencial';
import { LiContaNaoEncontradaError, LiCredencialInvalidaError } from '../core/erros';
import { FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS, DIA_MS, TOKEN_A, seedConta, seedCredencial } from '../testing/fixtures';
import { lerStatusDaConta, statusDaCredencial, statusNaoConfigurado } from './status';

const ID = 'conta-li-1';
/** 23:59:59 São Paulo on 2027-03-01 (AGORA_MS is noon, 2027-01-15). */
const EXPIRA_MS = Date.UTC(2027, 2, 2, 2, 59, 59);
const REF_PARADA = refDaCredencial({ personalToken: TOKEN_A, tokenAtualizadoEmMs: AGORA_MS });

describe('statusNaoConfigurado', () => {
  it('is the all-null shape, and parses', () => {
    const s = statusNaoConfigurado();
    expect(s).toEqual({
      configurado: false,
      expiraEm: null,
      diasParaExpirar: null,
      situacaoValidade: null,
      atualizadoEmMs: null,
      versaoCredencialUs: null,
      reconexaoPendente: null,
    });
    expect(statusContaLojaIntegradaSchema.parse(s)).toEqual(s);
  });
});

describe('statusDaCredencial', () => {
  it('projects the civil date, the day count, the situação and the version', () => {
    const s = statusDaCredencial(
      {
        tokenExpiraEmMs: EXPIRA_MS,
        tokenAtualizadoEmMs: AGORA_MS - DIA_MS,
        reconexaoPendente: null,
      },
      1_800_000_000_000_042,
      AGORA_MS,
    );
    expect(s).toEqual({
      configurado: true,
      expiraEm: '2027-03-01',
      diasParaExpirar: 45,
      situacaoValidade: 'ok',
      atualizadoEmMs: AGORA_MS - DIA_MS,
      versaoCredencialUs: 1_800_000_000_000_042,
      reconexaoPendente: null,
    });
    expect(statusContaLojaIntegradaSchema.parse(s)).toEqual(s);
  });

  it('a parked credential shows desdeMs and status — and NEVER its ref', () => {
    const s = statusDaCredencial(
      {
        tokenExpiraEmMs: EXPIRA_MS,
        tokenAtualizadoEmMs: AGORA_MS,
        reconexaoPendente: { desdeMs: AGORA_MS, status: 403, refCredencial: REF_PARADA },
      },
      1,
      AGORA_MS,
    );
    expect(s.reconexaoPendente).toEqual({ desdeMs: AGORA_MS, status: 403 });
    expect(JSON.stringify(s)).not.toContain(REF_PARADA);
  });

  it('the threshold reads as the aviso reads it: 30 days is expirando, 31 is ok', () => {
    const fimDoDia = Date.UTC(2027, 0, 16, 2, 59, 59);
    const em = (dias: number) =>
      statusDaCredencial(
        {
          tokenExpiraEmMs: fimDoDia + dias * DIA_MS,
          tokenAtualizadoEmMs: 1,
          reconexaoPendente: null,
        },
        1,
        AGORA_MS,
      );
    expect(em(30).situacaoValidade).toBe('expirando');
    expect(em(31).situacaoValidade).toBe('ok');
    expect(em(0)).toMatchObject({ diasParaExpirar: 0, situacaoValidade: 'expirando' });
    expect(em(-1)).toMatchObject({ diasParaExpirar: -1, situacaoValidade: 'vencido' });
  });
});

describe('lerStatusDaConta', () => {
  it('a conta that does not exist, or is not a Loja Integrada conta, is not found', async () => {
    const db = new FakeDb();
    await expect(lerStatusDaConta(asDb(db), ID, AGORA_MS)).rejects.toBeInstanceOf(
      LiContaNaoEncontradaError,
    );
    seedConta(db, ID, { tipo: 5 });
    seedCredencial(db, ID);
    await expect(lerStatusDaConta(asDb(db), ID, AGORA_MS)).rejects.toBeInstanceOf(
      LiContaNaoEncontradaError,
    );
  });

  it('no credential → não configurado', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    expect(await lerStatusDaConta(asDb(db), ID, AGORA_MS)).toEqual(statusNaoConfigurado());
  });

  it('an INACTIVE conta still answers: the panel is where it gets fixed', async () => {
    const db = new FakeDb();
    seedConta(db, ID, { ativo: false });
    const carimbo = seedCredencial(db, ID, { tokenExpiraEmMs: EXPIRA_MS });
    expect(await lerStatusDaConta(asDb(db), ID, AGORA_MS)).toMatchObject({
      configurado: true,
      expiraEm: '2027-03-01',
      versaoCredencialUs: relogioDoDocumentoUs(carimbo),
    });
  });

  it('the version is the credential document commit time in µs', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    const carimbo = seedCredencial(db, ID);
    const s = await lerStatusDaConta(asDb(db), ID, AGORA_MS);
    expect(s.versaoCredencialUs).toBe(relogioDoDocumentoUs(carimbo));
  });

  it('a corrupt credential is LiCredencialInvalidaError with paths, never a 500-shaped crash', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID, { tokenFingerprint: 'nao-hex' });
    const err: unknown = await lerStatusDaConta(asDb(db), ID, AGORA_MS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiCredencialInvalidaError);
    expect((err as LiCredencialInvalidaError).campos).toEqual(['tokenFingerprint']);
  });

  it('the token, its fingerprint and the ref appear nowhere in the answer', async () => {
    const db = new FakeDb();
    seedConta(db, ID);
    seedCredencial(db, ID, {
      reconexaoPendente: { desdeMs: AGORA_MS, status: 401, refCredencial: REF_PARADA },
    });
    const texto = JSON.stringify(await lerStatusDaConta(asDb(db), ID, AGORA_MS));
    expect(texto).not.toContain(TOKEN_A);
    expect(texto).not.toContain(fingerprintDoToken(TOKEN_A));
    expect(texto).not.toContain(REF_PARADA);
    expect(texto).toContain('"status":401');
  });
});
