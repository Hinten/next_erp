'use client';

import { Button, Group, Text } from '@mantine/core';
import {
  ACAO_STATUS_ANUNCIO,
  anuncioShopeeVivo,
  ehVinculoSubstituido,
  podeMoverAnuncioShopee,
  type ProdutoShopeeLink,
} from '@delfrance/schemas';

import {
  FRASE_ITEM_ID_INVALIDO_SHOPEE,
  FRASE_PRIMEIRA_PUBLICACAO_SHOPEE,
  itemIdDoAnuncioShopee,
  type IncertoKitShopee,
} from '@/lib/shopee/anuncioProduto';
import type { DesfechoAcaoShopee } from './DesfechoAcaoShopee';

/** The two native-kit CREATE arms of a publish — each makes a NEW kit on Shopee. */
export type ArmaKitShopee = 'recriar' | 'converter';

/** The writes a listing block can start — each one an apps/shopee route. */
export type AcaoDoAnuncioShopee =
  | 'pausar'
  | 'reativar'
  | 'reverificar'
  | 'publicar'
  | ArmaKitShopee;

/**
 * A kit create the server could not confirm, as the tab shows it: the stored
 * wait and body, whether the wait is still running, and Shopee's own refusal
 * sentence when the 202 carried one (this page only — a reload keeps the wait,
 * not the sentence).
 */
export interface IncertoKitNaTela extends IncertoKitShopee {
  readonly pendente: boolean;
  readonly fraseShopee: string | null;
}

/**
 * What the editor hands every listing block about the actions. The STATE lives
 * in the editor (its rule R2) — the in-flight write and every link's last
 * outcome — so a block is presentational and a hidden section loses nothing.
 */
export interface AcoesShopee {
  /** `integracao.write` resolved and granted. Without it no action renders at all. */
  readonly permitidas: boolean;
  /**
   * Every write button is disabled: the produto form is read-only, the client
   * is not ready, or a write from this tab is in flight (one at a time).
   */
  readonly bloqueadas: boolean;
  /** The write in flight from this tab — its button shows the spinner. */
  readonly emVoo: { readonly linkDocId: string; readonly acao: AcaoDoAnuncioShopee } | null;
  readonly desfechoDe: (linkDocId: string) => DesfechoAcaoShopee | null;
  /**
   * Whether the editor's live links hold `linkDocId` with an `item_id` that can
   * address a Shopee listing (`itemIdDoAnuncioShopee`). A button that sends a
   * link id it does not hold in hand asks this first: a refusal row and a kit
   * aviso name links other than their block's, and the pause and kit
   * confirmations outlive the click that opened them (the editor's own render
   * reads the same Set directly). A link the tab did not load answers `false` —
   * its outcome would land in a block that is not on screen. The one exception
   * is "Repetir", the identical re-send of an uncertain kit create.
   */
  readonly enderecavel: (linkDocId: string) => boolean;
  /** Opens the pause confirmation; the editor sends on confirm. */
  readonly pedirPausa: (contaId: string, linkDocId: string) => void;
  readonly reativar: (contaId: string, linkDocId: string) => void;
  readonly reverificar: (contaId: string, linkDocId: string) => void;
  /** A publish of an EXISTING link, naming it — never a kit option. */
  readonly republicar: (contaId: string, linkDocId: string) => void;
  /**
   * Opens the native-kit confirmation of one link — recriar or converter; the
   * editor sends on confirm. `focarPrincipal` puts the cursor on the principal
   * pick (a refusal that asked for one).
   */
  readonly abrirKit: (
    contaId: string,
    linkDocId: string,
    arma: ArmaKitShopee,
    focarPrincipal?: boolean,
  ) => void;
  /** The conta's uncertain kit create from THIS browser tab, or `null`. */
  readonly incertoDe: (contaId: string) => IncertoKitNaTela | null;
  /** Re-sends the uncertain create's IDENTICAL body — once its wait is over. */
  readonly repetirKit: (contaId: string) => void;
  /** Whether the link's kit block shows its composition (R2: the editor keeps it). */
  readonly kitAberto: (linkDocId: string) => boolean;
  readonly alternarKit: (linkDocId: string) => void;
}

export interface AcoesAnuncioShopeeProps {
  contaId: string;
  linkDocId: string;
  link: ProdutoShopeeLink;
  acoes: AcoesShopee;
}

/**
 * One listing's action row.
 *
 * ⚠️ **Every button needs an ADDRESSABLE `item_id`** —
 * `itemIdDoAnuncioShopee`, a positive SAFE integer — before any rule below is
 * asked. The two schemas predicates test `isFinite` only, so a malformed row's
 * `1.5` or `2 ** 53` passes them; they stay apps/shopee's batch filters, and
 * the tab does not offer Shopee an id that cannot name a listing.
 *
 *  - **Pausar anúncio / Reativar anúncio** — exactly when the schemas'
 *    `podeMoverAnuncioShopee` says so, the predicate `pausarAnuncio.ts` filters
 *    its batch with (#1369: never a web copy). A never-folded link
 *    (`estadoAnuncio: null`, the imported corpus) is movable both ways; a
 *    removed one is not.
 *  - **Reverificar** — every addressable link.
 *  - **Republicar** — a listing the ERP still publishes to: alive by
 *    `anuncioShopeeVivo` and not superseded (a superseded link is refused by the
 *    dispatcher, a removed one has nothing to update). Never with a kit option.
 *  - A DRAFT link (`item_id` absent) gets no button: a first publish is not
 *    offered in this step, and the row says where it will come from.
 *  - A link whose `item_id` is present but NOT addressable gets no button
 *    either, and one dimmed line saying so — never the draft's sentence: it is
 *    not waiting for a first publish. (Its status reads "Não publicado", the
 *    same `itemIdDoAnuncioShopee` reading.)
 *
 * The native-kit arms (recriar, converter, the principal) are not here — they
 * sit in the block's kit section (`KitAnuncioShopee`), with the uncertain
 * outcome a create can end in.
 */
export function AcoesAnuncioShopee({ contaId, linkDocId, link, acoes }: AcoesAnuncioShopeeProps) {
  // `== null`: a raw (unparsed) draft may lack the key altogether.
  if (link.item_id == null) {
    return (
      <Text size="sm" c="dimmed">
        {FRASE_PRIMEIRA_PUBLICACAO_SHOPEE}
      </Text>
    );
  }
  // The addressing gate, before every button (the docblock's ⚠️).
  if (itemIdDoAnuncioShopee(link.item_id) === null) {
    return (
      <Text size="sm" c="dimmed">
        {FRASE_ITEM_ID_INVALIDO_SHOPEE}
      </Text>
    );
  }
  if (!acoes.permitidas) return null;

  const pausavel = podeMoverAnuncioShopee(link, ACAO_STATUS_ANUNCIO.pausar).pode;
  const reativavel = podeMoverAnuncioShopee(link, ACAO_STATUS_ANUNCIO.reativar).pode;
  const republicavel = anuncioShopeeVivo(link) && !ehVinculoSubstituido(link);

  const carregando = (acao: AcaoDoAnuncioShopee) =>
    acoes.emVoo !== null && acoes.emVoo.linkDocId === linkDocId && acoes.emVoo.acao === acao;

  return (
    <Group gap="xs">
      {republicavel && (
        <Button
          type="button"
          size="xs"
          variant="light"
          disabled={acoes.bloqueadas}
          loading={carregando('publicar')}
          onClick={() => acoes.republicar(contaId, linkDocId)}
        >
          Republicar
        </Button>
      )}
      <Button
        type="button"
        size="xs"
        variant="default"
        disabled={acoes.bloqueadas}
        loading={carregando('reverificar')}
        onClick={() => acoes.reverificar(contaId, linkDocId)}
      >
        Reverificar
      </Button>
      {pausavel && (
        <Button
          type="button"
          size="xs"
          variant="light"
          color="orange"
          disabled={acoes.bloqueadas}
          loading={carregando('pausar')}
          onClick={() => acoes.pedirPausa(contaId, linkDocId)}
        >
          Pausar anúncio
        </Button>
      )}
      {reativavel && (
        <Button
          type="button"
          size="xs"
          variant="light"
          color="green"
          disabled={acoes.bloqueadas}
          loading={carregando('reativar')}
          onClick={() => acoes.reativar(contaId, linkDocId)}
        >
          Reativar anúncio
        </Button>
      )}
    </Group>
  );
}
