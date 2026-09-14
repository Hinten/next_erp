import { describe, expect, it } from 'vitest';

// ⚠️ The REAL `escreverAviso` / `resolverAviso` over the shared fake Firestore,
// never a mock of them: the property under test is the PLANO the producer hands
// over — which fields it states, which it deliberately omits — and a mocked
// writer cannot show that.
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  MOTIVO_PUSH_NORMALIZADO,
  avisarPushDegradado,
  avisarPushSuspenso,
  chavePushDegradado,
  chavePushSuspenso,
  resolverAvisosDePush,
  resolverPushSuspenso,
} from './pushSaude';

const AGORA_MS = 1_760_000_000_000;
const DIA_MS = 86_400_000;

const PATH_DEGRADADO = `avisos/${chavePushDegradado()}`;
const PATH_SUSPENSO = `avisos/${chavePushSuspenso()}`;

const deps = (nowMs = AGORA_MS) => ({ increment, nowMs });

describe('as chaves são de nível de PARCEIRO', () => {
  it('não carregam conta, entidade nem janela — a config de push é do APP, não da loja', () => {
    // `get_app_push_config` é keyed em `partner_id` sozinho: um `callback_url`
    // escalar, nenhum endereçamento por loja em lugar nenhum da página. Uma
    // janela seria pior que inútil — o resolvedor calcularia uma chave que nunca
    // foi criada e a linha ficaria de pé além da retenção de 90 dias.
    expect(chavePushDegradado()).toBe('shopeePushDegradado');
    expect(chavePushSuspenso()).toBe('shopeePushSuspenso');
  });
});

describe('avisarPushDegradado', () => {
  it('escreve UMA linha global com o plano exato que a caixa de avisos renderiza', async () => {
    const db = new FakeDb();

    const { chave, resultado } = await avisarPushDegradado(asDb(db), { status: 'Warning' }, deps());

    expect({ chave, resultado }).toEqual({ chave: 'shopeePushDegradado', resultado: 'criado' });
    expect(Object.keys(db.store)).toEqual([PATH_DEGRADADO]);
    expect(db.store[PATH_DEGRADADO]?.data).toMatchObject({
      tipo: 'shopeePushDegradado',
      severidade: 'atencao',
      canal: 'shopee',
      // `mensagens.ts` lê exatamente `status`, e cita o provedor VERBATIM.
      params: { status: 'Warning' },
      urlInterna: null,
      ocorrencias: 1,
      resolvidoEm: null,
      // Nunca um prazo: `get_app_push_config` não devolve nenhum para um Warning.
      prazo: null,
      relogioEvento: null,
    });
  });

  it('⚠️ nunca carrega relogioEvento — uma segunda tick REPETE, e criadoEm não se move', async () => {
    // O near-miss: passar o relógio de parede faria cada dia parecer um evento
    // mais novo e derrotaria o próprio watermark que finge ser. Como não há
    // relógio nenhum para um Warning, `ocorrencias` conta DIAS em warning e o
    // operador não é re-alertado.
    const db = new FakeDb();

    await avisarPushDegradado(asDb(db), { status: 'Warning' }, deps());
    const segunda = await avisarPushDegradado(
      asDb(db),
      { status: 'Warning' },
      deps(AGORA_MS + DIA_MS),
    );

    expect(segunda.resultado).toBe('repetido');
    const patch = db.patches.at(-1)?.patch ?? {};
    expect('relogioEvento' in patch).toBe(false);
    expect('prazo' in patch).toBe(false);
    expect(db.store[PATH_DEGRADADO]?.data).toMatchObject({
      criadoEm: AGORA_MS * 1000,
      ocorrencias: 2,
    });
  });
});

describe('avisarPushSuspenso', () => {
  it('⚠️ é CRÍTICO — é o único evento Shopee que perde dados de forma irrecuperável', async () => {
    // Pré-decidido em `packages/schemas/src/aviso.ts`, que nomeia este call
    // site. As mensagens perdidas durante a suspensão NÃO são reenviadas, e a
    // fila de 3 dias não cobre uma suspensão.
    const db = new FakeDb();

    const { chave, resultado } = await avisarPushSuspenso(asDb(db), {}, deps());

    expect({ chave, resultado }).toEqual({ chave: 'shopeePushSuspenso', resultado: 'criado' });
    expect(db.store[PATH_SUSPENSO]?.data).toMatchObject({
      tipo: 'shopeePushSuspenso',
      severidade: 'critico',
      canal: 'shopee',
      urlInterna: null,
      // A mensagem renderizada não lê parâmetro nenhum; um param que nada
      // renderiza é um campo que deriva em silêncio.
      params: {},
      prazo: null,
    });
  });

  it('carrega suspended_time em MILLIS como relogioEvento', async () => {
    const db = new FakeDb();

    await avisarPushSuspenso(asDb(db), { suspendedTimeMs: AGORA_MS - 3_600_000 }, deps());

    expect(db.store[PATH_SUSPENSO]?.data.relogioEvento).toBe(AGORA_MS - 3_600_000);
    // ⚠️ NUNCA em `prazo`: `suspended_time` é um INÍCIO, e `prazo` renderiza como
    // um limite — mostraria "Prazo: <uma data no passado>".
    expect(db.store[PATH_SUSPENSO]?.data.prazo).toBeNull();
  });

  it('⚠️ duas ticks na MESMA suspensão são ignoradas — ocorrencias conta suspensões, não dias', async () => {
    const db = new FakeDb();
    const inicio = AGORA_MS - 3_600_000;

    await avisarPushSuspenso(asDb(db), { suspendedTimeMs: inicio }, deps());
    const segunda = await avisarPushSuspenso(
      asDb(db),
      { suspendedTimeMs: inicio },
      deps(AGORA_MS + DIA_MS),
    );

    expect(segunda.resultado).toBe('ignorado');
    expect(db.store[PATH_SUSPENSO]?.data.ocorrencias).toBe(1);
  });

  it('uma NOVA suspensão (suspended_time maior) REABRE com criadoEm fresco', async () => {
    const db = new FakeDb();

    await avisarPushSuspenso(asDb(db), { suspendedTimeMs: AGORA_MS - 3_600_000 }, deps());
    await resolverAvisosDePush(asDb(db), { nowMs: AGORA_MS + 1000 });
    const nova = await avisarPushSuspenso(
      asDb(db),
      { suspendedTimeMs: AGORA_MS + DIA_MS },
      deps(AGORA_MS + DIA_MS + 1000),
    );

    expect(nova.resultado).toBe('reaberto');
    expect(db.store[PATH_SUSPENSO]?.data).toMatchObject({
      criadoEm: (AGORA_MS + DIA_MS + 1000) * 1000,
      resolvidoEm: null,
      ocorrencias: 2,
    });
  });

  it('⚠️ sem suspended_time o campo é OMITIDO, nunca null — um watermark zerado nunca mais rejeita', async () => {
    // O near-miss do teste acima. `camposInformados` lê um opcional ausente como
    // "não sei" e um `null` como "grave null": zerar o watermark faria a próxima
    // leitura da MESMA suspensão reabrir a linha em vez de ser ignorada.
    const db = new FakeDb();

    await avisarPushSuspenso(asDb(db), { suspendedTimeMs: AGORA_MS - 3_600_000 }, deps());
    await avisarPushSuspenso(asDb(db), {}, deps(AGORA_MS + DIA_MS));

    const patch = db.patches.at(-1)?.patch ?? {};
    expect('relogioEvento' in patch).toBe(false);
    expect('prazo' in patch).toBe(false);
    // O watermark gravado sobreviveu à escrita sem relógio.
    expect(db.store[PATH_SUSPENSO]?.data.relogioEvento).toBe(AGORA_MS - 3_600_000);
  });
});

describe('resolverAvisosDePush', () => {
  it('fecha as DUAS linhas e reporta a TRANSIÇÃO — uma linha já resolvida responde false', async () => {
    const db = new FakeDb();
    await avisarPushDegradado(asDb(db), { status: 'Warning' }, deps());
    await avisarPushSuspenso(asDb(db), { suspendedTimeMs: AGORA_MS - 1000 }, deps());

    const primeira = await resolverAvisosDePush(asDb(db), { nowMs: AGORA_MS + 1000 });
    const segunda = await resolverAvisosDePush(asDb(db), { nowMs: AGORA_MS + 2000 });

    expect(primeira).toEqual({ degradado: true, suspenso: true });
    // ⚠️ Contar "pedimos por duas linhas" inflaria o contador para sempre e
    // re-carimbaria `resolvidoEm`, empurrando a linha para além do corte de 90
    // dias do `sweepAvisosResolvidos`.
    expect(segunda).toEqual({ degradado: false, suspenso: false });
    expect(db.store[PATH_DEGRADADO]?.data).toMatchObject({
      resolvidoEm: (AGORA_MS + 1000) * 1000,
      resolucaoMotivo: MOTIVO_PUSH_NORMALIZADO,
    });
    expect(db.store[PATH_SUSPENSO]?.data.resolvidoEm).toBe((AGORA_MS + 1000) * 1000);
  });

  it('uma linha que nunca existiu responde false — não cria nada', async () => {
    const db = new FakeDb();

    expect(await resolverAvisosDePush(asDb(db), { nowMs: AGORA_MS })).toEqual({
      degradado: false,
      suspenso: false,
    });
    expect(Object.keys(db.store)).toEqual([]);
  });

  it('resolverPushSuspenso fecha SÓ o suspenso — o degradado fica de pé', async () => {
    // É o que o ramo `warning` do monitor usa: ser reportado como Warning é
    // prova positiva de que a assinatura está viva.
    const db = new FakeDb();
    await avisarPushDegradado(asDb(db), { status: 'Warning' }, deps());
    await avisarPushSuspenso(asDb(db), { suspendedTimeMs: AGORA_MS - 1000 }, deps());

    expect(await resolverPushSuspenso(asDb(db), { nowMs: AGORA_MS + 1000 })).toBe(true);

    expect(db.store[PATH_SUSPENSO]?.data.resolvidoEm).toBe((AGORA_MS + 1000) * 1000);
    expect(db.store[PATH_DEGRADADO]?.data.resolvidoEm).toBeNull();
  });
});
