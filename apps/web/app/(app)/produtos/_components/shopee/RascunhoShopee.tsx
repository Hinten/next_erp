'use client';

import type { KeyboardEvent } from 'react';
import { Alert, Button, Group, List, Stack, Text, TextInput, Textarea } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  CAMPO_RASCUNHO_SHOPEE,
  MAX_DESCRIPTION_RASCUNHO_SHOPEE,
  MAX_ITEM_NAME_RASCUNHO_SHOPEE,
  descreverFaixaShopee,
  pendenciasDoRascunhoShopee,
  textoNaFaixaShopee,
  textoUtilizavelShopee,
  type ArgsPendenciasRascunhoShopee,
  type CampoRascunhoShopee,
  type FaixaDto,
  type MarcaRascunhoShopee as ParMarcaRascunhoShopee,
} from '@delfrance/schemas';

import {
  FRASE_CATEGORIA_TRAVADA_SHOPEE,
  FRASE_LOGISTICA_RASCUNHO_SHOPEE,
  FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  FRASE_RASCUNHO_NOVO_SHOPEE,
  FRASE_VOLTAR_CATEGORIA_GRAVADA_SHOPEE,
  ROTULO_CAMPO_RASCUNHO_SHOPEE,
  textoDaPendenciaRascunhoShopee,
} from '@/lib/shopee/anuncioProduto';
import type {
  BlocoRascunhoShopee,
  CampoDoFormularioRascunhoShopee,
  DescarteDoRascunhoShopee,
  FormularioRascunhoShopee,
} from '@/lib/shopee/rascunho';

import { CategoriaRascunhoShopee } from './CategoriaRascunhoShopee';
import { MarcaRascunhoShopee, rotuloDaMarcaRascunhoShopee } from './MarcaRascunhoShopee';

/**
 * The two draft writes a block starts (DC §2.1). The editor's
 * `AcaoDoAnuncioShopee` (`AcoesAnuncioShopee.tsx`) gains exactly these
 * members, so its `emVoo` names a draft write the same way it names a publish.
 */
export type AcaoDoRascunhoShopee = 'salvar-rascunho' | 'descartar-rascunho';

/**
 * A sentence the last draft operation left on THIS block — never a success
 * (those are toasts). The editor keeps it (R2, keyed by link doc id) from
 * `falhaDoRascunhoShopee` (`@/lib/shopee/rascunho`): its `mensagem` arm as is,
 * its `largar` arm with `incerto: false`.
 */
export interface ResultadoDoRascunhoShopee {
  /** The sentence, verbatim (§C.2 copy from `@/lib/shopee/anuncioProduto`). */
  readonly mensagem: string;
  /** The operation MAY have happened (no answer, an unreadable 2xx, a 5xx): a "confira" notice, never a failure. */
  readonly incerto: boolean;
}

/**
 * The produto-side texts the pendências read — the STORED documents the
 * publish reads (`pendenciasDoRascunhoShopee`'s own argument names), never the
 * produto form's unsaved text.
 */
export type TextosDoProdutoRascunhoShopee = Pick<
  ArgsPendenciasRascunhoShopee,
  'nomeProduto' | 'descricaoProduto'
>;

export interface RascunhoShopeeProps {
  /** The Firestore handle — forwarded to the brand picker's shortlist listener (`useMarcasShopee`); supplied by the editor. */
  db: Firestore;
  /** The conta (`integracao` id) the draft belongs to — every taxonomy read and the shortlist are this conta's; `null` when the tab names no conta document that can answer (not found, an unreadable ref, still loading): then NOTHING is read — no tree, no shortlist listener — and the held category and brand show as plain text; supplied by the tab. */
  contaId: string | null;
  /** The conta's display name (`ContaShopee.nome`) — the brand picker's empty-shortlist sentence names it; supplied by the conta panel. */
  contaNome: string;
  /** The draft's link doc id (a stored draft's, or a local new one's minted id) — the test ids' suffix; supplied by the block. */
  linkDocId: string;
  /** THE block decision — `estadoDoBlocoRascunhoShopee({link, edicao, nowMs, kitVirtual, servidorConfirmado, podeEditar, ocupado})` with `nowMs` = `Date.now()` re-read on a timer of `releituraEmMs` (never the tab's frozen `agoraMs`); computed by the tab. */
  bloco: BlocoRascunhoShopee;
  /** The HELD projection's brand pair — §H Q1's "stored" brand: `projecaoGuardadaDoRascunhoShopee(edicao, link).marca` for a stored draft, `null` for a local new one; supplied by the tab. */
  marcaGuardada: ParMarcaRascunhoShopee | null;
  /** The STORED produto `nome` (`produtoSnap`) and `extraData/singleton.descricao` (rev. 2a #10's new `useDocSnapshot`), each `null` when absent — or `null` while either document has not answered (then no pendência is computed); supplied by the editor. */
  textosDoProduto: TextosDoProdutoRascunhoShopee | null;
  /** The EDITED category's title/description bands (`client.limitesDoItem({integracaoId, categoryId: bloco.valores.category_id}).limites`, requested only while that category is not `null`), or `null` while unknown — no category, loading or failed: no band pendência, no counter; supplied by the tab. */
  limites: ArgsPendenciasRascunhoShopee['limites'];
  /** The stale check — `divergenciasDoServidorShopee(edicao, link)` (`[]` for no entry, a local new draft or nothing to save): fields another writer changed since the entry was loaded, so the next Salvar will answer 409; supplied by the tab. */
  divergencias: readonly CampoRascunhoShopee[];
  /** `PERM.integracao.write` ∧ `PERM.produto.write` ∧ the produto form editable — the SAME flag the tab passes as `bloco`'s `podeEditar`; `false` ⇒ fields read-only and NO button renders (but see `somenteDescartar`). */
  podeEditar: boolean;
  /** The draft's conta document is GONE (a «não encontrada» tab whose id a document could carry) and the operator holds both bits: «Descartar» renders ALONE — enabled by `bloco.podeDescartar` — since the discard route needs only the link; nothing else is offered. Read only while `podeEditar` is `false`; supplied by the tab. */
  somenteDescartar: boolean;
  /** This link's draft write in flight (the editor's `emVoo` when it names this link and a draft action), else `null` — that button shows the spinner. */
  emVoo: AcaoDoRascunhoShopee | null;
  /** The last draft operation's sentence on this block (editor state, R2), or `null`. */
  resultado: ResultadoDoRascunhoShopee | null;
  /** One form field typed or picked: the editor creates the entry on the first one (`edicaoDoRascunhoGuardadoShopee`) and applies `comCampoRascunhoShopee`; fired only while `bloco.camposEditaveis` (`category_id` only while `bloco.categoriaEditavel`, or the held one put back while `bloco.podeVoltarCategoria` — the editor re-checks with `categoriaAceitaNoBlocoShopee`). */
  onCampo: <C extends CampoDoFormularioRascunhoShopee>(
    campo: C,
    valor: FormularioRascunhoShopee[C],
  ) => void;
  /** «Salvar rascunho» (enabled ⇔ `bloco.podeSalvar`): the editor sends the create (`novo`) or the edit through `executar`. */
  onSalvar: () => void;
  /** «Desfazer alterações» (enabled ⇔ `bloco.podeDesfazer`): the editor drops the entry; nothing is sent. */
  onDesfazer: () => void;
  /** «Descartar» (enabled ⇔ `bloco.podeDescartar`) with `bloco.descarte`: the editor opens that confirmation — `local` (drop, no request), `confirmar`, or `atestar` (the three-case Seller-Centre dialog). */
  onDescartar: (descarte: DescarteDoRascunhoShopee) => void;
}

/** A changed title no write accepts (the draft route's `item_name` refine: never blank). */
export const FRASE_TITULO_EM_BRANCO_RASCUNHO_SHOPEE =
  'O título do anúncio não pode ficar em branco.';

/** «Salvar rascunho» is disabled because a changed field holds a value no write accepts. */
export const FRASE_CAMPO_INVALIDO_RASCUNHO_SHOPEE =
  'Corrija o campo destacado para salvar o rascunho.';

/**
 * The stale check said so before the click (`divergencias`): another writer
 * changed these fields since the entry was loaded, so the next «Salvar
 * rascunho» answers with the field diff instead of overwriting them.
 */
export function fraseDasDivergenciasDoRascunhoShopee(
  campos: readonly CampoRascunhoShopee[],
): string {
  const nomes = campos.map((c) => ROTULO_CAMPO_RASCUNHO_SHOPEE[c]).join(', ');
  return (
    `Outra gravação mudou este rascunho depois que você começou a editar (${nomes}). ` +
    'Ao salvar, o ERP mostra a diferença antes de sobrescrever.'
  );
}

/** Notices that inform (dimmed text) rather than warn (an alert). */
const AVISOS_INFORMATIVOS: ReadonlySet<string> = new Set([
  FRASE_RASCUNHO_NOVO_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE,
]);

/**
 * The input's description: what the field is, and — once the category's band
 * is known and the text is not blank — its measured length (the TRIMMED
 * text's, `textoNaFaixaShopee`: the publisher's own measure) against the band.
 */
function descricaoDoCampo(
  base: string,
  texto: string | null,
  banda: FaixaDto | null | undefined,
): string {
  if (banda == null) return base;
  const medida = textoNaFaixaShopee(texto, banda);
  if (medida.estado === 'ausente') return base;
  return (
    `${base} ${String(medida.comprimento)} caracteres; esta categoria aceita ` +
    `${descreverFaixaShopee(banda)}.`
  );
}

/**
 * ⚠️ The draft sits INSIDE the produto's `<form>`: Enter in a single-line input
 * would submit THAT form (an implicit submission) — saving the produto, not
 * the draft. The title swallows it.
 */
function semEnviarOFormularioDoProduto(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') e.preventDefault();
}

/**
 * The draft form of ONE listing draft (#1911 P10, DC §2.3/§2.6): Título,
 * Descrição, Categoria (`CategoriaRascunhoShopee`), Marca
 * (`MarcaRascunhoShopee`), the read-only logistics line, the pendências
 * (`pendenciasDoRascunhoShopee` over `bloco.campos`), the block's notices, and
 * «Salvar rascunho» / «Desfazer alterações» / «Descartar». A virtual-kit
 * produto (`bloco.kitVirtual`) gets the notice and «Descartar» only.
 *
 * Presentational: every piece of state and every write is the editor's (R2);
 * it fetches nothing itself (its two pickers carry their own reads).
 *
 * - **Every decision is `bloco`'s** (`estadoDoBlocoRascunhoShopee`): what the
 *   fields show, whether they accept typing (the category separately — never
 *   in `incerta`), whether each button acts, which discard runs, the notices.
 *   Nothing here re-reads the publish lock or the clock (#1369).
 * - **Pendências** read `bloco.campos` (the form's values in the projection's
 *   form) with the STORED produto texts (`textosDoProduto`) — never the
 *   produto form's unsaved text — and only once those are known: a list built
 *   from missing knowledge would claim pendências that do not exist.
 * - **Buttons** render only with `podeEditar`; a read-only operator sees the
 *   values and the notices, nothing to click — except `somenteDescartar` (the
 *   draft of a conta that was deleted): «Descartar» alone.
 * - **No conta that can answer** (`contaId: null`): the category and the
 *   brand show as text; no picker mounts, so nothing is read for a conta
 *   apps/shopee could only answer 404 for.
 *
 * Contract for the tab's tests and the e2e: root
 * `data-testid="shopee-rascunho-<linkDocId>"`; buttons named exactly «Salvar
 * rascunho», «Desfazer alterações», «Descartar»; ⚠️ NO button whose name
 * contains "Publicar" (P10's pin `semBotao(id, /Publicar/)` — Publicar is P11).
 */
export function RascunhoShopee({
  db,
  contaId,
  contaNome,
  linkDocId,
  bloco,
  marcaGuardada,
  textosDoProduto,
  limites,
  divergencias,
  podeEditar,
  somenteDescartar,
  emVoo,
  resultado,
  onCampo,
  onSalvar,
  onDesfazer,
  onDescartar,
}: RascunhoShopeeProps) {
  const raiz = `shopee-rascunho-${linkDocId}`;
  const { valores } = bloco;
  const pendencias =
    textosDoProduto === null || bloco.kitVirtual
      ? []
      : pendenciasDoRascunhoShopee(bloco.campos, { ...textosDoProduto, limites });
  const tituloEmBranco =
    bloco.impedimento === 'campo-invalido' && textoUtilizavelShopee(valores.item_name) === null;

  const descartar = (
    <Button
      type="button"
      size="xs"
      variant="light"
      color="red"
      disabled={!bloco.podeDescartar}
      loading={emVoo === 'descartar-rascunho'}
      onClick={() => onDescartar(bloco.descarte)}
    >
      Descartar
    </Button>
  );

  return (
    <Stack gap="xs" data-testid={raiz}>
      {bloco.avisos.map((aviso) =>
        AVISOS_INFORMATIVOS.has(aviso) ? (
          <Text key={aviso} size="sm" c="dimmed">
            {aviso}
          </Text>
        ) : (
          <Alert key={aviso} color="yellow" variant="light">
            {aviso}
          </Alert>
        ),
      )}

      {resultado !== null && (
        <Alert
          color={resultado.incerto ? 'yellow' : 'red'}
          variant="light"
          data-testid={`${raiz}-resultado`}
        >
          {resultado.mensagem}
        </Alert>
      )}

      {divergencias.length > 0 && (
        <Alert color="orange" variant="light" data-testid={`${raiz}-divergencias`}>
          {fraseDasDivergenciasDoRascunhoShopee(divergencias)}
        </Alert>
      )}

      {!bloco.kitVirtual && (
        <>
          <TextInput
            label="Título do anúncio"
            description={descricaoDoCampo(
              'Começa com o nome do produto; é o título que a Shopee mostra.',
              valores.item_name,
              limites?.itemNameLengthLimit,
            )}
            value={valores.item_name ?? ''}
            maxLength={MAX_ITEM_NAME_RASCUNHO_SHOPEE}
            disabled={!bloco.camposEditaveis}
            error={tituloEmBranco ? FRASE_TITULO_EM_BRANCO_RASCUNHO_SHOPEE : undefined}
            onKeyDown={semEnviarOFormularioDoProduto}
            onChange={(e) => onCampo(CAMPO_RASCUNHO_SHOPEE.itemName, e.currentTarget.value)}
          />
          <Textarea
            label="Descrição do anúncio"
            description={descricaoDoCampo(
              'Em branco: a Shopee recebe a descrição do produto (aba Descrição).',
              valores.description,
              limites?.itemDescriptionLengthLimit,
            )}
            value={valores.description ?? ''}
            maxLength={MAX_DESCRIPTION_RASCUNHO_SHOPEE}
            autosize
            minRows={2}
            maxRows={10}
            disabled={!bloco.camposEditaveis}
            onChange={(e) => onCampo(CAMPO_RASCUNHO_SHOPEE.description, e.currentTarget.value)}
          />
          <CategoriaRascunhoShopee
            contaId={contaId}
            linkDocId={linkDocId}
            categoryId={valores.category_id}
            titulo={valores.item_name}
            editavel={bloco.categoriaEditavel}
            atributosGravados={bloco.atributosGravados}
            onEscolher={(categoryId) => onCampo(CAMPO_RASCUNHO_SHOPEE.categoryId, categoryId)}
            onVoltar={
              bloco.podeVoltarCategoria
                ? () => onCampo(CAMPO_RASCUNHO_SHOPEE.categoryId, bloco.categoriaGravada)
                : null
            }
          />
          {contaId === null ? (
            // No shortlist listener for a conta that cannot answer: the pair as text.
            <Stack gap={4} data-testid={`shopee-rascunho-marca-${linkDocId}`}>
              <Text size="sm" fw={500}>
                Marca
              </Text>
              <Text size="sm">{rotuloDaMarcaRascunhoShopee(valores.marca)}</Text>
            </Stack>
          ) : (
            <MarcaRascunhoShopee
              db={db}
              contaId={contaId}
              contaNome={contaNome}
              linkDocId={linkDocId}
              marca={valores.marca}
              marcaGuardada={marcaGuardada}
              editavel={bloco.camposEditaveis}
              onEscolher={(marca) => onCampo(CAMPO_RASCUNHO_SHOPEE.marca, marca)}
            />
          )}
          <Text size="xs" c="dimmed">
            {FRASE_LOGISTICA_RASCUNHO_SHOPEE}
          </Text>
        </>
      )}

      {pendencias.length > 0 && (
        <Stack gap={2} data-testid={`${raiz}-pendencias`}>
          <Text size="sm" fw={500}>
            Pendências para publicar
          </Text>
          <List size="sm">
            {pendencias.map((p) => (
              <List.Item key={p.tipo}>{textoDaPendenciaRascunhoShopee(p)}</List.Item>
            ))}
          </List>
        </Stack>
      )}

      {podeEditar && !bloco.kitVirtual && bloco.impedimento === 'campo-invalido' && (
        <Text size="sm" c="red" data-testid={`${raiz}-impedimento`}>
          {FRASE_CAMPO_INVALIDO_RASCUNHO_SHOPEE}
        </Text>
      )}
      {podeEditar && !bloco.kitVirtual && bloco.impedimento === 'categoria-travada' && (
        <Text size="sm" c="red" data-testid={`${raiz}-impedimento`}>
          {FRASE_CATEGORIA_TRAVADA_SHOPEE}
        </Text>
      )}
      {podeEditar &&
        !bloco.kitVirtual &&
        bloco.impedimento === 'categoria-travada' &&
        bloco.podeVoltarCategoria && (
          // Only while the button it names is on screen.
          <Text size="sm" c="red" data-testid={`${raiz}-voltar-categoria`}>
            {FRASE_VOLTAR_CATEGORIA_GRAVADA_SHOPEE}
          </Text>
        )}

      {!podeEditar && somenteDescartar && <Group gap="xs">{descartar}</Group>}
      {podeEditar && (
        <Group gap="xs">
          {bloco.kitVirtual ? (
            descartar
          ) : (
            <>
              <Button
                type="button"
                size="xs"
                disabled={!bloco.podeSalvar}
                loading={emVoo === 'salvar-rascunho'}
                onClick={onSalvar}
              >
                Salvar rascunho
              </Button>
              {!bloco.novo && (
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  disabled={!bloco.podeDesfazer}
                  onClick={onDesfazer}
                >
                  Desfazer alterações
                </Button>
              )}
              {descartar}
            </>
          )}
        </Group>
      )}
    </Stack>
  );
}
