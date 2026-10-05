import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { CANAL_AVISO, SEVERIDADE_AVISO, TIPO_AVISO } from '@delfrance/schemas';

import {
  MOTIVO_REAUTORIZADA,
  avisarDesautorizacao,
  avisarExpiracaoAutorizacao,
  chaveDesautorizacao,
  chaveExpiracao,
  prazoUsDe,
  resolverAvisosDeAutorizacao,
} from './autorizacao';

/* -------------------------------------------------------------------------- */
/*  Fake Admin-SDK Firestore                                                  */
/*                                                                            */
/*  COPIED from `packages/data/src/admin/avisos/escreverAviso.test.ts` — the   */
/*  producers below run through the REAL `escreverAviso` / `resolverAviso`,    */
/*  so the seam under test is the plano they hand it, not a mock of it.       */
/*  `create` throws gRPC 6 when the document exists; `update` honours the      */
/*  `lastUpdateTime` precondition and throws gRPC 9 on a mismatch.            */
/*                                                                            */
/*  Two deliberate extensions over the original:                              */
/*   - every `update` patch is recorded, so a test can assert which fields a   */
/*     producer OMITTED (the original only ever reads the final document);     */
/*   - the `{ __increment: n }` sentinel is APPLIED on write, so a counter     */
/*     across several runs can be read back as a number.                      */
/* -------------------------------------------------------------------------- */

interface Stored {
  data: Record<string, unknown>;
  updateTime: number;
}

function grpc(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function ehIncremento(v: unknown): v is { __increment: number } {
  return typeof v === 'object' && v !== null && '__increment' in v;
}

/** Apply the injected `increment` sentinel the way `FieldValue.increment` would. */
function aplicar(
  anterior: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const saida: Record<string, unknown> = { ...anterior };
  for (const [chave, valor] of Object.entries(patch)) {
    if (ehIncremento(valor)) {
      const base = saida[chave];
      saida[chave] = (typeof base === 'number' ? base : 0) + valor.__increment;
    } else {
      saida[chave] = valor;
    }
  }
  return saida;
}

function makeDb() {
  const store: Record<string, Stored> = {};
  const patches: { path: string; patch: Record<string, unknown> }[] = [];
  let relogio = 100;

  const docRef = (path: string) => ({
    path,
    create: (data: Record<string, unknown>) => {
      if (store[path]) return Promise.reject(grpc(6, 'ALREADY_EXISTS'));
      relogio += 1;
      store[path] = { data: aplicar(undefined, data), updateTime: relogio };
      return Promise.resolve();
    },
    get: () => {
      const atual = store[path];
      return Promise.resolve({
        exists: atual !== undefined,
        updateTime: atual?.updateTime,
        data: () => atual?.data,
      });
    },
    update: (patch: Record<string, unknown>, precond?: { lastUpdateTime?: number }) => {
      const atual = store[path];
      if (!atual) return Promise.reject(grpc(5, 'NOT_FOUND'));
      if (precond?.lastUpdateTime !== undefined && precond.lastUpdateTime !== atual.updateTime) {
        return Promise.reject(grpc(9, 'FAILED_PRECONDITION'));
      }
      relogio += 1;
      patches.push({ path, patch });
      store[path] = { data: aplicar(atual.data, patch), updateTime: relogio };
      return Promise.resolve();
    },
    set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const atual = store[path];
      relogio += 1;
      store[path] = {
        data: opts?.merge === true ? aplicar(atual?.data, data) : data,
        updateTime: relogio,
      };
      return Promise.resolve();
    },
  });

  const db = {
    collection: (colPath: string) => ({ doc: (id: string) => docRef(`${colPath}/${id}`) }),
    doc: (path: string) => docRef(path),
  };

  return { db: db as unknown as Firestore, store, patches };
}

const AGORA_MS = 1_760_000_000_000;
const DIA_MS = 86_400_000;
const SHOP_ID = 987654;
const INTEGRACAO = 'int-1';

const increment = (by: number): unknown => ({ __increment: by });
const deps = { increment, nowMs: AGORA_MS };

const CHAVE_EXP = chaveExpiracao(INTEGRACAO, SHOP_ID);
const CHAVE_DES = chaveDesautorizacao(INTEGRACAO, SHOP_ID);

function evento(over: Partial<Parameters<typeof avisarExpiracaoAutorizacao>[1]> = {}) {
  return {
    integracaoId: INTEGRACAO,
    shopId: SHOP_ID,
    expireTimeMs: AGORA_MS + 29 * DIA_MS,
    lojaNome: 'Loja BR',
    ...over,
  };
}

describe('the chaves', () => {
  it('carry NO janela — the resolver must be able to recompute them', async () => {
    // A window keyed on the expiry DATE would make the resolver derive a key
    // that was never created, because a re-consent moves the date: the row would
    // stand forever, past the 90-day retention sweep.
    const { db, store } = makeDb();
    await avisarExpiracaoAutorizacao(db, evento(), deps);

    expect(Object.keys(store)).toEqual([`avisos/${CHAVE_EXP}`]);
    expect(CHAVE_EXP).toBe(`${TIPO_AVISO.shopeeAutorizacaoExpirando}:${INTEGRACAO}:${SHOP_ID}`);
  });

  it('stay distinct per shop and per tipo', async () => {
    // The near-miss to the collapse above: dedup must not reach across shops
    // (two lojas, two problems) nor across the two tipos.
    expect(chaveExpiracao(INTEGRACAO, SHOP_ID)).not.toBe(chaveExpiracao(INTEGRACAO, 111));
    expect(chaveExpiracao(INTEGRACAO, SHOP_ID)).not.toBe(chaveExpiracao('int-2', SHOP_ID));
    expect(CHAVE_EXP).not.toBe(CHAVE_DES);
  });
});

describe('avisarExpiracaoAutorizacao', () => {
  it('writes the whole plano the operator inbox renders', async () => {
    const { db, store } = makeDb();
    const out = await avisarExpiracaoAutorizacao(db, evento(), deps);

    expect(out).toEqual({ chave: CHAVE_EXP, resultado: 'criado' });
    expect(store[`avisos/${CHAVE_EXP}`]?.data).toMatchObject({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      params: { loja: 'Loja BR', dias: 29 },
      urlInterna: { rota: `/canais/shopee/${INTEGRACAO}`, campo: null },
      ocorrencias: 1,
      resolvidoEm: null,
    });
  });

  it('speaks MICROSECONDS on the wire and MILLISECONDS in its signature', async () => {
    // This is the one module in apps/shopee that converts. A cross-unit
    // comparison downstream is a guard that never fires (rule 7).
    const { db, store } = makeDb();
    const e = evento();
    await avisarExpiracaoAutorizacao(db, e, deps);

    const doc = store[`avisos/${CHAVE_EXP}`]?.data;
    expect(doc?.criadoEm).toBe(AGORA_MS * 1000);
    expect(doc?.atualizadoEm).toBe(AGORA_MS * 1000);
    expect(doc?.prazo).toBe(e.expireTimeMs * 1000);
  });

  // ⚠️ The assertion above reads the CREATED document, which `escreverAviso`
  // full-parses — and `microsSinceEpoch` tolerantly promotes a ms-magnitude
  // integer to µs, so it would pass even if this module stopped converting.
  // The REPEAT path is where the tolerance stops: it is a raw `update`, so the
  // value goes to Firestore exactly as this module wrote it. This is the
  // assertion that pins the conversion instead of the schema.
  it('converte `prazo` no PATCH cru de um repeat, não só na criação', async () => {
    const { db, patches } = makeDb();
    const e = evento();
    await avisarExpiracaoAutorizacao(db, e, deps);
    await avisarExpiracaoAutorizacao(db, e, { ...deps, nowMs: AGORA_MS + 1000 });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch.prazo).toBe(e.expireTimeMs * 1000);
    // NEAR-MISS: em milissegundos NÃO pode passar.
    expect(patches[0]?.patch.prazo).not.toBe(e.expireTimeMs);
    expect(patches[0]?.patch.atualizadoEm).toBe((AGORA_MS + 1000) * 1000);
  });

  it('falls back to the shop id when the conta has no usable name', async () => {
    // `get_shop_info` is Shop-signed; the sweep reads no token, so the conta
    // document's `nome` is the only name it can reach.
    const { db, store } = makeDb();
    await avisarExpiracaoAutorizacao(db, evento({ lojaNome: null }), deps);

    expect(store[`avisos/${CHAVE_EXP}`]?.data.params).toEqual({
      loja: String(SHOP_ID),
      dias: 29,
    });
  });

  it('OMITS relogioEvento when the caller has no delivery clock', async () => {
    // The sweep has no provider delivery. `null` would RESET the stored
    // watermark, and a reset watermark is a guard that never rejects again.
    const { db, patches } = makeDb();
    await avisarExpiracaoAutorizacao(db, evento(), deps);
    await avisarExpiracaoAutorizacao(db, evento(), { ...deps, nowMs: AGORA_MS + 1000 });

    expect(patches).toHaveLength(1);
    expect('relogioEvento' in (patches[0]?.patch ?? {})).toBe(false);
  });

  it('SENDS relogioEvento when the caller has one', async () => {
    // The near-miss: the omission above must be the absence of a clock, not the
    // producer being unable to carry one. `push 12` does carry one.
    const { db, patches } = makeDb();
    await avisarExpiracaoAutorizacao(db, evento(), deps);
    await avisarExpiracaoAutorizacao(db, evento({ relogioEventoMs: AGORA_MS }), {
      ...deps,
      nowMs: AGORA_MS + 1000,
    });

    expect(patches[0]?.patch.relogioEvento).toBe(AGORA_MS);
  });
});

describe('avisarDesautorizacao', () => {
  it('writes the desautorizado tipo with { loja } and the provider motivo', async () => {
    // Five documented `authorize_type` values, five different remedies — which
    // is why the reason is stored beside the tipo instead of folded into it.
    const { db, store } = makeDb();
    const out = await avisarDesautorizacao(
      db,
      {
        integracaoId: INTEGRACAO,
        shopId: SHOP_ID,
        lojaNome: 'Loja BR',
        motivo: 'user cancel shop authorization',
      },
      deps,
    );

    expect(out).toEqual({ chave: CHAVE_DES, resultado: 'criado' });
    expect(store[`avisos/${CHAVE_DES}`]?.data).toMatchObject({
      tipo: TIPO_AVISO.shopeeDesautorizado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      params: { loja: 'Loja BR' },
      motivo: 'user cancel shop authorization',
      prazo: null,
    });
  });

  it('collapses a repeat onto ONE open row per shop', async () => {
    const { db, store } = makeDb();
    const base = {
      integracaoId: INTEGRACAO,
      shopId: SHOP_ID,
      lojaNome: 'Loja BR',
      motivo: 'expiry',
    };
    await avisarDesautorizacao(db, base, deps);
    const out = await avisarDesautorizacao(db, base, { ...deps, nowMs: AGORA_MS + 5 });

    expect(out.resultado).toBe('repetido');
    expect(Object.keys(store)).toEqual([`avisos/${CHAVE_DES}`]);
    expect(store[`avisos/${CHAVE_DES}`]?.data.ocorrencias).toBe(2);
  });
});

describe('resolverAvisosDeAutorizacao', () => {
  it('closes BOTH rows and says which ones it actually closed', async () => {
    const { db, store } = makeDb();
    await avisarExpiracaoAutorizacao(db, evento(), deps);
    await avisarDesautorizacao(
      db,
      { integracaoId: INTEGRACAO, shopId: SHOP_ID, lojaNome: 'Loja BR', motivo: 'expiry' },
      deps,
    );

    await expect(
      resolverAvisosDeAutorizacao(
        db,
        { integracaoId: INTEGRACAO, shopId: SHOP_ID },
        { nowMs: AGORA_MS + DIA_MS },
      ),
    ).resolves.toEqual({ expiracao: true, desautorizacao: true });

    for (const chave of [CHAVE_EXP, CHAVE_DES]) {
      expect(store[`avisos/${chave}`]?.data).toMatchObject({
        resolvidoEm: (AGORA_MS + DIA_MS) * 1000,
        resolucaoMotivo: MOTIVO_REAUTORIZADA,
      });
    }
  });

  it('answers false per chave rather than resurrecting a swept row', async () => {
    // Read-then-update, never `merge`: an admin `merge` is an UPSERT and would
    // recreate a document the retention sweep already deleted, as a ghost
    // carrying only the patch keys.
    const { db, store } = makeDb();
    await avisarExpiracaoAutorizacao(db, evento(), deps);

    await expect(
      resolverAvisosDeAutorizacao(
        db,
        { integracaoId: INTEGRACAO, shopId: SHOP_ID },
        { nowMs: AGORA_MS },
      ),
    ).resolves.toEqual({ expiracao: true, desautorizacao: false });

    expect(store[`avisos/${CHAVE_DES}`]).toBeUndefined();
  });

  it('reopens with a NEW criadoEm when the problem comes back', async () => {
    // A problem that went away and returned has to clear the operator's read
    // watermark, or a resolved-then-recurring lapse is invisible forever.
    const { db, store } = makeDb();
    await avisarExpiracaoAutorizacao(db, evento(), deps);
    await resolverAvisosDeAutorizacao(
      db,
      { integracaoId: INTEGRACAO, shopId: SHOP_ID },
      { nowMs: AGORA_MS + DIA_MS },
    );

    const out = await avisarExpiracaoAutorizacao(db, evento(), {
      ...deps,
      nowMs: AGORA_MS + 2 * DIA_MS,
    });

    expect(out.resultado).toBe('reaberto');
    expect(store[`avisos/${CHAVE_EXP}`]?.data).toMatchObject({
      criadoEm: (AGORA_MS + 2 * DIA_MS) * 1000,
      resolvidoEm: null,
      resolucaoMotivo: null,
    });
  });
});

describe('prazoUsDe — o segundo e ÚLTIMO sítio de conversão deste arquivo', () => {
  it('converte um prazo em ms para µs', () => {
    expect(prazoUsDe(AGORA_MS)).toBe(AGORA_MS * 1000);
    // NEAR-MISS: não devolve os milissegundos.
    expect(prazoUsDe(AGORA_MS)).not.toBe(AGORA_MS);
  });

  it('null entra, null sai — um prazo ausente é uma leitura, não um valor faltando', () => {
    // `push 16` documenta `fix_deadline_time` como "Empty if no deadline", e um
    // prazo que nós inventássemos seria pior que nenhum. ⚠️ NÃO é `?? 0`: zero é
    // 1970, um prazo que já venceu.
    expect(prazoUsDe(null)).toBeNull();
    expect(prazoUsDe(null)).not.toBe(0);
  });

  it('0 é um valor, não uma ausência — só null vira null', () => {
    expect(prazoUsDe(0)).toBe(0);
  });
});

/** Recursively collect every `.ts` file under `dir`. */
function arquivosTs(dir: string): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = `${dir}/${entrada.name}`;
    if (entrada.isDirectory()) saida.push(...arquivosTs(caminho));
    else if (entrada.name.endsWith('.ts')) saida.push(caminho);
  }
  return saida;
}

/** How many times `millisToMicros(` appears as a CALL in `fonte`. */
function chamadas(fonte: string): number {
  return fonte.split('millisToMicros(').length - 1;
}

describe('⚠️ a promessa do docblock: EXATAMENTE dois sítios de conversão', () => {
  const RAIZ_AVISOS = fileURLToPath(new URL('.', import.meta.url));
  const RAIZ_ANUNCIOS = fileURLToPath(new URL('../anuncios/', import.meta.url));

  it('este arquivo converte em dois lugares — agoraUsDe e prazoUsDe, e em mais nenhum', () => {
    // A frase "exactly two call sites" no cabeçalho é a única coisa que mantém o
    // seam µs revisável, e uma frase que virou três é pior que nenhuma frase. O
    // passo 11 acrescentou um terceiro módulo produtor de avisos sem acrescentar
    // um terceiro sítio, e é isto que diz isso em voz alta.
    const fonte = readFileSync(`${RAIZ_AVISOS}autorizacao.ts`, 'utf8');

    expect(chamadas(fonte)).toBe(2);
    // ÂNCORA: o arquivo realmente foi lido e realmente contém os dois seams.
    expect(fonte).toContain('export function agoraUsDe');
    expect(fonte).toContain('export function prazoUsDe');
  });

  it('o módulo de push-health continua sem conversão nenhuma', () => {
    const fonte = readFileSync(`${RAIZ_AVISOS}pushSaude.ts`, 'utf8');
    expect(chamadas(fonte)).toBe(0);
    expect(fonte).toContain('export function chavePushDegradado');
  });

  it('⚠️ NADA sob lib/shopee/anuncios/ converte, lê relógio ou fala microssegundo', () => {
    // O produtor de avisos de anúncio importa `prazoUsDe`/`agoraUsDe` daqui em
    // vez de converter, o que é o que mantém a lista numerada de SÍTIOS em
    // `apps/shopee/CLAUDE.md` em oito. Um `Date.now()` ali seria um relógio num
    // caminho cujo `nowMs` é sempre parâmetro.
    const arquivos = arquivosTs(RAIZ_ANUNCIOS);

    // ÂNCORA anti-vacuidade: sem ela, um diretório vazio (ou renomeado) passaria
    // verde dizendo nada.
    expect(arquivos.length).toBeGreaterThanOrEqual(1);

    for (const arquivo of arquivos) {
      const fonte = readFileSync(arquivo, 'utf8');
      // ⚠️ Texto CRU, comentários incluídos: nomear o conversor num comentário ali
      // é exatamente o que faria um leitor procurar um sítio que não existe.
      expect(fonte, arquivo).not.toContain('millisToMicros');
      expect(fonte, arquivo).not.toContain('coerceToMicros');
      expect(fonte, arquivo).not.toContain('Date.now(');
    }
  });
});
