'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  CloseButton,
  Group,
  Loader,
  MultiSelect,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import {
  CAMPO_RASCUNHO_SHOPEE,
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE,
  textoUtilizavelShopee,
  type EstadoPublicacaoRascunhoShopee,
} from '@delfrance/schemas';

import {
  ehFraseDeTerminal,
  saidaPeloSellerCentreDoRascunhoShopee,
} from '@/lib/shopee/anuncioProduto';
import {
  MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE,
  MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE,
  TIPO_CONTROLE_ATRIBUTO_SHOPEE,
  aplicarEdicaoDoAtributoShopee,
  type ArgsDoEditorDeAtributosShopee,
  type ControleAtributoShopee,
  type EdicaoDoAtributoShopee,
  type ItemDeAtributoShopee,
  type LinhaAtributoShopee,
  type MensagemAtributoShopee,
  type MotivoDigitacaoShopee,
  type MotivoNaoSuportadoAtributoShopee,
  type TipoDoValorAtributoShopee,
  type ValorExibidoAtributoShopee,
} from '@/lib/shopee/atributosRascunho';
import type { RespostaAtributosShopee } from '@/lib/shopee/wire';

import { idDoCampoRascunhoShopee } from './DesfechoAcaoShopee';
// Read only while rendering, so the import cycle with the form that mounts this
// section (`RascunhoShopee` imports this file) never reads a binding early.
import { ROTULO_LER_DE_NOVO_RASCUNHO_SHOPEE } from './RascunhoShopee';
import { semEnviarOFormularioDoProduto } from './semEnviarOFormularioDoProduto';

/* -------------------------------------------------------------------------- */
/*                                    Props                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where the EDITED category's attribute tree stands — what the section shows
 * above (or instead of) the rows. Built by the tab:
 *
 * - `sem-conta` — the draft's conta document cannot answer (the form's
 *   `contaId: null`): nothing is read; `gravados` = how many attributes the
 *   held projection stores;
 * - `sem-categoria` — no category chosen (or a legacy `0`): nothing is read;
 * - `carregando` — the tree read is pending;
 * - `falha` — the read FAILED with nothing to show: `causa` is
 *   `descreverFalhaShopee(err, { desconhecido: '' }).mensagem` (blank and
 *   terminal text are dropped here), `onLerDeNovo` the query's refetch,
 *   `relendo` while it runs;
 * - `nao-folha` / `vazia` / `lida` — the answer
 *   ({@link leituraDaRespostaDeAtributosShopee} maps it): a non-leaf category,
 *   a leaf with no attribute, or the tree (`truncated`, Shopee's `warning`).
 */
export type LeituraDosAtributosRascunhoShopee =
  | { readonly tipo: 'sem-conta'; readonly gravados: number }
  | { readonly tipo: 'sem-categoria' }
  | { readonly tipo: 'carregando' }
  | {
      readonly tipo: 'falha';
      readonly causa: string;
      readonly relendo: boolean;
      readonly onLerDeNovo: () => void;
    }
  | { readonly tipo: 'nao-folha' }
  | { readonly tipo: 'vazia'; readonly warning: string | null }
  | { readonly tipo: 'lida'; readonly truncated: boolean; readonly warning: string | null };
export type TipoLeituraDosAtributosRascunhoShopee = LeituraDosAtributosRascunhoShopee['tipo'];
export const TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE = {
  semConta: 'sem-conta',
  semCategoria: 'sem-categoria',
  carregando: 'carregando',
  falha: 'falha',
  naoFolha: 'nao-folha',
  vazia: 'vazia',
  lida: 'lida',
} as const satisfies Record<string, TipoLeituraDosAtributosRascunhoShopee>;

/**
 * Whether the composer's value of one attribute may be ADDED now — `null` =
 * yes, else why not. A DRY RUN of the model's `adicionar-personalizado` over
 * the editor's state ({@link ensaioDaAdicaoAtributoShopee} builds it), so
 * «Adicionar» is enabled by the same rule that applies the add (#1369).
 */
export type EnsaioDaAdicaoAtributoShopee = (
  attributeId: number,
  texto: string,
  unidade: string | null,
) => MotivoDigitacaoShopee | null;

export interface AtributosRascunhoShopeeProps {
  /** The draft's link doc id — the wrapper id's and the test ids' suffix; supplied by `RascunhoShopee`. */
  linkDocId: string;
  /** The EDITED category's tree read ({@link LeituraDosAtributosRascunhoShopee}); supplied by the tab. */
  leitura: LeituraDosAtributosRascunhoShopee;
  /** `linhasDoEditorDeAtributosShopee(…).linhas` over the editor's state once the read ANSWERED (`nao-folha` / `vazia` / `lida`; a non-leaf's tree is the empty, complete one); `[]` otherwise. */
  linhas: readonly LinhaAtributoShopee[];
  /** `linhasDoEditorDeAtributosShopee(…).semLugar` — stored attributes the walk hides, listed and never removed on load; `[]` while the tree is unknown. */
  semLugar: readonly ItemDeAtributoShopee[];
  /** `linhasDoEditorDeAtributosShopee(…).removidosAoSalvar` — the held base's attributes the list dropped, and a multiple attribute's dropped stored values (staged, apps/web rule 7; a replaced single value is an edit its row shows); `[]` while the tree is unknown. */
  removidosAoSalvar: readonly ItemDeAtributoShopee[];
  /** The block's CURRENT publication reading (`bloco.publicacao`) — the Seller-Centre exit a MANDATORY «não suportado» row names follows it. */
  publicacao: EstadoPublicacaoRascunhoShopee;
  /** The controls accept edits (`bloco.camposEditaveis`); `false` ⇒ every control disabled, no chip remove, the composer disabled (its typed text kept), no «Marcar para remover». */
  editavel: boolean;
  /** One edit of one attribute; the editor applies `comAtributoRascunhoShopee`. «Marcar para remover» sends `remover-sem-lugar` with the first «sem lugar» id. */
  onAtributo: (attributeId: number, edicao: EdicaoDoAtributoShopee) => void;
  /** The composer's dry run ({@link EnsaioDaAdicaoAtributoShopee}) — `ensaioDaAdicaoAtributoShopee(estado)` over the SAME state the rows were built from. */
  ensaiarAdicao: EnsaioDaAdicaoAtributoShopee;
}

/**
 * The section's reading of a 200 from `client.atributos`: a non-leaf
 * category (`leaf: false`, which apps/shopee answers empty at zero Shopee
 * calls), a leaf with no attribute, or the tree with its `truncated` flag and
 * Shopee's `warning`. The editor's tree for a non-leaf is the empty, complete
 * one (`{ atributos: [], truncated: false }`). Pure.
 */
export function leituraDaRespostaDeAtributosShopee(
  resposta: RespostaAtributosShopee,
): Extract<LeituraDosAtributosRascunhoShopee, { tipo: 'nao-folha' | 'vazia' | 'lida' }> {
  if (!resposta.leaf) return { tipo: TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.naoFolha };
  if (resposta.atributos.length === 0) {
    return { tipo: TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.vazia, warning: resposta.warning };
  }
  return {
    tipo: TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.lida,
    truncated: resposta.truncated,
    warning: resposta.warning,
  };
}

/**
 * {@link EnsaioDaAdicaoAtributoShopee} over the editor's state — the model's
 * own `adicionar-personalizado`, whose answer is read and thrown away. Pure.
 */
export function ensaioDaAdicaoAtributoShopee(
  estado: ArgsDoEditorDeAtributosShopee,
): EnsaioDaAdicaoAtributoShopee {
  return (attributeId, texto, unidade) => {
    const resultado = aplicarEdicaoDoAtributoShopee({
      ...estado,
      attributeId,
      edicao: { tipo: 'adicionar-personalizado', texto, unidade },
    });
    return resultado.ok ? null : resultado.motivo;
  };
}

/* -------------------------------------------------------------------------- */
/*                                    Copy                                     */
/* -------------------------------------------------------------------------- */

export const ROTULO_ATRIBUTOS_RASCUNHO_SHOPEE = 'Atributos';
export const FRASE_ATRIBUTOS_SEM_CATEGORIA_SHOPEE = 'Escolha a categoria para ver os atributos.';
export const FRASE_ATRIBUTOS_CARREGANDO_SHOPEE = 'Lendo os atributos da categoria…';
export const FRASE_ATRIBUTOS_ILEGIVEIS_SHOPEE =
  'Não foi possível ler os atributos desta categoria na Shopee.';
export const FRASE_ATRIBUTOS_CATEGORIA_NAO_FOLHA_SHOPEE =
  'Escolha uma categoria final para ver os atributos.';
export const FRASE_ATRIBUTOS_CATEGORIA_VAZIA_SHOPEE = 'Esta categoria não tem atributos na Shopee.';
/** The projection's depth cap dropped a level. No number: the cap is a server constant the browser cannot import. */
export const FRASE_ARVORE_DE_ATRIBUTOS_TRUNCADA_SHOPEE =
  'A árvore de atributos desta categoria é mais profunda do que o ERP mostra; os níveis mais ' +
  'profundos ficam de fora.';

/** The failed read's sentence: the cause appended unless blank or written for the terminal. */
export function fraseDosAtributosIlegiveisShopee(causa: string): string {
  const texto = causa.trim();
  return texto === '' || ehFraseDeTerminal(texto)
    ? FRASE_ATRIBUTOS_ILEGIVEIS_SHOPEE
    : `${FRASE_ATRIBUTOS_ILEGIVEIS_SHOPEE} ${texto}`;
}

export function fraseDoAvisoDaCategoriaShopee(warning: string): string {
  return `Aviso da Shopee sobre esta categoria: ${warning}`;
}

/** No conta that can answer: the stored list is only counted. */
export function fraseDosAtributosGravadosShopee(gravados: number): string {
  return `${String(gravados)} atributo(s) gravado(s) neste rascunho.`;
}

const PLACEHOLDER_ESCOLHA = 'Escolha';
/** The option of a `lista-ou-texto` Select that opens its text input. */
export const ROTULO_OUTRO_VALOR_OPCAO_SHOPEE = 'Outro valor…';
const ROTULO_OUTRO_VALOR = 'Outro valor';
const ROTULO_UNIDADE = 'Unidade';
const PLACEHOLDER_UNIDADE = 'Escolha a unidade';
const DESCRICAO_UNIDADE = 'Como a Shopee escreve — maiúsculas e minúsculas contam.';
const DESCRICAO_DECIMAL = 'Número; use vírgula para a parte decimal (ex.: 1,5).';
const DESCRICAO_INTEIRO = 'Número inteiro.';
const ROTULO_ADICIONAR_OUTRO_VALOR = 'Adicionar outro valor';
const ROTULO_ADICIONAR = 'Adicionar';
const NOTA_BUSCA_NA_SHOPEE =
  'A Shopee também oferece uma busca de valores para este atributo, que o ERP não faz: digite ' +
  'o valor.';

function fraseEscolhaAte(maximo: number): string {
  return `Escolha até ${String(maximo)}`;
}

function rotuloRemover(valor: string): string {
  return `Remover ${valor}`;
}

/** A child row's condition: «Exigido quando…» (mandatory) or «Aparece quando…». */
export function fraseDoPaiDoAtributoShopee(linha: LinhaAtributoShopee): string | null {
  const { pai } = linha;
  if (pai === null) return null;
  return linha.obrigatorio
    ? `Exigido quando ${pai.rotulo} é «${pai.valor}».`
    : `Aparece quando ${pai.rotulo} é «${pai.valor}».`;
}

const FRASE_NAO_SUPORTADO: Readonly<Record<MotivoNaoSuportadoAtributoShopee, string>> = {
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.data]: 'Atributo de data: o ERP ainda não edita datas.',
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.busca]:
    'Os valores deste atributo vêm de uma busca da Shopee que o ERP não faz.',
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.listaSemValores]:
    'A Shopee não enviou os valores deste atributo.',
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.desconhecido]:
    'O ERP não sabe editar este tipo de atributo.',
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.unidadeSemLista]:
    'A Shopee pede uma unidade para este atributo, mas não enviou a lista de unidades.',
};

/** The opening of a MANDATORY unsupported attribute's tail; the exit itself is `anuncioProduto`'s. */
const ABERTURA_OBRIGATORIO_NAO_SUPORTADO =
  'Ele é obrigatório, então este rascunho não pode ser publicado pelo ERP. ';
const FRASE_OPCIONAL_NAO_SUPORTADO = 'Ele é opcional: o anúncio pode ser publicado sem ele.';

/**
 * A «não suportado» row's sentence: why the ERP cannot edit it, then its tail:
 *
 * - MANDATORY and EMPTY (`ausente`: the row carries the validator's
 *   `obrigatorio-ausente` — the very row the `atributo-obrigatorio` pendência
 *   is built from, so this tail and the gate never disagree; D-8) ⇒ it cannot
 *   be published by the ERP, then the Seller-Centre exit for the block's
 *   CURRENT reading, composed from `saidaPeloSellerCentreDoRascunhoShopee` and
 *   never spelled here;
 * - mandatory WITH a stored value ⇒ no tail: the value is carried and
 *   published (D-7), so the draft is not held — the row's «Valor gravado: …
 *   (mantido).» says what goes;
 * - optional ⇒ that it blocks nothing.
 */
export function fraseDoAtributoNaoSuportadoShopee(
  motivo: MotivoNaoSuportadoAtributoShopee,
  obrigatorio: boolean,
  ausente: boolean,
  publicacao: EstadoPublicacaoRascunhoShopee,
): string {
  if (ausente) {
    return (
      `${FRASE_NAO_SUPORTADO[motivo]} ${ABERTURA_OBRIGATORIO_NAO_SUPORTADO}` +
      saidaPeloSellerCentreDoRascunhoShopee(publicacao)
    );
  }
  if (obrigatorio) return FRASE_NAO_SUPORTADO[motivo];
  return `${FRASE_NAO_SUPORTADO[motivo]} ${FRASE_OPCIONAL_NAO_SUPORTADO}`;
}

const FRASE_ESCOLHA_A_UNIDADE = 'Escolha a unidade.';
const FRASE_TIPO_DECIMAL =
  'Use um número, com vírgula para a parte decimal (ex.: 1,5) e sem separador de milhar.';
const FRASE_TIPO_INTEIRO = 'Use um número inteiro.';
const FRASE_VALOR_FORA_DA_LISTA =
  'Um valor gravado não está mais na lista da Shopee para esta categoria — escolha outro.';
const FRASE_VALOR_FORA_DA_LISTA_SEM_SAIDA =
  'Um valor gravado não está mais na lista da Shopee para esta categoria.';
/** The composer's `vazio` — shown only after Enter on an EMPTY composer ({@link Compositor}). */
const FRASE_DIGITE_UM_VALOR = 'Digite um valor.';
/** The composer's `repetido` — the typed value is one the attribute already holds. */
const FRASE_VALOR_JA_NA_LISTA = 'Este valor já está na lista.';
/** The accessible name of a single-choice Select's clear button. */
const ROTULO_LIMPAR = 'Limpar';

function fraseDoTipoDeValor(tipo: TipoDoValorAtributoShopee | null): string | null {
  if (tipo === 'decimal') return FRASE_TIPO_DECIMAL;
  if (tipo === 'inteiro') return FRASE_TIPO_INTEIRO;
  // A date is never edited here, and a text attribute has no value type.
  return null;
}

function fraseValoresDemais(maximo: number): string {
  return `A Shopee aceita no máximo ${String(maximo)} valor(es) aqui.`;
}

/**
 * How a row's control can fix a STORED value — what its sentences may offer:
 *
 * - `nenhuma` — a «não suportado» row: no control, the sentence only states;
 * - `digitar` — a single text input (`texto`): the value is typed again;
 * - `remover` — chips (`lista-multipla-ou-texto`, `textos-multiplos`) and a
 *   `lista-multipla`'s stored custom value: a chip cannot be retyped, and a
 *   list pick there KEEPS a custom value — it is removed (and added again);
 * - `escolher` — `lista-unica` / `lista-ou-texto`: a pick replaces the value.
 */
type SaidaDoValorGravado = 'nenhuma' | 'digitar' | 'remover' | 'escolher';

function saidaDoValorGravado(controle: ControleAtributoShopee): SaidaDoValorGravado {
  switch (controle.tipo) {
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.naoSuportado:
      return 'nenhuma';
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaMultipla:
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaMultiplaOuTexto:
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.textosMultiplos:
      return 'remover';
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.texto:
      return 'digitar';
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaUnica:
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaOuTexto:
      return 'escolher';
  }
}

/**
 * A STORED value of the wrong type, named. The typing sentence
 * ({@link fraseDoTipoDeValor}) asks for a format the shown value may already
 * have (a stored `1,5` is shown as `1,5`), so this one says the STORED text is
 * what is wrong and how this control fixes it: a single input types it again,
 * a chip is removed and added again, a «não suportado» row only states.
 */
function fraseDoTipoDeValorGravado(
  tipo: TipoDoValorAtributoShopee,
  valor: string,
  saida: SaidaDoValorGravado,
): string {
  const fato =
    tipo === 'decimal'
      ? `O valor gravado «${valor}» não está no formato de número da Shopee`
      : `O valor gravado «${valor}» não é um número inteiro`;
  if (saida === 'nenhuma') return `${fato}.`;
  const refazer = saida === 'remover' ? 'remova-o e adicione-o de novo' : 'digite-o de novo';
  return tipo === 'decimal'
    ? `${fato}: ${refazer}, com vírgula para a parte decimal (ex.: 1,5).`
    : `${fato}: ${refazer}.`;
}

/**
 * The sentence of one of the validator's rows on a STORED value, or `null`
 * for a kind the row says otherwise: a missing mandatory value is the
 * pendência's («Preencha os atributos obrigatórios: …»), a search-only one the
 * «não suportado» sentence's, the two hidden kinds are the «sem lugar» list's,
 * and a unit problem on a row Shopee sent no unit list for is that row's own
 * sentence.
 *
 * The exit it names is one THIS row's control (`controle`) has
 * ({@link SaidaDoValorGravado}): never «escolha» on a row with nothing to
 * choose, never a unit pick for a chip (the «Unidade» beside the composer is
 * the NEXT value's).
 */
export function fraseDoProblemaDoAtributoShopee(
  problema: MensagemAtributoShopee,
  tipoDoValor: TipoDoValorAtributoShopee | null,
  controle: ControleAtributoShopee,
): string | null {
  const saida = saidaDoValorGravado(controle);
  switch (problema.tipo) {
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida: {
      const unidade = problema.unidade ?? 'nenhuma';
      if (controle.tipo === TIPO_CONTROLE_ATRIBUTO_SHOPEE.naoSuportado) {
        return controle.motivo === MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.unidadeSemLista
          ? null
          : `A unidade gravada (${unidade}) não está na lista da Shopee para este atributo.`;
      }
      if (saida === 'remover' && problema.valor !== null) {
        return (
          `A unidade gravada de «${problema.valor}» (${unidade}) não está na lista da Shopee ` +
          'para este atributo: remova esse valor e adicione-o de novo, escolhendo a unidade.'
        );
      }
      return (
        `A unidade gravada (${unidade}) não está na lista da Shopee para este atributo: ` +
        'escolha uma.'
      );
    }
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor:
      return tipoDoValor !== null && problema.valor !== null
        ? fraseDoTipoDeValorGravado(tipoDoValor, problema.valor, saida)
        : fraseDoTipoDeValor(tipoDoValor);
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.personalizadoNaoPermitido: {
      const fato =
        'Este atributo só aceita valores da lista da Shopee; o valor gravado ' +
        `«${problema.valor ?? ''}» não vale aqui`;
      if (saida === 'nenhuma') return `${fato}.`;
      return saida === 'remover' ? `${fato} — remova-o.` : `${fato} — escolha um da lista.`;
    }
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valorForaDaLista:
      return saida === 'nenhuma' ? FRASE_VALOR_FORA_DA_LISTA_SEM_SAIDA : FRASE_VALOR_FORA_DA_LISTA;
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.valoresDemais:
      return problema.maximo === null ? null : fraseValoresDemais(problema.maximo);
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.dataEmFormatoDeLeitura:
      return (
        `Data gravada no formato de leitura da Shopee (${problema.valor ?? ''}); a publicação a ` +
        'converte.'
      );
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioAusente:
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioRequerBusca:
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.filhoSemPai:
    case TIPO_PROBLEMA_ATRIBUTO_SHOPEE.foraDaCategoria:
      return null;
  }
}

/**
 * The sentence of a TYPED value's refusal (the single input's blocking
 * typing, or the composer's dry run), or `null` when the reason has no copy —
 * a custom value refused where no editable control offers one; the input is
 * still marked. The composer's own two (#1911 P14b, P13 «no-sentence places»):
 * `vazio` says «Digite um valor.» (the composer shows it only after Enter on
 * an EMPTY composer) and `repetido` «Este valor já está na lista.».
 */
export function fraseDaDigitacaoDoAtributoShopee(
  motivo: MotivoDigitacaoShopee,
  tipoDoValor: TipoDoValorAtributoShopee | null,
  maximo: number | null,
): string | null {
  switch (motivo) {
    case MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida:
      return FRASE_ESCOLHA_A_UNIDADE;
    case MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.tipoDeValor:
      return fraseDoTipoDeValor(tipoDoValor);
    case MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.valoresDemais:
      return maximo === null ? null : fraseValoresDemais(maximo);
    case MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.vazio:
      return FRASE_DIGITE_UM_VALOR;
    case MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.repetido:
      return FRASE_VALOR_JA_NA_LISTA;
    case MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.personalizadoNaoPermitido:
      return null;
  }
}

const TITULO_SEM_LUGAR = 'Gravados, mas sem lugar nesta categoria';
const FRASE_SEM_LUGAR =
  'A Shopee não mostra estes atributos com as escolhas atuais. Ao salvar uma alteração de ' +
  'atributos, o ERP os remove.';
const ROTULO_MARCAR_PARA_REMOVER = 'Marcar para remover';
const TITULO_REMOVIDOS_AO_SALVAR = 'Serão removidos ao salvar';
const FRASE_DESFAZER_REMOCAO = 'Para mantê-los, use «Desfazer alterações».';

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

/** The `Select` value of «Outro valor…» — never a `String(valueId)`. */
const VALOR_OUTRO = 'outro-valor';

/** A value as the screen prints it: the model's label, then the stored unit. */
function textoDoValor(valor: ValorExibidoAtributoShopee): string {
  return valor.unidade === null ? valor.rotulo : `${valor.rotulo} ${valor.unidade}`;
}

interface OpcaoDoSelect {
  readonly value: string;
  readonly label: string;
}

/**
 * The options of a list control: the tree's pickable values, then every held
 * list id the tree does not offer (a stale stored one), labelled as the model
 * shows it — so the control still shows it and a pick of another keeps it
 * only when the operator says so. One option per value (Mantine refuses a
 * repeated one); the first wins.
 */
function opcoesDaLinha(linha: LinhaAtributoShopee): OpcaoDoSelect[] {
  const vistos = new Set<string>();
  const saida: OpcaoDoSelect[] = [];
  const incluir = (value: string, label: string): void => {
    if (vistos.has(value)) return;
    vistos.add(value);
    saida.push({ value, label });
  };
  for (const opcao of linha.opcoes) incluir(String(opcao.valueId), opcao.rotulo);
  for (const id of linha.escolhidos) {
    const guardado = linha.valores.find((v) => !v.personalizado && v.valor.value_id === id);
    incluir(String(id), guardado?.rotulo ?? `#${String(id)}`);
  }
  return saida;
}

/** The unit list VERBATIM — Shopee's order and case; an exact repeat is dropped (Mantine refuses one). */
function opcoesDeUnidade(unidades: readonly string[]): string[] {
  return [...new Set(unidades)];
}

/** Non-empty parts joined into one description, or `undefined`. */
function descricao(...partes: (string | null)[]): string | undefined {
  const usadas = partes.filter((p): p is string => p !== null && p !== '');
  return usadas.length === 0 ? undefined : usadas.join(' ');
}

function inputModeDe(tipo: TipoDoValorAtributoShopee | null): 'decimal' | 'numeric' | undefined {
  if (tipo === 'decimal') return 'decimal';
  if (tipo === 'inteiro') return 'numeric';
  return undefined;
}

function ehChips(linha: LinhaAtributoShopee): boolean {
  return (
    linha.controle.tipo === TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaMultiplaOuTexto ||
    linha.controle.tipo === TIPO_CONTROLE_ATRIBUTO_SHOPEE.textosMultiplos
  );
}

function maximoDoControle(linha: LinhaAtributoShopee): number | null {
  const { controle } = linha;
  return controle.tipo === TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaMultipla ||
    controle.tipo === TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaMultiplaOuTexto ||
    controle.tipo === TIPO_CONTROLE_ATRIBUTO_SHOPEE.textosMultiplos
    ? controle.max
    : null;
}

/* -------------------------------------------------------------------------- */
/*                                 The section                                 */
/* -------------------------------------------------------------------------- */

/**
 * The draft's «Atributos» section (#1911 P13, ATTR §3.3–§3.9): the EDITED
 * category's attribute tree as one row per attribute the walk shows, in walk
 * order, each with the control `controleDoAtributoShopee` decides; the stored
 * attributes the walk hides; and what a save would remove.
 *
 * Presentational: every row, value, label, problem and typing is the model's
 * (`linhasDoEditorDeAtributosShopee`, `@/lib/shopee/atributosRascunho`) and
 * every edit is the editor's (`onAtributo`). It decides no rule (#1369): a
 * pick sends the ids, a typing sends the RAW text with its unit, and the model
 * answers. The only state here is the screen's own — whether «Outro valor…»
 * was chosen before anything was typed, and each composer's text and unit
 * (nothing un-added is work).
 *
 * - **Controls** (ATTR §3.4): `lista-unica` a clearable `Select`;
 *   `lista-ou-texto` a `Select` + «Outro valor…», which opens a text input
 *   (+ unit) — a typed list label stays CUSTOM, the model never maps it;
 *   `texto` a text input (+ unit); `lista-multipla` a `MultiSelect` capped at
 *   the model's `maxEscolhas`; `lista-multipla-ou-texto` that plus custom
 *   chips and a composer; `textos-multiplos` chips and a composer;
 *   `nao-suportado` the reason, the mandatory/optional tail and the stored
 *   values, read-only. Values are `String(valueId)`; labels are the tree's
 *   (pt-BR), never a stored name. Mantine's search filtering is display-only
 *   (it decides no write), so it is no fold.
 * - **Units** (D-10): the attribute's list VERBATIM, in Shopee's order, case
 *   included, with NO default — a number without a unit is the model's
 *   blocking typing, shown as «Escolha a unidade.».
 * - **Decimals**: the text shown is the model's (the wire's dot already turned
 *   into the operator's comma); what is typed goes to the model raw.
 * - **Children** are indented by depth and say when they appear.
 * - **Staged removal** (apps/web rule 7): «Gravados, mas sem lugar nesta
 *   categoria» lists stored attributes the walk hides (on a truncated tree
 *   only an id no write accepts — the save keeps the others), never removed by
 *   opening the screen, with
 *   «Marcar para remover» staging them; «Serão removidos ao salvar» lists the
 *   held base's attributes the list dropped and a multiple attribute's dropped
 *   stored values (a replaced single value is an edit shown on its row),
 *   dimmed, undone by the form's «Desfazer alterações».
 *
 * Contract: the wrapper carries `id={idDoCampoRascunhoShopee(linkDocId,
 * 'attributes')}` (the refusal row's focus target — its first enabled control)
 * and `data-testid="shopee-rascunho-atributos-<linkDocId>"`; each row
 * `data-testid="shopee-atributo-<linkDocId>-<attributeId>"` with
 * `data-profundidade`.
 */
export function AtributosRascunhoShopee({
  linkDocId,
  leitura,
  linhas,
  semLugar,
  removidosAoSalvar,
  publicacao,
  editavel,
  onAtributo,
  ensaiarAdicao,
}: AtributosRascunhoShopeeProps) {
  const raiz = `shopee-rascunho-atributos-${linkDocId}`;
  return (
    <Stack
      gap="xs"
      id={idDoCampoRascunhoShopee(linkDocId, CAMPO_RASCUNHO_SHOPEE.attributes)}
      data-testid={raiz}
    >
      <Text size="sm" fw={500}>
        {ROTULO_ATRIBUTOS_RASCUNHO_SHOPEE}
      </Text>
      <EstadoDaLeitura raiz={raiz} leitura={leitura} />
      {linhas.map((linha) => (
        <LinhaDoAtributo
          key={linha.attributeId}
          linkDocId={linkDocId}
          linha={linha}
          publicacao={publicacao}
          editavel={editavel}
          onAtributo={onAtributo}
          ensaiarAdicao={ensaiarAdicao}
        />
      ))}
      {semLugar.length > 0 && (
        <Stack gap={4} data-testid={`${raiz}-sem-lugar`}>
          <Text size="sm" fw={500}>
            {TITULO_SEM_LUGAR}
          </Text>
          <Text size="xs" c="dimmed">
            {FRASE_SEM_LUGAR}
          </Text>
          <ItensDeAtributo itens={semLugar} riscados={false} />
          {editavel && semLugar[0] !== undefined && (
            <Group>
              <Button
                type="button"
                size="xs"
                variant="light"
                color="red"
                onClick={() => {
                  const primeiro = semLugar[0];
                  if (primeiro !== undefined) {
                    onAtributo(primeiro.attributeId, { tipo: 'remover-sem-lugar' });
                  }
                }}
              >
                {ROTULO_MARCAR_PARA_REMOVER}
              </Button>
            </Group>
          )}
        </Stack>
      )}
      {removidosAoSalvar.length > 0 && (
        <Stack gap={4} data-testid={`${raiz}-removidos`}>
          <Text size="sm" fw={500}>
            {TITULO_REMOVIDOS_AO_SALVAR}
          </Text>
          <ItensDeAtributo itens={removidosAoSalvar} riscados />
          <Text size="xs" c="dimmed">
            {FRASE_DESFAZER_REMOCAO}
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

function EstadoDaLeitura({
  raiz,
  leitura,
}: {
  raiz: string;
  leitura: LeituraDosAtributosRascunhoShopee;
}) {
  switch (leitura.tipo) {
    case TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.semConta:
      return (
        <Text size="sm" data-testid={`${raiz}-sem-conta`}>
          {fraseDosAtributosGravadosShopee(leitura.gravados)}
        </Text>
      );
    case TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.semCategoria:
      return (
        <Text size="sm" c="dimmed" data-testid={`${raiz}-sem-categoria`}>
          {FRASE_ATRIBUTOS_SEM_CATEGORIA_SHOPEE}
        </Text>
      );
    case TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.carregando:
      return (
        <Group gap="xs" data-testid={`${raiz}-carregando`}>
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            {FRASE_ATRIBUTOS_CARREGANDO_SHOPEE}
          </Text>
        </Group>
      );
    case TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.falha:
      return (
        <Group gap="xs" data-testid={`${raiz}-falha`}>
          <Text size="sm" c="red">
            {fraseDosAtributosIlegiveisShopee(leitura.causa)}
          </Text>
          <Button
            type="button"
            size="xs"
            variant="light"
            loading={leitura.relendo}
            onClick={leitura.onLerDeNovo}
          >
            {ROTULO_LER_DE_NOVO_RASCUNHO_SHOPEE}
          </Button>
        </Group>
      );
    case TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.naoFolha:
      return (
        <Text size="sm" c="dimmed" data-testid={`${raiz}-nao-folha`}>
          {FRASE_ATRIBUTOS_CATEGORIA_NAO_FOLHA_SHOPEE}
        </Text>
      );
    case TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.vazia:
      return (
        <>
          <AvisoDaCategoria raiz={raiz} warning={leitura.warning} />
          <Text size="sm" c="dimmed" data-testid={`${raiz}-vazia`}>
            {FRASE_ATRIBUTOS_CATEGORIA_VAZIA_SHOPEE}
          </Text>
        </>
      );
    case TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.lida:
      return (
        <>
          <AvisoDaCategoria raiz={raiz} warning={leitura.warning} />
          {leitura.truncated && (
            <Text size="xs" c="dimmed" data-testid={`${raiz}-truncada`}>
              {FRASE_ARVORE_DE_ATRIBUTOS_TRUNCADA_SHOPEE}
            </Text>
          )}
        </>
      );
  }
}

function AvisoDaCategoria({ raiz, warning }: { raiz: string; warning: string | null }) {
  const texto = textoUtilizavelShopee(warning);
  if (texto === null) return null;
  return (
    <Text size="xs" c="orange" data-testid={`${raiz}-aviso`}>
      {fraseDoAvisoDaCategoriaShopee(texto)}
    </Text>
  );
}

function ItensDeAtributo({
  itens,
  riscados,
}: {
  itens: readonly ItemDeAtributoShopee[];
  riscados: boolean;
}) {
  return (
    <Stack gap={2}>
      {itens.map((item) => (
        <Text
          key={item.attributeId}
          size="sm"
          c={riscados ? 'dimmed' : undefined}
          td={riscados ? 'line-through' : undefined}
        >
          {item.valores.length === 0
            ? item.rotulo
            : `${item.rotulo}: ${item.valores.map(textoDoValor).join(', ')}`}
        </Text>
      ))}
    </Stack>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  One row                                    */
/* -------------------------------------------------------------------------- */

interface PropsDaLinha {
  linkDocId: string;
  linha: LinhaAtributoShopee;
  publicacao: EstadoPublicacaoRascunhoShopee;
  editavel: boolean;
  onAtributo: (attributeId: number, edicao: EdicaoDoAtributoShopee) => void;
  ensaiarAdicao: EnsaioDaAdicaoAtributoShopee;
}

function LinhaDoAtributo(props: PropsDaLinha) {
  const { linkDocId, linha } = props;
  const idDaLinha = `shopee-atributo-${linkDocId}-${String(linha.attributeId)}`;
  const problemas = linha.problemas
    .map((p) => fraseDoProblemaDoAtributoShopee(p, linha.tipoDoValor, linha.controle))
    .filter((f): f is string => f !== null);
  const frasesDosProblemas = [...new Set(problemas)];
  return (
    <Stack
      gap={4}
      data-testid={idDaLinha}
      data-profundidade={linha.profundidade}
      style={{ paddingLeft: `calc(var(--mantine-spacing-lg) * ${String(linha.profundidade)})` }}
    >
      <ControleDaLinha {...props} idDaLinha={idDaLinha} />
      {frasesDosProblemas.length > 0 && (
        <Stack gap={2} data-testid={`${idDaLinha}-problemas`}>
          {frasesDosProblemas.map((frase) => (
            <Text key={frase} size="xs" c="red">
              {frase}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function ControleDaLinha(props: PropsDaLinha & { idDaLinha: string }) {
  const { linha } = props;
  switch (linha.controle.tipo) {
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.naoSuportado:
      return (
        <NaoSuportado
          idDaLinha={props.idDaLinha}
          linha={linha}
          motivo={linha.controle.motivo}
          publicacao={props.publicacao}
        />
      );
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaUnica:
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaOuTexto:
      return <ControleDeEscolhaUnica {...props} />;
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.texto:
      return (
        <EntradaDeTexto
          {...props}
          rotulo={linha.rotulo}
          obrigatorio={linha.obrigatorio}
          descricaoDaLinha={descricao(fraseDoPaiDoAtributoShopee(linha), linha.descricao)}
        />
      );
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaMultipla:
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaMultiplaOuTexto:
    case TIPO_CONTROLE_ATRIBUTO_SHOPEE.textosMultiplos:
      return <ControleMultiplo {...props} />;
  }
}

function NaoSuportado({
  idDaLinha,
  linha,
  motivo,
  publicacao,
}: {
  idDaLinha: string;
  linha: LinhaAtributoShopee;
  motivo: MotivoNaoSuportadoAtributoShopee;
  publicacao: EstadoPublicacaoRascunhoShopee;
}) {
  const sobre = descricao(fraseDoPaiDoAtributoShopee(linha), linha.descricao);
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {linha.rotulo}
      </Text>
      {sobre !== undefined && (
        <Text size="xs" c="dimmed">
          {sobre}
        </Text>
      )}
      <Text size="xs" data-testid={`${idDaLinha}-nao-suportado`}>
        {fraseDoAtributoNaoSuportadoShopee(
          motivo,
          linha.obrigatorio,
          linha.problemas.some((p) => p.tipo === TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioAusente),
          publicacao,
        )}
      </Text>
      {linha.valores.map((valor, i) => (
        <Text key={`${String(i)}-${textoDoValor(valor)}`} size="xs" c="dimmed">
          {`Valor gravado: ${textoDoValor(valor)} (mantido).`}
        </Text>
      ))}
    </Stack>
  );
}

/** `lista-unica` (a clearable Select) and `lista-ou-texto` (+ «Outro valor…» and its text input). */
function ControleDeEscolhaUnica(props: PropsDaLinha) {
  const { linha, editavel, onAtributo } = props;
  // «Outro valor…» chosen — before anything is typed (nothing in the list says
  // so yet), and LATCHED once the row shows a custom value: emptying its text
  // drops the value, never the input being typed in. A list pick or the
  // Select's clear unlatches it; the latch lives until «Desfazer alterações»
  // remounts the section.
  const [outroEscolhido, setOutroEscolhido] = useState(linha.outroValor);
  if (linha.outroValor && !outroEscolhido) setOutroEscolhido(true);
  const comOutro = linha.controle.tipo === TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaOuTexto;
  const primeiro = linha.escolhidos[0];
  const valor =
    primeiro !== undefined
      ? String(primeiro)
      : comOutro && (linha.outroValor || outroEscolhido)
        ? VALOR_OUTRO
        : null;
  const opcoes = opcoesDaLinha(linha);
  const dados = comOutro
    ? [...opcoes, { value: VALOR_OUTRO, label: ROTULO_OUTRO_VALOR_OPCAO_SHOPEE }]
    : opcoes;

  const escolher = (escolhido: string | null): void => {
    if (escolhido === VALOR_OUTRO) {
      setOutroEscolhido(true);
      // A held list value goes; the text input then sends what is typed.
      if (linha.escolhidos.length > 0)
        onAtributo(linha.attributeId, { tipo: 'lista', valueIds: [] });
      return;
    }
    setOutroEscolhido(false);
    onAtributo(linha.attributeId, {
      tipo: 'lista',
      valueIds: escolhido === null ? [] : [Number(escolhido)],
    });
  };

  return (
    <>
      <Select
        label={linha.rotulo}
        withAsterisk={linha.obrigatorio}
        description={descricao(fraseDoPaiDoAtributoShopee(linha), linha.descricao)}
        placeholder={PLACEHOLDER_ESCOLHA}
        data={dados}
        value={valor}
        onChange={escolher}
        clearable
        // Named «Limpar». Mantine 9.2.0's `Combobox.ClearButton` defaults to
        // `aria-hidden` (and `tabIndex={-1}`) and spreads these props after
        // it, so the name is only exposed with `aria-hidden` lifted too.
        clearButtonProps={{ 'aria-label': ROTULO_LIMPAR, 'aria-hidden': false }}
        // Re-clicking «Outro valor…» must not clear the typed value.
        allowDeselect={!comOutro}
        searchable
        disabled={!editavel}
        onKeyDown={semEnviarOFormularioDoProduto}
      />
      {valor === VALOR_OUTRO && (
        <EntradaDeTexto
          {...props}
          rotulo={ROTULO_OUTRO_VALOR}
          obrigatorio={false}
          descricaoDaLinha={undefined}
        />
      )}
    </>
  );
}

/** The single typed input (`texto`, or «Outro valor») and — on a unit attribute — its unit. */
function EntradaDeTexto({
  linha,
  editavel,
  onAtributo,
  rotulo,
  obrigatorio,
  descricaoDaLinha,
}: PropsDaLinha & {
  rotulo: string;
  obrigatorio: boolean;
  descricaoDaLinha: string | undefined;
}) {
  const { digitacao } = linha;
  const fraseDaDigitacao =
    digitacao === null ? null : fraseDaDigitacaoDoAtributoShopee(digitacao, linha.tipoDoValor, 1);
  const naUnidade =
    digitacao === MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida && linha.unidades !== null;
  const erroDoTexto = digitacao === null || naUnidade ? undefined : (fraseDaDigitacao ?? true);
  const descricaoDoTipo = linha.tipoDoValor === null ? null : descricaoDoTipoDeValor(linha);
  return (
    <>
      <TextInput
        label={rotulo}
        withAsterisk={obrigatorio}
        description={descricao(
          descricaoDaLinha ?? null,
          descricaoDoTipo,
          linha.buscaNaShopee ? NOTA_BUSCA_NA_SHOPEE : null,
        )}
        value={linha.textoDigitado}
        inputMode={inputModeDe(linha.tipoDoValor)}
        disabled={!editavel}
        error={erroDoTexto}
        onKeyDown={semEnviarOFormularioDoProduto}
        onChange={(e) =>
          onAtributo(linha.attributeId, {
            tipo: 'texto',
            texto: e.currentTarget.value,
            unidade: linha.unidadeDigitada,
          })
        }
      />
      {linha.unidades !== null && (
        <Select
          label={ROTULO_UNIDADE}
          description={DESCRICAO_UNIDADE}
          placeholder={PLACEHOLDER_UNIDADE}
          data={opcoesDeUnidade(linha.unidades)}
          value={linha.unidadeDigitada}
          allowDeselect={false}
          disabled={!editavel}
          error={naUnidade ? (fraseDaDigitacao ?? true) : undefined}
          onChange={(unidade) =>
            onAtributo(linha.attributeId, {
              tipo: 'texto',
              texto: linha.textoDigitado,
              unidade,
            })
          }
        />
      )}
    </>
  );
}

function descricaoDoTipoDeValor(linha: LinhaAtributoShopee): string | null {
  if (linha.tipoDoValor === 'decimal') return DESCRICAO_DECIMAL;
  if (linha.tipoDoValor === 'inteiro') return DESCRICAO_INTEIRO;
  return null;
}

/** `lista-multipla` (a MultiSelect), `lista-multipla-ou-texto` (+ chips and a composer), `textos-multiplos` (chips and a composer). */
function ControleMultiplo(props: PropsDaLinha & { idDaLinha: string }) {
  const { linha, editavel, onAtributo, idDaLinha } = props;
  const maximo = maximoDoControle(linha);
  const sobre = descricao(
    fraseDoPaiDoAtributoShopee(linha),
    linha.descricao,
    maximo === null ? null : fraseEscolhaAte(maximo),
  );
  const comLista = linha.controle.tipo !== TIPO_CONTROLE_ATRIBUTO_SHOPEE.textosMultiplos;
  const personalizados = linha.valores.filter((v) => v.personalizado);
  return (
    <>
      {comLista ? (
        <MultiSelect
          label={linha.rotulo}
          withAsterisk={linha.obrigatorio}
          description={sobre}
          placeholder={PLACEHOLDER_ESCOLHA}
          data={opcoesDaLinha(linha)}
          value={[...new Set(linha.escolhidos.map(String))]}
          maxValues={linha.maxEscolhas ?? undefined}
          searchable
          disabled={!editavel}
          onKeyDown={semEnviarOFormularioDoProduto}
          onChange={(valores) =>
            onAtributo(linha.attributeId, { tipo: 'lista', valueIds: valores.map(Number) })
          }
        />
      ) : (
        <Stack gap={2}>
          <Text size="sm" fw={500}>
            {linha.rotulo}
            {linha.obrigatorio && (
              <Text span c="red" aria-hidden>
                {' *'}
              </Text>
            )}
          </Text>
          {sobre !== undefined && (
            <Text size="xs" c="dimmed">
              {sobre}
            </Text>
          )}
        </Stack>
      )}
      {(ehChips(linha) || linha.controle.tipo === TIPO_CONTROLE_ATRIBUTO_SHOPEE.listaMultipla) &&
        personalizados.length > 0 && (
          <Group gap={4} data-testid={`${idDaLinha}-valores`}>
            {personalizados.map((valor) => {
              const texto = textoDoValor(valor);
              const indice = valor.indicePersonalizado;
              return (
                <Badge
                  key={`${String(indice)}-${texto}`}
                  variant="light"
                  tt="none"
                  rightSection={
                    editavel && indice !== null ? (
                      <CloseButton
                        type="button"
                        size="xs"
                        aria-label={rotuloRemover(texto)}
                        onClick={() =>
                          onAtributo(linha.attributeId, { tipo: 'remover-personalizado', indice })
                        }
                      />
                    ) : undefined
                  }
                >
                  {texto}
                </Badge>
              );
            })}
          </Group>
        )}
      {ehChips(linha) && <Compositor {...props} maximo={maximo} />}
    </>
  );
}

/**
 * The composer of a multi-value attribute: its text and unit live HERE (an
 * un-added value is no work to guard); «Adicionar» acts only while the
 * model's dry run accepts the value and the attribute is under its cap. It
 * stays MOUNTED while the section is read-only (`editavel` false — any write
 * of the tab in flight, a just-saved bridge): disabled, its typed text kept.
 *
 * The refusal is marked once something is typed — `repetido` reads «Este
 * valor já está na lista.» — or once Enter is pressed on an EMPTY composer
 * (`vazio`: «Digite um valor.»), which the next keystroke clears. A pristine
 * empty composer is never marked: every chips attribute starts empty, and a
 * red box on each would be noise.
 */
function Compositor({
  linha,
  editavel,
  onAtributo,
  ensaiarAdicao,
  maximo,
}: PropsDaLinha & { maximo: number | null }) {
  const [texto, setTexto] = useState('');
  const [unidade, setUnidade] = useState<string | null>(null);
  // Enter pressed with nothing typed — the only way `vazio` is ever shown.
  const [pediuSemValor, setPediuSemValor] = useState(false);
  const digitou = texto.trim() !== '';
  const motivo = ensaiarAdicao(linha.attributeId, texto, unidade);
  const pode = editavel && linha.podeAdicionar && digitou && motivo === null;
  const marcado = (digitou || pediuSemValor) && motivo !== null;
  const frase = marcado
    ? fraseDaDigitacaoDoAtributoShopee(motivo, linha.tipoDoValor, maximo)
    : null;
  const naUnidade = motivo === MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida;

  const adicionar = (): void => {
    if (!pode) return;
    onAtributo(linha.attributeId, { tipo: 'adicionar-personalizado', texto, unidade });
    setTexto('');
    // Never carried to the next value: a unit is chosen, never defaulted.
    setUnidade(null);
  };

  return (
    <>
      <TextInput
        label={ROTULO_ADICIONAR_OUTRO_VALOR}
        description={descricao(
          descricaoDoTipoDeValor(linha),
          linha.buscaNaShopee ? NOTA_BUSCA_NA_SHOPEE : null,
        )}
        value={texto}
        inputMode={inputModeDe(linha.tipoDoValor)}
        disabled={!editavel || !linha.podeAdicionar}
        error={marcado && !(naUnidade && linha.unidades !== null) ? (frase ?? true) : undefined}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (!digitou) setPediuSemValor(true);
          adicionar();
        }}
        onChange={(e) => {
          setPediuSemValor(false);
          setTexto(e.currentTarget.value);
        }}
      />
      {linha.unidades !== null && (
        <Select
          label={ROTULO_UNIDADE}
          description={DESCRICAO_UNIDADE}
          placeholder={PLACEHOLDER_UNIDADE}
          data={opcoesDeUnidade(linha.unidades)}
          value={unidade}
          allowDeselect={false}
          disabled={!editavel || !linha.podeAdicionar}
          error={marcado && naUnidade ? (frase ?? true) : undefined}
          onChange={setUnidade}
        />
      )}
      <Group>
        <Button type="button" size="xs" variant="light" disabled={!pode} onClick={adicionar}>
          {ROTULO_ADICIONAR}
        </Button>
      </Group>
    </>
  );
}
