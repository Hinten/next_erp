import { describe, expect, it } from 'vitest';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  DIA_MS,
  TOKEN_A,
  TOKEN_B,
  caminhoCredencial,
  credencialDoc,
  seedCredencial,
} from '../testing/fixtures';
import { fingerprintDoToken, refDaCredencial } from './credencial';
import {
  atualizarValidade,
  lerCredencial,
  removerCredencial,
  salvarCredencial,
} from './credentialStore';
import {
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
} from './erros';

const ID = 'conta-li-1';
const CAMINHO = caminhoCredencial(ID);
const EXPIRA_MS = AGORA_MS + 80 * DIA_MS;
const WEBHOOK = { notifyUrl: 'https://exemplo.invalid/hook', token: 'w'.repeat(43) };

describe('lerCredencial (strict)', () => {
  it('null when no credential is stored', async () => {
    expect(await lerCredencial(asDb(new FakeDb()), ID)).toBeNull();
  });

  it('returns the parsed doc, its updateTime and the version in µs', async () => {
    const db = new FakeDb();
    const carimbo = seedCredencial(db, ID);
    const lida = await lerCredencial(asDb(db), ID);
    expect(lida?.credencial).toEqual(credencialDoc());
    expect(carimbo.isEqual(lida?.updateTime)).toBe(true);
    expect(lida?.versaoUs).toBe(relogioDoDocumentoUs(carimbo));
  });

  it('a corrupt doc throws with PATHS only — never the token', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID, { tokenFingerprint: 'NAO-HEX', campoEstranho: 'x' });
    const err: unknown = await lerCredencial(asDb(db), ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiCredencialInvalidaError);
    const invalida = err as LiCredencialInvalidaError;
    expect(invalida.campos).toEqual(expect.arrayContaining(['tokenFingerprint']));
    expect(invalida.message).not.toContain(TOKEN_A);
    expect(invalida.message).not.toContain(fingerprintDoToken(TOKEN_A));
    expect(JSON.stringify(invalida.campos)).not.toContain(TOKEN_A);
  });

  it('a doc whose stored tokenFingerprint disagrees with its token still yields the right ref', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID, { tokenFingerprint: '0000000000000000' });
    const lida = await lerCredencial(asDb(db), ID);
    expect(lida).not.toBeNull();
    expect(refDaCredencial(lida!.credencial)).toBe(
      `${fingerprintDoToken(TOKEN_A)}.${String(AGORA_MS - DIA_MS)}`,
    );
  });
});

describe('salvarCredencial — create path (the caller saw no document)', () => {
  it('writes the full doc, both optional blocks null, raw ms values equal to the injected ones', async () => {
    const db = new FakeDb();
    const wr = await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_A,
      tokenExpiraEmMs: EXPIRA_MS,
      agoraMs: AGORA_MS,
    });
    const escrita = db.escritasEm(CAMINHO);
    expect(escrita.map((e) => e.verbo)).toEqual(['create']);
    expect(db.ler(CAMINHO)).toEqual({
      personalToken: TOKEN_A,
      tokenFingerprint: fingerprintDoToken(TOKEN_A),
      tokenExpiraEmMs: EXPIRA_MS,
      tokenAtualizadoEmMs: AGORA_MS,
      webhookPedido: null,
      reconexaoPendente: null,
    });
    // ⚠️ millisSinceEpoch() would silently "repair" a µs value; pin the raw ones.
    expect(db.ler(CAMINHO)?.tokenExpiraEmMs).toBe(EXPIRA_MS);
    expect(db.ler(CAMINHO)?.tokenAtualizadoEmMs).toBe(AGORA_MS);
    expect(wr.versaoUs).toBe(relogioDoDocumentoUs(db.carimboDe(CAMINHO)!));
  });

  it('a doc that appeared meanwhile is a 409, not an overwrite', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID, { personalToken: TOKEN_B });
    await expect(
      salvarCredencial(asDb(db), ID, {
        personalToken: TOKEN_A,
        tokenExpiraEmMs: EXPIRA_MS,
        agoraMs: AGORA_MS,
      }),
    ).rejects.toBeInstanceOf(LiCredencialAlteradaError);
    expect(db.ler(CAMINHO)?.personalToken).toBe(TOKEN_B);
    expect(db.escritasEm(CAMINHO)).toEqual([]);
  });
});

describe('salvarCredencial — update path (versioned)', () => {
  it('one patch of exactly five keys; a seeded webhookPedido survives; a park is cleared', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID, {
      webhookPedido: WEBHOOK,
      reconexaoPendente: { desdeMs: AGORA_MS - 1, status: 401, refCredencial: 'x.1' },
    });
    const lida = await lerCredencial(asDb(db), ID);
    await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_B,
      tokenExpiraEmMs: EXPIRA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: lida!.updateTime,
    });
    const [escrita] = db.escritasEm(CAMINHO);
    expect(escrita?.verbo).toBe('update');
    expect(Object.keys(escrita?.dados ?? {}).sort()).toEqual([
      'personalToken',
      'reconexaoPendente',
      'tokenAtualizadoEmMs',
      'tokenExpiraEmMs',
      'tokenFingerprint',
    ]);
    expect(db.ler(CAMINHO)).toEqual({
      personalToken: TOKEN_B,
      tokenFingerprint: fingerprintDoToken(TOKEN_B),
      tokenExpiraEmMs: EXPIRA_MS,
      tokenAtualizadoEmMs: AGORA_MS,
      webhookPedido: WEBHOOK,
      reconexaoPendente: null,
    });
  });

  it('a stale version writes nothing (409)', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const velha = (await lerCredencial(asDb(db), ID))!.updateTime;
    // Another operator saves after this page loaded.
    await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_B,
      tokenExpiraEmMs: EXPIRA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: velha,
    });
    const depois = db.ler(CAMINHO);
    await expect(
      salvarCredencial(asDb(db), ID, {
        personalToken: TOKEN_A,
        tokenExpiraEmMs: EXPIRA_MS + DIA_MS,
        agoraMs: AGORA_MS + 1,
        versaoEsperada: velha,
      }),
    ).rejects.toBeInstanceOf(LiCredencialAlteradaError);
    expect(db.ler(CAMINHO)).toEqual(depois);
  });

  it('a write landing between the read and the update is a 409, not a silent overwrite', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const lida = await lerCredencial(asDb(db), ID);
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await salvarCredencial(asDb(db), ID, {
        personalToken: TOKEN_B,
        tokenExpiraEmMs: EXPIRA_MS,
        agoraMs: AGORA_MS,
        versaoEsperada: lida!.updateTime,
      });
    });
    await expect(
      salvarCredencial(asDb(db), ID, {
        personalToken: TOKEN_A,
        tokenExpiraEmMs: EXPIRA_MS,
        agoraMs: AGORA_MS + 5,
        versaoEsperada: lida!.updateTime,
      }),
    ).rejects.toBeInstanceOf(LiCredencialAlteradaError);
    expect(db.ler(CAMINHO)?.personalToken).toBe(TOKEN_B);
  });

  it('a credential removed after the read is a 409 too (its stamp fails), and is not resurrected', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const lida = await lerCredencial(asDb(db), ID);
    await removerCredencial(asDb(db), ID);
    await expect(
      salvarCredencial(asDb(db), ID, {
        personalToken: TOKEN_A,
        tokenExpiraEmMs: EXPIRA_MS,
        agoraMs: AGORA_MS,
        versaoEsperada: lida!.updateTime,
      }),
    ).rejects.toBeInstanceOf(LiCredencialAlteradaError);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });
});

describe('atualizarValidade (versioned)', () => {
  it('exactly three keys; the token and the webhook stay; the park is cleared', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID, {
      webhookPedido: WEBHOOK,
      reconexaoPendente: { desdeMs: 1, status: 403, refCredencial: 'x.1' },
    });
    const lida = await lerCredencial(asDb(db), ID);
    const wr = await atualizarValidade(asDb(db), ID, {
      tokenExpiraEmMs: EXPIRA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: lida!.updateTime,
    });
    const [escrita] = db.escritasEm(CAMINHO);
    expect(Object.keys(escrita?.dados ?? {}).sort()).toEqual([
      'reconexaoPendente',
      'tokenAtualizadoEmMs',
      'tokenExpiraEmMs',
    ]);
    expect(db.ler(CAMINHO)).toMatchObject({
      personalToken: TOKEN_A,
      tokenExpiraEmMs: EXPIRA_MS,
      tokenAtualizadoEmMs: AGORA_MS,
      webhookPedido: WEBHOOK,
      reconexaoPendente: null,
    });
    expect(wr.versaoUs).toBe(relogioDoDocumentoUs(db.carimboDe(CAMINHO)!));
  });

  it('a precondition loss is ALTERADA; a removal — which fails the stamp too (9) — is AUSENTE, by a re-read', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const lida = await lerCredencial(asDb(db), ID);
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(CAMINHO, credencialDoc({ tokenExpiraEmMs: AGORA_MS + DIA_MS }));
    });
    await expect(
      atualizarValidade(asDb(db), ID, {
        tokenExpiraEmMs: EXPIRA_MS,
        agoraMs: AGORA_MS,
        versaoEsperada: lida!.updateTime,
      }),
    ).rejects.toBeInstanceOf(LiCredencialAlteradaError);

    const lida2 = await lerCredencial(asDb(db), ID);
    await removerCredencial(asDb(db), ID);
    await expect(
      atualizarValidade(asDb(db), ID, {
        tokenExpiraEmMs: EXPIRA_MS,
        agoraMs: AGORA_MS,
        versaoEsperada: lida2!.updateTime,
      }),
    ).rejects.toBeInstanceOf(LiCredencialAusenteError);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });
});

describe('removerCredencial', () => {
  it('deletes, is idempotent, and reports a strictly newer commit stamp each time', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const r1 = await removerCredencial(asDb(db), ID);
    const r2 = await removerCredencial(asDb(db), ID);
    expect(db.ler(CAMINHO)).toBeUndefined();
    expect(r2.versaoUs).toBeGreaterThan(r1.versaoUs);
  });
});
