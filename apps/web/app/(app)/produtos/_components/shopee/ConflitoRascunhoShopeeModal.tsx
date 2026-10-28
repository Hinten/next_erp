'use client';

import { Alert, Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  CAMPO_RASCUNHO_SHOPEE,
  textoUtilizavelShopee,
  type CampoRascunhoShopee,
  type ConflitoRascunhoShopee,
} from '@delfrance/schemas';

import {
  FRASE_CONFLITO_CRIACAO_RASCUNHO_SHOPEE,
  FRASE_CONFLITO_RASCUNHO_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  ROTULO_CAMPO_RASCUNHO_SHOPEE,
  TITULO_CONFLITO_RASCUNHO_SHOPEE,
  type OperacaoRascunhoShopee,
} from '@/lib/shopee/anuncioProduto';
import type { EdicaoRascunhoShopee } from '@/lib/shopee/rascunho';

import { rotuloDaMarcaRascunhoShopee } from './MarcaRascunhoShopee';

/**
 * The 409 `rascunhoConflito` being shown — `falhaDoRascunhoShopee`'s
 * `conflito` arm (a NON-EMPTY field list), plus which route answered it.
 */
export interface ConflitoRascunhoShopeeAberto {
  /** The draft the refused save named. */
  readonly linkDocId: string;
  /** `'criar'` (a create retry) or `'atualizar'` — picks the alert sentence; a discard's conflict is a message, never this modal. */
  readonly operacao: Exclude<OperacaoRascunhoShopee, 'descartar'>;
  /** `detalhes.conflitos` — each field with its STORED value `atual`, DISPLAY-ONLY (§C.2, rev. 2a #19). */
  readonly conflitos: readonly ConflitoRascunhoShopee[];
}

export interface ConflitoRascunhoShopeeModalProps {
  /** The conflict shown, or `null` (closed) — the editor's state (R2), set from a `tipo: 'conflito'` refusal. */
  conflito: ConflitoRascunhoShopeeAberto | null;
  /** The entry of `conflito.linkDocId` — `base` = «Quando você abriu», `atual` = «Sua alteração», `novo` = a create retry; `null` only while closed; supplied by the editor. */
  edicao: EdicaoRascunhoShopee | null;
  /** The links snapshot holds the stored draft at `conflito.linkDocId` — both resolving buttons rebase on it; `false` ⇒ they are disabled (`FRASE_RASCUNHO_CARREGANDO_SHOPEE`); supplied by the editor. */
  servidorCarregado: boolean;
  /** The resend is in flight (the editor's `emVoo` = this link's `'salvar-rascunho'`) — spinner on «Salvar mesmo assim», the other buttons disabled. */
  salvando: boolean;
  /** «Salvar mesmo assim»: the editor rebases on the CURRENT snapshot's doc (`rebasearEdicaoRascunhoShopee(edicao, link)` — never from `conflitos`) and resends through `executar`. */
  onSalvarMesmoAssim: () => void;
  /** «Usar o que está salvo»: the editor applies `rebasearEdicaoRascunhoShopee(edicao, link, <the conflitos' campos>)` and closes; nothing is sent. */
  onUsarOQueEstaSalvo: () => void;
  /** «Cancelar» or the close button: the modal closes, the entry stays as typed. */
  onCancelar: () => void;
}

/** A cell with no value to show. */
const VAZIO = '(vazio)';

/**
 * One draft field's value as the modal shows it — DISPLAY ONLY: it decides
 * nothing (the editor rebases on the stored document, never on these cells).
 * `valor` is `unknown` because a 409's `conflitos[].atual` is whatever the
 * server stored, read without a schema; anything this build does not know how
 * to show reads "(valor não reconhecido)" instead of crashing.
 */
export function textoDoValorDoRascunhoShopee(campo: CampoRascunhoShopee, valor: unknown): string {
  switch (campo) {
    case CAMPO_RASCUNHO_SHOPEE.itemName:
      if (valor === null || valor === undefined) return VAZIO;
      if (typeof valor !== 'string') break;
      return textoUtilizavelShopee(valor) === null ? VAZIO : valor;
    case CAMPO_RASCUNHO_SHOPEE.description:
      // `null` is a CHOICE on a draft: the produto's own description (D2).
      if (valor === null || valor === undefined) return '(a descrição do produto)';
      if (typeof valor !== 'string') break;
      return textoUtilizavelShopee(valor) === null ? '(a descrição do produto)' : valor;
    case CAMPO_RASCUNHO_SHOPEE.categoryId:
      if (valor === null || valor === undefined) return '(nenhuma)';
      if (typeof valor !== 'number') break;
      return `Categoria #${String(valor)}`;
    case CAMPO_RASCUNHO_SHOPEE.marca: {
      if (valor === null || valor === undefined) return rotuloDaMarcaRascunhoShopee(null);
      if (typeof valor !== 'object') break;
      const { brand_id: id, original_brand_name: nome } = valor as Record<string, unknown>;
      if (typeof id !== 'number') break;
      return rotuloDaMarcaRascunhoShopee({
        brand_id: id,
        original_brand_name: typeof nome === 'string' ? nome : null,
      });
    }
    case CAMPO_RASCUNHO_SHOPEE.attributes:
      if (valor === null || valor === undefined) return '(nenhum)';
      if (!Array.isArray(valor)) break;
      return valor.length === 0 ? '(nenhum)' : `${String(valor.length)} atributo(s)`;
    case CAMPO_RASCUNHO_SHOPEE.logisticInfo:
      if (valor === null || valor === undefined) return '(automática)';
      return 'definida';
  }
  return '(valor não reconhecido)';
}

/** What the operator holds for `campo`: the form's value for the four form fields, else the held projection's (the form does not edit it). */
function valorDaEdicao(
  edicao: EdicaoRascunhoShopee,
  campo: CampoRascunhoShopee,
  qual: 'base' | 'atual',
): unknown {
  if (qual === 'atual' && campo in edicao.atual) {
    return edicao.atual[campo as keyof typeof edicao.atual];
  }
  return edicao.base[campo];
}

/**
 * The draft's 409 field diff (#1911 P10, DC §2.7) — a sibling of the Mercado
 * Livre `ListingConflictModal`, not a generalisation of it. Title
 * `TITULO_CONFLITO_RASCUNHO_SHOPEE`; the alert `FRASE_CONFLITO_RASCUNHO_SHOPEE`
 * (edit) or `FRASE_CONFLITO_CRIACAO_RASCUNHO_SHOPEE` (create retry); one row per
 * conflicting field labelled by `ROTULO_CAMPO_RASCUNHO_SHOPEE`; buttons
 * «Cancelar», «Usar o que está salvo», «Salvar mesmo assim». Presentational:
 * fetches and writes nothing. Root `data-testid="shopee-rascunho-conflito"`.
 *
 * - Columns: «Quando você abriu» (the entry's held projection — an EDIT only:
 *   a create retry opened nothing stored), «Salvo agora» (the 409's
 *   `conflitos[].atual`, DISPLAY-ONLY) and «Sua alteração» (the form).
 * - Neither resolving button acts while the links snapshot lacks the stored
 *   draft (`servidorCarregado: false`): both rebase on THAT document, never on
 *   the 409's values (rev. 2a #19), and a resend against an older snapshot
 *   would only 409 again.
 */
export function ConflitoRascunhoShopeeModal({
  conflito,
  edicao,
  servidorCarregado,
  salvando,
  onSalvarMesmoAssim,
  onUsarOQueEstaSalvo,
  onCancelar,
}: ConflitoRascunhoShopeeModalProps) {
  const criacao = conflito?.operacao === 'criar';
  return (
    <Modal
      opened={conflito !== null}
      onClose={onCancelar}
      title={TITULO_CONFLITO_RASCUNHO_SHOPEE}
      centered
      size="lg"
    >
      {conflito !== null && (
        <Stack data-testid="shopee-rascunho-conflito">
          <Alert color="red" icon={<IconAlertTriangle size={18} />}>
            {criacao ? FRASE_CONFLITO_CRIACAO_RASCUNHO_SHOPEE : FRASE_CONFLITO_RASCUNHO_SHOPEE}
          </Alert>

          <Table withTableBorder withColumnBorders striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Campo</Table.Th>
                {!criacao && <Table.Th>Quando você abriu</Table.Th>}
                <Table.Th>Salvo agora</Table.Th>
                <Table.Th>Sua alteração</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {conflito.conflitos.map(({ campo, atual }) => (
                <Table.Tr key={campo} data-testid={`shopee-rascunho-conflito-${campo}`}>
                  <Table.Td>{ROTULO_CAMPO_RASCUNHO_SHOPEE[campo]}</Table.Td>
                  {!criacao && (
                    <Table.Td>
                      <Text size="sm" lineClamp={4}>
                        {edicao === null
                          ? '—'
                          : textoDoValorDoRascunhoShopee(
                              campo,
                              valorDaEdicao(edicao, campo, 'base'),
                            )}
                      </Text>
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Text size="sm" lineClamp={4}>
                      {textoDoValorDoRascunhoShopee(campo, atual)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={4}>
                      {edicao === null
                        ? '—'
                        : textoDoValorDoRascunhoShopee(
                            campo,
                            valorDaEdicao(edicao, campo, 'atual'),
                          )}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          {!servidorCarregado && (
            <Text size="sm" c="dimmed">
              {FRASE_RASCUNHO_CARREGANDO_SHOPEE}
            </Text>
          )}

          <Group justify="flex-end">
            <Button type="button" variant="default" onClick={onCancelar} disabled={salvando}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="light"
              onClick={onUsarOQueEstaSalvo}
              disabled={salvando || !servidorCarregado}
            >
              Usar o que está salvo
            </Button>
            <Button
              type="button"
              color="red"
              onClick={onSalvarMesmoAssim}
              loading={salvando}
              disabled={!servidorCarregado}
            >
              Salvar mesmo assim
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
