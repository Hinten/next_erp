'use client';

import { useEffect, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import { useFormContext, useWatch } from 'react-hook-form';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconArrowBackUp, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import {
  INTEGRACAO_TIPO,
  TIPO_CONFLITO_LINK_LI,
  TIPO_ENTRADA_LINK_LI,
  lerLinksVariacoesLi,
  type ConflitoLinkLi,
  type GradeCatalogoLi,
  type Integracao,
  type LinkVariacoesLi,
} from '@delfrance/schemas';
import { useSectionActive, type FieldRenderProps } from '@delfrance/ui';

import { useIntegracoes, type IntegracoesStatus } from '@/lib/data/useIntegracoes';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import {
  descreverFalhaCatalogoLi,
  mensagemBackendCatalogoIndisponivel,
  useGradeLi,
  useGradesLi,
} from '@/lib/loja-integrada/catalogo';
import { usePublicarSeedVinculadorLi } from './estadoVinculadorLi';
import {
  CONFLITO_VINCULO_LI,
  achadosDoVinculadorLi,
  agruparVinculosLi,
  alternarRemocaoLi,
  definirVariantesDaOpcaoLi,
  idsDasVariantesLi,
  mensagemDoConflitoLi,
  nomesDasVariantesLi,
  novoVinculoLi,
  substituirEntradaLi,
  type ItemVinculoLi,
  type OpcaoDoVinculadorLi,
} from './vinculadorLi';

/**
 * The "Loja Integrada" tab of a variation group (master plan step 10): the
 * `renderInput` of `linksVariacoesli`. Per ACTIVE Loja Integrada conta, the
 * operator links this group to the store's grades and assigns the group's
 * variantes to each grade option.
 *
 * Its conduct — nothing here is thrown away without a click:
 *  - every stored entry is shown, and none is dropped; another or unknown conta's
 *    entries and invalid ones are listed apart, read-only, each with a staged
 *    "Remover vínculo", and carried back unchanged by any other edit;
 *  - when the store cannot be read (until the cutover the backend refuses every
 *    read), the stored links show with their stored names and stay editable as
 *    far as variante assignment goes; adding a link needs the grade list;
 *  - a stored grade or option the store no longer lists is marked "não
 *    encontrada na loja", never pruned;
 *  - an option that loses its last variante leaves the entry as it is edited,
 *    while its row stays on screen;
 *  - not gated on the channel being switched on: the links are ERP data.
 *
 * The store is read only while this tab is the active one. The form's seed is
 * published for the page's `validate` on every reset (see `estadoVinculadorLi`).
 */
export function VinculadorLojaIntegrada({
  value,
  onChange,
  disabled,
  error,
}: Pick<FieldRenderProps, 'value' | 'onChange' | 'disabled' | 'error'>) {
  const { control, formState } = useFormContext();
  const seedLinks: unknown = formState.defaultValues?.linksVariacoesli;
  const seedVariacoes: unknown = formState.defaultValues?.variacoes;
  usePublicarSeedVinculadorLi(seedLinks, seedVariacoes);
  const variacoesVivas: unknown = useWatch({ control, name: 'variacoes' });
  // No `SectionTabs` around it (a test, a flat form) ⇒ always visible.
  const ativa = useSectionActive() !== false;
  const integracoes = useIntegracoes(getFirebaseFirestore());

  const contasLi = integracoes.rows.filter((r) => r.data.tipo === INTEGRACAO_TIPO.lojaIntegrada);
  const ativas = contasLi.filter((r) => r.data.ativo === true);
  const grupos = agruparVinculosLi(value, new Set(ativas.map((r) => r.id)));
  const seed = { links: seedLinks, variacoes: seedVariacoes };
  const achados = achadosDoVinculadorLi(value, variacoesVivas, seed);
  const nomes = nomesDasVariantesLi(variacoesVivas, seedVariacoes);
  const nomeDaVariante = (id: string) => nomes.get(id) ?? id;
  const lista: readonly unknown[] = Array.isArray(value) ? value : [];
  const contexto: ContextoDoVinculador = {
    lista,
    onChange,
    disabled: disabled === true,
    formatoInvalido: grupos.formatoInvalido,
    ativa,
    achados,
    nomeDaVariante,
    variantesOferecidas: idsDasVariantesLi(variacoesVivas),
    seedLinks,
  };
  // A user without the integrations read (`PERM.integracao.read`) is refused
  // the shared conta list itself, before any store read: say which permission.
  const semPermissao =
    integracoes.status === 'error' &&
    integracoes.query.error instanceof FirebaseError &&
    integracoes.query.error.code === 'permission-denied';

  return (
    <Stack gap="sm">
      {error && <Alert color="red">{error}</Alert>}
      {grupos.formatoInvalido && (
        <Alert color="red" title="Vínculos ilegíveis">
          <Stack gap="xs">
            <Text size="sm">
              Os vínculos da Loja Integrada guardados neste grupo não estão numa lista e não podem
              ser lidos nem salvos assim.
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
            ? 'Você está sem permissão para ler as contas da Loja Integrada: o seu cargo precisa ' +
              'da permissão de leitura de Integrações.'
            : 'Não foi possível ler as contas da Loja Integrada.'}{' '}
          Os vínculos guardados aparecem abaixo, sem edição.
        </Alert>
      )}
      {integracoes.status === 'success' && ativas.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhuma conta ativa da Loja Integrada.
        </Text>
      )}
      {ativas.map((conta) => (
        <BlocoContaLi
          key={conta.id}
          contaId={conta.id}
          nome={conta.data.nome}
          itens={grupos.porConta.get(conta.id) ?? []}
          contexto={contexto}
        />
      ))}
      {grupos.outras.length > 0 && (
        <OutrosVinculosLi
          itens={grupos.outras}
          contas={integracoes.byId}
          statusContas={integracoes.status}
          contexto={contexto}
        />
      )}
    </Stack>
  );
}

/** What every block and card of the tab reads. */
interface ContextoDoVinculador {
  /** The form's value as a list (`[]` when it is not one). */
  readonly lista: readonly unknown[];
  readonly onChange: (next: unknown) => void;
  readonly disabled: boolean;
  /**
   * The stored value is not a list: only the explicit "Substituir por uma lista
   * vazia" may replace it, so nothing that writes `lista` is offered.
   */
  readonly formatoInvalido: boolean;
  /** The tab is the active one: the store may be read. */
  readonly ativa: boolean;
  /** The tab's findings, on the form's indices. */
  readonly achados: readonly ConflitoLinkLi[];
  readonly nomeDaVariante: (id: string) => string;
  /** The group's variantes (live, minus any staged for deletion), in order. */
  readonly variantesOferecidas: readonly string[];
  /** The form's seed for this field. */
  readonly seedLinks: unknown;
}

function horaDe(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function BlocoContaLi({
  contaId,
  nome,
  itens,
  contexto,
}: {
  contaId: string;
  nome: string;
  itens: readonly ItemVinculoLi[];
  contexto: ContextoDoVinculador;
}) {
  const grades = useGradesLi(contaId, { habilitado: contexto.ativa });
  const [escolhida, setEscolhida] = useState<string | null>(null);
  // Each "Atualizar" click: the cards read their grade's options afresh too, so
  // an option created in the store's painel shows without waiting out a cache.
  const [rodadaDeAtualizacao, setRodadaDeAtualizacao] = useState(0);
  const daLoja = grades.dados?.grades;
  const podeAdicionar = daLoja !== undefined && !contexto.formatoInvalido;
  const jaVinculadas = new Set(
    itens.flatMap((i) =>
      i.entrada.tipo === TIPO_ENTRADA_LINK_LI.valida && !i.removida
        ? [i.entrada.link.grade_id]
        : [],
    ),
  );
  const porValor = new Map((daLoja ?? []).map((g) => [String(g.id), g]));
  const oferecidas = (daLoja ?? [])
    .filter((g) => !jaVinculadas.has(g.id))
    .map((g) => ({ value: String(g.id), label: `${g.nome} (${String(g.id)})` }));
  const falha = grades.erro === null ? null : descreverFalhaCatalogoLi(grades.erro);

  function adicionar(): void {
    // A stored value that is not a list is replaced only by its own explicit button.
    if (contexto.formatoInvalido) return;
    const grade = escolhida === null ? undefined : porValor.get(escolhida);
    if (grade === undefined) return;
    contexto.onChange([...contexto.lista, novoVinculoLi(contaId, grade)]);
    setEscolhida(null);
  }

  function atualizar(): void {
    grades.atualizar();
    setRodadaDeAtualizacao((n) => n + 1);
  }

  return (
    <Paper
      withBorder
      p="sm"
      role="group"
      aria-label={nome}
      data-testid={`vinculador-li-conta-${contaId}`}
    >
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>{nome}</Text>
          <Group gap="xs">
            {grades.dados && (
              <Text size="xs" c="dimmed">
                lista lida às {horaDe(grades.dados.lidaEmMs)}
              </Text>
            )}
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconRefresh size={14} />}
              onClick={atualizar}
              loading={grades.lendo}
              disabled={grades.indisponivel !== null}
            >
              Atualizar
            </Button>
          </Group>
        </Group>
        {grades.indisponivel !== null && (
          <Alert color="orange">{mensagemBackendCatalogoIndisponivel(grades.indisponivel)}</Alert>
        )}
        {falha && <Alert color={falha.cor}>{falha.mensagem}</Alert>}
        {itens.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhum vínculo com esta loja.
          </Text>
        )}
        {itens.map((item) =>
          item.entrada.tipo === TIPO_ENTRADA_LINK_LI.valida ? (
            <CartaoVinculoLi
              key={item.indice}
              contaId={contaId}
              item={item}
              link={item.entrada.link}
              daLoja={daLoja}
              rodadaDeAtualizacao={rodadaDeAtualizacao}
              contexto={contexto}
            />
          ) : null,
        )}
        {!contexto.disabled && (
          <Group align="flex-end">
            <Select
              label="Grade da loja"
              placeholder={daLoja ? 'Escolha uma grade' : 'Lista da loja indisponível'}
              data={oferecidas}
              value={escolhida}
              onChange={setEscolhida}
              disabled={!podeAdicionar}
              searchable
              style={{ flex: 1 }}
            />
            <Button
              leftSection={<IconPlus size={14} />}
              onClick={adicionar}
              disabled={!podeAdicionar || escolhida === null}
            >
              Adicionar vínculo
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

/** The same (conta, grade) entry in the form's seed, if any. */
function doSeed(seedLinks: unknown, link: LinkVariacoesLi): LinkVariacoesLi | null {
  for (const e of lerLinksVariacoesLi(seedLinks).entradas) {
    if (
      e.tipo === TIPO_ENTRADA_LINK_LI.valida &&
      e.link.integracaoLiId === link.integracaoLiId &&
      e.link.grade_id === link.grade_id
    )
      return e.link;
  }
  return null;
}

interface LinhaDeOpcaoLi extends OpcaoDoVinculadorLi {
  /** `false` when the store's grade was read and does not list it. */
  readonly naLoja: boolean;
}

/**
 * The option rows of a link: the store's options in the store's order, then
 * any option the entry or its seed holds that the store did not list — so an
 * option keeps its row after its last variante is cleared, and a stale one shows.
 */
function linhasDeOpcao(
  link: LinkVariacoesLi,
  daSeed: LinkVariacoesLi | null,
  daLoja: readonly { readonly id: number; readonly nome: string }[] | undefined,
): LinhaDeOpcaoLi[] {
  const linhas: LinhaDeOpcaoLi[] = [];
  const vistas = new Set<number>();
  for (const o of daLoja ?? []) {
    if (vistas.has(o.id)) continue;
    vistas.add(o.id);
    linhas.push({ id: o.id, nome: o.nome, naLoja: true });
  }
  for (const o of [...link.variationOptions, ...(daSeed?.variationOptions ?? [])]) {
    if (vistas.has(o.li_option_id)) continue;
    vistas.add(o.li_option_id);
    linhas.push({ id: o.li_option_id, nome: o.li_option_name, naLoja: daLoja === undefined });
  }
  return linhas;
}

function CartaoVinculoLi({
  contaId,
  item,
  link,
  daLoja,
  rodadaDeAtualizacao,
  contexto,
}: {
  contaId: string;
  item: ItemVinculoLi;
  link: LinkVariacoesLi;
  daLoja: readonly GradeCatalogoLi[] | undefined;
  /** Bumped by the block's "Atualizar": read this grade afresh as well. */
  rodadaDeAtualizacao: number;
  contexto: ContextoDoVinculador;
}) {
  const gradeDaLoja = daLoja?.find((g) => g.id === link.grade_id);
  const naoEncontrada = daLoja !== undefined && gradeDaLoja === undefined;
  // One grade's options are read only once the store's list holds that grade:
  // a list that failed already says why (above), and a grade the store no
  // longer lists has nothing to read.
  const lerDetalhe = contexto.ativa && !item.removida && gradeDaLoja !== undefined;
  const detalhe = useGradeLi(contaId, link.grade_id, { habilitado: lerDetalhe });
  // Once per "Atualizar" click, and only for a card that reads its grade; a card
  // mounted after the click starts at the current round, so it inherits nothing.
  const rodadaVista = useRef(rodadaDeAtualizacao);
  const atualizarDetalhe = detalhe.atualizar;
  useEffect(() => {
    if (rodadaVista.current === rodadaDeAtualizacao) return;
    rodadaVista.current = rodadaDeAtualizacao;
    if (lerDetalhe) atualizarDetalhe();
  }, [rodadaDeAtualizacao, lerDetalhe, atualizarDetalhe]);
  const rotulo = gradeDaLoja?.nome ?? link.name ?? `grade #${String(link.grade_id)}`;
  const linhas = linhasDeOpcao(link, doSeed(contexto.seedLinks, link), detalhe.dados?.opcoes);
  const falhaDetalhe =
    detalhe.erro === null || gradeDaLoja === undefined
      ? null
      : descreverFalhaCatalogoLi(detalhe.erro);
  const editavel = !contexto.disabled && !item.removida;
  const meus = contexto.achados.filter((a) => a.indices.includes(item.indice));

  function definir(opcao: OpcaoDoVinculadorLi, variantes: string[]): void {
    const nova = definirVariantesDaOpcaoLi(item.bruto, opcao, variantes);
    contexto.onChange(substituirEntradaLi(contexto.lista, item.indice, nova));
  }

  return (
    <Paper
      withBorder
      p="xs"
      role="group"
      aria-label={`${rotulo} (${String(link.grade_id)})`}
      data-testid={`vinculo-li-${contaId}-${String(link.grade_id)}`}
      style={
        item.removida ? { opacity: 0.55, borderColor: 'var(--mantine-color-red-6)' } : undefined
      }
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Text fw={500}>
              {rotulo} ({String(link.grade_id)})
            </Text>
            {naoEncontrada && (
              <Badge color="orange" variant="light">
                não encontrada na loja
              </Badge>
            )}
            {item.removida && (
              <Badge color="red" variant="light">
                Será removido
              </Badge>
            )}
          </Group>
          {!contexto.disabled && (
            <BotaoRemocaoLi
              removida={item.removida}
              onClick={() => contexto.onChange(alternarRemocaoLi(contexto.lista, item.indice))}
            />
          )}
        </Group>
        {item.conflito === CONFLITO_VINCULO_LI.alterado && (
          <Alert color="yellow">
            Alterado por outra pessoa enquanto você editava: esta é a versão dela. Refaça a sua
            alteração, se ainda quiser.
          </Alert>
        )}
        {item.conflito === CONFLITO_VINCULO_LI.removido && (
          <Alert color="orange">
            Removido por outra pessoa enquanto você o alterava: será descartado ao salvar. Altere-o
            de novo para mantê-lo.
          </Alert>
        )}
        {falhaDetalhe && !item.removida && (
          <Alert color={falhaDetalhe.cor} variant="light">
            {falhaDetalhe.mensagem}
          </Alert>
        )}
        {linhas.map((linha) => (
          <LinhaOpcaoLi
            key={linha.id}
            linha={linha}
            selecionadas={
              link.variationOptions.find((o) => o.li_option_id === linha.id)
                ?.arakene_variation_id ?? []
            }
            editavel={editavel}
            contexto={contexto}
            onChange={(ids) => definir(linha, ids)}
          />
        ))}
        {meus.map((a) => (
          <AchadoLi
            key={`${a.tipo}:${a.indices.join(',')}:${String(a.varianteId)}:${String(a.opcaoId)}`}
            achado={a}
            contexto={contexto}
          />
        ))}
      </Stack>
    </Paper>
  );
}

function LinhaOpcaoLi({
  linha,
  selecionadas,
  editavel,
  contexto,
  onChange,
}: {
  linha: LinhaDeOpcaoLi;
  selecionadas: readonly string[];
  editavel: boolean;
  contexto: ContextoDoVinculador;
  onChange: (ids: string[]) => void;
}) {
  const rotulo = linha.nome ?? `opção #${String(linha.id)}`;
  const oferecidas = new Set(contexto.variantesOferecidas);
  const data = [
    ...contexto.variantesOferecidas.map((id) => ({
      value: id,
      label: contexto.nomeDaVariante(id),
    })),
    // A selected id the group no longer offers stays visible, named as such.
    ...selecionadas
      .filter((id) => !oferecidas.has(id))
      .map((id) => ({ value: id, label: `${contexto.nomeDaVariante(id)} (excluída)` })),
  ];
  return (
    <Group align="flex-end" wrap="nowrap" gap="xs">
      <MultiSelect
        label={`Variantes da opção ${rotulo}`}
        data={data}
        value={[...selecionadas]}
        onChange={onChange}
        disabled={!editavel}
        searchable
        clearable
        clearButtonProps={{ 'aria-label': `Limpar variantes da opção ${rotulo}` }}
        style={{ flex: 1 }}
      />
      {!linha.naLoja && (
        <Badge color="orange" variant="light" mb={8}>
          não encontrada na loja
        </Badge>
      )}
    </Group>
  );
}

function AchadoLi({
  achado,
  contexto,
}: {
  achado: ConflitoLinkLi;
  contexto: ContextoDoVinculador;
}) {
  const aviso = achado.tipo === TIPO_CONFLITO_LINK_LI.opcaoComVariasVariantes;
  const mensagem = mensagemDoConflitoLi(achado, contexto.nomeDaVariante);
  return (
    <Text size="sm" c={aviso ? 'yellow' : 'red'}>
      {mensagem}
      {!aviso && !achado.bloqueia && ' (vínculo guardado assim; não impede salvar)'}
    </Text>
  );
}

function BotaoRemocaoLi({ removida, onClick }: { removida: boolean; onClick: () => void }) {
  return removida ? (
    <Tooltip label="Desfazer remoção">
      <ActionIcon variant="subtle" color="blue" onClick={onClick} aria-label="Desfazer remoção">
        <IconArrowBackUp size={16} />
      </ActionIcon>
    </Tooltip>
  ) : (
    <Tooltip label="Remover vínculo">
      <ActionIcon variant="subtle" color="red" onClick={onClick} aria-label="Remover vínculo">
        <IconTrash size={16} />
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * What a read-only line says about whose entry it is. An id is "não
 * reconhecida" only against a conta list that WAS read: while it loads or
 * failed, the conta may well exist.
 */
function rotuloDaConta(
  conta: unknown,
  contas: ReadonlyMap<string, Integracao>,
  statusContas: IntegracoesStatus,
): string {
  if (typeof conta !== 'string') return 'sem conta';
  if (statusContas === 'pending') return `conta ${conta} (lendo a lista de contas…)`;
  if (statusContas === 'error') return `conta ${conta} (lista de contas indisponível)`;
  const doc = contas.get(conta);
  if (doc === undefined) return `conta não reconhecida (${conta})`;
  if (doc.tipo !== INTEGRACAO_TIPO.lojaIntegrada) {
    return `${doc.nome} (não é uma conta da Loja Integrada)`;
  }
  return doc.ativo === true ? doc.nome : `${doc.nome} (inativa)`;
}

function OutrosVinculosLi({
  itens,
  contas,
  statusContas,
  contexto,
}: {
  itens: readonly ItemVinculoLi[];
  contas: ReadonlyMap<string, Integracao>;
  statusContas: IntegracoesStatus;
  contexto: ContextoDoVinculador;
}) {
  return (
    <Paper withBorder p="sm" data-testid="vinculador-li-outras">
      <Stack gap="xs">
        <Text fw={600}>Outras contas / vínculos ilegíveis</Text>
        <Text size="xs" c="dimmed">
          Guardados como estão: aqui só podem ser removidos.
        </Text>
        {itens.map((item) => {
          const e = item.entrada;
          const descricao =
            e.tipo === TIPO_ENTRADA_LINK_LI.valida
              ? `${e.link.name ?? `grade #${String(e.link.grade_id)}`} (${String(e.link.grade_id)}) · ` +
                `${String(e.link.variationOptions.length)} opção(ões)`
              : `vínculo ilegível${e.campos.length === 0 ? '' : ` (campos: ${e.campos.join(', ')})`}`;
          const conta =
            e.tipo === TIPO_ENTRADA_LINK_LI.valida
              ? e.link.integracaoLiId
              : typeof e.bruto === 'object' && e.bruto !== null && !Array.isArray(e.bruto)
                ? (e.bruto as Record<string, unknown>).integracaoLiId
                : undefined;
          const meus = contexto.achados.filter((a) => a.indices.includes(item.indice));
          const daConta = rotuloDaConta(conta, contas, statusContas);
          return (
            <Group
              key={item.indice}
              justify="space-between"
              wrap="nowrap"
              role="group"
              aria-label={`${descricao} — ${daConta}`}
              data-testid={`vinculo-li-outro-${String(item.indice)}`}
              style={item.removida ? { opacity: 0.55 } : undefined}
            >
              <Stack gap={0}>
                <Text size="sm" c={e.tipo === TIPO_ENTRADA_LINK_LI.invalida ? 'red' : undefined}>
                  {descricao}
                </Text>
                <Text size="xs" c="dimmed">
                  {daConta}
                </Text>
                {meus.map((a) => (
                  <AchadoLi
                    key={`${a.tipo}:${a.indices.join(',')}:${String(a.varianteId)}`}
                    achado={a}
                    contexto={contexto}
                  />
                ))}
              </Stack>
              <Group gap="xs" wrap="nowrap">
                {item.removida && (
                  <Badge color="red" variant="light">
                    Será removido
                  </Badge>
                )}
                {!contexto.disabled && (
                  <BotaoRemocaoLi
                    removida={item.removida}
                    onClick={() =>
                      contexto.onChange(alternarRemocaoLi(contexto.lista, item.indice))
                    }
                  />
                )}
              </Group>
            </Group>
          );
        })}
      </Stack>
    </Paper>
  );
}
