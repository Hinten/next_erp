/**
 * The product import's words (master plan step 9): every code the import's
 * answers carry, as the operator reads it in pt-BR. Pure: no React, no client.
 *
 * ## Two kinds of table
 *
 * - **Exhaustive** — one row per member of a shared enum
 *   (`importacaoLojaIntegrada.ts` in `@delfrance/schemas`), each written
 *   `as const satisfies Record<Enum, …>`: a member added to the contract stops
 *   this file compiling until it has copy here.
 * - **Total readers** for the fields the answers carry as PLAIN STRINGS — the
 *   phase, the failure's motivo, a report item's tipo, situação and ação, a
 *   pendência's code and a tax-review motivo. The contract keeps them open so a
 *   code a newer backend adds still parses in an older browser; the reader
 *   answers a known code with its copy and an unknown one with a generic label
 *   that SHOWS the raw code, so the operator can still quote it to support.
 *   "Known" is exact: the code is matched byte for byte through its schema,
 *   never trimmed or case-folded — a near miss is an unknown code, shown as such.
 *
 * ## Only paths that exist
 *
 * An actionable pendência's sentence says what to do, and only through a path
 * the app or the store offers TODAY: the variation linker (`/variacoes`), a
 * produto's own screen, the store's panel, or running the import again with
 * other options. No screen links an ERP category or produto to a store one by
 * hand, so a sentence that would need one sends the operator to support.
 *
 * ## Actionable or informational
 *
 * A pendência's class comes from the shared `ehPendenciaAcionavelLi` (the set
 * that keeps the summary aviso open), never from a second list here. For a
 * code this build does not know, the item's own stored `acionavel` flag — the
 * backend that wrote the code classified it — is the only source.
 */
import type { z } from 'zod';
import {
  ACAO_IMPORTACAO_LI,
  ACAO_ITEM_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  type AcaoImportacaoLi,
  type AcaoItemImportacaoLi,
  type AlvoImportacaoLi,
  CATEGORIAS_IMPORTACAO_LI,
  type CategoriasImportacaoLi,
  FASE_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  type FaseImportacaoLi,
  type FotosImportacaoLi,
  MODO_IMPORTACAO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  MOTIVO_FOTO_RECUSADA_LI,
  MOTIVO_REVISAO_FISCAL_LI,
  type ModoImportacaoLi,
  type MotivoFalhaImportacaoLi,
  type MotivoFotoRecusadaLi,
  type MotivoRevisaoFiscalLi,
  PENDENCIA_IMPORTACAO_LI,
  type PendenciaImportacaoLi,
  type RespostaImportacaoLi,
  SITUACAO_ERP_ITEM_LI,
  STATUS_IMPORTACAO_LI,
  type SituacaoErpItemLi,
  type StatusImportacaoLi,
  TIPO_PRODUTO_LI,
  type TipoProdutoLi,
  acaoItemImportacaoLiSchema,
  ehPendenciaAcionavelLi,
  faseImportacaoLiSchema,
  motivoFalhaImportacaoLiSchema,
  motivoFotoRecusadaLiSchema,
  motivoRevisaoFiscalLiSchema,
  pendenciaImportacaoLiSchema,
  situacaoErpItemLiSchema,
  tipoProdutoLiSchema,
} from '@delfrance/schemas';

/* -------------------------------------------------------------------------- */
/*                          The job: status, phase, motivo                     */
/* -------------------------------------------------------------------------- */

/** A Mantine colour name, which is what the card's `Badge` takes. */
export type CorStatusImportacaoLi = 'gray' | 'blue' | 'green' | 'red' | 'orange';

/** The job's status. `pendente` = created, waiting for its first dispatch. */
export const ROTULO_STATUS_IMPORTACAO_LI = {
  [STATUS_IMPORTACAO_LI.pendente]: 'Na fila',
  [STATUS_IMPORTACAO_LI.executando]: 'Em andamento',
  [STATUS_IMPORTACAO_LI.concluido]: 'Concluída',
  [STATUS_IMPORTACAO_LI.falhou]: 'Falhou',
  [STATUS_IMPORTACAO_LI.cancelado]: 'Cancelada',
} as const satisfies Record<StatusImportacaoLi, string>;

export const COR_STATUS_IMPORTACAO_LI = {
  [STATUS_IMPORTACAO_LI.pendente]: 'gray',
  [STATUS_IMPORTACAO_LI.executando]: 'blue',
  [STATUS_IMPORTACAO_LI.concluido]: 'green',
  [STATUS_IMPORTACAO_LI.falhou]: 'red',
  [STATUS_IMPORTACAO_LI.cancelado]: 'orange',
} as const satisfies Record<StatusImportacaoLi, CorStatusImportacaoLi>;

/** What a running job is doing, phase by phase (the schema's header lists the order). */
export const ROTULO_FASE_IMPORTACAO_LI = {
  [FASE_IMPORTACAO_LI.catalogo]: 'Lendo as categorias e as marcas da loja',
  [FASE_IMPORTACAO_LI.listagem]: 'Lendo a lista de produtos da loja',
  [FASE_IMPORTACAO_LI.lixeira]: 'Lendo a lixeira da loja',
  [FASE_IMPORTACAO_LI.orfaos]: 'Lendo as variações sem produto pai na lista',
  [FASE_IMPORTACAO_LI.evidencias]: 'Comparando as variações pelo SKU',
  [FASE_IMPORTACAO_LI.aprendizado]: 'Vinculando as opções de grade confirmadas pelo SKU',
  [FASE_IMPORTACAO_LI.familias]: 'Processando os produtos',
  [FASE_IMPORTACAO_LI.revisao]: 'Conferindo a lista de revisão fiscal',
  [FASE_IMPORTACAO_LI.fim]: 'Finalizando',
} as const satisfies Record<FaseImportacaoLi, string>;

/** Why a job ended `falhou`, saying what to do next. */
export const MENSAGEM_MOTIVO_FALHA_IMPORTACAO_LI = {
  [MOTIVO_FALHA_IMPORTACAO_LI.chamadasDesligadas]:
    'As chamadas à Loja Integrada estão desligadas neste backend: até a migração para este ' +
    'sistema, ou por configuração (se a migração já ocorreu, avise o suporte). Inicie a ' +
    'importação de novo quando elas estiverem ligadas.',
  [MOTIVO_FALHA_IMPORTACAO_LI.contaIndisponivel]:
    'A conta não pôde ser usada: ela foi removida ou está inativa, não tem token salvo, ou a ' +
    'Loja Integrada recusou o token. Confira a conta e inicie a importação de novo.',
  [MOTIVO_FALHA_IMPORTACAO_LI.tentativasEsgotadas]:
    'A importação falhou em todas as tentativas. Inicie de novo: o que já foi gravado não é ' +
    'duplicado.',
  [MOTIVO_FALHA_IMPORTACAO_LI.limiteDeChamadas]:
    'A Loja Integrada limitou as chamadas desta loja vezes demais seguidas. Inicie a ' +
    'importação de novo mais tarde.',
  [MOTIVO_FALHA_IMPORTACAO_LI.tarefasDesligadas]:
    'A fila de tarefas deste backend está desligada, e a importação não pôde continuar. Avise o ' +
    'suporte.',
  [MOTIVO_FALHA_IMPORTACAO_LI.catalogoExcedeLimite]:
    'A loja tem mais categorias ou marcas do que a importação consegue ler. Nada foi cortado: a ' +
    'importação parou. Avise o suporte.',
} as const satisfies Record<MotivoFalhaImportacaoLi, string>;

/* -------------------------------------------------------------------------- */
/*                               The start options                             */
/* -------------------------------------------------------------------------- */

export const ROTULO_MODO_IMPORTACAO_LI = {
  [MODO_IMPORTACAO_LI.simular]: 'Simular',
  [MODO_IMPORTACAO_LI.aplicar]: 'Importar',
} as const satisfies Record<ModoImportacaoLi, string>;

export const ROTULO_ALVO_IMPORTACAO_LI = {
  [ALVO_IMPORTACAO_LI.todos]: 'Todos',
  [ALVO_IMPORTACAO_LI.selecionados]: 'Selecionados',
  [ALVO_IMPORTACAO_LI.naoNoErp]: 'Só os que ainda não estão no ERP',
  [ALVO_IMPORTACAO_LI.jaNoErp]: 'Só os que já estão no ERP',
} as const satisfies Record<AlvoImportacaoLi, string>;

export const ROTULO_ACAO_IMPORTACAO_LI = {
  [ACAO_IMPORTACAO_LI.completar]: 'Completar',
  [ACAO_IMPORTACAO_LI.soVincular]: 'Só vincular',
} as const satisfies Record<AcaoImportacaoLi, string>;

export const ROTULO_CATEGORIAS_IMPORTACAO_LI = {
  [CATEGORIAS_IMPORTACAO_LI.criarEVincular]: 'Criar e vincular as que faltam',
  [CATEGORIAS_IMPORTACAO_LI.soVincular]: 'Usar só as já vinculadas',
} as const satisfies Record<CategoriasImportacaoLi, string>;

export const ROTULO_FOTOS_IMPORTACAO_LI = {
  [FOTOS_IMPORTACAO_LI.naoImportar]: 'Não importar',
  [FOTOS_IMPORTACAO_LI.soSemFotos]: 'Só em produtos sem foto',
} as const satisfies Record<FotosImportacaoLi, string>;

/* -------------------------------------------------------------------------- */
/*                                The report rows                              */
/* -------------------------------------------------------------------------- */

/** A store product's tipo as the report shows it. */
export const ROTULO_TIPO_PRODUTO_LI = {
  [TIPO_PRODUTO_LI.normal]: 'Simples',
  [TIPO_PRODUTO_LI.atributo]: 'Com variações',
  [TIPO_PRODUTO_LI.atributoOpcao]: 'Variação',
  [TIPO_PRODUTO_LI.desconhecido]: 'Tipo desconhecido',
} as const satisfies Record<TipoProdutoLi, string>;

/**
 * Where a store product stands against the ERP. `avulso` is a loose row (an
 * orphan variation, a variation of a trashed parent, a row of an unknown tipo):
 * informational, never matched against the ERP.
 */
export const ROTULO_SITUACAO_ERP_ITEM_LI = {
  [SITUACAO_ERP_ITEM_LI.vinculado]: 'Vinculado',
  [SITUACAO_ERP_ITEM_LI.encontrado]: 'Encontrado pelo SKU',
  [SITUACAO_ERP_ITEM_LI.ausente]: 'Não está no ERP',
  [SITUACAO_ERP_ITEM_LI.conflito]: 'Em conflito',
  [SITUACAO_ERP_ITEM_LI.naoListado]: 'Fora da lista da loja',
  [SITUACAO_ERP_ITEM_LI.avulso]: 'Linha avulsa',
} as const satisfies Record<SituacaoErpItemLi, string>;

/** An item's ação, as done (`aplicada`) or as a Simular says it would be done. */
export interface RotuloAcaoItemLi {
  readonly aplicada: string;
  readonly simulada: string;
}

export const ROTULO_ACAO_ITEM_IMPORTACAO_LI = {
  [ACAO_ITEM_IMPORTACAO_LI.vincular]: { aplicada: 'Vinculado', simulada: 'A vincular' },
  [ACAO_ITEM_IMPORTACAO_LI.criar]: { aplicada: 'Criado', simulada: 'A criar' },
  [ACAO_ITEM_IMPORTACAO_LI.completar]: { aplicada: 'Completado', simulada: 'A completar' },
  [ACAO_ITEM_IMPORTACAO_LI.nenhuma]: { aplicada: 'Nenhuma', simulada: 'Nenhuma' },
} as const satisfies Record<AcaoItemImportacaoLi, RotuloAcaoItemLi>;

/** One pendência's copy: a short label for the chip and a sentence saying what to do. */
export interface TextoPendenciaLi {
  readonly rotulo: string;
  readonly descricao: string;
}

/**
 * Every pendência code. The class (actionable or informational) is NOT here:
 * it is `ehPendenciaAcionavelLi`'s, read by {@link lerPendenciaLi}.
 */
export const TEXTO_PENDENCIA_IMPORTACAO_LI = {
  [PENDENCIA_IMPORTACAO_LI.semSku]: {
    rotulo: 'Sem SKU',
    descricao:
      'O produto da loja não tem SKU: não dá para encontrá-lo no ERP nem criá-lo. Preencha o SKU ' +
      'no painel da Loja Integrada.',
  },
  [PENDENCIA_IMPORTACAO_LI.skuAmbiguo]: {
    rotulo: 'SKU ambíguo no ERP',
    descricao: 'Mais de um produto do ERP tem este SKU. Deixe o SKU único no ERP.',
  },
  [PENDENCIA_IMPORTACAO_LI.skuParecido]: {
    rotulo: 'SKU parecido no ERP',
    descricao:
      'O ERP tem um SKU que difere deste só em maiúsculas e minúsculas ou em espaços nas pontas. ' +
      'Nada foi criado: iguale os SKUs no ERP ou na loja.',
  },
  [PENDENCIA_IMPORTACAO_LI.skuJaExiste]: {
    rotulo: 'SKU já existe no ERP',
    descricao:
      'Um SKU que a criação gravaria já existe em outro produto do ERP, então o produto não foi ' +
      'criado. Confira os produtos citados.',
  },
  [PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja]: {
    rotulo: 'SKU repetido na loja',
    descricao:
      'Outro produto da loja tem exatamente este SKU. Deixe o SKU único no painel da Loja ' +
      'Integrada.',
  },
  [PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja]: {
    rotulo: 'SKU parecido na loja',
    descricao:
      'Outro produto da loja tem um SKU que difere deste só em maiúsculas e minúsculas ou em ' +
      'espaços nas pontas, ou que coincide com o SKU "-UN" que o ERP daria a um produto simples. ' +
      'Este produto não foi criado nem vinculado pelo SKU: ajuste os SKUs no painel da Loja ' +
      'Integrada.',
  },
  [PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo]: {
    rotulo: 'Vínculo ambíguo',
    descricao:
      'Mais de um produto do ERP está vinculado a este produto da loja nesta conta, e nada foi ' +
      'escolhido. Avise o suporte para deixar um vínculo só.',
  },
  [PENDENCIA_IMPORTACAO_LI.vinculadoAOutro]: {
    rotulo: 'Vinculado a outro produto',
    descricao:
      'O produto do ERP encontrado já está vinculado a outro produto desta loja, e nada foi ' +
      'alterado. Confira os SKUs dos dois no painel da Loja Integrada; se o vínculo que já ' +
      'existe estiver errado, avise o suporte.',
  },
  [PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente]: {
    rotulo: 'Produto pai sem vínculo',
    descricao: 'O produto pai não foi vinculado, então as variações dele também não foram.',
  },
  [PENDENCIA_IMPORTACAO_LI.vinculoIlegivel]: {
    rotulo: 'Vínculo ilegível',
    descricao:
      'Um vínculo guardado no ERP para este produto está fora do formato (id ou conta). Avise o ' +
      'suporte para corrigi-lo ou removê-lo.',
  },
  [PENDENCIA_IMPORTACAO_LI.formaDiferente]: {
    rotulo: 'Forma diferente',
    descricao:
      'O produto tem forma diferente na loja e no ERP (por exemplo, simples de um lado e com ' +
      'variação do outro). Nada foi vinculado.',
  },
  [PENDENCIA_IMPORTACAO_LI.filhoDeOutraFamilia]: {
    rotulo: 'Variação de outro produto',
    descricao:
      'A variação encontrada no ERP pelo SKU pertence a outro produto pai. Nada foi vinculado.',
  },
  [PENDENCIA_IMPORTACAO_LI.gradeSemVinculo]: {
    rotulo: 'Grade sem vínculo',
    descricao:
      'Uma grade da loja usada por este produto não está vinculada a um grupo de variações do ' +
      'ERP. Vincule-a no grupo de variações.',
  },
  [PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo]: {
    rotulo: 'Opção sem vínculo',
    descricao:
      'Uma opção de grade usada por este produto não está vinculada a uma variante do ERP. ' +
      'Vincule-a no grupo de variações.',
  },
  [PENDENCIA_IMPORTACAO_LI.gradeEmDoisGrupos]: {
    rotulo: 'Grade em dois grupos',
    descricao:
      'Uma grade da loja está vinculada a dois grupos de variações do ERP. Deixe o vínculo em ' +
      'um só.',
  },
  [PENDENCIA_IMPORTACAO_LI.opcaoEmDoisGrupos]: {
    rotulo: 'Opção em dois grupos',
    descricao:
      'Uma opção de grade da loja está vinculada em dois grupos de variações do ERP. Deixe o ' +
      'vínculo em um só.',
  },
  [PENDENCIA_IMPORTACAO_LI.variacaoAmbigua]: {
    rotulo: 'Variação ambígua',
    descricao:
      'Uma variação da loja corresponde a mais de uma variação do ERP. Nada foi escolhido.',
  },
  [PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo]: {
    rotulo: 'Variação sem vínculo',
    descricao:
      'Não foi possível saber a que variação do ERP corresponde uma variação da loja. Vincule ' +
      'as opções de grade dela no grupo de variações.',
  },
  [PENDENCIA_IMPORTACAO_LI.evidenciaDivergente]: {
    rotulo: 'SKUs divergentes',
    descricao:
      'Produtos diferentes indicam variantes diferentes do ERP para a mesma opção da loja, então ' +
      'nada foi aprendido. Vincule essa opção à mão no grupo de variações.',
  },
  [PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo]: {
    rotulo: 'Categoria sem vínculo',
    descricao:
      'A categoria da loja não está vinculada a uma categoria do ERP, e o produto ficou sem ' +
      'categoria. Rode a importação de novo com "Completar" e, em categorias, "Criar e vincular ' +
      'as que faltam": ela cria a categoria no ERP e a vincula.',
  },
  [PENDENCIA_IMPORTACAO_LI.categoriaRecusada]: {
    rotulo: 'Categoria recusada',
    descricao:
      'A árvore desta categoria na loja está quebrada (um pai ilegível, ausente ou em ciclo), e o ' +
      'produto ficou sem categoria. Corrija a categoria no painel da Loja Integrada.',
  },
  [PENDENCIA_IMPORTACAO_LI.categoriaAmbigua]: {
    rotulo: 'Categoria ambígua',
    descricao:
      'O produto está em mais de uma categoria final da loja, ou a categoria está vinculada a ' +
      'duas categorias do ERP, e nada foi escolhido. Deixe o produto em uma categoria final no ' +
      'painel da Loja Integrada; se forem os vínculos, avise o suporte.',
  },
  [PENDENCIA_IMPORTACAO_LI.descricaoLonga]: {
    rotulo: 'Descrição longa demais',
    descricao:
      'A descrição da loja passa do limite do campo do ERP e não foi copiada. Preencha a ' +
      'descrição no ERP.',
  },
  [PENDENCIA_IMPORTACAO_LI.dadoInvalido]: {
    rotulo: 'Dado inválido',
    descricao:
      'Um dado da loja não pôde ser usado (veja os campos citados). Um produto, uma variação ou ' +
      'uma categoria que seria criado com ele não foi criado; num produto que já existia, só ' +
      'esse campo ficou de fora. Corrija o dado no painel da Loja Integrada e rode a importação ' +
      'de novo.',
  },
  [PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita]: {
    rotulo: 'Conflito de gravação',
    descricao:
      'Outra operação alterou o mesmo registro enquanto a importação gravava, e nada foi ' +
      'forçado. Rode a importação de novo.',
  },
  [PENDENCIA_IMPORTACAO_LI.orfao]: {
    rotulo: 'Variação sem pai',
    descricao: 'Nenhum produto pai da loja inclui esta variação; ela não foi vinculada nem criada.',
  },
  [PENDENCIA_IMPORTACAO_LI.naLixeira]: {
    rotulo: 'Pai na lixeira',
    descricao:
      'O produto pai desta variação está na lixeira da loja; ela não foi vinculada nem criada.',
  },
  [PENDENCIA_IMPORTACAO_LI.familiaVazia]: {
    rotulo: 'Sem variações',
    descricao: 'O produto tem variações na loja, mas nenhuma variação está na lista dele.',
  },
  [PENDENCIA_IMPORTACAO_LI.tipoDesconhecido]: {
    rotulo: 'Tipo desconhecido',
    descricao:
      'A loja informou um tipo de produto que a importação não conhece; a linha foi deixada de ' +
      'lado.',
  },
  [PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado]: {
    rotulo: 'Oculto, não criado',
    descricao:
      'O produto (ou a variação) está oculto na loja e não existe no ERP, então não foi criado.',
  },
  [PENDENCIA_IMPORTACAO_LI.nomeCortado]: {
    rotulo: 'Nome cortado',
    descricao:
      'O nome da loja passa de 100 caracteres, o limite do ERP: no produto criado ele fica ' +
      'cortado.',
  },
  [PENDENCIA_IMPORTACAO_LI.naoListado]: {
    rotulo: 'Fora da lista da loja',
    descricao:
      'Um produto selecionado não apareceu na lista de produtos da loja (removido ou na ' +
      'lixeira).',
  },
  [PENDENCIA_IMPORTACAO_LI.skuDiferente]: {
    rotulo: 'SKU diferente',
    descricao:
      'A variação foi vinculada pela combinação de opções, mas o SKU da loja e o do ERP são ' +
      'diferentes.',
  },
  [PENDENCIA_IMPORTACAO_LI.vinculoAtualizado]: {
    rotulo: 'Vínculo atualizado',
    descricao: 'O vínculo já existia; os dados da loja guardados nele foram atualizados.',
  },
  [PENDENCIA_IMPORTACAO_LI.fotoRecusada]: {
    rotulo: 'Foto recusada',
    descricao:
      'Uma foto da loja não pôde ser importada (endereço inválido, não encontrada, grande demais ' +
      'ou não é uma imagem).',
  },
  [PENDENCIA_IMPORTACAO_LI.semEstoqueNoErp]: {
    rotulo: 'Sem estoque no ERP',
    descricao: 'O produto não tem estoque no ERP. A importação nunca traz estoque da loja.',
  },
  [PENDENCIA_IMPORTACAO_LI.semPrecoNoErp]: {
    rotulo: 'Sem preço no ERP',
    descricao: 'O produto não tem preço no ERP. A importação nunca traz preço da loja.',
  },
  [PENDENCIA_IMPORTACAO_LI.revisaoFiscal]: {
    rotulo: 'Revisão fiscal',
    descricao:
      'O produto entrou na lista de revisão fiscal: confira a configuração de impostos dele ou ' +
      'da categoria dele.',
  },
} as const satisfies Record<PendenciaImportacaoLi, TextoPendenciaLi>;

/** Why a produto is on the tax-review list. */
export const ROTULO_MOTIVO_REVISAO_FISCAL_LI = {
  [MOTIVO_REVISAO_FISCAL_LI.produtoCriado]: 'Produto criado pela importação',
  [MOTIVO_REVISAO_FISCAL_LI.categoriaCriada]: 'Categoria criada pela importação',
  [MOTIVO_REVISAO_FISCAL_LI.semCategoria]: 'Ficou sem categoria',
  [MOTIVO_REVISAO_FISCAL_LI.categoriaPreenchida]: 'Categoria preenchida pela importação',
} as const satisfies Record<MotivoRevisaoFiscalLi, string>;

/* -------------------------------------------------------------------------- */
/*                     Total readers for the plain-string fields               */
/* -------------------------------------------------------------------------- */

/** A copied code: its copy, and whether this build knows the code at all. */
export interface CodigoLidoLi<T> {
  readonly texto: T;
  /** `false` = a code a newer backend added; `texto` is generic and quotes it. */
  readonly conhecido: boolean;
}

/**
 * `codigo` matched EXACTLY against an enum schema (no trim, no case fold — Zod's
 * enum check is a byte-for-byte membership test) and looked up in its
 * exhaustive table; anything else gets `generico(codigo)`.
 */
function lerCodigo<T extends string, V>(
  schema: z.ZodType<T>,
  tabela: Readonly<Record<T, V>>,
  codigo: string,
  generico: (codigo: string) => V,
): CodigoLidoLi<V> {
  const lido = schema.safeParse(codigo);
  return lido.success
    ? { texto: tabela[lido.data], conhecido: true }
    : { texto: generico(codigo), conhecido: false };
}

/** The raw code as the generic labels quote it: in quotes, so a space shows. */
const citar = (codigo: string) => `"${codigo}"`;

/** A job's `fase` (a plain string in the answer). */
export function lerFaseImportacaoLi(fase: string): CodigoLidoLi<string> {
  return lerCodigo(
    faseImportacaoLiSchema,
    ROTULO_FASE_IMPORTACAO_LI,
    fase,
    (c) => `Fase ${citar(c)}`,
  );
}

/**
 * A failed job's `motivo` (a plain string or `null` in the answer). `null` on a
 * `falhou` job is a backend that stamped no motivo: generic copy, still known
 * to be a failure.
 */
export function lerMotivoFalhaImportacaoLi(motivo: string | null): CodigoLidoLi<string> {
  if (motivo === null) {
    return {
      texto:
        'A importação falhou sem informar o motivo. Inicie de novo; se continuar, avise o suporte.',
      conhecido: false,
    };
  }
  return lerCodigo(
    motivoFalhaImportacaoLiSchema,
    MENSAGEM_MOTIVO_FALHA_IMPORTACAO_LI,
    motivo,
    (c) => `A importação falhou (motivo ${citar(c)}). Avise o suporte.`,
  );
}

/** A report item's `tipo`. */
export function lerTipoProdutoLi(tipo: string): CodigoLidoLi<string> {
  return lerCodigo(tipoProdutoLiSchema, ROTULO_TIPO_PRODUTO_LI, tipo, (c) => `Tipo ${citar(c)}`);
}

/** A report item's `situacaoErp`. */
export function lerSituacaoErpItemLi(situacao: string): CodigoLidoLi<string> {
  return lerCodigo(
    situacaoErpItemLiSchema,
    ROTULO_SITUACAO_ERP_ITEM_LI,
    situacao,
    (c) => `Situação ${citar(c)}`,
  );
}

/** A report item's `acao`, worded as done or as a Simular's proposal by `aplicada`. */
export function lerAcaoItemImportacaoLi(acao: string, aplicada: boolean): CodigoLidoLi<string> {
  const lido = lerCodigo(
    acaoItemImportacaoLiSchema,
    ROTULO_ACAO_ITEM_IMPORTACAO_LI,
    acao,
    (c): RotuloAcaoItemLi => ({ aplicada: `Ação ${citar(c)}`, simulada: `Ação ${citar(c)}` }),
  );
  return { texto: aplicada ? lido.texto.aplicada : lido.texto.simulada, conhecido: lido.conhecido };
}

/** One pendência as the report shows it. */
export interface PendenciaLidaLi extends TextoPendenciaLi {
  readonly codigo: string;
  /** Whether it needs a person — what keeps the summary aviso open. */
  readonly acionavel: boolean;
  readonly conhecido: boolean;
}

/**
 * A report pendência (`codigo` a plain string in the answer, `acionavel` the
 * backend's own stored flag).
 *
 * A KNOWN code takes its class from `ehPendenciaAcionavelLi`, the contract's
 * one set; an UNKNOWN code takes the stored flag, since only the backend that
 * wrote it knows what it is.
 */
export function lerPendenciaLi(pendencia: {
  readonly codigo: string;
  readonly acionavel: boolean;
}): PendenciaLidaLi {
  const { codigo } = pendencia;
  const lido = lerCodigo(
    pendenciaImportacaoLiSchema,
    TEXTO_PENDENCIA_IMPORTACAO_LI,
    codigo,
    (c): TextoPendenciaLi => ({
      rotulo: `Pendência ${citar(c)}`,
      descricao:
        'Uma pendência que esta versão da tela não conhece. Atualize a página; se continuar, ' +
        'avise o suporte.',
    }),
  );
  return {
    codigo,
    rotulo: lido.texto.rotulo,
    descricao: lido.texto.descricao,
    acionavel: lido.conhecido ? ehPendenciaAcionavelLi(codigo) : pendencia.acionavel,
    conhecido: lido.conhecido,
  };
}

/** A tax-review entry's motivo (plain strings in the answer). */
export function lerMotivoRevisaoFiscalLi(motivo: string): CodigoLidoLi<string> {
  return lerCodigo(
    motivoRevisaoFiscalLiSchema,
    ROTULO_MOTIVO_REVISAO_FISCAL_LI,
    motivo,
    (c) => `Motivo ${citar(c)}`,
  );
}

/* -------------------------------------------------------------------------- */
/*                               The job's phase line                          */
/* -------------------------------------------------------------------------- */

/** A job created and not picked up yet: its stored phase is only where it WILL start. */
export const TEXTO_JOB_AGUARDANDO_LI = 'Aguardando o início';

/** The learning phase under Simular, which works out what it would link and writes nothing. */
export const TEXTO_APRENDIZADO_SIMULADO_LI =
  'Conferindo as opções de grade confirmadas pelo SKU (sem gravar)';

/**
 * The line a running card shows: what the job is doing NOW. A `pendente` job
 * has not started (its stored phase is the first one it will run), and a
 * Simular's learning phase links nothing — every other phase reads the same in
 * both modes, through {@link lerFaseImportacaoLi}.
 */
export function textoDaFaseDoJobLi(
  job: Pick<RespostaImportacaoLi, 'status' | 'fase' | 'modo'>,
): string {
  if (job.status === STATUS_IMPORTACAO_LI.pendente) return TEXTO_JOB_AGUARDANDO_LI;
  if (job.modo === MODO_IMPORTACAO_LI.simular && job.fase === FASE_IMPORTACAO_LI.aprendizado) {
    return TEXTO_APRENDIZADO_SIMULADO_LI;
  }
  return lerFaseImportacaoLi(job.fase).texto;
}

/* -------------------------------------------------------------------------- */
/*                            The fields a report names                        */
/* -------------------------------------------------------------------------- */

/**
 * The field names the report carries as plain strings — what the complete step
 * filled (`camposPreenchidos`), what a `dado-invalido` cites, what a refreshed
 * link changed — as the operator reads them. Matched EXACTLY, like every code
 * here; a name this build does not know is shown as it came.
 */
const ROTULO_CAMPO_LI: ReadonlyMap<string, string> = new Map([
  ['gtin', 'GTIN'],
  ['pesoLiquidoKg', 'Peso líquido (kg)'],
  ['pesoBrutoKg', 'Peso bruto (kg)'],
  ['alturaCm', 'Altura (cm)'],
  ['larguraCm', 'Largura (cm)'],
  ['profundidadeCm', 'Profundidade (cm)'],
  ['categoriaProdutoOuterRef', 'Categoria'],
  ['extraData.descricao', 'Descrição'],
  ['extraData.marca', 'Marca'],
  ['nome', 'Nome'],
  ['sku', 'SKU'],
  ['filhos', 'Lista de variações do produto pai'],
  ['detalhe', 'Detalhe do produto na loja'],
  ['ativo', 'Ativo na loja'],
  ['bloqueado', 'Bloqueado na loja'],
  ['removido', 'Na lixeira da loja'],
]);

/**
 * The prefixes a cited field path carries when it is a field of something
 * else: a store category's, a category link's, a variation's.
 */
const PREFIXOS_CAMPO_LI: readonly (readonly [string, string])[] = [
  ['categoria.', 'Categoria da loja'],
  ['categoriaLojaIntegrada.', 'Vínculo da categoria'],
  ['membro.', 'Variação'],
];

/** One field name of the report, in pt-BR — or as it came, when this build does not know it. */
export function lerCampoLi(nome: string): string {
  const direto = ROTULO_CAMPO_LI.get(nome);
  if (direto !== undefined) return direto;
  for (const [prefixo, dono] of PREFIXOS_CAMPO_LI) {
    if (nome.startsWith(prefixo) && nome.length > prefixo.length) {
      const resto = nome.slice(prefixo.length);
      return `${dono}: ${ROTULO_CAMPO_LI.get(resto) ?? resto}`;
    }
  }
  return nome;
}

/** Why a store picture was refused (a `foto-recusada`'s second reference). */
export const ROTULO_MOTIVO_FOTO_RECUSADA_LI = {
  [MOTIVO_FOTO_RECUSADA_LI.caminhoInvalido]: 'endereço inválido',
  [MOTIVO_FOTO_RECUSADA_LI.redirecionamento]: 'o endereço redirecionou para outro',
  [MOTIVO_FOTO_RECUSADA_LI.naoEncontrada]: 'não encontrada',
  [MOTIVO_FOTO_RECUSADA_LI.http]: 'recusada pelo servidor de imagens',
  [MOTIVO_FOTO_RECUSADA_LI.muitoGrande]: 'grande demais',
  [MOTIVO_FOTO_RECUSADA_LI.naoEImagem]: 'não é uma imagem',
} as const satisfies Record<MotivoFotoRecusadaLi, string>;

/** A whole count of characters, as a reference carries it. */
const INTEIRO = /^\d+$/;

/**
 * What a pendência names, as one line — or `null` when it names nothing. The
 * codes whose references are FIELD names read them through {@link lerCampoLi};
 * a too-long description says its length; a refused picture says which and
 * why. Every other code names ids or SKUs, shown as they came — and so does a
 * known code whose references do not have the shape it carries.
 */
export function textoReferenciasDaPendenciaLi(pendencia: {
  readonly codigo: string;
  readonly referencias: readonly string[];
}): string | null {
  const { referencias } = pendencia;
  if (referencias.length === 0) return null;
  const lido = pendenciaImportacaoLiSchema.safeParse(pendencia.codigo);
  const codigo = lido.success ? lido.data : null;
  if (
    codigo === PENDENCIA_IMPORTACAO_LI.dadoInvalido ||
    codigo === PENDENCIA_IMPORTACAO_LI.vinculoAtualizado
  ) {
    return `Campos: ${referencias.map(lerCampoLi).join(', ')}`;
  }
  if (codigo === PENDENCIA_IMPORTACAO_LI.descricaoLonga) {
    const [tamanho] = referencias;
    if (referencias.length === 1 && tamanho !== undefined && INTEIRO.test(tamanho)) {
      return `Descrição com ${Number(tamanho).toLocaleString('pt-BR')} caracteres`;
    }
  }
  if (codigo === PENDENCIA_IMPORTACAO_LI.fotoRecusada) {
    const [imagem, motivo] = referencias;
    const motivoLido = motivoFotoRecusadaLiSchema.safeParse(motivo);
    if (referencias.length === 2 && imagem !== undefined && motivoLido.success) {
      return `Imagem ${imagem}: ${ROTULO_MOTIVO_FOTO_RECUSADA_LI[motivoLido.data]}`;
    }
  }
  return `Referências: ${referencias.join(', ')}`;
}
