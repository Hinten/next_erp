import { beforeEach, describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO, statusContaAmazonSchema } from '@delfrance/schemas';

import { ContaAmazonNaoEncontradaError } from '../core/erros';
import { fingerprintDoRefreshToken } from '../core/refCredencial';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  AUTORIZADO_EM_MS,
  REFRESH_TOKEN_A,
  SEGREDOS,
  SPID_A,
  refDe,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { statusContaAmazon } from './status';

const ID = 'conta-1';
const REF = refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS);
let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

const ler = (ambiente = AMBIENTE_LIGADO) =>
  statusContaAmazon(asDb(db), ID, { ambiente, agoraMs: AGORA_MS });

describe('statusContaAmazon', () => {
  it('the projection’s key set is EXACT, and it parses as the wire schema', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedCredencial(db, ID);
    const status = await ler();
    expect(Object.keys(status).sort()).toEqual(
      [
        'autorizadoEm',
        'chamadasLigadas',
        'connected',
        'credencialInvalida',
        'diasParaReautorizar',
        'reautorizarAte',
        'reconexaoPendente',
      ].sort(),
    );
    expect(statusContaAmazonSchema.strict().parse(status)).toEqual(status);
  });

  it('connected: São Paulo civil dates and the days left (10 days in → 355 left)', async () => {
    seedConta(db, ID);
    seedCredencial(db, ID);
    expect(await ler()).toEqual({
      connected: true,
      credencialInvalida: false,
      autorizadoEm: '2027-01-05',
      reautorizarAte: '2028-01-05',
      diasParaReautorizar: 355,
      reconexaoPendente: null,
      chamadasLigadas: true,
    });
  });

  it('no token, ref, fingerprint, LWA code or seller id appears — even when parked', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedCredencial(db, ID, {
      reconexaoPendente: {
        desdeMs: AGORA_MS,
        status: 400,
        codigoLwa: 'invalid_grant',
        refCredencial: REF,
      },
    });
    const status = await ler();
    expect(status.reconexaoPendente).toEqual({ desde: '2027-01-15', status: 400 });
    const texto = JSON.stringify(status);
    for (const proibido of [...SEGREDOS, REF, fingerprintDoRefreshToken(REFRESH_TOKEN_A), SPID_A]) {
      expect(texto, proibido).not.toContain(proibido);
    }
    expect(texto).not.toContain('invalid_grant');
  });

  it('no credential → not connected, every date null', async () => {
    seedConta(db, ID);
    expect(await ler()).toMatchObject({
      connected: false,
      credencialInvalida: false,
      autorizadoEm: null,
      reconexaoPendente: null,
    });
  });

  it('a CORRUPT credential → { connected: false, credencialInvalida: true }, never an error', async () => {
    seedConta(db, ID);
    seedCredencial(db, ID, { campoMisterioso: 1 });
    expect(await ler()).toMatchObject({ connected: false, credencialInvalida: true });
  });

  it('reports the read switch, without being gated by it', async () => {
    seedConta(db, ID);
    seedCredencial(db, ID);
    expect(await ler(AMBIENTE_DESLIGADO)).toMatchObject({
      connected: true,
      chamadasLigadas: false,
    });
  });

  it('an INACTIVE conta answers normally; a missing or other-tipo conta is the 404 class', async () => {
    seedConta(db, ID, { ativo: false });
    await expect(ler()).resolves.toMatchObject({ connected: false });
    seedConta(db, ID, { tipo: INTEGRACAO_TIPO.shopee });
    await expect(ler()).rejects.toBeInstanceOf(ContaAmazonNaoEncontradaError);
  });
});
