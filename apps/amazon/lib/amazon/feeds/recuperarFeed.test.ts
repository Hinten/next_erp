/**
 * The feed RECOVERY handler (step 12a, PR 12-c), against the fake Firestore:
 * the REAL context, and a FAKE provider built here (it imports no stock
 * module). The handler decides nothing about an outcome; these tests pin what
 * it hands the provider, what it answers when it cannot, and that a failure is
 * the queue's to retry.
 *
 * ⚠️ D11: the recovery makes no SP-API call of its own, and the global `fetch`
 * refuses. PLACEHOLDERS ONLY (public repository).
 */
import { AmazonHttpError } from '@delfrance/integrations-amazon-sp-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  FLUXO_FEED_AMAZON,
  type FluxoFeedAmazon,
  MOTIVO_CONTA_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  idVezFeedAmazon,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoCredencial,
  loggerEspiao,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import type {
  DesfechoRecuperacaoLoteAmazon,
  ProvedorLoteAmazon,
  RecuperacaoLoteAmazon,
} from './provedorLote';
import { ACAO_RECUPERACAO_FEED, processarRecuperacaoFeedAmazon } from './recuperarFeed';
import {
  DESFECHO_RECUPERACAO_FEED_AMAZON,
  type DesfechoRecuperacaoFeedAmazon,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaRecuperarFeedAmazon,
  referenciaVezFeed,
  tarefaRecuperarFeedAmazonSchema,
} from './tarefaLote';

const CONTA = 'conta-amz-recuperar';
const FEED = '50001234567';
const EXEC = 'exec-recuperar-teste';
const MIN = 60_000;
const VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const JANELA = {
  desdeMs: AGORA_MS - 30 * MIN,
  ateMs: AGORA_MS - 25 * MIN,
  manterDesdeMs: AGORA_MS - 30 * MIN,
  commitAposMs: null,
  depositoId: 'deposito-teste',
};

function recuperar(campos: {
  desfecho: DesfechoRecuperacaoFeedAmazon;
  feedId?: string | null;
  pendenteDesdeMs?: number | null;
  janela?: typeof JANELA | null;
  fluxo?: FluxoFeedAmazon;
}): TarefaRecuperarFeedAmazon {
  const vez = campos.desfecho === DESFECHO_RECUPERACAO_FEED_AMAZON.vez;
  return tarefaRecuperarFeedAmazonSchema.parse({
    v: 1,
    tipo: TIPO_TAREFA_LOTE_AMAZON.recuperar,
    fluxo: campos.fluxo ?? FLUXO_FEED_AMAZON.estoque,
    contaId: CONTA,
    desfecho: campos.desfecho,
    feedId: campos.feedId === undefined ? FEED : campos.feedId,
    execucaoId: EXEC,
    snapshotEmMs: vez ? null : AGORA_MS - 40 * MIN,
    pendenteDesdeMs: campos.pendenteDesdeMs ?? (vez ? AGORA_MS - 20 * MIN : null),
    janela: vez ? null : (campos.janela ?? null),
  });
}

function mundo() {
  const fake = new FakeDb();
  seedConta(fake, CONTA, { nome: 'Conta recuperação', selling_partner_id: SPID_A });
  seedCredencial(fake, CONTA, { expirationDate: AGORA_MS + 30 * DIA_MS });
  const log = loggerEspiao();
  const chamadas: RecuperacaoLoteAmazon[] = [];
  const m = {
    fake,
    log,
    chamadas,
    vendedores: [] as string[],
    respostas: [] as (DesfechoRecuperacaoLoteAmazon | Error)[],
    ambiente: { ...AMBIENTE_LIGADO } as Record<string, string | undefined>,
    provedor: null as ProvedorLoteAmazon<'estoque' | 'preco', unknown> | null,
    rodar(t: TarefaRecuperarFeedAmazon) {
      return processarRecuperacaoFeedAmazon(asDb(fake), t, {
        ambiente: m.ambiente,
        agora: () => AGORA_MS,
        logger: log.logger,
        provedor: m.provedor,
        registro: { tentativa: 0, idTarefa: 'tarefa-recuperar-teste' },
        fetch: () => Promise.reject(new Error('teste: a recuperação não chama a rede')),
      });
    },
  };
  m.provedor = {
    fluxo: 'estoque',
    membros: () => Promise.reject(new Error('a recuperação não monta')),
    montar: () => Promise.reject(new Error('a recuperação não monta')),
    gravarResultado: () => Promise.reject(new Error('a recuperação não grava resultado')),
    recuperar: (ctx, r) => {
      chamadas.push(r);
      m.vendedores.push(ctx.sellerId);
      const resposta = m.respostas.shift() ?? { nada: true };
      return resposta instanceof Error ? Promise.reject(resposta) : Promise.resolve(resposta);
    },
    repassarParaPatches: () => Promise.reject(new Error('a recuperação não repassa')),
    motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
  };
  return m;
}

const rede: string[] = [];
beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
});

/* ------------------------------------------------------------------------------ */

describe('what the provider receives', () => {
  it('a window feed’s end ⇒ its outcome, snapshot, folded start, its window, and the feed as the reference', async () => {
    const m = mundo();
    const r = await m.rodar(
      recuperar({
        desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.falhou,
        pendenteDesdeMs: AGORA_MS - 10 * MIN,
        janela: JANELA,
      }),
    );
    expect(m.chamadas).toEqual([
      {
        desfecho: 'falhou',
        snapshotEmMs: AGORA_MS - 40 * MIN,
        pendenteDesdeMs: AGORA_MS - 10 * MIN,
        referencia: FEED,
        janela: JANELA,
      },
    ]);
    expect(m.vendedores).toEqual([SPID_A]);
    expect(r).toMatchObject({ acao: ACAO_RECUPERACAO_FEED.recuperado, resposta: 'nada' });
  });

  it('the uncertain path’s recovery (no feed) ⇒ the run is the reference', async () => {
    const m = mundo();
    await m.rodar(recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.incerto, feedId: null }));
    expect(m.chamadas[0]).toMatchObject({ desfecho: 'incerto', referencia: EXEC, janela: null });
  });

  it.each<[string, string | null, string]>([
    ['a feed’s release', FEED, referenciaVezFeed(FEED)],
    ['a run’s release', null, referenciaVezFeed(EXEC)],
  ])(
    'a vez recovery from %s ⇒ a PREFIXED reference, no snapshot, no window, the start required',
    async (_caso, feedId, referencia) => {
      const m = mundo();
      await m.rodar(recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.vez, feedId }));
      expect(m.chamadas[0]).toEqual({
        desfecho: 'vez',
        snapshotEmMs: null,
        pendenteDesdeMs: AGORA_MS - 20 * MIN,
        referencia,
        janela: null,
      });
    },
  );

  it.each<[string, DesfechoRecuperacaoLoteAmazon, Record<string, unknown>]>([
    ['tarefas', { tarefas: 7 }, { resposta: 'tarefas', tarefas: 7, envio: null }],
    ['a feed', { feed: 'exec-recuperacao-1' }, { resposta: 'feed', envio: 'exec-recuperacao-1' }],
    ['a reconcile', { repassado: 'reconciliacao' }, { resposta: 'reconciliacao' }],
    ['nothing', { nada: true }, { resposta: 'nada' }],
  ])(
    'the provider’s answer (%s) is the line’s, as a closed token',
    async (_c, resposta, esperado) => {
      const m = mundo();
      m.respostas.push(resposta);
      const r = await m.rodar(recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.concluido }));
      expect(r).toMatchObject(esperado);
      expect(m.log.linhas.at(-1)).toMatchObject({
        nivel: 'info',
        meta: { evento: 'estoque', fase: 'recuperacao', acao: 'recuperado', ...esperado },
      });
    },
  );

  it('a feed name outside the id grammar never reaches the line', async () => {
    const m = mundo();
    m.respostas.push({ feed: 'texto livre com espaço' });
    const r = await m.rodar(recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.concluido }));
    expect(r).toMatchObject({ envio: '<invalido>' });
  });
});

describe('when it cannot recover', () => {
  it('a null seam row ⇒ sem-provedor, ONE line, NOTHING read', async () => {
    const m = mundo();
    m.provedor = null;
    const r = await m.rodar(recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.concluido }));
    expect(r).toMatchObject({ acao: ACAO_RECUPERACAO_FEED.semProvedor });
    expect(m.fake.leituras).toEqual([]);
    expect(m.log.linhas.filter((l) => l.meta?.fase === 'recuperacao')).toHaveLength(1);
  });

  it('the read switch off ⇒ contexto-recusado, WARNING, the provider never called, no throw', async () => {
    const m = mundo();
    m.ambiente.AMAZON_CHAMADAS = undefined;
    const r = await m.rodar(recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.concluido }));
    expect(r).toMatchObject({ acao: 'contexto-recusado', motivo: 'chamadas-desligadas' });
    expect(m.chamadas).toEqual([]);
    expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
  });

  it.each<[string, (m: ReturnType<typeof mundo>) => void, string]>([
    [
      'an inactive conta',
      (m) => seedConta(m.fake, CONTA, { selling_partner_id: SPID_A, ativo: false }),
      'conta-inativa',
    ],
    [
      'a conta with no credential',
      (m) => {
        m.fake.apagar(caminhoCredencial(CONTA));
      },
      'conta-indisponivel',
    ],
  ])(
    '★ %s ⇒ contexto-recusado, WARNING, the provider never called, no throw',
    async (_caso, preparar, motivo) => {
      const m = mundo();
      preparar(m);
      const r = await m.rodar(recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.falhou }));
      expect(r).toMatchObject({ acao: 'contexto-recusado', motivo });
      expect(m.chamadas).toEqual([]);
      expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
    },
  );

  it('a provider of another fluxo is a programming error (TypeError), nothing read', async () => {
    const m = mundo();
    const r = recuperar({
      desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.concluido,
      fluxo: FLUXO_FEED_AMAZON.preco,
    });
    await expect(m.rodar(r)).rejects.toBeInstanceOf(TypeError);
    expect(m.fake.leituras).toEqual([]);
  });

  it('★ recuperar throwing on its first attempt ⇒ the dispatch throws for its OWN task’s retry, which recovers; the feed’s lease is not this handler’s', async () => {
    const m = mundo();
    m.fake.seed(VEZ, {
      estado: 'livre',
      ateMs: AGORA_MS - MIN,
      atualizadoEmMs: AGORA_MS - MIN,
      tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
    });
    m.respostas.push(new Error('transitório do provedor'), { tarefas: 2 });
    const t = recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.concluido });
    await expect(m.rodar(t)).rejects.toThrow('transitório do provedor');
    expect(m.log.linhas.filter((l) => l.meta?.fase === 'recuperacao')).toEqual([]);

    const r = await m.rodar(t);
    expect(r).toMatchObject({ acao: 'recuperado', tarefas: 2 });
    expect(m.chamadas).toHaveLength(2);
    // Released by the tail before this task existed: never touched here.
    expect(m.fake.escritasEm(VEZ)).toEqual([]);
    expect(m.fake.leituras).not.toContain(VEZ);
  });

  it('an Amazon error thrown by the provider leaves SANITIZED (its class and status only)', async () => {
    const m = mundo();
    m.respostas.push(
      new AmazonHttpError({
        status: 500,
        destino: 'sp-api',
        operacao: 'getListingsItem',
        metodo: 'GET',
        caminho: `/listings/2021-08-01/items/${SPID_A}/SKU-TESTE`,
        correlationId: 'corr-teste',
        requestIdAmazon: null,
        refCredencial: 'ref-teste',
      }),
    );
    const erro = await m
      .rodar(recuperar({ desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.concluido }))
      .catch((e: unknown) => e);
    expect(erro).toMatchObject({ name: 'FalhaTarefaAmazonError' });
    expect(String((erro as Error).message)).not.toContain(SPID_A);
  });
});
