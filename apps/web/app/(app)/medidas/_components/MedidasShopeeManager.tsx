'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { Firestore } from 'firebase/firestore';
import type { UseQueryResult } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import {
  ESTADO_LISTA_SHOPEE,
  INTEGRACAO_TIPO,
  MOTIVO_ENTRADA_SHOPEE_ILEGIVEL,
  type EntradaTabelaShopee,
  type MotivoEntradaShopeeIlegivel,
} from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { valuesEqual } from '@delfrance/ui';

import {
  rotuloCategoriaShopee,
  useCategoriasShopee,
} from '@/components/shopee/ShopeeCategoriaBrowser';
import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { useShopeeClient } from '@/lib/shopee/client';
import {
  CODIGO_FALHA_SHOPEE,
  MENSAGEM_TABELA_INEXISTENTE,
  codigoDaFalhaShopee,
  descreverFalhaShopee,
} from '@/lib/shopee/erros';
import {
  PAPEL_DA_LINHA,
  adicionarOuSubstituir,
  entradasDeContasAusentes,
  linhasDaConta,
  marcarRemocao,
  type LinhaTabelaShopeeForm,
} from '@/lib/shopee/tabelasMedidasForm';
import type { DetalheTabelaMedidasDto, RespostaCategoriasShopee } from '@/lib/shopee/wire';

import { EscolherTabelaShopeeModal, useDetalheTabelaShopee } from './EscolherTabelaShopeeModal';
import { TabelaShopeeGrid } from './TabelaShopeeGrid';

/** The ML tab's bound (`MedidasMercadoLivreManager`): one query, no paging. */
const MAX_CONTAS = 50;

export interface MedidasShopeeManagerProps {
  db: Firestore;
  /** The FORM's `tabelasMedidasShopee` — what "Salvar alterações" will write. */
  value: unknown;
  /** The field's `onChange`: every staged edit hands back the WHOLE map. */
  onChange: (next: unknown) => void;
  disabled?: boolean;
}

/**
 * Where the open modal will land its pick. `trocar` remembers the entry the
 * operator clicked, so a list that changed under the open modal is noticed
 * instead of overwritten (see {@link MedidasShopeeManager}'s `confirmar`).
 */
type AlvoAberto =
  | { readonly tipo: 'adicionar' }
  | {
      readonly tipo: 'trocar';
      readonly indice: number;
      readonly entradaAntes: EntradaTabelaShopee;
    };

interface ModalAberto {
  readonly integracaoId: string;
  readonly contaNome: string;
  readonly alvo: AlvoAberto;
}

/** Operator words for why a stored OBJECT entry is unreadable. */
const ROTULO_MOTIVO_ILEGIVEL = {
  [MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.entradaInvalida]: 'não é uma entrada',
  [MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.categoriaInvalida]: 'categoria inválida',
  [MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.tabelaInvalida]: 'id da tabela inválido',
  [MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.nomeInvalido]: 'nome inválido',
} as const satisfies Record<MotivoEntradaShopeeIlegivel, string>;

const AVISO_LISTA_MUDOU =
  'A lista desta conta mudou enquanto a janela estava aberta — nada foi trocado. Confira e escolha de novo.';

/**
 * What to do with an entry publish can never send: `montarAnuncio` refuses a
 * listing whose category is not a leaf of the conta's tree, so an entry in a
 * non-leaf or vanished category is dead weight — like a stale template.
 */
const ACAO_ENTRADA_MORTA = 'nunca é usada na publicação — troque ou remova';

/**
 * Per-conta value that is not a list (`lista-invalida`). The base schema takes
 * ANY per-conta value (a loosening, rule 8) and `prepareForSave` carries a
 * non-array verbatim, so the tabela still saves and the value rides along.
 */
const COPIA_LISTA_INVALIDA =
  'O valor guardado para esta conta não é legível e não pode ser editado aqui — ao salvar a tabela, ele é gravado de volta como está.';

/**
 * The whole field is not a map (`campo-invalido`). The base schema still
 * REFUSES that shape, and `ObjectView` validates the whole schema on save, so
 * no edit of this tabela can be saved while it is there — say so, never
 * "mantido como está".
 */
const COPIA_CAMPO_INVALIDO =
  'O valor guardado para a Shopee nesta tabela não é legível e não pode ser editado aqui — enquanto ele existir, a tabela não pode ser salva. Peça a correção do documento.';

/**
 * The medidas editor's **Shopee** tab (#1526, step 18): one card per Shopee
 * conta listing the size-chart TEMPLATE this tabela picks per Shopee category,
 * with Adicionar / Trocar / Remover.
 *
 * ## Everything is STAGED in the tabela's own form
 *
 * The entries live on `tabMedi.tabelasMedidasShopee[<integracaoId>]`, and this
 * component is that field's `renderInput`: `value` is the FORM's map and every
 * action hands a new map to `onChange`. Nothing is written here — "Salvar
 * alterações" writes the field through `ObjectView`'s save transaction, whose
 * #1757 baseline guard raises the conflict modal when the stored map changed
 * since load (root `CLAUDE.md` rule 7, tier 3). Removal is a mark with an undo
 * ("Será excluída"), applied by the field's `prepareForSave`
 * (`apps/web/CLAUDE.md` rule 7). Every map edit goes through
 * `lib/shopee/tabelasMedidasForm.ts`, which rebuilds ONLY this conta's array
 * and carries every other element and key verbatim (rule 8: the migrated
 * corpus is not ours to tidy).
 *
 * ⚠️ It never calls `onChange` on mount and never normalises the value — a
 * `null` stays `null`, a per-key `null` stays — so an untouched tab cannot
 * dirty the form (`medidas.cadastros.e2e.spec.ts` edits Descrição and expects
 * nothing else in the patch).
 *
 * ## Which row a listing gets is decided ONCE (#1369)
 *
 * A row's role ("ignorada — outra entrada desta categoria vem antes") comes from
 * `linhasDaConta`, which asks `indiceDaEntradaShopee` from `@delfrance/schemas` —
 * the selector publish resolves through. This file holds no selection rule.
 *
 * ## Shown, never hidden
 *
 * Every Shopee conta (inactive ones badged — hiding a card would hide stored
 * data), every stored element (an unreadable one is shown and kept; a non-object
 * one cannot even carry a mark, so it has no action), and a count of entries
 * under keys that name no conta. The live data on a row — the category path and
 * the template's name — comes from the backend through react-query; the ENTRIES
 * come from the form value only.
 */
export function MedidasShopeeManager({
  db,
  value,
  onChange,
  disabled = false,
}: MedidasShopeeManagerProps) {
  const { allowed: canRead, loading: permsLoading } = usePermission(PERM.integracao.read);
  const client = useShopeeClient();

  // Gated on the bit: `integracao` is integracao.read-protected while tabMedi
  // uses produto perms, so an editor without it would hit a raw Firestore
  // permission-denied. Null query → the snapshot stays idle.
  const contasQuery = useMemo(
    () =>
      canRead
        ? buildQuery(integracaoCollection.ref(db, {}), [
            whereEqual('tipo', INTEGRACAO_TIPO.shopee),
            limit(MAX_CONTAS),
          ])
        : null,
    [db, canRead],
  );
  const contasSnap = useSnapshot(contasQuery);

  const [modal, setModal] = useState<ModalAberto | null>(null);
  const [aviso, setAviso] = useState<{ integracaoId: string; texto: string } | null>(null);

  // ⚠️ The loading gate comes FIRST, and `permsLoading` belongs in it:
  // `usePermission` answers `allowed: false` while the claims resolve, so the
  // permission text below would flash at an operator who has the bit.
  if (permsLoading || contasSnap.loading) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  }

  if (!canRead) {
    return (
      <Text size="sm" c="dimmed">
        Requer permissão de leitura em integrações para ver as contas Shopee.
      </Text>
    );
  }

  if (contasSnap.error) {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar as contas Shopee: {contasSnap.error.message}
      </Alert>
    );
  }

  const contas = contasSnap.data ?? [];
  const ausentes = entradasDeContasAusentes(value, new Set(contas.map((c) => c.id)));
  // The modal reads categories and templates through the client; without one
  // (signed out) nothing could be picked.
  const editavel = !disabled && client !== null;

  function abrir(next: ModalAberto): void {
    setAviso(null);
    setModal(next);
  }

  function remover(integracaoId: string, indice: number, marcar: boolean): void {
    setAviso(null);
    onChange(marcarRemocao(value, integracaoId, indice, marcar));
  }

  /**
   * Land the modal's pick. `adicionar` re-derives its target from the CURRENT
   * value (Q6: the category's active row is replaced, else appended), so it
   * cannot go stale. `trocar` targets an index chosen when the modal opened:
   * if that slot no longer holds the entry the operator clicked — the form was
   * re-seeded from server truth meanwhile — replacing it would silently swap a
   * DIFFERENT entry, so nothing is staged and the operator is told (tier 3).
   */
  function confirmar(aberto: ModalAberto, entrada: EntradaTabelaShopee): void {
    setModal(null);
    const { alvo, integracaoId } = aberto;
    if (alvo.tipo === 'adicionar') {
      onChange(adicionarOuSubstituir(value, integracaoId, entrada, { tipo: 'adicionar' }));
      return;
    }
    const atual = linhasDaConta(value, integracaoId).linhas.find((l) => l.indice === alvo.indice);
    if (
      atual === undefined ||
      atual.entrada === null ||
      atual.marcada ||
      !valuesEqual(atual.entrada, alvo.entradaAntes)
    ) {
      setAviso({ integracaoId, texto: AVISO_LISTA_MUDOU });
      return;
    }
    onChange(
      adicionarOuSubstituir(value, integracaoId, entrada, { tipo: 'trocar', indice: alvo.indice }),
    );
  }

  return (
    <Stack gap="sm" data-testid="shopee-medidas-manager">
      <Text size="sm" c="dimmed">
        A tabela escolhida por categoria é enviada ao anúncio na publicação. As alterações desta aba
        são gravadas ao salvar a tabela.
      </Text>
      <Text size="sm" c="dimmed">
        Sem tabela para a categoria do anúncio, vai no lugar a primeira foto desta tabela de medidas
        — a menos que a Shopee informe que a categoria não aceita foto.
      </Text>

      {contas.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhuma conta Shopee cadastrada.{' '}
          <Anchor component={Link} href="/canais/shopee" size="sm">
            Cadastrar em Canais de venda
          </Anchor>
          .
        </Text>
      )}

      {contas.map((conta) => {
        const { estado, linhas } = linhasDaConta(value, conta.id);
        const podeEditarLista =
          estado === ESTADO_LISTA_SHOPEE.lista || estado === ESTADO_LISTA_SHOPEE.semLista;
        const nome = conta.data.nome;
        return (
          <Card
            key={conta.id}
            withBorder
            padding="md"
            data-testid={`shopee-medida-conta-${conta.id}`}
          >
            <Stack gap="sm">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs">
                  <Text fw={600}>{nome}</Text>
                  {conta.data.ativo === false && (
                    <Badge color="gray" variant="light">
                      inativa
                    </Badge>
                  )}
                </Group>
                {podeEditarLista && (
                  <Button
                    size="xs"
                    variant="light"
                    disabled={!editavel}
                    onClick={() =>
                      abrir({
                        integracaoId: conta.id,
                        contaNome: nome,
                        alvo: { tipo: 'adicionar' },
                      })
                    }
                  >
                    Adicionar
                  </Button>
                )}
              </Group>

              {aviso?.integracaoId === conta.id && (
                <Alert color="yellow" variant="light" data-testid="shopee-medida-aviso">
                  <Text size="sm">{aviso.texto}</Text>
                </Alert>
              )}

              {estado === ESTADO_LISTA_SHOPEE.campoInvalido && (
                <Text size="sm" c="red">
                  {COPIA_CAMPO_INVALIDO}
                </Text>
              )}
              {estado === ESTADO_LISTA_SHOPEE.listaInvalida && (
                <Text size="sm" c="dimmed">
                  {COPIA_LISTA_INVALIDA}
                </Text>
              )}
              {podeEditarLista && linhas.length === 0 && (
                <Text size="sm" c="dimmed">
                  Nenhuma tabela escolhida para esta conta.
                </Text>
              )}

              {linhas.map((linha) =>
                linha.entrada === null ? (
                  <LinhaIlegivel
                    key={linha.indice}
                    integracaoId={conta.id}
                    linha={linha}
                    editavel={editavel}
                    onMarcar={(marcar) => remover(conta.id, linha.indice, marcar)}
                  />
                ) : (
                  <LinhaLegivel
                    key={linha.indice}
                    integracaoId={conta.id}
                    linha={linha}
                    entrada={linha.entrada}
                    editavel={editavel}
                    onMarcar={(marcar) => remover(conta.id, linha.indice, marcar)}
                    onTrocar={(entradaAntes) =>
                      abrir({
                        integracaoId: conta.id,
                        contaNome: nome,
                        alvo: { tipo: 'trocar', indice: linha.indice, entradaAntes },
                      })
                    }
                  />
                ),
              )}
            </Stack>
          </Card>
        );
      })}

      {ausentes > 0 && (
        <Text size="sm" c="dimmed" data-testid="shopee-medida-contas-ausentes">
          {`${String(ausentes)} entrada(s) de contas que não existem mais (mantidas)`}
        </Text>
      )}

      {modal !== null && (
        <EscolherTabelaShopeeModal
          integracaoId={modal.integracaoId}
          contaNome={modal.contaNome}
          alvo={
            modal.alvo.tipo === 'adicionar'
              ? { tipo: 'adicionar' }
              : {
                  tipo: 'trocar',
                  indice: modal.alvo.indice,
                  categoriaAtual: modal.alvo.entradaAntes.categoryId,
                }
          }
          linhas={linhasDaConta(value, modal.integracaoId).linhas}
          onConfirmar={(entrada) => confirmar(modal, entrada)}
          onFechar={() => setModal(null)}
        />
      )}
    </Stack>
  );
}

/** A row's frame: test id, role attribute (e2e hook), dimmed while marked. */
function QuadroDaLinha({
  integracaoId,
  linha,
  children,
}: {
  integracaoId: string;
  linha: LinhaTabelaShopeeForm;
  children: ReactNode;
}) {
  return (
    <Stack
      gap={4}
      data-testid={`shopee-medida-entrada-${integracaoId}-${String(linha.indice)}`}
      data-papel={linha.papel}
      style={linha.marcada ? { opacity: 0.55 } : undefined}
    >
      {children}
    </Stack>
  );
}

function BadgeSeraExcluida() {
  return (
    <Badge color="red" variant="light">
      Será excluída
    </Badge>
  );
}

/** A stored element the read slice could not read. Kept as stored; never queried. */
function LinhaIlegivel({
  integracaoId,
  linha,
  editavel,
  onMarcar,
}: {
  integracaoId: string;
  linha: LinhaTabelaShopeeForm;
  editavel: boolean;
  onMarcar: (marcar: boolean) => void;
}) {
  const motivo = linha.motivo === null ? null : ROTULO_MOTIVO_ILEGIVEL[linha.motivo];
  return (
    <QuadroDaLinha integracaoId={integracaoId} linha={linha}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap="xs">
          <Text size="sm">{`Entrada ilegível (posição ${String(linha.indice + 1)})`}</Text>
          {/* R-h: a non-object element cannot carry a mark — shown, kept, no action. */}
          {!linha.removivel ? (
            <Badge color="gray" variant="light">
              ilegível (mantida)
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              {`ilegível (${motivo ?? 'desconhecido'})`}
            </Badge>
          )}
          {linha.marcada && <BadgeSeraExcluida />}
        </Group>
        {linha.removivel && (
          <Button
            size="xs"
            variant="subtle"
            color={linha.marcada ? 'gray' : 'red'}
            disabled={!editavel}
            onClick={() => onMarcar(!linha.marcada)}
          >
            {linha.marcada ? 'Desfazer' : 'Remover'}
          </Button>
        )}
      </Group>
    </QuadroDaLinha>
  );
}

/** One readable entry: the live category path, the live template name, its role, its actions. */
function LinhaLegivel({
  integracaoId,
  linha,
  entrada,
  editavel,
  onMarcar,
  onTrocar,
}: {
  integracaoId: string;
  linha: LinhaTabelaShopeeForm;
  entrada: EntradaTabelaShopee;
  editavel: boolean;
  onMarcar: (marcar: boolean) => void;
  onTrocar: (entradaAntes: EntradaTabelaShopee) => void;
}) {
  const categoria = useCategoriasShopee(integracaoId, entrada.categoryId);
  const detalhe = useDetalheTabelaShopee(integracaoId, entrada.size_chart_id);
  const [verTabela, setVerTabela] = useState(false);
  const inexistente =
    detalhe.isError &&
    codigoDaFalhaShopee(detalhe.error) === CODIGO_FALHA_SHOPEE.tabelaMedidasInexistente;
  const morta = categoriaMorta(categoria);
  // Every entry publish can never send asks for the same act: Trocar, in red.
  const destacarTrocar = inexistente || morta !== null;
  const tabela = detalhe.data?.tabela;

  return (
    <QuadroDaLinha integracaoId={integracaoId} linha={linha}>
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <Stack gap={2}>
          <TextoDaCategoria entrada={entrada} consulta={categoria} morta={morta} />
          <Group gap="xs">
            <TextoDoModelo consulta={detalhe} inexistente={inexistente} />
            <Text span size="xs" c="dimmed">
              {`#${String(entrada.size_chart_id)}`}
            </Text>
            {linha.papel === PAPEL_DA_LINHA.ignoradaDuplicada && (
              <Badge color="yellow" variant="light">
                ignorada — outra entrada desta categoria vem antes
              </Badge>
            )}
            {linha.marcada && <BadgeSeraExcluida />}
          </Group>
        </Stack>
        <Group gap="xs" wrap="nowrap">
          {tabela !== undefined && (
            <Button size="xs" variant="subtle" onClick={() => setVerTabela((v) => !v)}>
              {verTabela ? 'Ocultar tabela' : 'Ver tabela'}
            </Button>
          )}
          {linha.marcada ? (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              disabled={!editavel}
              onClick={() => onMarcar(false)}
            >
              Desfazer
            </Button>
          ) : (
            <>
              <Button
                size="xs"
                variant={destacarTrocar ? 'filled' : 'light'}
                color={destacarTrocar ? 'red' : undefined}
                disabled={!editavel}
                onClick={() => onTrocar(entrada)}
              >
                Trocar
              </Button>
              <Button
                size="xs"
                variant="subtle"
                color="red"
                disabled={!editavel}
                onClick={() => onMarcar(true)}
              >
                Remover
              </Button>
            </>
          )}
        </Group>
      </Group>
      {verTabela && tabela !== undefined && <TabelaShopeeGrid tabela={tabela} />}
    </QuadroDaLinha>
  );
}

/** Why a row's category makes it dead weight for publish, or `null` while it may be sent. */
type CategoriaMorta = 'nao-folha' | 'fora-da-arvore';

/**
 * A legacy non-leaf category, or one the conta's tree no longer holds (404
 * `SHOPEE_CATEGORIA_DESCONHECIDA` — keyed on the code, never the status: a
 * rate limit or a backend predating the route is NOT a vanished category).
 * `null` while the read is pending, failed otherwise, or a leaf.
 */
function categoriaMorta(
  consulta: UseQueryResult<RespostaCategoriasShopee, unknown>,
): CategoriaMorta | null {
  const no = consulta.data?.no ?? null;
  if (no !== null) return no.isLeaf ? null : 'nao-folha';
  if (
    consulta.isError &&
    codigoDaFalhaShopee(consulta.error) === CODIGO_FALHA_SHOPEE.categoriaDesconhecida
  ) {
    return 'fora-da-arvore';
  }
  return null;
}

function AcaoEntradaMorta() {
  return (
    <Text span size="xs" c="red">
      {ACAO_ENTRADA_MORTA}
    </Text>
  );
}

/**
 * The category as the conta's tree has it now (root › … › leaf). Until it
 * answers — or when it cannot — the label stored at pick time stands in.
 */
function TextoDaCategoria({
  entrada,
  consulta,
  morta,
}: {
  entrada: EntradaTabelaShopee;
  consulta: UseQueryResult<RespostaCategoriasShopee, unknown>;
  morta: CategoriaMorta | null;
}) {
  const no = consulta.data?.no ?? null;
  // THE label (`rotuloCategoriaShopee`); a stored '' is "no name", never a blank.
  const guardado = rotuloCategoriaShopee({
    categoryId: entrada.categoryId,
    name: entrada.name === '' ? null : entrada.name,
    originalName: null,
  });
  const id = (
    <Text span size="xs" c="dimmed">
      {`#${String(entrada.categoryId)}`}
    </Text>
  );

  if (no !== null) {
    const caminho =
      no.pathFromRoot.length > 0
        ? no.pathFromRoot.map(rotuloCategoriaShopee).join(' › ')
        : rotuloCategoriaShopee(no);
    return (
      <Group gap="xs">
        <Text size="sm" fw={500}>
          {caminho}
        </Text>
        {id}
        {morta === 'nao-folha' && (
          <>
            <Badge color="orange" variant="light">
              categoria não-folha (legado)
            </Badge>
            <AcaoEntradaMorta />
          </>
        )}
      </Group>
    );
  }

  let nota: ReactNode = null;
  if (morta === 'fora-da-arvore') {
    nota = (
      <>
        <Text span size="xs" c="red">
          categoria não existe mais na árvore desta conta
        </Text>
        <AcaoEntradaMorta />
      </>
    );
  } else if (consulta.isError) {
    nota = (
      <Text span size="xs" c="dimmed">
        {
          descreverFalhaShopee(consulta.error, {
            desconhecido: 'Não foi possível ler a categoria.',
          }).mensagem
        }
      </Text>
    );
  }
  return (
    <Group gap="xs">
      <Text size="sm" fw={500}>
        {guardado}
      </Text>
      {id}
      {nota}
    </Group>
  );
}

/** The template's live name, or why there is none. */
function TextoDoModelo({
  consulta,
  inexistente,
}: {
  consulta: UseQueryResult<DetalheTabelaMedidasDto, unknown>;
  inexistente: boolean;
}) {
  if (consulta.data !== undefined) {
    return <Text size="sm">{consulta.data.tabela.sizeChartName ?? 'Sem nome'}</Text>;
  }
  if (inexistente) {
    return (
      <Text size="sm" c="red">
        {MENSAGEM_TABELA_INEXISTENTE}
      </Text>
    );
  }
  if (consulta.isError) {
    const { mensagem, repetivel } = descreverFalhaShopee(consulta.error, {
      desconhecido: 'Não foi possível ler esta tabela da Shopee.',
    });
    return (
      <Group gap="xs">
        <Text size="sm" c="dimmed">
          {mensagem}
        </Text>
        {repetivel && (
          <Button size="xs" variant="subtle" onClick={() => void consulta.refetch()}>
            Tentar de novo
          </Button>
        )}
      </Group>
    );
  }
  return consulta.isLoading ? <Loader size="xs" /> : null;
}
