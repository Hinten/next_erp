/**
 * `PUT` / `DELETE …/conta/[id]/credencial`, end to end through the REAL store,
 * guard, validator and aviso writers against the fake. Mocked: the Admin
 * singleton (auth + the fake as Firestore) and `FieldValue.increment` (the
 * fake's sentinel); stubbed: the global `fetch` the validator calls.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import {
  CODIGO_ERRO_LI,
  respostaCredencialLojaIntegradaSchema,
  respostaRemocaoCredencialLiSchema,
} from '@delfrance/schemas';

import {
  avisarExpiracaoToken,
  avisarReconexaoPendente,
  chaveExpiracao,
  chaveReconexao,
  prazoUsDe,
  relogioDoDocumentoUs,
} from '@/lib/lojaIntegrada/avisos/avisos';
import { fingerprintDoToken, refDaCredencial } from '@/lib/lojaIntegrada/core/credencial';
import { MENSAGEM_CORPO_NAO_JSON } from '@/lib/lojaIntegrada/core/respond';
import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import { FakeDb, asDb, grpc, increment } from '@/lib/lojaIntegrada/testing/fakeDb';
import {
  AGORA_MS,
  DIA_MS,
  TOKEN_A,
  TOKEN_B,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  espiarStdout,
  seedConta,
  seedCredencial,
} from '@/lib/lojaIntegrada/testing/fixtures';
import {
  ENVELOPE_VAZIO,
  ESCRITOR,
  LEITOR,
  contexto,
  espiarConsole,
  requisicao,
  respostaJson,
  stubFetch,
  textoDe,
} from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
  estacionar: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (by: number) => ({ __increment: by }) },
}));

// The routes must never reach the park: a refusal at SAVE time is a verdict on
// a candidate, not on the stored credential. Any call fails the suite below.
vi.mock('@/lib/lojaIntegrada/core/estacionamento', () => ({
  decidirEstacionamento: h.estacionar,
  estacionarConta: h.estacionar,
  tratarFalhaDeAutenticacao: h.estacionar,
}));

const { PUT, DELETE } = await import('./route');

const ID = 'conta-li-1';
const OUTRA = 'conta-li-2';
const CAMINHO = caminhoCredencial(ID);
/** 45 days after AGORA_MS's civil day (2027-01-15): far from the threshold. */
const EXPIRA_LONGE = '2027-03-01';
const EXPIRA_LONGE_MS = Date.UTC(2027, 2, 2, 2, 59, 59);
/** 20 days out: at or below the 30-day threshold. */
const EXPIRA_PERTO = '2027-02-04';
const EXPIRA_PERTO_MS = Date.UTC(2027, 1, 5, 2, 59, 59);

let db: FakeDb;
let console$: ReturnType<typeof espiarConsole>;
let stdout: ReturnType<typeof espiarStdout>;

/** The logger's lines on stdout, parsed: one JSON object per line. */
function linhasDeLog(): Record<string, unknown>[] {
  return stdout
    .escritas()
    .join('')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => z.record(z.string(), z.unknown()).parse(JSON.parse(l)));
}

function salvar(corpo: unknown, opts: { id?: string; sinal?: AbortSignal } = {}) {
  return PUT(
    requisicao('PUT', `${opts.id ?? ID}/credencial`, { corpo, sinal: opts.sinal }),
    contexto(opts.id ?? ID),
  );
}

function remover(id = ID) {
  return DELETE(requisicao('DELETE', `${id}/credencial`), contexto(id));
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

function aceitarTudo() {
  return stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA_MS);
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  seedConta(db, ID, { nome: 'Loja Um' });
  console$ = espiarConsole();
  stdout = espiarStdout();
  // Every case below but the read-switch ones runs with calls allowed.
  vi.stubEnv(CHAMADAS_ENV_LI, 'on');
});

afterEach(() => {
  expect(h.estacionar).not.toHaveBeenCalled();
  console$.restaurar();
  stdout.restaurar();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/*                        PUT — the read switch (D17)                          */
/* -------------------------------------------------------------------------- */

describe('PUT …/credencial — the read switch: only the exact `on` calls Loja Integrada', () => {
  /** A value that must never reach a log line or an answer. */
  const VALOR_SENTINELA = 'on-SENTINELA-valor-da-chave';

  it.each([
    ['unset', undefined, 'INFO'],
    ['blank', '', 'INFO'],
    ['off', 'off', 'INFO'],
    ['ON', 'ON', 'WARNING'],
    ['" on"', ' on', 'WARNING'],
    ['"on "', 'on ', 'WARNING'],
    ['true', 'true', 'WARNING'],
    ['1', '1', 'WARNING'],
    ['a sentinel', VALOR_SENTINELA, 'WARNING'],
  ])(
    '%s: a fixed 503 LI_CHAMADAS_DESLIGADAS — the fetch mock never called, nothing read or written',
    async (_caso, valor, severidade) => {
      vi.stubEnv(CHAMADAS_ENV_LI, valor);
      const chamadas = aceitarTudo();

      const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });

      expect(res.status).toBe(503);
      const texto = await res.text();
      expect(JSON.parse(texto)).toEqual({
        error:
          'As chamadas à Loja Integrada estão desligadas neste backend até a migração. ' +
          'Nada foi enviado à Loja Integrada nem salvo.',
        code: CODIGO_ERRO_LI.chamadasDesligadas,
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(chamadas).toHaveLength(0);
      // Before the body and before any Firestore read.
      expect(db.leituras).toEqual([]);
      expect(db.escritas).toEqual([]);
      // One line, by operation and conta — never the value, never the token.
      expect(linhasDeLog()).toEqual([
        expect.objectContaining({
          severity: severidade,
          evento: 'chamada-bloqueada',
          conta: ID,
          operacao: 'validarPersonalToken',
          chave: CHAMADAS_ENV_LI,
          valorReconhecido: severidade === 'INFO',
        }),
      ]);
      const tudo = [texto, textoDe(console$.argumentos()), ...stdout.escritas()].join('\n');
      expect(tudo).not.toContain(TOKEN_A);
      expect(tudo).not.toContain(VALOR_SENTINELA);
    },
  );

  it('near-miss: the exact `on` validates with exactly one fetch and saves', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    const chamadas = aceitarTudo();
    const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(chamadas).toHaveLength(1);
    expect(linhasDeLog().map((l) => l.evento)).toEqual(['chamada']);
  });

  it('the caller and the id are still checked first: 403 and 400 with the switch off', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, undefined);
    aceitarTudo();
    expect((await salvar({}, { id: '..' })).status).toBe(400);
    h.verifyIdToken.mockResolvedValue(LEITOR);
    expect((await salvar({})).status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(linhasDeLog()).toEqual([]);
  });

  it('near-miss: DELETE makes no Loja Integrada call, so the switch does not gate it', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, undefined);
    aceitarTudo();
    seedCredencial(db, ID);
    expect((await remover()).status).toBe(200);
    expect(db.ler(CAMINHO)).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                               PUT — the gates                               */
/* -------------------------------------------------------------------------- */

describe('PUT …/credencial — refused before anything is read or sent', () => {
  it('401 without a bearer token, 403 for a read-only caller', async () => {
    const chamadas = aceitarTudo();
    const semAuth = await PUT(
      requisicao('PUT', `${ID}/credencial`, { semAuth: true, corpo: {} }),
      contexto(ID),
    );
    expect(semAuth.status).toBe(401);
    h.verifyIdToken.mockResolvedValue(LEITOR);
    const leitor = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(leitor.status).toBe(403);
    expect(chamadas).toHaveLength(0);
    expect(db.escritas).toEqual([]);
  });

  it.each(['..', '.', 'a.b'])('400 LI_ID_INVALIDO for the id %j, with no read', async (id) => {
    const res = await salvar(
      { token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null },
      { id },
    );
    expect(res.status).toBe(400);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.idInvalido });
    expect(db.leituras).toEqual([]);
  });

  it('a malformed JSON body carrying the token: a FIXED 400, the token nowhere', async () => {
    const chamadas = aceitarTudo();
    const corpoBruto = `{"token":"${TOKEN_A}","expiraEm":`;
    const res = await PUT(requisicao('PUT', `${ID}/credencial`, { corpoBruto }), contexto(ID));
    expect(res.status).toBe(400);
    const texto = await res.text();
    expect(JSON.parse(texto)).toEqual({
      error: MENSAGEM_CORPO_NAO_JSON,
      code: CODIGO_ERRO_LI.corpoInvalido,
    });
    expect(texto).not.toContain(TOKEN_A);
    expect(textoDe(console$.argumentos())).not.toContain(TOKEN_A);
    expect(chamadas).toHaveLength(0);
    expect(db.escritas).toEqual([]);
  });

  it('a body of the wrong shape: 400 with field PATHS only, never a value', async () => {
    const res = await salvar({ token: 42, expiraEm: EXPIRA_LONGE, versaoEsperada: 'x' });
    expect(res.status).toBe(400);
    const corpo = await corpoDe(res);
    expect(corpo).toMatchObject({
      code: CODIGO_ERRO_LI.corpoInvalido,
      issues: ['token', 'versaoEsperada'],
    });

    const extra = await salvar({
      token: TOKEN_A,
      expiraEm: EXPIRA_LONGE,
      versaoEsperada: null,
      apelido: TOKEN_A,
    });
    expect(extra.status).toBe(400);
    const texto = await extra.text();
    expect(texto).not.toContain(TOKEN_A);
    expect(JSON.parse(texto)).toMatchObject({ issues: ['(raiz)'] });
  });

  it.each([
    ['2027-01-14', CODIGO_ERRO_LI.validadePassada],
    ['2027-05-16', CODIGO_ERRO_LI.validadeDistante],
    ['2027-02-30', CODIGO_ERRO_LI.validadeInvalida],
  ])('the date %s is a 422 %s — no LI call, no credential read', async (expiraEm, code) => {
    const chamadas = aceitarTudo();
    const res = await salvar({ token: TOKEN_A, expiraEm, versaoEsperada: null });
    expect(res.status).toBe(422);
    expect(await corpoDe(res)).toMatchObject({ code, issues: ['expiraEm'] });
    expect(chamadas).toHaveLength(0);
    expect(db.leituras).not.toContain(CAMINHO);
  });

  it('near-miss: today and today + 120 days are accepted', async () => {
    aceitarTudo();
    expect(
      (await salvar({ token: TOKEN_A, expiraEm: '2027-01-15', versaoEsperada: null })).status,
    ).toBe(200);
    const versao = relogioDoDocumentoUs(db.carimboDe(CAMINHO)!);
    expect(
      (await salvar({ token: TOKEN_A, expiraEm: '2027-05-15', versaoEsperada: versao })).status,
    ).toBe(200);
  });

  it('404 for a missing conta and for a conta of another tipo — no LI call', async () => {
    const chamadas = aceitarTudo();
    const faltando = await salvar(
      { token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null },
      { id: 'nao-existe' },
    );
    expect(faltando.status).toBe(404);
    seedConta(db, 'shopee-1', { tipo: 5 });
    const shopee = await salvar(
      { token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null },
      { id: 'shopee-1' },
    );
    expect(shopee.status).toBe(404);
    expect(await corpoDe(shopee)).toMatchObject({ code: CODIGO_ERRO_LI.contaNaoEncontrada });
    expect(chamadas).toHaveLength(0);
    expect(db.escritas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         PUT — the version (rule 7)                          */
/* -------------------------------------------------------------------------- */

describe('PUT …/credencial — the version the operator saw', () => {
  it('a stale version is 409 LI_CREDENCIAL_ALTERADA with ZERO LI calls and no write', async () => {
    const chamadas = aceitarTudo();
    const carimbo = seedCredencial(db, ID);
    const res = await salvar({
      token: TOKEN_B,
      expiraEm: EXPIRA_LONGE,
      versaoEsperada: relogioDoDocumentoUs(carimbo) - 1,
    });
    expect(res.status).toBe(409);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.credencialAlterada });
    expect(chamadas).toHaveLength(0);
    expect(db.escritas).toEqual([]);
  });

  it('null while a credential exists, and a number while none does, are both 409', async () => {
    const chamadas = aceitarTudo();
    expect(
      (await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: 123 })).status,
    ).toBe(409);
    seedCredencial(db, ID);
    expect(
      (await salvar({ token: TOKEN_B, expiraEm: EXPIRA_LONGE, versaoEsperada: null })).status,
    ).toBe(409);
    expect(chamadas).toHaveLength(0);
    expect(db.escritas).toEqual([]);
  });

  it('a write landing between the read and the update is a 409, never an overwrite', async () => {
    aceitarTudo();
    const carimbo = seedCredencial(db, ID, { personalToken: TOKEN_B });
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(CAMINHO, credencialDoc({ personalToken: TOKEN_B, tokenAtualizadoEmMs: 7 }));
    });
    const res = await salvar({
      token: TOKEN_A,
      expiraEm: EXPIRA_LONGE,
      versaoEsperada: relogioDoDocumentoUs(carimbo),
    });
    expect(res.status).toBe(409);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.credencialAlterada });
    expect(db.ler(CAMINHO)).toMatchObject({ personalToken: TOKEN_B, tokenAtualizadoEmMs: 7 });
  });

  it('a create racing another create is a 409 (ALREADY_EXISTS), never an overwrite', async () => {
    aceitarTudo();
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(CAMINHO, credencialDoc({ personalToken: TOKEN_B }));
    });
    const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(409);
    expect(db.ler(CAMINHO)?.personalToken).toBe(TOKEN_B);
  });

  it('a corrupt stored credential is 409 LI_CREDENCIAL_INVALIDA with paths, and no call', async () => {
    const chamadas = aceitarTudo();
    seedCredencial(db, ID, { tokenFingerprint: 'nao-hex' });
    const res = await salvar({ token: TOKEN_B, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(409);
    const texto = await res.text();
    expect(JSON.parse(texto)).toMatchObject({
      code: CODIGO_ERRO_LI.credencialInvalida,
      issues: ['tokenFingerprint'],
    });
    expect(texto).not.toContain(TOKEN_A);
    expect(chamadas).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                         PUT — the wrong-store guard                         */
/* -------------------------------------------------------------------------- */

describe('PUT …/credencial — the same token on ANOTHER conta (Q2)', () => {
  it.each([true, false])(
    'another conta (ativo: %s) holding the token → 409, with no LI call',
    async (ativo) => {
      const chamadas = aceitarTudo();
      seedConta(db, OUTRA, { ativo });
      seedCredencial(db, OUTRA, { personalToken: TOKEN_A });
      const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
      expect(res.status).toBe(409);
      expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.tokenDeOutraConta });
      expect(chamadas).toHaveLength(0);
      expect(db.ler(CAMINHO)).toBeUndefined();
    },
  );

  it('near-miss: re-saving the same token on the SAME conta passes', async () => {
    const chamadas = aceitarTudo();
    const carimbo = seedCredencial(db, ID, { personalToken: TOKEN_A });
    const res = await salvar({
      token: TOKEN_A,
      expiraEm: EXPIRA_LONGE,
      versaoEsperada: relogioDoDocumentoUs(carimbo),
    });
    expect(res.status).toBe(200);
    expect(chamadas).toHaveLength(1);
  });

  it('another conta with a DIFFERENT token, or a corrupt one, does not block — the corrupt one is logged by id', async () => {
    aceitarTudo();
    seedConta(db, OUTRA);
    seedCredencial(db, OUTRA, { personalToken: TOKEN_B });
    seedConta(db, 'conta-li-3');
    seedCredencial(db, 'conta-li-3', { personalToken: TOKEN_A, tokenFingerprint: 'nao-hex' });
    const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(200);
    const avisosLog = textoDe(console$.argumentos());
    expect(avisosLog).toContain('conta-li-3');
    expect(avisosLog).not.toContain(TOKEN_A);
  });
});

/* -------------------------------------------------------------------------- */
/*                         PUT — the validation verdict                        */
/* -------------------------------------------------------------------------- */

describe('PUT …/credencial — the verdict table', () => {
  it.each([
    [401, 422, CODIGO_ERRO_LI.tokenRecusado],
    [403, 422, CODIGO_ERRO_LI.tokenRecusado],
    [500, 502, CODIGO_ERRO_LI.validacaoInconclusiva],
    [429, 502, CODIGO_ERRO_LI.validacaoInconclusiva],
  ])('Loja Integrada answers %i → %i %s, nothing written', async (statusLi, http, code) => {
    stubFetch(() => respostaJson(statusLi, { erro: 'qualquer' }));
    const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(http);
    expect(await corpoDe(res)).toMatchObject({
      code,
      status: statusLi,
      correlationId: expect.any(String) as unknown,
    });
    expect(db.escritas).toEqual([]);
  });

  it('a malformed 200 and a network failure are inconclusive (502), nothing written', async () => {
    stubFetch(() => respostaJson(200, { objects: 'nao' }));
    expect(
      (await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null })).status,
    ).toBe(502);
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const rede = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(rede.status).toBe(502);
    expect(await corpoDe(rede)).toMatchObject({ status: null });
    expect(db.escritas).toEqual([]);
  });

  it('a malformed token is 422 LI_TOKEN_INVALIDO and NEVER sent', async () => {
    const chamadas = aceitarTudo();
    const res = await salvar({ token: 'a bc', expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(422);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.tokenInvalido });
    expect(chamadas).toHaveLength(0);
    expect(db.escritas).toEqual([]);
  });

  it('a token short enough to sit inside its own ref is 422 and never sent', async () => {
    const chamadas = aceitarTudo();
    // The ref is `<16 hex>.<tokenAtualizadoEmMs>`, and AGORA_MS ends in "000".
    const res = await salvar({ token: '000', expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(422);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.tokenInvalido });
    expect(chamadas).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                               PUT — the save                                */
/* -------------------------------------------------------------------------- */

describe('PUT …/credencial — aceito', () => {
  it('create: ONE call with the trimmed token in Authorization only; the full doc; the version', async () => {
    const chamadas = aceitarTudo();
    const res = await salvar({
      token: `  ${TOKEN_A}\n`,
      expiraEm: EXPIRA_LONGE,
      versaoEsperada: null,
    });
    expect(res.status).toBe(200);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.authorization).toBe(`Basic ${TOKEN_A}`);
    expect(chamadas[0]?.url).not.toContain(TOKEN_A);
    expect(chamadas[0]?.correlationId).toBeNull();

    expect(db.ler(CAMINHO)).toEqual({
      personalToken: TOKEN_A,
      tokenFingerprint: fingerprintDoToken(TOKEN_A),
      tokenExpiraEmMs: EXPIRA_LONGE_MS,
      tokenAtualizadoEmMs: AGORA_MS,
      webhookPedido: null,
      reconexaoPendente: null,
    });

    const corpo = respostaCredencialLojaIntegradaSchema.parse(await corpoDe(res));
    expect(corpo).toEqual({
      configurado: true,
      expiraEm: EXPIRA_LONGE,
      diasParaExpirar: 45,
      situacaoValidade: 'ok',
      atualizadoEmMs: AGORA_MS,
      versaoCredencialUs: relogioDoDocumentoUs(db.carimboDe(CAMINHO)!),
      reconexaoPendente: null,
      reconexaoResolvida: false,
    });
  });

  it('update: keeps webhookPedido, clears the park, resolves the reconexão aviso at the write clock', async () => {
    aceitarTudo();
    const webhookPedido = { notifyUrl: 'https://exemplo.invalid/h', token: 'w'.repeat(43) };
    const carimbo = seedCredencial(db, ID, {
      personalToken: TOKEN_B,
      webhookPedido,
      reconexaoPendente: {
        desdeMs: AGORA_MS - DIA_MS,
        status: 401,
        refCredencial: refDaCredencial({ personalToken: TOKEN_B, tokenAtualizadoEmMs: 1 }),
      },
    });
    await avisarReconexaoPendente(
      asDb(db),
      {
        integracaoId: ID,
        lojaNome: 'Loja Um',
        status: 401,
        relogioUs: relogioDoDocumentoUs(carimbo),
      },
      { increment, nowMs: AGORA_MS },
    );

    const res = await salvar({
      token: TOKEN_A,
      expiraEm: EXPIRA_LONGE,
      versaoEsperada: relogioDoDocumentoUs(carimbo),
    });
    expect(res.status).toBe(200);
    const corpo = respostaCredencialLojaIntegradaSchema.parse(await corpoDe(res));
    expect(corpo.reconexaoResolvida).toBe(true);
    expect(db.ler(CAMINHO)).toMatchObject({
      personalToken: TOKEN_A,
      webhookPedido,
      reconexaoPendente: null,
    });
    const escrita = db.escritasEm(CAMINHO);
    expect(escrita.map((e) => e.verbo)).toEqual(['update']);
    expect(Object.keys(escrita[0]?.dados ?? {}).sort()).toEqual([
      'personalToken',
      'reconexaoPendente',
      'tokenAtualizadoEmMs',
      'tokenExpiraEmMs',
      'tokenFingerprint',
    ]);
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolucaoMotivo: 'token-validado',
      relogioEvento: corpo.versaoCredencialUs,
    });
  });

  it('a date at or below 30 days raises the expiry aviso with fresh params; a far one resolves it', async () => {
    aceitarTudo();
    const perto = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_PERTO, versaoEsperada: null });
    expect(perto.status).toBe(200);
    expect(db.ler(CAMINHO)?.tokenExpiraEmMs).toBe(EXPIRA_PERTO_MS);
    expect(db.ler(caminhoAviso(chaveExpiracao(ID)))).toMatchObject({
      resolvidoEm: null,
      params: { loja: 'Loja Um', dias: 20, expiraEm: EXPIRA_PERTO },
      prazo: prazoUsDe(EXPIRA_PERTO_MS),
    });
    const { versaoCredencialUs } = respostaCredencialLojaIntegradaSchema.parse(
      await corpoDe(perto),
    );

    const longe = await salvar({
      token: TOKEN_A,
      expiraEm: EXPIRA_LONGE,
      versaoEsperada: versaoCredencialUs,
    });
    expect(longe.status).toBe(200);
    expect(db.ler(caminhoAviso(chaveExpiracao(ID)))).toMatchObject({
      resolucaoMotivo: 'token-validado',
    });
    expect(db.ler(caminhoAviso(chaveExpiracao(ID)))?.resolvidoEm).not.toBeNull();
  });

  it('the conta deleted while the token was validated: the credential is undone and the answer is 404', async () => {
    aceitarTudo();
    db.antesDaProximaEscrita(CAMINHO, async () => {
      // The conta delete — its discovery walk has already run and found nothing.
      await integracaoCollection.docRef(asDb(db), {}, ID).delete();
    });
    const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(404);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.contaNaoEncontrada });
    expect(db.ler(caminhoConta(ID))).toBeUndefined();
    expect(db.ler(CAMINHO)).toBeUndefined();
    expect(db.escritasEm(CAMINHO).map((e) => e.verbo)).toEqual(['create', 'delete']);
  });

  it('a transient aviso failure after the write still answers 200 — the token WAS saved', async () => {
    aceitarTudo();
    db.falharLeitura(caminhoAviso(chaveReconexao(ID)), grpc(14, 'UNAVAILABLE'));
    const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(200);
    expect(respostaCredencialLojaIntegradaSchema.parse(await corpoDe(res)).reconexaoResolvida).toBe(
      false,
    );
    expect(db.ler(CAMINHO)?.personalToken).toBe(TOKEN_A);
  });

  it('near-miss: a NON-transient aviso failure after the write is still a 500 (thrown)', async () => {
    aceitarTudo();
    db.falharLeitura(caminhoAviso(chaveReconexao(ID)), grpc(7, 'PERMISSION_DENIED'));
    await expect(
      salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null }),
    ).rejects.toMatchObject({ code: 7 });
  });
});

/* -------------------------------------------------------------------------- */
/*                           PUT — the caller going away                       */
/* -------------------------------------------------------------------------- */

describe('PUT …/credencial — abort', () => {
  it('the caller aborting during the validation is 499 with an empty body, and no write', async () => {
    const controller = new AbortController();
    stubFetch((_url, init) => {
      controller.abort(new Error('o navegador desistiu'));
      return Promise.reject(init.signal?.reason);
    });
    const res = await salvar(
      { token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null },
      { sinal: controller.signal },
    );
    expect(res.status).toBe(499);
    expect(await res.text()).toBe('');
    expect(db.escritas).toEqual([]);
  });

  it('near-miss: a DIFFERENT error thrown after the abort is rethrown (500), never a 499', async () => {
    const controller = new AbortController();
    const outro = new RangeError('outra falha');
    stubFetch(() => {
      controller.abort(new Error('o navegador desistiu'));
      return Promise.reject(outro);
    });
    await expect(
      salvar(
        { token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null },
        { sinal: controller.signal },
      ),
    ).rejects.toBe(outro);
    expect(db.escritas).toEqual([]);
  });

  it('a write that fails after an abort is a 500, not a 499: the write is outside the abort try', async () => {
    const controller = new AbortController();
    stubFetch(() => {
      controller.abort(new Error('o navegador desistiu'));
      return respostaJson(200, ENVELOPE_VAZIO);
    });
    const falha = grpc(14, 'UNAVAILABLE');
    db.falharEscrita(CAMINHO, falha);
    await expect(
      salvar(
        { token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null },
        { sinal: controller.signal },
      ),
    ).rejects.toBe(falha);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   DELETE                                    */
/* -------------------------------------------------------------------------- */

describe('DELETE …/credencial', () => {
  it('403 for a read-only caller', async () => {
    h.verifyIdToken.mockResolvedValue(LEITOR);
    expect((await remover()).status).toBe(403);
  });

  it('removes the token and resolves both avisos; twice is 200 twice', async () => {
    const chamadas = aceitarTudo();
    seedCredencial(db, ID);
    const deps = { increment, nowMs: AGORA_MS };
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja Um', status: 403, relogioUs: 5 },
      deps,
    );
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja Um', tokenExpiraEmMs: AGORA_MS + 10 * DIA_MS },
      deps,
    );

    const primeira = await remover();
    expect(primeira.status).toBe(200);
    expect(respostaRemocaoCredencialLiSchema.parse(await corpoDe(primeira))).toEqual({ ok: true });
    expect(db.ler(CAMINHO)).toBeUndefined();
    const reconexao = db.ler(caminhoAviso(chaveReconexao(ID)));
    expect(reconexao).toMatchObject({ resolucaoMotivo: 'credencial-removida' });
    // Clocked by the delete's own commit time.
    const apagou = db.escritasEm(CAMINHO).at(-1);
    expect(apagou?.verbo).toBe('delete');
    expect(reconexao?.relogioEvento).toBe(relogioDoDocumentoUs(apagou!.writeTime));
    expect(db.ler(caminhoAviso(chaveExpiracao(ID)))).toMatchObject({
      resolucaoMotivo: 'credencial-removida',
    });

    expect((await remover()).status).toBe(200);
    expect(chamadas).toHaveLength(0);
  });

  it('404 for a missing conta or one of another tipo; 400 for a bad id', async () => {
    expect((await remover('nao-existe')).status).toBe(404);
    seedConta(db, 'shopee-1', { tipo: 5 });
    seedCredencial(db, 'shopee-1');
    expect((await remover('shopee-1')).status).toBe(404);
    expect(db.ler(caminhoCredencial('shopee-1'))).toBeDefined();
    expect((await remover('..')).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/*                        The validating GET is logged                         */
/* -------------------------------------------------------------------------- */

describe('PUT …/credencial — the validating GET is ONE log line', () => {
  it('aceito: one chamada line for this conta, labelled as a candidate credential', async () => {
    aceitarTudo();
    const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(200);
    const linhas = linhasDeLog();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      severity: 'INFO',
      evento: 'chamada',
      conta: ID,
      operacao: 'validarPersonalToken',
      metodo: 'GET',
      recurso: 'categoria',
      politica: 'catalogo',
      caminho: '/v1/categoria/?limit=1',
      status: 200,
      resultado: 'ok',
      credencial: 'personal-token',
      versaoCredencial: null,
      enviouCorrelationId: false,
    });
  });

  it('recusado: the line is an ERROR, still one per PUT', async () => {
    stubFetch(() => respostaJson(401, { erro: 'qualquer' }));
    const res = await salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(res.status).toBe(422);
    const linhas = linhasDeLog();
    expect(linhas.map((l) => [l.severity, l.resultado, l.conta])).toEqual([['ERROR', 'auth', ID]]);
  });

  it('near-miss: a refusal before the call, and a malformed token, write NO line', async () => {
    const chamadas = aceitarTudo();
    const carimbo = seedCredencial(db, ID);
    await salvar({
      token: TOKEN_B,
      expiraEm: EXPIRA_LONGE,
      versaoEsperada: relogioDoDocumentoUs(carimbo) - 1,
    });
    await salvar({ token: 'a bc', expiraEm: EXPIRA_LONGE, versaoEsperada: null });
    expect(chamadas).toHaveLength(0);
    expect(linhasDeLog()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               Token hygiene                                 */
/* -------------------------------------------------------------------------- */

describe('the token and its fingerprint appear in no answer and no log line', () => {
  it('across every outcome', async () => {
    const proibidos = [TOKEN_A, fingerprintDoToken(TOKEN_A)];
    const respostas: string[] = [];
    const registrar = async (p: Promise<Response>) => respostas.push(await (await p).text());

    // aceito (create), then the same token again on the same conta (update)
    aceitarTudo();
    await registrar(salvar({ token: TOKEN_A, expiraEm: EXPIRA_PERTO, versaoEsperada: null }));
    const versao = relogioDoDocumentoUs(db.carimboDe(CAMINHO)!);
    await registrar(salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: versao }));
    // stale version
    await registrar(salvar({ token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: versao }));
    // the same token from another conta
    seedConta(db, OUTRA);
    await registrar(
      PUT(
        requisicao('PUT', `${OUTRA}/credencial`, {
          corpo: { token: TOKEN_A, expiraEm: EXPIRA_LONGE, versaoEsperada: null },
        }),
        contexto(OUTRA),
      ),
    );
    // refused and inconclusive, each echoing the token in ITS body. The candidate
    // is a NEW token that still contains the sentinel (TOKEN_A itself is stored
    // on ID now, so the wrong-store guard would answer before any call). The
    // echo is only PART of the token sent, so the package's exact-token scrub
    // misses it: only the logger's own rule (a candidate credential's line has
    // no body excerpt) keeps it out of stdout.
    proibidos.push(fingerprintDoToken(`${TOKEN_A}x`));
    for (const status of [401, 500]) {
      stubFetch(() => respostaJson(status, { detalhe: `token ${TOKEN_A} recusado` }));
      seedConta(db, `conta-${String(status)}`);
      await registrar(
        PUT(
          requisicao('PUT', `conta-${String(status)}/credencial`, {
            corpo: { token: `${TOKEN_A}x`, expiraEm: EXPIRA_LONGE, versaoEsperada: null },
          }),
          contexto(`conta-${String(status)}`),
        ),
      );
    }
    // malformed JSON
    await registrar(
      PUT(
        requisicao('PUT', `${ID}/credencial`, { corpoBruto: `{"token":"${TOKEN_A}"` }),
        contexto(ID),
      ),
    );
    // removal
    await registrar(remover());

    expect(respostas).toHaveLength(8);
    // Anti-vacuity: the stdout lines searched below exist (aceito ×2, 401, 500).
    expect(linhasDeLog().filter((l) => l.evento === 'chamada')).toHaveLength(4);
    const tudo = [...respostas, textoDe(console$.argumentos()), ...stdout.escritas()].join('\n');
    for (const p of proibidos) expect(tudo).not.toContain(p);
  });
});

describe('structure', () => {
  it('this route calls the validator exactly once, and imports no park module', () => {
    const fonte = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8');
    expect(fonte.split('validarPersonalToken(').length - 1).toBe(1);
    expect(fonte).not.toContain('estacionamento');
  });
});
