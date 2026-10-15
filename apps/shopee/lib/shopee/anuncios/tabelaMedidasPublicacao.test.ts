import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type Foto, MOTIVO_SEM_TABELA_SHOPEE, lerEntradasShopeeDaConta } from '@delfrance/schemas';

import type { LimitesDeItemDto } from '../taxonomia/limites';
import type { LeituraTabelaDeMedidasShopee } from './lerTabelaMedidasDoProduto';
import {
  FONTE_TABELA_MEDIDAS,
  FOTO_TABELA_MEDIDAS_OMITIDA,
  MOTIVO_TABELA_MEDIDAS_OMITIDA,
  type MotivoTabelaMedidasOmitida,
  type ResultadoTabelaDeMedidasShopee,
  resolverTabelaDeMedidasDoAnuncio,
} from './tabelaMedidasPublicacao';

/* ---------------------------------- fixtures ------------------------------ */

const CONTA = 'int-1';
const TAB_ID = 'tab-1';
/** Ids de AMOSTRA da doc da Shopee — nunca de uma loja real. */
const CATEGORIA = 400055;
const MODELO = 700024641;

const FOTO_1: Foto = {
  arquivoOuterRef: 'arquivos/tab-1_aaa',
  arquivo200pxOuterRef: null,
  arquivo400pxOuterRef: null,
  arquivoJpegOuterRef: null,
  grupoDeVariacoesOuterRef: null,
  variantePath: null,
};

type Limite = LimitesDeItemDto['sizeChartLimit'];

function limite(
  obrigatoria: boolean | null,
  suportaFoto: boolean | null = null,
  suportaModelo: boolean | null = null,
): Limite {
  return {
    sizeChartMandatory: obrigatoria,
    supportImageSizeChart: suportaFoto,
    supportTemplateSizeChart: suportaModelo,
  };
}

/** A tabela LIDA, montada pela fatia REAL do schemas a partir do mapa cru. */
function lida(
  lista: unknown,
  primeiraFoto: Foto | null = null,
  mapaExtra: Record<string, unknown> = {},
): LeituraTabelaDeMedidasShopee {
  return {
    tipo: 'lida',
    tabMediId: TAB_ID,
    leitura: lerEntradasShopeeDaConta({ ...mapaExtra, [CONTA]: lista }, CONTA),
    primeiraFoto,
  };
}

function entrada(categoryId: number, sizeChartId: number, name = 'Camisetas') {
  return { categoryId, size_chart_id: sizeChartId, name };
}

function decidir(
  leitura: LeituraTabelaDeMedidasShopee,
  categoryId: number | null = CATEGORIA,
  sizeChartLimit: Limite = null,
): ResultadoTabelaDeMedidasShopee {
  return resolverTabelaDeMedidasDoAnuncio(leitura, categoryId, sizeChartLimit);
}

/* -------------------------------------------------------------------------- */
/*          (1) o produtor de cada motivo, e a precedência (o pino O7)         */
/* -------------------------------------------------------------------------- */

describe('cada motivo tem um caminho que o produz — e a precedência', () => {
  const casos: readonly {
    readonly rotulo: string;
    readonly leitura: LeituraTabelaDeMedidasShopee;
    readonly categoryId: number | null;
    readonly motivo: MotivoTabelaMedidasOmitida | null;
  }[] = [
    {
      rotulo: 'produto-sem-tabela',
      leitura: { tipo: 'produto-sem-tabela' },
      categoryId: CATEGORIA,
      motivo: MOTIVO_TABELA_MEDIDAS_OMITIDA.produtoSemTabela,
    },
    {
      rotulo: 'tabela-inexistente (ref inutilizável)',
      leitura: { tipo: 'tabela-inexistente', tabMediId: null },
      categoryId: CATEGORIA,
      motivo: MOTIVO_TABELA_MEDIDAS_OMITIDA.tabelaInexistente,
    },
    {
      rotulo: 'tabela-inexistente (documento ausente)',
      leitura: { tipo: 'tabela-inexistente', tabMediId: TAB_ID },
      categoryId: CATEGORIA,
      motivo: MOTIVO_TABELA_MEDIDAS_OMITIDA.tabelaInexistente,
    },
    {
      // M8 do schemas, aqui pela composição: a categoria nula vence uma entrada válida.
      rotulo: 'anuncio-sem-categoria',
      leitura: lida([entrada(CATEGORIA, MODELO)]),
      categoryId: null,
      motivo: MOTIVO_TABELA_MEDIDAS_OMITIDA.anuncioSemCategoria,
    },
    {
      rotulo: 'conta-sem-entradas (só ilegíveis)',
      leitura: lida([{ categoryId: String(CATEGORIA), size_chart_id: MODELO, name: 'x' }]),
      categoryId: CATEGORIA,
      motivo: MOTIVO_TABELA_MEDIDAS_OMITIDA.contaSemEntradas,
    },
    {
      // ⛔ QUASE-PAR ±1 na categoria.
      rotulo: 'categoria-sem-entrada',
      leitura: lida([entrada(CATEGORIA + 1, MODELO)]),
      categoryId: CATEGORIA,
      motivo: MOTIVO_TABELA_MEDIDAS_OMITIDA.categoriaSemEntrada,
    },
    {
      rotulo: 'anexado',
      leitura: lida([entrada(CATEGORIA, MODELO)]),
      categoryId: CATEGORIA,
      motivo: null,
    },
  ];

  it.each(casos)('$rotulo', ({ leitura, categoryId, motivo }) => {
    const r = decidir(leitura, categoryId);
    expect(r.motivo).toBe(motivo);
    // A invariante, linha a linha: sizeChartId não-nulo ⇔ modelo ⇔ motivo nulo.
    expect(r.sizeChartId !== null).toBe(motivo === null);
    expect(r.fonte.tipo === FONTE_TABELA_MEDIDAS.modelo).toBe(motivo === null);
  });

  it('a tabela cobre TODO membro do vocabulário — um motivo sem caminho seria uma promessa vazia', () => {
    const produzidos = new Set(casos.map((c) => c.motivo).filter((m) => m !== null));
    expect([...produzidos].sort()).toEqual(
      [...Object.values(MOTIVO_TABELA_MEDIDAS_OMITIDA)].sort(),
    );
    // E os três do schemas são ESPALHADOS, nunca redigitados.
    for (const m of Object.values(MOTIVO_SEM_TABELA_SHOPEE)) {
      expect(Object.values(MOTIVO_TABELA_MEDIDAS_OMITIDA)).toContain(m);
    }
    expect(Object.keys(MOTIVO_TABELA_MEDIDAS_OMITIDA)).toHaveLength(5);
  });

  it('o tabMediId acompanha a leitura: null sem tabela, o id quando lida ou ausente', () => {
    expect(decidir({ tipo: 'produto-sem-tabela' }).tabMediId).toBeNull();
    expect(decidir({ tipo: 'tabela-inexistente', tabMediId: null }).tabMediId).toBeNull();
    expect(decidir({ tipo: 'tabela-inexistente', tabMediId: TAB_ID }).tabMediId).toBe(TAB_ID);
    expect(decidir(lida([])).tabMediId).toBe(TAB_ID);
  });
});

/* -------------------------------------------------------------------------- */
/*                  (2) o modelo — a regra ÚNICA de seleção                    */
/* -------------------------------------------------------------------------- */

describe('o modelo', () => {
  it('M-A1 — uma entrada que casa VENCE a foto: fonte modelo, a foto nem é citada', () => {
    const r = decidir(lida([entrada(CATEGORIA, MODELO)], FOTO_1));
    expect(r.fonte).toStrictEqual({ tipo: FONTE_TABELA_MEDIDAS.modelo, sizeChartId: MODELO });
    expect(r.sizeChartId).toBe(MODELO);
    expect(r.motivo).toBeNull();
    expect(r.fotoOmitida).toBeNull();
  });

  it('a PRIMEIRA entrada da categoria vence uma duplicada — o id da primeira, nunca o da segunda (RT8)', () => {
    const r = decidir(
      lida([entrada(CATEGORIA, MODELO), entrada(CATEGORIA, MODELO + 1)], null, {
        // Outra conta com a chave null no MESMO mapa (o corpus pode ter).
        'int-10': null,
      }),
    );
    expect(r.sizeChartId).toBe(MODELO);
  });

  it('⛔ QUASE-PARES da seleção: o mesmo size_chart_id noutra categoria e um `name` igual à categoria NÃO casam', () => {
    const r = decidir(
      lida([entrada(CATEGORIA + 1, MODELO), entrada(CATEGORIA - 1, MODELO + 7, String(CATEGORIA))]),
    );
    expect(r.motivo).toBe(MOTIVO_TABELA_MEDIDAS_OMITIDA.categoriaSemEntrada);
    expect(r.sizeChartId).toBeNull();
  });

  it('M72 (metade pura) — decide pela categoria RECEBIDA: entrada para 100, anúncio em 200 ⇒ nada anexado', () => {
    const leitura = lida([entrada(100, MODELO)]);
    expect(decidir(leitura, 200).sizeChartId).toBeNull();
    expect(decidir(leitura, 100).sizeChartId).toBe(MODELO);
  });

  it('L7 — `support_template_size_chart: false` NÃO impede o modelo que o operador escolheu', () => {
    const r = decidir(lida([entrada(CATEGORIA, MODELO)]), CATEGORIA, limite(true, false, false));
    expect(r.fonte.tipo).toBe(FONTE_TABELA_MEDIDAS.modelo);
    expect(r.suportaModelo).toBe(false);
    expect(r.suportaFoto).toBe(false);
    expect(r.avisoObrigatoria).toBe(false);
  });

  it('as contagens: legíveis desta conta (qualquer categoria) e ilegíveis', () => {
    const r = decidir(
      lida([
        entrada(CATEGORIA + 1, MODELO),
        null,
        entrada(CATEGORIA, MODELO + 1),
        { size_chart_id: 1 },
      ]),
    );
    expect(r.entradasNestaConta).toBe(2);
    expect(r.ilegiveis).toBe(2);
    expect(r.sizeChartId).toBe(MODELO + 1);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (3) a foto — o fallback do legado (A.1)                     */
/* -------------------------------------------------------------------------- */

describe('a foto da tabela', () => {
  it('M-A2 — sem entrada que case, a PRIMEIRA foto vira a fonte — o mesmo objeto, e o motivo diz do que caiu', () => {
    for (const lista of [[], [entrada(CATEGORIA + 1, MODELO)], [null], null]) {
      const r = decidir(lida(lista, FOTO_1));
      expect(r.fonte.tipo, JSON.stringify(lista)).toBe(FONTE_TABELA_MEDIDAS.foto);
      if (r.fonte.tipo !== 'foto') throw new Error('inalcançável');
      expect(r.fonte.foto).toBe(FOTO_1);
      expect(r.sizeChartId).toBeNull();
      expect(r.motivo).not.toBeNull();
      expect(r.fotoOmitida).toBeNull();
    }
  });

  it('sem primeira foto utilizável ⇒ nenhuma, `sem-fotos`', () => {
    const r = decidir(lida([entrada(CATEGORIA + 1, MODELO)], null));
    expect(r.fonte).toStrictEqual({ tipo: FONTE_TABELA_MEDIDAS.nenhuma });
    expect(r.fotoOmitida).toBe(FOTO_TABELA_MEDIDAS_OMITIDA.semFotos);
  });

  it('M-A4 — `support_image_size_chart: false` EXPLÍCITO retém a foto; `null` e `true` a mandam', () => {
    const sem = decidir(lida([], FOTO_1), CATEGORIA, limite(null, false));
    expect(sem.fonte).toStrictEqual({ tipo: FONTE_TABELA_MEDIDAS.nenhuma });
    expect(sem.fotoOmitida).toBe(FOTO_TABELA_MEDIDAS_OMITIDA.categoriaSemFoto);

    for (const suportaFoto of [null, true]) {
      const com = decidir(lida([], FOTO_1), CATEGORIA, limite(null, suportaFoto));
      expect(com.fonte.tipo, String(suportaFoto)).toBe(FONTE_TABELA_MEDIDAS.foto);
      expect(com.fotoOmitida, String(suportaFoto)).toBeNull();
    }
    // E o bloco AUSENTE inteiro (`null`) é "não sei" — manda.
    expect(decidir(lida([], FOTO_1), CATEGORIA, null).fonte.tipo).toBe(FONTE_TABELA_MEDIDAS.foto);
  });

  it('sem fotos E categoria sem foto ⇒ `sem-fotos` (não há foto a reter)', () => {
    const r = decidir(lida([], null), CATEGORIA, limite(null, false));
    expect(r.fotoOmitida).toBe(FOTO_TABELA_MEDIDAS_OMITIDA.semFotos);
  });

  it('⛔ sem TABELA não há passo da foto: produto-sem-tabela e tabela-inexistente dão fotoOmitida null', () => {
    for (const leitura of [
      { tipo: 'produto-sem-tabela' },
      { tipo: 'tabela-inexistente', tabMediId: TAB_ID },
    ] satisfies readonly LeituraTabelaDeMedidasShopee[]) {
      const r = decidir(leitura, CATEGORIA, limite(true, false));
      expect(r.fonte.tipo, leitura.tipo).toBe(FONTE_TABELA_MEDIDAS.nenhuma);
      expect(r.fotoOmitida, leitura.tipo).toBeNull();
      expect(r.entradasNestaConta).toBe(0);
      expect(r.ilegiveis).toBe(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*            (4) `size_chart_limit` — conselho, e o aviso não bloqueia        */
/* -------------------------------------------------------------------------- */

describe('o aviso de obrigatória (M74: um aviso, nunca uma recusa)', () => {
  const fontes: readonly (readonly [string, () => LeituraTabelaDeMedidasShopee, string])[] = [
    ['modelo', () => lida([entrada(CATEGORIA, MODELO)], FOTO_1), FONTE_TABELA_MEDIDAS.modelo],
    ['foto', () => lida([], FOTO_1), FONTE_TABELA_MEDIDAS.foto],
    ['nenhuma (sem fotos)', () => lida([], null), FONTE_TABELA_MEDIDAS.nenhuma],
    ['nenhuma (sem tabela)', () => ({ tipo: 'produto-sem-tabela' }), FONTE_TABELA_MEDIDAS.nenhuma],
  ];

  it.each(
    fontes.flatMap(([rotulo, leitura, fonte]) =>
      [true, false, null].map((obrigatoria) => ({ rotulo, leitura, fonte, obrigatoria })),
    ),
  )('obrigatória=$obrigatoria × $rotulo', ({ leitura, fonte, obrigatoria }) => {
    const r = decidir(leitura(), CATEGORIA, limite(obrigatoria));
    expect(r.fonte.tipo).toBe(fonte);
    expect(r.obrigatoria).toBe(obrigatoria);
    // SÓ `true` × nada enviado avisa; `null` (não sei) nunca.
    expect(r.avisoObrigatoria).toBe(obrigatoria === true && fonte === FONTE_TABELA_MEDIDAS.nenhuma);
  });

  it('a foto RETIDA pela categoria também conta como "nada enviado" para o aviso', () => {
    const r = decidir(lida([], FOTO_1), CATEGORIA, limite(true, false));
    expect(r.fotoOmitida).toBe(FOTO_TABELA_MEDIDAS_OMITIDA.categoriaSemFoto);
    expect(r.avisoObrigatoria).toBe(true);
  });

  it('as três bandas saem verbatim do bloco, e um bloco ausente dá três null', () => {
    expect(decidir(lida([]), CATEGORIA, limite(true, false, true))).toMatchObject({
      obrigatoria: true,
      suportaFoto: false,
      suportaModelo: true,
    });
    expect(decidir(lida([]), CATEGORIA, null)).toMatchObject({
      obrigatoria: null,
      suportaFoto: null,
      suportaModelo: null,
      avisoObrigatoria: false,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         (5) as chaves e a disciplina                        */
/* -------------------------------------------------------------------------- */

describe('a forma e a disciplina', () => {
  it('o resultado tem EXATAMENTE as onze chaves do contrato', () => {
    expect(Object.keys(decidir(lida([entrada(CATEGORIA, MODELO)]))).sort()).toEqual(
      [
        'avisoObrigatoria',
        'entradasNestaConta',
        'fonte',
        'fotoOmitida',
        'ilegiveis',
        'motivo',
        'obrigatoria',
        'sizeChartId',
        'suportaFoto',
        'suportaModelo',
        'tabMediId',
      ].sort(),
    );
  });

  it('os vocabulários são kebab-case ASCII e as chaves casam em camelCase', () => {
    for (const vocab of [
      MOTIVO_TABELA_MEDIDAS_OMITIDA,
      FOTO_TABELA_MEDIDAS_OMITIDA,
      FONTE_TABELA_MEDIDAS,
    ]) {
      for (const [chave, slug] of Object.entries(vocab)) {
        expect(slug, slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
        expect(chave, slug).toBe(slug.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()));
      }
    }
  });

  const fonte = readFileSync(
    fileURLToPath(new URL('./tabelaMedidasPublicacao.ts', import.meta.url)),
    'utf8',
  );

  it('#1369 — UMA regra de seleção: chama `resolverEntradaShopee`, nunca compara categoryId por conta própria', () => {
    expect(fonte).toContain('resolverEntradaShopee(leitura.leitura, categoryId)');
    expect(fonte).not.toMatch(/categoryId\s*===/);
    expect(fonte).not.toContain('indiceDaEntradaShopee');
    expect(fonte).not.toMatch(/\.find\(|\.findIndex\(/);
  });

  it('puro: sem Firestore, sem Shopee, sem relógio, sem ambiente', () => {
    for (const proibido of [
      'firebase-admin',
      '@delfrance/data',
      '@delfrance/integrations-shopee',
      'Date.now',
      'process.env',
      'await ',
    ]) {
      expect(fonte, proibido).not.toContain(proibido);
    }
  });
});
