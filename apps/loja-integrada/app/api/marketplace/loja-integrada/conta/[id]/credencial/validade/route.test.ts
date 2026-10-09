/**
 * `PUT …/conta/[id]/credencial/validade` — the renewal: re-validate the STORED
 * token, store a new expiry. Same seams as the save suite: the Admin singleton
 * and `FieldValue.increment` mocked, the global `fetch` stubbed, the real
 * store, validator and aviso writers against the fake.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CODIGO_ERRO_LI, respostaCredencialLojaIntegradaSchema } from '@delfrance/schemas';

import {
  avisarReconexaoPendente,
  chaveExpiracao,
  chaveReconexao,
  relogioDoDocumentoUs,
} from '@/lib/lojaIntegrada/avisos/avisos';
import { fingerprintDoToken, refDaCredencial } from '@/lib/lojaIntegrada/core/credencial';
import { removerCredencial } from '@/lib/lojaIntegrada/core/credentialStore';
import { FakeDb, asDb, increment } from '@/lib/lojaIntegrada/testing/fakeDb';
import {
  AGORA_MS,
  DIA_MS,
  TOKEN_A,
  caminhoAviso,
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

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (by: number) => ({ __increment: by }) },
}));

const { PUT } = await import('./route');

const ID = 'conta-li-1';
const CAMINHO = caminhoCredencial(ID);
const NOVA_VALIDADE = '2027-04-10';
const NOVA_VALIDADE_MS = Date.UTC(2027, 3, 11, 2, 59, 59);
const WEBHOOK = { notifyUrl: 'https://exemplo.invalid/h', token: 'w'.repeat(43) };

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

function renovar(corpo: unknown, opts: { id?: string; sinal?: AbortSignal } = {}) {
  const id = opts.id ?? ID;
  return PUT(
    requisicao('PUT', `${id}/credencial/validade`, { corpo, sinal: opts.sinal }),
    contexto(id),
  );
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

/** A stored credential (TOKEN_A), parked by a 401; returns its version in µs. */
function seedParada(): number {
  const carimbo = seedCredencial(db, ID, {
    webhookPedido: WEBHOOK,
    reconexaoPendente: {
      desdeMs: AGORA_MS - DIA_MS,
      status: 401,
      refCredencial: refDaCredencial({
        personalToken: TOKEN_A,
        tokenAtualizadoEmMs: AGORA_MS - DIA_MS,
      }),
    },
  });
  return relogioDoDocumentoUs(carimbo);
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
});

afterEach(() => {
  console$.restaurar();
  stdout.restaurar();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PUT …/credencial/validade — aceito', () => {
  it('re-validates the STORED token once, changes only the expiry, clears the park, keeps the webhook', async () => {
    const chamadas = stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const versao = seedParada();
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja Um', status: 401, relogioUs: versao },
      { increment, nowMs: AGORA_MS },
    );

    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao });
    expect(res.status).toBe(200);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.authorization).toBe(`Basic ${TOKEN_A}`);

    expect(db.ler(CAMINHO)).toEqual({
      ...credencialDoc(),
      tokenExpiraEmMs: NOVA_VALIDADE_MS,
      tokenAtualizadoEmMs: AGORA_MS,
      webhookPedido: WEBHOOK,
      reconexaoPendente: null,
    });
    const escritas = db.escritasEm(CAMINHO);
    expect(escritas.map((e) => e.verbo)).toEqual(['update']);
    expect(Object.keys(escritas[0]?.dados ?? {}).sort()).toEqual([
      'reconexaoPendente',
      'tokenAtualizadoEmMs',
      'tokenExpiraEmMs',
    ]);

    const corpo = respostaCredencialLojaIntegradaSchema.parse(await corpoDe(res));
    expect(corpo).toMatchObject({
      configurado: true,
      expiraEm: NOVA_VALIDADE,
      diasParaExpirar: 85,
      situacaoValidade: 'ok',
      atualizadoEmMs: AGORA_MS,
      versaoCredencialUs: relogioDoDocumentoUs(escritas[0]!.writeTime),
      reconexaoPendente: null,
      reconexaoResolvida: true,
    });
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolucaoMotivo: 'token-validado',
      relogioEvento: corpo.versaoCredencialUs,
    });
  });

  it('a date at or below 30 days raises the expiry aviso', async () => {
    stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const versao = relogioDoDocumentoUs(seedCredencial(db, ID));
    const res = await renovar({ expiraEm: '2027-02-04', versaoEsperada: versao });
    expect(res.status).toBe(200);
    expect(db.ler(caminhoAviso(chaveExpiracao(ID)))).toMatchObject({
      resolvidoEm: null,
      params: { loja: 'Loja Um', dias: 20, expiraEm: '2027-02-04' },
    });
  });
});

describe('PUT …/credencial/validade — refusals before any call', () => {
  it('403 for a read-only caller; 400 for a bad id', async () => {
    h.verifyIdToken.mockResolvedValue(LEITOR);
    expect((await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: 1 })).status).toBe(403);
    h.verifyIdToken.mockResolvedValue(ESCRITOR);
    expect(
      (await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: 1 }, { id: '..' })).status,
    ).toBe(400);
  });

  it('a body carrying a token is a 400: a renewal never accepts a new token', async () => {
    const chamadas = stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const versao = seedParada();
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao, token: 'outro' });
    expect(res.status).toBe(400);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.corpoInvalido });
    expect(chamadas).toHaveLength(0);
  });

  it('a past date is 422 with no call', async () => {
    const chamadas = stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const versao = seedParada();
    const res = await renovar({ expiraEm: '2027-01-14', versaoEsperada: versao });
    expect(res.status).toBe(422);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.validadePassada });
    expect(chamadas).toHaveLength(0);
  });

  it('no stored token → 409 LI_CREDENCIAL_AUSENTE', async () => {
    const chamadas = stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: 1 });
    expect(res.status).toBe(409);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.credencialAusente });
    expect(chamadas).toHaveLength(0);
  });

  it('a stale version → 409 LI_CREDENCIAL_ALTERADA with ZERO calls', async () => {
    const chamadas = stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const versao = seedParada();
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao - 1 });
    expect(res.status).toBe(409);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.credencialAlterada });
    expect(chamadas).toHaveLength(0);
    expect(db.escritas).toEqual([]);
  });

  it('a corrupt stored credential → 409 LI_CREDENCIAL_INVALIDA with paths', async () => {
    stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    seedCredencial(db, ID, { campoEstranho: 1 });
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: 1 });
    expect(res.status).toBe(409);
    expect(await corpoDe(res)).toMatchObject({
      code: CODIGO_ERRO_LI.credencialInvalida,
      issues: ['(raiz)'],
    });
  });

  it('a conta of another tipo → 404', async () => {
    seedConta(db, 'shopee-1', { tipo: 5 });
    seedCredencial(db, 'shopee-1');
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: 1 }, { id: 'shopee-1' });
    expect(res.status).toBe(404);
  });
});

describe('PUT …/credencial/validade — races with the write (rule 7)', () => {
  it('a write between the read and the update → 409 LI_CREDENCIAL_ALTERADA; the winner stands', async () => {
    stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const versao = seedParada();
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(CAMINHO, credencialDoc({ tokenAtualizadoEmMs: 99 }));
    });
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao });
    expect(res.status).toBe(409);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.credencialAlterada });
    expect(db.ler(CAMINHO)?.tokenAtualizadoEmMs).toBe(99);
  });

  it('a removal between the read and the update → 409 LI_CREDENCIAL_AUSENTE, never a resurrection', async () => {
    stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const versao = seedParada();
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await removerCredencial(asDb(db), ID);
    });
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao });
    expect(res.status).toBe(409);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.credencialAusente });
    expect(db.ler(CAMINHO)).toBeUndefined();
  });
});

describe('PUT …/credencial/validade — verdicts other than aceito', () => {
  it('recusado is 422 and does NOT park: the stored document is untouched', async () => {
    stubFetch(() => respostaJson(401, {}));
    const versao = relogioDoDocumentoUs(seedCredencial(db, ID));
    const antes = db.ler(CAMINHO);
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao });
    expect(res.status).toBe(422);
    expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.tokenRecusado, status: 401 });
    expect(db.ler(CAMINHO)).toEqual(antes);
    expect(db.escritas).toEqual([]);
  });

  it('inconclusivo is 502, nothing written', async () => {
    stubFetch(() => respostaJson(503, {}));
    const versao = relogioDoDocumentoUs(seedCredencial(db, ID));
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao });
    expect(res.status).toBe(502);
    expect(db.escritas).toEqual([]);
  });

  it('a caller abort during the validation is 499, nothing written', async () => {
    const controller = new AbortController();
    stubFetch((_url, init) => {
      controller.abort(new Error('o navegador desistiu'));
      return Promise.reject(init.signal?.reason);
    });
    const versao = relogioDoDocumentoUs(seedCredencial(db, ID));
    const res = await renovar(
      { expiraEm: NOVA_VALIDADE, versaoEsperada: versao },
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
    const versao = relogioDoDocumentoUs(seedCredencial(db, ID));
    await expect(
      renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao }, { sinal: controller.signal }),
    ).rejects.toBe(outro);
    expect(db.escritas).toEqual([]);
  });
});

describe('the validating GET is ONE log line', () => {
  it('one chamada line per PUT, for this conta; none for a refusal before the call', async () => {
    stubFetch(() => respostaJson(200, ENVELOPE_VAZIO));
    const versao = relogioDoDocumentoUs(seedCredencial(db, ID));
    // A stale version: refused before any call, so no line.
    await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao - 1 });
    expect(linhasDeLog()).toEqual([]);
    const res = await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao });
    expect(res.status).toBe(200);
    const linhas = linhasDeLog();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      severity: 'INFO',
      evento: 'chamada',
      conta: ID,
      operacao: 'validarPersonalToken',
      caminho: '/v1/categoria/?limit=1',
      status: 200,
      resultado: 'ok',
      credencial: 'personal-token',
      versaoCredencial: null,
    });
  });
});

describe('hygiene and structure', () => {
  it('the stored token and its fingerprint appear in no answer and no log line', async () => {
    const respostas: string[] = [];
    // A PARTIAL echo survives the package's exact-token scrub; only the logger's
    // own rule (a candidate credential's line has no body excerpt) stops it.
    const parcial = TOKEN_A.slice(0, -4);
    for (const status of [200, 401, 500]) {
      stubFetch(() =>
        respostaJson(
          status,
          status === 200 ? ENVELOPE_VAZIO : { eco: TOKEN_A, detalhe: `token ${parcial} recusado` },
        ),
      );
      const versao = relogioDoDocumentoUs(db.carimboDe(CAMINHO) ?? seedCredencial(db, ID));
      respostas.push(
        await (await renovar({ expiraEm: NOVA_VALIDADE, versaoEsperada: versao })).text(),
      );
    }
    // Anti-vacuity: each of the three PUTs wrote its line, and it is searched below.
    expect(linhasDeLog()).toHaveLength(3);
    const tudo = [...respostas, textoDe(console$.argumentos()), ...stdout.escritas()].join('\n');
    expect(tudo).not.toContain(parcial);
    expect(tudo).not.toContain(fingerprintDoToken(TOKEN_A));
  });

  it('this route calls the validator exactly once, and imports no park module', () => {
    const fonte = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8');
    expect(fonte.split('validarPersonalToken(').length - 1).toBe(1);
    expect(fonte).not.toContain('estacionamento');
  });
});
