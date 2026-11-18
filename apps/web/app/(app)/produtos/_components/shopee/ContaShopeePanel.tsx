'use client';

import { useId, useMemo } from 'react';
import type { Firestore } from 'firebase/firestore';
import { Alert, Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import type { ProdutoShopeeLink } from '@delfrance/schemas';

import { ordenarVinculosShopee } from '@/lib/shopee/anuncioProduto';
import type { FormularioDoAnuncioShopee } from '@/lib/shopee/rascunho';
import {
  chaveDaContaShopee,
  type AcoesShopee,
  type EdicaoDoAnuncioNaTela,
} from './AcoesAnuncioShopee';
import { AnuncioShopeeBlock } from './AnuncioShopeeBlock';
import {
  DesfechoAcaoShopee,
  type DesfechoDoRascunhoShopee,
  type DestinosDasSuperficiesShopee,
} from './DesfechoAcaoShopee';
import { AvisoReceitaKitShopee } from './AvisoReceitaKitShopee';
import { IncertoDoKit } from './KitAnuncioShopee';
import { RascunhoShopee, type PropsDoFormularioShopee } from './RascunhoShopee';

/** One `prodshopee` row as the live snapshot hands it over (possibly the RAW doc — see `campos.ts`). */
export interface VinculoShopee {
  readonly id: string;
  readonly data: ProdutoShopeeLink;
}

/** One tab of the strip: a conta the query returned, or one a link names that it did not. */
export interface ContaShopee {
  readonly id: string;
  readonly nome: string;
  /** The conta's `shop_id`, unvalidated — the storefront URL checks it. */
  readonly shopId: unknown;
  readonly ativo: boolean;
  /** `false` for a tab built from a link's conta ref alone (no conta doc to show). */
  readonly encontrada: boolean;
  /**
   * `true` while that conta's by-id read has not answered — the tab must not
   * call it missing yet. Always `false` when `encontrada`.
   */
  readonly carregando: boolean;
}

/**
 * The produto's tabela de medidas, as far as the tab knows it. `ausente` is a
 * produto that names a tabela whose document does not exist (publish reports
 * that dangling ref itself; the tab only says it).
 */
export type TabelaMedidasDoProduto =
  | { readonly estado: 'sem-tabela' }
  | { readonly estado: 'carregando' }
  /** The ref names no `tabMedi` document (`lerRefTabelaDeMedidas`) — nothing was read. */
  | { readonly estado: 'ref-invalida'; readonly ref: string }
  | { readonly estado: 'ausente'; readonly id: string }
  | {
      readonly estado: 'tabela';
      readonly id: string;
      readonly nome: string;
      /** `tabelasMedidasShopee` verbatim — `lerEntradasShopeeDaConta` reads it. */
      readonly entradasShopee: unknown;
    };

/** A notice about a draft whose block is gone — it was discarded elsewhere while it held unsaved work. */
export interface AvisoDeRascunhoShopee {
  readonly linkDocId: string;
  readonly mensagem: string;
}

export type EstadoNovoAnuncioShopee =
  | { readonly tipo: 'habilitado' }
  | { readonly tipo: 'desabilitado' | 'oculto'; readonly motivo: string };

/**
 * What the editor hands the conta panel and every block about the listing
 * DRAFTS (#1911 P10) — the `AcoesShopee` of the draft editor. The STATE (the
 * drafts being edited, the write in flight, every confirmation) lives in the
 * editor (its rule R2); a panel and a block only render what this answers.
 */
export interface RascunhosShopee {
  readonly estadoNovoAnuncio: (contaId: string) => EstadoNovoAnuncioShopee;
  /**
   * «Novo anúncio»: a LOCAL draft at once — or, when the conta already holds
   * one of the produto's listings or drafts, the second-listing confirmation
   * first (D15). Nothing is sent.
   */
  readonly novoAnuncio: (contaId: string) => void;
  /** The conta's LOCAL new drafts (created on this screen, no document yet), in creation order. */
  readonly locaisDe: (contaId: string) => readonly string[];
  /**
   * The form of ONE link of this conta — a draft's (`modo` absent or `'rascunho'`), or an
   * EDITABLE PUBLISHED listing's (`modo: 'anuncio'`, PR3) — or `null` when the link has none
   * this tab edits. The editor branches on the block's `alvo` BEFORE it looks up a publish
   * decision, which a published block never has.
   */
  readonly propsDe: (conta: ContaShopee, linkDocId: string) => PropsDoFormularioShopee | null;
  /**
   * What the outcome panel and the field surfaces need of a PUBLISHED listing's edit form:
   * `{ logisticaConfiavel }` for a link whose block is an anuncio edit, else `null` (a draft,
   * a link with no form, a link not editable here — its refusal rows keep the Seller Centre).
   */
  readonly formularioDoAnuncioDe: (linkDocId: string) => FormularioDoAnuncioShopee | null;
  /**
   * The action row's view of that edit (`suja`: the form is dirty, `aguardandoEco`: a save awaits
   * the snapshot echo), or `null` when the link has no anuncio form.
   */
  readonly edicaoDoAnuncioDe: (linkDocId: string) => EdicaoDoAnuncioNaTela | null;
  /** The notice of a draft that became a listing while it held unsaved work — on that listing's block. */
  readonly avisoDe: (linkDocId: string) => string | null;
  /** The notices of drafts of this conta discarded elsewhere while they held unsaved work. */
  readonly avisosSemBlocoDe: (contaId: string) => readonly AvisoDeRascunhoShopee[];
  /** The operator read a notice: the dropped draft is forgotten. */
  readonly dispensarAviso: (linkDocId: string) => void;
  /**
   * The outcome panel's draft inputs (#1911 P11) for a block that is a DRAFT
   * now — its publish reading at the editor's clock, the «Publicar» decision
   * its attestation exits share with the form, and those exits' handler — or
   * `null` for a live listing (and once a draft stopped being one) — and for an
   * anuncio block (no attestation exit exists for it).
   */
  readonly desfechoDoRascunhoDe: (linkDocId: string) => DesfechoDoRascunhoShopee | null;
  /**
   * Where a refusal row's `variacoes` / `medidas` surface leads — the STORED
   * produto's, the same for every block of the tab, a draft's or a live
   * listing's.
   */
  readonly destinosDasSuperficies: DestinosDasSuperficiesShopee;
}

export interface ContaShopeePanelProps {
  db: Firestore;
  produtoId: string;
  conta: ContaShopee;
  vinculos: readonly VinculoShopee[];
  /** `false` for the tab of links whose conta ref names no id — no size chart can be resolved for them. */
  contaDoAnuncioLegivel: boolean;
  tabelaMedidas: TabelaMedidasDoProduto;
  agoraMs: number;
  modelosAbertos: ReadonlySet<string>;
  onAlternarModelos: (linkDocId: string) => void;
  /** The produto's STORED `ehKit`. */
  produtoEhKit: boolean;
  /** The actions — `permitidas: false` on a tab whose conta the query did not return. */
  acoes: AcoesShopee;
  /** The listing drafts (#1911 P10) — owned by the editor. */
  rascunhos: RascunhosShopee;
}

/**
 * One Shopee conta's listings on this produto, in `ordenarVinculosShopee` order
 * (live, then superseded, then removed or never published — a stored DRAFT is
 * one of these, its block holding the draft editor), then the conta's LOCAL
 * new drafts (#1911 P10: «Novo anúncio», nothing written until «Salvar
 * rascunho»), which have no document and so no listing block — this panel
 * frames each one itself. Presentational: the editor owns every piece of state
 * (its rule R2).
 *
 * Above the listings: «Novo anúncio» beside the conta's name, the conta's open
 * "kit with an old composition" aviso (only for a conta holding a native-kit
 * link), an uncertain kit create whose link this conta no longer lists — it
 * still blocks the kit buttons, so it is never left unexplained — and the
 * notice of a draft discarded elsewhere while it held unsaved work (never a
 * silent drop).
 */
export function ContaShopeePanel({
  db,
  produtoId,
  conta,
  vinculos,
  contaDoAnuncioLegivel,
  tabelaMedidas,
  agoraMs,
  modelosAbertos,
  onAlternarModelos,
  produtoEhKit,
  acoes,
  rascunhos,
}: ContaShopeePanelProps) {
  const ordenados = useMemo(() => ordenarVinculosShopee(vinculos), [vinculos]);
  const temKitNativo = vinculos.some((v) => v.data.kitNativo === true);
  const incerto = acoes.incertoDe(conta.id);
  const incertoSemBloco =
    incerto !== null && !vinculos.some((v) => v.id === incerto.corpo.linkDocId) ? incerto : null;
  const locais = rascunhos.locaisDe(conta.id);
  const avisosSemBloco = rascunhos.avisosSemBlocoDe(conta.id);
  // #1912: the conta's FIRST native-kit create — offered by the dispatcher's
  // own rule, and its outcome kept under the conta's key (it names no link).
  const chaveDaConta = chaveDaContaShopee(conta.id);
  const ofereceKitNativo =
    conta.encontrada &&
    acoes.permitidas &&
    acoes.ofereceKitNativo(
      conta.id,
      vinculos.map((v) => v.data),
    );
  const desfechoDaConta = acoes.desfechoDe(chaveDaConta);
  const publicandoKit = acoes.emVoo?.linkDocId === chaveDaConta;
  const estadoNovoAnuncio = rascunhos.estadoNovoAnuncio(conta.id);
  const motivoNovoAnuncioId = useId();

  return (
    <Card withBorder padding="md" data-testid={`shopee-conta-${conta.id}`}>
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>{conta.nome}</Text>
            {conta.encontrada && !conta.ativo && (
              <Badge color="gray" variant="light">
                Conta inativa
              </Badge>
            )}
          </Group>
          {/* Always offered (not only on an empty conta): a produto may hold
              several listings on one conta — behind the second-listing
              confirmation. A click sends NOTHING: the draft exists only on
              this screen until «Salvar rascunho». */}
          {ofereceKitNativo && (
            <Button
              type="button"
              size="xs"
              color="grape"
              data-testid={`shopee-publicar-kit-${conta.id}`}
              loading={publicandoKit}
              // An uncertain earlier create waits out its hold: a second
              // `add_kit_item` before Shopee lists the first is a second kit.
              disabled={acoes.bloqueadas || (incerto?.pendente ?? false)}
              onClick={() => acoes.abrirKit(conta.id, null, 'criar')}
            >
              Publicar como kit nativo
            </Button>
          )}
          {estadoNovoAnuncio.tipo !== 'oculto' && (
            <Button
              type="button"
              size="xs"
              variant={vinculos.length === 0 && locais.length === 0 ? 'filled' : 'light'}
              data-testid={`shopee-novo-anuncio-${conta.id}`}
              disabled={estadoNovoAnuncio.tipo === 'desabilitado'}
              aria-describedby={
                estadoNovoAnuncio.tipo === 'desabilitado' ? motivoNovoAnuncioId : undefined
              }
              onClick={() => rascunhos.novoAnuncio(conta.id)}
            >
              Novo anúncio
            </Button>
          )}
        </Group>

        {estadoNovoAnuncio.tipo !== 'habilitado' && (
          <Text id={motivoNovoAnuncioId} size="sm" c="dimmed">
            {estadoNovoAnuncio.motivo}
          </Text>
        )}

        {conta.encontrada && temKitNativo && (
          <AvisoReceitaKitShopee db={db} contaId={conta.id} produtoId={produtoId} />
        )}

        {incertoSemBloco !== null && (
          <IncertoDoKit contaId={conta.id} incerto={incertoSemBloco} acoes={acoes} />
        )}

        {desfechoDaConta !== null && (
          <DesfechoAcaoShopee
            contaId={conta.id}
            produtoId={produtoId}
            linkDocId={chaveDaConta}
            desfecho={desfechoDaConta}
            acoes={acoes}
            // A first kit create names no link: there is no stored listing text.
            descricaoPropria={false}
            destinosDasSuperficies={rascunhos.destinosDasSuperficies}
            rascunho={null}
          />
        )}

        {avisosSemBloco.map((a) => (
          <Alert
            key={a.linkDocId}
            color="orange"
            variant="light"
            withCloseButton
            closeButtonLabel="Dispensar aviso"
            onClose={() => rascunhos.dispensarAviso(a.linkDocId)}
            data-testid={`shopee-rascunho-aviso-${a.linkDocId}`}
          >
            {a.mensagem}
          </Alert>
        ))}

        {ordenados.length === 0 && (
          <Text size="sm" c="dimmed">
            Este produto não tem anúncio nesta conta.
          </Text>
        )}

        {ordenados.map((v) => (
          <AnuncioShopeeBlock
            key={v.id}
            db={db}
            produtoId={produtoId}
            linkDocId={v.id}
            link={v.data}
            conta={conta}
            contaDoAnuncioLegivel={contaDoAnuncioLegivel}
            tabelaMedidas={tabelaMedidas}
            agoraMs={agoraMs}
            modelosAberto={modelosAbertos.has(v.id)}
            onAlternarModelos={onAlternarModelos}
            produtoEhKit={produtoEhKit}
            acoes={acoes}
            rascunhos={rascunhos}
          />
        ))}

        {locais.map((linkDocId) => {
          const props = rascunhos.propsDe(conta, linkDocId);
          if (props === null) return null;
          return (
            <Card
              key={linkDocId}
              withBorder
              padding="sm"
              data-testid={`shopee-novo-rascunho-${linkDocId}`}
            >
              <Stack gap="sm">
                <Text fw={600} size="sm">
                  Novo anúncio
                </Text>
                <RascunhoShopee {...props} />
              </Stack>
            </Card>
          );
        })}
      </Stack>
    </Card>
  );
}
