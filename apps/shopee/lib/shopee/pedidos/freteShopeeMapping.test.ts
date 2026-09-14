import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  ESTADO_FRETE,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  efeitoEstoquePedido,
  estadoFreteSchema,
  freteDoPedidoSchema,
  pacoteFreteSchema,
  seedFreteInicial,
  type EstadoFrete,
  type PacoteFrete,
} from '@delfrance/schemas';

import {
  ESCADA_FRETE_SHOPEE,
  ESTADOS_FRETE_FORA_DO_CANAL,
  ESTADOS_FRETE_RETORNO,
  ESTADOS_FRETE_SHOPEE_TERMINAL,
  ESTADO_FRETE_DE_TOKEN_SHOPEE,
  FALHA_FRETE_SHOPEE,
  FIDELIDADE_FONTE_PACOTE_SHOPEE,
  FONTE_PACOTE_SHOPEE,
  LIMITE_COD_RASTREIO_SHOPEE,
  MOTIVO_FRETE_SHOPEE,
  MOTIVO_TOKEN_SHOPEE,
  ORDEM_FALHA_SHOPEE,
  TOKENS_DE_RETORNO_SHOPEE,
  dobrarPacotesShopee,
  estadoFreteDeTokenShopee,
  estadoFreteShopeeAplicavel,
  fidelidadeDaFonteShopee,
  mesclarPacotesShopee,
  type ObservacaoPacoteUs,
} from './freteShopeeMapping';
import type { FontePacoteShopee } from './fretePushShopee';

/* -------------------------------------------------------------------------- */
/*                          fixtures (fixture ids only)                        */
/* -------------------------------------------------------------------------- */

/** The doc page's own package number — sorts BEFORE `PKG_B` in code-unit order. */
const PKG_A = 'OFG199593509207187';
/** The package already committed to `__wire__`. */
const PKG_B = 'OFG242672552205937';

const T1 = 1_788_000_000_000_000;
const T2 = 1_788_000_060_000_000;
const T3 = 1_788_000_120_000_000;

const PACOTE_DETAIL = FONTE_PACOTE_SHOPEE.packageDetail;
const ORDER_DETAIL = FONTE_PACOTE_SHOPEE.orderDetail;

/** A stored diary row, built THROUGH the schema so every fixture is storable. */
function linha(over: Partial<PacoteFrete> & { numero: string }): PacoteFrete {
  return pacoteFreteSchema.parse(over);
}

/**
 * A row built WITHOUT the schema.
 *
 * `microsSinceEpoch` coerces by magnitude on parse, so {@link linha} is the
 * wrong tool for any fixture whose point is that a raw number travels untouched.
 */
function linhaCrua(numero: string, over: Partial<PacoteFrete> = {}): PacoteFrete {
  return {
    numero,
    estado: null,
    estadoMarketplace: null,
    codRastreio: null,
    canalId: null,
    prazoDespacho: null,
    atualizadoEm: null,
    fonte: null,
    ...over,
  };
}

/** One observation; everything the caller did not name is absent, not zero. */
function obs(over: Partial<ObservacaoPacoteUs> & { numero: string }): ObservacaoPacoteUs {
  return {
    estadoMarketplace: null,
    codRastreio: null,
    canalId: null,
    prazoDespachoUs: null,
    relogioUs: null,
    fonte: PACOTE_DETAIL,
    ...over,
  };
}

/** A row as the pull would leave it, so the worked examples read as diaries. */
function linhaDoToken(numero: string, token: string, over: Partial<PacoteFrete> = {}): PacoteFrete {
  const { pacotes } = mesclarPacotesShopee(
    [],
    [obs({ numero, estadoMarketplace: token, relogioUs: T1 })],
  );
  return linha({ ...pacotes[0]!, ...over });
}

/**
 * The REAL `ESTADOS_FRETE_REMOVE_ESTOQUE`, MEASURED rather than retyped.
 *
 * That set is declared in `packages/schemas/src/shared/frete.ts` but is not
 * re-exported from the package barrel, and nothing in this repo deep-imports the
 * package — so a second literal copy here would be exactly the two-copies-drift-
 * toward-plausible failure (#1369) this table exists to prevent. `efeitoEstoquePedido`
 * IS exported, and its `freteRemove` term is literally
 * `ESTADOS_FRETE_REMOVE_ESTOQUE.has(estadoFrete)`. With a saída operação that
 * moves both physical and reserved stock, a pedido estado that is neither
 * `finalizado` nor already moved, the whole entry condition collapses to that
 * one term — so `remover` IS the shared set's answer.
 */
function removeEstoqueCompartilhado(estadoFrete: EstadoFrete | null): boolean {
  return efeitoEstoquePedido({
    estado: ESTADO_PEDIDO.pago,
    estadoFrete,
    ehSaida: true,
    movimentaEstoque: true,
    movimentaIndisponivelEstoque: true,
    jaMovimentado: false,
  }).remover;
}

/* -------------------------------------------------------------------------- */
/*                       (1) the token → estado table                          */
/* -------------------------------------------------------------------------- */

describe('1 — a tabela token → EstadoFrete', () => {
  it.each([
    ['LOGISTICS_NOT_START', ESTADO_FRETE.iniciado],
    ['LOGISTICS_NOT_STARTED', ESTADO_FRETE.iniciado],
    ['LOGISTICS_READY', ESTADO_FRETE.despachoAutorizado],
    ['LOGISTICS_REQUEST_CREATED', ESTADO_FRETE.aguardandoPostagem],
    ['LOGISTICS_PICKUP_RETRY', ESTADO_FRETE.aguardandoPostagem],
    ['LOGISTICS_PICKUP_DONE', ESTADO_FRETE.postado],
    ['LOGISTICS_DELIVERY_DONE', ESTADO_FRETE.entregue],
    ['LOGISTICS_DELIVERY_FAILED', ESTADO_FRETE.falhaNaEntrega],
    ['LOGISTICS_LOST', ESTADO_FRETE.objetoExtraviado],
    ['LOGISTICS_INVALID', ESTADO_FRETE.cancelado],
    ['LOGISTICS_REQUEST_CANCELED', ESTADO_FRETE.cancelado],
    ['LOGISTICS_REQUEST_CANCELLED', ESTADO_FRETE.cancelado],
    ['LOGISTICS_PICKUP_FAILED', ESTADO_FRETE.suspenso],
    ['LOGISTICS_COD_REJECTED', ESTADO_FRETE.despachoNegado],
  ])('1 — %s → %s', (token, esperado) => {
    expect(estadoFreteDeTokenShopee(token)).toEqual({ estado: esperado });
  });

  it('1 — a tabela tem exatamente as QUATORZE chaves acima e nenhuma outra', () => {
    // Anti-vacuity: without this, ADDING a row would break no test at all and a
    // reader could believe the `it.each` above enumerates the table.
    expect(Object.keys(ESTADO_FRETE_DE_TOKEN_SHOPEE).sort()).toEqual(
      [
        'LOGISTICS_COD_REJECTED',
        'LOGISTICS_DELIVERY_DONE',
        'LOGISTICS_DELIVERY_FAILED',
        'LOGISTICS_INVALID',
        'LOGISTICS_LOST',
        'LOGISTICS_NOT_START',
        'LOGISTICS_NOT_STARTED',
        'LOGISTICS_PICKUP_DONE',
        'LOGISTICS_PICKUP_FAILED',
        'LOGISTICS_PICKUP_RETRY',
        'LOGISTICS_READY',
        'LOGISTICS_REQUEST_CANCELED',
        'LOGISTICS_REQUEST_CANCELLED',
        'LOGISTICS_REQUEST_CREATED',
      ].sort(),
    );
  });
});

describe('2 — os dois pares de alias, e o que NÃO é alias', () => {
  it('2 — NOT_START ≡ NOT_STARTED (dobram IGUAL)', () => {
    expect(estadoFreteDeTokenShopee('LOGISTICS_NOT_START')).toEqual(
      estadoFreteDeTokenShopee('LOGISTICS_NOT_STARTED'),
    );
    expect(estadoFreteDeTokenShopee('LOGISTICS_NOT_START')).toEqual({
      estado: ESTADO_FRETE.iniciado,
    });
  });

  it('2 — REQUEST_CANCELED ≡ REQUEST_CANCELLED (o L duplo de faq 207)', () => {
    expect(estadoFreteDeTokenShopee('LOGISTICS_REQUEST_CANCELED')).toEqual(
      estadoFreteDeTokenShopee('LOGISTICS_REQUEST_CANCELLED'),
    );
    expect(estadoFreteDeTokenShopee('LOGISTICS_REQUEST_CANCELED')).toEqual({
      estado: ESTADO_FRETE.cancelado,
    });
  });

  it('2 — QUASE-ERRO: um sufixo NÃO é absorvido — não existe regra de prefixo', () => {
    // The #1372 shape: the fold applies, and what goes wrong is its SCOPE. A
    // `startsWith` rule would swallow a future LOGISTICS_REQUEST_CANCELLED_BY_SYSTEM
    // into `cancelado` and move physical stock on a value nobody modelled.
    expect(estadoFreteDeTokenShopee('LOGISTICS_REQUEST_CANCELLED_X')).toEqual({
      estado: null,
      motivo: MOTIVO_TOKEN_SHOPEE.desconhecido,
    });
    expect(estadoFreteDeTokenShopee('LOGISTICS_NOT_STARTEDX')).toEqual({
      estado: null,
      motivo: MOTIVO_TOKEN_SHOPEE.desconhecido,
    });
    // …and the mirror image: a TRUNCATING fold would read the alias as its
    // shorter twin. `LOGISTICS_NOT_START` is a strict prefix of
    // `LOGISTICS_NOT_STARTED`, and both are keys, so only an EXACT lookup can
    // answer both correctly while refusing the sufixo above.
    expect(estadoFreteDeTokenShopee('LOGISTICS_NOT_STAR')).toEqual({
      estado: null,
      motivo: MOTIVO_TOKEN_SHOPEE.desconhecido,
    });
  });
});

describe('3 — PENDING_ARRANGE é RETORNO, e retorno ≠ desconhecido', () => {
  it('3 — LOGISTICS_PENDING_ARRANGE → null com motivo "retorno"', () => {
    expect(estadoFreteDeTokenShopee('LOGISTICS_PENDING_ARRANGE')).toEqual({
      estado: null,
      motivo: MOTIVO_TOKEN_SHOPEE.retorno,
    });
    expect(TOKENS_DE_RETORNO_SHOPEE.has('LOGISTICS_PENDING_ARRANGE')).toBe(true);
  });

  it('3 — DISTINTO de um token desconhecido: os dois são null, os motivos NÃO', () => {
    const retorno = estadoFreteDeTokenShopee('LOGISTICS_PENDING_ARRANGE');
    const desconhecido = estadoFreteDeTokenShopee('LOGISTICS_TELEPORTED');
    expect(retorno.estado).toBeNull();
    expect(desconhecido.estado).toBeNull();
    expect(retorno).not.toEqual(desconhecido);
  });

  it('3 — nunca vira aguardandoAgendamento (retornos são do passo 17)', () => {
    expect(estadoFreteDeTokenShopee('LOGISTICS_PENDING_ARRANGE')).not.toEqual({
      estado: ESTADO_FRETE.aguardandoAgendamento,
    });
    expect(Object.values(ESTADO_FRETE_DE_TOKEN_SHOPEE)).not.toContain(
      ESTADO_FRETE.aguardandoAgendamento,
    );
  });
});

describe('4 — BACKEND_LOGISTICS_NOT_STARTED é um cancel_reason, não um status', () => {
  it('4 — → null desconhecido, NUNCA iniciado', () => {
    const leitura = estadoFreteDeTokenShopee('BACKEND_LOGISTICS_NOT_STARTED');
    expect(leitura).toEqual({ estado: null, motivo: MOTIVO_TOKEN_SHOPEE.desconhecido });
    expect(leitura.estado).not.toBe(ESTADO_FRETE.iniciado);
  });

  it('4 — ÂNCORA: o token de verdade continua mapeando para iniciado', () => {
    // Without this the negative above would also pass if the whole table were
    // deleted.
    expect(estadoFreteDeTokenShopee('LOGISTICS_NOT_STARTED')).toEqual({
      estado: ESTADO_FRETE.iniciado,
    });
  });
});

describe('5 — lixo entra, null sai, nada lança', () => {
  it.each([
    ['', 'a string vazia'],
    ['-', 'a sentinela de ausência da Shopee'],
    ['logistics_pickup_done', 'minúsculas — não há case fold'],
    ['  LOGISTICS_PICKUP_DONE  ', 'espaços — não há trim'],
    ['constructor', 'uma chave do PROTÓTIPO'],
    ['toString', 'idem'],
    ['__proto__', 'idem'],
  ])('5 — %s (%s) → null desconhecido', (token) => {
    expect(() => estadoFreteDeTokenShopee(token)).not.toThrow();
    expect(estadoFreteDeTokenShopee(token)).toEqual({
      estado: null,
      motivo: MOTIVO_TOKEN_SHOPEE.desconhecido,
    });
  });

  it('5 — ÂNCORA: o token exato responde, então a leitura não é null-por-construção', () => {
    expect(estadoFreteDeTokenShopee('LOGISTICS_PICKUP_DONE')).toEqual({
      estado: ESTADO_FRETE.postado,
    });
  });
});

describe('6 — a COLUNA DE ESTOQUE, medida no conjunto compartilhado', () => {
  it('6 — ÂNCORA da sonda: ela discrimina e responde false sem frete', () => {
    // If the probe were constant, every row below would pass for free.
    expect(removeEstoqueCompartilhado(ESTADO_FRETE.postado)).toBe(true);
    expect(removeEstoqueCompartilhado(ESTADO_FRETE.iniciado)).toBe(false);
    expect(removeEstoqueCompartilhado(null)).toBe(false);
  });

  it.each([
    ['LOGISTICS_REQUEST_CREATED', true],
    ['LOGISTICS_PICKUP_RETRY', true],
    ['LOGISTICS_PICKUP_DONE', true],
    ['LOGISTICS_DELIVERY_DONE', true],
    ['LOGISTICS_DELIVERY_FAILED', true],
    ['LOGISTICS_LOST', true],
    ['LOGISTICS_PICKUP_FAILED', true],
    ['LOGISTICS_NOT_START', false],
    ['LOGISTICS_NOT_STARTED', false],
    ['LOGISTICS_READY', false],
    ['LOGISTICS_INVALID', false],
    ['LOGISTICS_REQUEST_CANCELED', false],
    ['LOGISTICS_REQUEST_CANCELLED', false],
    ['LOGISTICS_COD_REJECTED', false],
  ])('6 — %s move estoque físico? %s', (token, esperado) => {
    const leitura = estadoFreteDeTokenShopee(token);
    expect(leitura.estado).not.toBeNull();
    expect(removeEstoqueCompartilhado(leitura.estado)).toBe(esperado);
  });

  it('6 — o conjunto COMPARTILHADO é o que a imagem da tabela encontra', () => {
    // The gate-5 set is no longer a channel-local copy: `ESTADOS_FRETE_REMOVE_ESTOQUE`
    // is imported from `@delfrance/schemas`. Two independent readings of it are
    // asserted to agree — the MEASURED one (through `efeitoEstoquePedido`, which
    // is what actually moves stock) and the imported set itself — and then the
    // intersection with this channel's token image is pinned to the six estados
    // this channel can produce. A row moving in the table, or a member moving in
    // the shared set, fails here.
    const imagem = [...new Set(Object.values(ESTADO_FRETE_DE_TOKEN_SHOPEE))];
    for (const estado of imagem) {
      expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(estado)).toBe(removeEstoqueCompartilhado(estado));
    }
    const medido = imagem.filter((estado) => removeEstoqueCompartilhado(estado)).sort();
    expect(medido).toEqual(
      [
        ESTADO_FRETE.aguardandoPostagem,
        ESTADO_FRETE.postado,
        ESTADO_FRETE.entregue,
        ESTADO_FRETE.falhaNaEntrega,
        ESTADO_FRETE.objetoExtraviado,
        ESTADO_FRETE.suspenso,
      ].sort(),
    );
    // ⚠️ QUASE-ERRO: the shared set is genuinely WIDER than the intersection —
    // it also holds estados this channel's table never produces. Asserting
    // equality instead of intersection would pass only by accident.
    expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(ESTADO_FRETE.checkFinalizado)).toBe(true);
    expect(imagem).not.toContain(ESTADO_FRETE.checkFinalizado);
  });
});

describe('7 — a imagem da tabela é um subconjunto do enum', () => {
  it('7 — todo valor da tabela é membro de estadoFreteSchema.options', () => {
    // `satisfies` is compile-time; this is its runtime twin.
    const opcoes = new Set<string>(estadoFreteSchema.options);
    for (const estado of Object.values(ESTADO_FRETE_DE_TOKEN_SHOPEE)) {
      expect(opcoes.has(estado)).toBe(true);
    }
    expect(new Set(Object.values(ESTADO_FRETE_DE_TOKEN_SHOPEE)).size).toBe(10);
  });
});

/* -------------------------------------------------------------------------- */
/*                    (2) the ladder, the sets, the verdict                    */
/* -------------------------------------------------------------------------- */

describe('8 — a ESCADA é a ordem do próprio enum', () => {
  it('8 — subsequência ESTRITA de estadoFreteSchema.options, na mesma ordem', () => {
    const opcoes: readonly string[] = estadoFreteSchema.options;
    const indices = ESCADA_FRETE_SHOPEE.map((estado) => opcoes.indexOf(estado));
    expect(indices).not.toContain(-1);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    // ESTRITA: the enum has values the ladder deliberately drops.
    expect(ESCADA_FRETE_SHOPEE.length).toBe(14);
    expect(ESCADA_FRETE_SHOPEE.length).toBeLessThan(opcoes.length);
    expect(new Set(ESCADA_FRETE_SHOPEE).size).toBe(ESCADA_FRETE_SHOPEE.length);
  });

  it('8 — os dois DESFECHOS que ficam de fora são nomeados', () => {
    // `aguardandoAgendamento` and `despachoNegado` sit INSIDE the enum run but
    // beside the chain. Enumerating (rather than slicing) is what keeps them out.
    expect(ESCADA_FRETE_SHOPEE).not.toContain(ESTADO_FRETE.aguardandoAgendamento);
    expect(ESCADA_FRETE_SHOPEE).not.toContain(ESTADO_FRETE.despachoNegado);
    expect(ESCADA_FRETE_SHOPEE[0]).toBe(ESTADO_FRETE.iniciado);
    expect(ESCADA_FRETE_SHOPEE[ESCADA_FRETE_SHOPEE.length - 1]).toBe(ESTADO_FRETE.entregue);
    expect(ESCADA_FRETE_SHOPEE.indexOf(ESTADO_FRETE.checkFinalizado)).toBe(8);
  });
});

describe('9 — os conjuntos são disjuntos onde precisam ser', () => {
  it('9 — ESCADA ∩ ORDEM_FALHA = ∅', () => {
    for (const estado of ORDEM_FALHA_SHOPEE) {
      expect(ESCADA_FRETE_SHOPEE).not.toContain(estado);
    }
    expect(ORDEM_FALHA_SHOPEE.length).toBe(5);
    expect(FALHA_FRETE_SHOPEE.size).toBe(5);
  });

  it('9 — RETORNO ∩ ESCADA = ∅ (o passo 17 não tem degrau aqui)', () => {
    for (const estado of ESTADOS_FRETE_RETORNO) {
      expect(ESCADA_FRETE_SHOPEE).not.toContain(estado);
    }
  });

  it('9 — suspenso NÃO é terminal; entregue É', () => {
    expect(ESTADOS_FRETE_SHOPEE_TERMINAL.has(ESTADO_FRETE.suspenso)).toBe(false);
    expect(ESTADOS_FRETE_SHOPEE_TERMINAL.has(ESTADO_FRETE.entregue)).toBe(true);
    expect(ESTADOS_FRETE_FORA_DO_CANAL.has(ESTADO_FRETE.fulfillment)).toBe(true);
    expect(ESTADOS_FRETE_FORA_DO_CANAL.has(ESTADO_FRETE.aguardandoRetirada)).toBe(true);
  });
});

describe('10 — estadoFreteShopeeAplicavel: a tabela de vereditos inteira', () => {
  const escrever = (estado: EstadoFrete, ressuscitado = false) => ({
    escrever: true,
    estado,
    ressuscitado,
  });
  const recusar = (motivo: string) => ({ escrever: false, motivo });

  it.each([
    [
      ESTADO_FRETE.iniciado,
      ESTADO_FRETE.despachoAutorizado,
      escrever(ESTADO_FRETE.despachoAutorizado),
    ],
    [ESTADO_FRETE.iniciado, ESTADO_FRETE.postado, escrever(ESTADO_FRETE.postado)],
    [
      ESTADO_FRETE.despachoAutorizado,
      ESTADO_FRETE.iniciado,
      recusar(MOTIVO_FRETE_SHOPEE.regressivo),
    ],
    [
      ESTADO_FRETE.aguardandoPostagem,
      ESTADO_FRETE.despachoAutorizado,
      recusar(MOTIVO_FRETE_SHOPEE.regressivo),
    ],
    [
      ESTADO_FRETE.checkFinalizado,
      ESTADO_FRETE.aguardandoPostagem,
      recusar(MOTIVO_FRETE_SHOPEE.regressivo),
    ],
    [ESTADO_FRETE.checkFinalizado, ESTADO_FRETE.postado, escrever(ESTADO_FRETE.postado)],
    [ESTADO_FRETE.checkFinalizado, ESTADO_FRETE.entregue, escrever(ESTADO_FRETE.entregue)],
    [ESTADO_FRETE.empacotado, ESTADO_FRETE.postado, escrever(ESTADO_FRETE.postado)],
    [
      ESTADO_FRETE.postado,
      ESTADO_FRETE.aguardandoPostagem,
      recusar(MOTIVO_FRETE_SHOPEE.regressivo),
    ],
    [ESTADO_FRETE.postado, ESTADO_FRETE.entregue, escrever(ESTADO_FRETE.entregue)],
    [ESTADO_FRETE.entregue, ESTADO_FRETE.postado, recusar(MOTIVO_FRETE_SHOPEE.regressivo)],
    [ESTADO_FRETE.entregue, ESTADO_FRETE.entregue, recusar(MOTIVO_FRETE_SHOPEE.semMudanca)],
    [
      ESTADO_FRETE.cancelado,
      ESTADO_FRETE.aguardandoPostagem,
      escrever(ESTADO_FRETE.aguardandoPostagem, true),
    ],
    [ESTADO_FRETE.cancelado, ESTADO_FRETE.entregue, escrever(ESTADO_FRETE.entregue)],
    [ESTADO_FRETE.falhaNaEntrega, ESTADO_FRETE.entregue, escrever(ESTADO_FRETE.entregue)],
    [ESTADO_FRETE.objetoExtraviado, ESTADO_FRETE.entregue, escrever(ESTADO_FRETE.entregue)],
    [
      ESTADO_FRETE.despachoNegado,
      ESTADO_FRETE.despachoAutorizado,
      escrever(ESTADO_FRETE.despachoAutorizado, true),
    ],
    [ESTADO_FRETE.suspenso, ESTADO_FRETE.postado, escrever(ESTADO_FRETE.postado)],
    [ESTADO_FRETE.devolvido, ESTADO_FRETE.entregue, recusar(MOTIVO_FRETE_SHOPEE.retornoPreservado)],
    [
      ESTADO_FRETE.aCaminhoDoRemetente,
      ESTADO_FRETE.postado,
      recusar(MOTIVO_FRETE_SHOPEE.retornoPreservado),
    ],
    [ESTADO_FRETE.error, ESTADO_FRETE.postado, escrever(ESTADO_FRETE.postado, true)],
    [
      ESTADO_FRETE.error,
      ESTADO_FRETE.despachoAutorizado,
      recusar(MOTIVO_FRETE_SHOPEE.erroPreservado),
    ],
    [ESTADO_FRETE.fulfillment, ESTADO_FRETE.postado, recusar(MOTIVO_FRETE_SHOPEE.foraDoCanal)],
    [
      ESTADO_FRETE.aguardandoRetirada,
      ESTADO_FRETE.postado,
      recusar(MOTIVO_FRETE_SHOPEE.foraDoCanal),
    ],
    [ESTADO_FRETE.desconhecido, ESTADO_FRETE.postado, escrever(ESTADO_FRETE.postado)],
    [ESTADO_FRETE.postado, null, recusar(MOTIVO_FRETE_SHOPEE.tokenDesconhecido)],
    [ESTADO_FRETE.error, null, recusar(MOTIVO_FRETE_SHOPEE.tokenDesconhecido)],
  ])('10 — %s → %s', (armazenado, alvo, esperado) => {
    expect(estadoFreteShopeeAplicavel(armazenado, alvo)).toEqual(esperado);
  });

  it('10 — ressuscitado só quando um TERMINAL é trocado por um NÃO-terminal', () => {
    // ⚠️ The design report's verdict table annotates `falhaNaEntrega → entregue`,
    // `objetoExtraviado → entregue` and `cancelado → entregue` "ressuscitado" in
    // prose while stating `TERMINAL.has(armazenado) && !TERMINAL.has(alvo)` as the
    // implementation twice, and its own worked example E5
    // (`postado → objetoExtraviado`, "not ressuscitado") only agrees with the
    // expression. The expression ships — it is `estadoShopeeAplicavel`'s verbatim —
    // and these are the values it produces. The write happens either way; only the
    // loud-log flag differs.
    const paraEntregue = estadoFreteShopeeAplicavel(
      ESTADO_FRETE.falhaNaEntrega,
      ESTADO_FRETE.entregue,
    );
    expect(paraEntregue).toEqual({
      escrever: true,
      estado: ESTADO_FRETE.entregue,
      ressuscitado: false,
    });
    // The DISTINCT case, same stored estado: a non-terminal target does raise it.
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.falhaNaEntrega, ESTADO_FRETE.postado)).toEqual({
      escrever: true,
      estado: ESTADO_FRETE.postado,
      ressuscitado: true,
    });
  });

  it('10 — DOBRA IGUAL: (checkFinalizado, postado) ≡ (aguardandoPostagem, postado)', () => {
    const a = estadoFreteShopeeAplicavel(ESTADO_FRETE.checkFinalizado, ESTADO_FRETE.postado);
    const b = estadoFreteShopeeAplicavel(ESTADO_FRETE.aguardandoPostagem, ESTADO_FRETE.postado);
    expect(a).toEqual(b);
    expect(a).toEqual({ escrever: true, estado: ESTADO_FRETE.postado, ressuscitado: false });
  });

  it('10 — QUASE-ERRO: o par invertido NÃO dobra igual', () => {
    const desce = estadoFreteShopeeAplicavel(
      ESTADO_FRETE.checkFinalizado,
      ESTADO_FRETE.aguardandoPostagem,
    );
    const sobe = estadoFreteShopeeAplicavel(
      ESTADO_FRETE.aguardandoPostagem,
      ESTADO_FRETE.checkFinalizado,
    );
    expect(desce).toEqual({ escrever: false, motivo: MOTIVO_FRETE_SHOPEE.regressivo });
    expect(sobe).toEqual({
      escrever: true,
      estado: ESTADO_FRETE.checkFinalizado,
      ressuscitado: false,
    });
    expect(desce).not.toEqual(sobe);
  });

  it('10 — a ORDEM das cláusulas importa: devolvido é terminal E retorno', () => {
    // `devolvido` is in BOTH sets. The retorno gate runs first, so the motivo has
    // to be `retorno-preservado` — swapping the two gates would answer the wrong
    // reason while still refusing the write, which no other row can see.
    expect(ESTADOS_FRETE_SHOPEE_TERMINAL.has(ESTADO_FRETE.devolvido)).toBe(true);
    expect(ESTADOS_FRETE_RETORNO.has(ESTADO_FRETE.devolvido)).toBe(true);
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.devolvido, ESTADO_FRETE.postado)).toEqual({
      escrever: false,
      motivo: MOTIVO_FRETE_SHOPEE.retornoPreservado,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                    (3) the N-package fold — E1 … E7                         */
/* -------------------------------------------------------------------------- */

describe('E1–E7 — os sete exemplos trabalhados', () => {
  it('E1 — um pacote, despacho arranjado: iniciado → aguardandoPostagem', () => {
    const { pacotes } = mesclarPacotesShopee(
      [],
      [
        obs({
          numero: PKG_B,
          estadoMarketplace: 'LOGISTICS_REQUEST_CREATED',
          codRastreio: 'BR123456789XY',
          canalId: '90021',
          relogioUs: T1,
        }),
      ],
    );
    const dobra = dobrarPacotesShopee(pacotes, null);
    expect(dobra.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(dobra.codRastreio).toBe('BR123456789XY');
    expect(dobra.externalOptionId).toBe('90021');
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.iniciado, dobra.estado)).toEqual({
      escrever: true,
      estado: ESTADO_FRETE.aguardandoPostagem,
      ressuscitado: false,
    });
    // The estado that leaves the shelf — the whole point of this row.
    expect(removeEstoqueCompartilhado(dobra.estado)).toBe(true);
  });

  it('E2 — dois pacotes, um postado: o pedido fica no MENOS avançado', () => {
    const { pacotes } = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T1 }),
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_REQUEST_CREATED', relogioUs: T1 }),
      ],
    );
    const dobra = dobrarPacotesShopee(pacotes, null);
    expect(dobra.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.aguardandoPostagem, dobra.estado)).toEqual({
      escrever: false,
      motivo: MOTIVO_FRETE_SHOPEE.semMudanca,
    });
  });

  it('E3 — QUASE-ERRO de E2: um pacote CANCELADO é ignorado, um LENTO não é', () => {
    const { pacotes } = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_REQUEST_CANCELED', relogioUs: T1 }),
        obs({
          numero: PKG_B,
          estadoMarketplace: 'LOGISTICS_PICKUP_DONE',
          codRastreio: 'BR123456789XY',
          relogioUs: T1,
        }),
      ],
    );
    const dobra = dobrarPacotesShopee(pacotes, null);
    expect(dobra.estado).toBe(ESTADO_FRETE.postado);
    // Only the live package carries a number.
    expect(dobra.codRastreio).toBe('BR123456789XY');
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.aguardandoPostagem, dobra.estado)).toEqual({
      escrever: true,
      estado: ESTADO_FRETE.postado,
      ressuscitado: false,
    });
  });

  it('E4 — todos entregues: o mínimo É entregue, sem caso especial', () => {
    const { pacotes } = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_DELIVERY_DONE', relogioUs: T1 }),
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_DELIVERY_DONE', relogioUs: T1 }),
      ],
    );
    const dobra = dobrarPacotesShopee(pacotes, null);
    expect(dobra.estado).toBe(ESTADO_FRETE.entregue);
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.postado, dobra.estado)).toEqual({
      escrever: true,
      estado: ESTADO_FRETE.entregue,
      ressuscitado: false,
    });
  });

  it('E5 — todos falharam: a PRECEDÊNCIA declarada decide, nunca o relógio', () => {
    const observacoes = [
      obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_LOST', relogioUs: T1 }),
      obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_REQUEST_CANCELED', relogioUs: T2 }),
    ];
    const { pacotes } = mesclarPacotesShopee([], observacoes);
    const dobra = dobrarPacotesShopee(pacotes, null);
    expect(dobra.estado).toBe(ESTADO_FRETE.objetoExtraviado);

    // The same two rows with the clocks SWAPPED answer identically — a
    // "latest by clock" arm would flip to `cancelado` here.
    const trocado = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_LOST', relogioUs: T2 }),
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_REQUEST_CANCELED', relogioUs: T1 }),
      ],
    );
    expect(dobrarPacotesShopee(trocado.pacotes, null).estado).toBe(ESTADO_FRETE.objetoExtraviado);

    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.postado, dobra.estado)).toEqual({
      escrever: true,
      estado: ESTADO_FRETE.objetoExtraviado,
      ressuscitado: false,
    });
  });

  it('E6 — evento ATRASADO num pedido entregue: DUAS redes independentes', () => {
    const armazenados = [
      linhaDoToken(PKG_A, 'LOGISTICS_DELIVERY_DONE', { atualizadoEm: T2 }),
      linhaDoToken(PKG_B, 'LOGISTICS_DELIVERY_DONE', { atualizadoEm: T2 }),
    ];
    // Rede 1 — a porta de frescor descarta a linha, o diário não muda.
    const mesclado = mesclarPacotesShopee(armazenados, [
      obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T1 }),
    ]);
    expect(mesclado.obsoletos).toEqual([PKG_B]);
    expect(mesclado.pacotes[0]).toBe(armazenados[0]);
    expect(mesclado.pacotes[1]).toBe(armazenados[1]);
    const dobra = dobrarPacotesShopee(mesclado.pacotes, null);
    expect(dobra.estado).toBe(ESTADO_FRETE.entregue);
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.entregue, dobra.estado)).toEqual({
      escrever: false,
      motivo: MOTIVO_FRETE_SHOPEE.semMudanca,
    });

    // Rede 2 — mesmo SEM a porta, a escada recusaria: entregue → postado.
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.entregue, ESTADO_FRETE.postado)).toEqual({
      escrever: false,
      motivo: MOTIVO_FRETE_SHOPEE.regressivo,
    });
  });

  it('E7 — o salto NÃO-INTEGRADO converge sem nunca ver REQUEST_CREATED', () => {
    const primeira = mesclarPacotesShopee(
      [],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_NOT_STARTED', relogioUs: T1 })],
    );
    expect(dobrarPacotesShopee(primeira.pacotes, null).estado).toBe(ESTADO_FRETE.iniciado);

    const segunda = mesclarPacotesShopee(primeira.pacotes, [
      obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T2 }),
    ]);
    const dobra = dobrarPacotesShopee(segunda.pacotes, null);
    expect(dobra.estado).toBe(ESTADO_FRETE.postado);
    expect(segunda.pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
    expect(estadoFreteShopeeAplicavel(ESTADO_FRETE.iniciado, dobra.estado)).toEqual({
      escrever: true,
      estado: ESTADO_FRETE.postado,
      ressuscitado: false,
    });
  });
});

describe('11 — a ordem de chegada não é entrada, e o fold roda sobre o DIÁRIO', () => {
  it('11 — E2 com as observações INVERTIDAS dobra idêntico (bytes inclusive)', () => {
    const a = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T1 }),
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_REQUEST_CREATED', relogioUs: T1 }),
      ],
    );
    const b = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_REQUEST_CREATED', relogioUs: T1 }),
        obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T1 }),
      ],
    );
    expect(JSON.stringify(a.pacotes)).toBe(JSON.stringify(b.pacotes));
    expect(a.pacotes.map((p) => p.numero)).toEqual([PKG_A, PKG_B]);
    expect(dobrarPacotesShopee(a.pacotes, null)).toEqual(dobrarPacotesShopee(b.pacotes, null));
  });

  it('11 — o fold roda sobre o diário MESCLADO, não sobre as observações', () => {
    // Stored: the SLOWER package. Observed: only the faster one. A fold over the
    // observations alone would answer `postado` and take the stock of a parcel
    // still on the shelf.
    const armazenados = [linhaDoToken(PKG_B, 'LOGISTICS_REQUEST_CREATED', { atualizadoEm: T1 })];
    const { pacotes } = mesclarPacotesShopee(armazenados, [
      obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T2 }),
    ]);
    expect(pacotes).toHaveLength(2);
    expect(dobrarPacotesShopee(pacotes, null).estado).toBe(ESTADO_FRETE.aguardandoPostagem);
  });

  it('11 — a ordenação é por UNIDADE DE CÓDIGO, nunca localeCompare', () => {
    const { pacotes } = mesclarPacotesShopee(
      [],
      [obs({ numero: 'ofg1' }), obs({ numero: 'OFG2' })],
    );
    // Code units: 'O' (79) < 'o' (111). `localeCompare` folds case and would
    // answer ['ofg1', 'OFG2'] — the near-miss that makes the comparator visible.
    expect(pacotes.map((p) => p.numero)).toEqual(['OFG2', 'ofg1']);
    expect(['ofg1', 'OFG2'].sort((a, b) => a.localeCompare(b))).toEqual(['ofg1', 'OFG2']);
  });
});

describe('12 — o teto de 200 caracteres do codRastreio', () => {
  it('12 — 12 pacotes × 18 caracteres: ≤ 200, termina em " +N", e o schema aceita', () => {
    const pacotes = Array.from({ length: 12 }, (_, i) =>
      linha({
        numero: `PKG${String(i).padStart(3, '0')}`,
        codRastreio: `BR${String(i).padStart(14, '0')}XY`,
      }),
    );
    expect(pacotes[0]?.codRastreio).toHaveLength(18);
    const dobra = dobrarPacotesShopee(pacotes, null);
    const codRastreio = dobra.codRastreio ?? '';
    expect(codRastreio.length).toBeLessThanOrEqual(LIMITE_COD_RASTREIO_SHOPEE);
    expect(codRastreio).toMatch(/ \+\d+$/);
    expect(dobra.codRastreioTruncado).toBe(false);
    // ÂNCORA: the naive join really would have blown the cap.
    expect(pacotes.map((p) => p.codRastreio).join(', ').length).toBeGreaterThan(
      LIMITE_COD_RASTREIO_SHOPEE,
    );
    const parse = freteDoPedidoSchema.safeParse({
      ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
      codRastreio,
    });
    expect(parse.success).toBe(true);
  });

  it('12 — dois pacotes cabem inteiros: junta com ", " e não trunca', () => {
    const dobra = dobrarPacotesShopee(
      [
        linha({ numero: PKG_A, codRastreio: 'BR000000001XY' }),
        linha({ numero: PKG_B, codRastreio: 'BR000000002XY' }),
      ],
      null,
    );
    expect(dobra.codRastreio).toBe('BR000000001XY, BR000000002XY');
    expect(dobra.codRastreioTruncado).toBe(false);
  });

  it('12 — patológico: nem UMA entrada cabe ⇒ fatia + codRastreioTruncado', () => {
    const dobra = dobrarPacotesShopee(
      [
        linha({ numero: PKG_A, codRastreio: 'X'.repeat(200) }),
        linha({ numero: PKG_B, codRastreio: 'Y'.repeat(200) }),
      ],
      null,
    );
    expect(dobra.codRastreio).toBe('X'.repeat(200));
    expect(dobra.codRastreioTruncado).toBe(true);
    expect(dobra.codRastreio?.length).toBeLessThanOrEqual(LIMITE_COD_RASTREIO_SHOPEE);
  });

  it('12 — números repetidos contam UMA vez, na ordem do numero do pacote', () => {
    const dobra = dobrarPacotesShopee(
      [
        linha({ numero: PKG_B, codRastreio: 'BR000000002XY' }),
        linha({ numero: PKG_A, codRastreio: 'BR000000001XY' }),
        linha({ numero: 'OFG300000000000000', codRastreio: 'BR000000001XY' }),
      ],
      null,
    );
    expect(dobra.codRastreio).toBe('BR000000001XY, BR000000002XY');
  });
});

describe('13 — codRastreio: preenche-ou-mantém no fold, SUBSTITUI no bloco', () => {
  it('13 — fold vazio ⇒ null, que significa "nada a dizer", nunca "apagar"', () => {
    const dobra = dobrarPacotesShopee([linhaDoToken(PKG_B, 'LOGISTICS_READY')], null);
    expect(dobra.codRastreio).toBeNull();
  });

  it('13 — fold não-nulo SUBSTITUI (um codRastreio migrado pode ser um package number)', () => {
    const dobra = dobrarPacotesShopee([linha({ numero: PKG_B, codRastreio: 'BR999XY' })], null);
    expect(dobra.codRastreio).toBe('BR999XY');
    expect(dobra.codRastreio).not.toBe(PKG_B);
  });

  it('13 — uma observação SEM número não apaga o número que a linha já tinha', () => {
    const armazenados = [
      linhaDoToken(PKG_B, 'LOGISTICS_REQUEST_CREATED', {
        codRastreio: 'BR123456789XY',
        atualizadoEm: T1,
      }),
    ];
    const { pacotes } = mesclarPacotesShopee(armazenados, [
      obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T2 }),
    ]);
    expect(pacotes[0]?.codRastreio).toBe('BR123456789XY');
    // ÂNCORA (o outro lado do mesmo ?? ): um número novo entra.
    const comNumero = mesclarPacotesShopee(armazenados, [
      obs({ numero: PKG_B, codRastreio: 'BR777XY', relogioUs: T2 }),
    ]);
    expect(comNumero.pacotes[0]?.codRastreio).toBe('BR777XY');
  });

  it('13 — uma string vazia não é um número de rastreio', () => {
    const dobra = dobrarPacotesShopee(
      [linha({ numero: PKG_A, codRastreio: '' }), linha({ numero: PKG_B, codRastreio: 'BR1XY' })],
      null,
    );
    expect(dobra.codRastreio).toBe('BR1XY');
  });
});

describe('14 — prazoDespacho: o MÍNIMO do diário, com fallback de ORDEM', () => {
  it('14 — min sobre dois pacotes', () => {
    const dobra = dobrarPacotesShopee(
      [linha({ numero: PKG_A, prazoDespacho: T3 }), linha({ numero: PKG_B, prazoDespacho: T1 })],
      null,
    );
    expect(dobra.prazoDespachoUs).toBe(T1);
  });

  it('14 — um pacote SEM prazo não puxa o mínimo para lugar nenhum', () => {
    // The 2020 floor lives at the wire boundary: a zero-filled `ship_by_date`
    // arrives here as `null`, and a null contributes nothing to the min.
    const dobra = dobrarPacotesShopee(
      [linha({ numero: PKG_A, prazoDespacho: null }), linha({ numero: PKG_B, prazoDespacho: T2 })],
      null,
    );
    expect(dobra.prazoDespachoUs).toBe(T2);
  });

  it('14 — um prazo NOVO e MAIS TARDE SUBSTITUI o armazenado (nunca min(stored, incoming))', () => {
    // `push 44`'s two samples disagree on the DIRECTION of a `ship_by_date`
    // move; a monotone floor against the stored value would make a pushed-out
    // deadline unreachable for ever.
    const armazenados = [
      linhaDoToken(PKG_B, 'LOGISTICS_READY', {
        prazoDespacho: T1,
        atualizadoEm: T1,
      }),
    ];
    const { pacotes } = mesclarPacotesShopee(armazenados, [
      obs({ numero: PKG_B, prazoDespachoUs: T3, relogioUs: T2 }),
    ]);
    expect(pacotes[0]?.prazoDespacho).toBe(T3);
    expect(dobrarPacotesShopee(pacotes, null).prazoDespachoUs).toBe(T3);
  });

  it('14 — o fallback da ORDEM só vale quando NENHUM pacote traz prazo', () => {
    const semPrazo = dobrarPacotesShopee([linha({ numero: PKG_B, prazoDespacho: null })], T2);
    expect(semPrazo.prazoDespachoUs).toBe(T2);
    // ÂNCORA: com um prazo de pacote, o da ordem NÃO ganha — nem quando é menor.
    const comPrazo = dobrarPacotesShopee([linha({ numero: PKG_B, prazoDespacho: T3 })], T1);
    expect(comPrazo.prazoDespachoUs).toBe(T3);
  });

  it('14 — diário vazio e sem prazo de ordem ⇒ null', () => {
    expect(dobrarPacotesShopee([], null).prazoDespachoUs).toBeNull();
  });
});

describe('15 — externalOptionId: o canal quando ele é inequívoco', () => {
  it('15 — um pacote com canal ⇒ o canal', () => {
    const dobra = dobrarPacotesShopee([linha({ numero: PKG_B, canalId: '90021' })], null);
    expect(dobra.externalOptionId).toBe('90021');
    expect(dobra.canaisDivergentes).toBe(false);
  });

  it('15 — dois pacotes no MESMO canal ⇒ o canal (amplia a regra N = 1 do passo 5)', () => {
    const dobra = dobrarPacotesShopee(
      [linha({ numero: PKG_A, canalId: '90021' }), linha({ numero: PKG_B, canalId: '90021' })],
      null,
    );
    expect(dobra.externalOptionId).toBe('90021');
    expect(dobra.canaisDivergentes).toBe(false);
  });

  it('15 — canais DIFERENTES ⇒ null + canaisDivergentes', () => {
    const dobra = dobrarPacotesShopee(
      [linha({ numero: PKG_A, canalId: '90021' }), linha({ numero: PKG_B, canalId: '90025' })],
      null,
    );
    expect(dobra.externalOptionId).toBeNull();
    expect(dobra.canaisDivergentes).toBe(true);
  });

  it('15 — nenhum canal ⇒ null, e isso NÃO é divergência', () => {
    const dobra = dobrarPacotesShopee([linha({ numero: PKG_B, canalId: null })], null);
    expect(dobra.externalOptionId).toBeNull();
    expect(dobra.canaisDivergentes).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                  (4) freshness, fidelity and the clock                      */
/* -------------------------------------------------------------------------- */

describe('16 — este módulo NÃO converte unidade nenhuma', () => {
  it('16 — o fonte não NOMEIA nenhum dos três conversores (grep de texto cru)', () => {
    // A raw-text grep, so the source must not spell them even in a comment —
    // the same convention the transaction-inventory guard and the
    // equivalence-fold inventory carry over their own vocabularies.
    // The µs SITE list in `apps/shopee/CLAUDE.md` is what this pins: this file
    // is not on it, and the conversion happens once, in the caller.
    const fonte = readFileSync(
      fileURLToPath(new URL('./freteShopeeMapping.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte).not.toContain('millisToMicros');
    expect(fonte).not.toContain('coerceToMicros');
    expect(fonte).not.toContain('microsDeSegundosShopee');
    // ÂNCORA: the file really was read and really does hold the module.
    expect(fonte).toContain('export function dobrarPacotesShopee');
  });

  it('16 — um valor em SEGUNDOS atravessa VERBATIM: nada aqui classifica por magnitude', () => {
    const segundos = 1_660_000_000; // a seconds-magnitude value, fed where µs is expected
    const { pacotes } = mesclarPacotesShopee(
      [],
      [obs({ numero: PKG_B, prazoDespachoUs: segundos, relogioUs: segundos })],
    );
    expect(pacotes[0]?.prazoDespacho).toBe(segundos);
    expect(pacotes[0]?.atualizadoEm).toBe(segundos);
    // And the fold picks the SMALLER raw number, with no idea that one of them
    // is not microseconds: the unit contract lives in the field name and in the
    // caller, and this test says so out loud.
    const dobra = dobrarPacotesShopee(
      [linhaCrua(PKG_A, { prazoDespacho: segundos }), linhaCrua(PKG_B, { prazoDespacho: T1 })],
      null,
    );
    expect(dobra.prazoDespachoUs).toBe(segundos);
  });

  it('16 — QUASE-ERRO: o SCHEMA (não este módulo) classifica por magnitude ao parsear', () => {
    // `pacoteFreteSchema.prazoDespacho` / `.atualizadoEm` are `microsSinceEpoch`,
    // whose preprocess coerces BY MAGNITUDE — so the same seconds value read
    // through the schema is multiplied by 1000 and lands in January 1970. That is
    // the tolerant-read contract of the stored side, and it is exactly why the
    // seconds → µs crossing must happen at the WIRE boundary, in the caller,
    // before a value ever reaches the diary. This module cannot repair it and
    // must not try.
    const parseado = pacoteFreteSchema.parse({ numero: PKG_B, prazoDespacho: 1_660_000_000 });
    expect(parseado.prazoDespacho).toBe(1_660_000_000_000);
    expect(new Date(1_660_000_000_000 / 1000).getUTCFullYear()).toBe(1970);
    // …and a genuine µs value round-trips untouched.
    expect(pacoteFreteSchema.parse({ numero: PKG_B, prazoDespacho: T1 }).prazoDespacho).toBe(T1);
  });
});

describe('17/18 — atualizadoEm avança SÓ numa mudança de conteúdo de FIO', () => {
  it('17 — uma correção da TABELA muda o estado derivado e NÃO mexe no relógio', () => {
    // The stored row disagrees with the token table (exactly what a table
    // correction looks like on disk). The projection is re-derived; the PACKAGE
    // clock is a wire fact and must not move because we recomputed something.
    const armazenado = linha({
      numero: PKG_B,
      estado: ESTADO_FRETE.cancelado,
      estadoMarketplace: 'LOGISTICS_PICKUP_FAILED',
      atualizadoEm: T1,
      fonte: PACOTE_DETAIL,
    });
    const { pacotes } = mesclarPacotesShopee(
      [armazenado],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_FAILED', relogioUs: T3 })],
    );
    expect(pacotes[0]?.estado).toBe(ESTADO_FRETE.suspenso);
    expect(pacotes[0]?.atualizadoEm).toBe(T1);
  });

  it('17 — e a correção vale também para uma linha que a entrega NÃO nomeou', () => {
    const desatualizada = linha({
      numero: PKG_A,
      estado: ESTADO_FRETE.cancelado,
      estadoMarketplace: 'LOGISTICS_PICKUP_FAILED',
      atualizadoEm: T1,
      fonte: PACOTE_DETAIL,
    });
    const { pacotes } = mesclarPacotesShopee(
      [desatualizada],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_READY', relogioUs: T2 })],
    );
    const corrigida = pacotes.find((p) => p.numero === PKG_A);
    expect(corrigida?.estado).toBe(ESTADO_FRETE.suspenso);
    expect(corrigida?.atualizadoEm).toBe(T1);
    expect(corrigida?.estadoMarketplace).toBe('LOGISTICS_PICKUP_FAILED');
  });

  it('18 — uma mudança de estadoMarketplace MOVE o relógio para o da observação', () => {
    const armazenado = linhaDoToken(PKG_B, 'LOGISTICS_REQUEST_CREATED', { atualizadoEm: T1 });
    const { pacotes } = mesclarPacotesShopee(
      [armazenado],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T3 })],
    );
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
    expect(pacotes[0]?.estado).toBe(ESTADO_FRETE.postado);
    expect(pacotes[0]?.atualizadoEm).toBe(T3);
  });

  it('18 — as outras três chaves de fio também movem o relógio', () => {
    const base = linhaDoToken(PKG_B, 'LOGISTICS_READY', { atualizadoEm: T1 });
    for (const campo of [
      { codRastreio: 'BR555XY' },
      { canalId: '90026' },
      { prazoDespachoUs: T3 },
    ]) {
      const { pacotes } = mesclarPacotesShopee(
        [base],
        [obs({ numero: PKG_B, relogioUs: T2, ...campo })],
      );
      expect(pacotes[0]?.atualizadoEm).toBe(T2);
    }
  });

  it('18 — QUASE-ERRO: uma reentrega IDÊNTICA não move o relógio nem os bytes', () => {
    const armazenado = linhaDoToken(PKG_B, 'LOGISTICS_READY', {
      codRastreio: 'BR1XY',
      canalId: '90021',
      prazoDespacho: T1,
      atualizadoEm: T1,
    });
    const { pacotes } = mesclarPacotesShopee(
      [armazenado],
      [
        obs({
          numero: PKG_B,
          estadoMarketplace: 'LOGISTICS_READY',
          codRastreio: 'BR1XY',
          canalId: '90021',
          prazoDespachoUs: T1,
          relogioUs: T3,
        }),
      ],
    );
    expect(pacotes[0]?.atualizadoEm).toBe(T1);
    expect(JSON.stringify(pacotes[0])).toBe(JSON.stringify(armazenado));
  });

  it('18 — conteúdo mudou mas a fonte não tem relógio: o carimbo GUARDADO fica', () => {
    // Erasing it would disarm the freshness gate for ever, which is worse than
    // a stamp that lags one delivery.
    const armazenado = linhaDoToken(PKG_B, 'LOGISTICS_READY', { atualizadoEm: T2 });
    const { pacotes } = mesclarPacotesShopee(
      [armazenado],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: null })],
    );
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
    expect(pacotes[0]?.atualizadoEm).toBe(T2);
  });
});

describe('a porta de frescor, linha por linha', () => {
  const armazenado = (over: Partial<PacoteFrete> = {}) =>
    linha({
      numero: PKG_B,
      estadoMarketplace: 'LOGISTICS_READY',
      estado: ESTADO_FRETE.despachoAutorizado,
      atualizadoEm: T2,
      fonte: PACOTE_DETAIL,
      ...over,
    });

  it('porta — linha AUSENTE: primeira visão sempre aplica', () => {
    const { pacotes, obsoletos } = mesclarPacotesShopee(
      [],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T1 })],
    );
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
    expect(pacotes[0]?.fonte).toBe(PACOTE_DETAIL);
    expect(obsoletos).toEqual([]);
  });

  it('porta — relógio guardado MAIOR ⇒ a linha é DESCARTADA e vira "obsoleto"', () => {
    const original = armazenado();
    const { pacotes, obsoletos } = mesclarPacotesShopee(
      [original],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T1 })],
    );
    expect(obsoletos).toEqual([PKG_B]);
    expect(pacotes[0]).toBe(original);
  });

  it('porta — relógios IGUAIS ⇒ aplica (a resolução da Shopee é de 1 segundo)', () => {
    // The mutant `>` → `>=` dies here: an equal-clock delivery carrying a NEW
    // token has to land, or two packages arranged in the same `ship_order` would
    // freeze each other.
    const { pacotes, obsoletos } = mesclarPacotesShopee(
      [armazenado()],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T2 })],
    );
    expect(obsoletos).toEqual([]);
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
  });

  it('porta — relógio recebido MAIOR ⇒ aplica', () => {
    const { pacotes, obsoletos } = mesclarPacotesShopee(
      [armazenado()],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T3 })],
    );
    expect(obsoletos).toEqual([]);
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
  });

  it.each([
    ['o guardado é null', { atualizadoEm: null }, T1],
    ['o recebido é null', {}, null],
  ])('porta — um relógio null dos DOIS lados aplica (%s)', (_titulo, over, relogioUs) => {
    // The OPPOSITE of Mercado Livre's `ignorar × 3`: applied verbatim here it
    // would block the whole code-3 backstop, which carries no package clock.
    const { pacotes, obsoletos } = mesclarPacotesShopee(
      [armazenado(over)],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs })],
    );
    expect(obsoletos).toEqual([]);
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
  });

  it('porta — uma observação sem NÚMERO não nomeia linha nenhuma', () => {
    const original = armazenado();
    const { pacotes } = mesclarPacotesShopee(
      [original],
      [obs({ numero: '', estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T3 })],
    );
    expect(pacotes).toHaveLength(1);
    expect(pacotes[0]).toBe(original);
  });
});

describe('a FIDELIDADE da fonte', () => {
  it('fonte — as DUAS declarações do vocabulário são o mesmo conjunto', () => {
    // ⚠️ `FontePacoteShopee` (the union on `PacoteObservadoShopee.fonte`, wave I)
    // and `FONTE_PACOTE_SHOPEE` (the named members, this module) are two
    // declarations of ONE vocabulary. The module's `satisfies
    // Record<string, FontePacoteShopee>` already refuses a member the union does
    // not name; this closes the other direction — a member ADDED to the union
    // with no row here fails to compile on the next line, and the runtime
    // assertion pins that the two lists are equal as SETS rather than merely
    // assignable.
    const exaustivo: Record<FontePacoteShopee, number> = FIDELIDADE_FONTE_PACOTE_SHOPEE;
    const doVocabulario = [...Object.values(FONTE_PACOTE_SHOPEE)].sort();
    expect(Object.keys(exaustivo).sort()).toEqual(doVocabulario);
    expect(doVocabulario).toEqual(['get_order_detail', 'get_package_detail']);
    // ÂNCORA: a string outside the vocabulary is not a key of either table.
    expect(Object.hasOwn(FIDELIDADE_FONTE_PACOTE_SHOPEE, 'get_tracking_info')).toBe(false);
  });

  it('fidelidade — get_package_detail (2) > get_order_detail (1) > desconhecida (0)', () => {
    expect(fidelidadeDaFonteShopee(PACOTE_DETAIL)).toBe(2);
    expect(fidelidadeDaFonteShopee(ORDER_DETAIL)).toBe(1);
    expect(fidelidadeDaFonteShopee(null)).toBe(0);
    expect(fidelidadeDaFonteShopee('get_tracking_info')).toBe(0);
    expect(fidelidadeDaFonteShopee('toString')).toBe(0);
    expect(FIDELIDADE_FONTE_PACOTE_SHOPEE[PACOTE_DETAIL]).toBe(2);
  });

  it('fidelidade — order_detail guardado ⇒ package_detail aplica SEM olhar relógio', () => {
    const armazenado = linha({
      numero: PKG_B,
      estadoMarketplace: 'LOGISTICS_READY',
      estado: ESTADO_FRETE.despachoAutorizado,
      atualizadoEm: T3,
      fonte: ORDER_DETAIL,
    });
    const { pacotes, obsoletos } = mesclarPacotesShopee(
      [armazenado],
      [
        obs({
          numero: PKG_B,
          estadoMarketplace: 'LOGISTICS_PICKUP_DONE',
          relogioUs: T1, // OLDER than the stored order clock — and it still applies
          fonte: PACOTE_DETAIL,
        }),
      ],
    );
    expect(obsoletos).toEqual([]);
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
    expect(pacotes[0]?.fonte).toBe(PACOTE_DETAIL);
    expect(pacotes[0]?.atualizadoEm).toBe(T1);
  });

  it('fidelidade — package_detail guardado ⇒ order_detail aplica CAMPOS, não o carimbo', () => {
    // This is what stops the code-3 backstop re-stamping a pull's rows on every
    // order import: one write and one audit row per import, for ever.
    const armazenado = linha({
      numero: PKG_B,
      estadoMarketplace: 'LOGISTICS_READY',
      estado: ESTADO_FRETE.despachoAutorizado,
      codRastreio: null,
      atualizadoEm: T1,
      fonte: PACOTE_DETAIL,
    });
    const { pacotes } = mesclarPacotesShopee(
      [armazenado],
      [
        obs({
          numero: PKG_B,
          estadoMarketplace: 'LOGISTICS_PICKUP_DONE',
          canalId: '90021',
          relogioUs: T3,
          fonte: ORDER_DETAIL,
        }),
      ],
    );
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
    expect(pacotes[0]?.canalId).toBe('90021');
    expect(pacotes[0]?.atualizadoEm).toBe(T1);
    expect(pacotes[0]?.fonte).toBe(PACOTE_DETAIL);
  });

  it('fidelidade — duas entregas na MESMA chamada aplicam em ordem', () => {
    const { pacotes } = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_READY', relogioUs: T1 }),
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T2 }),
      ],
    );
    expect(pacotes).toHaveLength(1);
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
    expect(pacotes[0]?.atualizadoEm).toBe(T2);
  });
});

describe('o diário: nada é apagado, e os tokens ilegíveis são reportados', () => {
  it('linhas que a entrega NÃO nomeou ficam byte-idênticas (mesmo objeto)', () => {
    const intocada = linhaDoToken(PKG_A, 'LOGISTICS_DELIVERY_DONE', { atualizadoEm: T1 });
    const { pacotes } = mesclarPacotesShopee(
      [intocada],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_READY', relogioUs: T2 })],
    );
    expect(pacotes).toHaveLength(2);
    expect(pacotes.find((p) => p.numero === PKG_A)).toBe(intocada);
    expect(pacotes.map((p) => p.numero)).toEqual([PKG_A, PKG_B]);
  });

  it('nenhuma linha é REMOVIDA — um pedido pode ser dividido (is_split_up)', () => {
    const armazenados = [
      linhaDoToken(PKG_A, 'LOGISTICS_READY', { atualizadoEm: T1 }),
      linhaDoToken(PKG_B, 'LOGISTICS_READY', { atualizadoEm: T1 }),
    ];
    const { pacotes } = mesclarPacotesShopee(armazenados, []);
    expect(pacotes.map((p) => p.numero)).toEqual([PKG_A, PKG_B]);
  });

  it('as chaves de passthrough de uma linha guardada sobrevivem à mesclagem', () => {
    const armazenado = pacoteFreteSchema.parse({
      numero: PKG_B,
      estadoMarketplace: 'LOGISTICS_READY',
      atualizadoEm: T1,
      fonte: PACOTE_DETAIL,
      campoDeUmPassoFuturo: 'preservado',
    });
    const { pacotes } = mesclarPacotesShopee(
      [armazenado],
      [obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T2 })],
    );
    expect(pacotes[0]?.campoDeUmPassoFuturo).toBe('preservado');
    expect(pacotes[0]?.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
  });

  it('tokens desconhecidos e de retorno são reportados DISTINTOS e sem repetição', () => {
    const { pacotes, tokensDesconhecidos, tokensDeRetorno } = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_TELEPORTED', relogioUs: T1 }),
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_TELEPORTED', relogioUs: T1 }),
        obs({
          numero: 'OFG300000000000000',
          estadoMarketplace: 'LOGISTICS_PENDING_ARRANGE',
          relogioUs: T1,
        }),
      ],
    );
    expect(tokensDesconhecidos).toEqual(['LOGISTICS_TELEPORTED']);
    expect(tokensDeRetorno).toEqual(['LOGISTICS_PENDING_ARRANGE']);
    // Recorded VERBATIM, never written to an estado.
    expect(pacotes.map((p) => p.estado)).toEqual([null, null, null]);
    expect(pacotes.map((p) => p.estadoMarketplace)).toEqual([
      'LOGISTICS_TELEPORTED',
      'LOGISTICS_TELEPORTED',
      'LOGISTICS_PENDING_ARRANGE',
    ]);
    expect(dobrarPacotesShopee(pacotes, null).estado).toBeNull();
  });

  it('um token ilegível não impede os OUTROS pacotes de dobrarem', () => {
    const { pacotes } = mesclarPacotesShopee(
      [],
      [
        obs({ numero: PKG_A, estadoMarketplace: 'LOGISTICS_TELEPORTED', relogioUs: T1 }),
        obs({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_PICKUP_DONE', relogioUs: T1 }),
      ],
    );
    expect(dobrarPacotesShopee(pacotes, null).estado).toBe(ESTADO_FRETE.postado);
  });

  it('um diário vazio dobra para null em tudo', () => {
    expect(dobrarPacotesShopee([], null)).toEqual({
      estado: null,
      codRastreio: null,
      prazoDespachoUs: null,
      externalOptionId: null,
      canaisDivergentes: false,
      codRastreioTruncado: false,
    });
  });
});
