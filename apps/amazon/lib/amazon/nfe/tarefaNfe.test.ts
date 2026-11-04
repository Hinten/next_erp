/**
 * The NF-e task contract: the payload grammar, the ladders, and the COPY RULES
 * of the five builders (step 14, PR 14-b). Pure; no queue.
 */
import { describe, expect, it } from 'vitest';

import { makePedidoIdAmazon } from '../pedidos/orderIds';
import {
  ESCADA_VERIFICACAO_NFE_AMAZON_S,
  FASE_NFE_AMAZON,
  FILA_NFE_AMAZON,
  LEITURA_ANTES_NFE_AMAZON,
  MAX_REENVIOS_NFE_AMAZON,
  PAUSAS_NFE_AMAZON_S,
  TENTATIVAS_NFE_AMAZON,
  type TarefaNfeAmazon,
  ULTIMO_DEGRAU_NFE_AMAZON,
  aposEnvioNfeAmazon,
  pausaNfeAmazon,
  proximoDegrauNfeAmazon,
  reenvioNfeAmazon,
  tarefaInicialNfeAmazon,
  tarefaNfeAmazonSchema,
} from './tarefaNfe';

const PEDIDO_ID = makePedidoIdAmazon('conta-teste', '171-9876543-2109876');
const NFE_ID = 's1';

const inicial = () => tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID);

/** A verification payload at `degrau`, built ONLY through the builders. */
function verificacao(
  degrau: number,
  o: { incerto?: boolean; reenvios?: 0 | 1; leitura?: 'sem-nota' | 'recusada' | null } = {},
): TarefaNfeAmazon {
  let envio = inicial();
  if (o.reenvios === 1) {
    const primeira = aposEnvioNfeAmazon(envio, LEITURA_ANTES_NFE_AMAZON.semNota, true);
    envio = reenvioNfeAmazon(primeira) ?? envio;
  }
  let t = aposEnvioNfeAmazon(
    envio,
    o.leitura === undefined ? LEITURA_ANTES_NFE_AMAZON.semNota : o.leitura,
    o.incerto ?? false,
  );
  for (let i = 0; i < degrau; i++) t = proximoDegrauNfeAmazon(t) ?? t;
  return t;
}

describe('the ladders and bounds', () => {
  it('the verification ladder: ten rungs, Σ 85,680 s (≈ 23.8 h per submit)', () => {
    expect(ESCADA_VERIFICACAO_NFE_AMAZON_S).toEqual([
      60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 28800,
    ]);
    expect(ESCADA_VERIFICACAO_NFE_AMAZON_S.reduce((a, b) => a + b, 0)).toBe(85_680);
    expect(ULTIMO_DEGRAU_NFE_AMAZON).toBe(9);
  });

  it('the 429 pauses, the attempts, the queue name, the one resubmit', () => {
    expect(PAUSAS_NFE_AMAZON_S).toEqual([30, 60, 120, 240, 480]);
    expect(TENTATIVAS_NFE_AMAZON).toBe(4);
    expect(FILA_NFE_AMAZON).toBe('processAmazonNfeUpload');
    expect(MAX_REENVIOS_NFE_AMAZON).toBe(1);
  });

  it('the companion constants pair every enum member with its slug', () => {
    expect(FASE_NFE_AMAZON).toEqual({ envio: 'envio', verificacao: 'verificacao' });
    expect(LEITURA_ANTES_NFE_AMAZON).toEqual({ semNota: 'sem-nota', recusada: 'recusada' });
  });
});

describe('tarefaNfeAmazonSchema', () => {
  /** `t` paused `n` times, through the builder only. */
  function pausada(t: TarefaNfeAmazon, n: number): TarefaNfeAmazon {
    let p = t;
    for (let i = 0; i < n; i++) {
      const proxima = pausaNfeAmazon(p);
      if (proxima === null) throw new Error('anti-vacuity');
      p = proxima;
    }
    return p;
  }

  it('accepts every builder output — the pause bound and the last rung included', () => {
    const t = inicial();
    const noLimite = pausada(t, PAUSAS_NFE_AMAZON_S.length);
    const ultimoDegrauNoLimite = pausada(verificacao(9), PAUSAS_NFE_AMAZON_S.length);
    // Anti-vacuity: the builders really reached both bounds.
    expect(noLimite.pausas).toBe(5);
    expect(ultimoDegrauNoLimite).toMatchObject({ degrau: 9, pausas: 5 });
    for (const p of [
      t,
      aposEnvioNfeAmazon(t, LEITURA_ANTES_NFE_AMAZON.recusada, true),
      verificacao(9),
      verificacao(3, { incerto: true, reenvios: 1 }),
      pausaNfeAmazon(t),
      noLimite,
      ultimoDegrauNoLimite,
    ]) {
      expect(tarefaNfeAmazonSchema.safeParse(p).success, JSON.stringify(p)).toBe(true);
    }
  });

  it('★ the nfeId grammar ACCEPTS a legacy 20-character auto id and a 128-character id; 129 is refused', () => {
    const LEGADO = 'AbCdEfGhIjKlMnOpQrSt';
    expect(LEGADO).toHaveLength(20);
    for (const nfeId of [LEGADO, 'a'.repeat(128), 's1', 's9']) {
      const p = tarefaInicialNfeAmazon(PEDIDO_ID, nfeId);
      expect(tarefaNfeAmazonSchema.safeParse(p).success, nfeId).toBe(true);
    }
    const longo = 'a'.repeat(129);
    expect(() => tarefaInicialNfeAmazon(PEDIDO_ID, longo)).toThrow(RangeError);
    expect(tarefaNfeAmazonSchema.safeParse({ ...inicial(), nfeId: longo }).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown key', { conta: 'x' }],
    ['a pedidoId in UPPER hex', { pedidoId: PEDIDO_ID.toUpperCase() }],
    ['a short pedidoId', { pedidoId: PEDIDO_ID.slice(1) }],
    ['an nfeId with a slash', { nfeId: 'a/b' }],
    ['an nfeId `..`', { nfeId: '..' }],
    ['an nfeId `__x__`', { nfeId: '__x__' }],
    ['an empty nfeId', { nfeId: '' }],
    ['a fase outside the enum', { fase: 'reverificacao' }],
    ['degrau 10', { degrau: 10 }],
    ['degrau -1', { degrau: -1 }],
    ['degrau 1.5', { degrau: 1.5 }],
    ['reenvios 2', { reenvios: 2 }],
    ['pausas 6', { pausas: 6 }],
    ['leituraAntes `processando`', { leituraAntes: 'processando' }],
    ['envioIncerto as a string', { envioIncerto: 'false' }],
  ])('refuses %s (strict)', (_r, extra) => {
    expect(tarefaNfeAmazonSchema.safeParse({ ...inicial(), ...extra }).success).toBe(false);
  });

  it('refuses a payload missing any field (every field is required)', () => {
    for (const chave of Object.keys(inicial())) {
      const p: Record<string, unknown> = { ...inicial() };
      delete p[chave];
      expect(tarefaNfeAmazonSchema.safeParse(p).success, chave).toBe(false);
    }
  });
});

describe('the copy rules (★ mutation 26: a chain builder resetting reenvios)', () => {
  it('tarefaInicialNfeAmazon mints envio, rung 0, nothing spent', () => {
    expect(inicial()).toEqual({
      pedidoId: PEDIDO_ID,
      nfeId: NFE_ID,
      fase: 'envio',
      degrau: 0,
      envioIncerto: false,
      reenvios: 0,
      leituraAntes: null,
      pausas: 0,
    });
  });

  it('tarefaInicialNfeAmazon refuses an id outside its grammar, naming no value', () => {
    expect(() => tarefaInicialNfeAmazon('abc', NFE_ID)).toThrow(RangeError);
    expect(() => tarefaInicialNfeAmazon(PEDIDO_ID, 'a/b')).toThrow(RangeError);
    try {
      tarefaInicialNfeAmazon(PEDIDO_ID, 'segredo/x');
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      expect(err.message).not.toContain('segredo');
    }
  });

  it('★ aposEnvioNfeAmazon: verification rung 0, leituraAntes = the planned-on reading, reenvios COPIED', () => {
    const envio = inicial();
    expect(aposEnvioNfeAmazon(envio, LEITURA_ANTES_NFE_AMAZON.recusada, false)).toEqual({
      ...envio,
      fase: 'verificacao',
      degrau: 0,
      envioIncerto: false,
      reenvios: 0,
      leituraAntes: 'recusada',
      pausas: 0,
    });
    // A dispatch that did not submit (it read `processando`) carries no reading.
    expect(aposEnvioNfeAmazon(envio, null, false).leituraAntes).toBeNull();
    expect(aposEnvioNfeAmazon(envio, LEITURA_ANTES_NFE_AMAZON.semNota, true).envioIncerto).toBe(
      true,
    );
  });

  it('★ aposEnvioNfeAmazon from a reenvios-1 payload KEEPS 1 (the resubmit is never forgotten)', () => {
    const reenvio = reenvioNfeAmazon(verificacao(2, { incerto: true }));
    expect(reenvio?.reenvios).toBe(1);
    if (reenvio === null) throw new Error('anti-vacuity');
    expect(aposEnvioNfeAmazon(reenvio, LEITURA_ANTES_NFE_AMAZON.semNota, true).reenvios).toBe(1);
    expect(aposEnvioNfeAmazon(reenvio, LEITURA_ANTES_NFE_AMAZON.semNota, false).reenvios).toBe(1);
  });

  it('★ proximoDegrauNfeAmazon keeps reenvios, leituraAntes and envioIncerto; resets pausas; climbs one rung', () => {
    const t = { ...verificacao(2, { incerto: true, reenvios: 1, leitura: 'recusada' }) };
    const pausada = pausaNfeAmazon(t);
    if (pausada === null) throw new Error('anti-vacuity');
    expect(pausada.pausas).toBe(1);
    expect(proximoDegrauNfeAmazon(pausada)).toEqual({
      ...t,
      degrau: 3,
      pausas: 0,
      reenvios: 1,
      leituraAntes: 'recusada',
      envioIncerto: true,
    });
  });

  it('proximoDegrauNfeAmazon answers null at the last rung (the ladder’s end is the caller’s)', () => {
    expect(proximoDegrauNfeAmazon(verificacao(8))?.degrau).toBe(9);
    expect(proximoDegrauNfeAmazon(verificacao(9))).toBeNull();
  });

  it('★ reenvioNfeAmazon is the chain’s ONE resubmit: envio, reenvios 1, rung 0 — and null once spent', () => {
    const t = verificacao(2, { incerto: true });
    expect(reenvioNfeAmazon(t)).toEqual({
      pedidoId: PEDIDO_ID,
      nfeId: NFE_ID,
      fase: 'envio',
      degrau: 0,
      envioIncerto: false,
      reenvios: 1,
      leituraAntes: null,
      pausas: 0,
    });
    // ★ mutation 12: a second resubmit is never built.
    expect(reenvioNfeAmazon(verificacao(2, { incerto: true, reenvios: 1 }))).toBeNull();
  });

  it('★ reenvioNfeAmazon is the ONLY builder yielding reenvios 1 from a reenvios-0 payload', () => {
    const t0 = verificacao(2, { incerto: true });
    expect(t0.reenvios).toBe(0);
    const outros = [
      aposEnvioNfeAmazon(inicial(), LEITURA_ANTES_NFE_AMAZON.semNota, true),
      proximoDegrauNfeAmazon(t0),
      pausaNfeAmazon(t0),
      pausaNfeAmazon(inicial()),
    ];
    for (const p of outros) expect(p?.reenvios).toBe(0);
    expect(reenvioNfeAmazon(t0)?.reenvios).toBe(1);
  });

  it('★ pausaNfeAmazon keeps everything (fase and rung included) and adds 1; null at the bound', () => {
    const t = verificacao(4, { incerto: true, reenvios: 1 });
    expect(pausaNfeAmazon(t)).toEqual({ ...t, pausas: 1 });
    let p: TarefaNfeAmazon | null = t;
    for (let i = 0; i < PAUSAS_NFE_AMAZON_S.length; i++) p = p === null ? null : pausaNfeAmazon(p);
    expect(p?.pausas).toBe(5);
    expect(p === null ? 'nulo' : pausaNfeAmazon(p)).toBeNull();
  });

  it('a rung or fase change resets pausas to 0', () => {
    const envioPausado = pausaNfeAmazon(inicial());
    if (envioPausado === null) throw new Error('anti-vacuity');
    expect(aposEnvioNfeAmazon(envioPausado, null, false).pausas).toBe(0);
    const verifPausada = pausaNfeAmazon(verificacao(2, { incerto: true }));
    if (verifPausada === null) throw new Error('anti-vacuity');
    expect(proximoDegrauNfeAmazon(verifPausada)?.pausas).toBe(0);
    expect(reenvioNfeAmazon(verifPausada)?.pausas).toBe(0);
  });

  it('a builder handed the wrong fase is a programming error (RangeError)', () => {
    expect(() => aposEnvioNfeAmazon(verificacao(0), null, false)).toThrow(RangeError);
    expect(() => proximoDegrauNfeAmazon(inicial())).toThrow(RangeError);
    expect(() => reenvioNfeAmazon(inicial())).toThrow(RangeError);
  });

  it('every builder output is a NEW object: the incoming payload is never mutated', () => {
    const t = verificacao(2, { incerto: true });
    const copia = { ...t };
    proximoDegrauNfeAmazon(t);
    reenvioNfeAmazon(t);
    pausaNfeAmazon(t);
    expect(t).toEqual(copia);
  });
});
