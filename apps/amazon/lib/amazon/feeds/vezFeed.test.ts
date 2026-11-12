/**
 * The feed lease's pure state machine (step 12a, PR 12-b): the classification
 * table, the turned-away routing, the breaker and its half-open probe, the
 * submission floor, every transition's holder check, the pending start's
 * MIN-merge and consumption, and the release table.
 */
import {
  ESTADO_VEZ_FEED_AMAZON,
  type EstadoVezFeedAmazon,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
  vezFeedAmazonSchema,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import {
  ESPACO_MINIMO_ENTRE_FEEDS_MS,
  ESPERA_LOTE_EM_VEZ_S,
  ESPERA_MAXIMA_ATRAS_DE_FEED_MS,
  ESPERA_SONDA_DISJUNTOR_MS,
  MAX_FALHAS_SEGUIDAS_FEED,
} from './provedorLote';
import { PRAZO_FEED_MS } from './registroFeed';
import {
  type LoteFeedAmazon,
  type TarefaEnviarFeedAmazon,
  tarefaEnviarFeedAmazonSchema,
} from './tarefaLote';
import {
  CLASSE_DO_LOTE,
  CONSUMO_DO_PENDENTE,
  DESTINO_DO_LOTE,
  type DestinoDoLoteFeed,
  type DisjuntorFeed,
  type DonoDaVezFeed,
  ESTADO_DO_DISJUNTOR,
  LIBERACAO_VEZ_FEED,
  type LiberacaoVezFeed,
  MOTIVO_REPASSE_LOTE,
  type MotivoRepasseLote,
  RECUSA_DA_VEZ,
  REGRA_DA_LIBERACAO,
  TOMADA_DA_VEZ,
  type TipoTomadaDaVez,
  type TomadaDaVezFeed,
  VALIDADE_VEZ_ENVIADO_MS,
  VALIDADE_VEZ_MS,
  classeDoLote,
  consumirPendenteVez,
  decidirLiberacao,
  decidirTomadaDaVez,
  destinoDoLoteRecusado,
  disjuntorDaVez,
  estadoDoDisjuntor,
  expirarIncertoVez,
  faseDaVez,
  marcarEnviadoVez,
  marcarEnviandoVez,
  mesclarPendente,
  registrarPendenteVez,
  tomarVez,
  voltarParaMontandoVez,
} from './vezFeed';

const AGORA = 1_800_000_000_000;
const SEG = 1_000;
const MIN = 60_000;
const HORA = 3_600_000;
const EU = 'execucao-eu';
const OUTRO = 'execucao-outro';
const FEED = '50001';
const OUTRO_FEED = '50002';
const CONTA = 'conta-teste';

const E = ESTADO_VEZ_FEED_AMAZON;
const T = TOMADA_DA_VEZ;
const D = DESTINO_DO_LOTE;
const L = LIBERACAO_VEZ_FEED;

/** A stored lease, parsed (so every default is filled the way a read fills it). */
function vez(campos: Record<string, unknown>): VezFeedAmazon {
  return vezFeedAmazonSchema.parse({ atualizadoEmMs: AGORA - MIN, ...campos });
}

/** A lease the transitions would have written for `estado` (with or without a feedId). */
function vezEm(estado: EstadoVezFeedAmazon, extras: Record<string, unknown> = {}): VezFeedAmazon {
  const emCurso = estado !== E.livre;
  const enviou = estado === E.enviando || estado === E.enviado;
  return vez({
    estado,
    execucaoId: OUTRO,
    feedId: estado === E.enviado ? FEED : null,
    snapshotEmMs: enviou ? AGORA - 6 * MIN : null,
    antesDoEnvioMs: enviou ? AGORA - 5 * MIN : null,
    mensagens: enviou ? 40 : null,
    bytes: enviou ? 9_000 : null,
    ateMs: emCurso ? AGORA + MIN : AGORA - HORA,
    ...extras,
  });
}

/** The stored lease after a patch (field update: absent keys are kept). */
function aplicar(armazenada: VezFeedAmazon, escrever: Partial<VezFeedAmazon>): VezFeedAmazon {
  return vezFeedAmazonSchema.parse({ ...armazenada, ...escrever });
}

const BLOCOS: LoteFeedAmazon = {
  tipo: TIPO_LOTE_FEED_AMAZON.blocos,
  partes: 2,
  esperaAteMs: AGORA + 6 * HORA,
};

/** A TICK-born window batch: no commit filter, no wait. */
const TICK: LoteFeedAmazon = {
  tipo: TIPO_LOTE_FEED_AMAZON.janela,
  desdeMs: 900,
  ateMs: 5_000,
  manterDesdeMs: 900,
  commitAposMs: null,
  esperaAteMs: null,
  depositoId: 'deposito-1',
};

/** A RECOVERY-born window batch: a commit filter, and a bounded wait. */
const RECUPERACAO: LoteFeedAmazon = {
  tipo: TIPO_LOTE_FEED_AMAZON.janela,
  desdeMs: 700,
  ateMs: 5_000,
  manterDesdeMs: 800,
  commitAposMs: 750,
  esperaAteMs: AGORA + HORA,
  depositoId: 'deposito-1',
};

function tarefa(lote: LoteFeedAmazon, execucaoId = EU): TarefaEnviarFeedAmazon {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: 'feed-enviar',
    fluxo: 'estoque',
    contaId: CONTA,
    execucaoId,
    origem: 'delta',
    lote,
  });
}

const FECHADO: DisjuntorFeed = { falhasSeguidas: 0, ultimaFalhaEmMs: null };
const ABERTO: DisjuntorFeed = { falhasSeguidas: 3, ultimaFalhaEmMs: AGORA - 59 * MIN };
const SONDA: DisjuntorFeed = { falhasSeguidas: 3, ultimaFalhaEmMs: AGORA - 60 * MIN };

/* ================================== the phase ================================= */

describe('faseDaVez — a known feedId is never submitted over', () => {
  it('livre is free whatever it holds; a feedId makes any other estado behave as enviado', () => {
    const casos: [EstadoVezFeedAmazon, string | null, EstadoVezFeedAmazon][] = [
      [E.livre, null, E.livre],
      [E.livre, FEED, E.livre],
      [E.montando, null, E.montando],
      [E.montando, FEED, E.enviado],
      [E.enviando, null, E.enviando],
      [E.enviando, FEED, E.enviado],
      [E.enviado, FEED, E.enviado],
      [E.enviado, null, E.enviando],
    ];
    for (const [estado, feedId, fase] of casos) {
      expect(faseDaVez(vezEm(estado, { feedId })), `${estado} + ${String(feedId)}`).toBe(fase);
    }
  });
});

/* ============================== the classification ============================ */

describe('★ decidirTomadaDaVez — every (estado × expired × feedId × own run) tuple', () => {
  // The holder's feed (when it has one) was submitted 5 min ago: young, so
  // only the expiry, the feedId and the run decide.
  type Linha = [EstadoVezFeedAmazon, boolean, boolean, boolean, TipoTomadaDaVez];
  const tabela: Linha[] = [
    // estado, vencida, feedId, própria → classificação
    [E.livre, false, false, false, T.tomar],
    [E.livre, false, true, false, T.tomar],
    [E.livre, true, false, false, T.tomar],
    [E.livre, true, true, false, T.tomar],
    [E.livre, false, false, true, T.tomar],
    [E.livre, false, true, true, T.tomar],
    [E.livre, true, false, true, T.tomar],
    [E.livre, true, true, true, T.tomar],
    [E.montando, false, false, false, T.ocupada],
    [E.montando, false, true, false, T.ocupada],
    [E.montando, true, false, false, T.tomar],
    [E.montando, true, true, false, T.adotarResultado],
    [E.montando, false, false, true, T.retomar],
    [E.montando, false, true, true, T.retomarConsulta],
    [E.montando, true, false, true, T.retomar],
    [E.montando, true, true, true, T.retomarConsulta],
    [E.enviando, false, false, false, T.ocupada],
    [E.enviando, false, true, false, T.ocupada],
    [E.enviando, true, false, false, T.incertaAguardar],
    [E.enviando, true, true, false, T.adotarResultado],
    [E.enviando, false, false, true, T.garantirIncerto],
    [E.enviando, false, true, true, T.retomarConsulta],
    [E.enviando, true, false, true, T.garantirIncerto],
    [E.enviando, true, true, true, T.retomarConsulta],
    [E.enviado, false, false, false, T.ocupada],
    [E.enviado, false, true, false, T.ocupada],
    [E.enviado, true, false, false, T.incertaAguardar],
    [E.enviado, true, true, false, T.adotarResultado],
    [E.enviado, false, false, true, T.garantirIncerto],
    [E.enviado, false, true, true, T.retomarConsulta],
    [E.enviado, true, false, true, T.garantirIncerto],
    [E.enviado, true, true, true, T.retomarConsulta],
  ];

  it('the table covers all 32 tuples exactly once', () => {
    const chaves = new Set(tabela.map(([e, v, f, p]) => `${e}|${v}|${f}|${p}`));
    expect(chaves.size).toBe(32);
  });

  it.each(tabela)(
    '%s, vencida %s, feedId %s, própria %s ⇒ %s',
    (estado, vencida, comFeed, propria, esperado) => {
      const armazenada = vezEm(estado, {
        feedId: comFeed ? FEED : null,
        antesDoEnvioMs: AGORA - 5 * MIN,
        // Expired AT ateMs (inclusive); unexpired one ms before it.
        ateMs: vencida ? AGORA : AGORA + 1,
        execucaoId: OUTRO,
      });
      expect(decidirTomadaDaVez(armazenada, AGORA, propria ? OUTRO : EU).tipo).toBe(esperado);
    },
  );

  it('no document yet ⇒ tomar', () => {
    expect(decidirTomadaDaVez(null, AGORA, EU)).toEqual({ tipo: T.tomar });
  });

  it('a non-livre lease with no execucaoId is never the run’s own', () => {
    const armazenada = vezEm(E.montando, { execucaoId: null, ateMs: AGORA + 1 });
    expect(decidirTomadaDaVez(armazenada, AGORA, EU).tipo).toBe(T.ocupada);
  });

  it('a clock or an execucaoId outside its grammar is a programming error', () => {
    expect(() => decidirTomadaDaVez(null, -1, EU)).toThrow(RangeError);
    expect(() => decidirTomadaDaVez(null, 1.5, EU)).toThrow(RangeError);
    expect(() => decidirTomadaDaVez(null, AGORA, 'com espaço')).toThrow(RangeError);
  });
});

describe('★ the uncertain holder: never taken over before antesDoEnvioMs + 12 h', () => {
  const ANTES = AGORA - 20 * HORA;
  const incerta = vezEm(E.enviando, { antesDoEnvioMs: ANTES, ateMs: ANTES + 10 * MIN });

  it('11 h 59 min ⇒ incerta-aguardar; 12 h − 1 ms ⇒ incerta-aguardar; 12 h ⇒ incerta-recuperar (inclusive)', () => {
    expect(decidirTomadaDaVez(incerta, ANTES + 11 * HORA + 59 * MIN, EU).tipo).toBe(
      T.incertaAguardar,
    );
    expect(decidirTomadaDaVez(incerta, ANTES + PRAZO_FEED_MS - 1, EU).tipo).toBe(T.incertaAguardar);
    expect(decidirTomadaDaVez(incerta, ANTES + PRAZO_FEED_MS, EU).tipo).toBe(T.incertaRecuperar);
    expect(decidirTomadaDaVez(incerta, ANTES + 30 * HORA, EU).tipo).toBe(T.incertaRecuperar);
  });

  it('NEAR-MISS: an unexpired enviando is ocupada, however old its stamp', () => {
    const viva = vezEm(E.enviando, { antesDoEnvioMs: ANTES, ateMs: AGORA + 1 });
    expect(decidirTomadaDaVez(viva, AGORA, EU).tipo).toBe(T.ocupada);
    // Also without its stamp: a live holder is ocupada, never uncertain.
    const vivaSemCarimbo = vezEm(E.enviando, { antesDoEnvioMs: null, ateMs: AGORA + 1 });
    expect(decidirTomadaDaVez(vivaSemCarimbo, AGORA, EU).tipo).toBe(T.ocupada);
  });

  it('without its stamp the wait cannot be measured: incerta-aguardar, never a take', () => {
    const semCarimbo = vezEm(E.enviando, { antesDoEnvioMs: null, ateMs: AGORA - HORA });
    expect(decidirTomadaDaVez(semCarimbo, AGORA + 100 * HORA, EU).tipo).toBe(T.incertaAguardar);
  });
});

describe('★ ocupada vs ocupada-lenta vs ocupada-vencida (another run’s enviado, unexpired)', () => {
  const ANTES = AGORA;
  const enviado = vezEm(E.enviado, {
    antesDoEnvioMs: ANTES,
    ateMs: ANTES + VALIDADE_VEZ_ENVIADO_MS,
  });

  it('30 min − 1 ms ⇒ ocupada; 30 min ⇒ lenta; 12 h − 1 ms ⇒ lenta; 12 h ⇒ vencida (inclusive on the later class)', () => {
    const em = (ms: number) => decidirTomadaDaVez(enviado, ANTES + ms, EU).tipo;
    expect(ESPERA_MAXIMA_ATRAS_DE_FEED_MS).toBe(30 * MIN);
    expect(em(0)).toBe(T.ocupada);
    expect(em(30 * MIN - 1)).toBe(T.ocupada);
    expect(em(30 * MIN)).toBe(T.ocupadaLenta);
    expect(em(12 * HORA - 1)).toBe(T.ocupadaLenta);
    expect(em(12 * HORA)).toBe(T.ocupadaVencida);
    expect(em(49 * HORA - 1)).toBe(T.ocupadaVencida);
  });

  it('expired at antesDoEnvioMs + 49 h ⇒ adotar-resultado', () => {
    expect(VALIDADE_VEZ_ENVIADO_MS).toBe(49 * HORA);
    expect(decidirTomadaDaVez(enviado, ANTES + 49 * HORA, EU).tipo).toBe(T.adotarResultado);
  });

  it('an enviado without its stamp has an unknown age: treated as overdue', () => {
    const semCarimbo = vezEm(E.enviado, { antesDoEnvioMs: null, ateMs: AGORA + HORA });
    expect(decidirTomadaDaVez(semCarimbo, AGORA, EU).tipo).toBe(T.ocupadaVencida);
    // NEAR-MISS: once EXPIRED it is adopted like any known feed, stamp or not.
    const vencidaSemCarimbo = vezEm(E.enviado, { antesDoEnvioMs: null, ateMs: AGORA });
    expect(decidirTomadaDaVez(vencidaSemCarimbo, AGORA, EU).tipo).toBe(T.adotarResultado);
  });
});

describe('★ the submission floor (aguardar-espaco)', () => {
  it('119 s after ultimoEnvioMs ⇒ aguardar-espaco with a 1-s remainder; 120 s ⇒ tomar', () => {
    expect(ESPACO_MINIMO_ENTRE_FEEDS_MS).toBe(120 * SEG);
    const livre = vezEm(E.livre, { ultimoEnvioMs: AGORA - 119 * SEG });
    expect(decidirTomadaDaVez(livre, AGORA, EU)).toEqual({ tipo: T.aguardarEspaco, restanteS: 1 });
    const passou = vezEm(E.livre, { ultimoEnvioMs: AGORA - 120 * SEG });
    expect(decidirTomadaDaVez(passou, AGORA, EU)).toEqual({ tipo: T.tomar });
  });

  it('the remainder is WHOLE seconds rounded UP, at least 1 and at most the floor', () => {
    const resto = (ultimoEnvioMs: number) => {
      const tomada = decidirTomadaDaVez(vezEm(E.livre, { ultimoEnvioMs }), AGORA, EU);
      return tomada.tipo === T.aguardarEspaco ? tomada.restanteS : null;
    };
    expect(resto(AGORA - 120 * SEG + 1)).toBe(1);
    expect(resto(AGORA - 119_500)).toBe(1);
    expect(resto(AGORA - 90 * SEG)).toBe(30);
    expect(resto(AGORA - 90 * SEG + 1)).toBe(31);
    expect(resto(AGORA - 1)).toBe(120);
    expect(resto(AGORA)).toBe(120);
    // A stamp from a clock ahead of ours never asks for more than one floor.
    expect(resto(AGORA + 10 * MIN)).toBe(120);
  });

  it('also on another run’s expired montando (any take)', () => {
    const vencida = vezEm(E.montando, { ateMs: AGORA, ultimoEnvioMs: AGORA - 10 * SEG });
    expect(decidirTomadaDaVez(vencida, AGORA, EU)).toEqual({
      tipo: T.aguardarEspaco,
      restanteS: 110,
    });
  });

  it('NEAR-MISS: never on the run’s own lease, which is not a take', () => {
    const minha = vezEm(E.montando, { execucaoId: EU, ultimoEnvioMs: AGORA - 10 * SEG });
    expect(decidirTomadaDaVez(minha, AGORA, EU).tipo).toBe(T.retomar);
  });
});

/* ================================= the breaker ================================ */

describe('estadoDoDisjuntor — open at 3, half-open an hour after the last failure', () => {
  it('fechado below 3 whatever the clock; aberto at 59 min; sonda at 60 min (inclusive)', () => {
    expect(MAX_FALHAS_SEGUIDAS_FEED).toBe(3);
    expect(ESPERA_SONDA_DISJUNTOR_MS).toBe(HORA);
    expect(estadoDoDisjuntor({ falhasSeguidas: 2, ultimaFalhaEmMs: AGORA }, AGORA)).toBe(
      ESTADO_DO_DISJUNTOR.fechado,
    );
    expect(estadoDoDisjuntor(ABERTO, AGORA)).toBe(ESTADO_DO_DISJUNTOR.aberto);
    expect(estadoDoDisjuntor(SONDA, AGORA)).toBe(ESTADO_DO_DISJUNTOR.sonda);
    expect(estadoDoDisjuntor({ falhasSeguidas: 9, ultimaFalhaEmMs: AGORA - HORA + 1 }, AGORA)).toBe(
      ESTADO_DO_DISJUNTOR.aberto,
    );
  });

  it('an open count without its clock is half-open (a count must not latch it open)', () => {
    expect(estadoDoDisjuntor({ falhasSeguidas: 3, ultimaFalhaEmMs: null }, AGORA)).toBe(
      ESTADO_DO_DISJUNTOR.sonda,
    );
  });

  it('disjuntorDaVez reads the lease; no document is closed', () => {
    expect(disjuntorDaVez(null)).toEqual(FECHADO);
    expect(
      disjuntorDaVez(vezEm(E.livre, { falhasSeguidas: 4, ultimaFalhaEmMs: AGORA - MIN })),
    ).toEqual({ falhasSeguidas: 4, ultimaFalhaEmMs: AGORA - MIN });
  });
});

/* ============================ the turned-away batch =========================== */

describe('classeDoLote', () => {
  it('block; window WITHOUT a commit filter = tick-born; WITH one = recovery-born', () => {
    expect(classeDoLote(BLOCOS)).toBe(CLASSE_DO_LOTE.blocos);
    expect(classeDoLote(TICK)).toBe(CLASSE_DO_LOTE.janelaDoTick);
    expect(classeDoLote(RECUPERACAO)).toBe(CLASSE_DO_LOTE.janelaDaRecuperacao);
  });
});

describe('★ destinoDoLoteRecusado — every (classification × batch class × breaker) cell', () => {
  const tomar: TomadaDaVezFeed = { tipo: T.tomar };
  const espaco: TomadaDaVezFeed = { tipo: T.aguardarEspaco, restanteS: 7 };
  const so = (tipo: TipoTomadaDaVez) => ({ tipo }) as TomadaDaVezFeed;
  const aguardar = (atrasoS: number): DestinoDoLoteFeed => ({ tipo: D.aguardar, atrasoS });
  const repassar = (motivo: MotivoRepasseLote): DestinoDoLoteFeed => ({
    tipo: D.repassarParaPatches,
    motivo,
  });
  const registrar: DestinoDoLoteFeed = { tipo: D.registrarPendente };
  const tomarSem: DestinoDoLoteFeed = { tipo: D.tomar, sonda: false };
  const tomarSonda: DestinoDoLoteFeed = { tipo: D.tomar, sonda: true };
  const ESPERA = aguardar(ESPERA_LOTE_EM_VEZ_S);

  const disjuntores: [string, DisjuntorFeed][] = [
    ['fechado', FECHADO],
    ['aberto', ABERTO],
    ['sonda', SONDA],
  ];
  const lotes: [string, LoteFeedAmazon][] = [
    ['blocos', BLOCOS],
    ['tick', TICK],
    ['recuperacao', RECUPERACAO],
  ];

  // [classification, lote, breaker] → destino; every batch's esperaAteMs is still ahead.
  const esperado: Record<string, DestinoDoLoteFeed> = {
    'tomar|blocos|fechado': tomarSem,
    'tomar|blocos|aberto': tomarSonda,
    'tomar|blocos|sonda': tomarSonda,
    'tomar|tick|fechado': tomarSem,
    'tomar|tick|aberto': repassar(MOTIVO_REPASSE_LOTE.disjuntor),
    'tomar|tick|sonda': tomarSonda,
    'tomar|recuperacao|fechado': tomarSem,
    'tomar|recuperacao|aberto': repassar(MOTIVO_REPASSE_LOTE.disjuntor),
    'tomar|recuperacao|sonda': tomarSonda,
    'aguardar-espaco|blocos|fechado': aguardar(7),
    'aguardar-espaco|blocos|aberto': aguardar(7),
    'aguardar-espaco|blocos|sonda': aguardar(7),
    'aguardar-espaco|tick|fechado': aguardar(7),
    'aguardar-espaco|tick|aberto': repassar(MOTIVO_REPASSE_LOTE.disjuntor),
    'aguardar-espaco|tick|sonda': aguardar(7),
    'aguardar-espaco|recuperacao|fechado': aguardar(7),
    'aguardar-espaco|recuperacao|aberto': repassar(MOTIVO_REPASSE_LOTE.disjuntor),
    'aguardar-espaco|recuperacao|sonda': aguardar(7),
  };
  for (const [nomeD] of disjuntores) {
    for (const classe of [
      T.ocupada,
      T.ocupadaLenta,
      T.ocupadaVencida,
      T.incertaAguardar,
      T.incertaRecuperar,
      T.adotarResultado,
    ]) {
      // The breaker refuses only a take: a held lease routes the same under every breaker.
      esperado[`${classe}|blocos|${nomeD}`] = ESPERA;
    }
    esperado[`${T.ocupada}|tick|${nomeD}`] = registrar;
    esperado[`${T.ocupada}|recuperacao|${nomeD}`] = ESPERA;
    for (const classe of [T.ocupadaLenta, T.ocupadaVencida, T.incertaAguardar, T.adotarResultado]) {
      esperado[`${classe}|tick|${nomeD}`] = repassar(classe);
      esperado[`${classe}|recuperacao|${nomeD}`] = repassar(classe);
    }
    esperado[`${T.incertaRecuperar}|tick|${nomeD}`] = registrar;
    esperado[`${T.incertaRecuperar}|recuperacao|${nomeD}`] = repassar(T.incertaRecuperar);
  }

  const classificacoes: TomadaDaVezFeed[] = [
    tomar,
    espaco,
    so(T.ocupada),
    so(T.ocupadaLenta),
    so(T.ocupadaVencida),
    so(T.incertaAguardar),
    so(T.incertaRecuperar),
    so(T.adotarResultado),
  ];

  it('the table covers 8 × 3 × 3 = 72 cells', () => {
    expect(Object.keys(esperado)).toHaveLength(72);
  });

  for (const tomada of classificacoes) {
    for (const [nomeL, lote] of lotes) {
      for (const [nomeD, disjuntor] of disjuntores) {
        const chave = `${tomada.tipo}|${nomeL}|${nomeD}`;
        it(chave, () => {
          expect(destinoDoLoteRecusado(tomada, lote, disjuntor, AGORA)).toEqual(esperado[chave]);
        });
      }
    }
  }

  it('NEAR-MISS: a RECOVERY-born batch on ocupada is never recorded as a bare start', () => {
    expect(destinoDoLoteRecusado(so(T.ocupada), RECUPERACAO, FECHADO, AGORA).tipo).not.toBe(
      D.registrarPendente,
    );
  });

  it('a recovery-born batch on ocupada waits until its esperaAteMs, then goes per SKU (inclusive)', () => {
    const ate = RECUPERACAO.esperaAteMs ?? 0;
    expect(destinoDoLoteRecusado(so(T.ocupada), RECUPERACAO, FECHADO, ate - 1)).toEqual(ESPERA);
    expect(destinoDoLoteRecusado(so(T.ocupada), RECUPERACAO, FECHADO, ate)).toEqual(
      repassar(MOTIVO_REPASSE_LOTE.esperaEsgotada),
    );
  });

  it('a block batch waits until its esperaAteMs, then lote-expirado — never per SKU', () => {
    for (const classe of [T.ocupada, T.ocupadaLenta, T.ocupadaVencida, T.incertaAguardar]) {
      expect(destinoDoLoteRecusado(so(classe), BLOCOS, FECHADO, BLOCOS.esperaAteMs - 1)).toEqual(
        ESPERA,
      );
      expect(destinoDoLoteRecusado(so(classe), BLOCOS, FECHADO, BLOCOS.esperaAteMs)).toEqual({
        tipo: D.loteExpirado,
      });
    }
    for (const classe of [T.incertaRecuperar, T.adotarResultado]) {
      expect(destinoDoLoteRecusado(so(classe), BLOCOS, ABERTO, BLOCOS.esperaAteMs + 1)).toEqual({
        tipo: D.loteExpirado,
      });
    }
  });

  it('a tick-born batch never waits, however its (absent) esperaAteMs reads', () => {
    expect(destinoDoLoteRecusado(so(T.ocupada), TICK, FECHADO, AGORA + 100 * HORA)).toEqual(
      registrar,
    );
  });

  it('★ the breaker on tomar: falhasSeguidas 3 at 59 min ⇒ patches, 60 min ⇒ the probe; NEAR-MISS 2 ⇒ tomar whatever the clock', () => {
    for (const lote of [TICK, RECUPERACAO]) {
      expect(destinoDoLoteRecusado(tomar, lote, ABERTO, AGORA)).toEqual(
        repassar(MOTIVO_REPASSE_LOTE.disjuntor),
      );
      expect(destinoDoLoteRecusado(tomar, lote, SONDA, AGORA)).toEqual(tomarSonda);
      expect(
        destinoDoLoteRecusado(tomar, lote, { falhasSeguidas: 2, ultimaFalhaEmMs: AGORA }, AGORA),
      ).toEqual(tomarSem);
    }
    // A block batch is never refused: 9 failures, the last one just now.
    expect(
      destinoDoLoteRecusado(tomar, BLOCOS, { falhasSeguidas: 9, ultimaFalhaEmMs: AGORA }, AGORA),
    ).toEqual(tomarSonda);
  });

  it('★ the floor end to end: 119 s after ultimoEnvioMs ⇒ aguardar 1 s; 120 s ⇒ tomar (any batch kind)', () => {
    for (const lote of [BLOCOS, TICK, RECUPERACAO]) {
      const cedo = decidirTomadaDaVez(
        vezEm(E.livre, { ultimoEnvioMs: AGORA - 119 * SEG }),
        AGORA,
        EU,
      );
      expect(destinoDoLoteRecusado(cedo, lote, FECHADO, AGORA)).toEqual(aguardar(1));
      const passou = decidirTomadaDaVez(
        vezEm(E.livre, { ultimoEnvioMs: AGORA - 120 * SEG }),
        AGORA,
        EU,
      );
      expect(destinoDoLoteRecusado(passou, lote, FECHADO, AGORA)).toEqual(tomarSem);
    }
  });

  it('a classification of the run’s OWN lease is never a turned-away batch: a programming error', () => {
    for (const tipo of [T.retomar, T.garantirIncerto, T.retomarConsulta]) {
      expect(() => destinoDoLoteRecusado(so(tipo), TICK, FECHADO, AGORA)).toThrow(RangeError);
    }
  });
});

/* ================================ the transitions ============================= */

/** The five fields that outlive each feed, set on a lease another run let expire. */
const PERSISTENTES = {
  pendenteDesdeMs: 1_000,
  falhasSeguidas: 2,
  ultimaFalhaEmMs: AGORA - 3 * HORA,
  ultimoEnvioMs: AGORA - 2 * HORA,
  ultimoFeedConcluidoEmMs: AGORA - 90 * MIN,
};
const CHAVES_PERSISTENTES = Object.keys(PERSISTENTES);

describe('★ tomarVez — livre → montando, keeping what outlives each feed', () => {
  it('no document ⇒ a whole new lease, its persistent fields empty', () => {
    const r = tomarVez(null, AGORA, tarefa(TICK));
    expect(r).toEqual({
      tipo: 'criar',
      documento: {
        estado: E.montando,
        execucaoId: EU,
        feedId: null,
        snapshotEmMs: null,
        antesDoEnvioMs: null,
        mensagens: null,
        bytes: null,
        ateMs: AGORA + VALIDADE_VEZ_MS,
        atualizadoEmMs: AGORA,
        origem: 'delta',
        tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
        janela: {
          desdeMs: 900,
          ateMs: 5_000,
          manterDesdeMs: 900,
          commitAposMs: null,
          depositoId: 'deposito-1',
        },
        pendenteDesdeMs: null,
        falhasSeguidas: 0,
        ultimaFalhaEmMs: null,
        ultimoEnvioMs: null,
        ultimoFeedConcluidoEmMs: null,
      },
    });
    expect(VALIDADE_VEZ_MS).toBe(10 * MIN);
    if (r.tipo === 'criar') expect(vezFeedAmazonSchema.parse(r.documento)).toEqual(r.documento);
  });

  it('★ over another run’s expired montando: the patch never names the five persistent fields, and they survive', () => {
    const armazenada = vezEm(E.montando, { ateMs: AGORA, ...PERSISTENTES });
    const r = tomarVez(armazenada, AGORA, tarefa(BLOCOS));
    expect(r.tipo).toBe('atualizar');
    if (r.tipo !== 'atualizar') return;
    for (const chave of CHAVES_PERSISTENTES) expect(r.escrever).not.toHaveProperty(chave);
    expect(r.escrever).toEqual({
      estado: E.montando,
      execucaoId: EU,
      feedId: null,
      snapshotEmMs: null,
      antesDoEnvioMs: null,
      mensagens: null,
      bytes: null,
      ateMs: AGORA + VALIDADE_VEZ_MS,
      atualizadoEmMs: AGORA,
      origem: 'delta',
      tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
      janela: null,
    });
    const depois = aplicar(armazenada, r.escrever);
    expect(depois).toMatchObject(PERSISTENTES);
  });

  it('a recovery-born window is stored with its commit filter (the keep rule, never the wait)', () => {
    const r = tomarVez(vezEm(E.livre), AGORA, tarefa(RECUPERACAO));
    expect(r.tipo === 'atualizar' && r.escrever.janela).toEqual({
      desdeMs: 700,
      ateMs: 5_000,
      manterDesdeMs: 800,
      commitAposMs: 750,
      depositoId: 'deposito-1',
    });
  });

  it('refuses (writes nothing) whenever the route is not tomar', () => {
    const outraRota = { tipo: 'recusado', motivo: RECUSA_DA_VEZ.outraRota };
    // Held by another run.
    expect(tomarVez(vezEm(E.montando), AGORA, tarefa(TICK))).toEqual(outraRota);
    // The run's own lease: it resumes, never re-takes.
    expect(tomarVez(vezEm(E.montando, { execucaoId: EU }), AGORA, tarefa(TICK))).toEqual(outraRota);
    // The floor.
    expect(
      tomarVez(vezEm(E.livre, { ultimoEnvioMs: AGORA - 10 * SEG }), AGORA, tarefa(BLOCOS)),
    ).toEqual(outraRota);
    // The breaker, for a window batch only.
    const aberto = vezEm(E.livre, { falhasSeguidas: 3, ultimaFalhaEmMs: AGORA - MIN });
    expect(tomarVez(aberto, AGORA, tarefa(TICK))).toEqual(outraRota);
    expect(tomarVez(aberto, AGORA, tarefa(BLOCOS)).tipo).toBe('atualizar');
  });
});

describe('★ the pending start — MIN-merged, never overwritten', () => {
  const ocupada = (pendenteDesdeMs: number | null) =>
    vezEm(E.enviando, { pendenteDesdeMs, ateMs: AGORA + MIN });
  const comDesde = (desdeMs: number) => tarefa({ ...TICK, desdeMs, manterDesdeMs: desdeMs }, EU);

  it('mesclarPendente: stored 1,000 + 900 ⇒ 900; + 1,100 ⇒ 1,000; nothing stored ⇒ the batch’s', () => {
    expect(mesclarPendente(1_000, 900)).toBe(900);
    expect(mesclarPendente(1_000, 1_100)).toBe(1_000);
    expect(mesclarPendente(null, 1_100)).toBe(1_100);
    expect(mesclarPendente(1_000, 1_000)).toBe(1_000);
  });

  it('★ stored 1,000, a batch from 900 ⇒ writes 900', () => {
    expect(registrarPendenteVez(ocupada(1_000), AGORA, comDesde(900))).toEqual({
      tipo: 'atualizar',
      escrever: { pendenteDesdeMs: 900, atualizadoEmMs: AGORA },
      pendenteDesdeMs: 900,
    });
  });

  it('★ NEAR-MISS: stored 1,000, a batch from 1,100 ⇒ 1,000 kept, nothing written (an overwrite would lose 900–1,000)', () => {
    expect(registrarPendenteVez(ocupada(1_000), AGORA, comDesde(1_100))).toEqual({
      tipo: 'nada',
      pendenteDesdeMs: 1_000,
    });
  });

  it('nothing stored ⇒ the batch’s start', () => {
    const r = registrarPendenteVez(ocupada(null), AGORA, comDesde(1_100));
    expect(r.tipo === 'atualizar' && r.escrever).toEqual({
      pendenteDesdeMs: 1_100,
      atualizadoEmMs: AGORA,
    });
  });

  it('a tick-born batch on incerta-recuperar records its start (the uncertain path folds it)', () => {
    const incerta = vezEm(E.enviando, { antesDoEnvioMs: AGORA - 13 * HORA, ateMs: AGORA - HORA });
    expect(registrarPendenteVez(incerta, AGORA, comDesde(900)).tipo).toBe('atualizar');
  });

  it('★ refused for every batch whose route is not registrar-pendente (16, 18)', () => {
    const recusa = { tipo: 'recusado', motivo: RECUSA_DA_VEZ.outraRota };
    // A recovery-born batch: never a bare start.
    expect(registrarPendenteVez(ocupada(1_000), AGORA, tarefa(RECUPERACAO))).toEqual(recusa);
    // A block batch.
    expect(registrarPendenteVez(ocupada(1_000), AGORA, tarefa(BLOCOS))).toEqual(recusa);
    // A slow, uncertain or overdue holder: the batch goes per SKU, never waits on it.
    const lenta = vezEm(E.enviado, { antesDoEnvioMs: AGORA - 31 * MIN, ateMs: AGORA + HORA });
    const incerta = vezEm(E.enviando, { antesDoEnvioMs: AGORA - HORA, ateMs: AGORA });
    const vencida = vezEm(E.enviado, { antesDoEnvioMs: AGORA - 13 * HORA, ateMs: AGORA + HORA });
    for (const holder of [lenta, incerta, vencida]) {
      expect(registrarPendenteVez(holder, AGORA, comDesde(900))).toEqual(recusa);
    }
    // A free lease is taken, not recorded on.
    expect(registrarPendenteVez(vezEm(E.livre), AGORA, comDesde(900))).toEqual(recusa);
    expect(registrarPendenteVez(null, AGORA, comDesde(900))).toEqual(recusa);
  });

  it('★ the start survives a take over an expired lease', () => {
    const vencida = vezEm(E.montando, { ateMs: AGORA, ...PERSISTENTES });
    const r = tomarVez(vencida, AGORA, tarefa(TICK));
    expect(r.tipo === 'atualizar' && aplicar(vencida, r.escrever).pendenteDesdeMs).toBe(1_000);
  });
});

describe('★ marcarEnviandoVez — montando → enviando, and the SAME attempt’s refresh re-entry', () => {
  const envio = (antesDoEnvioMs: number) => ({
    snapshotEmMs: AGORA - 4 * MIN,
    antesDoEnvioMs,
    mensagens: 40,
    bytes: 9_000,
  });

  it('the holder’s montando ⇒ enviando, stamping ultimoEnvioMs = antesDoEnvioMs', () => {
    const minha = vezEm(E.montando, { execucaoId: EU });
    expect(marcarEnviandoVez(minha, AGORA, EU, envio(AGORA - SEG), null)).toEqual({
      tipo: 'atualizar',
      escrever: {
        estado: E.enviando,
        snapshotEmMs: AGORA - 4 * MIN,
        antesDoEnvioMs: AGORA - SEG,
        mensagens: 40,
        bytes: 9_000,
        ateMs: AGORA + VALIDADE_VEZ_MS,
        atualizadoEmMs: AGORA,
        ultimoEnvioMs: AGORA - SEG,
      },
    });
  });

  it('★ enviando → enviando for the SAME run re-stamps antesDoEnvioMs; NEAR-MISS another run ⇒ refused', () => {
    const minha = vezEm(E.enviando, { execucaoId: EU, antesDoEnvioMs: AGORA - 20 * SEG });
    const r = marcarEnviandoVez(minha, AGORA, EU, envio(AGORA), AGORA - 20 * SEG);
    expect(r.tipo).toBe('atualizar');
    if (r.tipo === 'atualizar') {
      expect(r.escrever.antesDoEnvioMs).toBe(AGORA);
      expect(r.escrever.ultimoEnvioMs).toBe(AGORA);
    }
    // Another run, even one naming the stored stamp.
    const alheia = vezEm(E.enviando, { execucaoId: OUTRO });
    expect(marcarEnviandoVez(alheia, AGORA, EU, envio(AGORA), AGORA - 5 * MIN)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroDono,
    });
    expect(
      marcarEnviandoVez(vezEm(E.montando, { execucaoId: OUTRO }), AGORA, EU, envio(AGORA), null),
    ).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroDono,
    });
  });

  it('★ NEAR-MISS: the re-entry is the ATTEMPT’s — a copy of the same payload that never stamped, or that names another stamp, is refused', () => {
    const minha = vezEm(E.enviando, {
      execucaoId: EU,
      antesDoEnvioMs: AGORA - 20 * SEG,
      ateMs: AGORA + 9 * MIN,
    });
    const recusada = { tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroEstado };
    // A copy that resumed a montando lease and built while another copy submitted.
    expect(marcarEnviandoVez(minha, AGORA, EU, envio(AGORA), null)).toEqual(recusada);
    expect(marcarEnviandoVez(minha, AGORA, EU, envio(AGORA), AGORA - 21 * SEG)).toEqual(recusada);
    // An attempt that stamped never takes a montando lease again.
    const montando = vezEm(E.montando, { execucaoId: EU });
    expect(marcarEnviandoVez(montando, AGORA, EU, envio(AGORA), AGORA - 20 * SEG)).toEqual(
      recusada,
    );
  });

  it('★ NEAR-MISS: never after the uncertain outcome — its own stamp is refused once the lease expired in place (no second createFeed)', () => {
    const ANTES = AGORA - 30 * SEG;
    const minha = vezEm(E.enviando, {
      execucaoId: EU,
      antesDoEnvioMs: ANTES,
      ateMs: AGORA + 9 * MIN,
    });
    const incerta = expirarIncertoVez(minha, AGORA, EU);
    if (incerta.tipo !== 'atualizar') throw new Error('esperado atualizar');
    const depois = aplicar(minha, incerta.escrever);
    expect(marcarEnviandoVez(depois, AGORA + SEG, EU, envio(AGORA + SEG), ANTES)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroEstado,
    });
    // So every other run still reads the uncertain lease, never a live holder.
    expect(decidirTomadaDaVez(depois, AGORA + MIN, OUTRO).tipo).toBe(T.incertaAguardar);
    // The boundary: live 1 ms before its ateMs, expired AT it.
    const viva = vezEm(E.enviando, { execucaoId: EU, antesDoEnvioMs: ANTES, ateMs: AGORA + 1 });
    expect(marcarEnviandoVez(viva, AGORA, EU, envio(AGORA), ANTES).tipo).toBe('atualizar');
    const noLimite = vezEm(E.enviando, { execucaoId: EU, antesDoEnvioMs: ANTES, ateMs: AGORA });
    expect(marcarEnviandoVez(noLimite, AGORA, EU, envio(AGORA), ANTES).tipo).toBe('recusado');
  });

  it('refused from a known feed, from a free lease, or with no document', () => {
    expect(
      marcarEnviandoVez(
        vezEm(E.enviado, { execucaoId: EU }),
        AGORA,
        EU,
        envio(AGORA),
        AGORA - 5 * MIN,
      ),
    ).toEqual({ tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroEstado });
    expect(
      marcarEnviandoVez(
        vezEm(E.enviando, { execucaoId: EU, feedId: FEED }),
        AGORA,
        EU,
        envio(AGORA),
        AGORA - 5 * MIN,
      ),
    ).toEqual({ tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroEstado });
    expect(
      marcarEnviandoVez(vezEm(E.livre, { execucaoId: EU }), AGORA, EU, envio(AGORA), null),
    ).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.livre,
    });
    expect(marcarEnviandoVez(null, AGORA, EU, envio(AGORA), null)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.livre,
    });
  });

  it('a stamp that is not a ms instant, or an empty document, is a programming error', () => {
    const minha = vezEm(E.montando, { execucaoId: EU });
    expect(() =>
      marcarEnviandoVez(minha, AGORA, EU, { ...envio(AGORA), mensagens: 0 }, null),
    ).toThrow(RangeError);
    expect(() => marcarEnviandoVez(minha, AGORA, EU, { ...envio(AGORA), bytes: 0 }, null)).toThrow(
      RangeError,
    );
    expect(() => marcarEnviandoVez(minha, AGORA, EU, envio(-1), null)).toThrow(RangeError);
    expect(() => marcarEnviandoVez(minha, AGORA, EU, envio(AGORA), 1.5)).toThrow(RangeError);
  });
});

describe('marcarEnviadoVez — enviando → enviado, holding until antesDoEnvioMs + 49 h', () => {
  const minha = vezEm(E.enviando, { execucaoId: EU, antesDoEnvioMs: AGORA - SEG });

  it('names the feedId', () => {
    expect(marcarEnviadoVez(minha, AGORA, EU, FEED)).toEqual({
      tipo: 'atualizar',
      escrever: {
        estado: E.enviado,
        feedId: FEED,
        ateMs: AGORA - SEG + 49 * HORA,
        atualizadoEmMs: AGORA,
      },
    });
  });

  it('refused for another run, or from montando', () => {
    expect(marcarEnviadoVez(vezEm(E.enviando), AGORA, EU, FEED)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroDono,
    });
    expect(marcarEnviadoVez(vezEm(E.montando, { execucaoId: EU }), AGORA, EU, FEED)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroEstado,
    });
  });

  it('NEAR-MISS: refused from a montando that carries a stamp, and over an already-named feed', () => {
    const montandoComCarimbo = vezEm(E.montando, { execucaoId: EU, antesDoEnvioMs: AGORA - SEG });
    expect(marcarEnviadoVez(montandoComCarimbo, AGORA, EU, FEED)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroEstado,
    });
    // The run's own feed is already named: a second answer never renames it.
    const jaNomeado = vezEm(E.enviado, { execucaoId: EU, feedId: FEED });
    expect(marcarEnviadoVez(jaNomeado, AGORA, EU, OUTRO_FEED)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroEstado,
    });
  });

  it('a feedId outside its grammar is a programming error', () => {
    expect(() => marcarEnviadoVez(minha, AGORA, EU, 'feed-1')).toThrow(RangeError);
  });
});

describe('★ expirarIncertoVez — the uncertain outcome expires the lease AT ONCE', () => {
  const minha = vezEm(E.enviando, {
    execucaoId: EU,
    antesDoEnvioMs: AGORA - 5 * SEG,
    ateMs: AGORA + 9 * MIN,
    pendenteDesdeMs: 1_000,
  });

  it('ateMs = agora, still enviando, still no feedId; the read’s start handed to a vez recovery', () => {
    const r = expirarIncertoVez(minha, AGORA, EU);
    expect(r).toEqual({
      tipo: 'atualizar',
      escrever: { ateMs: AGORA, atualizadoEmMs: AGORA, pendenteDesdeMs: null },
      pendenteDesdeMs: 1_000,
      vezPara: 1_000,
    });
  });

  it('★ every other run then reads incerta-aguardar at once, and a window batch goes per SKU (mutation 5)', () => {
    const r = expirarIncertoVez(minha, AGORA, EU);
    if (r.tipo !== 'atualizar') throw new Error('esperado atualizar');
    const depois = aplicar(minha, r.escrever);
    expect(depois.estado).toBe(E.enviando);
    expect(depois.feedId).toBeNull();
    const umMinutoDepois = AGORA + MIN;
    const tomada = decidirTomadaDaVez(depois, umMinutoDepois, OUTRO);
    expect(tomada.tipo).toBe(T.incertaAguardar);
    expect(destinoDoLoteRecusado(tomada, TICK, FECHADO, umMinutoDepois)).toEqual({
      tipo: D.repassarParaPatches,
      motivo: MOTIVO_REPASSE_LOTE.incertaAguardar,
    });
    // NEAR-MISS: left unexpired, the same batch would be recorded and held.
    const tomadaSemExpirar = decidirTomadaDaVez(minha, umMinutoDepois, OUTRO);
    expect(destinoDoLoteRecusado(tomadaSemExpirar, TICK, FECHADO, umMinutoDepois).tipo).toBe(
      D.registrarPendente,
    );
    // Never taken over before the 12 h.
    expect(decidirTomadaDaVez(depois, AGORA + 11 * HORA, OUTRO).tipo).toBe(T.incertaAguardar);
  });

  it('refused for another run, or once the feed is known', () => {
    expect(expirarIncertoVez(minha, AGORA, OUTRO)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroDono,
    });
    expect(expirarIncertoVez(vezEm(E.enviado, { execucaoId: EU }), AGORA, EU)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroEstado,
    });
  });
});

describe('voltarParaMontandoVez — a 429: not processed', () => {
  it('enviando → montando, the submission cleared, ultimoEnvioMs kept', () => {
    const minha = vezEm(E.enviando, { execucaoId: EU, ultimoEnvioMs: AGORA - SEG });
    const r = voltarParaMontandoVez(minha, AGORA, EU);
    expect(r).toEqual({
      tipo: 'atualizar',
      escrever: {
        estado: E.montando,
        feedId: null,
        snapshotEmMs: null,
        antesDoEnvioMs: null,
        mensagens: null,
        bytes: null,
        ateMs: AGORA + VALIDADE_VEZ_MS,
        atualizadoEmMs: AGORA,
      },
    });
    if (r.tipo === 'atualizar') expect(aplicar(minha, r.escrever).ultimoEnvioMs).toBe(AGORA - SEG);
  });

  it('refused for another run or another state', () => {
    expect(voltarParaMontandoVez(vezEm(E.enviando), AGORA, EU)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroDono,
    });
    expect(voltarParaMontandoVez(vezEm(E.montando, { execucaoId: EU }), AGORA, EU)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroEstado,
    });
  });
});

describe('★ a KNOWN feedId is never reverted by a transition keyed on the run', () => {
  // The run's OWN lease, naming a feed: the normal enviado, and the crossing
  // enviando + feedId (written by no transition; it behaves as enviado).
  const comFeed: [string, VezFeedAmazon][] = [
    ['enviado + feedId', vezEm(E.enviado, { execucaoId: EU, feedId: FEED })],
    ['enviando + feedId', vezEm(E.enviando, { execucaoId: EU, feedId: FEED })],
  ];
  const transicoes: [string, (v: VezFeedAmazon) => { readonly tipo: string }][] = [
    [
      'marcarEnviandoVez',
      (v) =>
        marcarEnviandoVez(
          v,
          AGORA,
          EU,
          { snapshotEmMs: AGORA - MIN, antesDoEnvioMs: AGORA, mensagens: 1, bytes: 1 },
          v.antesDoEnvioMs,
        ),
    ],
    ['marcarEnviadoVez', (v) => marcarEnviadoVez(v, AGORA, EU, OUTRO_FEED)],
    ['expirarIncertoVez', (v) => expirarIncertoVez(v, AGORA, EU)],
    ['voltarParaMontandoVez', (v) => voltarParaMontandoVez(v, AGORA, EU)],
  ];

  it.each(transicoes.flatMap(([n, f]) => comFeed.map(([l, v]) => [n, l, f, v] as const)))(
    '%s over the run’s own %s ⇒ outro-estado, nothing written',
    (_n, _l, transicao, armazenada) => {
      expect(transicao(armazenada)).toEqual({
        tipo: 'recusado',
        motivo: RECUSA_DA_VEZ.outroEstado,
      });
    },
  );
});

/* ================================= the releases =============================== */

/** Every release kind, with the phase its holder holds and what it does to the counts. */
type Efeito = 'zera' | 'soma' | 'mantem';
const LIBERACOES: [LiberacaoVezFeed, EstadoVezFeedAmazon, Efeito, boolean][] = [
  // kind, phase, falhasSeguidas, stamps ultimoFeedConcluidoEmMs
  [L.concluido, E.enviado, 'zera', true],
  [L.falhou, E.enviado, 'soma', true],
  [L.cancelado, E.enviado, 'soma', false],
  [L.abandonado, E.enviado, 'soma', true],
  [L.incerto, E.enviando, 'soma', true],
  [L.recusaDefinitiva, E.enviando, 'soma', false],
  [L.documentoFalhou, E.montando, 'soma', false],
  [L.snapshotLento, E.montando, 'soma', false],
  [L.documentoTransitorio, E.montando, 'mantem', false],
  [L.depositoMudou, E.montando, 'mantem', false],
  [L.janelaGrande, E.montando, 'mantem', false],
  [L.semEscrita, E.montando, 'mantem', false],
  [L.simulado, E.montando, 'mantem', false],
  [L.desligado, E.montando, 'mantem', false],
  [L.soPatches, E.montando, 'mantem', false],
  [L.limitado, E.montando, 'mantem', false],
];

/** The lease a release of that phase finds, held by this run (and, once known, by FEED). */
function emPosse(fase: EstadoVezFeedAmazon): VezFeedAmazon {
  return vezEm(fase, {
    execucaoId: EU,
    feedId: fase === E.enviado ? FEED : null,
    // Old enough for the uncertain release's 12-h wait.
    antesDoEnvioMs: fase === E.montando ? null : AGORA - 13 * HORA,
    ateMs: fase === E.enviando ? AGORA - 12 * HORA : AGORA + HORA,
    origem: 'delta',
    tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
    janela: { desdeMs: 900, ateMs: 5_000, manterDesdeMs: 900, commitAposMs: null, depositoId: 'd' },
    ...PERSISTENTES,
    ultimoEnvioMs: AGORA - 10 * SEG,
  });
}

function donoDe(fase: EstadoVezFeedAmazon): DonoDaVezFeed {
  return fase === E.enviado ? { feedId: FEED } : { execucaoId: EU };
}

const OPCOES = { agoraMs: AGORA, pendenteDobrado: null };

describe('★ decidirLiberacao — the release table, total', () => {
  it('REGRA_DA_LIBERACAO has exactly one row per release kind, and this table names them all', () => {
    expect(Object.keys(REGRA_DA_LIBERACAO).sort()).toEqual(
      Object.values(LIBERACAO_VEZ_FEED).sort(),
    );
    expect(LIBERACOES.map(([k]) => k).sort()).toEqual(Object.values(LIBERACAO_VEZ_FEED).sort());
  });

  it.each(LIBERACOES)(
    '%s (from %s): falhasSeguidas %s, ultimoFeedConcluidoEmMs stamped %s',
    (liberacao, fase, efeito, conclui) => {
      const armazenada = emPosse(fase);
      const r = decidirLiberacao(armazenada, donoDe(fase), liberacao, OPCOES);
      expect(r.tipo).toBe('atualizar');
      if (r.tipo !== 'atualizar') return;
      const falhas = { zera: 0, soma: 3, mantem: 2 }[efeito];
      expect(r.falhasSeguidas).toBe(falhas);
      expect(r.ultimaFalhaEmMs).toBe(efeito === 'soma' ? AGORA : PERSISTENTES.ultimaFalhaEmMs);
      // The patch: free, every in-flight field cleared, the start consumed.
      expect(r.escrever).toMatchObject({
        estado: E.livre,
        feedId: null,
        snapshotEmMs: null,
        antesDoEnvioMs: null,
        mensagens: null,
        bytes: null,
        origem: null,
        tipoLote: null,
        janela: null,
        ateMs: AGORA,
        atualizadoEmMs: AGORA,
        pendenteDesdeMs: null,
      });
      // Only what changes is written.
      if (efeito === 'mantem') {
        expect(r.escrever).not.toHaveProperty('falhasSeguidas');
        expect(r.escrever).not.toHaveProperty('ultimaFalhaEmMs');
      } else {
        expect(r.escrever.falhasSeguidas).toBe(falhas);
      }
      if (efeito === 'soma') expect(r.escrever.ultimaFalhaEmMs).toBe(AGORA);
      if (efeito === 'zera') expect(r.escrever).not.toHaveProperty('ultimaFalhaEmMs');
      if (conclui) expect(r.escrever.ultimoFeedConcluidoEmMs).toBe(AGORA);
      else expect(r.escrever).not.toHaveProperty('ultimoFeedConcluidoEmMs');
      // Never the floor's clock, never the run's id.
      expect(r.escrever).not.toHaveProperty('ultimoEnvioMs');
      expect(r.escrever).not.toHaveProperty('execucaoId');
      const depois = aplicar(armazenada, r.escrever);
      expect(depois.ultimoEnvioMs).toBe(AGORA - 10 * SEG);
      expect(depois.execucaoId).toBe(EU);
      expect(depois.ultimoFeedConcluidoEmMs).toBe(
        conclui ? AGORA : PERSISTENTES.ultimoFeedConcluidoEmMs,
      );
    },
  );

  it('★ the start comes from the READ, never from the write (stored 1,000, the patch null)', () => {
    const r = decidirLiberacao(emPosse(E.enviado), { feedId: FEED }, L.falhou, OPCOES);
    expect(
      r.tipo === 'atualizar' && [r.pendenteDesdeMs, r.vezPara, r.escrever.pendenteDesdeMs],
    ).toEqual([1_000, 1_000, null]);
  });

  it('★ NEAR-MISS: nothing stored ⇒ no vez', () => {
    const semPendente = vezEm(E.montando, { execucaoId: EU, pendenteDesdeMs: null });
    const r = decidirLiberacao(semPendente, { execucaoId: EU }, L.semEscrita, OPCOES);
    expect(r.tipo === 'atualizar' && [r.pendenteDesdeMs, r.vezPara]).toEqual([null, null]);
  });

  it('a start already folded into the caller’s own recovery needs no vez — unless the read found a SMALLER one', () => {
    const vezDe = (pendenteDobrado: number | null) => {
      const r = decidirLiberacao(emPosse(E.enviado), { feedId: FEED }, L.concluido, {
        agoraMs: AGORA,
        pendenteDobrado,
      });
      return r.tipo === 'atualizar' ? r.vezPara : 'recusado';
    };
    expect(vezDe(1_000)).toBeNull(); // the same start: folded
    expect(vezDe(900)).toBeNull(); // a smaller one was folded: it covers 1,000
    expect(vezDe(1_200)).toBe(1_000); // turned away after the fold's read
    expect(vezDe(null)).toBe(1_000); // nothing folded
  });

  it('★ the incerto release waits the 12 h: 1 ms early ⇒ cedo-demais, at 12 h ⇒ released (inclusive)', () => {
    const armazenada = vezEm(E.enviando, {
      execucaoId: EU,
      antesDoEnvioMs: AGORA - PRAZO_FEED_MS + 1,
      ateMs: AGORA - HORA,
    });
    expect(decidirLiberacao(armazenada, { execucaoId: EU }, L.incerto, OPCOES)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.cedoDemais,
    });
    const r = decidirLiberacao(armazenada, { execucaoId: EU }, L.incerto, {
      agoraMs: AGORA + 1,
      pendenteDobrado: null,
    });
    expect(r.tipo).toBe('atualizar');
    // A definitive refusal from the same lease does not wait.
    expect(decidirLiberacao(armazenada, { execucaoId: EU }, L.recusaDefinitiva, OPCOES).tipo).toBe(
      'atualizar',
    );
  });

  it('★ NEAR-MISS: an enviando WITHOUT its stamp has an unmeasurable wait — its incerto release is refused, however late', () => {
    const semCarimbo = vezEm(E.enviando, {
      execucaoId: EU,
      antesDoEnvioMs: null,
      ateMs: AGORA - HORA,
    });
    expect(
      decidirLiberacao(semCarimbo, { execucaoId: EU }, L.incerto, {
        agoraMs: AGORA + 100 * HORA,
        pendenteDobrado: null,
      }),
    ).toEqual({ tipo: 'recusado', motivo: RECUSA_DA_VEZ.cedoDemais });
  });

  it('★ the two document kinds also release the refresh re-run’s LIVE enviando (nothing was submitted); NEAR-MISS: never an expired one', () => {
    expect(REGRA_DA_LIBERACAO[L.documentoFalhou].fases).toEqual([E.montando, E.enviando]);
    expect(REGRA_DA_LIBERACAO[L.documentoTransitorio].fases).toEqual([E.montando, E.enviando]);
    // The first marcarEnviando wrote enviando; the createFeed 401 re-ran the
    // submission, whose document or upload then failed.
    const CARIMBO = AGORA - 30 * SEG;
    const reexecucao = vezEm(E.enviando, {
      execucaoId: EU,
      antesDoEnvioMs: CARIMBO,
      ateMs: AGORA + 9 * MIN,
      ...PERSISTENTES,
    });
    const DA_TENTATIVA = { ...OPCOES, antesDoEnvioAnteriorMs: CARIMBO };
    const falhou = decidirLiberacao(
      reexecucao,
      { execucaoId: EU },
      L.documentoFalhou,
      DA_TENTATIVA,
    );
    expect(falhou).toMatchObject({
      tipo: 'atualizar',
      falhasSeguidas: PERSISTENTES.falhasSeguidas + 1,
      escrever: { estado: E.livre, antesDoEnvioMs: null, pendenteDesdeMs: null },
      vezPara: PERSISTENTES.pendenteDesdeMs,
    });
    if (falhou.tipo === 'atualizar') {
      expect(falhou.escrever).not.toHaveProperty('ultimoFeedConcluidoEmMs');
    }
    const transitorio = decidirLiberacao(
      reexecucao,
      { execucaoId: EU },
      L.documentoTransitorio,
      DA_TENTATIVA,
    );
    expect(transitorio).toMatchObject({
      tipo: 'atualizar',
      falhasSeguidas: PERSISTENTES.falhasSeguidas,
    });
    // Expired in place (the uncertain outcome) or simply expired: only incerto releases it.
    const recusada = { tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroEstado };
    for (const ateMs of [AGORA, AGORA - HORA]) {
      const vencida = { ...reexecucao, ateMs };
      expect(
        decidirLiberacao(vencida, { execucaoId: EU }, L.documentoFalhou, DA_TENTATIVA),
      ).toEqual(recusada);
      expect(
        decidirLiberacao(vencida, { execucaoId: EU }, L.documentoTransitorio, DA_TENTATIVA),
      ).toEqual(recusada);
    }
    // Every other nothing-submitted kind still refuses an enviando.
    expect(decidirLiberacao(reexecucao, { execucaoId: EU }, L.limitado, DA_TENTATIVA)).toEqual(
      recusada,
    );
    expect(decidirLiberacao(reexecucao, { execucaoId: EU }, L.snapshotLento, DA_TENTATIVA)).toEqual(
      recusada,
    );
  });

  it('★ NEAR-MISS: a document kind frees an enviando only for the ATTEMPT that stamped it — a copy of the payload whose own document failed before it stamped writes nothing', () => {
    // Another copy (same execucaoId) passed marcarEnviando and is in createFeed.
    const CARIMBO = AGORA - 30 * SEG;
    const outraCopia = vezEm(E.enviando, {
      execucaoId: EU,
      antesDoEnvioMs: CARIMBO,
      ateMs: AGORA + 9 * MIN,
    });
    const recusada = { tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroEstado };
    for (const liberacao of [L.documentoFalhou, L.documentoTransitorio]) {
      // This copy never stamped: absent, or null.
      expect(decidirLiberacao(outraCopia, { execucaoId: EU }, liberacao, OPCOES)).toEqual(recusada);
      expect(
        decidirLiberacao(outraCopia, { execucaoId: EU }, liberacao, {
          ...OPCOES,
          antesDoEnvioAnteriorMs: null,
        }),
      ).toEqual(recusada);
      // A stale stamp of an earlier attempt.
      expect(
        decidirLiberacao(outraCopia, { execucaoId: EU }, liberacao, {
          ...OPCOES,
          antesDoEnvioAnteriorMs: CARIMBO - 1,
        }),
      ).toEqual(recusada);
      // The stamping attempt itself.
      expect(
        decidirLiberacao(outraCopia, { execucaoId: EU }, liberacao, {
          ...OPCOES,
          antesDoEnvioAnteriorMs: CARIMBO,
        }).tipo,
      ).toBe('atualizar');
      // A stampless enviando (no attempt to match) is never freed this way.
      const semCarimbo = { ...outraCopia, antesDoEnvioMs: null };
      expect(decidirLiberacao(semCarimbo, { execucaoId: EU }, liberacao, OPCOES)).toEqual(recusada);
      // From montando nothing was stamped: no stamp is asked for.
      expect(
        decidirLiberacao(
          vezEm(E.montando, { execucaoId: EU }),
          { execucaoId: EU },
          liberacao,
          OPCOES,
        ).tipo,
      ).toBe('atualizar');
    }
    expect(() =>
      decidirLiberacao(outraCopia, { execucaoId: EU }, L.documentoFalhou, {
        ...OPCOES,
        antesDoEnvioAnteriorMs: 1.5,
      }),
    ).toThrow(RangeError);
  });

  it('★ the floor never delays a release (10 s after ultimoEnvioMs)', () => {
    for (const [liberacao, fase] of LIBERACOES) {
      const r = decidirLiberacao(emPosse(fase), donoDe(fase), liberacao, OPCOES);
      expect(r.tipo, liberacao).toBe('atualizar');
    }
  });
});

describe('★ every release is holder-checked: a non-holder writes nothing (mutation 10)', () => {
  it.each(LIBERACOES)('%s', (liberacao, fase) => {
    // Another holder of the same phase.
    const alheia = vezEm(fase, {
      execucaoId: OUTRO,
      feedId: fase === E.enviado ? OUTRO_FEED : null,
      antesDoEnvioMs: fase === E.montando ? null : AGORA - 13 * HORA,
      ateMs: AGORA - 12 * HORA,
    });
    expect(decidirLiberacao(alheia, donoDe(fase), liberacao, OPCOES)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroDono,
    });
    // A free lease, or no document.
    expect(
      decidirLiberacao(vezEm(E.livre, { execucaoId: EU }), donoDe(fase), liberacao, OPCOES),
    ).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.livre,
    });
    expect(decidirLiberacao(null, donoDe(fase), liberacao, OPCOES)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.livre,
    });
  });

  it('the holder, but in another phase ⇒ outro-estado', () => {
    // This run's montando cannot be released as a submitted (enviando) one.
    expect(
      decidirLiberacao(emPosse(E.montando), { execucaoId: EU }, L.recusaDefinitiva, OPCOES),
    ).toEqual({ tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroEstado });
    // Nor its enviando as a montando one: that would lose a maybe-submitted feed.
    expect(decidirLiberacao(emPosse(E.enviando), { execucaoId: EU }, L.semEscrita, OPCOES)).toEqual(
      {
        tipo: 'recusado',
        motivo: RECUSA_DA_VEZ.outroEstado,
      },
    );
    // A known feed is released by its feedId, never by the run that sent it.
    expect(
      decidirLiberacao(emPosse(E.enviado), { execucaoId: EU }, L.recusaDefinitiva, OPCOES),
    ).toEqual({ tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroEstado });
  });

  it('★ the PHASE decides, never the stored estado (the two crossings)', () => {
    // A montando that names a feed behaves as enviado: never released by the
    // run as nothing-submitted, released by its feedId as a known feed.
    const montandoComFeed = vezEm(E.montando, { execucaoId: EU, feedId: FEED });
    expect(decidirLiberacao(montandoComFeed, { execucaoId: EU }, L.semEscrita, OPCOES)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroEstado,
    });
    expect(decidirLiberacao(montandoComFeed, { feedId: FEED }, L.concluido, OPCOES).tipo).toBe(
      'atualizar',
    );
    // An enviado with no feedId behaves as enviando: the uncertain path releases it.
    const enviadoSemFeed = vezEm(E.enviado, {
      execucaoId: EU,
      feedId: null,
      antesDoEnvioMs: AGORA - 13 * HORA,
      ateMs: AGORA - HORA,
    });
    expect(decidirLiberacao(enviadoSemFeed, { execucaoId: EU }, L.incerto, OPCOES).tipo).toBe(
      'atualizar',
    );
  });

  it('a tail of an older feed finds the lease held by the next run’s feed ⇒ outro-dono', () => {
    const proximo = vezEm(E.enviado, { execucaoId: OUTRO, feedId: OUTRO_FEED });
    expect(decidirLiberacao(proximo, { feedId: FEED }, L.concluido, OPCOES)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroDono,
    });
  });

  it('a holder keyed for another phase than the kind’s, or an unknown kind, is a programming error', () => {
    expect(() =>
      decidirLiberacao(emPosse(E.enviado), { execucaoId: EU }, L.concluido, OPCOES),
    ).toThrow(RangeError);
    expect(() =>
      decidirLiberacao(emPosse(E.montando), { feedId: FEED }, L.semEscrita, OPCOES),
    ).toThrow(RangeError);
    expect(() =>
      decidirLiberacao(
        emPosse(E.montando),
        { execucaoId: EU },
        'outra' as LiberacaoVezFeed,
        OPCOES,
      ),
    ).toThrow(RangeError);
  });
});

/* =========================== consuming without a release ====================== */

describe('★ consumirPendenteVez — the slow and overdue rungs, the montando check, a repasse', () => {
  const enviado = (pendenteDesdeMs: number | null) =>
    vezEm(E.enviado, {
      antesDoEnvioMs: AGORA - 30 * MIN,
      ateMs: AGORA + 40 * HORA,
      pendenteDesdeMs,
    });
  const rodada = { tipo: CONSUMO_DO_PENDENTE.rodada, feedId: FEED } as const;

  it('the holder’s rung at 30 min consumes the start; the lease stays enviado', () => {
    const armazenada = enviado(1_000);
    const r = consumirPendenteVez(armazenada, rodada, AGORA);
    expect(r).toEqual({
      tipo: 'atualizar',
      escrever: { pendenteDesdeMs: null, atualizadoEmMs: AGORA },
      pendenteDesdeMs: 1_000,
      vezPara: 1_000,
    });
    if (r.tipo === 'atualizar') {
      const depois = aplicar(armazenada, r.escrever);
      expect([depois.estado, depois.feedId, depois.ateMs]).toEqual([
        E.enviado,
        FEED,
        armazenada.ateMs,
      ]);
    }
  });

  it('NEAR-MISS: a rung before 30 min ⇒ cedo-demais; another feed ⇒ outro-dono; nothing stored ⇒ nada', () => {
    expect(consumirPendenteVez(enviado(1_000), rodada, AGORA - 1)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.cedoDemais,
    });
    expect(
      consumirPendenteVez(
        enviado(1_000),
        { tipo: CONSUMO_DO_PENDENTE.rodada, feedId: OUTRO_FEED },
        AGORA,
      ),
    ).toEqual({ tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroDono });
    expect(consumirPendenteVez(enviado(null), rodada, AGORA)).toEqual({ tipo: 'nada' });
    expect(consumirPendenteVez(vezEm(E.livre), rodada, AGORA)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.livre,
    });
    // A holder without its stamp is never known to be past the slow-holder bound.
    const semCarimbo = vezEm(E.enviado, {
      antesDoEnvioMs: null,
      ateMs: AGORA + HORA,
      pendenteDesdeMs: 1_000,
    });
    expect(consumirPendenteVez(semCarimbo, rodada, AGORA + 100 * HORA)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.cedoDemais,
    });
  });

  it('an expired montando (a holder that died building) ⇒ consumed; unexpired ⇒ cedo-demais; another phase ⇒ outro-estado', () => {
    const quem = { tipo: CONSUMO_DO_PENDENTE.montandoVencida } as const;
    const vencida = vezEm(E.montando, { ateMs: AGORA, pendenteDesdeMs: 1_000 });
    expect(consumirPendenteVez(vencida, quem, AGORA)).toMatchObject({
      tipo: 'atualizar',
      vezPara: 1_000,
    });
    expect(
      consumirPendenteVez(
        vezEm(E.montando, { ateMs: AGORA + 1, pendenteDesdeMs: 1_000 }),
        quem,
        AGORA,
      ),
    ).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.cedoDemais,
    });
    expect(consumirPendenteVez(enviado(1_000), quem, AGORA)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outroEstado,
    });
    // The PHASE decides: an expired montando that names a feed behaves as enviado.
    expect(
      consumirPendenteVez(
        vezEm(E.montando, { feedId: FEED, ateMs: AGORA, pendenteDesdeMs: 1_000 }),
        quem,
        AGORA,
      ),
    ).toEqual({ tipo: 'recusado', motivo: RECUSA_DA_VEZ.outroEstado });
    expect(consumirPendenteVez(null, quem, AGORA)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.livre,
    });
  });

  it('a repasse takes whatever start the read shows, held by anyone', () => {
    const quem = { tipo: CONSUMO_DO_PENDENTE.repasse } as const;
    expect(consumirPendenteVez(enviado(1_000), quem, AGORA)).toMatchObject({
      tipo: 'atualizar',
      pendenteDesdeMs: 1_000,
      vezPara: 1_000,
    });
    expect(consumirPendenteVez(enviado(null), quem, AGORA)).toEqual({ tipo: 'nada' });
    expect(consumirPendenteVez(null, quem, AGORA)).toEqual({ tipo: 'nada' });
  });
});

/* ================================ the sequences =============================== */

describe('★ the breaker, end to end', () => {
  /** One feed's life for run `execucaoId`: take, submit, name, then the release `fim`. */
  function umFeed(
    inicial: VezFeedAmazon | null,
    agoraMs: number,
    execucaoId: string,
    lote: LoteFeedAmazon,
    fim: LiberacaoVezFeed,
    feedId: string,
  ): VezFeedAmazon {
    const tomada = tomarVez(inicial, agoraMs, tarefa(lote, execucaoId));
    if (tomada.tipo === 'recusado') throw new Error(`tomar recusado: ${tomada.motivo}`);
    let atual: VezFeedAmazon;
    if (tomada.tipo === 'criar') atual = vezFeedAmazonSchema.parse(tomada.documento);
    else if (inicial === null) throw new Error('atualizar sem documento');
    else atual = aplicar(inicial, tomada.escrever);
    const enviando = marcarEnviandoVez(
      atual,
      agoraMs,
      execucaoId,
      {
        snapshotEmMs: agoraMs,
        antesDoEnvioMs: agoraMs,
        mensagens: 31,
        bytes: 5_000,
      },
      null,
    );
    if (enviando.tipo !== 'atualizar') throw new Error('enviando recusado');
    atual = aplicar(atual, enviando.escrever);
    const enviado = marcarEnviadoVez(atual, agoraMs, execucaoId, feedId);
    if (enviado.tipo !== 'atualizar') throw new Error('enviado recusado');
    atual = aplicar(atual, enviado.escrever);
    const r = decidirLiberacao(atual, { feedId }, fim, {
      agoraMs: agoraMs + MIN,
      pendenteDobrado: null,
    });
    if (r.tipo !== 'atualizar') throw new Error(`liberação recusada: ${r.motivo}`);
    return aplicar(atual, r.escrever);
  }

  it('three failed feeds open it; a window batch within the hour goes per SKU; the probe at 1 h; its DONE closes it', () => {
    let t = AGORA;
    let atual: VezFeedAmazon | null = null;
    for (const [i, fim] of [L.falhou, L.cancelado, L.abandonado].entries()) {
      atual = umFeed(atual, t, `e${i}`, TICK, fim, `${7000 + i}`);
      t += 10 * MIN;
    }
    if (atual === null) throw new Error('sem vez');
    const ultimaFalha = t - 10 * MIN + MIN;
    expect([atual.falhasSeguidas, atual.ultimaFalhaEmMs]).toEqual([3, ultimaFalha]);

    // Within the hour: per SKU, and the lease is untouched (tomarVez refuses).
    const cedo = ultimaFalha + 59 * MIN;
    const tomadaCedo = decidirTomadaDaVez(atual, cedo, 'e9');
    expect(destinoDoLoteRecusado(tomadaCedo, TICK, disjuntorDaVez(atual), cedo)).toEqual({
      tipo: D.repassarParaPatches,
      motivo: MOTIVO_REPASSE_LOTE.disjuntor,
    });
    expect(tomarVez(atual, cedo, tarefa(TICK, 'e9')).tipo).toBe('recusado');
    // A block batch takes it meanwhile (a probe too).
    expect(tomarVez(atual, cedo, tarefa(BLOCOS, 'e9')).tipo).toBe('atualizar');

    // At the hour: the probe takes it; a second window batch meeting the probe is recorded, never a second probe.
    const sonda = ultimaFalha + HORA;
    const tomou = tomarVez(atual, sonda, tarefa(TICK, 'sonda'));
    expect(tomou.tipo).toBe('atualizar');
    if (tomou.tipo !== 'atualizar') return;
    const comSonda = aplicar(atual, tomou.escrever);
    const segunda = decidirTomadaDaVez(comSonda, sonda + MIN, 'e10');
    expect(destinoDoLoteRecusado(segunda, TICK, disjuntorDaVez(comSonda), sonda + MIN)).toEqual({
      tipo: D.registrarPendente,
    });

    // The probe completes: the count is 0 and the next window batch takes the lease again.
    const fechado = umFeed(atual, sonda, 'sonda', TICK, L.concluido, '7100');
    expect(fechado.falhasSeguidas).toBe(0);
    expect(fechado.ultimaFalhaEmMs).toBe(ultimaFalha);
    const depois = sonda + 10 * MIN;
    expect(tomarVez(fechado, depois, tarefa(TICK, 'e11')).tipo).toBe('atualizar');
  });

  it('a failed probe re-arms the hour: 4 failures, re-stamped, the next window batch per SKU again', () => {
    const aberto = vezEm(E.livre, { falhasSeguidas: 3, ultimaFalhaEmMs: AGORA - 2 * HORA });
    const falhou = umFeed(aberto, AGORA, 'sonda', TICK, L.falhou, '7200');
    expect([falhou.falhasSeguidas, falhou.ultimaFalhaEmMs]).toEqual([4, AGORA + MIN]);
    const logo = AGORA + 30 * MIN;
    expect(
      destinoDoLoteRecusado(
        decidirTomadaDaVez(falhou, logo, 'x'),
        TICK,
        disjuntorDaVez(falhou),
        logo,
      ),
    ).toEqual({ tipo: D.repassarParaPatches, motivo: MOTIVO_REPASSE_LOTE.disjuntor });
  });

  it('NEAR-MISS: only a completed feed resets it — every other release keeps or raises the count', () => {
    for (const [liberacao, fase, efeito] of LIBERACOES) {
      const r = decidirLiberacao(emPosse(fase), donoDe(fase), liberacao, OPCOES);
      if (r.tipo !== 'atualizar') throw new Error(liberacao);
      expect(r.falhasSeguidas === 0, liberacao).toBe(liberacao === L.concluido);
      expect(efeito === 'zera').toBe(liberacao === L.concluido);
    }
  });

  it('★ a take keeps falhasSeguidas, ultimaFalhaEmMs, ultimoFeedConcluidoEmMs and ultimoEnvioMs', () => {
    const livre = vezEm(E.livre, PERSISTENTES);
    const r = tomarVez(livre, AGORA, tarefa(BLOCOS));
    if (r.tipo !== 'atualizar') throw new Error('esperado atualizar');
    expect(aplicar(livre, r.escrever)).toMatchObject(PERSISTENTES);
  });
});

describe('★ the submission floor, end to end', () => {
  it('a feed released 90 s after its antesDoEnvioMs ⇒ the next send waits 30 s, then takes at 120 s', () => {
    const t0 = AGORA;
    const criada = tomarVez(null, t0 - 5 * SEG, tarefa(TICK, 'a'));
    if (criada.tipo !== 'criar') throw new Error('esperado criar');
    let atual = vezFeedAmazonSchema.parse(criada.documento);
    const env = marcarEnviandoVez(
      atual,
      t0,
      'a',
      {
        snapshotEmMs: t0 - 5 * SEG,
        antesDoEnvioMs: t0,
        mensagens: 31,
        bytes: 1_000,
      },
      null,
    );
    if (env.tipo !== 'atualizar') throw new Error('enviando');
    atual = aplicar(atual, env.escrever);
    const nomeado = marcarEnviadoVez(atual, t0 + SEG, 'a', FEED);
    if (nomeado.tipo !== 'atualizar') throw new Error('enviado');
    atual = aplicar(atual, nomeado.escrever);
    const fim = decidirLiberacao(atual, { feedId: FEED }, L.concluido, {
      agoraMs: t0 + 90 * SEG,
      pendenteDobrado: null,
    });
    if (fim.tipo !== 'atualizar') throw new Error('liberação');
    atual = aplicar(atual, fim.escrever);
    expect(atual.ultimoEnvioMs).toBe(t0);

    const proxima = tarefa(BLOCOS, 'b');
    expect(decidirTomadaDaVez(atual, t0 + 90 * SEG, 'b')).toEqual({
      tipo: T.aguardarEspaco,
      restanteS: 30,
    });
    expect(tomarVez(atual, t0 + 90 * SEG, proxima)).toEqual({
      tipo: 'recusado',
      motivo: RECUSA_DA_VEZ.outraRota,
    });
    expect(tomarVez(atual, t0 + 120 * SEG, proxima).tipo).toBe('atualizar');
  });
});
