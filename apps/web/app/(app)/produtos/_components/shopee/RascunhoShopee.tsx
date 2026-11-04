'use client';

import { useState, type KeyboardEvent } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  List,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  CAMPO_RASCUNHO_SHOPEE,
  MAX_DESCRIPTION_RASCUNHO_SHOPEE,
  MAX_ITEM_NAME_RASCUNHO_SHOPEE,
  descreverFaixaShopee,
  textoNaFaixaShopee,
  textoUtilizavelShopee,
  type ArgsPendenciasRascunhoShopee,
  type CampoRascunhoShopee,
  type EstadoPublicacaoRascunhoShopee,
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
  ROTULO_CRIAR_PAUSADO_SHOPEE,
  ROTULO_PUBLICAR_RASCUNHO_SHOPEE,
  ROTULO_PUBLICAR_SEGUNDO_ANUNCIO_SHOPEE,
  TITULO_PUBLICAR_RASCUNHO_SHOPEE,
  textoDaConfirmacaoDePublicacaoShopee,
  textoDaPendenciaRascunhoShopee,
  textoDoSegundoAnuncioNaPublicacaoShopee,
  tituloDoSegundoAnuncioNaPublicacaoShopee,
} from '@/lib/shopee/anuncioProduto';
import type {
  BlocoRascunhoShopee,
  CampoDoFormularioRascunhoShopee,
  DescarteDoRascunhoShopee,
  ExistentesNaContaShopee,
  FormularioRascunhoShopee,
  PublicacaoDoRascunhoShopee,
  SaidaDoProblemaShopee,
} from '@/lib/shopee/rascunho';

import { CategoriaRascunhoShopee } from './CategoriaRascunhoShopee';
import { idDoCampoRascunhoShopee } from './DesfechoAcaoShopee';
import { MarcaRascunhoShopee, rotuloDaMarcaRascunhoShopee } from './MarcaRascunhoShopee';

/**
 * The two draft writes a block starts (DC §2.1). The editor's
 * `AcaoDoAnuncioShopee` (`AcoesAnuncioShopee.tsx`) gains exactly these
 * members, so its `emVoo` names a draft write the same way it names a publish.
 */
export type AcaoDoRascunhoShopee = 'salvar-rascunho' | 'descartar-rascunho';

/**
 * Every write a draft block starts (#1911 P11): its two draft writes plus its
 * «Publicar» — the `publicar` route, the editor's existing
 * `AcaoDoAnuncioShopee` member, sent by `linkDocId`.
 */
export type AcaoDoBlocoRascunhoShopee = AcaoDoRascunhoShopee | 'publicar';

/**
 * The «Publicar» confirmation of ONE draft while it is open (#1911 P11, DC
 * §2.6). Editor state (R2): it survives a hidden tab, and a 409 re-ask or a
 * refusal row's attestation exit opens it as well as the block's own button.
 * The form renders it as a controlled modal
 * (`data-testid="shopee-rascunho-publicar-<linkDocId>"`): the publish text
 * (`textoDaConfirmacaoDePublicacaoShopee`), the «Criar pausado» checkbox
 * (`ROTULO_CRIAR_PAUSADO_SHOPEE`), the D15 warning while {@link segundoAnuncio}
 * is set, «Cancelar» and the confirm button.
 */
export interface ConfirmacaoDePublicacaoShopee {
  /**
   * D15: what makes this publish a SECOND listing of the produto on the conta
   * — `segundoAnuncioNaContaShopee(links, contaId, edicoes, linkDocId)` as the
   * dialog opens (the draft itself excluded; a conta holding only removed
   * listings ⇒ `null`), or `existentesDosVinculosShopee(vinculos)` when a 409
   * `rascunhoContaJaTemAnuncio` re-asks. Non-null ⇒ the warning
   * (`textoDoSegundoAnuncioNaPublicacaoShopee`) shows and the send carries
   * `confirmarSegundoAnuncio: true`; `null` ⇒ neither. Supplied by the editor.
   */
  readonly segundoAnuncio: ExistentesNaContaShopee | null;
  /** «Criar pausado» as the dialog opens — `false` on a click; the refused request's own choice when a 409 re-asks (the re-send is identical but for the flag). Supplied by the editor. */
  readonly pausado: boolean;
  /**
   * The refusal-row exit that opened it — `saidasDoProblemaShopee`'s
   * `publicar-atestando` (its `rotulo` is what the operator attested, its
   * `adota` the unlinked listing(s) the publish adopts instead of creating) —
   * so the send carries `confirmarCriacaoIncerta: true` WITH that promise
   * (`criacaoIncertaAdota`, §I1: the server keeps it or refuses with nothing
   * sent), on a 409 re-ask too; `null` for the block's own «Publicar». The
   * confirmation's text, D15 warning and title are worded by what it does
   * (adopt vs create), and the text by whether its look-up re-scans (`varre`:
   * the SKU-less exit's does not, KNOWN #12). Supplied by the editor.
   */
  readonly atestacao: Extract<
    SaidaDoProblemaShopee,
    { readonly tipo: 'publicar-atestando' }
  > | null;
}

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
 * A read whose failure is why a draft's «Publicar» waits
 * ({@link RascunhoShopeeProps.falhaDaLeitura}). Built by the tab.
 */
export interface FalhaDaLeituraDoRascunhoShopee {
  /** The sentence — what failed, that «Publicar» is unavailable, and its own exit. */
  readonly mensagem: string;
  /** Asks the read again (the query's refetch), or `null` when only a reload re-reads it (a listener). */
  readonly lerDeNovo: (() => void) | null;
  /** That re-read is in flight: the button spins. */
  readonly relendo: boolean;
}

/** The re-read button of a {@link FalhaDaLeituraDoRascunhoShopee}. */
export const ROTULO_LER_DE_NOVO_RASCUNHO_SHOPEE = 'Ler de novo';

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
  /** The STORED produto `nome` (`produtoSnap`) and `extraData/singleton.descricao` (rev. 2a #10's new `useDocSnapshot`), each `null` when absent — or `null` while either document has not answered (then no pendência is computed); supplied by the editor. Since #1911 P11 the form reads the pendências from {@link decisaoDePublicar}, which the tab computes over this SAME value — so the list shown is the list that gates. */
  textosDoProduto: TextosDoProdutoRascunhoShopee | null;
  /** The title/description bands the tab holds (`client.limitesDoItem(…).limites` — the EDITED category's), or `null` while unknown: the fields' measured counter reads them (the band pendências are {@link decisaoDePublicar}'s); supplied by the tab. */
  limites: ArgsPendenciasRascunhoShopee['limites'];
  /** The stale check — `divergenciasDoServidorShopee(edicao, link)` (`[]` for no entry, a local new draft or nothing to save): fields another writer changed since the entry was loaded, so the next Salvar will answer 409; supplied by the tab. */
  divergencias: readonly CampoRascunhoShopee[];
  /** `PERM.integracao.write` ∧ `PERM.produto.write` ∧ the produto form editable — the SAME flag the tab passes as `bloco`'s `podeEditar`; `false` ⇒ fields read-only and NO button renders (but see `somenteDescartar`). */
  podeEditar: boolean;
  /** The draft's conta document is GONE (a «não encontrada» tab whose id a document could carry) and the operator holds both bits: «Descartar» renders ALONE — enabled by `bloco.podeDescartar` — since the discard route needs only the link; nothing else is offered (no «Publicar»: `decisaoDePublicar` reads `sem-permissao` for a block the operator may not author, and the button renders only with `podeEditar`). Read only while `podeEditar` is `false`; supplied by the tab. */
  somenteDescartar: boolean;
  /** This link's write in flight (the editor's `emVoo` when it names this link and a draft action or its «Publicar» — `'publicar'` on a draft's link is always this block's), else `null` — that button shows the spinner. */
  emVoo: AcaoDoBlocoRascunhoShopee | null;
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
  /**
   * THE «Publicar» gate (#1911 P11) — `publicacaoDoRascunhoShopee({bloco,
   * podeEditar, ocupado, servidorConfirmado, produtoSujo, textosDoProduto,
   * limites})` over the SAME `bloco`, `podeEditar`, `textosDoProduto` and
   * `limites` this form gets (`limites`: the EDITED category's bands — no
   * shop-wide read: a draft with no category, or a legacy `0`, is held by
   * `categoria-ausente` / `categoria-inexistente` first, review R2-drafts#7);
   * computed by the tab. «Publicar» (named exactly
   * `ROTULO_PUBLICAR_RASCUNHO_SHOPEE`) renders with the other buttons and is
   * enabled ⇔ `podePublicar`; a non-null `aviso` shows under it — unless
   * {@link falhaDaLeitura} names a failed read, whose sentence replaces it;
   * `pendencias` is the list that gates — the one the form shows.
   */
  decisaoDePublicar: PublicacaoDoRascunhoShopee;
  /**
   * The READ whose failure is why «Publicar» waits (review R7-roundtrip#3 /
   * R8-copy#9), or `null` — then {@link decisaoDePublicar}'s `aviso` is the
   * reason. Set by the tab ONLY while that read IS the gate's reason (the
   * bands read failed under `faixas-desconhecidas`; the stored description's
   * listener failed under `carregando`), so a disabled «Publicar» never reads
   * as "still loading" — or as nothing — after a failure. Its sentence shows
   * in red under the button and in the open confirmation; «Ler de novo»
   * (`lerDeNovo`, the query's own refetch — the app never refetches on focus
   * and a 502 is never retried) when the read can be asked again here.
   */
  falhaDaLeitura: FalhaDaLeituraDoRascunhoShopee | null;
  /** «Publicar» (enabled ⇔ `decisaoDePublicar.podePublicar`): the editor re-checks the gate and opens `confirmacaoDePublicacao` — the click itself sends nothing. */
  onPublicar: () => void;
  /** This draft's open «Publicar» confirmation (editor state, R2), or `null` while closed. */
  confirmacaoDePublicacao: ConfirmacaoDePublicacaoShopee | null;
  /**
   * The confirm, with «Criar pausado» as ticked now: the editor closes the
   * dialog and sends `corpoPublicarRascunhoShopee({contaId, produtoId,
   * linkDocId, pausado, confirmarSegundoAnuncio: segundoAnuncio !== null,
   * atestacao})` through `executar` — by `linkDocId`, never `categoryId`; an
   * attestation travels with its promise (`criacaoIncertaAdota`). The confirm
   * button acts only while `decisaoDePublicar.podePublicar` (the reading can
   * change while it is open).
   */
  onConfirmarPublicacao: (pausado: boolean) => void;
  /** «Cancelar» (or the dialog closed): the editor closes it; nothing is sent. */
  onCancelarPublicacao: () => void;
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
 * The draft form of ONE listing draft (#1911 P10/P11, DC §2.3/§2.6): Título,
 * Descrição, Categoria (`CategoriaRascunhoShopee`), Marca
 * (`MarcaRascunhoShopee`), the read-only logistics line, the pendências, the
 * block's notices, and «Salvar rascunho» / «Desfazer alterações» /
 * «Publicar» / «Descartar» — with the «Publicar» confirmation. A virtual-kit
 * produto (`bloco.kitVirtual`) gets the notice and «Descartar» only: its first
 * publish is a native kit, never this draft (§C #1).
 *
 * Presentational: every piece of state and every write is the editor's (R2);
 * it fetches nothing itself (its two pickers carry their own reads).
 *
 * - **Every decision is `bloco`'s** (`estadoDoBlocoRascunhoShopee`): what the
 *   fields show, whether they accept typing (the category separately — never
 *   in `incerta`), whether each button acts, which discard runs, the notices.
 *   Nothing here re-reads the publish lock or the clock (#1369).
 * - **«Publicar» is `decisaoDePublicar`'s** (`publicacaoDoRascunhoShopee`):
 *   enabled ⇔ `podePublicar`, its `aviso` under the button. The pendências
 *   shown ARE `decisaoDePublicar.pendencias` — the list that gates, computed
 *   once by the tab over `bloco.campos` and the STORED produto texts (never
 *   the produto form's unsaved text), empty while those texts are unknown: a
 *   list built from missing knowledge would claim pendências that do not
 *   exist. The form never recomputes them (#1369).
 * - **The click sends nothing**: `onPublicar` asks the editor to open
 *   `confirmacaoDePublicacao` — the ONE way to publish a draft, also taken by
 *   a 409 `rascunhoContaJaTemAnuncio` re-ask and by a refusal row's
 *   attestation exit, so the confirmation, «Criar pausado» and the D15
 *   warning are never skipped (K2-13). Its confirm acts only while
 *   `decisaoDePublicar.podePublicar` still holds.
 * - **Buttons** render only with `podeEditar`; a read-only operator sees the
 *   values and the notices, nothing to click — except `somenteDescartar` (the
 *   draft of a conta that was deleted): «Descartar» alone.
 * - **No conta that can answer** (`contaId: null`): the category and the
 *   brand show as text; no picker mounts, so nothing is read for a conta
 *   apps/shopee could only answer 404 for.
 *
 * Contract for the tab's tests and the e2e: root
 * `data-testid="shopee-rascunho-<linkDocId>"`; buttons named exactly «Salvar
 * rascunho», «Desfazer alterações», «Publicar»
 * (`ROTULO_PUBLICAR_RASCUNHO_SHOPEE`), «Descartar», in that order; the
 * confirmation `data-testid="shopee-rascunho-publicar-<linkDocId>"` (a Mantine
 * `Modal`: portalled outside the root in the browser, so scope its buttons by
 * that test id or the `dialog` role — its confirm is also named «Publicar»,
 * or «Publicar mesmo assim» with the D15 warning); field ids
 * {@link idDoCampoRascunhoShopee}.
 */
export function RascunhoShopee({
  db,
  contaId,
  contaNome,
  linkDocId,
  bloco,
  marcaGuardada,
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
  decisaoDePublicar,
  falhaDaLeitura,
  onPublicar,
  confirmacaoDePublicacao,
  onConfirmarPublicacao,
  onCancelarPublicacao,
}: RascunhoShopeeProps) {
  const raiz = `shopee-rascunho-${linkDocId}`;
  const { valores } = bloco;
  // The gate's own list (#1369) — `[]` while the produto texts are unknown or on a kit.
  const { pendencias } = decisaoDePublicar;
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
            id={idDoCampoRascunhoShopee(linkDocId, CAMPO_RASCUNHO_SHOPEE.itemName)}
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
            id={idDoCampoRascunhoShopee(linkDocId, CAMPO_RASCUNHO_SHOPEE.description)}
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
          <div id={idDoCampoRascunhoShopee(linkDocId, CAMPO_RASCUNHO_SHOPEE.categoryId)}>
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
          </div>
          <div id={idDoCampoRascunhoShopee(linkDocId, CAMPO_RASCUNHO_SHOPEE.marca)}>
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
          </div>
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
              <Button
                type="button"
                size="xs"
                color="green"
                disabled={!decisaoDePublicar.podePublicar}
                loading={emVoo === 'publicar'}
                onClick={onPublicar}
              >
                {ROTULO_PUBLICAR_RASCUNHO_SHOPEE}
              </Button>
              {descartar}
            </>
          )}
        </Group>
      )}
      {podeEditar && !bloco.kitVirtual && falhaDaLeitura !== null && (
        // A FAILED read is the reason: said as such, never as "still loading".
        <Group gap="xs" data-testid={`${raiz}-publicar-falha-leitura`}>
          <Text size="xs" c="red">
            {falhaDaLeitura.mensagem}
          </Text>
          {falhaDaLeitura.lerDeNovo !== null && (
            <Button
              type="button"
              size="xs"
              variant="light"
              loading={falhaDaLeitura.relendo}
              onClick={falhaDaLeitura.lerDeNovo}
            >
              {ROTULO_LER_DE_NOVO_RASCUNHO_SHOPEE}
            </Button>
          )}
        </Group>
      )}
      {podeEditar &&
        !bloco.kitVirtual &&
        falhaDaLeitura === null &&
        decisaoDePublicar.aviso !== null && (
          <Text size="xs" c="dimmed" data-testid={`${raiz}-publicar-aviso`}>
            {decisaoDePublicar.aviso}
          </Text>
        )}

      {/* Mounted only while open, so «Criar pausado» starts from the editor's value on every opening. */}
      {podeEditar && !bloco.kitVirtual && confirmacaoDePublicacao !== null && (
        <ConfirmacaoDePublicacaoModal
          linkDocId={linkDocId}
          contaNome={contaNome}
          publicacao={bloco.publicacao}
          confirmacao={confirmacaoDePublicacao}
          podePublicar={decisaoDePublicar.podePublicar}
          aviso={falhaDaLeitura?.mensagem ?? decisaoDePublicar.aviso}
          onConfirmar={onConfirmarPublicacao}
          onCancelar={onCancelarPublicacao}
        />
      )}
    </Stack>
  );
}

/**
 * The «Publicar» confirmation (DC §2.6): what the publish sends and reads
 * (`textoDaConfirmacaoDePublicacaoShopee` — on an `incerta` draft it also
 * says the publish may ADOPT the last attempt's listing, and an attestation
 * exit whose `adota` names one is worded as that adoption, never as a
 * create), the attestation the
 * operator gave when a refusal row's exit opened it, the D15 second-listing
 * warning while `confirmacao.segundoAnuncio` is set (then titled by what the
 * publish DOES — `tituloDoSegundoAnuncioNaPublicacaoShopee`: adopting, first
 * beside drafts, or another listing — and confirmed with the D15 button), and
 * «Criar pausado».
 *
 * The confirm acts only while `podePublicar` holds — the reading can change
 * while the dialog is open (another tab starts a publish, the produto form
 * turns dirty) — and then hands the editor «Criar pausado» as ticked NOW.
 */
function ConfirmacaoDePublicacaoModal({
  linkDocId,
  contaNome,
  publicacao,
  confirmacao,
  podePublicar,
  aviso,
  onConfirmar,
  onCancelar,
}: {
  linkDocId: string;
  contaNome: string;
  publicacao: EstadoPublicacaoRascunhoShopee;
  confirmacao: ConfirmacaoDePublicacaoShopee;
  podePublicar: boolean;
  aviso: string | null;
  onConfirmar: (pausado: boolean) => void;
  onCancelar: () => void;
}) {
  const [pausado, setPausado] = useState(confirmacao.pausado);
  const { segundoAnuncio, atestacao } = confirmacao;
  return (
    <Modal
      opened
      onClose={onCancelar}
      title={
        segundoAnuncio === null
          ? TITULO_PUBLICAR_RASCUNHO_SHOPEE
          : // By what THIS publish does: an adopting attestation links a
            // listing, and beside drafts only it makes the conta's first.
            tituloDoSegundoAnuncioNaPublicacaoShopee(segundoAnuncio, atestacao)
      }
      centered
    >
      <Stack gap="sm" data-testid={`shopee-rascunho-publicar-${linkDocId}`}>
        <Text size="sm">
          {textoDaConfirmacaoDePublicacaoShopee({
            contaNome,
            publicacao,
            // An attestation exit that ADOPTS a listing creates nothing (§C
            // #8); one that creates (`adota: []`) never promises the SKU scan;
            // the SKU-less one (`varre: false`) promises no change-guard either
            // — the exit itself is handed on, `varre` included (KNOWN #12).
            atestacao,
          })}
        </Text>
        {atestacao !== null && (
          <Text size="sm" data-testid={`shopee-rascunho-publicar-${linkDocId}-atestacao`}>
            Você confirmou: «{atestacao.rotulo}».
          </Text>
        )}
        {segundoAnuncio !== null && (
          <Alert
            color="orange"
            variant="light"
            data-testid={`shopee-rascunho-publicar-${linkDocId}-segundo-anuncio`}
          >
            {textoDoSegundoAnuncioNaPublicacaoShopee(segundoAnuncio, { publicacao, atestacao })}
          </Alert>
        )}
        <Checkbox
          label={ROTULO_CRIAR_PAUSADO_SHOPEE}
          checked={pausado}
          onChange={(e) => setPausado(e.currentTarget.checked)}
        />
        {!podePublicar && aviso !== null && (
          <Text size="sm" c="dimmed">
            {aviso}
          </Text>
        )}
        <Group justify="flex-end">
          <Button type="button" variant="default" onClick={onCancelar}>
            Cancelar
          </Button>
          <Button
            type="button"
            color={segundoAnuncio === null ? 'green' : 'orange'}
            disabled={!podePublicar}
            onClick={() => {
              if (podePublicar) onConfirmar(pausado);
            }}
          >
            {segundoAnuncio === null
              ? ROTULO_PUBLICAR_RASCUNHO_SHOPEE
              : ROTULO_PUBLICAR_SEGUNDO_ANUNCIO_SHOPEE}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
