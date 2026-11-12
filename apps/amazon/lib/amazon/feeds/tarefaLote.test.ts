/**
 * The feed core's jobs-queue contract (step 12a, PR 12-b): the strict payload
 * union and its refusals, the grammars restated in @delfrance/schemas, and the
 * task names (every one carrying the conta).
 */
import { sha256Hex } from '@delfrance/data/admin';
import { FEED_ID_AMAZON_REGEX } from '@delfrance/integrations-amazon-sp-api';
import {
  DESFECHO_FEED_AMAZON,
  FEED_ID_REGISTRO_AMAZON_REGEX,
  FLUXO_FEED_AMAZON,
  type FluxoFeedAmazon,
  TIPO_LOTE_FEED_AMAZON,
  desfechoFeedAmazonSchema,
  fluxoFeedAmazonSchema,
} from '@delfrance/schemas';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { FLUXOS_COM_LOTE, type FluxoComLoteAmazon } from '../core/valvulas';
import {
  DESFECHO_RECUPERACAO_FEED_AMAZON,
  ORIGEM_RESULTADO_FEED_AMAZON,
  type RodadaConsultaFeed,
  TIPO_TAREFA_LOTE_AMAZON,
  VERSAO_TAREFA_LOTE_AMAZON,
  desfechoRecuperacaoFeedAmazonSchema,
  execucaoIdDaJanelaFeed,
  execucaoIdDaRecuperacaoFeed,
  nomeConsultaFeed,
  nomeEnvioFeed,
  nomeIncertoFeed,
  nomeNotificacaoFeed,
  nomeRecuperacaoFeed,
  origemResultadoFeedAmazonSchema,
  referenciaDaRecuperacaoFeed,
  referenciaVezFeed,
  tarefaLoteAmazonSchema,
  tarefaRecuperarFeedAmazonSchema,
  tipoTarefaLoteAmazonSchema,
} from './tarefaLote';

const CONTA = 'conta-teste';
const OUTRA_CONTA = 'conta-outra';
const FEED = '3485934';
const EXECUCAO = 'b'.repeat(64);
const T0 = 1_800_000_000_000;

const BLOCOS = {
  tipo: TIPO_LOTE_FEED_AMAZON.blocos,
  partes: 3,
  esperaAteMs: T0 + 6 * 3_600_000,
};

/** A TICK-born window batch: its keep rule is its start; no commit filter, no wait. */
const JANELA_DO_TICK = {
  tipo: TIPO_LOTE_FEED_AMAZON.janela,
  desdeMs: T0 - 300_000,
  ateMs: T0,
  manterDesdeMs: T0 - 300_000,
  commitAposMs: null,
  esperaAteMs: null,
  depositoId: 'deposito-1',
};

/** A RECOVERY-born window batch: its commit filter, and how long it may wait. */
const JANELA_DA_RECUPERACAO = {
  ...JANELA_DO_TICK,
  manterDesdeMs: T0 - 900_000,
  commitAposMs: T0 - 20_000,
  esperaAteMs: T0 + 3_600_000,
};

function enviar(lote: Record<string, unknown>) {
  return {
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.enviar,
    fluxo: FLUXO_FEED_AMAZON.estoque,
    contaId: CONTA,
    execucaoId: EXECUCAO,
    origem: 'delta',
    lote,
  };
}

const RESULTADO = {
  v: VERSAO_TAREFA_LOTE_AMAZON,
  tipo: TIPO_TAREFA_LOTE_AMAZON.resultado,
  contaId: CONTA,
  feedId: FEED,
  rodada: 3,
  origem: ORIGEM_RESULTADO_FEED_AMAZON.consulta,
};

const INCERTO = {
  v: VERSAO_TAREFA_LOTE_AMAZON,
  tipo: TIPO_TAREFA_LOTE_AMAZON.incerto,
  fluxo: FLUXO_FEED_AMAZON.estoque,
  contaId: CONTA,
  execucaoId: EXECUCAO,
};

const RECUPERAR = {
  v: VERSAO_TAREFA_LOTE_AMAZON,
  tipo: TIPO_TAREFA_LOTE_AMAZON.recuperar,
  fluxo: FLUXO_FEED_AMAZON.estoque,
  contaId: CONTA,
  desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.concluido,
  feedId: FEED,
  execucaoId: EXECUCAO,
  snapshotEmMs: T0 - 30_000,
  pendenteDesdeMs: null,
  janela: {
    desdeMs: JANELA_DO_TICK.desdeMs,
    ateMs: JANELA_DO_TICK.ateMs,
    manterDesdeMs: JANELA_DO_TICK.manterDesdeMs,
    commitAposMs: null,
    depositoId: 'deposito-1',
  },
};

const VEZ = {
  ...RECUPERAR,
  desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.vez,
  snapshotEmMs: null,
  pendenteDesdeMs: T0 - 600_000,
  janela: null,
};

const aceita = (t: unknown) => tarefaLoteAmazonSchema.safeParse(t).success;

describe('the closed vocabularies and the grammars', () => {
  it('each companion constant is exactly its schema’s options', () => {
    expect(Object.values(TIPO_TAREFA_LOTE_AMAZON).sort()).toEqual(
      [...tipoTarefaLoteAmazonSchema.options].sort(),
    );
    expect(Object.values(ORIGEM_RESULTADO_FEED_AMAZON).sort()).toEqual(
      [...origemResultadoFeedAmazonSchema.options].sort(),
    );
    expect(Object.values(DESFECHO_RECUPERACAO_FEED_AMAZON).sort()).toEqual(
      [...desfechoRecuperacaoFeedAmazonSchema.options].sort(),
    );
    // A recovery's outcome is a feed's, plus `vez`.
    expect(desfechoRecuperacaoFeedAmazonSchema.options).toEqual([
      ...desfechoFeedAmazonSchema.options,
      'vez',
    ]);
    expect(DESFECHO_RECUPERACAO_FEED_AMAZON.falhou).toBe(DESFECHO_FEED_AMAZON.falhou);
  });

  it('the feedId grammar restated in @delfrance/schemas is the package’s, byte for byte', () => {
    expect(FEED_ID_REGISTRO_AMAZON_REGEX.source).toBe(FEED_ID_AMAZON_REGEX.source);
    expect(FEED_ID_REGISTRO_AMAZON_REGEX.flags).toBe(FEED_ID_AMAZON_REGEX.flags);
  });

  it('the stored fluxos are exactly the valves’ batch fluxos', () => {
    expect([...fluxoFeedAmazonSchema.options]).toEqual([...FLUXOS_COM_LOTE]);
    expectTypeOf<FluxoFeedAmazon>().toEqualTypeOf<FluxoComLoteAmazon>();
  });
});

describe('the payloads (.strict(), v: 1)', () => {
  it('one of each parses unchanged', () => {
    for (const t of [
      enviar(BLOCOS),
      enviar(JANELA_DO_TICK),
      enviar(JANELA_DA_RECUPERACAO),
      RESULTADO,
      { ...RESULTADO, contaId: null, rodada: 0, origem: ORIGEM_RESULTADO_FEED_AMAZON.notificacao },
      INCERTO,
      RECUPERAR,
      { ...RECUPERAR, desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.incerto, feedId: null },
      { ...RECUPERAR, janela: null },
      VEZ,
    ]) {
      expect(tarefaLoteAmazonSchema.parse(t)).toEqual(t);
    }
  });

  it('an extra key is refused — a SKU list, a URL, or a token, at the top or in the batch', () => {
    expect(aceita({ ...enviar(BLOCOS), skus: ['A'] })).toBe(false);
    expect(aceita(enviar({ ...BLOCOS, skus: ['A'] }))).toBe(false);
    expect(aceita(enviar({ ...JANELA_DO_TICK, skus: ['A'] }))).toBe(false);
    expect(aceita({ ...RESULTADO, url: 'https://x.invalid/' })).toBe(false);
    expect(aceita({ ...INCERTO, token: 'x' })).toBe(false);
    expect(aceita({ ...RECUPERAR, janela: { ...RECUPERAR.janela, skus: ['A'] } })).toBe(false);
  });

  it('another version, an unknown tipo or a fluxo outside the batch fluxos is refused', () => {
    expect(aceita({ ...INCERTO, v: 2 })).toBe(false);
    expect(aceita({ ...INCERTO, tipo: 'feed-cancelar' })).toBe(false);
    expect(aceita({ ...INCERTO, fluxo: 'nfe' })).toBe(false);
  });

  it('a result rung’s origem is a closed token', () => {
    expect(aceita({ ...RESULTADO, origem: 'tick' })).toBe(false);
    expect(aceita({ ...RESULTADO, origem: 'Consulta' })).toBe(false);
  });

  it.each(['run:1', '', 'a b', 'a'.repeat(129)])(
    'an execucaoId outside its grammar (%j) is refused in every payload that carries one',
    (execucaoId) => {
      expect(aceita({ ...enviar(BLOCOS), execucaoId })).toBe(false);
      expect(aceita({ ...INCERTO, execucaoId })).toBe(false);
      expect(aceita({ ...RECUPERAR, execucaoId })).toBe(false);
      expect(aceita({ ...VEZ, execucaoId })).toBe(false);
    },
  );

  it.each(['conta/x', 'a:b', 'a b', '', 'a'.repeat(129)])(
    'a contaId outside its grammar (%j) is refused in every payload that carries one',
    (contaId) => {
      expect(aceita({ ...enviar(BLOCOS), contaId })).toBe(false);
      expect(aceita({ ...RESULTADO, contaId })).toBe(false);
      expect(aceita({ ...INCERTO, contaId })).toBe(false);
      expect(aceita({ ...RECUPERAR, contaId })).toBe(false);
    },
  );

  it('the producer label is a token, never free text', () => {
    expect(aceita({ ...enviar(BLOCOS), origem: 'reconciliacao' })).toBe(true);
    expect(aceita({ ...enviar(BLOCOS), origem: 'Delta do tick' })).toBe(false);
  });

  describe('★ the window batch', () => {
    it('refuses desdeMs ≥ ateMs (NEAR-MISS: one ms wide parses)', () => {
      expect(aceita(enviar({ ...JANELA_DO_TICK, desdeMs: T0 }))).toBe(false);
      expect(aceita(enviar({ ...JANELA_DO_TICK, desdeMs: T0 + 1 }))).toBe(false);
      expect(aceita(enviar({ ...JANELA_DO_TICK, desdeMs: T0 - 1 }))).toBe(true);
    });

    it('refuses a batch whose keep fields are both null', () => {
      expect(aceita(enviar({ ...JANELA_DO_TICK, manterDesdeMs: null }))).toBe(false);
    });

    it('refuses commitAposMs without esperaAteMs, and the reverse (NEAR-MISS: both, or neither, parse)', () => {
      expect(aceita(enviar({ ...JANELA_DA_RECUPERACAO, esperaAteMs: null }))).toBe(false);
      expect(aceita(enviar({ ...JANELA_DO_TICK, esperaAteMs: T0 + 3_600_000 }))).toBe(false);
      expect(aceita(enviar(JANELA_DA_RECUPERACAO))).toBe(true);
      expect(aceita(enviar(JANELA_DO_TICK))).toBe(true);
    });

    it('a recovery-born batch may keep by commit alone (no stamp rule)', () => {
      expect(aceita(enviar({ ...JANELA_DA_RECUPERACAO, manterDesdeMs: null }))).toBe(true);
    });

    it('refuses a missing field and a depósito outside the id grammar', () => {
      const { depositoId: _d, ...semDeposito } = JANELA_DO_TICK;
      expect(aceita(enviar(semDeposito))).toBe(false);
      expect(aceita(enviar({ ...JANELA_DO_TICK, depositoId: 'deposito/1' }))).toBe(false);
    });
  });

  describe('★ the block batch', () => {
    it('refuses it without partes, with a negative or zero partes, or without esperaAteMs', () => {
      const { partes: _p, ...semPartes } = BLOCOS;
      const { esperaAteMs: _e, ...semEspera } = BLOCOS;
      expect(aceita(enviar(semPartes))).toBe(false);
      expect(aceita(enviar({ ...BLOCOS, partes: -1 }))).toBe(false);
      expect(aceita(enviar({ ...BLOCOS, partes: 0 }))).toBe(false);
      expect(aceita(enviar({ ...BLOCOS, partes: 1.5 }))).toBe(false);
      expect(aceita(enviar(semEspera))).toBe(false);
      expect(aceita(enviar({ ...BLOCOS, esperaAteMs: null }))).toBe(false);
      expect(aceita(enviar({ ...BLOCOS, partes: 1 }))).toBe(true);
    });
  });

  describe('★ the recovery', () => {
    it('refuses a vez recovery with a snapshot', () => {
      expect(aceita({ ...VEZ, snapshotEmMs: T0 })).toBe(false);
    });

    it('refuses a vez recovery with no pending start, or with a window', () => {
      expect(aceita({ ...VEZ, pendenteDesdeMs: null })).toBe(false);
      expect(aceita({ ...VEZ, janela: RECUPERAR.janela })).toBe(false);
    });

    it('refuses a feed outcome with no snapshot (NEAR-MISS: the same payload as vez parses)', () => {
      expect(aceita({ ...RECUPERAR, snapshotEmMs: null, pendenteDesdeMs: T0 })).toBe(false);
      expect(
        aceita({
          ...RECUPERAR,
          desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.vez,
          snapshotEmMs: null,
          pendenteDesdeMs: T0,
          janela: null,
        }),
      ).toBe(true);
    });

    it('refuses a recovered window that is reversed or keeps nothing', () => {
      expect(aceita({ ...RECUPERAR, janela: { ...RECUPERAR.janela, ateMs: 1 } })).toBe(false);
      expect(aceita({ ...RECUPERAR, janela: { ...RECUPERAR.janela, manterDesdeMs: null } })).toBe(
        false,
      );
    });
  });

  it('★ a non-digit feedId is refused wherever a payload carries one', () => {
    for (const feedId of ['F1', '12a', '1'.repeat(21), '', '12/34']) {
      expect(aceita({ ...RESULTADO, feedId }), feedId).toBe(false);
      expect(aceita({ ...RECUPERAR, feedId }), feedId).toBe(false);
    }
  });

  it('a rung index is a non-negative integer', () => {
    expect(aceita({ ...RESULTADO, rodada: -1 })).toBe(false);
    expect(aceita({ ...RESULTADO, rodada: 1.5 })).toBe(false);
  });
});

describe('★ the names', () => {
  it('each name is sha256Hex of its documented preimage', () => {
    expect(nomeConsultaFeed(CONTA, FEED, 3)).toBe(sha256Hex(`feed:consulta:${CONTA}:${FEED}:3`));
    expect(nomeConsultaFeed(CONTA, FEED, 'adocao')).toBe(
      sha256Hex(`feed:consulta:${CONTA}:${FEED}:adocao`),
    );
    expect(nomeNotificacaoFeed('AXXXXXXXXXXXXX', FEED)).toBe(
      sha256Hex(`feed:notificacao:AXXXXXXXXXXXXX:${FEED}`),
    );
    expect(nomeNotificacaoFeed(null, FEED)).toBe(sha256Hex(`feed:notificacao:-:${FEED}`));
    expect(execucaoIdDaJanelaFeed(CONTA, 10, 20)).toBe(sha256Hex(`janela:${CONTA}:10:20`));
    expect(execucaoIdDaRecuperacaoFeed(CONTA, FEED, 5)).toBe(
      sha256Hex(`recuperacao:${CONTA}:${FEED}:5`),
    );
    expect(execucaoIdDaRecuperacaoFeed(CONTA, FEED, null)).toBe(
      sha256Hex(`recuperacao:${CONTA}:${FEED}:-`),
    );
    expect(nomeIncertoFeed(CONTA, EXECUCAO)).toBe(sha256Hex(`feed:incerto:${CONTA}:${EXECUCAO}`));
    expect(nomeEnvioFeed(CONTA, EXECUCAO)).toBe(sha256Hex(`feed:envio:${CONTA}:${EXECUCAO}`));
    expect(nomeRecuperacaoFeed(CONTA, FEED, null)).toBe(
      sha256Hex(`feed:recuperacao:${CONTA}:${FEED}:-`),
    );
    expect(nomeRecuperacaoFeed(CONTA, FEED, 5)).toBe(
      sha256Hex(`feed:recuperacao:${CONTA}:${FEED}:5`),
    );
  });

  it('two send runs of one conta give two uncertain names and two send names (NEAR-MISS: the same run gives one)', () => {
    const outraExecucao = `${EXECUCAO}-2`;
    expect(nomeIncertoFeed(CONTA, EXECUCAO)).not.toBe(nomeIncertoFeed(CONTA, outraExecucao));
    expect(nomeEnvioFeed(CONTA, EXECUCAO)).not.toBe(nomeEnvioFeed(CONTA, outraExecucao));
    expect(nomeIncertoFeed(CONTA, EXECUCAO)).toBe(nomeIncertoFeed(CONTA, EXECUCAO));
    expect(nomeEnvioFeed(CONTA, EXECUCAO)).toBe(nomeEnvioFeed(CONTA, EXECUCAO));
  });

  it('two contas with one feedId give two consultation names (and two of every name)', () => {
    expect(nomeConsultaFeed(CONTA, FEED, 0)).not.toBe(nomeConsultaFeed(OUTRA_CONTA, FEED, 0));
    expect(nomeIncertoFeed(CONTA, EXECUCAO)).not.toBe(nomeIncertoFeed(OUTRA_CONTA, EXECUCAO));
    expect(nomeEnvioFeed(CONTA, EXECUCAO)).not.toBe(nomeEnvioFeed(OUTRA_CONTA, EXECUCAO));
    expect(nomeRecuperacaoFeed(CONTA, FEED, null)).not.toBe(
      nomeRecuperacaoFeed(OUTRA_CONTA, FEED, null),
    );
    expect(execucaoIdDaJanelaFeed(CONTA, 10, 20)).not.toBe(
      execucaoIdDaJanelaFeed(OUTRA_CONTA, 10, 20),
    );
  });

  it('one name per rung; an adoption is its own rung, per day when dated', () => {
    const nomes = new Set([
      nomeConsultaFeed(CONTA, FEED, 0),
      nomeConsultaFeed(CONTA, FEED, 1),
      nomeConsultaFeed(CONTA, FEED, 'adocao'),
      nomeConsultaFeed(CONTA, FEED, 'adocao:2026-11-11'),
      nomeConsultaFeed(CONTA, FEED, 'adocao:2026-11-12'),
    ]);
    expect(nomes.size).toBe(5);
    expect(() => nomeConsultaFeed(CONTA, FEED, 'adocao:ontem')).toThrow(RangeError);
    expect(() => nomeConsultaFeed(CONTA, FEED, -1)).toThrow(RangeError);
    // The grammar is anchored at BOTH ends.
    expect(() => nomeConsultaFeed(CONTA, FEED, 'adocao:x:adocao')).toThrow(RangeError);
    expect(() => nomeConsultaFeed(CONTA, FEED, 'xadocao' as RodadaConsultaFeed)).toThrow(
      RangeError,
    );
  });

  it('two windows of one conta give two send names; the same window twice gives one', () => {
    const a = nomeEnvioFeed(CONTA, execucaoIdDaJanelaFeed(CONTA, T0 - 300_000, T0));
    const b = nomeEnvioFeed(CONTA, execucaoIdDaJanelaFeed(CONTA, T0, T0 + 300_000));
    const aDeNovo = nomeEnvioFeed(CONTA, execucaoIdDaJanelaFeed(CONTA, T0 - 300_000, T0));
    expect(a).not.toBe(b);
    expect(a).toBe(aDeNovo);
  });

  it('a recovery-born batch is named by the recovery’s identity alone (no window bound in the signature), so a retry with a later ateMs meets the same name', () => {
    // The signature itself is the guard: a window bound added to it reds this pin.
    expectTypeOf(execucaoIdDaRecuperacaoFeed).parameters.toEqualTypeOf<
      [string, string, number | null]
    >();
    // The same recovery (feed F, folding start p), retried: it re-derives a later ateMs.
    const p = T0 - 600_000;
    const primeira = { ...JANELA_DA_RECUPERACAO, ateMs: T0 };
    const retentada = { ...JANELA_DA_RECUPERACAO, ateMs: T0 + 45_000 };
    expect(aceita(enviar(primeira)) && aceita(enviar(retentada))).toBe(true);
    const nome = () => nomeEnvioFeed(CONTA, execucaoIdDaRecuperacaoFeed(CONTA, FEED, p));
    expect(nome()).toBe(nome());
    // NEAR-MISS: named by (desdeMs, ateMs), the retry would mint a twin batch.
    expect(
      nomeEnvioFeed(CONTA, execucaoIdDaJanelaFeed(CONTA, primeira.desdeMs, primeira.ateMs)),
    ).not.toBe(
      nomeEnvioFeed(CONTA, execucaoIdDaJanelaFeed(CONTA, retentada.desdeMs, retentada.ateMs)),
    );
  });

  it('two recoveries of one feed folding different pending starts give two names (NEAR-MISS: the same start gives one)', () => {
    expect(nomeRecuperacaoFeed(CONTA, FEED, T0 - 600_000)).not.toBe(
      nomeRecuperacaoFeed(CONTA, FEED, T0 - 500_000),
    );
    expect(nomeRecuperacaoFeed(CONTA, FEED, null)).not.toBe(
      nomeRecuperacaoFeed(CONTA, FEED, T0 - 600_000),
    );
    expect(nomeRecuperacaoFeed(CONTA, FEED, T0 - 600_000)).toBe(
      nomeRecuperacaoFeed(CONTA, FEED, T0 - 600_000),
    );
    expect(execucaoIdDaRecuperacaoFeed(CONTA, FEED, 1)).not.toBe(
      execucaoIdDaRecuperacaoFeed(CONTA, FEED, 2),
    );
  });

  it('a vez recovery is named apart from the tail recovery of the same releaser and start', () => {
    const ref = referenciaVezFeed(FEED);
    expect(ref).toBe(`vez:${FEED}`);
    expect(nomeRecuperacaoFeed(CONTA, ref, T0)).toBe(
      sha256Hex(`feed:recuperacao:${CONTA}:vez:${FEED}:${T0}`),
    );
    expect(nomeRecuperacaoFeed(CONTA, ref, T0)).not.toBe(nomeRecuperacaoFeed(CONTA, FEED, T0));
    // A run id as the releaser (an uncertain or never-submitted feed).
    expect(nomeRecuperacaoFeed(CONTA, referenciaVezFeed(EXECUCAO), T0)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('★ a payload’s reference is ONE derivation: feedId, else execucaoId; a vez recovery’s prefixed', () => {
    const recuperar = (t: Record<string, unknown>) => tarefaRecuperarFeedAmazonSchema.parse(t);
    expect(referenciaDaRecuperacaoFeed(recuperar(RECUPERAR))).toBe(FEED);
    expect(
      referenciaDaRecuperacaoFeed(
        recuperar({
          ...RECUPERAR,
          desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.incerto,
          feedId: null,
        }),
      ),
    ).toBe(EXECUCAO);
    expect(referenciaDaRecuperacaoFeed(recuperar(VEZ))).toBe(`vez:${FEED}`);
    expect(referenciaDaRecuperacaoFeed(recuperar({ ...VEZ, feedId: null }))).toBe(
      `vez:${EXECUCAO}`,
    );
    // NEAR-MISS: a vez recovery and the tail recovery of the same releaser,
    // folding the same start, never share a name nor a recovery-born batch.
    const vez = recuperar({ ...VEZ, pendenteDesdeMs: T0 });
    const cauda = recuperar({ ...RECUPERAR, pendenteDesdeMs: T0 });
    const r = (t: typeof vez) => referenciaDaRecuperacaoFeed(t);
    expect(nomeRecuperacaoFeed(CONTA, r(vez), T0)).not.toBe(
      nomeRecuperacaoFeed(CONTA, r(cauda), T0),
    );
    expect(execucaoIdDaRecuperacaoFeed(CONTA, r(vez), T0)).not.toBe(
      execucaoIdDaRecuperacaoFeed(CONTA, r(cauda), T0),
    );
  });

  it('an id outside its grammar throws a RangeError naming the grammar, never the value', () => {
    expect(() => nomeConsultaFeed('conta/x', FEED, 0)).toThrow(/contaId fora da gramática/);
    expect(() => nomeConsultaFeed(CONTA, 'F1', 0)).toThrow(/feedId fora da gramática/);
    expect(() => nomeConsultaFeed(CONTA, 'F1', 0)).not.toThrow(/F1/);
    expect(() => nomeNotificacaoFeed('', FEED)).toThrow(RangeError);
    expect(() => nomeIncertoFeed(CONTA, 'run:1')).toThrow(RangeError);
    expect(() => nomeEnvioFeed(CONTA, '')).toThrow(RangeError);
    expect(() => nomeRecuperacaoFeed(CONTA, 'vez:', null)).toThrow(RangeError);
    expect(() => nomeRecuperacaoFeed(CONTA, 'a:b', null)).toThrow(RangeError);
    expect(() => nomeRecuperacaoFeed(CONTA, FEED, -1)).toThrow(RangeError);
    expect(() => referenciaVezFeed('vez:x')).toThrow(RangeError);
    expect(() => execucaoIdDaJanelaFeed(CONTA, T0, T0)).toThrow(RangeError);
    expect(() => execucaoIdDaJanelaFeed(CONTA, 1.5, T0)).toThrow(RangeError);
    expect(() => execucaoIdDaJanelaFeed(CONTA, 0, 1.5)).toThrow(RangeError);
    expect(() => execucaoIdDaJanelaFeed(CONTA, 0, Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() => execucaoIdDaRecuperacaoFeed(CONTA, 'a:b', null)).toThrow(RangeError);
    expect(() => execucaoIdDaRecuperacaoFeed(CONTA, 'vez:', null)).toThrow(RangeError);
  });

  it.each<[string, (contaId: string) => string]>([
    ['nomeConsultaFeed', (c) => nomeConsultaFeed(c, FEED, 0)],
    ['nomeIncertoFeed', (c) => nomeIncertoFeed(c, EXECUCAO)],
    ['nomeEnvioFeed', (c) => nomeEnvioFeed(c, EXECUCAO)],
    ['nomeRecuperacaoFeed', (c) => nomeRecuperacaoFeed(c, FEED, null)],
    ['execucaoIdDaJanelaFeed', (c) => execucaoIdDaJanelaFeed(c, 10, 20)],
    ['execucaoIdDaRecuperacaoFeed', (c) => execucaoIdDaRecuperacaoFeed(c, FEED, null)],
  ])('%s refuses a contaId outside its grammar, naming the grammar only', (_nome, f) => {
    expect(() => f('conta/x')).toThrow(/contaId fora da gramática/);
    expect(() => f('a:b')).toThrow(RangeError);
    expect(() => f(CONTA)).not.toThrow();
  });
});
