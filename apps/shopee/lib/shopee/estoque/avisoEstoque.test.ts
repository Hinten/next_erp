import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ⚠️ The REAL `escreverAviso` / `resolverAviso` over the shared fake Firestore,
// never a mock of them: the property under test is the PLANO this producer hands
// over — which fields it states, which it deliberately OMITS — and a mocked
// writer cannot show that. Same argument as `anuncios/avisoAnuncio.test.ts`.
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  RESOLUCAO_ESTOQUE_DENTRO_DO_DISPONIVEL,
  avisarEstoqueAcimaDoDisponivel,
  chaveEstoqueAcimaDoDisponivel,
  resolverEstoqueAcimaDoDisponivel,
} from './avisoEstoque';

const AGORA_MS = 1_760_000_000_000;
/** One day in ms, spelled from its factors — the folder bans the literal. */
const DIA_MS = 24 * 60 * 60 * 1000;
const INTEGRACAO = 'int-1';
const PRODUTO = 'prod-abc';
const ITEM_ID = 2_500_139_861;
const PISO = 12;
const DISPONIVEL = 5;

/** Recognisable stand-ins for the provider PROSE that must never be stored. */
const PROSA_NOME = 'PROSA-NOME: Camiseta Premium Algodao Pima da Loja Exemplo';
const PROSA_PROMOCAO = 'PROSA-PROMOCAO: Mega Liquidacao de Aniversario da Loja';

const CHAVE = chaveEstoqueAcimaDoDisponivel(INTEGRACAO, PRODUTO);
const PATH = `avisos/${CHAVE}`;

const deps = (nowMs = AGORA_MS) => ({ increment, nowMs });

type Entrada = Parameters<typeof avisarEstoqueAcimaDoDisponivel>[1];
/** An entrada carrying raw wire keys beside the declared ones — see the prose test. */
type EntradaCrua = Entrada & Record<string, unknown>;

function entrada(over: Partial<Entrada> = {}): Entrada {
  return {
    integracaoId: INTEGRACAO,
    produtoId: PRODUTO,
    itemId: ITEM_ID,
    piso: PISO,
    disponivel: DISPONIVEL,
    ...over,
  };
}

const FONTE = readFileSync(fileURLToPath(new URL('./avisoEstoque.ts', import.meta.url)), 'utf8');

describe('a chave', () => {
  it('1 — carrega (tipo, conta, produto) e NENHUMA janela', async () => {
    // Uma janela keyed na promoção — seu id, sua data de fim, o número
    // reservado — faria o resolvedor calcular uma chave que nunca foi criada,
    // porque a Shopee muda a promoção por baixo de nós. A linha ficaria de pé
    // para sempre, além do corte de 90 dias da retenção, numa coleção
    // `serverOwned` que ninguém dispensa à mão.
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());

    expect(Object.keys(db.store)).toEqual([PATH]);
    expect(CHAVE).toBe(`estoqueAcimaDoDisponivel:${INTEGRACAO}:${PRODUTO}`);
  });

  it('2 — ⚠️ NEAR-MISS: dois produtos na mesma conta têm chaves DISTINTAS', () => {
    expect(chaveEstoqueAcimaDoDisponivel(INTEGRACAO, PRODUTO)).not.toBe(
      chaveEstoqueAcimaDoDisponivel(INTEGRACAO, 'prod-xyz'),
    );
  });

  it('3 — ⚠️ NEAR-MISS: o MESMO produto em duas contas também', () => {
    expect(chaveEstoqueAcimaDoDisponivel(INTEGRACAO, PRODUTO)).not.toBe(
      chaveEstoqueAcimaDoDisponivel('int-2', PRODUTO),
    );
  });

  it('4 — ⚠️ PAR: dois produtoIds que diferem só num ponto vs um sublinhado COLAPSAM', () => {
    // O custo aceito do `segmentoChave`, que dobra `/ \ . # [ ] :` e espaço em
    // `_` para que a chave possa ser o id do documento. Um id do Firestore pode
    // legalmente conter ponto, então isto é alcançável e não hipotético.
    expect(chaveEstoqueAcimaDoDisponivel(INTEGRACAO, 'prod.abc')).toBe(
      chaveEstoqueAcimaDoDisponivel(INTEGRACAO, 'prod_abc'),
    );
  });

  it('5 — é a entidade PRODUTO, nunca o item_id — um republish com item_id novo cai na MESMA linha', () => {
    expect(CHAVE).toContain(PRODUTO);
    expect(CHAVE).not.toContain(String(ITEM_ID));
  });
});

describe('avisarEstoqueAcimaDoDisponivel', () => {
  it('6 — escreve o plano exato que a caixa de avisos renderiza', async () => {
    const db = new FakeDb();

    const resultado = await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());

    expect(resultado).toBe('criado');
    expect(db.store[PATH]?.data).toMatchObject({
      tipo: 'estoqueAcimaDoDisponivel',
      canal: 'shopee',
      // `mensagens.ts` lê exatamente `anuncio`, `reservado` e `disponivel`.
      params: {
        anuncio: String(ITEM_ID),
        reservado: String(PISO),
        disponivel: String(DISPONIVEL),
      },
      ocorrencias: 1,
      resolvidoEm: null,
    });
  });

  it("7 — severidade é 'atencao', nunca 'critico'", async () => {
    // O anúncio está NO AR e vendendo, a quantidade chegou à Shopee, e a
    // exposição é a diferença entre os dois números do `params`. `critico` é o
    // único nível que escala para fora do app e precisa ficar raro o bastante
    // para ninguém aprender a ignorá-lo.
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());

    expect(db.store[PATH]?.data.severidade).toBe('atencao');
    expect(db.store[PATH]?.data.severidade).not.toBe('critico');
  });

  it('8 — params tem EXATAMENTE anuncio/reservado/disponivel e mais NADA', async () => {
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());

    // Uma allow-list, não um `toMatchObject`: a asserção tem de falhar quando
    // alguém ACRESCENTA um param, que é exatamente como o nome de um anúncio
    // chegaria à caixa do operador.
    expect(db.store[PATH]?.data.params).toEqual({
      anuncio: String(ITEM_ID),
      reservado: String(PISO),
      disponivel: String(DISPONIVEL),
    });
  });

  it('9 — params só carrega DÍGITOS, e prosa do provedor nunca entra no documento', async () => {
    // ⚠️ O título de um anúncio e o corpo de uma promoção são PROSA do provedor
    // sobre o produto de um vendedor, e `params` é renderizado direto na caixa
    // do operador. A entrada abaixo CARREGA as duas chaves do wire de propósito
    // — um produtor que as lesse seria visto aqui, e a asserção é sobre o
    // documento INTEIRO, não só sobre `params`.
    const db = new FakeDb();
    const comProsa: EntradaCrua = {
      ...entrada(),
      item_name: PROSA_NOME,
      promotion_name: PROSA_PROMOCAO,
    };
    await avisarEstoqueAcimaDoDisponivel(asDb(db), comProsa, deps());

    const documento = JSON.stringify(db.store[PATH]?.data);
    for (const sentinela of [PROSA_NOME, PROSA_PROMOCAO]) {
      expect(documento, `o documento inteiro vazou "${sentinela}"`).not.toContain(sentinela);
    }

    const params = db.store[PATH]?.data.params as Record<string, string> | undefined;
    expect(params).toBeDefined();
    for (const [chave, valor] of Object.entries(params ?? {})) {
      expect(typeof valor, chave).toBe('string');
      expect(valor, chave).toMatch(/^\d+$/);
    }
  });

  it('10 — urlInterna aponta para /produtos/<id>, não para /canais/shopee/<id>', async () => {
    // Um operador mandado para a tela da conta não aprende NADA sobre qual
    // anúncio está vendido além do que temos — e os dois remédios (repor
    // estoque, ou encerrar a promoção deste item) partem do produto.
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());

    expect(db.store[PATH]?.data.urlInterna).toEqual({
      rota: `/produtos/${PRODUTO}`,
      campo: null,
    });
  });

  it('11 — prazo e relogioEvento são OMITIDOS: AUSENTES do patch, nunca null', async () => {
    // ⚠️ O CREATE preenche todo opcional (o documento tem de ser completo e o
    // SDK rejeita `undefined`), então é o PATCH do repeat que mostra a omissão.
    // `camposInformados` lê um opcional ausente como "não sei" e um `null` como
    // "põe null": passar `null` em `relogioEvento` RESETARIA o watermark
    // guardado, e um watermark resetado é uma guarda que nunca mais rejeita
    // nada. Aqui não há entrega de provedor nenhuma — o aviso nasce do NOSSO
    // envio, no NOSSO relógio.
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps(AGORA_MS + 1000));

    const patch = db.patches.find((p) => p.path === PATH)?.patch ?? {};
    expect('prazo' in patch).toBe(false);
    expect('relogioEvento' in patch).toBe(false);
    // …e o documento criado os declara `null`, que é o writer preenchendo, não
    // este módulo informando.
    expect(db.store[PATH]?.data.prazo).toBeNull();
    expect(db.store[PATH]?.data.relogioEvento).toBeNull();
  });

  it('12 — um segundo clamp do MESMO (conta, produto) ATUALIZA a linha: 1 documento, `reservado` novo', async () => {
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());
    const repetido = await avisarEstoqueAcimaDoDisponivel(
      asDb(db),
      entrada({ piso: 40 }),
      deps(AGORA_MS + 1000),
    );

    expect(repetido).toBe('repetido');
    expect(Object.keys(db.store)).toEqual([PATH]);
    expect(db.store[PATH]?.data.params).toEqual({
      anuncio: String(ITEM_ID),
      reservado: '40',
      disponivel: String(DISPONIVEL),
    });
    expect(db.store[PATH]?.data.ocorrencias).toBe(2);
    // Um repeat NÃO move `criadoEm` — é para isso que serve a dedup, e
    // `ocorrencias` já registra a recorrência sem re-alertar o operador.
    expect(db.store[PATH]?.data.criadoEm).toBe(AGORA_MS * 1000);
  });

  it('13 — ⚠️ NEAR-MISS: outro produto na mesma conta cria uma SEGUNDA linha', async () => {
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());
    await avisarEstoqueAcimaDoDisponivel(
      asDb(db),
      entrada({ produtoId: 'prod-xyz' }),
      deps(AGORA_MS + 1000),
    );

    expect(Object.keys(db.store).sort()).toEqual(
      [PATH, `avisos/${chaveEstoqueAcimaDoDisponivel(INTEGRACAO, 'prod-xyz')}`].sort(),
    );
  });

  it('14 — reabre com um criadoEm NOVO depois de resolvido', async () => {
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());
    await resolverEstoqueAcimaDoDisponivel(
      asDb(db),
      { integracaoId: INTEGRACAO, produtoId: PRODUTO },
      deps(AGORA_MS + DIA_MS),
    );

    const reaberto = await avisarEstoqueAcimaDoDisponivel(
      asDb(db),
      entrada(),
      deps(AGORA_MS + 2 * DIA_MS),
    );

    expect(reaberto).toBe('reaberto');
    expect(db.store[PATH]?.data).toMatchObject({
      criadoEm: (AGORA_MS + 2 * DIA_MS) * 1000,
      resolvidoEm: null,
      resolucaoMotivo: null,
    });
  });
});

describe('resolverEstoqueAcimaDoDisponivel', () => {
  it('15 — calcula a MESMA chave que o produtor e fecha a linha com o motivo', async () => {
    // ⚠️ É a mesma função exportada, e é esse o ponto de exportá-la: um
    // resolvedor que deriva a própria chave é como uma linha fica de pé para
    // sempre.
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());

    await expect(
      resolverEstoqueAcimaDoDisponivel(
        asDb(db),
        { integracaoId: INTEGRACAO, produtoId: PRODUTO },
        deps(AGORA_MS + DIA_MS),
      ),
    ).resolves.toBe(true);

    expect(db.store[PATH]?.data).toMatchObject({
      resolvidoEm: (AGORA_MS + DIA_MS) * 1000,
      resolucaoMotivo: 'estoque-dentro-do-disponivel',
    });
    expect(RESOLUCAO_ESTOQUE_DENTRO_DO_DISPONIVEL).toBe('estoque-dentro-do-disponivel');
  });

  it('16 — uma linha JÁ resolvida responde false e não escreve NADA', async () => {
    // É uma TRANSIÇÃO, não a existência do documento: re-carimbar `resolvidoEm`
    // a cada envio limpo empurraria a linha para longe do corte de 90 dias da
    // retenção para sempre, e faria o contador `avisosResolvidos` do chamador
    // relatar fechamentos que nunca aconteceram.
    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps());
    const alvo = { integracaoId: INTEGRACAO, produtoId: PRODUTO };

    await resolverEstoqueAcimaDoDisponivel(asDb(db), alvo, deps(AGORA_MS + DIA_MS));
    const escritasAntes = db.writes.length;

    await expect(
      resolverEstoqueAcimaDoDisponivel(asDb(db), alvo, deps(AGORA_MS + 2 * DIA_MS)),
    ).resolves.toBe(false);

    expect(db.writes.length).toBe(escritasAntes);
    expect(db.store[PATH]?.data.resolvidoEm).toBe((AGORA_MS + DIA_MS) * 1000);
  });

  it('17 — uma linha que nunca existiu responde false, sem ressuscitar documento nenhum', async () => {
    const db = new FakeDb();

    await expect(
      resolverEstoqueAcimaDoDisponivel(
        asDb(db),
        { integracaoId: INTEGRACAO, produtoId: PRODUTO },
        deps(),
      ),
    ).resolves.toBe(false);

    expect(db.store[PATH]).toBeUndefined();
    expect(db.writes).toEqual([]);
    expect(db.patches).toEqual([]);
  });
});

describe('a disciplina da pasta', () => {
  it('18 — o módulo não lê relógio nenhum: o instante é um PARÂMETRO', async () => {
    // O mesmo grep que a pasta inteira tem de passar, replicado para este
    // arquivo — e o teste abaixo prova o outro lado: dois envios com instantes
    // diferentes carimbam instantes diferentes, então o módulo só pode estar
    // lendo o que lhe foi passado.
    for (const proibido of ['Date.now(', 'setTimeout(', 'setInterval(']) {
      expect(FONTE, proibido).not.toContain(proibido);
    }

    const db = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(db), entrada(), deps(AGORA_MS));
    expect(db.store[PATH]?.data.criadoEm).toBe(AGORA_MS * 1000);

    const outro = new FakeDb();
    await avisarEstoqueAcimaDoDisponivel(asDb(outro), entrada(), deps(AGORA_MS + DIA_MS));
    expect(outro.store[PATH]?.data.criadoEm).toBe((AGORA_MS + DIA_MS) * 1000);
  });

  it('19 — o módulo não converte unidade nenhuma: os µs vêm do selo compartilhado', () => {
    // `avisos/autorizacao.ts` é o módulo que atravessa para microssegundos
    // neste app, e continua sendo: este arquivo importa o selo em vez de
    // reproduzi-lo, o que é o que mantém a lista de SITES em
    // `apps/shopee/CLAUDE.md` do tamanho que ela declara.
    for (const conversor of ['millisToMicros', 'coerceToMicros', 'microsToMillis']) {
      expect(FONTE, conversor).not.toContain(conversor);
    }
    expect(FONTE).toContain("from '../avisos/autorizacao'");
  });

  it('20 — o módulo nunca soletra item_name, nem em comentário', () => {
    // O grep é sobre TEXTO CRU de propósito: um comentário dizendo "poderíamos
    // mandar o item_name aqui" é exatamente o convite que este teste recusa.
    expect(FONTE).not.toContain('item_name');
    expect(FONTE).not.toContain('promotion_name');
  });
});
