'use client';

import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { ESTADO_ANUNCIO_SHOPEE, type ProdutoShopeeLink } from '@delfrance/schemas';

import { ROTULO_CRIAR_PAUSADO_SHOPEE } from '@/lib/shopee/anuncioProduto';
import type { ReceitaKitShopee } from '@/lib/shopee/useReceitaKitShopee';
import type { ArmaKitShopee } from './AcoesAnuncioShopee';
import { ComposicaoKitShopee } from './KitAnuncioShopee';

/** Which confirmation is open: the arm, on which link of which conta. */
export interface AlvoDoKitShopee {
  readonly contaId: string;
  /** The link the arm acts on — `null` for `criar`, the conta's FIRST native kit (#1912). */
  readonly linkDocId: string | null;
  readonly arma: ArmaKitShopee;
  /** A refusal asked for a principal: the cursor starts on the pick. */
  readonly focarPrincipal: boolean;
}

export interface KitNativoShopeeModalProps {
  alvo: AlvoDoKitShopee | null;
  /** The target link's live document, when this conta's listing still holds it (`null` for `criar`). */
  link: ProdutoShopeeLink | null;
  receita: ReceitaKitShopee;
  /** The principal picked for this target (R2: the editor keeps it), `null` = let the ERP choose. */
  principal: string | null;
  onPrincipal: (principal: string | null) => void;
  /** `criar` only: «Criar pausado» is ticked — the create is sent `status: 'UNLIST'`. */
  pausado: boolean;
  onPausado: (pausado: boolean) => void;
  /**
   * The produto form (or a staged edit outside it) has UNSAVED changes. Every
   * kit create reads the SAVED produto and its saved recipe, which Shopee then
   * freezes — so the confirm is disabled and the reason shown until it is saved.
   */
  produtoSujo: boolean;
  /**
   * The confirm is disabled: every write button is (one write at a time, a
   * read-only form, an uncertain create waiting), or the link it names is no
   * longer a loaded link whose `item_id` addresses a listing — the live
   * snapshot can rewrite it while this is open — or, for `criar`, the conta no
   * longer offers a first create.
   */
  bloqueado: boolean;
  onConfirmar: () => void;
  onFechar: () => void;
}

const TITULO = {
  criar: 'Publicar como kit nativo',
  recriar: 'Recriar kit nativo',
  converter: 'Converter em kit nativo',
} as const satisfies Record<ArmaKitShopee, string>;

const CONFIRMAR = {
  criar: 'Publicar kit nativo',
  recriar: 'Recriar kit',
  converter: 'Converter em kit nativo',
} as const satisfies Record<ArmaKitShopee, string>;

/** What the first native-kit create does (#1912). */
export const FRASE_PUBLICAR_KIT_NATIVO_SHOPEE =
  'Cria na Shopee um kit nativo com a composição salva no ERP: o estoque do kit passa a ser ' +
  'calculado pela Shopee a partir dos componentes. A Shopee não deixa alterar a composição de ' +
  'um kit depois de criado — para mudá-la será preciso recriá-lo. Se um kit com o SKU deste ' +
  'produto já existir na Shopee, nada é criado e o ERP indica importá-lo.';

/** Why a kit create waits for the produto's save. */
export const FRASE_SALVE_O_PRODUTO_ANTES_DO_KIT_SHOPEE =
  'Salve o produto antes: o kit é criado com a composição SALVA no ERP, e a Shopee não deixa ' +
  'alterá-la depois.';

/**
 * The confirmation of a native-kit CREATE (step 21-3, PR 8; the first create
 * since #1912): what the arm does, the SAVED recipe with its local warnings,
 * and the principal pick — plus «Criar pausado» on a first create. Every arm
 * makes a NEW kit on Shopee — `add_kit_item` is not idempotent, which is why
 * the editor sends it under its one-write lock and reads every unclear ending
 * as UNCERTAIN (and the server serializes it with a lease, #1912).
 *
 * ⚠️ The recipe warnings are shown, never enforced: the confirm button is
 * disabled only by {@link KitNativoShopeeModalProps.bloqueado} and by an unsaved
 * produto ({@link KitNativoShopeeModalProps.produtoSujo}).
 */
export function KitNativoShopeeModal({
  alvo,
  link,
  receita,
  principal,
  onPrincipal,
  pausado,
  onPausado,
  produtoSujo,
  bloqueado,
  onConfirmar,
  onFechar,
}: KitNativoShopeeModalProps) {
  const arma = alvo?.arma ?? 'recriar';
  const opcoes =
    receita.estado === 'pronta'
      ? receita.componentes.map((id) => {
          const nome = receita.nomes.get(id);
          return { value: id, label: nome === undefined ? id : `${nome} (${id})` };
        })
      : [];
  return (
    <Modal opened={alvo !== null} onClose={onFechar} title={TITULO[arma]} centered size="lg">
      {alvo !== null && (
        <Stack gap="md">
          <Text size="sm">{fraseDaArma(alvo, link)}</Text>
          <ComposicaoKitShopee receita={receita} />
          <Select
            label="Componente principal"
            description={
              'A Shopee copia dele a categoria, os atributos e a marca do kit, e não deixa trocá-lo ' +
              'depois. Vazio: o ERP escolhe quando todos os componentes estão no mesmo anúncio da ' +
              'Shopee.'
            }
            placeholder="O ERP escolhe"
            data={opcoes}
            value={principal}
            onChange={onPrincipal}
            clearable
            data-autofocus={alvo.focarPrincipal ? true : undefined}
          />
          {arma === 'criar' && (
            <Checkbox
              label={ROTULO_CRIAR_PAUSADO_SHOPEE}
              checked={pausado}
              onChange={(e) => onPausado(e.currentTarget.checked)}
              data-testid="shopee-kit-criar-pausado"
            />
          )}
          {produtoSujo && (
            <Alert color="yellow" variant="light" data-testid="shopee-kit-produto-sujo">
              {FRASE_SALVE_O_PRODUTO_ANTES_DO_KIT_SHOPEE}
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={onFechar}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="grape"
              disabled={bloqueado || produtoSujo}
              onClick={onConfirmar}
            >
              {CONFIRMAR[arma]}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

/** What the arm does to the listing it names (or, on a first create, to the conta). */
function fraseDaArma(alvo: AlvoDoKitShopee, link: ProdutoShopeeLink | null): string {
  if (alvo.arma === 'criar' || alvo.linkDocId === null) return FRASE_PUBLICAR_KIT_NATIVO_SHOPEE;
  if (alvo.arma === 'recriar') return fraseDoRecriar(alvo.linkDocId, link);
  return (
    'Cria um kit nativo NOVO na Shopee com a composição salva no ERP. O anúncio comum ' +
    `(vínculo ${alvo.linkDocId}) não é alterado: ele continua vendendo, com o próprio ` +
    'estoque e preço, até ser excluído no Seller Centre.'
  );
}

/**
 * What a recriar does to the kit it names. Shopee never changes the recipe of a
 * live kit, so a recriar CREATES one; the old kit is deleted only once the new
 * one reads active and equal to the ERP's composition — until then both exist.
 */
function fraseDoRecriar(linkDocId: string, link: ProdutoShopeeLink | null): string {
  const base =
    'A Shopee não deixa alterar os componentes de um kit nativo, então recriar cria um kit NOVO ' +
    'com a composição salva no ERP. ';
  if (link?.estadoAnuncio === ESTADO_ANUNCIO_SHOPEE.removido) {
    return `${base}O kit antigo (vínculo ${linkDocId}) já foi excluído na Shopee.`;
  }
  return (
    `${base}O kit antigo (vínculo ${linkDocId}) só é excluído na Shopee depois que o novo estiver ` +
    'ativo e igual à composição do ERP — até lá, os dois existem.'
  );
}
