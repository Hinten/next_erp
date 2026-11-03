'use client';

import Link from 'next/link';
import { Alert, Button, Group, List, Stack, Text } from '@mantine/core';
import { parseIsoToMillis } from '@delfrance/core/datetime';
import {
  ACAO_STATUS_ANUNCIO,
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  podeMoverAnuncioShopee,
  type EstadoPublicacaoRascunhoShopee,
} from '@delfrance/schemas';
import { useObjectViewSections } from '@delfrance/ui';

import {
  ehFraseDeTerminal,
  formatarInstanteShopee,
  FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE,
  FRASE_RECUSA_SEM_PASSO_SHOPEE,
  TITULO_ANUNCIO_INCERTO_SHOPEE,
  TITULO_RASCUNHO_PUBLICADO_SHOPEE,
  fraseDaPublicacaoSemRespostaShopee,
  fraseDoAnuncioIncertoShopee,
  fraseDoRascunhoPublicadoShopee,
  textoDaEtapaShopee,
  textoDoAvisoKit,
  textoDoProblemaShopee,
  vinculoSubstituidoAlheio,
} from '@/lib/shopee/anuncioProduto';
import {
  rotuloDaSuperficieShopee,
  saidasDoProblemaShopee,
  superficieDoCampoShopee,
  textoDaPublicacaoParadaDoRascunhoShopee,
  type CampoDoFormularioRascunhoShopee,
  type PublicacaoParadaDoRascunhoShopee,
  type SaidaDoProblemaShopee,
  type SuperficieDoCampoShopee,
} from '@/lib/shopee/rascunho';
import type {
  AnuncioStatusShopee,
  ItemPublicadoShopee,
  KitPublicadoShopee,
  ProblemaShopee,
  RespostaItemIncertoShopee,
  RespostaPublicarShopee,
} from '@/lib/shopee/wire';
import type { AcoesShopee, ArmaKitShopee } from './AcoesAnuncioShopee';

/**
 * The element id of one field of a draft's form (`RascunhoShopee` stamps it)
 * — what a refusal row's «Corrigir no rascunho: …» button (a `rascunho`
 * surface of `superficieDoCampoShopee`) focuses. The title and the
 * description are the inputs themselves; the category and the brand are
 * their pickers' wrappers (the picker's first enabled control takes the
 * focus). It lives HERE, beside its one reader, so the form imports it from
 * the panel and never the reverse.
 */
export function idDoCampoRascunhoShopee(
  linkDocId: string,
  campo: CampoDoFormularioRascunhoShopee,
): string {
  return `shopee-rascunho-${linkDocId}-campo-${campo}`;
}

/** What can take the focus inside a picker's wrapper — its first enabled control. */
const FOCAVEL = 'input:not([disabled]), textarea:not([disabled]), button:not([disabled])';

/**
 * Brings one field of a draft's form into view and focuses it (a picker's
 * first enabled control). Navigation only — nothing is written. A field that
 * is read-only now (the reading is `em-andamento`, the category in `incerta`)
 * is still scrolled to; a form that is not on screen is a no-op.
 */
function focarCampoRascunhoShopee(linkDocId: string, campo: CampoDoFormularioRascunhoShopee): void {
  const alvo = document.getElementById(idDoCampoRascunhoShopee(linkDocId, campo));
  if (alvo === null) return;
  // jsdom implements no layout, so the scroll is optional there.
  if (typeof alvo.scrollIntoView === 'function') alvo.scrollIntoView({ block: 'center' });
  const focavel = alvo.matches(FOCAVEL) ? alvo : alvo.querySelector<HTMLElement>(FOCAVEL);
  focavel?.focus();
}

/**
 * A publish request that was a listing DRAFT's «Publicar» (#1911 P11) — a
 * fact of the REQUEST, kept with its answer: once the publish lands the link
 * is no longer a draft, so it cannot be read off the link afterwards.
 */
export interface PedidoDoRascunhoShopee {
  /** «Criar pausado» was asked (`status: 'UNLIST'` sent) — the draft's 200 copy never implies it applied (rev. 2a #14). Supplied by the editor from the body it sent. */
  readonly pausado: boolean;
}

/**
 * The last outcome of an action on ONE listing, kept by the editor under the
 * link doc id it addressed (its rule R2) until the next action on that link.
 *
 *  - `status` — the pause/reactivate run's answer (200 even when refused);
 *  - `publicado` — the publish's answer: the 200 of a republish of an ordinary
 *    listing or a native kit, or of a recriar / converter that created (or
 *    resumed) a kit; and (#1911 P11) a DRAFT's «Publicar» — its 200
 *    (`tipo: 'item'`, never worded «criado»: a draft live meanwhile is merely
 *    republished, an `incerta` one may adopt) or its 202 (`tipo:
 *    'item-incerto'`, the ordinary listing's uncertain first create, never
 *    «falhou»);
 *  - `recusado` — the publish 422 (`SHOPEE_PUBLISH_BLOCKED`, the ERP's own
 *    refusal — usually before any Shopee write, but on an update the model
 *    leg refuses AFTER `update_item`; `SHOPEE_PUBLISH_REJECTED`, Shopee's),
 *    with its `problemas`;
 *  - `falha` — any other failure, already worded for the operator;
 *  - `sem-resposta` — a DRAFT's «Publicar» left without an answer the tab can
 *    trust (#1911 P11, rev. 2a #15);
 *  - `parada` — a DRAFT's «Publicar» stopped by a 409 `publicacaoExpirada` or
 *    a coded non-limit 502 (#1911 P11 review, §I2), worded on every render
 *    over the block's CURRENT reading.
 *
 * A re-verify that succeeds leaves no outcome here: it answers with a toast,
 * and the live link document repaints the block. Neither does an UNCERTAIN kit
 * create: that is the conta's own state (the editor's `incertos`), shown with
 * its wait and its "Repetir". A draft's uncertain create IS an outcome here —
 * but its wait is never stored: the panel reads it, on every render, off the
 * block's current publish reading ({@link DesfechoAcaoShopeeProps.rascunho}).
 */
export type DesfechoAcaoShopee =
  | { readonly tipo: 'status'; readonly resposta: AnuncioStatusShopee }
  | {
      readonly tipo: 'publicado';
      readonly resposta: RespostaPublicarShopee;
      /**
       * The answered request was a DRAFT's «Publicar» (by its `linkDocId`), or
       * `null` for a live link's republish or a kit arm. Picks the draft's 200
       * copy (`TITULO_RASCUNHO_PUBLICADO_SHOPEE` +
       * `fraseDoRascunhoPublicadoShopee`) over «republicado». Supplied by the
       * editor.
       */
      readonly pedidoRascunho: PedidoDoRascunhoShopee | null;
    }
  | {
      readonly tipo: 'recusado';
      /**
       * `true` for OUR 422 (`SHOPEE_PUBLISH_BLOCKED`), `false` for Shopee's
       * (`SHOPEE_PUBLISH_REJECTED`). ⚠️ NOT "nothing was sent": the model leg
       * of an UPDATE (a live listing's Republicar, an adopted draft) refuses
       * after `update_item`, and the body does not say which — so the title
       * claims neither (review R7-roundtrip#0).
       */
      readonly bloqueadaPeloErp: boolean;
      /**
       * The refused request carried `confirmarCriacaoIncerta` (a refusal
       * row's attestation exit): a row of the uncertain-create look-up then
       * answers a situation that CHANGED since the refusal the operator
       * checked — the server refused with nothing sent (§I1). Supplied by the
       * editor from the body it sent.
       */
      readonly respondeAtestacao: boolean;
      /**
       * WHERE in the publish sequence a mid-publish refusal landed (apps/shopee's
       * `EtapaPublicacao`) — never a channel state, which depends on the arm
       * too. Worded by `textoDaEtapaShopee`; the raw code is never printed.
       */
      readonly etapa: string | null;
      readonly problemas: readonly ProblemaShopee[];
      /** The backend's own summary — shown only when no row could be read. */
      readonly mensagem: string;
      /**
       * The kit create arm the refused request was — what an `informar-principal`
       * row re-opens, on the same link; `null` for any other publish.
       */
      readonly pedidoKit: { readonly arma: ArmaKitShopee; readonly linkDocId: string } | null;
    }
  | { readonly tipo: 'falha'; readonly mensagem: string }
  /**
   * A DRAFT's «Publicar» with no answer the tab can trust —
   * `falhaDaPublicacaoDoRascunhoShopee` read `sem-resposta`: a network
   * failure, an unreadable 2xx, a 5xx without a usable code (App Hosting's 504
   * at the route ceiling is one). NEVER «falhou»: the publish may still be
   * running, or may have created the listing. It holds no sentence — the panel
   * words it on every render (`fraseDaPublicacaoSemRespostaShopee`) from the
   * block's CURRENT reading ({@link DesfechoAcaoShopeeProps.rascunho}), so the
   * wait follows the snapshot. Supplied by the editor.
   */
  | { readonly tipo: 'sem-resposta' }
  /**
   * A DRAFT's «Publicar» the route STOPPED — 409 `publicacaoExpirada` (before
   * any send that could create) or a coded 502 that is not a rate limit
   * (`falhaDaPublicacaoDoRascunhoShopee`'s `expirada` / `interrompida`). It
   * holds no sentence: the panel words it on every render
   * (`textoDaPublicacaoParadaDoRascunhoShopee`) from the block's CURRENT
   * reading — a `livre` draft is checked first then created, an `incerta`
   * one's last attempt is checked first and never repeated (§I2). Supplied by
   * the editor.
   */
  | { readonly tipo: 'parada'; readonly parada: PublicacaoParadaDoRascunhoShopee };

/**
 * Where a refusal row's `variacoes` / `medidas` surface
 * (`superficieDoCampoShopee`, `@/lib/shopee/rascunho`) leads — each `null`
 * when the produto names none, and then that row keeps its sentence with no
 * button. The other surfaces need no input: a `rascunho` one focuses that
 * field of this block's draft form, a `produto` one switches the ObjectView
 * tab (`useObjectViewSections().sectionOfField` → `goToSection`, also the
 * label's section), and `seller-centre` is text.
 */
export interface DestinosDasSuperficiesShopee {
  /** The page that fixes the produto's variations — its STORED `grupoDeVariacoesUid` group's `/variacoes/<id>` — or `null` when none can be named; supplied by the editor (it holds the stored produto). */
  readonly variacoes: string | null;
  /** The produto's STORED size chart, `/medidas/<id>` (the id `TabelaMedidasShopeeResumo` links to), or `null` when it has none; supplied by the editor. */
  readonly medidas: string | null;
}

/**
 * The outcome inputs of a block that is a listing DRAFT now (#1911 P11) —
 * what the 202, the no-answer notice and a refusal row's attestation exits
 * read. All of it is the editor's, taken in the same render as the block's
 * decision.
 */
export interface DesfechoDoRascunhoShopee {
  /**
   * THE block's publish reading now — `bloco.publicacao`
   * (`estadoDoBlocoRascunhoShopee` at the editor's `relogioRascunho`). The wait
   * a 202 (`fraseDoAnuncioIncertoShopee`) and a `sem-resposta`
   * (`fraseDaPublicacaoSemRespostaShopee`) print, re-worded on every render —
   * never the 202's own `aguardarMs` nor `AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS`
   * (rev. 2a #7).
   */
  readonly publicacao: EstadoPublicacaoRascunhoShopee;
  /** MILLISECONDS — the clock {@link publicacao} was read at (`relogioRascunho`); never `Date.now()` at render, never the tab's frozen `agoraMs`. */
  readonly nowMs: number;
  /**
   * The SKU the uncertain attempt SENT — `janelaDaCriacaoIncertaShopee(link)?.sku
   * ?? null` (`@delfrance/schemas`): `''` ⇔ sent with none, `null` ⇔ unknown.
   * The SKU-moved refusal row names it (review R8-copy#5). Supplied by the
   * editor.
   */
  readonly skuEnviado: string | null;
  /** The draft's «Publicar» acts now — `publicacaoDoRascunhoShopee(…).podePublicar`, the SAME decision the form's button gets: a `publicar-atestando` exit is disabled otherwise. */
  readonly podePublicar: boolean;
  /** `bloco.podeDescartar`: a `descartar-atestando` exit is disabled otherwise. */
  readonly podeDescartar: boolean;
  /**
   * A refusal row's Seller-Centre attestation exit was clicked — one of
   * `saidasDoProblemaShopee(p, {ehRascunho: true})`, its button labelled
   * `saida.rotulo`, offered only with `acoes.permitidas`.
   * `publicar-atestando` ⇒ the editor opens the SAME «Publicar» confirmation
   * and gate (`RascunhoShopeeProps.confirmacaoDePublicacao` carrying this
   * exit as `atestacao`) — never a bare re-send (K2-13: pendências, «Criar
   * pausado» and D15 are never skipped). `descartar-atestando` ⇒ its discard
   * confirmation showing `aviso`, then `rascunho/descartar` with
   * `confirmarCriacaoIncerta: true` over the held projection.
   */
  readonly onSaida: (saida: SaidaDoProblemaShopee) => void;
}

export interface DesfechoAcaoShopeeProps {
  contaId: string;
  /** The produto whose block this is — `textoDoProblemaShopee`'s third argument, so an `importar` row words each linked id «(deste produto)» or «(do produto X)» (§C rule 3); supplied by the block. */
  produtoId: string;
  linkDocId: string;
  desfecho: DesfechoAcaoShopee;
  acoes: AcoesShopee;
  /** `superficieDoCampoShopee`'s `descricaoPropria`: the STORED link's own description is usable text (`textoUtilizavelShopee(link.description) !== null` — a draft's Publicar reads the stored draft), so a `description` row routes to that text, else to the produto's; supplied by the block. */
  descricaoPropria: boolean;
  /** The `variacoes` / `medidas` surface destinations; supplied by the editor. */
  destinosDasSuperficies: DestinosDasSuperficiesShopee;
  /**
   * The block is a listing DRAFT now (`ehRascunhoShopee`, the editor's block
   * decision) — its outcome inputs; `null` for a live listing, and once the
   * link stops being a draft: then no attestation exit renders, and
   * `superficieDoCampoShopee` reads `ehRascunho: false` (Seller Centre for
   * the listing's own content). A `republicar{linkDocId: <draft>}` row still
   * gets NO button: `acoes.enderecavel` stays `item_id`-only (K2-13).
   * Supplied by the editor.
   */
  rascunho: DesfechoDoRascunhoShopee | null;
}

/**
 * A draft's uncertain outcome (the 202, or no answer) still on screen after
 * the link stopped being a draft (the import adopted it, another tab
 * published it): there is no draft to publish again, and the block's own
 * state is what the ERP read since.
 */
export const FRASE_INCERTO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE =
  'Este vínculo não é mais um rascunho: o estado do anúncio neste bloco é o que o ERP leu ' +
  'depois — confira-o antes de qualquer outra ação.';

/**
 * The outcome of the last action on one listing (`data-testid="shopee-desfecho-<linkDocId>"`),
 * rendered inline in its block.
 *
 * ⚠️ No server sentence written for the terminal is ever shown: a refusal row
 * with an `acao` reads {@link textoDoProblemaShopee}'s copy and offers the
 * button the `acao` names, on the link the `acao` names.
 *
 * A DRAFT's «Publicar» (#1911 P11) is never «falhou» unless the answer says
 * so: its 202 and its no-answer outcome are worded on EVERY render from the
 * block's CURRENT publish reading (`rascunho.publicacao` at `rascunho.nowMs`),
 * so the wait follows the snapshot — never the 202's own `aguardarMs`, never a
 * constant (rev. 2a #7, #15).
 */
export function DesfechoAcaoShopee({
  contaId,
  produtoId,
  linkDocId,
  desfecho,
  acoes,
  descricaoPropria,
  destinosDasSuperficies,
  rascunho,
}: DesfechoAcaoShopeeProps) {
  return (
    <div data-testid={`shopee-desfecho-${linkDocId}`}>
      {desfecho.tipo === 'status' && (
        <DesfechoStatus linkDocId={linkDocId} resposta={desfecho.resposta} />
      )}
      {desfecho.tipo === 'publicado' && (
        <DesfechoPublicado
          contaId={contaId}
          resposta={desfecho.resposta}
          pedidoRascunho={desfecho.pedidoRascunho}
          acoes={acoes}
          rascunho={rascunho}
        />
      )}
      {desfecho.tipo === 'recusado' && (
        <DesfechoRecusado
          contaId={contaId}
          produtoId={produtoId}
          linkDocId={linkDocId}
          desfecho={desfecho}
          acoes={acoes}
          descricaoPropria={descricaoPropria}
          destinos={destinosDasSuperficies}
          rascunho={rascunho}
        />
      )}
      {desfecho.tipo === 'falha' && (
        <Alert color="red" variant="light">
          {semTerminal(desfecho.mensagem, rascunho !== null)}
        </Alert>
      )}
      {desfecho.tipo === 'sem-resposta' && (
        <Alert
          color="yellow"
          variant="light"
          title={TITULO_ANUNCIO_INCERTO_SHOPEE}
          data-testid={`shopee-desfecho-${linkDocId}-sem-resposta`}
        >
          <Text size="sm">
            {rascunho === null
              ? FRASE_INCERTO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE
              : fraseDaPublicacaoSemRespostaShopee(rascunho.publicacao, rascunho.nowMs)}
          </Text>
        </Alert>
      )}
      {desfecho.tipo === 'parada' && (
        // A definite stop (the route said so) — but WHAT exists is the block's
        // current reading, re-worded on every render (§I2), and its copy is a
        // check-first exit: orange, never the red of «falhou» (an `incerta`
        // draft's last attempt, or a create the 502 followed, may exist).
        <Alert color="orange" variant="light" data-testid={`shopee-desfecho-${linkDocId}-parada`}>
          <Text size="sm">
            {rascunho === null
              ? FRASE_INCERTO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE
              : textoDaPublicacaoParadaDoRascunhoShopee(desfecho.parada, rascunho.publicacao)}
          </Text>
        </Alert>
      )}
    </div>
  );
}

/**
 * A backend sentence, unless it is CLI copy — then the neutral stand-in: a
 * live listing's names «Reverificar», a DRAFT block's names no button (it has
 * none — review R8-copy#2).
 */
function semTerminal(texto: string, ehRascunho = false): string {
  if (!ehFraseDeTerminal(texto)) return texto;
  return ehRascunho ? FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE : FRASE_RECUSA_SEM_PASSO_SHOPEE;
}

/**
 * The title of OUR 422 (`SHOPEE_PUBLISH_BLOCKED`). ⚠️ Never «nada foi enviado
 * à Shopee» (review R7-roundtrip#0 and siblings): on an UPDATE — a live
 * listing's Republicar, an adopted draft, a draft published elsewhere
 * meanwhile — the model leg refuses AFTER `update_item`, and the body names
 * no etapa that would tell it apart from the (usual) refusal before any
 * write. Who refused is all it claims; each row says what to fix.
 */
export const TITULO_PUBLICACAO_BLOQUEADA_SHOPEE = 'Publicação bloqueada pelo ERP';

/** The title of Shopee's own refusal (`SHOPEE_PUBLISH_REJECTED`). */
export const TITULO_PUBLICACAO_RECUSADA_SHOPEE = 'A Shopee recusou a publicação';

/** `pausadoAte` (ISO-8601) in São Paulo, or `null` when absent or unreadable. */
function instanteIso(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = parseIsoToMillis(iso);
  return ms === null ? null : formatarInstanteShopee(ms);
}

/**
 * The pause/reactivate answer for THIS link. The run's own per-listing
 * sentence says what Shopee CONFIRMED (never the action requested); a run
 * Shopee's daily quota stopped says until when.
 */
function DesfechoStatus({
  linkDocId,
  resposta,
}: {
  linkDocId: string;
  resposta: AnuncioStatusShopee;
}) {
  // One listing was addressed, so there is at most one row — matched by link,
  // with the first row as the fallback for a backend that echoes none.
  const linha =
    resposta.listings.find((l) => l.linkDocId === linkDocId) ?? resposta.listings[0] ?? null;
  const semAnuncio = resposta.produtosSemAnuncio[0] ?? null;
  const cor =
    linha === null
      ? 'yellow'
      : linha.outcome === 'enviado'
        ? 'green'
        : linha.outcome === 'falha'
          ? 'red'
          : 'yellow';
  const pausaAte = instanteIso(resposta.pausadoAte);
  return (
    <Alert color={cor} variant="light">
      <Text size="sm">
        {semTerminal(linha?.mensagem ?? semAnuncio?.mensagem ?? 'Nenhum anúncio foi alterado.')}
      </Text>
      {pausaAte !== null && (
        <Text size="sm" mt={4}>
          Cota diária da Shopee esgotada até {pausaAte}.
        </Text>
      )}
    </Alert>
  );
}

/**
 * The publish's answer, by arm: a native kit's ({@link DesfechoKit}), the
 * ordinary listing's 202 ({@link DesfechoItemIncerto}), or its 200
 * ({@link DesfechoItem}) — a DRAFT's 200 worded as such (`pedidoRascunho`).
 */
function DesfechoPublicado({
  contaId,
  resposta,
  pedidoRascunho,
  acoes,
  rascunho,
}: {
  contaId: string;
  resposta: RespostaPublicarShopee;
  pedidoRascunho: PedidoDoRascunhoShopee | null;
  acoes: AcoesShopee;
  rascunho: DesfechoDoRascunhoShopee | null;
}) {
  if (resposta.tipo === 'kit')
    return <DesfechoKit contaId={contaId} kit={resposta} acoes={acoes} />;
  if (resposta.tipo === 'item-incerto')
    return <DesfechoItemIncerto resposta={resposta} rascunho={rascunho} />;
  return <DesfechoItem item={resposta} pedidoRascunho={pedidoRascunho} />;
}

/**
 * The ordinary listing's **202** — a draft's first create whose outcome is
 * unknown. NEVER «falhou». The wait is the block's CURRENT reading, re-worded
 * on every render (`fraseDoAnuncioIncertoShopee` over `rascunho.publicacao` at
 * `rascunho.nowMs`): the 202's own `aguardarMs` is never read — the route
 * answers it even when re-arming the lock did not land (rev. 2a #7). Its
 * `mensagem` (CLI text) is not even declared on the wire.
 */
function DesfechoItemIncerto({
  resposta,
  rascunho,
}: {
  resposta: RespostaItemIncertoShopee;
  rascunho: DesfechoDoRascunhoShopee | null;
}) {
  return (
    <Alert color="yellow" variant="light" title={TITULO_ANUNCIO_INCERTO_SHOPEE}>
      <Text size="sm">
        {rascunho === null
          ? FRASE_INCERTO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE
          : fraseDoAnuncioIncertoShopee(resposta, rascunho.publicacao, rascunho.nowMs)}
      </Text>
    </Alert>
  );
}

/**
 * The ordinary listing's 200: what the update changed on Shopee. A DRAFT's
 * (`pedidoRascunho`) opens with what Shopee READS of the listing
 * (`fraseDoRascunhoPublicadoShopee`) — never «criado» (a draft live meanwhile
 * is merely republished, an `incerta` one may adopt) and never an implied
 * «Criar pausado» (rev. 2a #14) — and is never titled «republicado».
 */
function DesfechoItem({
  item,
  pedidoRascunho,
}: {
  item: ItemPublicadoShopee;
  pedidoRascunho: PedidoDoRascunhoShopee | null;
}) {
  const { modelos, fotos, tabelaDeMedidas } = item;
  const linhas = [
    modelos.total > 0
      ? `Variações: ${String(modelos.atualizados)} atualizada(s), ${String(modelos.criados)} criada(s)` +
        (modelos.semFilho > 0
          ? `; ${String(modelos.semFilho)} sem produto correspondente no ERP.`
          : '.')
      : null,
    `Fotos: ${String(fotos.enviadas)} enviada(s), ${String(fotos.reutilizadas)} reaproveitada(s)` +
      (fotos.falhas > 0 ? `; ${String(fotos.falhas)} falharam.` : '.'),
    textoDaTabelaDeMedidas(tabelaDeMedidas),
    item.taxInfoOmitido === null ? null : `Dados fiscais não enviados (${item.taxInfoOmitido}).`,
    item.avisoShopee === null ? null : `A Shopee avisou: ${semTerminal(item.avisoShopee)}`,
  ].filter((l): l is string => l !== null);
  return (
    <Alert
      color="green"
      variant="light"
      title={
        pedidoRascunho === null ? 'Anúncio republicado na Shopee' : TITULO_RASCUNHO_PUBLICADO_SHOPEE
      }
    >
      {pedidoRascunho !== null && (
        <Text size="sm" mb={4}>
          {fraseDoRascunhoPublicadoShopee(item, { pausadoPedido: pedidoRascunho.pausado })}
        </Text>
      )}
      <List size="sm" spacing={2}>
        {linhas.map((l) => (
          <List.Item key={l}>{l}</List.Item>
        ))}
      </List>
    </Alert>
  );
}

/** Which size chart actually went out — the publish's own answer, never the tab's guess. */
function textoDaTabelaDeMedidas(t: ItemPublicadoShopee['tabelaDeMedidas']): string {
  if (t.fonte === 'modelo' && t.sizeChartId !== null) {
    return `Tabela de medidas: modelo #${String(t.sizeChartId)}.`;
  }
  if (t.fonte === 'foto') return 'Tabela de medidas: enviada como foto.';
  if (t.fonte === 'nenhuma') {
    return t.avisoObrigatoria
      ? 'Nenhuma tabela de medidas foi enviada — a categoria exige uma.'
      : 'Nenhuma tabela de medidas foi enviada.';
  }
  return `Tabela de medidas: ${t.fonte}.`;
}

const ROTULO_DESFECHO_KIT = {
  criado: 'Kit nativo criado na Shopee',
  retomado: 'Kit nativo retomado na Shopee',
  atualizado: 'Kit nativo atualizado na Shopee',
  incerto: 'A Shopee não confirmou o resultado',
} as const satisfies Record<KitPublicadoShopee['desfecho'], string>;

/**
 * A native kit's 200: a republish (`kit-atualizar`), or a recriar / converter
 * that created or resumed a kit. Each aviso is worded by
 * {@link textoDoAvisoKit} — the 200 carries the CODE only, and a code this
 * build does not know reads a neutral line naming it. A create also says which
 * link holds the new kit and what became of the listing it replaced.
 *
 * The next step an aviso asks for is a button ({@link passosDoAvisoKit}), on
 * the link the BODY names — the new kit's `linkDocId` or the replaced
 * listing's `antecessor.linkDocId` — never the block the outcome sits in, and
 * only while the tab holds that link loaded and addressable.
 *
 * The uncertain outcome here only says to wait and re-verify: it is the plain
 * republish's (which never reaches a create arm, so no identical re-send is
 * owed). A create's uncertainty is the editor's `incertos`, with its "Repetir".
 */
function DesfechoKit({
  contaId,
  kit,
  acoes,
}: {
  contaId: string;
  kit: KitPublicadoShopee;
  acoes: AcoesShopee;
}) {
  if (kit.desfecho === 'incerto') {
    const minutos = Math.ceil((kit.aguardarMs ?? AGUARDAR_KIT_INCERTO_SHOPEE_MS) / 60_000);
    return (
      <Alert color="yellow" variant="light" title={ROTULO_DESFECHO_KIT.incerto}>
        <Text size="sm">
          Aguarde {minutos} minutos e use &quot;Reverificar&quot; antes de publicar de novo.
        </Text>
      </Alert>
    );
  }
  const novo =
    kit.arma !== 'kit-atualizar' && kit.linkDocId !== null
      ? `Kit novo: vínculo ${kit.linkDocId}` +
        (kit.itemId === null ? '.' : ` (anúncio ${String(kit.itemId)} na Shopee).`)
      : null;
  const antecessor = kit.antecessor;
  const fraseDoAntecessor =
    antecessor === null
      ? null
      : antecessor.excluido
        ? `O anúncio anterior (vínculo ${antecessor.linkDocId}) foi excluído na Shopee.`
        : antecessor.substituido
          ? `O anúncio anterior (vínculo ${antecessor.linkDocId}) foi marcado como substituído e ` +
            'ainda pode estar vendendo na Shopee.'
          : `O anúncio anterior (vínculo ${antecessor.linkDocId}) não foi alterado.`;
  const passos = acoes.permitidas ? passosDoAvisoKit(kit, contaId, acoes) : [];
  return (
    <Alert
      color={kit.avisos.length > 0 ? 'yellow' : 'green'}
      variant="light"
      title={ROTULO_DESFECHO_KIT[kit.desfecho]}
    >
      <Stack gap={4}>
        {novo !== null && <Text size="sm">{novo}</Text>}
        {fraseDoAntecessor !== null && <Text size="sm">{fraseDoAntecessor}</Text>}
        {kit.avisos.length > 0 && (
          <List size="sm" spacing={2} data-testid="shopee-kit-avisos">
            {kit.avisos.map((a, i) => (
              <List.Item key={`${a.codigo}-${a.produtoId ?? ''}-${String(i)}`}>
                {textoDoAvisoKit(a.codigo)}
                {a.produtoId === null ? '' : ` (produto ${a.produtoId})`}
              </List.Item>
            ))}
          </List>
        )}
        {kit.avisosResolvidos > 0 && (
          <Text size="sm">{kit.avisosResolvidos} aviso(s) de composição resolvido(s).</Text>
        )}
        {passos.length > 0 && (
          <Group gap="xs">
            {passos.map((p) => (
              <BotaoDoPasso key={p.rotulo} contaId={contaId} passo={p} acoes={acoes} />
            ))}
          </Group>
        )}
      </Stack>
    </Alert>
  );
}

/** One next step a refusal row or a kit aviso offers, already bound to its link. */
interface PassoShopee {
  readonly rotulo: string;
  /**
   * The link the step sends, or whose kit confirmation it opens. ⚠️ Its button
   * renders only while `AcoesShopee.enderecavel(alvo)` holds — a loaded link
   * whose `item_id` addresses a listing: every step names its link by id alone,
   * and the outcome it sits in outlives a rewrite of that link.
   */
  readonly alvo: string;
  readonly agir: () => void;
  /**
   * A native-kit CREATE (recriar / converter): it also waits out this conta's
   * uncertain create — a second `add_kit_item` before Shopee lists the first is
   * a second kit.
   */
  readonly criaKit: boolean;
}

/**
 * The buttons a kit 200's avisos ask for, one per distinct step:
 *
 *  - `receita-divergente` → recriar the kit the run addressed (`linkDocId`);
 *  - `kit-novo-inativo` → reactivate the NEW kit (`linkDocId`) — only when
 *    `podeMoverAnuncioShopee` allows it on the kit's reading, the predicate the
 *    block's own Reativar and the route's pre-check use (a banned kit is never
 *    relisted, one under review is Shopee's to change) — then recriar the OLD
 *    one (`antecessor.linkDocId`): the old kit is deleted only once the new one
 *    is live;
 *  - `kit-antigo-nao-excluido` → re-verify the OLD listing (`antecessor`);
 *  - every other code is text: its next step is in the ERP or Seller Centre,
 *    or (`kit-alvo-mais-novo`) the body does not say which kit is the old one.
 *
 * ⚠️ Each step is offered only on a link `AcoesShopee.enderecavel` holds
 * ({@link PassoShopee.alvo}). The BODY's ids are no stand-in: `kit-novo-inativo`'s
 * predicate reads the body's `itemId`, a wire `z.number().int()` that already
 * refuses a fraction or 2^53 — but the outcome stays on screen after the
 * snapshot rewrites `novo`, and a link the tab has not loaded would put the
 * step's own outcome in no visible block.
 */
function passosDoAvisoKit(
  kit: KitPublicadoShopee,
  contaId: string,
  acoes: AcoesShopee,
): readonly PassoShopee[] {
  const passos = new Map<string, PassoShopee>();
  const juntar = (p: PassoShopee) => {
    if (acoes.enderecavel(p.alvo) && !passos.has(p.rotulo)) passos.set(p.rotulo, p);
  };
  const recriar = (alvo: string): PassoShopee => ({
    rotulo: `Recriar o kit do vínculo ${alvo}`,
    alvo,
    agir: () => acoes.abrirKit(contaId, alvo, 'recriar'),
    criaKit: true,
  });
  const novo = kit.linkDocId;
  const antigo = kit.antecessor?.linkDocId ?? null;
  for (const { codigo } of kit.avisos) {
    if (codigo === 'receita-divergente' && novo !== null) juntar(recriar(novo));
    if (codigo === 'kit-novo-inativo') {
      const reativavel = podeMoverAnuncioShopee(
        { item_id: kit.itemId, estadoAnuncio: kit.estadoAnuncio },
        ACAO_STATUS_ANUNCIO.reativar,
      ).pode;
      if (novo !== null && reativavel) {
        juntar({
          rotulo: `Reativar o kit novo (vínculo ${novo})`,
          alvo: novo,
          agir: () => acoes.reativar(contaId, novo),
          criaKit: false,
        });
      }
      if (antigo !== null) juntar(recriar(antigo));
    }
    if (codigo === 'kit-antigo-nao-excluido' && antigo !== null) {
      juntar({
        rotulo: `Reverificar o vínculo ${antigo}`,
        alvo: antigo,
        agir: () => acoes.reverificar(contaId, antigo),
        criaKit: false,
      });
    }
  }
  return [...passos.values()];
}

/** The button of one {@link PassoShopee}: disabled with every write button, and a create also by the wait. */
function BotaoDoPasso({
  contaId,
  passo,
  acoes,
}: {
  contaId: string;
  passo: PassoShopee;
  acoes: AcoesShopee;
}) {
  const esperando = passo.criaKit && (acoes.incertoDe(contaId)?.pendente ?? false);
  return (
    <Button
      type="button"
      size="xs"
      variant="light"
      disabled={acoes.bloqueadas || esperando}
      onClick={passo.agir}
    >
      {passo.rotulo}
    </Button>
  );
}

/**
 * The publish 422: one row per refusal. A row with an `acao` reads the tab's
 * copy and offers the next step on the link the `acao` names:
 *
 *  - `republicar` with a link → "Republicar o vínculo <id>" on THAT link, the
 *    successor — when the row is about the block itself (the dispatcher's
 *    case). A row about ANOTHER superseded link (a kit create's duplicate scan
 *    found K's old kit still live, `vinculoSubstituidoAlheio`) offers "Recriar
 *    o kit do vínculo <antigo>" instead, the retry of its delete: republishing
 *    the successor — often the very block — cannot clear it;
 *  - `sem-opcoes-de-kit` → a republish of this link, with no kit option;
 *  - `recriar` → the Recriar confirmation for the link the `acao` names (a
 *    removed native kit is not necessarily the block the refusal sits in);
 *  - `informar-principal` → the SAME kit arm's confirmation again, its cursor on
 *    the principal pick — only after a recriar / converter (a plain republish
 *    never sends a principal, so it has nothing to re-open);
 *  - `importar` / `escolher-vinculo` → text: they point elsewhere.
 *
 * ⚠️ A button renders only for a target `AcoesShopee.enderecavel` holds — a
 * loaded link whose `item_id` can address a listing, the gate every block's own
 * buttons pass (`AcoesAnuncioShopee`, and the kit arms' `recriavel` /
 * `convertivel`). Every branch's target is a link id alone — the `acao`'s (a
 * successor from a stored `substituidoPorLinkDocId`, a removed kit, a superseded
 * old kit) or, for `sem-opcoes-de-kit` and `informar-principal`, the refused
 * request's own — and the outcome outlives a rewrite of that link, so the tab
 * checks the link it would send; without a button the row's text stays. A kit
 * step only opens the confirmation, whose confirm checks the same again.
 *
 * ⚠️ So a `republicar{linkDocId: <a draft>}` row (P1's `rascunho-nao-nomeado`)
 * gets NO button — a draft has no `item_id` (K2-13): a draft's Publicar is
 * never reached through a refusal row, only through its own confirmation.
 *
 * #1911 P11 adds, per row, two things the `acao` does not carry:
 *
 *  - **the surface that fixes its `campo`** ({@link BotaoDaSuperficie},
 *    `superficieDoCampoShopee`): a field of this draft's form, a produto tab,
 *    the variations or the size chart, or — a published listing's own
 *    content — the Seller-Centre line. An unmapped campo keeps the sentence
 *    and gets nothing (the safe fallback);
 *  - **a draft's Seller-Centre attestation exits** ({@link SaidasDoProblema},
 *    `saidasDoProblemaShopee`, keyed on the exact motivo slug): only on a
 *    DRAFT (`rascunho`), only with `acoes.permitidas`.
 */
function DesfechoRecusado({
  contaId,
  produtoId,
  linkDocId,
  desfecho,
  acoes,
  descricaoPropria,
  destinos,
  rascunho,
}: {
  contaId: string;
  produtoId: string;
  linkDocId: string;
  desfecho: Extract<DesfechoAcaoShopee, { tipo: 'recusado' }>;
  acoes: AcoesShopee;
  descricaoPropria: boolean;
  destinos: DestinosDasSuperficiesShopee;
  rascunho: DesfechoDoRascunhoShopee | null;
}) {
  const ehRascunho = rascunho !== null;
  // A DRAFT row is worded by the block's facts NOW (§I1 / §I2, R8-copy#2/#5);
  // `null` ⇔ a live listing's row.
  const contextoDoRascunho =
    rascunho === null
      ? null
      : {
          publicacao: rascunho.publicacao,
          skuEnviado: rascunho.skuEnviado,
          respondeAtestacao: desfecho.respondeAtestacao,
        };
  return (
    <Alert
      color="red"
      variant="light"
      title={
        desfecho.bloqueadaPeloErp
          ? TITULO_PUBLICACAO_BLOQUEADA_SHOPEE
          : TITULO_PUBLICACAO_RECUSADA_SHOPEE
      }
    >
      <Stack gap="xs">
        {desfecho.etapa !== null && (
          <Text size="sm">{textoDaEtapaShopee(desfecho.etapa, { ehRascunho })}</Text>
        )}
        {desfecho.problemas.length === 0 ? (
          <Text size="sm">{semTerminal(desfecho.mensagem, ehRascunho)}</Text>
        ) : (
          desfecho.problemas.map((p, i) => (
            <Stack key={i} gap={4} data-testid={`shopee-problema-${linkDocId}-${String(i)}`}>
              <Text size="sm">
                {textoDoProblemaShopee(p, linkDocId, produtoId, contextoDoRascunho)}
              </Text>
              <BotaoDoProblema
                contaId={contaId}
                linkDocId={linkDocId}
                problema={p}
                pedidoKit={desfecho.pedidoKit}
                acoes={acoes}
              />
              <BotaoDaSuperficie
                linkDocId={linkDocId}
                superficie={superficieDoCampoShopee(p, { ehRascunho, descricaoPropria })}
                destinos={destinos}
              />
              {rascunho !== null && acoes.permitidas && (
                <SaidasDoProblema
                  saidas={saidasDoProblemaShopee(p, { ehRascunho })}
                  rascunho={rascunho}
                  acoes={acoes}
                />
              )}
            </Stack>
          ))
        )}
      </Stack>
    </Alert>
  );
}

/**
 * The button (or line) of a refusal row's surface — navigation only, nothing
 * is written, so it is offered to every operator who sees the row:
 *
 *  - `rascunho` — «Corrigir no rascunho: <campo>» focuses that field of THIS
 *    draft's form ({@link idDoCampoRascunhoShopee}); its `aviso` (a Shopee
 *    brand refusal) reads beside it;
 *  - `produto` — «Abrir no produto: <aba>» switches the produto's ObjectView
 *    tab (`sectionOfField` → `goToSection`); no button when the view names no
 *    tab for the field (rendered outside it, or the field has no input);
 *  - `variacoes` / `medidas` — a link to the page the editor names
 *    (`destinos`), or nothing when it names none;
 *  - `seller-centre` — a published listing's own content (D8): text, no link;
 *  - `null` — an unmapped campo: nothing (the row keeps its sentence).
 */
function BotaoDaSuperficie({
  linkDocId,
  superficie,
  destinos,
}: {
  linkDocId: string;
  superficie: SuperficieDoCampoShopee | null;
  destinos: DestinosDasSuperficiesShopee;
}) {
  const secoes = useObjectViewSections();
  if (superficie === null) return null;
  switch (superficie.tipo) {
    case 'seller-centre':
      return (
        <Text size="sm" c="dimmed">
          {rotuloDaSuperficieShopee(superficie, null)}
        </Text>
      );
    case 'rascunho': {
      const { campo, aviso } = superficie;
      return (
        <Stack gap={2}>
          {aviso !== null && <Text size="sm">{aviso}</Text>}
          <Group>
            <Button
              type="button"
              size="xs"
              variant="light"
              onClick={() => focarCampoRascunhoShopee(linkDocId, campo)}
            >
              {rotuloDaSuperficieShopee(superficie, null)}
            </Button>
          </Group>
        </Stack>
      );
    }
    case 'produto': {
      const secao = secoes?.sectionOfField(superficie.campo) ?? null;
      if (secoes === null || secao === null) return null;
      return (
        <Group>
          <Button type="button" size="xs" variant="light" onClick={() => secoes.goToSection(secao)}>
            {rotuloDaSuperficieShopee(superficie, secao)}
          </Button>
        </Group>
      );
    }
    case 'variacoes':
    case 'medidas': {
      const href = superficie.tipo === 'variacoes' ? destinos.variacoes : destinos.medidas;
      if (href === null) return null;
      return (
        <Group>
          <Button component={Link} href={href} size="xs" variant="light">
            {rotuloDaSuperficieShopee(superficie, null)}
          </Button>
        </Group>
      );
    }
  }
}

/**
 * A DRAFT's Seller-Centre attestation exits of one refusal row — exactly what
 * `saidasDoProblemaShopee` returns (keyed on the motivo SLUG: a renamed one
 * gets none, the safe direction; `criacao-incerta-ambigua` never gets one).
 * Each button hands its exit to the editor (`rascunho.onSaida`), which never
 * re-sends directly: `publicar-atestando` opens the SAME «Publicar»
 * confirmation and gate, `descartar-atestando` its discard confirmation.
 * Disabled with every write button, and by the draft's own decision
 * (`podePublicar` / `podeDescartar`). A discard exit's `aviso` (an UNLINKED
 * listing that stays on Shopee) reads before the click.
 */
function SaidasDoProblema({
  saidas,
  rascunho,
  acoes,
}: {
  saidas: readonly SaidaDoProblemaShopee[];
  rascunho: DesfechoDoRascunhoShopee;
  acoes: AcoesShopee;
}) {
  if (saidas.length === 0) return null;
  return (
    <Stack gap={4}>
      {saidas.map((s) =>
        s.tipo === 'descartar-atestando' && s.aviso !== null ? (
          <Text key={`aviso-${s.rotulo}`} size="sm">
            {s.aviso}
          </Text>
        ) : null,
      )}
      <Group gap="xs">
        {saidas.map((s) => (
          <Button
            key={s.rotulo}
            type="button"
            size="xs"
            variant="light"
            color={s.tipo === 'descartar-atestando' ? 'red' : 'orange'}
            disabled={
              acoes.bloqueadas ||
              (s.tipo === 'publicar-atestando' ? !rascunho.podePublicar : !rascunho.podeDescartar)
            }
            onClick={() => rascunho.onSaida(s)}
          >
            {s.rotulo}
          </Button>
        ))}
      </Group>
    </Stack>
  );
}

function BotaoDoProblema({
  contaId,
  linkDocId,
  problema,
  pedidoKit,
  acoes,
}: {
  contaId: string;
  linkDocId: string;
  problema: ProblemaShopee;
  pedidoKit: Extract<DesfechoAcaoShopee, { tipo: 'recusado' }>['pedidoKit'];
  acoes: AcoesShopee;
}) {
  const { acao } = problema;
  if (acao === null || !acoes.permitidas) return null;
  const passo = passoDoProblema(contaId, linkDocId, acao, pedidoKit, acoes);
  // The docblock's ⚠️: the link the step would send must still address a listing.
  if (passo === null || !acoes.enderecavel(passo.alvo)) return null;
  return (
    <Group>
      <BotaoDoPasso contaId={contaId} passo={passo} acoes={acoes} />
    </Group>
  );
}

/** The step a refusal row's `acao` asks for ({@link DesfechoRecusado}'s list), or `null` for a text-only row. */
function passoDoProblema(
  contaId: string,
  linkDocId: string,
  acao: NonNullable<ProblemaShopee['acao']>,
  pedidoKit: Extract<DesfechoAcaoShopee, { tipo: 'recusado' }>['pedidoKit'],
  acoes: AcoesShopee,
): PassoShopee | null {
  const antigo = vinculoSubstituidoAlheio(acao, linkDocId);
  if (antigo !== null) {
    return {
      rotulo: `Recriar o kit do vínculo ${antigo}`,
      alvo: antigo,
      agir: () => acoes.abrirKit(contaId, antigo, 'recriar'),
      criaKit: true,
    };
  }
  if (acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar && acao.linkDocId !== null) {
    const republicado = acao.linkDocId;
    return {
      rotulo: `Republicar o vínculo ${republicado}`,
      alvo: republicado,
      agir: () => acoes.republicar(contaId, republicado),
      criaKit: false,
    };
  }
  if (acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.semOpcoesDeKit) {
    return {
      rotulo: 'Republicar sem as opções de kit',
      alvo: linkDocId,
      agir: () => acoes.republicar(contaId, linkDocId),
      criaKit: false,
    };
  }
  if (acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar) {
    const recriado = acao.linkDocId;
    return {
      rotulo: `Recriar o kit do vínculo ${recriado}`,
      alvo: recriado,
      agir: () => acoes.abrirKit(contaId, recriado, 'recriar'),
      criaKit: true,
    };
  }
  if (acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.informarPrincipal && pedidoKit !== null) {
    return {
      rotulo: 'Escolher o componente principal',
      alvo: pedidoKit.linkDocId,
      agir: () => acoes.abrirKit(contaId, pedidoKit.linkDocId, pedidoKit.arma, true),
      criaKit: true,
    };
  }
  return null;
}
