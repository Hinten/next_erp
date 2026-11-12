/**
 * The feed RECOVERY handler on a REAL Firestore — the emulator of
 * `ci-amazon.yml` (step 12a, PR 12-c). The offline suite proves every branch
 * against `testing/fakeDb.ts`; this file proves, on the real server, that the
 * handler's ONE Firestore dependency — the context, loaded from the stored conta
 * and its credential — answers each arm as the fake says:
 *
 *  - `recuperado`: the context loads from the emulator, and the provider gets
 *    the payload's outcome, snapshot, folded start and window, the reference
 *    `referenciaDaRecuperacaoFeed` derives, and the conta's seller;
 *  - `contexto-recusado`: an inactive conta, and a conta whose credential is
 *    gone, each end the dispatch with ONE WARNING and the provider never
 *    called — no throw, so the queue does not retry a recovery that cannot run;
 *  - `sem-provedor`: an empty seam row reads nothing and calls nothing.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the handler as `ambiente` (never `process.env`: the lane sets it `off`).
 * The recovery makes no SP-API call of its own: the scripted `fetch` refuses
 * every request, and a case that reached it would fail. Nothing enqueues onto a
 * real queue (the fake provider enqueues nothing).
 *
 * ⚠️ The emulator is SHARED: the conta here is INCOMPLETE (no filial, no
 * `dataCadastro`), so the conta trigger only reads; its id is seeded by no
 * other suite. Every case wipes what it reads first; the file leaves nothing
 * behind.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { FLUXO_FEED_AMAZON, INTEGRACAO_TIPO, MOTIVO_CONTA_AMAZON } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import type { AmbienteAmazon } from '../env';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
} from '../testing/fixtures';
import type { ProvedorLoteAmazon, RecuperacaoLoteAmazon } from './provedorLote';
import {
  ACAO_RECUPERACAO_FEED,
  type ResultadoRecuperacaoFeedAmazon,
  processarRecuperacaoFeedAmazon,
} from './recuperarFeed';
import {
  DESFECHO_RECUPERACAO_FEED_AMAZON,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaRecuperarFeedAmazon,
  tarefaRecuperarFeedAmazonSchema,
} from './tarefaLote';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** The conta of this file — an id no other suite seeds. */
const CONTA = 'conta-amazon-feed-recuperar-ci';
const FEED = '50001234567';
const EXEC = 'exec-recuperar-ci';
const MIN = 60_000;
const JANELA = {
  desdeMs: AGORA_MS - 30 * MIN,
  ateMs: AGORA_MS - 25 * MIN,
  manterDesdeMs: AGORA_MS - 30 * MIN,
  commitAposMs: null,
  depositoId: 'deposito-ci',
};

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE_LIGADO_NO_PROCESSO: AmbienteAmazon = Object.freeze({
  ...AMBIENTE_LIGADO,
  AMAZON_CHAMADAS: 'on',
});

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  await db().doc(caminhoCredencial(CONTA)).delete();
  await db().doc(caminhoConta(CONTA)).delete();
}

/** A connected, INCOMPLETE conta (`ativo` as given) and, unless told not to, its credential. */
async function semearConta(o: { ativo?: boolean; credencial?: boolean } = {}): Promise<void> {
  await db()
    .doc(caminhoConta(CONTA))
    .set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste da recuperação',
      ativo: o.ativo ?? true,
      padrao: false,
      selling_partner_id: SPID_A,
    });
  if (o.credencial !== false) {
    await db()
      .doc(caminhoCredencial(CONTA))
      .set(credencialDoc({ expirationDate: AGORA_MS + 365 * DIA_MS }));
  }
}

/** A window feed's end: `falhou`, its snapshot, a folded start and its own window. */
function recuperacao(): TarefaRecuperarFeedAmazon {
  return tarefaRecuperarFeedAmazonSchema.parse({
    v: 1,
    tipo: TIPO_TAREFA_LOTE_AMAZON.recuperar,
    fluxo: FLUXO_FEED_AMAZON.estoque,
    contaId: CONTA,
    desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.falhou,
    feedId: FEED,
    execucaoId: EXEC,
    snapshotEmMs: AGORA_MS - 40 * MIN,
    pendenteDesdeMs: AGORA_MS - 20 * MIN,
    janela: JANELA,
  });
}

interface Mundo {
  readonly recuperacoes: RecuperacaoLoteAmazon[];
  readonly vendedores: string[];
  readonly rede: string[];
  readonly log: ReturnType<typeof loggerEspiao>;
  provedor: ProvedorLoteAmazon<'estoque', unknown> | null;
  rodar(t: TarefaRecuperarFeedAmazon): Promise<ResultadoRecuperacaoFeedAmazon>;
}

function mundo(): Mundo {
  const recusa = () => Promise.reject(new Error('teste: a recuperação não monta nem grava'));
  const m: Mundo = {
    recuperacoes: [],
    vendedores: [],
    rede: [],
    log: loggerEspiao(),
    provedor: null,
    rodar: (t) => {
      expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
      return processarRecuperacaoFeedAmazon(db(), t, {
        ambiente: AMBIENTE_LIGADO_NO_PROCESSO,
        agora: () => AGORA_MS,
        logger: m.log.logger,
        provedor: m.provedor,
        registro: { tentativa: 0, idTarefa: 'tarefa-recuperar-ci' },
        fetch: (input) => {
          m.rede.push(String(input));
          return Promise.reject(new TypeError('sem rede: a recuperação não chama a Amazon'));
        },
      });
    },
  };
  // A fake provider: it imports no stock module, and only `recuperar` may run.
  m.provedor = {
    fluxo: 'estoque',
    membros: recusa,
    montar: recusa,
    gravarResultado: recusa,
    recuperar: (ctx, r) => {
      m.recuperacoes.push(r);
      m.vendedores.push(ctx.sellerId);
      return Promise.resolve({ tarefas: 4 });
    },
    repassarParaPatches: recusa,
    motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
  };
  return m;
}

describe.skipIf(!EMULATED)('the feed recovery handler on real Firestore (emulator)', () => {
  beforeAll(() => {
    db();
  });

  beforeEach(async () => {
    __resetAllReadCaches();
    __setRelogioDoCacheParaTestes(() => AGORA_MS);
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    __resetAllReadCaches();
    __setRelogioDoCacheParaTestes();
  });

  it('★ recuperado: the context loads from the stored conta and credential, and the provider gets the payload’s outcome, window and reference, and the conta’s seller', async () => {
    await semearConta();
    const m = mundo();
    const r = await m.rodar(recuperacao());
    expect(r).toMatchObject({
      acao: ACAO_RECUPERACAO_FEED.recuperado,
      desfecho: 'falhou',
      referencia: FEED,
      tarefas: 4,
    });
    expect(m.recuperacoes).toEqual([
      {
        desfecho: 'falhou',
        snapshotEmMs: AGORA_MS - 40 * MIN,
        pendenteDesdeMs: AGORA_MS - 20 * MIN,
        referencia: FEED,
        janela: JANELA,
      },
    ]);
    expect(m.vendedores).toEqual([SPID_A]);
    expect(m.rede).toEqual([]);
    expect(m.log.linhas.filter((l) => l.meta?.fase === 'recuperacao')).toHaveLength(1);
  });

  it.each<[string, { ativo?: boolean; credencial?: boolean }, string]>([
    ['an inactive conta', { ativo: false }, 'conta-inativa'],
    ['a conta whose credential is gone', { credencial: false }, 'conta-indisponivel'],
  ])(
    '★ contexto-recusado: %s ⇒ ONE WARNING, the provider never called, no throw',
    async (_caso, conta, motivo) => {
      await semearConta(conta);
      const m = mundo();
      const r = await m.rodar(recuperacao());
      expect(r).toMatchObject({ acao: ACAO_RECUPERACAO_FEED.contextoRecusado, motivo });
      expect(m.recuperacoes).toEqual([]);
      expect(m.rede).toEqual([]);
      expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
    },
  );

  it('sem-provedor: an empty seam row ends the dispatch with nothing called', async () => {
    await semearConta();
    const m = mundo();
    m.provedor = null;
    const r = await m.rodar(recuperacao());
    expect(r).toMatchObject({ acao: ACAO_RECUPERACAO_FEED.semProvedor });
    expect(m.recuperacoes).toEqual([]);
    expect(m.rede).toEqual([]);
  });
});
