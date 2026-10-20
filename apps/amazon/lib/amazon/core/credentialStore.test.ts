import { beforeEach, describe, expect, it } from 'vitest';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_NOVO,
  AGORA_MS,
  AUTORIZADO_EM_MS,
  REFRESH_TOKEN_A,
  REFRESH_TOKEN_B,
  caminhoCredencial,
  credencialDoc,
  refDe,
  seedCredencial,
  textoDe,
} from '../testing/fixtures';
import {
  lerCredencial,
  lerCredencialComLeitura,
  persistirAcesso,
  removerCredencial,
  salvarConsentimento,
} from './credentialStore';
import { CredencialAmazonAusenteError, CredencialAmazonInvalidaError } from './erros';

const ID = 'conta-1';
const CAMINHO = caminhoCredencial(ID);
let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

async function invalida(p: Promise<unknown>): Promise<CredencialAmazonInvalidaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CredencialAmazonInvalidaError) return err;
    throw err;
  }
  throw new Error('esperava CredencialAmazonInvalidaError');
}

describe('lerCredencial', () => {
  it('answers null when no credential is stored, and reads the generic path', async () => {
    expect(await lerCredencial(asDb(db), ID)).toBeNull();
    expect(db.leituras).toEqual([CAMINHO]);
    expect(CAMINHO).toBe('integracao/conta-1/credenciais/current');
  });

  it('parses a stored credential strictly, with its updateTime and µs version', async () => {
    const carimbo = seedCredencial(db, ID);
    const lida = await lerCredencial(asDb(db), ID);
    expect(lida?.credencial.refresh_token).toBe(REFRESH_TOKEN_A);
    expect(lida?.updateTime.isEqual(carimbo as never)).toBe(true);
    expect(lida?.versaoUs).toBe(relogioDoDocumentoUs(carimbo));
  });

  it('a hand-added key reads as CORRUPT (strict), with paths only — never a token', async () => {
    seedCredencial(db, ID, { tokenFingerprint: 'ffffffffffffffff' });
    const err = await invalida(lerCredencial(asDb(db), ID));
    expect(err.campos.length).toBeGreaterThan(0);
    expect(textoDe(err)).not.toContain(REFRESH_TOKEN_A);
    expect(textoDe(err)).not.toContain(ACCESS_TOKEN_A);
  });

  it('a park with a status outside 4xx reads as corrupt, naming the path', async () => {
    seedCredencial(db, ID, {
      reconexaoPendente: { desdeMs: AGORA_MS, status: 500, codigoLwa: null, refCredencial: 'r' },
    });
    expect((await invalida(lerCredencial(asDb(db), ID))).campos).toEqual([
      'reconexaoPendente.status',
    ]);
  });
});

describe('lerCredencialComLeitura', () => {
  it('clocks an ABSENCE by the snapshot readTime: a later write is stamped after it', async () => {
    const { lida, readTimeUs } = await lerCredencialComLeitura(asDb(db), ID);
    expect(lida).toBeNull();
    const depois = seedCredencial(db, ID);
    expect(relogioDoDocumentoUs(depois)).toBeGreaterThan(readTimeUs);
  });
});

describe('salvarConsentimento — a FULL set (tier 0)', () => {
  const consentimento = {
    access_token: ACCESS_TOKEN_NOVO,
    refresh_token: REFRESH_TOKEN_B,
    expirationDate: AGORA_MS + 3_600_000,
    autorizadoEmMs: AGORA_MS,
    acessoRef: refDe(REFRESH_TOKEN_B, AGORA_MS),
  };

  it('writes the whole document with `set` — exactly six keys, park cleared', async () => {
    seedCredencial(db, ID, {
      reconexaoPendente: {
        desdeMs: AGORA_MS - 1,
        status: 400,
        codigoLwa: 'invalid_grant',
        refCredencial: refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS),
      },
    });
    const w = await salvarConsentimento(asDb(db), ID, consentimento);
    const escritas = db.escritasEm(CAMINHO);
    expect(escritas.map((e) => e.verbo)).toEqual(['set']);
    expect(Object.keys(db.ler(CAMINHO) ?? {}).sort()).toEqual([
      'access_token',
      'acessoRef',
      'autorizadoEmMs',
      'expirationDate',
      'reconexaoPendente',
      'refresh_token',
    ]);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toBeNull();
    expect(w.versaoUs).toBe(relogioDoDocumentoUs(w.writeTime));
  });

  it('PINS the raw stored stamps in MILLISECONDS (millisSinceEpoch would hide a µs slip on read)', async () => {
    await salvarConsentimento(asDb(db), ID, consentimento);
    const cru = db.ler(CAMINHO);
    expect(cru?.autorizadoEmMs).toBe(AGORA_MS);
    expect(cru?.expirationDate).toBe(AGORA_MS + 3_600_000);
    expect(cru?.autorizadoEmMs).not.toBe(AGORA_MS * 1000);
  });

  it('a µs stamp handed in is coerced by the schema — so only the raw pin above notices one', async () => {
    // The near-miss the risk list names: `millisSinceEpoch` "repairs" a µs value
    // instead of refusing it. The store therefore never relies on the parse to
    // catch a unit slip; the pin above does.
    await salvarConsentimento(asDb(db), ID, { ...consentimento, autorizadoEmMs: AGORA_MS * 1000 });
    expect(db.ler(CAMINHO)?.autorizadoEmMs).toBe(AGORA_MS);
  });

  it('refuses, before any write, a document the strict reader would reject', async () => {
    await expect(
      salvarConsentimento(asDb(db), ID, { ...consentimento, acessoRef: 'r'.repeat(65) }),
    ).rejects.toThrow();
    expect(db.escritas).toHaveLength(0);
  });

  it('what it writes reads back through the strict reader', async () => {
    await salvarConsentimento(asDb(db), ID, consentimento);
    expect((await lerCredencial(asDb(db), ID))?.credencial).toEqual({
      ...consentimento,
      reconexaoPendente: null,
    });
  });
});

describe('persistirAcesso — a 3-key field update (tier 0)', () => {
  it('patches exactly access_token, expirationDate and acessoRef — never a set, no precondition', async () => {
    seedCredencial(db, ID);
    await persistirAcesso(asDb(db), ID, {
      access_token: ACCESS_TOKEN_NOVO,
      expirationDate: AGORA_MS + 3_600_000,
      acessoRef: refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS),
    });
    const [escrita] = db.escritasEm(CAMINHO);
    expect(escrita?.verbo).toBe('update');
    expect(escrita?.comPrecondicao).toBe(false);
    expect(Object.keys(escrita?.dados ?? {}).sort()).toEqual([
      'access_token',
      'acessoRef',
      'expirationDate',
    ]);
  });

  it('leaves the grant and a park untouched', async () => {
    const park = {
      desdeMs: AGORA_MS,
      status: 400,
      codigoLwa: 'invalid_grant',
      refCredencial: refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS),
    };
    seedCredencial(db, ID, { reconexaoPendente: park });
    await persistirAcesso(asDb(db), ID, {
      access_token: ACCESS_TOKEN_NOVO,
      expirationDate: AGORA_MS + 1,
      acessoRef: 'x',
    });
    expect(db.ler(CAMINHO)).toMatchObject({
      refresh_token: REFRESH_TOKEN_A,
      autorizadoEmMs: AUTORIZADO_EM_MS,
      reconexaoPendente: park,
    });
  });

  it('a removed credential → CredencialAmazonAusenteError, and the doc is NOT recreated', async () => {
    await expect(
      persistirAcesso(asDb(db), ID, {
        access_token: ACCESS_TOKEN_NOVO,
        expirationDate: AGORA_MS,
        acessoRef: 'x',
      }),
    ).rejects.toBeInstanceOf(CredencialAmazonAusenteError);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('an extra key on the input never reaches the patch (the fields are named, never spread)', async () => {
    seedCredencial(db, ID);
    const entrada = {
      access_token: ACCESS_TOKEN_NOVO,
      expirationDate: AGORA_MS,
      acessoRef: 'x',
      refresh_token: 'nao-deve-ser-gravado',
    };
    await persistirAcesso(asDb(db), ID, entrada);
    expect(db.ler(CAMINHO)?.refresh_token).toBe(REFRESH_TOKEN_A);
    expect(Object.keys(db.escritasEm(CAMINHO)[0]?.dados ?? {})).toHaveLength(3);
  });

  it('refuses a malformed value before writing (strict pick: an empty token)', async () => {
    seedCredencial(db, ID);
    await expect(
      persistirAcesso(asDb(db), ID, { access_token: '', expirationDate: AGORA_MS, acessoRef: 'x' }),
    ).rejects.toThrow();
    expect(db.escritasEm(CAMINHO)).toHaveLength(0);
  });
});

describe('removerCredencial', () => {
  it('deletes, idempotently', async () => {
    seedCredencial(db, ID);
    await removerCredencial(asDb(db), ID);
    await removerCredencial(asDb(db), ID);
    expect(db.ler(CAMINHO)).toBeUndefined();
    expect(db.escritasEm(CAMINHO).map((e) => e.verbo)).toEqual(['delete', 'delete']);
  });
});

describe('the fixture itself', () => {
  it('a default credential parses (so every other suite starts from a valid one)', async () => {
    seedCredencial(db, ID);
    expect((await lerCredencial(asDb(db), ID))?.credencial.acessoRef).toBe(
      credencialDoc().acessoRef,
    );
  });
});
