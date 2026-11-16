'use client';

import { useState } from 'react';
import { FirebaseError } from 'firebase/app';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useFormContext, useWatch } from 'react-hook-form';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { IconArrowBackUp, IconPlus, IconTrash } from '@tabler/icons-react';
import {
  INTEGRACAO_TIPO,
  type FaixaDto,
  type Integracao,
  type LinkVariacaoOpcaoShopee,
  type LinkVariacoesShopee,
} from '@delfrance/schemas';
import { DELETE_MARK, useSectionActive, type FieldRenderProps } from '@delfrance/ui';

import {
  ShopeeCategoriaBrowser,
  rotuloCategoriaShopee,
} from '@/components/shopee/ShopeeCategoriaBrowser';
import { useIntegracoes, type IntegracoesStatus } from '@/lib/data/useIntegracoes';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useShopeeClient } from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE, codigoDaFalhaShopee, shopeeQueryRetry } from '@/lib/shopee/erros';
import {
  MENSAGEM_VARIACOES_SHOPEE_GENERICA,
  VARIACOES_SHOPEE_STALE_MS,
  descreverFalhaVariacoesShopee,
  grupoAutomaticoShopee,
  gruposEscolhiveisShopee,
  opcoesDoGrupoShopee,
  rotuloShopee,
  useVariacoesShopee,
  variacoesVinculaveisShopee,
} from '@/lib/shopee/variacoes';
import type {
  CategoriaResumoDto,
  RespostaVariacoesShopee,
  VariacaoDto,
  VariacaoGrupoDto,
  VariacaoOpcaoDto,
} from '@/lib/shopee/wire';
import { usePublicarSeedVinculadorShopee } from './estadoVinculadorShopee';
import {
  CONFLITO_VINCULO_SHOPEE,
  TIPO_ACHADO_SHOPEE,
  TIPO_ITEM_VINCULO_SHOPEE,
  achadosDaLeituraShopee,
  achadosDoVinculadorShopee,
  agruparVinculosShopee,
  avisosDaRemocaoShopee,
  definirGrupoDoVinculoShopee,
  definirOpcaoDaVarianteShopee,
  escolhaAtualDaVariante,
  escolhaDaLinhaShopee,
  escolhaPersonalizadaDaVarianteShopee,
  grupoAusenteShopee,
  linkDoSeedShopee,
  mensagemDoAchadoShopee,
  mensagemDoAvisoDeRemocaoShopee,
  novoVinculoShopee,
  removerVinculoShopee,
  situacaoDaChaveShopee,
  substituirEntradaShopee,
  valorDaLinhaShopee,
  type AchadoVinculoShopee,
  type EscolhaDaVarianteShopee,
  type ItemVinculoShopee,
} from './vinculadorShopee';
import { ehObjeto, nomesDasVariantes, proprio } from './vinculosDeCanal';

/**
 * The "Shopee" tab of a variation group (#1911 P14): the `renderInput` of
 * `linksVariacoesShopee`, on the EDIT page only. Per ACTIVE Shopee conta, the
 * operator binds this grupo's variantes to the standard options Shopee has for a
 * leaf category.
 *
 * Its conduct:
 *  - **It emits nothing on mount** (#1787), and picking the option a variante
 *    already has is not an edit. Removing a new entry takes the field back to its
 *    seed when the list empties, so the form reads as pristine.
 *  - **Every stored element shows and none is dropped:** a readable standard entry
 *    is a card; a custom one (`variation_id: 0`, import-written) and one of another
 *    conta are read-only with a staged «Remover vínculo»; an unreadable one says
 *    which fields fail. An edit elsewhere carries them all back as stored.
 *  - **Options are the CHOSEN group's only, keyed by id.** Two options Shopee names
 *    alike are two items, and a size of another group is never offered. A stored id
 *    the current tree lacks stays selectable and is a warning: a published listing
 *    may be using it. "Stored" means the draft's rows AND the seed's
 *    (`linkDoSeedShopee`), so an edit that took such an option off its last variante
 *    never takes it out of the list.
 *  - **Names are never typed here, and only the rules module folds one.** A standard
 *    row stores Shopee's string verbatim, a stored row keeps its own, and a NEW custom
 *    row stores the variante's name ends-trimmed (`escolhaPersonalizadaDaVarianteShopee`,
 *    #1911 P14b); labels trim for display, and a `Select`'s value is never a label.
 *    Mantine's search only narrows the list, so it decides no equality. A variante with
 *    no name yet offers its custom option disabled: there is no name to store.
 *  - **A staged removal says what the next publication does without the entry**
 *    (`avisosDaRemocaoShopee`), wherever a publication could read it: an active conta's
 *    block, an inactive Shopee conta, or ANY conta while the conta list is loading or
 *    failed (it may be Shopee's). Never under a conta the READ list says is not Shopee's
 *    or does not exist.
 *  - **Shopee is read only while this tab is the active one**, and without a tree a
 *    card still offers «Sem opção», the stored rows (the draft's and the seed's) and
 *    the custom option.
 *  - The tree's failure copy is `descreverFalhaVariacoesShopee`'s. An unknown category
 *    makes a stored entry read-only. In the add modal no link exists yet, so that case
 *    reads the generic sentence, never «remova o vínculo».
 *
 * The pure rules (what a choice rebuilds, what blocks a save, how a conflict merges)
 * are `vinculadorShopee.ts`; the seed is published for the page's `validate` on every
 * reset (`estadoVinculadorShopee`), which is why this tab stays mounted while hidden.
 */
export function VinculadorDaShopee({
  value,
  onChange,
  disabled,
  error,
}: Pick<FieldRenderProps, 'value' | 'onChange' | 'disabled' | 'error'>) {
  const { control, formState } = useFormContext();
  const seedLinks: unknown = formState.defaultValues?.linksVariacoesShopee;
  const seedVariacoes: unknown = formState.defaultValues?.variacoes;
  usePublicarSeedVinculadorShopee(seedLinks, seedVariacoes);
  const variacoesVivas: unknown = useWatch({ control, name: 'variacoes' });
  // No `SectionTabs` around it (a test, a flat form) ⇒ always visible.
  const ativa = useSectionActive() !== false;
  const integracoes = useIntegracoes(getFirebaseFirestore());

  const contasShopee = integracoes.rows.filter((r) => r.data.tipo === INTEGRACAO_TIPO.shopee);
  const ativas = contasShopee.filter((r) => r.data.ativo === true);
  const grupos = agruparVinculosShopee(value, new Set(ativas.map((r) => r.id)));
  const nomes = nomesDasVariantes(variacoesVivas, seedVariacoes);
  const contexto: ContextoDoVinculador = {
    valor: value,
    lista: Array.isArray(value) ? (value as readonly unknown[]) : [],
    onChange,
    disabled: disabled === true,
    formatoInvalido: grupos.formatoInvalido,
    ativa,
    achados: achadosDoVinculadorShopee(value, variacoesVivas, {
      links: seedLinks,
      variacoes: seedVariacoes,
    }),
    nomeDaVariante: (id) => nomes.get(id) ?? id,
    variantes: variantesOferecidas(variacoesVivas),
    seedLinks,
  };
  // A user without the integrations read (`PERM.integracao.read`) is refused the
  // shared conta list itself, before any Shopee read: say which permission.
  const semPermissao =
    integracoes.status === 'error' &&
    integracoes.query.error instanceof FirebaseError &&
    integracoes.query.error.code === 'permission-denied';

  return (
    <Stack gap="sm">
      {error && <Alert color="red">{error}</Alert>}
      <Text size="sm">
        Nas categorias de moda, a Shopee tem variações padrão (como Cor e Tamanho). Vincule as
        variantes deste grupo às opções da Shopee para publicar nessas categorias. Nas outras
        categorias não é preciso vincular: a publicação usa variações personalizadas, com o nome do
        grupo e das variantes.
      </Text>
      <Text size="xs" c="dimmed">
        A importação de anúncios da Shopee também grava vínculos aqui e volta a acrescentar uma
        opção que um anúncio publicado ainda usa — desvincular aqui não muda o anúncio.
      </Text>
      {grupos.formatoInvalido && (
        <Alert color="red" title="Vínculos ilegíveis">
          <Stack gap="xs">
            <Text size="sm">
              Os vínculos da Shopee guardados neste grupo não estão numa lista e não podem ser lidos
              nem salvos assim.
            </Text>
            {!disabled && (
              <Group>
                <Button size="xs" variant="light" color="red" onClick={() => onChange([])}>
                  Substituir por uma lista vazia
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}
      {integracoes.status === 'pending' && <Loader size="sm" />}
      {integracoes.status === 'error' && (
        <Alert color="orange">
          {semPermissao
            ? 'Você está sem permissão para ler as contas da Shopee: o seu cargo precisa da permissão de leitura de Integrações. Os vínculos guardados aparecem abaixo, sem edição.'
            : 'Não foi possível ler as contas da Shopee. Os vínculos guardados aparecem abaixo, sem edição.'}
        </Alert>
      )}
      {integracoes.status === 'success' && ativas.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhuma conta ativa da Shopee.
        </Text>
      )}
      {ativas.map((conta) => (
        <BlocoContaShopee
          key={conta.id}
          contaId={conta.id}
          nome={conta.data.nome}
          itens={grupos.porConta.get(conta.id) ?? []}
          contexto={contexto}
        />
      ))}
      {grupos.outras.length > 0 && (
        <OutrosVinculosShopee
          itens={grupos.outras}
          contas={integracoes.byId}
          statusContas={integracoes.status}
          contexto={contexto}
        />
      )}
    </Stack>
  );
}

/**
 * A live variante of the form. `nome` is verbatim, blank included: a NEW custom row
 * stores it ends-trimmed, and a blank one offers no custom option.
 */
interface VarianteOferecida {
  readonly id: string;
  readonly nome: string;
}

/**
 * The form's live variantes, each once, in order, minus any staged for deletion.
 * Reads the raw value because `nomesDasVariantes` skips a blank name, and a custom
 * row is named by the variante itself.
 */
function variantesOferecidas(variacoes: unknown): VarianteOferecida[] {
  if (!Array.isArray(variacoes)) return [];
  const vistas = new Set<string>();
  const saida: VarianteOferecida[] = [];
  for (const v of variacoes as readonly unknown[]) {
    if (!ehObjeto(v) || proprio(v, DELETE_MARK) === true) continue;
    const id = proprio(v, 'id');
    if (typeof id !== 'string' || vistas.has(id)) continue;
    vistas.add(id);
    const nome = proprio(v, 'nome');
    saida.push({ id, nome: typeof nome === 'string' ? nome : '' });
  }
  return saida;
}

/** What every block and card of the tab reads. */
interface ContextoDoVinculador {
  /** The form's value as it is, for the checks that read what the save would write. */
  readonly valor: unknown;
  /** The form's value as a list (`[]` when it is not one). */
  readonly lista: readonly unknown[];
  readonly onChange: (next: unknown) => void;
  readonly disabled: boolean;
  /** The stored value is not a list: only its explicit button may replace it. */
  readonly formatoInvalido: boolean;
  /** The tab is the active one: Shopee may be read. */
  readonly ativa: boolean;
  /** The findings that need no tree, on the form's indices. */
  readonly achados: readonly AchadoVinculoShopee[];
  readonly nomeDaVariante: (id: string) => string;
  readonly variantes: readonly VarianteOferecida[];
  /** The form's seed for this field. */
  readonly seedLinks: unknown;
}

/* -------------------------------------------------------------------------- */
/*                               One conta's block                             */
/* -------------------------------------------------------------------------- */

function BlocoContaShopee({
  contaId,
  nome,
  itens,
  contexto,
}: {
  contaId: string;
  nome: string;
  itens: readonly ItemVinculoShopee[];
  contexto: ContextoDoVinculador;
}) {
  const [adicionando, setAdicionando] = useState(false);
  const semVariantes = contexto.variantes.length === 0;
  return (
    <Paper
      withBorder
      p="sm"
      role="group"
      aria-label={nome}
      data-testid={`vinculador-shopee-conta-${contaId}`}
    >
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>{nome}</Text>
          {!contexto.disabled && (
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => setAdicionando(true)}
              disabled={semVariantes || contexto.formatoInvalido}
            >
              Adicionar vínculo
            </Button>
          )}
        </Group>
        {!contexto.disabled && semVariantes && (
          <Text size="sm" c="dimmed">
            Cadastre as variantes deste grupo (aba Variantes) antes de vincular.
          </Text>
        )}
        {itens.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhum vínculo com esta conta.
          </Text>
        )}
        {itens.map((item) =>
          item.tipo === TIPO_ITEM_VINCULO_SHOPEE.padrao ? (
            <CartaoVinculoShopee
              key={item.indice}
              contaId={contaId}
              item={item}
              link={item.link}
              contexto={contexto}
            />
          ) : (
            <VinculoSomenteLeitura
              key={item.indice}
              item={item}
              conta={null}
              contaPublicavel
              contexto={contexto}
            />
          ),
        )}
      </Stack>
      {adicionando && (
        <ModalNovoVinculoShopee
          contaId={contaId}
          nomeDaConta={nome}
          contexto={contexto}
          onFechar={() => setAdicionando(false)}
        />
      )}
    </Paper>
  );
}

/* -------------------------------------------------------------------------- */
/*                               Adding an entry                               */
/* -------------------------------------------------------------------------- */

function ModalNovoVinculoShopee({
  contaId,
  nomeDaConta,
  contexto,
  onFechar,
}: {
  contaId: string;
  nomeDaConta: string;
  contexto: ContextoDoVinculador;
  onFechar: () => void;
}) {
  const [categoria, setCategoria] = useState<CategoriaResumoDto | null>(null);
  // "Trocar categoria" reopens the browser among the last pick's siblings.
  const [inicio, setInicio] = useState<number | null>(null);
  const situacao =
    categoria === null
      ? null
      : situacaoDaChaveShopee(contexto.valor, contaId, categoria.categoryId);

  return (
    <Modal opened onClose={onFechar} size="xl" title={`Novo vínculo com a Shopee — ${nomeDaConta}`}>
      <Stack gap="sm" data-testid="shopee-novo-vinculo-modal">
        {categoria === null ? (
          <>
            <Text size="sm" fw={500}>
              Categoria da Shopee
            </Text>
            <ShopeeCategoriaBrowser
              integracaoId={contaId}
              categoriaInicial={inicio}
              onEscolher={setCategoria}
            />
          </>
        ) : (
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="sm">
              {`Categoria: ${rotuloCategoriaShopee(categoria)} (${String(categoria.categoryId)})`}
            </Text>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setInicio(categoria.categoryId);
                setCategoria(null);
              }}
            >
              Trocar categoria
            </Button>
          </Group>
        )}
        {situacao === 'vinculada' && (
          <Alert color="yellow" variant="light">
            Este grupo já tem um vínculo com esta conta para esta categoria — edite-o na lista ou,
            para trocá-lo, remova-o lá antes de adicionar outro.
          </Alert>
        )}
        {situacao === 'ilegivel' && (
          <Alert color="yellow" variant="light">
            Este grupo já tem um vínculo ilegível com esta conta para esta categoria — remova-o na
            lista antes de adicionar outro.
          </Alert>
        )}
        {categoria !== null && situacao === 'livre' ? (
          // Remounted per category, so no choice leaks between two.
          <EtapaVariacaoShopee
            key={categoria.categoryId}
            contaId={contaId}
            categoria={categoria}
            ativa={contexto.ativa}
            onAdicionar={(novo) => {
              contexto.onChange([...contexto.lista, novo]);
              onFechar();
            }}
            onCancelar={onFechar}
          />
        ) : (
          <RodapeDoModal onAdicionar={null} onCancelar={onFechar} />
        )}
      </Stack>
    </Modal>
  );
}

function RodapeDoModal({
  onAdicionar,
  onCancelar,
}: {
  /** `null` while there is nothing to add. */
  onAdicionar: (() => void) | null;
  onCancelar: () => void;
}) {
  return (
    <Group justify="flex-end" gap="xs">
      <Button variant="default" onClick={onCancelar}>
        Cancelar
      </Button>
      <Button onClick={onAdicionar ?? undefined} disabled={onAdicionar === null}>
        Adicionar
      </Button>
    </Group>
  );
}

/** One `Select` item per value: Mantine THROWS on a repeated option value. */
function itensSemRepetir<T extends { readonly value: string }>(itens: readonly T[]): T[] {
  const vistos = new Set<string>();
  return itens.filter((i) => {
    if (vistos.has(i.value)) return false;
    vistos.add(i.value);
    return true;
  });
}

/** Step 2 of the modal: the leaf's tree, then the variation and, when required, the group. */
function EtapaVariacaoShopee({
  contaId,
  categoria,
  ativa,
  onAdicionar,
  onCancelar,
}: {
  contaId: string;
  categoria: CategoriaResumoDto;
  ativa: boolean;
  onAdicionar: (novo: LinkVariacoesShopee) => void;
  onCancelar: () => void;
}) {
  const { categoryId } = categoria;
  const arvore = useVariacoesShopee(contaId, categoryId, { enabled: ativa });
  const [variacaoEscolhida, setVariacaoEscolhida] = useState<string | null>(null);
  const [grupoEscolhido, setGrupoEscolhido] = useState<string | null>(null);
  const resposta = arvore.data;

  if (resposta === undefined) {
    return (
      <>
        {arvore.isError ? (
          <FalhaDaArvoreNoModal err={arvore.error} onTentar={() => void arvore.refetch()} />
        ) : (
          <Group justify="center" p="md">
            <Loader size="sm" />
          </Group>
        )}
        <RodapeDoModal onAdicionar={null} onCancelar={onCancelar} />
      </>
    );
  }
  // `leaf` FIRST: a non-leaf answers an empty list too, and that is not "nothing to bind".
  const vinculaveis = variacoesVinculaveisShopee(resposta);
  if (!resposta.leaf || vinculaveis.length === 0) {
    return (
      <>
        <Alert color={resposta.leaf ? 'blue' : 'yellow'} variant="light">
          {resposta.leaf
            ? 'Esta categoria não tem variações padrão da Shopee: não é preciso vincular. A publicação usa variações personalizadas, com o nome do grupo e das variantes.'
            : 'Escolha uma categoria final (sem subcategorias).'}
        </Alert>
        <RodapeDoModal onAdicionar={null} onCancelar={onCancelar} />
      </>
    );
  }

  const [unica] = vinculaveis;
  const valorDaVariacao =
    vinculaveis.length === 1 && unica !== undefined ? String(unica.variationId) : variacaoEscolhida;
  const variacao = vinculaveis.find((v) => String(v.variationId) === valorDaVariacao);
  // ⚠️ `0` is an answer (the single-level sentinel); only `null` asks for a choice.
  const automatico = variacao === undefined ? null : grupoAutomaticoShopee(variacao);
  const grupos = variacao === undefined ? [] : gruposEscolhiveisShopee(variacao);
  const doSelect = grupos.find((g) => String(g.variationGroupId) === grupoEscolhido);
  const grupoId = automatico ?? doSelect?.variationGroupId ?? null;

  return (
    <>
      <Select
        label="Variação da Shopee"
        placeholder="Escolha a variação"
        data={itensSemRepetir(
          vinculaveis.map((v) => ({
            value: String(v.variationId),
            label: rotuloShopee(v.variationName, v.variationId),
          })),
        )}
        value={valorDaVariacao}
        onChange={(v) => {
          setVariacaoEscolhida(v);
          setGrupoEscolhido(null);
        }}
        allowDeselect={false}
        searchable
      />
      {variacao !== undefined && automatico === null && (
        <SelectDoGrupoShopee
          grupos={grupos}
          valor={grupoEscolhido}
          onEscolher={setGrupoEscolhido}
        />
      )}
      <RodapeDoModal
        onAdicionar={
          variacao === undefined || grupoId === null
            ? null
            : () =>
                onAdicionar(
                  novoVinculoShopee(
                    contaId,
                    { categoryId, rotulo: rotuloCategoriaShopee(categoria) },
                    variacao.variationId,
                    grupoId,
                  ),
                )
        }
        onCancelar={onCancelar}
      />
    </>
  );
}

function FalhaDaArvoreNoModal({ err, onTentar }: { err: unknown; onTentar: () => void }) {
  // No link exists yet, so the stored entry's «remova o vínculo» says nothing here.
  const falha =
    codigoDaFalhaShopee(err) === CODIGO_FALHA_SHOPEE.categoriaDesconhecida
      ? { mensagem: MENSAGEM_VARIACOES_SHOPEE_GENERICA, repetivel: false }
      : descreverFalhaVariacoesShopee(err);
  return (
    <FalhaDaArvore mensagem={falha.mensagem} repetivel={falha.repetivel} onTentar={onTentar} />
  );
}

function FalhaDaArvore({
  mensagem,
  repetivel,
  onTentar,
}: {
  mensagem: string;
  repetivel: boolean;
  onTentar: () => void;
}) {
  return (
    <Alert color="orange" variant="light">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm">{mensagem}</Text>
        {repetivel && (
          <Button size="xs" variant="light" onClick={onTentar}>
            Tentar de novo
          </Button>
        )}
      </Group>
    </Alert>
  );
}

function SelectDoGrupoShopee({
  grupos,
  valor,
  onEscolher,
}: {
  grupos: readonly VariacaoGrupoDto[];
  valor: string | null;
  onEscolher: (valor: string) => void;
}) {
  return (
    <Select
      label="Grupo de opções"
      placeholder="Escolha o grupo"
      description="Esta variação tem mais de um grupo de opções (por exemplo, tamanhos BR e internacionais) e a Shopee exige que um seja escolhido."
      data={itensSemRepetir(
        grupos.map((g) => ({
          value: String(g.variationGroupId),
          label: rotuloShopee(g.variationGroupName, g.variationGroupId),
        })),
      )}
      value={valor}
      onChange={(v) => {
        if (v !== null) onEscolher(v);
      }}
      allowDeselect={false}
      searchable
    />
  );
}

/* -------------------------------------------------------------------------- */
/*                             One readable standard card                      */
/* -------------------------------------------------------------------------- */

/** What one card reads off the category's tree. */
interface ArvoreDoCartao {
  /** The tree answered. Nothing about a stored id can be said otherwise. */
  readonly lida: boolean;
  readonly variacao: VariacaoDto | undefined;
  /** The stored variation's groups that have options. */
  readonly grupos: readonly VariacaoGrupoDto[];
  /** A two-level variation with no group recorded: nothing can be chosen yet. */
  readonly grupoAusente: boolean;
  /** The options the `Select`s offer: the chosen group's, never another's. */
  readonly opcoes: readonly VariacaoOpcaoDto[];
  /** What a stored id is judged against. While the group is missing, every group's. */
  readonly idsDaArvore: ReadonlySet<number> | null;
  /** How many option-bearing groups the variation has; `null` when the tree does not say. */
  readonly gruposComOpcoes: number | null;
}

function arvoreDoCartao(
  resposta: RespostaVariacoesShopee | undefined,
  link: LinkVariacoesShopee,
): ArvoreDoCartao {
  const semOpcoes = { grupos: [], grupoAusente: false, opcoes: [], gruposComOpcoes: null };
  if (resposta === undefined) {
    return { ...semOpcoes, lida: false, variacao: undefined, idsDaArvore: null };
  }
  const variacao = resposta.standardiseVariationList.find(
    (v) => v.variationId === link.variation_id,
  );
  if (variacao === undefined) {
    return { ...semOpcoes, lida: true, variacao, idsDaArvore: new Set() };
  }
  const grupos = gruposEscolhiveisShopee(variacao);
  const grupoAusente = grupoAusenteShopee(link, grupos.length);
  // A stored `0` on a variation with one group reads that group: nobody had to choose.
  const grupoLido =
    link.variation_group_list !== 0
      ? link.variation_group_list
      : (grupoAutomaticoShopee(variacao) ?? 0);
  const opcoes = grupoAusente ? [] : opcoesDoGrupoShopee(variacao, grupoLido);
  const listadas = grupoAusente ? grupos.flatMap((g) => g.variationOptionList) : opcoes;
  return {
    lida: true,
    variacao,
    grupos,
    grupoAusente,
    opcoes,
    idsDaArvore: new Set(listadas.map((o) => o.variationOptionId)),
    gruposComOpcoes: grupos.length,
  };
}

/**
 * The band a custom name is measured against, or `null` until it is read. It shares
 * the draft editor's cache entry. A failed read says nothing: the band is a warning,
 * and the publisher refuses the name itself.
 */
function useFaixaDoNomeShopee(
  contaId: string,
  categoryId: number,
  enabled: boolean,
): FaixaDto | null {
  const client = useShopeeClient();
  const limites = useQuery({
    queryKey: ['shopee', 'limitesDoItem', contaId, categoryId],
    queryFn:
      client === null
        ? skipToken
        : () => client.limitesDoItem({ integracaoId: contaId, categoryId }),
    enabled,
    staleTime: VARIACOES_SHOPEE_STALE_MS,
    retry: shopeeQueryRetry,
  });
  return limites.data?.limites.tierVariationOptionLengthLimit ?? null;
}

function descricaoDaVariacao(link: LinkVariacoesShopee, arvore: ArvoreDoCartao): string {
  const { variacao } = arvore;
  const daVariacao =
    variacao === undefined
      ? `Variação ${String(link.variation_id)}`
      : rotuloShopee(variacao.variationName, variacao.variationId);
  const grupoId = link.variation_group_list;
  if (grupoId === 0) return daVariacao;
  const grupo = variacao?.variationGroupList.find((g) => g.variationGroupId === grupoId);
  const doGrupo =
    grupo === undefined
      ? `Grupo ${String(grupoId)}`
      : rotuloShopee(grupo.variationGroupName, grupoId);
  return `${daVariacao} · ${doGrupo}`;
}

function CartaoVinculoShopee({
  contaId,
  item,
  link,
  contexto,
}: {
  contaId: string;
  item: ItemVinculoShopee;
  link: LinkVariacoesShopee;
  contexto: ContextoDoVinculador;
}) {
  const lendo = contexto.ativa && !item.removida;
  const leitura = useVariacoesShopee(contaId, link.category_id, { enabled: lendo });
  const arvore = arvoreDoCartao(leitura.data, link);
  const daSeed = linkDoSeedShopee(contexto.seedLinks, item.bruto);
  // Only a custom row some variante holds is ever measured.
  const medeNome = link.variationOptions.some(
    (o) => o.shopee_option_id === 0 && o.arakene_variation_id.length > 0,
  );
  const faixaDoNome = useFaixaDoNomeShopee(contaId, link.category_id, lendo && medeNome);

  const falhou = leitura.isError && leitura.data === undefined;
  const falha = falhou ? descreverFalhaVariacoesShopee(leitura.error) : null;
  const categoriaDesconhecida =
    falhou && codigoDaFalhaShopee(leitura.error) === CODIGO_FALHA_SHOPEE.categoriaDesconhecida;
  const podeEscrever = !contexto.disabled && !item.removida;
  const editavel = podeEscrever && !categoriaDesconhecida && !arvore.grupoAusente;
  const achados = item.removida
    ? []
    : achadosDaLeituraShopee(link, item.indice, {
        idsDaArvore: arvore.idsDaArvore,
        gruposComOpcoes: arvore.gruposComOpcoes,
        faixaDoNome,
      });

  function escrever(nova: unknown): void {
    // A choice that changes nothing hands back the same object: not an edit.
    if (nova === item.bruto) return;
    contexto.onChange(substituirEntradaShopee(contexto.lista, item.indice, nova));
  }

  return (
    <Paper
      withBorder
      p="xs"
      role="group"
      aria-label={`${link.name} (${String(link.category_id)})`}
      data-testid={`vinculo-shopee-${contaId}-${String(link.category_id)}`}
      style={
        item.removida ? { opacity: 0.55, borderColor: 'var(--mantine-color-red-6)' } : undefined
      }
    >
      <Stack gap="xs">
        <CabecalhoDoVinculo
          titulo={`${link.name} (${String(link.category_id)})`}
          item={item}
          contexto={contexto}
        />
        <Text size="sm">{descricaoDaVariacao(link, arvore)}</Text>
        {podeEscrever && (
          <Text size="xs" c="dimmed">
            Para trocar a variação, remova este vínculo e adicione outro.
          </Text>
        )}
        {falha !== null && !item.removida && (
          <FalhaDaArvore
            mensagem={falha.mensagem}
            repetivel={falha.repetivel}
            onTentar={() => void leitura.refetch()}
          />
        )}
        {arvore.grupoAusente && podeEscrever && (
          <SelectDoGrupoShopee
            grupos={arvore.grupos}
            valor={null}
            onEscolher={(valor) => escrever(definirGrupoDoVinculoShopee(item.bruto, Number(valor)))}
          />
        )}
        {contexto.variantes.map((variante) => (
          <SelectDaVariante
            key={variante.id}
            variante={variante}
            link={link}
            daSeed={daSeed}
            arvore={arvore}
            editavel={editavel}
            contexto={contexto}
            onEscolher={(escolha) =>
              escrever(definirOpcaoDaVarianteShopee(item.bruto, variante.id, escolha))
            }
          />
        ))}
        <AvisosDoVinculo
          item={item}
          achadosDaLeitura={achados}
          // A card exists only inside an ACTIVE conta's block: a publication reads it.
          contaPublicavel
          // `categoriaDesconhecida || disabled`, never `!editavel`: a card waiting for its
          // group becomes editable after the pick, so its «Escolha uma.» stays.
          somenteLeitura={categoriaDesconhecida || contexto.disabled}
          contexto={contexto}
        />
      </Stack>
    </Paper>
  );
}

/** «Sem opção»'s value: never an id, nor a custom row's prefixed name. */
const VALOR_SEM_OPCAO = 'sem-opcao';

interface ItemDaVariante {
  readonly value: string;
  readonly label: string;
  /** `null` when it can only be seen: an option with no name to store. */
  readonly escolha: EscolhaDaVarianteShopee | null;
}

/**
 * A stored row's label, the one rule the `Select` and the read-only rows share: a
 * custom row (id `0`, which is no option id) reads «Personalizada: «{nome}»», a
 * standard one «{nome} ({id})». Trimmed for display only.
 */
function rotuloDaLinhaShopee(
  linha: Pick<LinkVariacaoOpcaoShopee, 'shopee_option_id' | 'shopee_option_name'>,
): string {
  return linha.shopee_option_id === 0
    ? `Personalizada: «${linha.shopee_option_name.trim()}»`
    : rotuloShopee(linha.shopee_option_name, linha.shopee_option_id);
}

/**
 * The items of one variante's `Select`, in order: «Sem opção»; the chosen group's
 * options; the stored rows the tree does not offer — the draft's, then the seed's
 * entry's (`daSeed`), so a stored option the tree lacks stays offered after an edit
 * dropped its row; the variante's custom option.
 *
 * ⚠️ `valorDaLinhaShopee` builds every value, so a stored row and a tree option of one
 * id are one item, a row in both the draft and the seed is one item (the draft's,
 * first), and a stored custom row named like the variante's TRIMMED name does not
 * repeat the custom item (Mantine THROWS on a repeated value). The custom item stores
 * that trimmed name (`escolhaPersonalizadaDaVarianteShopee`, #1911 P14b); a legacy row
 * stored with edge spaces keeps its own value, so beside a variante of the same
 * trimmed name the two items share one label — re-picking either is harmless.
 *
 * An option the tree sends with no name has nothing to store verbatim, and the
 * publisher would send that blank beside a standard id: it shows, disabled, unless a
 * stored row already carries its name. No capture has shown one. A variante with no
 * name yet is the same case for its custom option: shown, disabled
 * (`escolhaPersonalizadaDaVarianteShopee` answers `null` exactly when
 * `nomePersonalizadoAusenteShopee`, the finding's own measure, reads no name).
 */
function itensDaVariante(
  variante: VarianteOferecida,
  link: LinkVariacoesShopee,
  daSeed: LinkVariacoesShopee | null,
  arvore: ArvoreDoCartao,
  nomeDaVariante: (id: string) => string,
): ItemDaVariante[] {
  const itens: ItemDaVariante[] = [
    { value: VALOR_SEM_OPCAO, label: 'Sem opção', escolha: { tipo: 'nenhuma' } },
  ];
  const linhasGuardadas = [...link.variationOptions, ...(daSeed?.variationOptions ?? [])];
  const guardadas = new Set(linhasGuardadas.map((o) => o.shopee_option_id));
  for (const opcao of arvore.opcoes) {
    const id = opcao.variationOptionId;
    const nome = opcao.variationOptionName;
    if (nome === null || nome.trim() === '') {
      if (!guardadas.has(id)) {
        itens.push({ value: String(id), label: rotuloShopee(nome, id), escolha: null });
      }
      continue;
    }
    const linha = { shopee_option_id: id, shopee_option_name: nome };
    itens.push({
      value: valorDaLinhaShopee(linha),
      label: rotuloShopee(nome, id),
      escolha: escolhaDaLinhaShopee(linha),
    });
  }
  for (const linha of linhasGuardadas) {
    const id = linha.shopee_option_id;
    const rotulo = rotuloDaLinhaShopee(linha);
    // Unread, a stored id cannot be called outside the list; a custom one never is.
    const fora = id !== 0 && arvore.idsDaArvore !== null && !arvore.idsDaArvore.has(id);
    itens.push({
      value: valorDaLinhaShopee(linha),
      label: fora ? `${rotulo} — fora da lista atual` : rotulo,
      escolha: escolhaDaLinhaShopee(linha),
    });
  }
  const personalizada = escolhaPersonalizadaDaVarianteShopee(variante.nome);
  itens.push({
    value: valorDaLinhaShopee({
      shopee_option_id: 0,
      shopee_option_name: personalizada?.nome ?? variante.nome,
    }),
    label:
      personalizada === null
        ? `Personalizada: «${nomeDaVariante(variante.id)}»`
        : rotuloDaLinhaShopee({ shopee_option_id: 0, shopee_option_name: personalizada.nome }),
    escolha: personalizada,
  });
  return itensSemRepetir(itens);
}

function SelectDaVariante({
  variante,
  link,
  daSeed,
  arvore,
  editavel,
  contexto,
  onEscolher,
}: {
  variante: VarianteOferecida;
  link: LinkVariacoesShopee;
  /** The stored entry this card stands for, whose rows stay offered; `null` when new. */
  daSeed: LinkVariacoesShopee | null;
  arvore: ArvoreDoCartao;
  editavel: boolean;
  contexto: ContextoDoVinculador;
  onEscolher: (escolha: EscolhaDaVarianteShopee) => void;
}) {
  const itens = itensDaVariante(variante, link, daSeed, arvore, contexto.nomeDaVariante);
  const atual = escolhaAtualDaVariante(link, variante.id);
  let valor: string | null = null;
  if (atual.tipo === 'nenhuma') valor = VALOR_SEM_OPCAO;
  else if (atual.tipo === 'uma') valor = valorDaLinhaShopee(atual.linha);
  return (
    <Select
      label={`Opção da Shopee para «${contexto.nomeDaVariante(variante.id)}»`}
      data={itens.map((i) => ({ value: i.value, label: i.label, disabled: i.escolha === null }))}
      value={valor}
      onChange={(v) => {
        const escolha = itens.find((i) => i.value === v)?.escolha;
        if (escolha) onEscolher(escolha);
      }}
      disabled={!editavel}
      allowDeselect={false}
      searchable
    />
  );
}

/* -------------------------------------------------------------------------- */
/*                        What every kind of element shares                    */
/* -------------------------------------------------------------------------- */

function CabecalhoDoVinculo({
  titulo,
  item,
  contexto,
}: {
  titulo: string | null;
  item: ItemVinculoShopee;
  contexto: ContextoDoVinculador;
}) {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Group gap="xs">
        {titulo !== null && <Text fw={500}>{titulo}</Text>}
        {item.tipo === TIPO_ITEM_VINCULO_SHOPEE.personalizada && (
          <Badge variant="light">Personalizada</Badge>
        )}
        {item.tipo !== TIPO_ITEM_VINCULO_SHOPEE.ilegivel && item.gemea && (
          <Badge color="orange" variant="light">
            Não lido pela publicação
          </Badge>
        )}
        {item.removida && (
          <Badge color="red" variant="light">
            Será removido
          </Badge>
        )}
      </Group>
      {!contexto.disabled && <BotaoRemocaoShopee item={item} contexto={contexto} />}
    </Group>
  );
}

function BotaoRemocaoShopee({
  item,
  contexto,
}: {
  item: ItemVinculoShopee;
  contexto: ContextoDoVinculador;
}) {
  const alternar = () =>
    contexto.onChange(removerVinculoShopee(contexto.lista, item.indice, contexto.seedLinks));
  return item.removida ? (
    <Button
      size="xs"
      variant="subtle"
      leftSection={<IconArrowBackUp size={14} />}
      onClick={alternar}
    >
      Desfazer remoção
    </Button>
  ) : (
    <Button
      size="xs"
      variant="subtle"
      color="red"
      leftSection={<IconTrash size={14} />}
      onClick={alternar}
    >
      Remover vínculo
    </Button>
  );
}

/**
 * A conflict merge's note, a staged removal's warnings and this element's findings.
 * ⚠️ `chave-repetida`'s sentence says ANOTHER entry comes first, so it shows on the
 * twin alone, though it names both.
 */
function AvisosDoVinculo({
  item,
  achadosDaLeitura,
  contaPublicavel,
  somenteLeitura,
  contexto,
}: {
  item: ItemVinculoShopee;
  achadosDaLeitura: readonly AchadoVinculoShopee[];
  /**
   * A publication may read this element's conta: an active or inactive Shopee conta, or
   * one the conta list has not answered for yet. Gates the staged-removal warnings.
   */
  contaPublicavel: boolean;
  /** The card offers nothing to choose (`CartaoDoAchadoShopee`). */
  somenteLeitura: boolean;
  contexto: ContextoDoVinculador;
}) {
  const gemea = item.tipo !== TIPO_ITEM_VINCULO_SHOPEE.ilegivel && item.gemea;
  const achados = [
    ...contexto.achados.filter(
      (a) =>
        a.indices.includes(item.indice) && (a.tipo !== TIPO_ACHADO_SHOPEE.chaveRepetida || gemea),
    ),
    ...achadosDaLeitura,
  ];
  const avisosDaRemocao =
    item.removida && contaPublicavel
      ? avisosDaRemocaoShopee(contexto.valor, item.indice, contexto.variantes)
      : [];
  return (
    <>
      {item.conflito === CONFLITO_VINCULO_SHOPEE.alterado && (
        <Alert color="yellow">
          Alterado enquanto você editava (por outra pessoa ou pela importação): esta é a versão
          gravada. Refaça a sua alteração, se ainda quiser.
        </Alert>
      )}
      {item.conflito === CONFLITO_VINCULO_SHOPEE.removido && (
        <Alert color="orange">
          Removido enquanto você o alterava: será descartado ao salvar. Altere-o de novo para
          mantê-lo.
        </Alert>
      )}
      {avisosDaRemocao.map((aviso, i) => (
        <Alert key={`${aviso.tipo}-${String(i)}`} color="orange" variant="light" p="xs">
          <Text size="sm">{mensagemDoAvisoDeRemocaoShopee(aviso)}</Text>
        </Alert>
      ))}
      {achados.map((achado, i) => (
        <Alert
          key={`${achado.tipo}-${String(i)}`}
          color={achado.bloqueia ? 'red' : 'yellow'}
          variant="light"
          p="xs"
        >
          <Text size="sm">
            {mensagemDoAchadoShopee(achado, contexto.nomeDaVariante, { somenteLeitura })}
          </Text>
        </Alert>
      ))}
    </>
  );
}

/**
 * An element no `Select` edits: a custom entry, one of another conta, an unreadable
 * one. `conta` says whose it is where the block around it does not (`null` inside one).
 */
function VinculoSomenteLeitura({
  item,
  conta,
  contaPublicavel,
  contexto,
}: {
  item: ItemVinculoShopee;
  conta: string | null;
  /** See `AvisosDoVinculo`. */
  contaPublicavel: boolean;
  contexto: ContextoDoVinculador;
}) {
  const link = item.tipo === TIPO_ITEM_VINCULO_SHOPEE.ilegivel ? null : item.link;
  const titulo = link === null ? null : `${link.name} (${String(link.category_id)})`;
  const camposRecusados =
    item.tipo === TIPO_ITEM_VINCULO_SHOPEE.ilegivel && item.campos.length > 0
      ? ` (campos: ${item.campos.join(', ')})`
      : '';
  return (
    <Paper
      withBorder
      p="xs"
      role="group"
      aria-label={titulo ?? `Vínculo ilegível ${String(item.indice + 1)}`}
      data-testid={`vinculo-shopee-leitura-${String(item.indice)}`}
      style={
        item.removida ? { opacity: 0.55, borderColor: 'var(--mantine-color-red-6)' } : undefined
      }
    >
      <Stack gap="xs">
        <CabecalhoDoVinculo titulo={titulo} item={item} contexto={contexto} />
        {conta !== null && (
          <Text size="xs" c="dimmed">
            {conta}
          </Text>
        )}
        {item.tipo === TIPO_ITEM_VINCULO_SHOPEE.ilegivel && (
          <Text size="sm" c="red">
            {`Vínculo ilegível${camposRecusados}. Enquanto ele existir, este grupo não pode ser salvo — remova-o (você pode recriá-lo em seguida).`}
          </Text>
        )}
        {item.tipo === TIPO_ITEM_VINCULO_SHOPEE.personalizada && (
          <Text size="sm">
            Vínculo personalizado (gravado pela importação): as opções levam o nome guardado em cada
            uma (sem opção guardada, o da variante) e não há o que vincular aqui.
          </Text>
        )}
        {item.tipo === TIPO_ITEM_VINCULO_SHOPEE.padrao && (
          <Text size="sm">{`Variação ${String(item.link.variation_id)}`}</Text>
        )}
        {link?.variationOptions.map((opcao, i) => (
          <Text key={`${String(opcao.shopee_option_id)}-${String(i)}`} size="sm">
            {`${rotuloDaLinhaShopee(opcao)} → ${opcao.arakene_variation_id.map(contexto.nomeDaVariante).join(', ')}`}
          </Text>
        ))}
        <AvisosDoVinculo
          item={item}
          achadosDaLeitura={[]}
          contaPublicavel={contaPublicavel}
          somenteLeitura
          contexto={contexto}
        />
      </Stack>
    </Paper>
  );
}

/**
 * Whose a read-only element is. An id is "não reconhecida" only against a conta list
 * that WAS read: while it loads or failed, the conta may well exist.
 */
function rotuloDaConta(
  conta: string | null,
  contas: ReadonlyMap<string, Integracao>,
  statusContas: IntegracoesStatus,
): string {
  if (conta === null) return 'sem conta';
  if (statusContas === 'pending') return `conta ${conta} (lendo a lista de contas…)`;
  if (statusContas === 'error') return `conta ${conta} (lista de contas indisponível)`;
  const doc = contas.get(conta);
  if (doc === undefined) return `conta não reconhecida (${conta})`;
  if (doc.tipo !== INTEGRACAO_TIPO.shopee) return `${doc.nome} (não é uma conta da Shopee)`;
  return doc.ativo === true ? doc.nome : `${doc.nome} (inativa)`;
}

function OutrosVinculosShopee({
  itens,
  contas,
  statusContas,
  contexto,
}: {
  itens: readonly ItemVinculoShopee[];
  contas: ReadonlyMap<string, Integracao>;
  statusContas: IntegracoesStatus;
  contexto: ContextoDoVinculador;
}) {
  return (
    <Paper withBorder p="sm" data-testid="vinculador-shopee-outras">
      <Stack gap="xs">
        {/* Until the list is read these may be the active conta's own entries. */}
        {statusContas === 'success' && (
          <Stack gap={0}>
            <Text fw={600}>Vínculos de outras contas</Text>
            <Text size="xs" c="dimmed">
              Contas inativas, que não existem mais ou que não são da Shopee, e vínculos que não
              nomeiam uma conta. Os vínculos são mantidos e podem ser removidos.
            </Text>
          </Stack>
        )}
        {itens.map((item) => (
          <VinculoSomenteLeitura
            key={item.indice}
            item={item}
            conta={rotuloDaConta(item.chave?.integracaoId ?? null, contas, statusContas)}
            // An inactive Shopee conta, or a list not read (yet): a publication may read
            // it. A conta that is not Shopee's, or does not exist, is read by none.
            contaPublicavel={
              statusContas !== 'success' ||
              contas.get(item.chave?.integracaoId ?? '')?.tipo === INTEGRACAO_TIPO.shopee
            }
            contexto={contexto}
          />
        ))}
      </Stack>
    </Paper>
  );
}
