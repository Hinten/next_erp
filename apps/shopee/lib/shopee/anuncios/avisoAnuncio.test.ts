import { describe, expect, it } from 'vitest';

// ⚠️ The REAL `escreverAviso` / `resolverAviso` over the shared fake Firestore,
// never a mock of them: the property under test is the PLANO this producer hands
// over — which fields it states, which it deliberately OMITS — and a mocked
// writer cannot show that.
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  MOTIVO_AVISO_ANUNCIO,
  MOTIVO_RESOLUCAO_ANUNCIO,
  avisarAnuncioComViolacao,
  chaveAnuncioComViolacao,
  resolverAvisoDeAnuncio,
} from './avisoAnuncio';

const AGORA_MS = 1_760_000_000_000;
const DIA_MS = 86_400_000;
const INTEGRACAO = 'int-1';
const PRODUTO = 'prod-abc';
const ITEM_ID = 2_500_139_861;

/** A recognisable stand-in for the provider PROSE that must never be stored. */
const PROSA_RAZAO = 'PROSA-RAZAO: o titulo deste anuncio copia o de outra loja';
const PROSA_SUGESTAO = 'PROSA-SUGESTAO: mova o anuncio para a categoria sugerida';

const PRAZO_MS = AGORA_MS + 7 * DIA_MS;

const CHAVE = chaveAnuncioComViolacao(INTEGRACAO, PRODUTO);
const PATH = `avisos/${CHAVE}`;

const deps = (nowMs = AGORA_MS) => ({ increment, nowMs });

type Evento = Parameters<typeof avisarAnuncioComViolacao>[1];
/** An event carrying raw wire keys beside the declared ones — see the prose test. */
type EventoCru = Evento & Record<string, unknown>;

function evento(over: Partial<Evento> = {}): Evento {
  return {
    integracaoId: INTEGRACAO,
    produtoId: PRODUTO,
    itemId: ITEM_ID,
    motivo: MOTIVO_AVISO_ANUNCIO.violacao,
    violacaoTipo: 'Spam',
    prazoMs: PRAZO_MS,
    ...over,
  };
}

describe('a chave', () => {
  it('carrega (tipo, conta, produto) e NENHUMA janela', async () => {
    // Uma janela keyed na violação — no tipo, ou no `fix_deadline_time` — faria o
    // resolvedor calcular uma chave que nunca foi criada, porque a Shopee muda a
    // violação conforme o vendedor edita. A linha ficaria de pé para sempre, além
    // do corte de 90 dias da retenção, numa coleção `serverOwned` que ninguém
    // dispensa à mão.
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());

    expect(Object.keys(db.store)).toEqual([PATH]);
    expect(CHAVE).toBe(`anuncioComViolacao:${INTEGRACAO}:${PRODUTO}`);
  });

  it('⚠️ NEAR-MISS: dois produtos na mesma conta têm chaves DISTINTAS', () => {
    expect(chaveAnuncioComViolacao(INTEGRACAO, PRODUTO)).not.toBe(
      chaveAnuncioComViolacao(INTEGRACAO, 'prod-xyz'),
    );
  });

  it('⚠️ NEAR-MISS: o MESMO produto em duas contas também', () => {
    expect(chaveAnuncioComViolacao(INTEGRACAO, PRODUTO)).not.toBe(
      chaveAnuncioComViolacao('int-2', PRODUTO),
    );
  });

  it('⚠️ PAR: dois produtoIds que diferem só num ponto vs um sublinhado COLAPSAM', () => {
    // O custo aceito do `segmentoChave`, que dobra `/ \ . # [ ] :` e espaço em
    // `_` para que a chave possa ser o id do documento. Um id do Firestore pode
    // legalmente conter ponto, então isto é alcançável e não hipotético — e um
    // leitor não pode ser pego de surpresa por ele.
    expect(chaveAnuncioComViolacao(INTEGRACAO, 'prod.abc')).toBe(
      chaveAnuncioComViolacao(INTEGRACAO, 'prod_abc'),
    );
  });

  it('é a entidade PRODUTO, nunca o item_id — um republish com item_id novo cai na MESMA linha', () => {
    // Um produto republicado sob um `item_id` novo (delete + publicar de novo)
    // tem de colapsar na linha que o operador já conhece, em vez de cunhar uma
    // segunda para o mesmo problema.
    expect(CHAVE).toContain(PRODUTO);
    expect(CHAVE).not.toContain(String(ITEM_ID));
  });
});

describe('avisarAnuncioComViolacao', () => {
  it('escreve o plano exato que a caixa de avisos renderiza', async () => {
    const db = new FakeDb();

    const out = await avisarAnuncioComViolacao(asDb(db), evento(), deps());

    expect(out).toEqual({ chave: CHAVE, resultado: 'criado' });
    expect(db.store[PATH]?.data).toMatchObject({
      tipo: 'anuncioComViolacao',
      canal: 'shopee',
      // `mensagens.ts` lê exatamente `anuncio` e `violacao`.
      params: { anuncio: String(ITEM_ID), violacao: 'Spam' },
      motivo: MOTIVO_AVISO_ANUNCIO.violacao,
      ocorrencias: 1,
      resolvidoEm: null,
    });
  });

  it("severidade é 'atencao', nunca 'critico'", async () => {
    // O anúncio está fora do ar em UM canal e o remédio é o Seller Centre ou a
    // aba do produto. `critico` é o único nível que escala para fora do app e
    // precisa ficar raro o bastante para ninguém aprender a ignorá-lo.
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());

    expect(db.store[PATH]?.data.severidade).toBe('atencao');
    expect(db.store[PATH]?.data.severidade).not.toBe('critico');
  });

  it('params leva o item_id e o violation_type, e NUNCA violation_reason nem suggestion', async () => {
    // ⚠️ As duas são PROSA do provedor sobre o anúncio de um vendedor, estão no
    // denylist de redação de fixture por isso mesmo, e `params` é renderizado
    // direto na caixa do operador. `violation_type` é vocabulário FECHADO de
    // sete valores e é seguro por construção.
    //
    // O evento abaixo CARREGA as duas chaves do wire de propósito — um produtor
    // que as lesse (ou que trocasse `violacaoTipo` por uma delas) seria visto
    // aqui, e a asserção é sobre o documento INTEIRO, não só sobre `params`.
    const db = new FakeDb();
    const comProsa: EventoCru = {
      ...evento({ violacaoTipo: 'Inappropriate Image' }),
      violation_reason: PROSA_RAZAO,
      suggestion: PROSA_SUGESTAO,
    };
    await avisarAnuncioComViolacao(asDb(db), comProsa, deps());

    const documento = JSON.stringify(db.store[PATH]?.data);
    for (const sentinela of [PROSA_RAZAO, PROSA_SUGESTAO]) {
      expect(documento, `o documento inteiro vazou "${sentinela}"`).not.toContain(sentinela);
    }
    expect(db.store[PATH]?.data.params).toEqual({
      anuncio: String(ITEM_ID),
      violacao: 'Inappropriate Image',
    });
  });

  it('sem violation_type, params.violacao é a frase do PRÓPRIO app, uma por motivo', async () => {
    // `push 27` não carrega violação nenhuma, e uma linha de
    // `item_status_details[]` pode chegar com `violation_type` nulo — os três
    // braços são alcançáveis, e nenhum deles pode cair em prosa do provedor.
    const casos = [
      [MOTIVO_AVISO_ANUNCIO.violacao, 'violação sem tipo informado'],
      [MOTIVO_AVISO_ANUNCIO.deboost, 'rebaixamento na busca'],
      [MOTIVO_AVISO_ANUNCIO.agendamentoFalhou, 'publicação agendada falhou'],
    ] as const;

    for (const [motivo, frase] of casos) {
      const db = new FakeDb();
      await avisarAnuncioComViolacao(asDb(db), evento({ motivo, violacaoTipo: null }), deps());
      expect(db.store[PATH]?.data.params, motivo).toEqual({
        anuncio: String(ITEM_ID),
        violacao: frase,
      });
      expect(db.store[PATH]?.data.motivo, motivo).toBe(motivo);
    }
  });

  it('params.prazo é OMITIDO; o prazo vai no CAMPO, em microssegundos', async () => {
    // ⚠️ A mensagem renderizada interpola `params.prazo` CRU, então um número ali
    // sairia como `Prazo para corrigir: 1760604800000000.`. Omitir o param faz o
    // ramo não disparar; o CAMPO carrega o prazo para o painel formatar.
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());

    const guardado = db.store[PATH]?.data;
    expect(guardado?.params).not.toHaveProperty('prazo');
    expect(guardado?.prazo).toBe(PRAZO_MS * 1000);
    // NEAR-MISS: em milissegundos NÃO pode passar.
    expect(guardado?.prazo).not.toBe(PRAZO_MS);
  });

  it('converte o prazo no PATCH CRU de um repeat, não só na criação', async () => {
    // ⚠️ A asserção acima lê o documento CRIADO, que `escreverAviso`
    // full-parseia — e `microsSinceEpoch` promove tolerantemente um inteiro de
    // magnitude ms. O caminho de REPEAT é onde a tolerância para: é um `update`
    // cru, então o valor vai a Firestore exatamente como este módulo o escreveu.
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());
    await avisarAnuncioComViolacao(asDb(db), evento(), deps(AGORA_MS + 1000));

    const patch = db.patches.find((p) => p.path === PATH)?.patch;
    expect(patch?.prazo).toBe(PRAZO_MS * 1000);
    expect(patch?.prazo).not.toBe(PRAZO_MS);
    expect(patch?.atualizadoEm).toBe((AGORA_MS + 1000) * 1000);
  });

  it('um prazo AUSENTE é declarado como null, não inventado', async () => {
    // `push 16` documenta `fix_deadline_time` como "Empty if no deadline": null
    // é uma leitura legítima, e um prazo que nós inventássemos seria pior que
    // nenhum.
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento({ prazoMs: null }), deps());

    expect(db.store[PATH]?.data.prazo).toBeNull();
  });

  it('urlInterna aponta para /produtos/<id>, não para /canais/shopee/<id>', async () => {
    // Um operador mandado para a tela da conta não aprende NADA sobre qual
    // anúncio está banido.
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());

    expect(db.store[PATH]?.data.urlInterna).toEqual({
      rota: `/produtos/${PRODUTO}`,
      campo: null,
    });
  });

  it('relogioEvento é o carimbo do push, espalhado-ou-nada', async () => {
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());
    await avisarAnuncioComViolacao(
      asDb(db),
      evento({ relogioEventoMs: AGORA_MS + 500 }),
      deps(AGORA_MS + 1000),
    );

    const patch = db.patches.find((p) => p.path === PATH)?.patch;
    expect(patch?.relogioEvento).toBe(AGORA_MS + 500);
  });

  it('⚠️ o caminho do reverificar NÃO passa a chave — nem como null', async () => {
    // Uma ausência quer dizer "não sei" e deixa o watermark guardado em paz;
    // `null` o RESETARIA, e um watermark resetado é uma guarda que nunca mais
    // rejeita nada — a próxima reentrega velha seria aplicada em vez de largada.
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());
    await avisarAnuncioComViolacao(asDb(db), evento(), deps(AGORA_MS + 1000));

    const patch = db.patches.find((p) => p.path === PATH)?.patch ?? {};
    expect('relogioEvento' in patch).toBe(false);
  });

  it("uma segunda entrega do MESMO push é 'ignorado' pelo watermark", async () => {
    const db = new FakeDb();
    const comRelogio = evento({ relogioEventoMs: AGORA_MS });

    const primeira = await avisarAnuncioComViolacao(asDb(db), comRelogio, deps());
    const segunda = await avisarAnuncioComViolacao(asDb(db), comRelogio, deps(AGORA_MS + 1000));

    expect(primeira.resultado).toBe('criado');
    expect(segunda.resultado).toBe('ignorado');
    expect(db.store[PATH]?.data.ocorrencias).toBe(1);
  });

  it('repete sem mover criadoEm, e reabre com um criadoEm NOVO', async () => {
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());
    const repetido = await avisarAnuncioComViolacao(asDb(db), evento(), deps(AGORA_MS + 1000));

    expect(repetido.resultado).toBe('repetido');
    expect(db.store[PATH]?.data.criadoEm).toBe(AGORA_MS * 1000);

    await resolverAvisoDeAnuncio(
      asDb(db),
      { integracaoId: INTEGRACAO, produtoId: PRODUTO },
      MOTIVO_RESOLUCAO_ANUNCIO.normalizado,
      { nowMs: AGORA_MS + DIA_MS },
    );
    const reaberto = await avisarAnuncioComViolacao(
      asDb(db),
      evento(),
      deps(AGORA_MS + 2 * DIA_MS),
    );

    expect(reaberto.resultado).toBe('reaberto');
    expect(db.store[PATH]?.data).toMatchObject({
      criadoEm: (AGORA_MS + 2 * DIA_MS) * 1000,
      resolvidoEm: null,
      resolucaoMotivo: null,
    });
  });
});

describe('resolverAvisoDeAnuncio', () => {
  it('calcula a MESMA chave que o produtor', async () => {
    // ⚠️ É a mesma função exportada, e é esse o ponto de exportá-la: um
    // resolvedor que deriva a própria chave é como uma linha fica de pé para
    // sempre.
    const db = new FakeDb();
    const { chave } = await avisarAnuncioComViolacao(asDb(db), evento(), deps());

    expect(chaveAnuncioComViolacao(INTEGRACAO, PRODUTO)).toBe(chave);

    await expect(
      resolverAvisoDeAnuncio(
        asDb(db),
        { integracaoId: INTEGRACAO, produtoId: PRODUTO },
        MOTIVO_RESOLUCAO_ANUNCIO.normalizado,
        { nowMs: AGORA_MS + DIA_MS },
      ),
    ).resolves.toBe(true);

    expect(db.store[PATH]?.data).toMatchObject({
      resolvidoEm: (AGORA_MS + DIA_MS) * 1000,
      resolucaoMotivo: MOTIVO_RESOLUCAO_ANUNCIO.normalizado,
    });
  });

  it('um aviso já resolvido responde false — é uma TRANSIÇÃO, não a existência do documento', async () => {
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());
    const alvo = { integracaoId: INTEGRACAO, produtoId: PRODUTO };

    await resolverAvisoDeAnuncio(asDb(db), alvo, MOTIVO_RESOLUCAO_ANUNCIO.normalizado, {
      nowMs: AGORA_MS + DIA_MS,
    });

    await expect(
      resolverAvisoDeAnuncio(asDb(db), alvo, MOTIVO_RESOLUCAO_ANUNCIO.normalizado, {
        nowMs: AGORA_MS + 2 * DIA_MS,
      }),
    ).resolves.toBe(false);
    // …e não re-carimba `resolvidoEm`, que empurraria a linha para longe do
    // corte de 90 dias da retenção a cada varredura.
    expect(db.store[PATH]?.data.resolvidoEm).toBe((AGORA_MS + DIA_MS) * 1000);
  });

  it('uma linha que nunca existiu responde false, sem ressuscitar documento nenhum', async () => {
    const db = new FakeDb();

    await expect(
      resolverAvisoDeAnuncio(
        asDb(db),
        { integracaoId: INTEGRACAO, produtoId: PRODUTO },
        MOTIVO_RESOLUCAO_ANUNCIO.removido,
        { nowMs: AGORA_MS },
      ),
    ).resolves.toBe(false);

    expect(db.store[PATH]).toBeUndefined();
  });

  it('o motivo REMOVIDO fecha a linha dizendo qual fato a fechou', async () => {
    // Um anúncio que a Shopee apagou não foi "normalizado", mas o aviso de
    // violação virou irrelevante e nada mais o fecharia — e um aviso que nada
    // resolve fica de pé até a retenção varrer, numa coleção sem botão de
    // dispensar.
    const db = new FakeDb();
    await avisarAnuncioComViolacao(asDb(db), evento(), deps());

    await expect(
      resolverAvisoDeAnuncio(
        asDb(db),
        { integracaoId: INTEGRACAO, produtoId: PRODUTO },
        MOTIVO_RESOLUCAO_ANUNCIO.removido,
        { nowMs: AGORA_MS + DIA_MS },
      ),
    ).resolves.toBe(true);

    expect(db.store[PATH]?.data.resolucaoMotivo).toBe('anuncio-removido');
    expect(MOTIVO_RESOLUCAO_ANUNCIO.normalizado).toBe('anuncio-normalizado');
  });
});
