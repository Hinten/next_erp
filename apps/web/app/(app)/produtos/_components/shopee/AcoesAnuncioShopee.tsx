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
  FRASE_PRIMEIRA_PUBLICACAO_SHOPEE,
  itemIdDoAnuncioShopee,
} from '@/lib/shopee/anuncioProduto';
import type { DesfechoAcaoShopee } from './DesfechoAcaoShopee';

/** The writes a listing block can start — each one an apps/shopee route. */
export type AcaoDoAnuncioShopee = 'pausar' | 'reativar' | 'reverificar' | 'publicar';

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
  /** Opens the pause confirmation; the editor sends on confirm. */
  readonly pedirPausa: (contaId: string, linkDocId: string) => void;
  readonly reativar: (contaId: string, linkDocId: string) => void;
  readonly reverificar: (contaId: string, linkDocId: string) => void;
  /** A publish of an EXISTING link, naming it — never a kit option. */
  readonly republicar: (contaId: string, linkDocId: string) => void;
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
 *  - **Pausar anúncio / Reativar anúncio** — exactly when the schemas'
 *    `podeMoverAnuncioShopee` says so, the predicate `pausarAnuncio.ts` filters
 *    its batch with (#1369: never a web copy). A never-folded link
 *    (`estadoAnuncio: null`, the imported corpus) is movable both ways; a
 *    removed one is not.
 *  - **Reverificar** — any link that names a listing.
 *  - **Republicar** — a listing the ERP still publishes to: alive by
 *    `anuncioShopeeVivo` and not superseded (a superseded link is refused by the
 *    dispatcher, a removed one has nothing to update). Never with a kit option.
 *  - A DRAFT link (`item_id` absent) gets no button: a first publish is not
 *    offered in this step, and the row says where it will come from.
 *
 * The native-kit arms (recriar, converter, the principal) are not here — they
 * carry their own single-flight and uncertain-outcome rules.
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
  if (!acoes.permitidas) return null;

  const pausavel = podeMoverAnuncioShopee(link, ACAO_STATUS_ANUNCIO.pausar).pode;
  const reativavel = podeMoverAnuncioShopee(link, ACAO_STATUS_ANUNCIO.reativar).pode;
  const reverificavel = itemIdDoAnuncioShopee(link.item_id) !== null;
  const republicavel = anuncioShopeeVivo(link) && !ehVinculoSubstituido(link);
  if (!pausavel && !reativavel && !reverificavel && !republicavel) return null;

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
      {reverificavel && (
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
      )}
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
