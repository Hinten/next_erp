import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { AGUARDAR_KIT_INCERTO_SHOPEE_MS } from '../../shopeeAcaoSugerida';
import {
  ESTADO_ANUNCIO_SHOPEE,
  itemIdEnderecavelShopee,
  produtoShopeeLinkSchema,
} from './shopeeLink';
import { anuncioShopeeVivo, ehRascunhoShopee } from './shopeeLinkLeitura';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  baseRascunhoShopeeSchema,
  CAMPO_RASCUNHO_SHOPEE,
  campoRascunhoShopeeSchema,
  camposDaBaseDoRascunhoShopee,
  camposDoRascunhoShopee,
  camposPresentesDoRascunhoShopee,
  CODIGO_RASCUNHO_SHOPEE,
  conflitoRascunhoShopeeSchema,
  conteudoRascunhoShopeeSchema,
  corpoAtualizarRascunhoShopeeSchema,
  corpoCriarRascunhoShopeeSchema,
  corpoDescartarRascunhoShopeeSchema,
  criadoNaJanelaShopee,
  estadoPublicacaoRascunhoShopee,
  FOLGA_JANELA_CRIACAO_SHOPEE_S,
  idRascunhoShopeeSchema,
  inicioDaJanelaDaCriacaoShopeeS,
  janelaDaCriacaoIncertaShopee,
  MARGEM_ENVIO_SHOPEE_MS,
  MAX_DESCRIPTION_RASCUNHO_SHOPEE,
  MAX_ITEM_NAME_RASCUNHO_SHOPEE,
  mesmoValorDoRascunhoShopee,
  MOTIVO_RASCUNHO_INVALIDO_SHOPEE,
  motivoRascunhoInvalidoShopeeSchema,
  MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE,
  MSG_BASE_SEM_ATRIBUTOS_NA_TROCA_DE_CATEGORIA_RASCUNHO_SHOPEE,
  MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE,
  MSG_PATCH_VAZIO_RASCUNHO_SHOPEE,
  PADRAO_ID_RASCUNHO_SHOPEE,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  rascunhoSemMarcaShopee,
  respostaAtualizarRascunhoShopeeSchema,
  respostaCriarRascunhoShopeeSchema,
  respostaDescartarRascunhoShopeeSchema,
  respostaItemIncertoShopeeSchema,
  TETO_ROTA_SHOPEE_MS,
  vinculoConflitanteShopeeSchema,
  vinculosQueExigemConfirmacaoShopee,
  type CampoRascunhoShopee,
  type CamposRascunhoShopee,
  type EstadoPublicacaoRascunhoShopee,
  type PosicaoNaJanelaShopee,
  type RespostaItemIncertoShopee,
} from './shopeeRascunho';

/* ---------------------------------- fixtures ------------------------------ */

const DESDE = 1_761_000_000_000;
const EXPIRA = DESDE + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS;
const GRACA = 240_000;
const TRAVA = { desde: DESDE, expiraEm: EXPIRA, token: 'tok-1' };
const INCERTA_DESDE = DESDE - 600_000;

/** A draft carrying the lock (and, when given, an earlier uncertain attempt). */
function rascunhoTravado(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { item_id: null, publicacaoEmCurso: TRAVA, ...extra };
}

const CONTA = 'int-1';
const REF = `documents/integracao/${CONTA}`;
const REF_NUA = `integracao/${CONTA}`;
const OUTRA_REF = 'documents/integracao/int-12';

/* -------------------------------------------------------------------------- */
/*                              (1) the constants                              */
/* -------------------------------------------------------------------------- */

describe('as constantes da trava (#1911, K1-2)', () => {
  it('os valores congelados no §2.1', () => {
    expect(PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS).toBe(300_000);
    expect(TETO_ROTA_SHOPEE_MS).toBe(180_000);
    expect(MARGEM_ENVIO_SHOPEE_MS).toBe(30_000);
    expect(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS).toBe(240_000);
    expect(FOLGA_JANELA_CRIACAO_SHOPEE_S).toBe(300);
  });

  it('⚠️ a folga da janela é em SEGUNDOS (o `create_time` da Shopee), nunca em ms', () => {
    // 300 s antes do segundo da tentativa — não 300 ms (que cairia no mesmo
    // segundo) nem 300 000 s (três dias e meio).
    expect(inicioDaJanelaDaCriacaoShopeeS(1_761_000_000_000)).toBe(1_761_000_000 - 300);
  });

  it('a espera do anúncio incerto É a do kit — um apelido, nunca um segundo número (#1369)', () => {
    expect(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS).toBe(AGUARDAR_KIT_INCERTO_SHOPEE_MS);
    // O valor pode estar certo por coincidência; o TEXTO prova que é o apelido.
    const fonte = readFileSync(join(import.meta.dirname, 'shopeeRascunho.ts'), 'utf8');
    expect(fonte).toMatch(
      /export const AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS = AGUARDAR_KIT_INCERTO_SHOPEE_MS;/,
    );
  });

  it('as relações que tornam a janela segura', () => {
    // A trava vive mais que o teto da rota: quando a trava de uma requisição
    // expira, a requisição que a tomou já passou do teto.
    expect(PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS).toBeGreaterThan(TETO_ROTA_SHOPEE_MS);
    // A margem cabe dentro do teto e da trava — senão nenhum envio passaria.
    expect(MARGEM_ENVIO_SHOPEE_MS).toBeLessThan(TETO_ROTA_SHOPEE_MS);
    expect(MARGEM_ENVIO_SHOPEE_MS).toBeLessThan(PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS);
    // A carência sobrevive a uma requisição inteira que tenha começado no limite.
    expect(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS).toBeGreaterThan(TETO_ROTA_SHOPEE_MS);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 (2) the codes                               */
/* -------------------------------------------------------------------------- */

describe('CODIGO_RASCUNHO_SHOPEE — os códigos do P3 e do P4', () => {
  it('os onze códigos, com os valores congelados no §2.1 (seis do P3, cinco do P4)', () => {
    expect(CODIGO_RASCUNHO_SHOPEE).toEqual({
      publicacaoEmAndamento: 'SHOPEE_PUBLICACAO_EM_ANDAMENTO',
      jaPublicado: 'SHOPEE_RASCUNHO_JA_PUBLICADO',
      publicacaoExpirada: 'SHOPEE_PUBLICACAO_EXPIRADA',
      contencao: 'SHOPEE_RASCUNHO_CONTENCAO',
      criacaoIncerta: 'SHOPEE_RASCUNHO_CRIACAO_INCERTA',
      contaJaTemAnuncio: 'SHOPEE_RASCUNHO_CONTA_JA_TEM_ANUNCIO',
      conflito: 'SHOPEE_RASCUNHO_CONFLITO',
      idEmUso: 'SHOPEE_RASCUNHO_ID_EM_USO',
      categoriaTravada: 'SHOPEE_RASCUNHO_CATEGORIA_TRAVADA',
      produtoInvalido: 'SHOPEE_RASCUNHO_PRODUTO_INVALIDO',
      inexistente: 'SHOPEE_RASCUNHO_INEXISTENTE',
    });
  });

  it('nenhum valor se repete — um código ambíguo faria o leitor escolher o ramo errado', () => {
    const valores = Object.values(CODIGO_RASCUNHO_SHOPEE);
    expect(new Set(valores).size).toBe(valores.length);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (3) estadoPublicacaoRascunhoShopee                       */
/* -------------------------------------------------------------------------- */

describe('estadoPublicacaoRascunhoShopee — sem trava', () => {
  it('PAR: documento nulo, trava AUSENTE e trava `null` são o MESMO `livre`', () => {
    expect(estadoPublicacaoRascunhoShopee(null, DESDE)).toEqual({ tipo: 'livre' });
    expect(estadoPublicacaoRascunhoShopee({ item_id: null }, DESDE)).toEqual({ tipo: 'livre' });
    expect(
      estadoPublicacaoRascunhoShopee({ item_id: null, publicacaoEmCurso: null }, DESDE),
    ).toEqual({ tipo: 'livre' });
    expect(
      estadoPublicacaoRascunhoShopee(
        { item_id: null, publicacaoEmCurso: null, criacaoIncertaDesde: null },
        DESDE,
      ),
    ).toEqual({ tipo: 'livre' });
  });

  it('⛔ NEAR-MISS: sem trava mas COM `criacaoIncertaDesde` ⇒ `incerta`, nunca `livre`', () => {
    expect(
      estadoPublicacaoRascunhoShopee({ item_id: null, criacaoIncertaDesde: INCERTA_DESDE }, DESDE),
    ).toEqual({ tipo: 'incerta', desdeMs: INCERTA_DESDE });
  });

  it('⛔ NEAR-MISS: um `criacaoIncertaDesde` ilegível AINDA conta como registrado (desdeMs null)', () => {
    for (const bruto of ['1761000000000', '', 1.5, true, {}]) {
      expect(
        estadoPublicacaoRascunhoShopee({ item_id: null, criacaoIncertaDesde: bruto }, DESDE),
        JSON.stringify(bruto),
      ).toEqual({ tipo: 'incerta', desdeMs: null });
    }
  });
});

describe('estadoPublicacaoRascunhoShopee — as fronteiras congeladas (§2.1, K1-2(b))', () => {
  const casos: readonly {
    readonly nome: string;
    readonly agora: number;
    readonly comIncerteza: boolean;
    readonly esperado: EstadoPublicacaoRascunhoShopee;
  }[] = [
    {
      nome: 'DESDE (o instante em que foi tomada) ⇒ em-andamento, a trava inteira por esperar',
      agora: DESDE,
      comIncerteza: false,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
        aposIncerteza: false,
        posExpiracao: false,
      },
    },
    {
      nome: 'expiraEm − 1 ⇒ em-andamento, posExpiracao: false, 1 ms por esperar',
      agora: EXPIRA - 1,
      comIncerteza: false,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: 1,
        aposIncerteza: false,
        posExpiracao: false,
      },
    },
    {
      nome: 'expiraEm ⇒ AINDA em-andamento (a carência), posExpiracao: true, 240 000 por esperar',
      agora: EXPIRA,
      comIncerteza: false,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: GRACA,
        aposIncerteza: false,
        posExpiracao: true,
      },
    },
    {
      nome: 'expiraEm + 240 000 − 1 ⇒ em-andamento, posExpiracao: true, 1 ms por esperar',
      agora: EXPIRA + GRACA - 1,
      comIncerteza: false,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: 1,
        aposIncerteza: false,
        posExpiracao: true,
      },
    },
    {
      nome: 'expiraEm + 240 000 ⇒ incerta (a carência acabou), desde = o da trava',
      agora: EXPIRA + GRACA,
      comIncerteza: false,
      esperado: { tipo: 'incerta', desdeMs: DESDE },
    },
    {
      nome: 'expiraEm − 1 COM criacaoIncertaDesde ⇒ em-andamento, aposIncerteza: true',
      agora: EXPIRA - 1,
      comIncerteza: true,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: 1,
        aposIncerteza: true,
        posExpiracao: false,
      },
    },
    {
      nome: 'expiraEm COM criacaoIncertaDesde ⇒ incerta JÁ (a espera já foi cumprida), desde = o da incerteza',
      agora: EXPIRA,
      comIncerteza: true,
      esperado: { tipo: 'incerta', desdeMs: INCERTA_DESDE },
    },
  ];

  for (const caso of casos) {
    it(caso.nome, () => {
      const link = rascunhoTravado(caso.comIncerteza ? { criacaoIncertaDesde: INCERTA_DESDE } : {});
      expect(estadoPublicacaoRascunhoShopee(link, caso.agora)).toEqual(caso.esperado);
    });
  }

  it('a leitura é MONÓTONA no tempo: em-andamento → carência → incerta, nunca de volta, nunca `livre`', () => {
    const ordem = (e: EstadoPublicacaoRascunhoShopee): number =>
      e.tipo === 'livre' ? -1 : e.tipo === 'incerta' ? 2 : e.posExpiracao ? 1 : 0;
    let anterior = 0;
    for (let t = DESDE - 1_000; t <= EXPIRA + GRACA + 60_000; t += 7_919) {
      const atual = ordem(estadoPublicacaoRascunhoShopee(rascunhoTravado(), t));
      expect(atual, String(t)).toBeGreaterThanOrEqual(anterior);
      anterior = atual;
    }
    expect(anterior).toBe(2);
  });

  it('`aguardarMs` é sempre > 0 enquanto em-andamento, e chega exatamente no fim da carência', () => {
    for (let t = DESDE; t < EXPIRA + GRACA; t += 13_337) {
      const e = estadoPublicacaoRascunhoShopee(rascunhoTravado(), t);
      if (e.tipo !== 'em-andamento') throw new Error(`esperava em-andamento em ${String(t)}`);
      expect(e.aguardarMs).toBeGreaterThan(0);
      expect(t + e.aguardarMs).toBe(e.posExpiracao ? EXPIRA + GRACA : EXPIRA);
    }
  });

  it('a incerteza registrada vence o `desde` da trava (a tentativa MAIS ANTIGA)', () => {
    expect(
      estadoPublicacaoRascunhoShopee(
        rascunhoTravado({ criacaoIncertaDesde: INCERTA_DESDE }),
        EXPIRA + GRACA,
      ),
    ).toEqual({ tipo: 'incerta', desdeMs: INCERTA_DESDE });
  });

  it('⛔ NEAR-MISS: um `criacaoIncertaDesde` ilegível ainda TIRA a carência; desdeMs cai no da trava', () => {
    expect(
      estadoPublicacaoRascunhoShopee(rascunhoTravado({ criacaoIncertaDesde: 'x' }), EXPIRA),
    ).toEqual({ tipo: 'incerta', desdeMs: DESDE });
  });
});

describe('estadoPublicacaoRascunhoShopee — trava ilegível', () => {
  it('⛔ uma trava malformada é `incerta`, nunca `livre` (nem ausente, nem em andamento)', () => {
    const malformadas: readonly unknown[] = [
      'tok-1',
      0,
      true,
      [],
      {},
      { ...TRAVA, token: '' },
      { desde: DESDE, expiraEm: EXPIRA },
      { ...TRAVA, desde: 1.5 },
      { ...TRAVA, expiraEm: String(EXPIRA) },
      { ...TRAVA, expiraEm: Number.NaN },
      { ...TRAVA, expiraEm: Number.POSITIVE_INFINITY },
    ];
    for (const trava of malformadas) {
      expect(
        estadoPublicacaoRascunhoShopee({ item_id: null, publicacaoEmCurso: trava }, DESDE),
        JSON.stringify(trava),
      ).toEqual({ tipo: 'incerta', desdeMs: null });
    }
  });

  it('com incerteza registrada, a trava ilegível ainda é incerta — desde = o da incerteza', () => {
    expect(
      estadoPublicacaoRascunhoShopee(
        { item_id: null, publicacaoEmCurso: { token: 'x' }, criacaoIncertaDesde: INCERTA_DESDE },
        DESDE,
      ),
    ).toEqual({ tipo: 'incerta', desdeMs: INCERTA_DESDE });
  });

  it('PAR: uma chave a MAIS na trava (passthrough) não a torna ilegível', () => {
    expect(
      estadoPublicacaoRascunhoShopee(
        { item_id: null, publicacaoEmCurso: { ...TRAVA, etapa: 'addItem' } },
        DESDE,
      ).tipo,
    ).toBe('em-andamento');
  });

  it('lê a trava qualquer que seja o documento — ser rascunho é pergunta de quem chama', () => {
    expect(
      estadoPublicacaoRascunhoShopee({ item_id: 2500139861, publicacaoEmCurso: TRAVA }, DESDE).tipo,
    ).toBe('em-andamento');
  });

  it('⛔ um relógio inválido nunca libera uma trava', () => {
    expect(estadoPublicacaoRascunhoShopee(rascunhoTravado(), Number.NaN).tipo).toBe('incerta');
  });
});

/* -------------------------------------------------------------------------- */
/*        (3b) the uncertain create's ATTEMPT WINDOW (P5, K1-7/K1-8)           */
/* -------------------------------------------------------------------------- */

describe('janelaDaCriacaoIncertaShopee — a evidência de uma tentativa (K1-8)', () => {
  it('PAR: rascunho legado (sem as chaves), as duas chaves `null` e o documento nulo ⇒ SEM janela', () => {
    expect(janelaDaCriacaoIncertaShopee(null)).toBeNull();
    expect(janelaDaCriacaoIncertaShopee({ item_id: null })).toBeNull();
    expect(janelaDaCriacaoIncertaShopee({ item_id: null, item_name: 'Camiseta' })).toBeNull();
    expect(
      janelaDaCriacaoIncertaShopee({
        item_id: null,
        publicacaoEmCurso: null,
        criacaoIncertaDesde: null,
      }),
    ).toBeNull();
  });

  it('só a trava ⇒ o `desde` da trava — viva, na carência OU vencida sem registro (o caminho do crash)', () => {
    expect(janelaDaCriacaoIncertaShopee(rascunhoTravado())).toEqual({ desdeMs: DESDE });
  });

  it('só o registro ⇒ o registro', () => {
    expect(
      janelaDaCriacaoIncertaShopee({ item_id: null, criacaoIncertaDesde: INCERTA_DESDE }),
    ).toEqual({ desdeMs: INCERTA_DESDE });
  });

  it('⛔ NEAR-MISS: com os dois, o REGISTRO vence a trava (a tentativa mais antiga; a trava de um reenvio é mais nova)', () => {
    expect(
      janelaDaCriacaoIncertaShopee(rascunhoTravado({ criacaoIncertaDesde: INCERTA_DESDE })),
    ).toEqual({ desdeMs: INCERTA_DESDE });
    // O `??` do §2.1, literal: o registro vence até um `desde` de trava mais antigo.
    expect(
      janelaDaCriacaoIncertaShopee(rascunhoTravado({ criacaoIncertaDesde: DESDE + 1 })),
    ).toEqual({ desdeMs: DESDE + 1 });
  });

  it('⛔ NEAR-MISS: `criacaoIncertaDesde: 0` é um instante, nunca "ausente"', () => {
    expect(janelaDaCriacaoIncertaShopee(rascunhoTravado({ criacaoIncertaDesde: 0 }))).toEqual({
      desdeMs: 0,
    });
  });

  it('um registro ILEGÍVEL cai no `desde` da trava legível; sem trava legível, sem janela', () => {
    for (const bruto of ['1761000000000', '', 1.5, true, {}, Number.NaN, 2 ** 53]) {
      expect(
        janelaDaCriacaoIncertaShopee(rascunhoTravado({ criacaoIncertaDesde: bruto })),
        String(bruto),
      ).toEqual({ desdeMs: DESDE });
      expect(
        janelaDaCriacaoIncertaShopee({ item_id: null, criacaoIncertaDesde: bruto }),
        String(bruto),
      ).toBeNull();
    }
  });

  it('⛔ NEAR-MISS: uma trava ILEGÍVEL não dá janela, mesmo com um `desde` legível dentro (UMA grafia da trava)', () => {
    for (const trava of [
      { ...TRAVA, token: '' },
      { desde: DESDE, expiraEm: EXPIRA },
      { desde: DESDE, token: 'tok-1' },
      { ...TRAVA, expiraEm: String(EXPIRA) },
      'tok-1',
      DESDE,
    ]) {
      expect(
        janelaDaCriacaoIncertaShopee({ item_id: null, publicacaoEmCurso: trava }),
        JSON.stringify(trava),
      ).toBeNull();
    }
    // …e o registro legível ainda dá a janela ao lado de uma trava ilegível.
    expect(
      janelaDaCriacaoIncertaShopee({
        item_id: null,
        publicacaoEmCurso: { token: 'x' },
        criacaoIncertaDesde: INCERTA_DESDE,
      }),
    ).toEqual({ desdeMs: INCERTA_DESDE });
  });

  it('lê qualquer documento — ser rascunho é pergunta de quem chama', () => {
    expect(
      janelaDaCriacaoIncertaShopee({ item_id: 2500139861, criacaoIncertaDesde: INCERTA_DESDE }),
    ).toEqual({ desdeMs: INCERTA_DESDE });
  });

  it('⚠️ por que a tomada de uma trava vencida CARREGA o `desde` antigo: sem isso a janela anda para frente', () => {
    const TOMADA = EXPIRA + GRACA + 5_000;
    const novaTrava = {
      desde: TOMADA,
      expiraEm: TOMADA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
      token: 'tok-2',
    };
    // Lido ANTES da tomada: a janela é a da tentativa que caiu.
    expect(janelaDaCriacaoIncertaShopee(rascunhoTravado())).toEqual({ desdeMs: DESDE });
    // A tomada que carrega o registro mantém a janela…
    expect(
      janelaDaCriacaoIncertaShopee({
        item_id: null,
        publicacaoEmCurso: novaTrava,
        criacaoIncertaDesde: DESDE,
      }),
    ).toEqual({ desdeMs: DESDE });
    // …e a que só troca a trava a estreita até depois da tentativa antiga.
    expect(janelaDaCriacaoIncertaShopee({ item_id: null, publicacaoEmCurso: novaTrava })).toEqual({
      desdeMs: TOMADA,
    });
  });
});

describe('estadoPublicacaoRascunhoShopee × janelaDaCriacaoIncertaShopee — UMA leitura (#1369)', () => {
  const documentos: readonly (Record<string, unknown> | null)[] = [
    null,
    { item_id: null },
    { item_id: null, publicacaoEmCurso: null, criacaoIncertaDesde: null },
    { item_id: null, criacaoIncertaDesde: INCERTA_DESDE },
    { item_id: null, criacaoIncertaDesde: 'x' },
    rascunhoTravado(),
    rascunhoTravado({ criacaoIncertaDesde: INCERTA_DESDE }),
    rascunhoTravado({ criacaoIncertaDesde: 'x' }),
    { item_id: null, publicacaoEmCurso: { token: 'x' } },
    { item_id: null, publicacaoEmCurso: { token: 'x' }, criacaoIncertaDesde: INCERTA_DESDE },
    { item_id: null, publicacaoEmCurso: 'tok-1', criacaoIncertaDesde: 'x' },
  ];
  const instantes = [DESDE, EXPIRA - 1, EXPIRA, EXPIRA + GRACA - 1, EXPIRA + GRACA, Number.NaN];

  it('`incerta`.desdeMs É o início da janela; `livre` ⇒ sem janela; `em-andamento` ⇒ há janela', () => {
    let incertas = 0;
    for (const doc of documentos) {
      const janela = janelaDaCriacaoIncertaShopee(doc);
      for (const agora of instantes) {
        const estado = estadoPublicacaoRascunhoShopee(doc, agora);
        const rotulo = `${JSON.stringify(doc)} @ ${String(agora)}`;
        if (estado.tipo === 'incerta') {
          incertas += 1;
          expect(estado.desdeMs, rotulo).toBe(janela?.desdeMs ?? null);
        } else if (estado.tipo === 'livre') {
          expect(janela, rotulo).toBeNull();
        } else {
          expect(janela, rotulo).not.toBeNull();
        }
      }
    }
    // A propriedade não é vacuamente verdadeira: muitas leituras são `incerta`.
    expect(incertas).toBeGreaterThan(20);
  });
});

describe('o ciclo de um 202 (P5): a trava fica viva pela espera, depois `incerta` SEM segunda carência', () => {
  // O `incerto` reescreve a trava DO MESMO token: expiraEm = agora + a espera,
  // criacaoIncertaDesde = o registrado ?? o desde da trava.
  const ACEITO = DESDE + 42_000;
  const reescrito = {
    item_id: null,
    publicacaoEmCurso: {
      desde: DESDE,
      expiraEm: ACEITO + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
      token: 'tok-1',
    },
    criacaoIncertaDesde: DESDE,
  };

  it('no instante do 202: em-andamento, aposIncerteza, e a espera inteira por cumprir', () => {
    expect(estadoPublicacaoRascunhoShopee(reescrito, ACEITO)).toEqual({
      tipo: 'em-andamento',
      desdeMs: DESDE,
      expiraEmMs: ACEITO + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
      aguardarMs: AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
      aposIncerteza: true,
      posExpiracao: false,
    });
  });

  it('um ms antes do fim: em-andamento; no fim: incerta JÁ, com a janela da tentativa', () => {
    const fim = ACEITO + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS;
    expect(estadoPublicacaoRascunhoShopee(reescrito, fim - 1)).toMatchObject({
      tipo: 'em-andamento',
      aguardarMs: 1,
      aposIncerteza: true,
    });
    expect(estadoPublicacaoRascunhoShopee(reescrito, fim)).toEqual({
      tipo: 'incerta',
      desdeMs: DESDE,
    });
    expect(janelaDaCriacaoIncertaShopee(reescrito)).toEqual({ desdeMs: DESDE });
  });

  it('o `aguardarMs` do 202 é o que a leitura responde no mesmo instante — e o envelope o aceita', () => {
    const estado = estadoPublicacaoRascunhoShopee(reescrito, ACEITO);
    if (estado.tipo !== 'em-andamento') throw new Error('esperava em-andamento');
    const corpo: RespostaItemIncertoShopee = respostaItemIncertoShopeeSchema.parse({
      arma: 'item',
      desfecho: 'incerto',
      linkDocId: 'AbCdEfGhIjKlMnOpQrSt',
      aguardarMs: estado.aguardarMs,
      reenvioVerificaSku: true,
      recusa: null,
    });
    expect(corpo.aguardarMs).toBe(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS);
  });
});

describe('criadoNaJanelaShopee — dentro, fora ou desconhecido (K1-7)', () => {
  /** An attempt that started half a second into its second. */
  const TENTATIVA_MS = 1_761_000_000_500;
  const SEGUNDO = 1_761_000_000;
  const INICIO = SEGUNDO - FOLGA_JANELA_CRIACAO_SHOPEE_S;

  it('o início da janela é ⌊desde/1000⌋ − a folga, ARREDONDADO PARA BAIXO', () => {
    expect(inicioDaJanelaDaCriacaoShopeeS(TENTATIVA_MS)).toBe(INICIO);
    expect(inicioDaJanelaDaCriacaoShopeeS(SEGUNDO * 1000)).toBe(INICIO);
    expect(inicioDaJanelaDaCriacaoShopeeS(SEGUNDO * 1000 + 999)).toBe(INICIO);
  });

  it('PAR: no próprio segundo da tentativa, depois dela e EXATAMENTE no início ⇒ dentro (inclusivo)', () => {
    const casos: readonly (readonly [number, PosicaoNaJanelaShopee])[] = [
      [SEGUNDO, 'dentro'],
      [SEGUNDO + 1, 'dentro'],
      [SEGUNDO + 86_400, 'dentro'],
      [INICIO, 'dentro'],
      [SEGUNDO - 1, 'dentro'],
      [SEGUNDO - 299, 'dentro'],
    ];
    for (const [criadoS, esperado] of casos) {
      expect(criadoNaJanelaShopee(criadoS, TENTATIVA_MS), String(criadoS)).toBe(esperado);
    }
  });

  it('⛔ NEAR-MISS: um segundo antes do início ⇒ fora (um anúncio mais antigo, nunca o da tentativa)', () => {
    expect(criadoNaJanelaShopee(INICIO - 1, TENTATIVA_MS)).toBe('fora');
    expect(criadoNaJanelaShopee(SEGUNDO - 301, TENTATIVA_MS)).toBe('fora');
    expect(criadoNaJanelaShopee(SEGUNDO - 86_400, TENTATIVA_MS)).toBe('fora');
  });

  it('⛔ NEAR-MISS do arredondamento: com o desde no FIM do segundo, o início não sobe um segundo', () => {
    // ⌈·⌉ ou round daria INICIO + 1 e mandaria para `fora` um anúncio criado
    // exatamente no início.
    for (const desde of [SEGUNDO * 1000 + 999, SEGUNDO * 1000 + 500]) {
      expect(criadoNaJanelaShopee(INICIO, desde), String(desde)).toBe('dentro');
      expect(criadoNaJanelaShopee(INICIO - 1, desde), String(desde)).toBe('fora');
    }
  });

  it('⚠️ `null` (a Shopee não preencheu) ⇒ desconhecido — NUNCA fora (falha fechada)', () => {
    expect(criadoNaJanelaShopee(null, TENTATIVA_MS)).toBe('desconhecido');
  });

  it('⚠️ um create_time que não é um inteiro seguro POSITIVO ⇒ desconhecido, nunca fora', () => {
    for (const ruim of [
      0,
      -1,
      -SEGUNDO,
      1.5,
      SEGUNDO + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
    ]) {
      expect(criadoNaJanelaShopee(ruim, TENTATIVA_MS), String(ruim)).toBe('desconhecido');
    }
    // `undefined` em tempo de execução (uma chave ausente) também.
    expect(criadoNaJanelaShopee(undefined as unknown as number | null, TENTATIVA_MS)).toBe(
      'desconhecido',
    );
  });

  it('⛔ um `desdeMs` que não é um inteiro seguro ⇒ desconhecido (sem janela, nada se decide)', () => {
    for (const desde of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53]) {
      expect(criadoNaJanelaShopee(SEGUNDO, desde), String(desde)).toBe('desconhecido');
    }
  });

  it('a janela da evidência guardada decide: o registro antigo põe DENTRO o que a trava nova deixaria fora', () => {
    const docTomado = {
      item_id: null,
      publicacaoEmCurso: { desde: DESDE + 3_600_000, expiraEm: DESDE + 3_900_000, token: 't' },
      criacaoIncertaDesde: DESDE,
    };
    const janela = janelaDaCriacaoIncertaShopee(docTomado);
    if (janela === null) throw new Error('esperava uma janela');
    const criadoPelaTentativaS = Math.floor(DESDE / 1000) + 5;
    expect(criadoNaJanelaShopee(criadoPelaTentativaS, janela.desdeMs)).toBe('dentro');
    expect(criadoNaJanelaShopee(criadoPelaTentativaS, DESDE + 3_600_000)).toBe('fora');
  });
});

/* -------------------------------------------------------------------------- */
/*                       (4) rascunhoSemMarcaShopee                           */
/* -------------------------------------------------------------------------- */

describe('rascunhoSemMarcaShopee — a marca ainda por escolher (D10)', () => {
  it('PAR: rascunho com `brand_id: null` e rascunho SEM a chave são "sem marca"', () => {
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: null })).toBe(true);
    expect(rascunhoSemMarcaShopee({ item_id: null })).toBe(true);
    expect(rascunhoSemMarcaShopee({})).toBe(true);
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: undefined })).toBe(true);
  });

  it('⛔ NEAR-MISS: `brand_id: 0` é "Sem marca" ESCOLHIDO — não é pendência', () => {
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: 0 })).toBe(false);
  });

  it('DISTINTO: todo inteiro seguro NÃO negativo é marca escolhida (0, 1, 77, o maior seguro)', () => {
    for (const brand of [0, 1, 77, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: brand }), String(brand)).toBe(false);
    }
  });

  it('⛔ FALHA FECHADA (emenda do P5): um brand_id malformado é "sem marca" — nunca uma marca escolhida', () => {
    // Antes da emenda, cada um destes respondia "escolhida" e a publicação
    // seguia com a marca da cascata, enquanto o editor mostrava "sem marca".
    for (const brand of [
      '77',
      '0',
      '',
      false,
      true,
      1.5,
      -0.5,
      -1,
      Number.MIN_SAFE_INTEGER,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      {},
      [77],
      { brand_id: 77 },
    ]) {
      expect(
        rascunhoSemMarcaShopee({ item_id: null, brand_id: brand }),
        typeof brand === 'object' ? JSON.stringify(brand) : String(brand),
      ).toBe(true);
    }
  });

  it('⛔ NEAR-MISS nas duas fronteiras: −1 é "sem marca" e 0 é escolhida; 2^53 − 1 é escolhida e 2^53 não', () => {
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: -1 })).toBe(true);
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: 0 })).toBe(false);
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: 2 ** 53 - 1 })).toBe(false);
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: 2 ** 53 })).toBe(true);
  });

  it('⛔ NEAR-MISS: um anúncio importado com `brand_id: null` NÃO é rascunho ⇒ não é pendência', () => {
    expect(rascunhoSemMarcaShopee({ item_id: 2500139861, brand_id: null })).toBe(false);
    const importadoRemovido: Record<string, unknown> = {
      item_id: 2500139861,
      brand_id: null,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
    };
    expect(rascunhoSemMarcaShopee(importadoRemovido)).toBe(false);
  });

  it('DISTINTO: o resíduo de kit nativo (`kitNativo: true`, sem item) e o documento nulo', () => {
    expect(rascunhoSemMarcaShopee({ item_id: null, kitNativo: true, brand_id: null })).toBe(false);
    expect(rascunhoSemMarcaShopee(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (5) vinculosQueExigemConfirmacaoShopee                      */
/* -------------------------------------------------------------------------- */

describe('vinculosQueExigemConfirmacaoShopee — o segundo anúncio (D15, K1-4)', () => {
  const rascunhoA = { id: 'A', data: { contaProdutoShopeeOuterRef: REF, item_id: null } };
  const rascunhoB = { id: 'B', data: { contaProdutoShopeeOuterRef: REF, item_id: null } };
  const vivo = {
    id: 'V',
    data: {
      contaProdutoShopeeOuterRef: REF,
      item_id: 2500139861,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    },
  };

  it('dois rascunhos da conta: publicar A ⇒ B exige a confirmação', () => {
    expect(vinculosQueExigemConfirmacaoShopee([rascunhoA, rascunhoB], CONTA, 'A')).toEqual([
      { linkDocId: 'B', itemId: null, rascunho: true },
    ]);
  });

  it('⛔ NEAR-MISS: B `removido` (não é vivo nem rascunho) ⇒ nada a confirmar', () => {
    const bRemovido = {
      id: 'B',
      data: {
        contaProdutoShopeeOuterRef: REF,
        item_id: 2500139862,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      },
    };
    expect(vinculosQueExigemConfirmacaoShopee([rascunhoA, bRemovido], CONTA, 'A')).toEqual([]);
  });

  it('um anúncio vivo conta com o seu item_id — e um SUBSTITUÍDO também (ainda está na Shopee)', () => {
    const substituido = {
      id: 'S',
      data: {
        contaProdutoShopeeOuterRef: REF,
        item_id: 2500139863,
        substituidoPorLinkDocId: 'V',
      },
    };
    expect(vinculosQueExigemConfirmacaoShopee([vivo, substituido, rascunhoA], CONTA, 'A')).toEqual([
      { linkDocId: 'V', itemId: 2500139861, rascunho: false },
      { linkDocId: 'S', itemId: 2500139863, rascunho: false },
    ]);
  });

  it('o próprio link fica de fora; sem `excluirLinkDocId`, todos contam (a criação de um rascunho novo)', () => {
    expect(vinculosQueExigemConfirmacaoShopee([rascunhoA], CONTA, 'A')).toEqual([]);
    expect(vinculosQueExigemConfirmacaoShopee([rascunhoA, vivo], CONTA)).toEqual([
      { linkDocId: 'A', itemId: null, rascunho: true },
      { linkDocId: 'V', itemId: 2500139861, rascunho: false },
    ]);
  });

  it('PAR: as duas codificações do ref da conta contam igual', () => {
    const legado = { id: 'L', data: { contaProdutoShopeeOuterRef: REF_NUA, item_id: null } };
    expect(vinculosQueExigemConfirmacaoShopee([legado], CONTA)).toEqual([
      { linkDocId: 'L', itemId: null, rascunho: true },
    ]);
  });

  it('⛔ NEAR-MISS: um link de OUTRA conta (`int-12` não é `int-1`) ou sem conta não conta', () => {
    const outra = { id: 'O', data: { contaProdutoShopeeOuterRef: OUTRA_REF, item_id: 2500139864 } };
    const semConta = { id: 'N', data: { item_id: null } };
    expect(vinculosQueExigemConfirmacaoShopee([outra, semConta], CONTA)).toEqual([]);
  });

  it('⛔ NEAR-MISS: um link CORROMPIDO (item 0, "123", resíduo de kit nativo) não é nenhum dos dois', () => {
    const corrompidos = [
      { id: 'z', data: { contaProdutoShopeeOuterRef: REF, item_id: 0 } },
      { id: 's', data: { contaProdutoShopeeOuterRef: REF, item_id: '123' } },
      { id: 'k', data: { contaProdutoShopeeOuterRef: REF, item_id: null, kitNativo: true } },
    ];
    for (const c of corrompidos) {
      expect(anuncioShopeeVivo(c.data) || ehRascunhoShopee(c.data), c.id).toBe(false);
    }
    expect(vinculosQueExigemConfirmacaoShopee(corrompidos, CONTA)).toEqual([]);
  });

  it('(batch-A) um vivo com item_id NÃO endereçável (1.5, além de 2^53) ainda CONTA — com `itemId: null`, e a saída cabe no schema', () => {
    const fracionado = { id: 'F', data: { contaProdutoShopeeOuterRef: REF, item_id: 1.5 } };
    const enorme = {
      id: 'G',
      data: { contaProdutoShopeeOuterRef: REF, item_id: Number.MAX_SAFE_INTEGER + 2 },
    };
    // Membership is "alive" (`isFinite`) — unchanged.
    expect(anuncioShopeeVivo(fracionado.data)).toBe(true);
    expect(anuncioShopeeVivo(enorme.data)).toBe(true);
    const saida = vinculosQueExigemConfirmacaoShopee([fracionado, enorme, vivo], CONTA);
    expect(saida).toEqual([
      { linkDocId: 'F', itemId: null, rascunho: false },
      { linkDocId: 'G', itemId: null, rascunho: false },
      // ⛔ near-miss: an addressable id is carried verbatim.
      { linkDocId: 'V', itemId: 2500139861, rascunho: false },
    ]);
    expect(() => vinculoConflitanteShopeeSchema.array().parse(saida)).not.toThrow();
  });

  it('(batch-A) `itemIdEnderecavelShopee` — o ÚNICO leitor do id endereçável: inteiro seguro > 0, senão null', () => {
    expect(itemIdEnderecavelShopee(2500139861)).toBe(2500139861);
    expect(itemIdEnderecavelShopee(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const v of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '123',
      null,
      undefined,
    ]) {
      expect(itemIdEnderecavelShopee(v), String(v)).toBeNull();
    }
  });

  it('a saída é EXATAMENTE o que o leitor do 409 aceita (vinculoConflitanteShopeeSchema)', () => {
    const saida = vinculosQueExigemConfirmacaoShopee([vivo, rascunhoA, rascunhoB], CONTA, 'B');
    expect(saida).toHaveLength(2);
    for (const v of saida) expect(vinculoConflitanteShopeeSchema.parse(v)).toEqual(v);
  });
});

describe('vinculoConflitanteShopeeSchema — o item de `vinculos[]`', () => {
  it('PAR: rascunho (itemId null) e anúncio (itemId inteiro); chaves a mais caem fora', () => {
    expect(
      vinculoConflitanteShopeeSchema.parse({ linkDocId: 'A', itemId: null, rascunho: true }),
    ).toEqual({ linkDocId: 'A', itemId: null, rascunho: true });
    expect(
      vinculoConflitanteShopeeSchema.parse({
        linkDocId: 'V',
        itemId: 2500139861,
        rascunho: false,
        produtoId: 'p-1',
      }),
    ).toEqual({ linkDocId: 'V', itemId: 2500139861, rascunho: false });
  });

  it('⛔ NEAR-MISS: linkDocId vazio, itemId fracionário ou em texto, rascunho ausente são recusados', () => {
    for (const ruim of [
      { linkDocId: '', itemId: null, rascunho: true },
      { linkDocId: 'V', itemId: 1.5, rascunho: false },
      { linkDocId: 'V', itemId: '2500139861', rascunho: false },
      { linkDocId: 'V', itemId: 2500139861 },
    ]) {
      expect(vinculoConflitanteShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                  (7) the 422's motivo (P4, K2-10)                           */
/* -------------------------------------------------------------------------- */

describe('MOTIVO_RASCUNHO_INVALIDO_SHOPEE — o motivo do 422 (K2-10)', () => {
  it('os dois valores congelados no §2.1, e a constante cobre EXATAMENTE o enum', () => {
    expect(motivoRascunhoInvalidoShopeeSchema.options).toEqual(['filho', 'kit-virtual']);
    expect(MOTIVO_RASCUNHO_INVALIDO_SHOPEE).toEqual({ filho: 'filho', kitVirtual: 'kit-virtual' });
    expect(Object.values(MOTIVO_RASCUNHO_INVALIDO_SHOPEE).sort()).toEqual(
      [...motivoRascunhoInvalidoShopeeSchema.options].sort(),
    );
  });

  it('⛔ NEAR-MISS: os slugs PERSISTIDOS do despacho não são motivos desta rota', () => {
    // `falhaPublicacao` guarda o vocabulário do despacho; uma resposta que
    // ninguém guarda não se mistura com ele (o pino de `errosPublicacao.test.ts`).
    for (const slug of ['rascunho-em-kit-virtual', 'produto-e-filho', 'kit_virtual', 'Filho']) {
      expect(motivoRascunhoInvalidoShopeeSchema.safeParse(slug).success, slug).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                     (8) the vocabulary of the fields                        */
/* -------------------------------------------------------------------------- */

describe('CampoRascunhoShopee — os campos editáveis (§2.1)', () => {
  it('os seis campos na ordem CANÔNICA, e a constante cobre exatamente o enum', () => {
    expect(campoRascunhoShopeeSchema.options).toEqual([
      'item_name',
      'description',
      'category_id',
      'marca',
      'attributes',
      'logistic_info',
    ]);
    expect(Object.values(CAMPO_RASCUNHO_SHOPEE)).toEqual(campoRascunhoShopeeSchema.options);
  });
});

/* -------------------------------------------------------------------------- */
/*                  (9) camposDoRascunhoShopee — THE projection                */
/* -------------------------------------------------------------------------- */

const C = CAMPO_RASCUNHO_SHOPEE;
const VAZIO: CamposRascunhoShopee = {
  item_name: null,
  description: null,
  category_id: null,
  marca: null,
  attributes: null,
};

/** A request-shape attribute list (what the draft route writes). */
const ATRIBUTOS = [
  { attribute_id: 10, attribute_value_list: [{ value_id: 55 }] },
  { attribute_id: 11, attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }] },
  {
    attribute_id: 12,
    attribute_value_list: [{ value_id: 0, original_value_name: '30', value_unit: 'cm' }],
  },
];

/**
 * What the draft route STORES for a normalised write — the frozen rule "the
 * pair is stored as BOTH keys; `null` ⇒ both `null`". The test's own spelling,
 * used to prove that every value a write produces reads back through the
 * projection unchanged.
 */
function gravado(conteudo: z.output<typeof conteudoRascunhoShopeeSchema>): Record<string, unknown> {
  const { marca, ...escalares } = conteudo;
  return {
    item_id: null,
    ...escalares,
    ...(marca === undefined
      ? {}
      : {
          brand_id: marca === null ? null : marca.brand_id,
          original_brand_name: marca === null ? null : marca.original_brand_name,
        }),
  };
}

/** Every field the value NAMES compares equal to the projection of what was stored. */
function todosIguais(
  campos: CamposRascunhoShopee,
  valores: Partial<Record<CampoRascunhoShopee, unknown>>,
): boolean {
  const lidos = campos as unknown as Record<CampoRascunhoShopee, never>;
  const dados = valores as Record<CampoRascunhoShopee, never>;
  return camposPresentesDoRascunhoShopee(valores).every((campo) =>
    mesmoValorDoRascunhoShopee(campo, lidos[campo], dados[campo]),
  );
}

describe('camposDoRascunhoShopee — A projeção de um rascunho guardado (K2-4, #1369)', () => {
  it('PAR: chave AUSENTE e `null` explícito são o MESMO `null` — decidido aqui, uma vez', () => {
    expect(camposDoRascunhoShopee({})).toEqual(VAZIO);
    expect(
      camposDoRascunhoShopee({
        item_id: null,
        item_name: null,
        description: null,
        category_id: null,
        brand_id: null,
        original_brand_name: null,
      }),
    ).toEqual(VAZIO);
  });

  it('VERBATIM: nunca apara, nunca troca o branco por `null` (o "" legado fica "")', () => {
    expect(camposDoRascunhoShopee({ item_name: 'Camiseta ', description: '' })).toMatchObject({
      item_name: 'Camiseta ',
      description: '',
    });
    expect(camposDoRascunhoShopee({ item_name: '', description: '   ' })).toMatchObject({
      item_name: '',
      description: '   ',
    });
  });

  it('a marca é o PAR quando há brand_id; `0` ("Sem marca") é uma escolha', () => {
    expect(camposDoRascunhoShopee({ brand_id: 77, original_brand_name: 'Acme' }).marca).toEqual({
      brand_id: 77,
      original_brand_name: 'Acme',
    });
    expect(camposDoRascunhoShopee({ brand_id: 0 }).marca).toEqual({
      brand_id: 0,
      original_brand_name: null,
    });
    expect(camposDoRascunhoShopee({ brand_id: 77, original_brand_name: '' }).marca).toEqual({
      brand_id: 77,
      original_brand_name: '',
    });
  });

  it('⛔ NEAR-MISS: um nome SEM brand_id não é marca escolhida', () => {
    expect(camposDoRascunhoShopee({ original_brand_name: 'Acme' }).marca).toBeNull();
    expect(
      camposDoRascunhoShopee({ brand_id: null, original_brand_name: 'Acme' }).marca,
    ).toBeNull();
  });

  it('um valor ILEGÍVEL lê `null` — o rascunho continua editável', () => {
    expect(
      camposDoRascunhoShopee({
        item_name: 123,
        description: { paragrafos: [] },
        category_id: '100087',
        brand_id: '77',
        original_brand_name: 'Acme',
      }),
    ).toEqual(VAZIO);
    for (const categoria of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', true]) {
      expect(
        camposDoRascunhoShopee({ category_id: categoria }).category_id,
        String(categoria),
      ).toBeNull();
    }
    expect(camposDoRascunhoShopee({ brand_id: 77, original_brand_name: 5 }).marca).toEqual({
      brand_id: 77,
      original_brand_name: null,
    });
  });

  it('ler não é validar: inteiros fora da faixa de ESCRITA (0, negativo) são lidos VERBATIM', () => {
    expect(camposDoRascunhoShopee({ category_id: 0, brand_id: -1 })).toMatchObject({
      category_id: 0,
      marca: { brand_id: -1, original_brand_name: null },
    });
  });

  it('o campo RESERVADO (logistic_info) não é projetado, mesmo quando guardado; attributes SIM (P6)', () => {
    const campos = camposDoRascunhoShopee({
      attributes: [{ attribute_id: 1 }],
      logistic_info: [{ logistic_id: 2 }],
    });
    expect(Object.keys(campos)).toEqual([
      'item_name',
      'description',
      'category_id',
      'marca',
      'attributes',
    ]);
  });

  it('attributes (P6): a forma de REQUISIÇÃO guardada é projetada como está, na ordem guardada', () => {
    expect(camposDoRascunhoShopee({ attributes: ATRIBUTOS }).attributes).toEqual(ATRIBUTOS);
    expect(camposDoRascunhoShopee({ attributes: [...ATRIBUTOS].reverse() }).attributes).toEqual(
      [...ATRIBUTOS].reverse(),
    );
  });

  it('attributes (P6): a forma de LEITURA da importação e o legado sem value_id saem na forma de REQUISIÇÃO (Q1)', () => {
    const importado = [
      {
        attribute_id: 10,
        original_attribute_name: 'Material',
        attribute_value_list: [{ value_id: 55, original_value_name: 'Algodão', value_unit: null }],
      },
      { attribute_id: 11, attribute_value_list: [{ original_value_name: ' Linho ' }] },
      { attribute_id: 12, attribute_value_list: [{ original_value_name: '  ' }] },
    ];
    expect(camposDoRascunhoShopee({ attributes: importado }).attributes).toEqual([
      { attribute_id: 10, attribute_value_list: [{ value_id: 55 }] },
      { attribute_id: 11, attribute_value_list: [{ value_id: 0, original_value_name: 'Linho' }] },
    ]);
  });

  it('attributes (P6): ausente, `null` ou não-lista ⇒ `null` ⟷ uma lista (mesmo sem nada útil) ⇒ uma lista', () => {
    for (const bruto of [undefined, null, 'x', 7, { attribute_id: 1 }]) {
      expect(camposDoRascunhoShopee({ attributes: bruto }).attributes, String(bruto)).toBeNull();
    }
    expect(camposDoRascunhoShopee({}).attributes).toBeNull();
    expect(camposDoRascunhoShopee({ attributes: [] }).attributes).toEqual([]);
    expect(camposDoRascunhoShopee({ attributes: [{ attribute_id: 'x' }] }).attributes).toEqual([]);
  });

  it('lê qualquer documento — ser rascunho é pergunta de quem chama', () => {
    expect(camposDoRascunhoShopee({ item_id: 2500139861, item_name: 'Vivo' }).item_name).toBe(
      'Vivo',
    );
  });

  it('um rascunho recém-criado pelo schema guardado projeta exatamente o que foi escrito', () => {
    const criado = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: REF,
      item_name: 'Camiseta',
    }) as Record<string, unknown>;
    expect(camposDoRascunhoShopee(criado)).toEqual({ ...VAZIO, item_name: 'Camiseta' });
  });

  it('PAR com rascunhoSemMarcaShopee: brand_id nulo, ausente, NÃO negativo ou ilegível ⇒ `marca === null` ⇔ "sem marca"', () => {
    const rascunhos: Record<string, unknown>[] = [
      { item_id: null },
      { item_id: null, brand_id: null },
      { item_id: null, brand_id: 0 },
      { item_id: null, brand_id: 77 },
      { item_id: null, brand_id: '77' },
      { item_id: null, brand_id: '' },
      { item_id: null, brand_id: false },
      { item_id: null, brand_id: 1.5 },
      { item_id: null, brand_id: Number.NaN },
      { item_id: null, brand_id: 2 ** 53 },
    ];
    for (const r of rascunhos) {
      expect(camposDoRascunhoShopee(r).marca === null, String(r.brand_id)).toBe(
        rascunhoSemMarcaShopee(r),
      );
    }
  });

  it('⚠️ ALINHADO (emenda do P5): o brand_id "77" em texto é ilegível aqui E "sem marca" lá — a publicação recusa', () => {
    // Antes da emenda este pino guardava a DIVERGÊNCIA: a projeção lia `null`
    // ("não escolhida") e o predicado respondia "escolhida", então a montagem
    // seguia com a marca da cascata. Agora as duas leituras concordam.
    const corrompido: Record<string, unknown> = { item_id: null, brand_id: '77' };
    expect(camposDoRascunhoShopee(corrompido).marca).toBeNull();
    expect(rascunhoSemMarcaShopee(corrompido)).toBe(true);
  });

  it('⛔ nunca a direção INSEGURA: em todo rascunho, `marca === null` ⇒ "sem marca" (nenhuma marca não escolhida é enviada)', () => {
    const valores: readonly unknown[] = [
      undefined,
      null,
      0,
      77,
      -1,
      Number.MIN_SAFE_INTEGER,
      '77',
      '',
      false,
      true,
      1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      {},
      [],
    ];
    for (const brand_id of valores) {
      const r: Record<string, unknown> = { item_id: null, brand_id };
      if (camposDoRascunhoShopee(r).marca === null) {
        expect(rascunhoSemMarcaShopee(r), String(brand_id)).toBe(true);
      }
    }
  });

  it('⚠️ RESÍDUO PINADO, na direção segura: um brand_id NEGATIVO é lido verbatim aqui e "sem marca" lá', () => {
    // A projeção lê inteiros fora da faixa de escrita VERBATIM (ler não é
    // validar); nenhum escritor grava um negativo. O editor mostra o id
    // guardado ao lado da pendência e a publicação RECUSA — nunca envia.
    const negativo: Record<string, unknown> = { item_id: null, brand_id: -1 };
    expect(camposDoRascunhoShopee(negativo).marca).toEqual({
      brand_id: -1,
      original_brand_name: null,
    });
    expect(rascunhoSemMarcaShopee(negativo)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*              (10) mesmoValorDoRascunhoShopee — THE comparison               */
/* -------------------------------------------------------------------------- */

describe('mesmoValorDoRascunhoShopee — a comparação ESTREITA', () => {
  const ACME = { brand_id: 77, original_brand_name: 'Acme' };

  it('PAR: `undefined` ≡ `null` em cada campo escalar e na marca', () => {
    expect(mesmoValorDoRascunhoShopee(C.itemName, undefined, null)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.description, null, undefined)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.categoryId, undefined, undefined)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.marca, undefined, null)).toBe(true);
  });

  it('PAR: o mesmo texto, o mesmo número, o mesmo "" e duas marcas nulas', () => {
    expect(mesmoValorDoRascunhoShopee(C.itemName, 'Camiseta', 'Camiseta')).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.description, '', '')).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.categoryId, 100087, 100087)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.marca, null, null)).toBe(true);
  });

  it('PAR: a marca compara pelo brand_id — o nome SEGUE o id', () => {
    expect(
      mesmoValorDoRascunhoShopee(C.marca, ACME, { brand_id: 77, original_brand_name: null }),
    ).toBe(true);
    expect(
      mesmoValorDoRascunhoShopee(C.marca, ACME, { brand_id: 77, original_brand_name: 'ACME Ltda' }),
    ).toBe(true);
  });

  it('⛔ NEAR-MISS: "Camiseta" vs "Camiseta " (sem trim) e vs "camiseta" (sem caixa)', () => {
    expect(mesmoValorDoRascunhoShopee(C.itemName, 'Camiseta', 'Camiseta ')).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.itemName, ' Camiseta', 'Camiseta')).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.itemName, 'Camiseta', 'camiseta')).toBe(false);
  });

  it('⛔ NEAR-MISS: "" vs `null` — um "" guardado não é "nada"', () => {
    expect(mesmoValorDoRascunhoShopee(C.description, '', null)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.itemName, undefined, '')).toBe(false);
  });

  it('⛔ NEAR-MISS: 100 vs "100" — sem coerção', () => {
    const texto = '100' as unknown as number;
    expect(mesmoValorDoRascunhoShopee(C.categoryId, 100, texto)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.categoryId, 100, 101)).toBe(false);
  });

  it('⛔ NEAR-MISS: marca 0 ("Sem marca", escolhida) vs `null` (não escolhida); 0 vs 77', () => {
    const semMarca = { brand_id: 0, original_brand_name: null };
    expect(mesmoValorDoRascunhoShopee(C.marca, semMarca, null)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.marca, undefined, semMarca)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.marca, semMarca, ACME)).toBe(false);
  });

  it('⛔ uma "marca" que não é um par nunca é igual a nada — a dúvida vira conflito', () => {
    const solto = 77 as unknown as typeof ACME;
    expect(mesmoValorDoRascunhoShopee(C.marca, solto, solto)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.marca, solto, ACME)).toBe(false);
    // @ts-expect-error — a marca é o PAR, nunca um brand_id solto.
    expect(mesmoValorDoRascunhoShopee(C.marca, 77, null)).toBe(false);
  });

  it('RESERVADO: logistic_info é SEMPRE distinto, até `null` vs `null` (até o P15)', () => {
    expect(mesmoValorDoRascunhoShopee(C.logisticInfo, null, null)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.logisticInfo, undefined, undefined)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.logisticInfo, [], [])).toBe(false);
  });
});

describe('mesmoValorDoRascunhoShopee — attributes (P6, K2-5): ESTRUTURAL e estreita', () => {
  /** A structurally identical COPY — never the same reference. */
  const copia = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  it('PAR: `undefined` ≡ `null`; `[]` ≡ `[]`; a mesma lista em OUTRA referência', () => {
    expect(mesmoValorDoRascunhoShopee(C.attributes, undefined, null)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.attributes, null, null)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.attributes, [], [])).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.attributes, ATRIBUTOS, copia(ATRIBUTOS))).toBe(true);
  });

  it('PAR: as mesmas chaves em OUTRA ORDEM (o objeto não é texto)', () => {
    const reordenadas = [
      { attribute_value_list: [{ value_id: 55 }], attribute_id: 10 },
      { attribute_value_list: [{ original_value_name: 'Algodão', value_id: 0 }], attribute_id: 11 },
      {
        attribute_value_list: [{ value_unit: 'cm', original_value_name: '30', value_id: 0 }],
        attribute_id: 12,
      },
    ];
    expect(mesmoValorDoRascunhoShopee(C.attributes, ATRIBUTOS, reordenadas)).toBe(true);
  });

  it('⛔ NEAR-MISS: `value_unit` AUSENTE vs "" — distintos', () => {
    const semUnidade = [{ attribute_id: 12, attribute_value_list: [{ value_id: 7 }] }];
    const unidadeVazia = [
      { attribute_id: 12, attribute_value_list: [{ value_id: 7, value_unit: '' }] },
    ];
    expect(mesmoValorDoRascunhoShopee(C.attributes, semUnidade, unidadeVazia)).toBe(false);
  });

  it('⛔ NEAR-MISS: a mesma lista REORDENADA (atributos ou valores) — distintas: reordenar é uma edição', () => {
    expect(mesmoValorDoRascunhoShopee(C.attributes, ATRIBUTOS, [...ATRIBUTOS].reverse())).toBe(
      false,
    );
    const ab = [{ attribute_id: 1, attribute_value_list: [{ value_id: 1 }, { value_id: 2 }] }];
    const ba = [{ attribute_id: 1, attribute_value_list: [{ value_id: 2 }, { value_id: 1 }] }];
    expect(mesmoValorDoRascunhoShopee(C.attributes, ab, ba)).toBe(false);
  });

  it('⛔ NEAR-MISS: `[]` vs `null`; 55 vs "55"; um valor a mais; um nome diferente', () => {
    const um = [{ attribute_id: 1, attribute_value_list: [{ value_id: 55 }] }];
    const texto = [
      { attribute_id: 1, attribute_value_list: [{ value_id: '55' as unknown as number }] },
    ];
    expect(mesmoValorDoRascunhoShopee(C.attributes, [], null)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.attributes, um, texto)).toBe(false);
    expect(
      mesmoValorDoRascunhoShopee(C.attributes, um, [
        { attribute_id: 1, attribute_value_list: [{ value_id: 55 }, { value_id: 56 }] },
      ]),
    ).toBe(false);
    const linho = [
      { attribute_id: 1, attribute_value_list: [{ value_id: 0, original_value_name: 'Linho' }] },
    ];
    const linhoEspaco = [
      { attribute_id: 1, attribute_value_list: [{ value_id: 0, original_value_name: 'Linho ' }] },
    ];
    expect(mesmoValorDoRascunhoShopee(C.attributes, linho, linhoEspaco)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                      (11) camposPresentesDoRascunhoShopee                   */
/* -------------------------------------------------------------------------- */

describe('camposPresentesDoRascunhoShopee — os campos que um valor NOMEIA', () => {
  it('na ordem canônica, qualquer que seja a ordem das chaves; `null` conta, `undefined` não', () => {
    expect(
      camposPresentesDoRascunhoShopee({ marca: null, item_name: 'x', description: undefined }),
    ).toEqual(['item_name', 'marca']);
    expect(camposPresentesDoRascunhoShopee({ category_id: 1, item_name: null })).toEqual([
      'item_name',
      'category_id',
    ]);
    expect(camposPresentesDoRascunhoShopee({})).toEqual([]);
  });
});

describe('camposDaBaseDoRascunhoShopee — o que a base PRECISA nomear (K1-12)', () => {
  it('os campos do patch — mais `attributes` quando o patch troca category_id sem eles', () => {
    expect(camposDaBaseDoRascunhoShopee({ item_name: 'x' })).toEqual(['item_name']);
    expect(camposDaBaseDoRascunhoShopee({ category_id: 1 })).toEqual(['category_id', 'attributes']);
    expect(camposDaBaseDoRascunhoShopee({ category_id: null })).toEqual([
      'category_id',
      'attributes',
    ]);
    expect(camposDaBaseDoRascunhoShopee({ marca: null, category_id: 1, item_name: 'x' })).toEqual([
      'item_name',
      'category_id',
      'marca',
      'attributes',
    ]);
  });

  it('⛔ QUASE-PAR: o patch que JÁ traz attributes não ganha nada; sem category_id, nada também', () => {
    expect(camposDaBaseDoRascunhoShopee({ category_id: 1, attributes: [] })).toEqual([
      'category_id',
      'attributes',
    ]);
    expect(camposDaBaseDoRascunhoShopee({ attributes: null })).toEqual(['attributes']);
    expect(camposDaBaseDoRascunhoShopee({ description: null })).toEqual(['description']);
    expect(camposDaBaseDoRascunhoShopee({})).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (12) conteudoRascunhoShopeeSchema — the WHITELIST           */
/* -------------------------------------------------------------------------- */

describe('conteudoRascunhoShopeeSchema — a whitelist de escrita (normaliza)', () => {
  it('PAR: `{}` é um conteúdo válido e vazio', () => {
    expect(conteudoRascunhoShopeeSchema.parse({})).toEqual({});
  });

  it('item_name é guardado VERBATIM (sem trim)', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ item_name: ' Camiseta ' })).toEqual({
      item_name: ' Camiseta ',
    });
  });

  it('description: em branco ⇒ `null` ("a do produto"); com texto, VERBATIM', () => {
    for (const branco of ['', '   ', '\n\t', null]) {
      expect(
        conteudoRascunhoShopeeSchema.parse({ description: branco }),
        JSON.stringify(branco),
      ).toEqual({ description: null });
    }
    expect(conteudoRascunhoShopeeSchema.parse({ description: ' Algodão \n' })).toEqual({
      description: ' Algodão \n',
    });
  });

  it('a marca: `null` fica `null`; `0` apaga o nome; nome em branco ⇒ `null`; com texto, VERBATIM', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ marca: null })).toEqual({ marca: null });
    expect(
      conteudoRascunhoShopeeSchema.parse({
        marca: { brand_id: 0, original_brand_name: 'No Brand' },
      }),
    ).toEqual({ marca: { brand_id: 0, original_brand_name: null } });
    expect(
      conteudoRascunhoShopeeSchema.parse({ marca: { brand_id: 77, original_brand_name: '  ' } }),
    ).toEqual({ marca: { brand_id: 77, original_brand_name: null } });
    expect(
      conteudoRascunhoShopeeSchema.parse({ marca: { brand_id: 77, original_brand_name: 'Acme ' } }),
    ).toEqual({ marca: { brand_id: 77, original_brand_name: 'Acme ' } });
  });

  it('category_id: um inteiro positivo ou `null`', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ category_id: 100087 })).toEqual({
      category_id: 100087,
    });
    expect(conteudoRascunhoShopeeSchema.parse({ category_id: null })).toEqual({
      category_id: null,
    });
  });

  it('attributes (P6): a forma de REQUISIÇÃO, `[]` ou `null` — normalizada ao que o decodificador lê', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ attributes: ATRIBUTOS })).toEqual({
      attributes: ATRIBUTOS,
    });
    expect(conteudoRascunhoShopeeSchema.parse({ attributes: [] })).toEqual({ attributes: [] });
    expect(conteudoRascunhoShopeeSchema.parse({ attributes: null })).toEqual({ attributes: null });
    expect(
      conteudoRascunhoShopeeSchema.parse({
        attributes: [
          {
            attribute_id: 1,
            attribute_value_list: [{ value_id: 0, original_value_name: ' Linho ', value_unit: '' }],
          },
        ],
      }),
    ).toEqual({
      attributes: [
        { attribute_id: 1, attribute_value_list: [{ value_id: 0, original_value_name: 'Linho' }] },
      ],
    });
  });

  it('⛔ attributes (P6): a forma de LEITURA, o legado sem value_id, uma lista vazia de valores, um id repetido — 400', () => {
    for (const ruim of [
      [
        {
          attribute_id: 1,
          attribute_value_list: [{ value_id: 55, original_value_name: 'Algodão' }],
        },
      ],
      [
        {
          attribute_id: 1,
          original_attribute_name: 'Material',
          attribute_value_list: [{ value_id: 55, original_value_name: null, value_unit: null }],
        },
      ],
      [{ attribute_id: 1, attribute_value_list: [{ original_value_name: 'Algodão' }] }],
      [{ attribute_id: 1, attribute_value_list: [{ value_id: 0 }] }],
      [{ attribute_id: 1, attribute_value_list: [{ value_id: '55' }] }],
      [{ attribute_id: 1, attribute_value_list: [] }],
      [
        { attribute_id: 1, attribute_value_list: [{ value_id: 5 }] },
        { attribute_id: 1, attribute_value_list: [{ value_id: 6 }] },
      ],
      [{ attribute_id: 1, attribute_value_list: [{ value_id: 5 }], is_mandatory: true }],
      { attribute_id: 1, attribute_value_list: [{ value_id: 5 }] },
    ]) {
      expect(
        conteudoRascunhoShopeeSchema.safeParse({ attributes: ruim }).success,
        JSON.stringify(ruim),
      ).toBe(false);
    }
  });

  it('⛔ a whitelist: item_id, um campo de ciclo de vida, o RESERVADO e chaves desconhecidas são recusados', () => {
    for (const ruim of [
      { item_id: 2500139861 },
      { item_status: 'NORMAL' },
      { brand_id: 77 },
      { original_brand_name: 'Acme' },
      { publicacaoEmCurso: null },
      { logistic_info: [] },
      { item_name: 'Camiseta', foo: 1 },
    ]) {
      expect(conteudoRascunhoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });

  it('⛔ item_name vazio, só espaços ou `null` é recusado com a frase', () => {
    for (const ruim of ['', '   ', '\n', null]) {
      const lido = conteudoRascunhoShopeeSchema.safeParse({ item_name: ruim });
      expect(lido.success, JSON.stringify(ruim)).toBe(false);
      expect(lido.error?.issues[0]?.message).toBe(MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE);
    }
  });

  it('as cotas são inclusivas: o máximo passa, +1 é recusado', () => {
    const nome = 'a'.repeat(MAX_ITEM_NAME_RASCUNHO_SHOPEE);
    const descricao = 'b'.repeat(MAX_DESCRIPTION_RASCUNHO_SHOPEE);
    expect(conteudoRascunhoShopeeSchema.safeParse({ item_name: nome }).success).toBe(true);
    expect(conteudoRascunhoShopeeSchema.safeParse({ item_name: `${nome}a` }).success).toBe(false);
    expect(conteudoRascunhoShopeeSchema.safeParse({ description: descricao }).success).toBe(true);
    expect(conteudoRascunhoShopeeSchema.safeParse({ description: `${descricao}b` }).success).toBe(
      false,
    );
    expect(MAX_ITEM_NAME_RASCUNHO_SHOPEE).toBe(2_000);
    expect(MAX_DESCRIPTION_RASCUNHO_SHOPEE).toBe(10_000);
  });

  it('⛔ category_id 0, negativo, fracionário, em texto ou inseguro é recusado', () => {
    for (const ruim of [0, -1, 1.5, '100087', 2 ** 53, Number.NaN]) {
      expect(
        conteudoRascunhoShopeeSchema.safeParse({ category_id: ruim }).success,
        String(ruim),
      ).toBe(false);
    }
  });

  it('⛔ a marca: brand_id negativo, fracionário ou em texto; o par sem nome; uma chave a mais', () => {
    for (const ruim of [
      { brand_id: -1, original_brand_name: null },
      { brand_id: 1.5, original_brand_name: null },
      { brand_id: '77', original_brand_name: null },
      { brand_id: 77 },
      { original_brand_name: 'Acme' },
      { brand_id: 77, original_brand_name: 'Acme', brand_name: 'Acme' },
    ]) {
      expect(
        conteudoRascunhoShopeeSchema.safeParse({ marca: ruim }).success,
        JSON.stringify(ruim),
      ).toBe(false);
    }
  });

  it('o que a escrita normaliza volta IGUAL pela projeção (todo valor gravado é legível)', () => {
    const conteudos = [
      { item_name: 'Camiseta ', description: '', category_id: 100087, marca: null },
      { description: 'Algodão', marca: { brand_id: 0, original_brand_name: 'No Brand' } },
      { marca: { brand_id: 77, original_brand_name: '  ' } },
      { marca: { brand_id: 77, original_brand_name: 'Acme' }, category_id: null },
      { attributes: ATRIBUTOS },
      { attributes: [] },
      { attributes: null, category_id: 100087 },
      {
        attributes: [
          {
            attribute_id: 1,
            attribute_value_list: [
              { value_id: 0, original_value_name: '  Linho ', value_unit: ' ' },
              { value_id: 9, value_unit: ' kg' },
            ],
          },
        ],
      },
    ];
    for (const bruto of conteudos) {
      const conteudo = conteudoRascunhoShopeeSchema.parse(bruto);
      const lidos = camposDoRascunhoShopee(gravado(conteudo));
      expect(todosIguais(lidos, conteudo), JSON.stringify(bruto)).toBe(true);
      // e o nome da marca volta exatamente como foi gravado, não só o id
      if (conteudo.marca !== undefined) expect(lidos.marca).toEqual(conteudo.marca);
      // e os atributos voltam BYTE a byte: a escrita já grava a forma que o decodificador lê
      if (conteudo.attributes !== undefined) expect(lidos.attributes).toEqual(conteudo.attributes);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*            (13) baseRascunhoShopeeSchema — what the operator SAW            */
/* -------------------------------------------------------------------------- */

const BASE_COMPLETA = {
  item_name: 'Camiseta',
  description: null,
  category_id: 100087,
  marca: { brand_id: 0, original_brand_name: null },
  attributes: null,
};

describe('baseRascunhoShopeeSchema — o que o operador VIU, verbatim (K2-4)', () => {
  it('VERBATIM: "" fica "", espaços ficam, `null` fica `null`', () => {
    expect(baseRascunhoShopeeSchema.parse({ description: '' })).toEqual({ description: '' });
    expect(baseRascunhoShopeeSchema.parse({ item_name: ' Camiseta ' })).toEqual({
      item_name: ' Camiseta ',
    });
    expect(baseRascunhoShopeeSchema.parse({ item_name: null })).toEqual({ item_name: null });
    expect(
      baseRascunhoShopeeSchema.parse({ marca: { brand_id: 0, original_brand_name: 'No Brand' } }),
    ).toEqual({ marca: { brand_id: 0, original_brand_name: 'No Brand' } });
  });

  it('⛔ QUASE-PAR com a escrita: o MESMO "" vira `null` no conteúdo e fica "" na base', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ description: '' })).toEqual({ description: null });
    expect(baseRascunhoShopeeSchema.parse({ description: '' })).toEqual({ description: '' });
  });

  it('tolerante: sem mínimo, sem máximo, inteiros fora da faixa de escrita', () => {
    const longo = 'x'.repeat(MAX_DESCRIPTION_RASCUNHO_SHOPEE + 1);
    expect(
      baseRascunhoShopeeSchema.parse({
        item_name: '',
        description: longo,
        category_id: 0,
        marca: { brand_id: -1, original_brand_name: '' },
      }),
    ).toEqual({
      item_name: '',
      description: longo,
      category_id: 0,
      marca: { brand_id: -1, original_brand_name: '' },
    });
  });

  it('attributes (P6): VERBATIM e tolerante — sem mínimo, sem trim, "" fica "", ids inteiros quaisquer', () => {
    const visto = [
      { attribute_id: 1, attribute_value_list: [] },
      {
        attribute_id: -3,
        attribute_value_list: [
          { value_id: 0, original_value_name: ' Linho ', value_unit: '' },
          { value_id: 0, original_value_name: '' },
          { value_id: 2 ** 60 },
        ],
      },
    ];
    expect(baseRascunhoShopeeSchema.parse({ attributes: visto })).toEqual({ attributes: visto });
    expect(baseRascunhoShopeeSchema.parse({ attributes: null })).toEqual({ attributes: null });
    expect(baseRascunhoShopeeSchema.parse({ attributes: [] })).toEqual({ attributes: [] });
  });

  it('⛔ attributes (P6): estrita mesmo tolerante — chave a mais, nulo da leitura, id não inteiro', () => {
    for (const ruim of [
      [{ attribute_id: 1, attribute_value_list: [{ value_id: 5, extra: 1 }] }],
      [{ attribute_id: 1, attribute_value_list: [{ value_id: 5, value_unit: null }] }],
      [{ attribute_id: 1, attribute_value_list: [{ value_id: 1.5 }] }],
      [{ attribute_id: '1', attribute_value_list: [] }],
      [{ attribute_id: 1 }],
      [{ attribute_id: 1, attribute_value_list: [], original_attribute_name: 'x' }],
    ]) {
      expect(
        baseRascunhoShopeeSchema.safeParse({ attributes: ruim }).success,
        JSON.stringify(ruim),
      ).toBe(false);
    }
  });

  it('⛔ estrita: chave desconhecida, campo RESERVADO, par incompleto e tipo errado são recusados', () => {
    for (const ruim of [
      { foo: 1 },
      { logistic_info: null },
      { brand_id: 77 },
      { marca: { brand_id: 77 } },
      { marca: { brand_id: 77, original_brand_name: null, extra: 1 } },
      { category_id: '100087' },
      { category_id: 1.5 },
      { item_name: 123 },
    ]) {
      expect(baseRascunhoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(false);
    }
  });

  it('toda projeção é uma base VERBATIM — inclusive a completa do descarte (a ida e volta)', () => {
    const guardados: Record<string, unknown>[] = [
      {},
      { item_name: '', description: '' },
      { item_name: 'Camiseta ', description: '   ', category_id: 0, brand_id: -1 },
      { item_name: 7, category_id: 'x', brand_id: 77, original_brand_name: '' },
      { item_name: 'Camiseta', brand_id: 0, original_brand_name: 'No Brand' },
      { item_name: 'z'.repeat(5_000), description: 'y'.repeat(20_000) },
      { attributes: ATRIBUTOS },
      { attributes: [] },
      { attributes: 'x' },
      {
        attributes: [
          { attribute_id: -3, attribute_value_list: [{ value_id: 2 ** 60 }] },
          { attribute_id: 7, attribute_value_list: [{ original_value_name: ' legado ' }] },
          {
            attribute_id: 8,
            attribute_value_list: [{ value_id: 9, original_value_name: 'x', value_unit: null }],
          },
          { attribute_id: 'lixo' },
        ],
      },
    ];
    const descarte = corpoDescartarRascunhoShopeeSchema.shape.base;
    for (const guardado of guardados) {
      const projecao = camposDoRascunhoShopee(guardado);
      expect(baseRascunhoShopeeSchema.parse(projecao)).toEqual(projecao);
      expect(descarte.parse(projecao)).toEqual(projecao);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       (14) the create body                                  */
/* -------------------------------------------------------------------------- */

const ID_RASCUNHO = 'Ab3dEf5hIj7lMn9pQr1t';
const IDS = { integracaoId: CONTA, produtoId: 'prod-1' };

describe('corpoCriarRascunhoShopeeSchema — POST rascunho', () => {
  it('PAR: o mínimo, e com conteúdo + confirmação', () => {
    expect(corpoCriarRascunhoShopeeSchema.parse({ ...IDS, linkDocId: ID_RASCUNHO })).toEqual({
      ...IDS,
      linkDocId: ID_RASCUNHO,
    });
    expect(
      corpoCriarRascunhoShopeeSchema.parse({
        ...IDS,
        linkDocId: ID_RASCUNHO,
        conteudo: { item_name: 'Camiseta', description: '' },
        confirmarSegundoAnuncio: true,
      }),
    ).toEqual({
      ...IDS,
      linkDocId: ID_RASCUNHO,
      conteudo: { item_name: 'Camiseta', description: null },
      confirmarSegundoAnuncio: true,
    });
  });

  it('conteudo `null` e confirmação `null`/false são aceitos (só um `true` literal confirma)', () => {
    for (const confirmar of [false, null]) {
      expect(
        corpoCriarRascunhoShopeeSchema.safeParse({
          ...IDS,
          linkDocId: ID_RASCUNHO,
          conteudo: null,
          confirmarSegundoAnuncio: confirmar,
        }).success,
      ).toBe(true);
    }
    expect(
      corpoCriarRascunhoShopeeSchema.safeParse({
        ...IDS,
        linkDocId: ID_RASCUNHO,
        confirmarSegundoAnuncio: 'true',
      }).success,
    ).toBe(false);
  });

  it('o id do rascunho: exatamente 20 letras ou dígitos (o auto-id do Firestore)', () => {
    expect(PADRAO_ID_RASCUNHO_SHOPEE.test(ID_RASCUNHO)).toBe(true);
    expect(idRascunhoShopeeSchema.safeParse('00000000000000000000').success).toBe(true);
    const ruins = [
      ID_RASCUNHO.slice(1), // 19
      `${ID_RASCUNHO}x`, // 21
      `${ID_RASCUNHO.slice(2)}a/`, // 20 com "/"
      `${ID_RASCUNHO.slice(1)}-`, // 20 com "-"
      `${ID_RASCUNHO.slice(1)}_`, // 20 com "_"
      `${ID_RASCUNHO.slice(1)}é`, // 20 com acento
      'a/b',
      '',
      'f'.repeat(64), // o id derivado de um kit nativo
    ];
    for (const ruim of ruins) {
      expect(
        corpoCriarRascunhoShopeeSchema.safeParse({ ...IDS, linkDocId: ruim }).success,
        ruim,
      ).toBe(false);
    }
  });

  it('⛔ integracaoId e produtoId inutilizáveis como id de documento são recusados', () => {
    for (const ruim of ['', 'a/b', 'integracao/int-1', '.', '..', 7]) {
      expect(
        corpoCriarRascunhoShopeeSchema.safeParse({
          ...IDS,
          integracaoId: ruim,
          linkDocId: ID_RASCUNHO,
        }).success,
        `integracaoId ${String(ruim)}`,
      ).toBe(false);
      expect(
        corpoCriarRascunhoShopeeSchema.safeParse({
          ...IDS,
          produtoId: ruim,
          linkDocId: ID_RASCUNHO,
        }).success,
        `produtoId ${String(ruim)}`,
      ).toBe(false);
    }
  });

  it('⛔ estrito: item_id no conteúdo, chave desconhecida e campo ausente são 400', () => {
    for (const ruim of [
      { ...IDS, linkDocId: ID_RASCUNHO, conteudo: { item_id: 2500139861 } },
      { ...IDS, linkDocId: ID_RASCUNHO, categoryId: 100087 },
      { ...IDS, linkDocId: ID_RASCUNHO, base: {} },
      { integracaoId: CONTA, linkDocId: ID_RASCUNHO },
      { ...IDS },
    ]) {
      expect(corpoCriarRascunhoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                         (15) the update body                                */
/* -------------------------------------------------------------------------- */

/** The update body for `base` and `patch`. */
function atualizar(base: unknown, patch: unknown): unknown {
  return { ...IDS, linkDocId: ID_RASCUNHO, base, patch };
}

/** The messages of a refused body. */
function mensagens(lido: { error?: { issues: { message: string }[] } }): string[] {
  return (lido.error?.issues ?? []).map((i) => i.message);
}

describe('corpoAtualizarRascunhoShopeeSchema — POST rascunho/atualizar', () => {
  it('PAR: `base` nomeia exatamente os campos de `patch` — em qualquer ordem de chaves', () => {
    const lido = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar(
        { marca: null, item_name: 'Camiseta' },
        { item_name: 'Camiseta Azul', marca: { brand_id: 77, original_brand_name: 'Acme' } },
      ),
    );
    expect(lido.base).toEqual({ marca: null, item_name: 'Camiseta' });
    expect(lido.patch).toEqual({
      item_name: 'Camiseta Azul',
      marca: { brand_id: 77, original_brand_name: 'Acme' },
    });
  });

  it('PAR (K1-12, P6): trocar category_id exige a base dos ATRIBUTOS que a troca apaga — com eles, aceito', () => {
    const lido = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar(
        { category_id: null, item_name: 'Camiseta', attributes: ATRIBUTOS },
        { item_name: 'Camiseta Azul', category_id: 100087 },
      ),
    );
    expect(lido.base).toEqual({ category_id: null, item_name: 'Camiseta', attributes: ATRIBUTOS });
    expect(lido.patch).toEqual({ item_name: 'Camiseta Azul', category_id: 100087 });
    // `attributes: null` IS a base (the operator saw none) — absent is not
    expect(
      corpoAtualizarRascunhoShopeeSchema.safeParse(
        atualizar({ category_id: 1, attributes: null }, { category_id: 2 }),
      ).success,
    ).toBe(true);
  });

  it('⛔ (K1-12, P6): trocar category_id SEM attributes na base é 400, com a frase própria', () => {
    for (const [base, patch] of [
      [{ category_id: 1 }, { category_id: 2 }],
      [{ category_id: 1 }, { category_id: null }],
      [
        { item_name: 'A', category_id: 1 },
        { item_name: 'B', category_id: 2 },
      ],
    ] as const) {
      const lido = corpoAtualizarRascunhoShopeeSchema.safeParse(atualizar(base, patch));
      expect(lido.success, JSON.stringify([base, patch])).toBe(false);
      expect(mensagens(lido)).toEqual([
        MSG_BASE_SEM_ATRIBUTOS_NA_TROCA_DE_CATEGORIA_RASCUNHO_SHOPEE,
      ]);
      expect(lido.error?.issues[0]?.path).toEqual(['base']);
    }
  });

  it('QUASE-PAR (K1-12, P6): o patch que traz os próprios attributes já os nomeia — nenhuma base extra', () => {
    expect(
      corpoAtualizarRascunhoShopeeSchema.safeParse(
        atualizar({ category_id: 1, attributes: ATRIBUTOS }, { category_id: 2, attributes: [] }),
      ).success,
    ).toBe(true);
    expect(
      corpoAtualizarRascunhoShopeeSchema.safeParse(
        atualizar({ attributes: null }, { attributes: ATRIBUTOS }),
      ).success,
    ).toBe(true);
  });

  it('⛔ QUASE-PAR (P6): attributes na base SEM troca de categoria e sem attributes no patch — campo a mais, 400', () => {
    const lido = corpoAtualizarRascunhoShopeeSchema.safeParse(
      atualizar({ item_name: 'A', attributes: null }, { item_name: 'B' }),
    );
    expect(lido.success).toBe(false);
    expect(mensagens(lido)).toEqual([MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE]);
  });

  it('(K1-12) o salvamento de atributos do operador B chegou; a troca de categoria de A com a base VELHA diverge em `attributes` ⟷ com a ATUAL, não', () => {
    // A opened the draft with no attributes; B then saved some.
    const guardadoDepoisDeB = camposDoRascunhoShopee({
      item_id: null,
      category_id: 100087,
      attributes: ATRIBUTOS,
    });
    const divergentes = (base: unknown): CampoRascunhoShopee[] => {
      const lido = corpoAtualizarRascunhoShopeeSchema.parse(
        atualizar(base, { category_id: 100030 }),
      );
      const vista = lido.base as unknown as Record<CampoRascunhoShopee, never>;
      const atual = guardadoDepoisDeB as unknown as Record<CampoRascunhoShopee, never>;
      return camposDaBaseDoRascunhoShopee(lido.patch).filter(
        (campo) => !mesmoValorDoRascunhoShopee(campo, atual[campo], vista[campo]),
      );
    };
    expect(divergentes({ category_id: 100087, attributes: null })).toEqual(['attributes']);
    expect(divergentes({ category_id: 100087, attributes: ATRIBUTOS })).toEqual([]);
  });

  it('`base` é VERBATIM e `patch` é NORMALIZADO, no mesmo corpo', () => {
    const lido = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar({ description: '' }, { description: '  ' }),
    );
    expect(lido.base).toEqual({ description: '' });
    expect(lido.patch).toEqual({ description: null });
  });

  it('⛔ `patch` vazio é 400 com a frase, no caminho `patch`', () => {
    const lido = corpoAtualizarRascunhoShopeeSchema.safeParse(atualizar({}, {}));
    expect(lido.success).toBe(false);
    expect(mensagens(lido)).toEqual([MSG_PATCH_VAZIO_RASCUNHO_SHOPEE]);
    expect(lido.error?.issues[0]?.path).toEqual(['patch']);
  });

  it('⛔ `base` com um campo A MAIS, A MENOS ou OUTRO é 400 com a frase, no caminho `base`', () => {
    for (const [base, patch] of [
      [{ item_name: 'A', description: null }, { item_name: 'B' }],
      [{ item_name: 'A' }, { item_name: 'B', description: 'x' }],
      [{ description: null }, { item_name: 'B' }],
      [{}, { item_name: 'B' }],
    ] as const) {
      const lido = corpoAtualizarRascunhoShopeeSchema.safeParse(atualizar(base, patch));
      expect(lido.success, JSON.stringify([base, patch])).toBe(false);
      expect(mensagens(lido)).toEqual([MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE]);
      expect(lido.error?.issues[0]?.path).toEqual(['base']);
    }
  });

  it('PAR (K2-4): um rascunho legado SEM item_name aceita `base: {item_name: null}` e a edição do título', () => {
    const legado: Record<string, unknown> = { item_id: null, contaProdutoShopeeOuterRef: REF };
    const lido = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar({ item_name: null }, { item_name: 'Camiseta' }),
    );
    expect(
      mesmoValorDoRascunhoShopee(
        C.itemName,
        camposDoRascunhoShopee(legado).item_name,
        lido.base.item_name,
      ),
    ).toBe(true);
  });

  it('PAR/QUASE-PAR (K2-4): `description: ""` legado contra base "" ⇒ sem conflito; contra base `null` ⇒ conflito', () => {
    const guardado = camposDoRascunhoShopee({ item_id: null, description: '' });
    const comVazio = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar({ description: '' }, { description: 'Algodão' }),
    );
    const comNulo = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar({ description: null }, { description: 'Algodão' }),
    );
    expect(
      mesmoValorDoRascunhoShopee(C.description, guardado.description, comVazio.base.description),
    ).toBe(true);
    expect(
      mesmoValorDoRascunhoShopee(C.description, guardado.description, comNulo.base.description),
    ).toBe(false);
  });

  it('o id de um rascunho EXISTENTE só precisa ser um id de documento (o legado vem como veio)', () => {
    expect(
      corpoAtualizarRascunhoShopeeSchema.safeParse({
        ...IDS,
        linkDocId: 'rascunho-legado-1',
        base: { item_name: 'A' },
        patch: { item_name: 'B' },
      }).success,
    ).toBe(true);
    for (const ruim of ['', 'a/b', '..']) {
      expect(
        corpoAtualizarRascunhoShopeeSchema.safeParse({
          ...IDS,
          linkDocId: ruim,
          base: { item_name: 'A' },
          patch: { item_name: 'B' },
        }).success,
        ruim,
      ).toBe(false);
    }
  });

  it('⛔ estrito: uma chave desconhecida no corpo é 400, nunca descartada em silêncio', () => {
    const valido = atualizar({ item_name: 'A' }, { item_name: 'B' }) as Record<string, unknown>;
    expect(corpoAtualizarRascunhoShopeeSchema.safeParse(valido).success).toBe(true);
    for (const extra of [
      { conteudo: { item_name: 'B' } },
      { confirmarSegundoAnuncio: true },
      { item_name: 'B' },
    ]) {
      expect(
        corpoAtualizarRascunhoShopeeSchema.safeParse({ ...valido, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('⛔ o patch passa pela whitelist: item_id, o RESERVADO, atributos na forma de LEITURA ou um título em branco são 400', () => {
    for (const [base, patch] of [
      [{}, { item_id: 2500139861 }],
      [{ logistic_info: null }, { logistic_info: [] }],
      [
        { attributes: null },
        {
          attributes: [
            {
              attribute_id: 1,
              attribute_value_list: [{ value_id: 5, original_value_name: 'X', value_unit: null }],
            },
          ],
        },
      ],
      [{ item_name: 'A' }, { item_name: '  ' }],
    ] as const) {
      expect(
        corpoAtualizarRascunhoShopeeSchema.safeParse(atualizar(base, patch)).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                          (16) the discard body                              */
/* -------------------------------------------------------------------------- */

describe('corpoDescartarRascunhoShopeeSchema — POST rascunho/descartar (K1-13, K1-6)', () => {
  const corpo = { ...IDS, linkDocId: ID_RASCUNHO, base: BASE_COMPLETA };

  it('PAR: a base COMPLETA, com e sem a atestação', () => {
    expect(corpoDescartarRascunhoShopeeSchema.parse(corpo)).toEqual(corpo);
    for (const atesta of [true, false, null]) {
      expect(
        corpoDescartarRascunhoShopeeSchema.parse({ ...corpo, confirmarCriacaoIncerta: atesta })
          .confirmarCriacaoIncerta,
      ).toBe(atesta);
    }
  });

  it('⛔ a base precisa trazer TODO campo projetado — faltar um é 400', () => {
    for (const campo of Object.keys(BASE_COMPLETA)) {
      const { [campo]: _fora, ...incompleta } = BASE_COMPLETA as Record<string, unknown>;
      expect(
        corpoDescartarRascunhoShopeeSchema.safeParse({ ...corpo, base: incompleta }).success,
        campo,
      ).toBe(false);
    }
    expect(corpoDescartarRascunhoShopeeSchema.safeParse({ ...corpo, base: {} }).success).toBe(
      false,
    );
  });

  it('⛔ base com RESERVADO ou chave desconhecida, atestação não booleana, corpo sem base: 400', () => {
    for (const ruim of [
      { ...corpo, base: { ...BASE_COMPLETA, logistic_info: null } },
      { ...corpo, base: { ...BASE_COMPLETA, foo: 1 } },
      { ...corpo, confirmarCriacaoIncerta: 'sim' },
      { ...IDS, linkDocId: ID_RASCUNHO },
      { ...corpo, patch: {} },
    ]) {
      expect(corpoDescartarRascunhoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });

  it('a corrida (K1-13): uma edição feita depois do que o operador viu aparece na comparação', () => {
    const visto = camposDoRascunhoShopee({ item_id: null, item_name: 'Camiseta', brand_id: 0 });
    const { base } = corpoDescartarRascunhoShopeeSchema.parse({ ...corpo, base: visto });
    const depois = camposDoRascunhoShopee({ item_id: null, item_name: 'Camiseta 2', brand_id: 0 });
    const diferentes = camposPresentesDoRascunhoShopee(base).filter(
      (campo) =>
        !mesmoValorDoRascunhoShopee(
          campo,
          (depois as unknown as Record<CampoRascunhoShopee, never>)[campo],
          (base as unknown as Record<CampoRascunhoShopee, never>)[campo],
        ),
    );
    expect(diferentes).toEqual(['item_name']);
  });

  it('a corrida (K1-13, P6): um salvamento de ATRIBUTOS feito depois do que o operador viu também aparece', () => {
    const visto = camposDoRascunhoShopee({ item_id: null, item_name: 'Camiseta', brand_id: 0 });
    const { base } = corpoDescartarRascunhoShopeeSchema.parse({ ...corpo, base: visto });
    const depois = camposDoRascunhoShopee({
      item_id: null,
      item_name: 'Camiseta',
      brand_id: 0,
      attributes: ATRIBUTOS,
    });
    const diferentes = camposPresentesDoRascunhoShopee(base).filter(
      (campo) =>
        !mesmoValorDoRascunhoShopee(
          campo,
          (depois as unknown as Record<CampoRascunhoShopee, never>)[campo],
          (base as unknown as Record<CampoRascunhoShopee, never>)[campo],
        ),
    );
    expect(diferentes).toEqual(['attributes']);
  });
});

/* -------------------------------------------------------------------------- */
/*                    (17) the create retry compare (K1-9)                     */
/* -------------------------------------------------------------------------- */

describe('a repetição de uma criação (K1-9) — o mesmo conteúdo ⟷ outro conteúdo', () => {
  const primeiro = conteudoRascunhoShopeeSchema.parse({
    item_name: 'Camiseta',
    description: '   ',
    marca: { brand_id: 0, original_brand_name: 'No Brand' },
  });
  const guardado = camposDoRascunhoShopee(gravado(primeiro));

  it('PAR: a repetição IDÊNTICA (normalizada) é igual ao que foi guardado', () => {
    const repeticao = conteudoRascunhoShopeeSchema.parse({
      item_name: 'Camiseta',
      description: '',
      marca: { brand_id: 0, original_brand_name: null },
    });
    expect(todosIguais(guardado, repeticao)).toBe(true);
  });

  it('⛔ NEAR-MISS: a repetição com o item_name mudado NÃO é igual', () => {
    const repeticao = conteudoRascunhoShopeeSchema.parse({
      item_name: 'Camiseta Azul',
      description: '',
      marca: { brand_id: 0, original_brand_name: null },
    });
    expect(todosIguais(guardado, repeticao)).toBe(false);
  });

  it('PAR/QUASE-PAR (P6): a repetição com os MESMOS atributos (nome com espaço normalizado) é igual ⟷ com outro valor, não', () => {
    const comAtributos = conteudoRascunhoShopeeSchema.parse({
      item_name: 'Camiseta',
      attributes: ATRIBUTOS,
    });
    const guardadoComAtributos = camposDoRascunhoShopee(gravado(comAtributos));
    const mesma = conteudoRascunhoShopeeSchema.parse({
      item_name: 'Camiseta',
      attributes: [
        ATRIBUTOS[0],
        {
          attribute_id: 11,
          attribute_value_list: [{ value_id: 0, original_value_name: ' Algodão ', value_unit: '' }],
        },
        ATRIBUTOS[2],
      ],
    });
    expect(todosIguais(guardadoComAtributos, mesma)).toBe(true);
    const outra = conteudoRascunhoShopeeSchema.parse({
      item_name: 'Camiseta',
      attributes: [{ attribute_id: 10, attribute_value_list: [{ value_id: 56 }] }],
    });
    expect(todosIguais(guardadoComAtributos, outra)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                       (18) the answers and the 409 item                     */
/* -------------------------------------------------------------------------- */

describe('as respostas da rota e o item de `conflitos[]`', () => {
  it('criar: `criado` booleano; atualizar: `gravados` do vocabulário; descartar: `descartado: true`', () => {
    expect(
      respostaCriarRascunhoShopeeSchema.parse({ linkDocId: ID_RASCUNHO, criado: false }),
    ).toEqual({ linkDocId: ID_RASCUNHO, criado: false });
    expect(
      respostaAtualizarRascunhoShopeeSchema.parse({
        linkDocId: ID_RASCUNHO,
        gravados: [C.itemName, C.marca],
      }),
    ).toEqual({ linkDocId: ID_RASCUNHO, gravados: ['item_name', 'marca'] });
    expect(
      respostaAtualizarRascunhoShopeeSchema.parse({ linkDocId: ID_RASCUNHO, gravados: [] })
        .gravados,
    ).toEqual([]);
    expect(
      respostaDescartarRascunhoShopeeSchema.parse({
        linkDocId: ID_RASCUNHO,
        descartado: true,
        criacaoIncerta: true,
      }),
    ).toEqual({ linkDocId: ID_RASCUNHO, descartado: true, criacaoIncerta: true });
  });

  it('⛔ campo fora do vocabulário, `descartado: false` e linkDocId vazio são recusados', () => {
    expect(
      respostaAtualizarRascunhoShopeeSchema.safeParse({
        linkDocId: ID_RASCUNHO,
        gravados: ['brand_id'],
      }).success,
    ).toBe(false);
    expect(
      respostaDescartarRascunhoShopeeSchema.safeParse({
        linkDocId: ID_RASCUNHO,
        descartado: false,
        criacaoIncerta: false,
      }).success,
    ).toBe(false);
    expect(
      respostaCriarRascunhoShopeeSchema.safeParse({ linkDocId: '', criado: true }).success,
    ).toBe(false);
  });

  it('conflito: o campo e o valor guardado AGORA, na forma da projeção (qualquer valor)', () => {
    for (const atual of [
      null,
      '',
      'Camiseta',
      100087,
      { brand_id: 0, original_brand_name: null },
    ]) {
      expect(conflitoRascunhoShopeeSchema.parse({ campo: C.marca, atual })).toEqual({
        campo: 'marca',
        atual,
      });
    }
    expect(conflitoRascunhoShopeeSchema.parse({ campo: C.itemName, atual: 'x', extra: 1 })).toEqual(
      { campo: 'item_name', atual: 'x' },
    );
    expect(conflitoRascunhoShopeeSchema.safeParse({ campo: 'brand_id', atual: 77 }).success).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                         (6) the text of the file                            */
/* -------------------------------------------------------------------------- */

describe('shopeeRascunho.ts — o texto do arquivo', () => {
  const FONTE = readFileSync(join(import.meta.dirname, 'shopeeRascunho.ts'), 'utf8');

  it('é puro: nenhum relógio, nenhuma transação, nenhum carimbo em microssegundos', () => {
    // O relógio é o da ROTA e chega como parâmetro; o inventário de transações
    // (`config-eslint`) grepa TEXTO CRU, comentários inclusive.
    for (const proibido of ['Date.now(', 'new Date(', 'runTransaction', 'µs', 'firebase']) {
      expect(FONTE, proibido).not.toContain(proibido);
    }
    expect(FONTE).toContain('MILLISECONDS');
  });

  it('(K2-5) a comparação estrutural é a do repo (`valuesEqual`), nunca uma cópia privada nem o helper do inventário de dobras', () => {
    expect(FONTE).toContain("import { valuesEqual } from '@delfrance/core/equality';");
    // `deepEqual` is in the fold inventory's PATTERN: spelling it here — even in
    // a comment — would demand an inventory entry for a helper this file does
    // not use (and `valuesEqual` must NOT get one: the stale-entry test).
    expect(FONTE).not.toMatch(/\bdeepEqual\b/);
    expect(FONTE).not.toContain('JSON.stringify');
  });
});

/* -------------------------------------------------------------------------- */
/*            (N) respostaItemIncertoShopeeSchema — the publish's 202 (P5)     */
/* -------------------------------------------------------------------------- */

describe('respostaItemIncertoShopeeSchema — o 202 do item incerto (§2.1, K1-5)', () => {
  const VALIDO = {
    arma: 'item',
    desfecho: 'incerto',
    linkDocId: 'AbCdEfGhIjKlMnOpQrSt',
    aguardarMs: AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
    reenvioVerificaSku: true,
    recusa: { codigo: 'error_inner', fraseShopee: 'the system is taking some time to respond' },
  } as const;

  it('PAR: com a recusa da Shopee, com `fraseShopee` nula e sem recusa (nenhuma resposta chegou)', () => {
    expect(respostaItemIncertoShopeeSchema.parse(VALIDO)).toEqual(VALIDO);
    expect(
      respostaItemIncertoShopeeSchema.parse({
        ...VALIDO,
        recusa: { codigo: 'error_server', fraseShopee: null },
      }).recusa,
    ).toEqual({ codigo: 'error_server', fraseShopee: null });
    expect(
      respostaItemIncertoShopeeSchema.parse({ ...VALIDO, recusa: null, reenvioVerificaSku: false }),
    ).toEqual({ ...VALIDO, recusa: null, reenvioVerificaSku: false });
  });

  it('⚠️ `mensagem` (o texto do CLI) é enviada e NÃO declarada: o parse a descarta, e chaves a mais também', () => {
    const lido = respostaItemIncertoShopeeSchema.parse({
      ...VALIDO,
      mensagem: 'A Shopee pode ter criado o anúncio — aguarde e publique de novo.',
      itemId: null,
      recusa: { ...VALIDO.recusa, motivo: 'x' },
    }) as Record<string, unknown>;
    expect(lido).not.toHaveProperty('mensagem');
    expect(lido).not.toHaveProperty('itemId');
    expect(lido.recusa).toEqual(VALIDO.recusa);
  });

  it('⛔ NEAR-MISS (K1-5): `linkDocId` nulo ou vazio é recusado — a criação sem vínculo cunha um rascunho antes', () => {
    for (const linkDocId of [null, '', undefined, 7]) {
      expect(
        respostaItemIncertoShopeeSchema.safeParse({ ...VALIDO, linkDocId }).success,
        String(linkDocId),
      ).toBe(false);
    }
  });

  it('⛔ NEAR-MISS: `aguardarMs` precisa ser um inteiro > 0 (0, negativo, fracionário, texto, ausente)', () => {
    for (const aguardarMs of [0, -1, 1.5, '240000', null, undefined]) {
      expect(
        respostaItemIncertoShopeeSchema.safeParse({ ...VALIDO, aguardarMs }).success,
        String(aguardarMs),
      ).toBe(false);
    }
    expect(respostaItemIncertoShopeeSchema.safeParse({ ...VALIDO, aguardarMs: 1 }).success).toBe(
      true,
    );
  });

  it('⛔ NEAR-MISS: a etiqueta é EXATA — um braço de kit, outro desfecho ou a etiqueta ausente não são este 202', () => {
    for (const ruim of [
      { ...VALIDO, arma: 'kit-criar' },
      { ...VALIDO, arma: 'Item' },
      { ...VALIDO, desfecho: 'criado' },
      { ...VALIDO, desfecho: 'nao-criado' },
      { ...VALIDO, arma: undefined },
      { ...VALIDO, desfecho: undefined },
    ]) {
      expect(respostaItemIncertoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });

  it('⛔ NEAR-MISS: `reenvioVerificaSku` é um booleano obrigatório; `recusa` é anulável, nunca opcional', () => {
    for (const ruim of [
      { ...VALIDO, reenvioVerificaSku: undefined },
      { ...VALIDO, reenvioVerificaSku: 'true' },
      { ...VALIDO, reenvioVerificaSku: null },
      { ...VALIDO, recusa: undefined },
      { ...VALIDO, recusa: { codigo: 'error_server' } },
      { ...VALIDO, recusa: { fraseShopee: null } },
      { ...VALIDO, recusa: { codigo: 5, fraseShopee: null } },
      { ...VALIDO, recusa: 'error_server' },
    ]) {
      expect(respostaItemIncertoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });

  it('⛔ o 202 do KIT e o 200 do item NÃO passam por este envelope (cada braço tem a sua etiqueta)', () => {
    const kitIncerto = {
      arma: 'kit-criar',
      desfecho: 'incerto',
      itemId: null,
      linkDocId: null,
      aguardarMs: AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
      recusa: null,
    };
    const item200 = { itemId: 2500139861, estadoAnuncio: 'ativo', itemStatus: 'NORMAL' };
    expect(respostaItemIncertoShopeeSchema.safeParse(kitIncerto).success).toBe(false);
    expect(respostaItemIncertoShopeeSchema.safeParse(item200).success).toBe(false);
  });
});
