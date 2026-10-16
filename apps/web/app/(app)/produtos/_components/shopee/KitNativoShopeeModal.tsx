'use client';

import { Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { ESTADO_ANUNCIO_SHOPEE, type ProdutoShopeeLink } from '@delfrance/schemas';

import type { ReceitaKitShopee } from '@/lib/shopee/useReceitaKitShopee';
import type { ArmaKitShopee } from './AcoesAnuncioShopee';
import { ComposicaoKitShopee } from './KitAnuncioShopee';

/** Which confirmation is open: the arm, on which link of which conta. */
export interface AlvoDoKitShopee {
  readonly contaId: string;
  readonly linkDocId: string;
  readonly arma: ArmaKitShopee;
  /** A refusal asked for a principal: the cursor starts on the pick. */
  readonly focarPrincipal: boolean;
}

export interface KitNativoShopeeModalProps {
  alvo: AlvoDoKitShopee | null;
  /** The target link's live document, when this conta's listing still holds it. */
  link: ProdutoShopeeLink | null;
  receita: ReceitaKitShopee;
  /** The principal picked for this link (R2: the editor keeps it), `null` = let the ERP choose. */
  principal: string | null;
  onPrincipal: (principal: string | null) => void;
  /**
   * The confirm is disabled: every write button is (one write at a time, a
   * read-only form, an uncertain create waiting), or the link it names is no
   * longer a loaded link whose `item_id` addresses a listing — the live
   * snapshot can rewrite it while this is open.
   */
  bloqueado: boolean;
  onConfirmar: () => void;
  onFechar: () => void;
}

const TITULO = {
  recriar: 'Recriar kit nativo',
  converter: 'Converter em kit nativo',
} as const satisfies Record<ArmaKitShopee, string>;

const CONFIRMAR = {
  recriar: 'Recriar kit',
  converter: 'Converter em kit nativo',
} as const satisfies Record<ArmaKitShopee, string>;

/**
 * The confirmation of a native-kit CREATE (step 21-3, PR 8): what the arm does
 * to the listing it names, the SAVED recipe with its local warnings, and the
 * principal pick. Both arms make a NEW kit on Shopee — `add_kit_item` is not
 * idempotent, which is why the editor sends it under its one-write lock and
 * reads every unclear ending as UNCERTAIN.
 *
 * ⚠️ The warnings are shown, never enforced: the confirm button is disabled
 * only by {@link KitNativoShopeeModalProps.bloqueado} — which also holds once
 * the named link stops addressing a listing, so every kit create the tab sends
 * from here names an addressable link.
 */
export function KitNativoShopeeModal({
  alvo,
  link,
  receita,
  principal,
  onPrincipal,
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
          <Text size="sm">
            {arma === 'recriar'
              ? fraseDoRecriar(alvo.linkDocId, link)
              : 'Cria um kit nativo NOVO na Shopee com a composição salva no ERP. O anúncio comum ' +
                `(vínculo ${alvo.linkDocId}) não é alterado: ele continua vendendo, com o próprio ` +
                'estoque e preço, até ser excluído no Seller Centre.'}
          </Text>
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
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={onFechar}>
              Cancelar
            </Button>
            <Button type="button" color="grape" disabled={bloqueado} onClick={onConfirmar}>
              {CONFIRMAR[arma]}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
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
