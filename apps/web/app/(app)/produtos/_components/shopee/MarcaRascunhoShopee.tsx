'use client';

import Link from 'next/link';
import { Alert, Anchor, Group, Loader, Select, Stack, Text } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import {
  textoUtilizavelShopee,
  type MarcaDaContaShopee,
  // Aliased: this file's component carries the schemas type's name.
  type MarcaRascunhoShopee as ParMarcaRascunhoShopee,
} from '@delfrance/schemas';

import { LIMITE_MARCAS_SHOPEE, useMarcasShopee } from '@/lib/shopee/marcas';
import {
  MARCA_SEM_MARCA_RASCUNHO_SHOPEE,
  marcaDaLinhaParaRascunhoShopee,
} from '@/lib/shopee/rascunho';

import { semEnviarOFormularioDoProduto } from './semEnviarOFormularioDoProduto';

export interface MarcaRascunhoShopeeProps {
  /** The Firestore handle `useMarcasShopee` listens with; supplied by `RascunhoShopee` (from the editor). */
  db: Firestore;
  /** The conta (`integracao` id) whose `brandshopee` shortlist is listed; supplied by `RascunhoShopee`. */
  contaId: string;
  /** The conta's display name — the empty-shortlist sentence says where to register brands (Canais de venda › Shopee › {conta} › Marcas, linked to `/canais/shopee/<contaId>`). */
  contaNome: string;
  /** The draft's link doc id — the test ids' suffix only; supplied by `RascunhoShopee`. */
  linkDocId: string;
  /** The pair the form holds (`bloco.valores.marca`): `null` = not chosen (the pendência), `brand_id: 0` = «Sem marca»; a stored id absent from the shortlist (or `-1`) is shown as "(fora da lista da conta)", never dropped and never a crash. */
  marca: ParMarcaRascunhoShopee | null;
  /** §H Q1's STORED pair — `RascunhoShopee`'s `marcaGuardada` (the held projection's, `null` for a local new draft) — the second argument of `marcaDaLinhaParaRascunhoShopee`. */
  marcaGuardada: ParMarcaRascunhoShopee | null;
  /** The Select accepts a pick (`bloco.camposEditaveis`). */
  editavel: boolean;
  /** A pick: «Sem marca» ⇒ `MARCA_SEM_MARCA_RASCUNHO_SHOPEE`; a shortlist row ⇒ `marcaDaLinhaParaRascunhoShopee(linha, marcaGuardada)`, never the row's raw pair; `RascunhoShopee` forwards it as `onCampo('marca', par)`. */
  onEscolher: (marca: ParMarcaRascunhoShopee) => void;
}

/** The Select value of «Sem marca» — `brand_id: 0`, which no shortlist row ever holds (`MarcaDaContaShopee.brandId` is positive). */
const VALOR_SEM_MARCA = String(MARCA_SEM_MARCA_RASCUNHO_SHOPEE.brand_id);

/** The option label of «Sem marca» (DC §2.11). */
export const ROTULO_SEM_MARCA_SHOPEE = 'Sem marca (No Brand)';

/** The suffix of a held brand the conta's shortlist does not list (imported, removed since, or a legacy `-1`). */
export const SUFIXO_MARCA_FORA_DA_LISTA_SHOPEE = '(fora da lista da conta)';

/** The listener failed: the shortlist cannot be offered. */
export const FRASE_MARCAS_ILEGIVEIS_SHOPEE =
  'Não foi possível ler as marcas desta conta — recarregue a aba.';

/**
 * How a draft's brand PAIR reads on screen — DISPLAY ONLY (it decides no
 * identity: the pick is by `brand_id`): «Sem marca» for `0`, else the stored
 * name, else `Marca <id>`; `null` = nothing chosen yet. Shared with the
 * conflict modal, so one pair reads the same on both.
 */
export function rotuloDaMarcaRascunhoShopee(par: ParMarcaRascunhoShopee | null): string {
  if (par === null) return 'Nenhuma marca escolhida';
  if (par.brand_id === MARCA_SEM_MARCA_RASCUNHO_SHOPEE.brand_id) return ROTULO_SEM_MARCA_SHOPEE;
  return textoUtilizavelShopee(par.original_brand_name) ?? `Marca ${String(par.brand_id)}`;
}

/**
 * The draft's Marca (#1911 P10, DC §2.11, §H Q1): a Select over the conta's
 * brand shortlist (`useMarcasShopee` — its one read; the spinner gates on
 * `leitura === undefined`, R1) with «Sem marca (No Brand)» first. A nameless
 * row re-picked at the STORED id keeps the stored name (Lucas, 2026-10-28) —
 * decided by `marcaDaLinhaParaRascunhoShopee`, never here. Writes nothing.
 * Root `data-testid="shopee-rascunho-marca-<linkDocId>"`.
 *
 * - The Select's value is the pair's `brand_id` as a string; a pick is mapped
 *   back through the shortlist row it names (one row per `brand_id`, the
 *   reader's own grouping), never parsed into a pair here.
 * - A held pair the shortlist does not list (an imported brand, one removed
 *   since, a legacy `-1`) stays selected as "{nome} (fora da lista da conta)":
 *   it is kept unless the operator picks another, and re-picking it sends
 *   nothing.
 * - Mantine's `searchable` filtering is display-only (it decides no write), so
 *   it is no fold to inventory.
 * - The draft sits inside the produto's `<form>`: Enter in the search box never
 *   submits it; ↓ + Enter still picks (`semEnviarOFormularioDoProduto`, the
 *   guard the title and the attribute controls share).
 */
export function MarcaRascunhoShopee({
  db,
  contaId,
  contaNome,
  linkDocId,
  marca,
  marcaGuardada,
  editavel,
  onEscolher,
}: MarcaRascunhoShopeeProps) {
  const lista = useMarcasShopee(db, contaId);
  const raiz = `shopee-rascunho-marca-${linkDocId}`;

  if (lista.leitura === undefined) {
    return (
      <Stack gap={4} data-testid={raiz}>
        <Text size="sm" fw={500}>
          Marca
        </Text>
        {lista.error !== undefined ? (
          <Alert color="red" variant="light" data-testid={`${raiz}-erro`}>
            {FRASE_MARCAS_ILEGIVEIS_SHOPEE}
          </Alert>
        ) : (
          <Group gap="xs" data-testid={`${raiz}-carregando`}>
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Carregando as marcas da conta…
            </Text>
          </Group>
        )}
      </Stack>
    );
  }

  const { marcas } = lista.leitura;
  const porValor = new Map<string, MarcaDaContaShopee>(
    marcas.map((m) => [String(m.brandId), m] as const),
  );
  const valor = marca === null ? null : String(marca.brand_id);
  const foraDaLista = valor !== null && valor !== VALOR_SEM_MARCA && !porValor.has(valor);

  const opcoes = [
    { value: VALOR_SEM_MARCA, label: ROTULO_SEM_MARCA_SHOPEE },
    ...marcas.map((m) => ({ value: String(m.brandId), label: m.rotulo })),
    ...(foraDaLista
      ? [
          {
            value: valor,
            label: `${rotuloDaMarcaRascunhoShopee(marca)} ${SUFIXO_MARCA_FORA_DA_LISTA_SHOPEE}`,
          },
        ]
      : []),
  ];

  const escolher = (escolhido: string | null) => {
    if (escolhido === null) return;
    if (escolhido === VALOR_SEM_MARCA) {
      onEscolher(MARCA_SEM_MARCA_RASCUNHO_SHOPEE);
      return;
    }
    const linha = porValor.get(escolhido);
    // The "fora da lista" option is the held pair itself: nothing to send.
    if (linha === undefined) return;
    onEscolher(marcaDaLinhaParaRascunhoShopee(linha, marcaGuardada));
  };

  return (
    <Stack gap={4} data-testid={raiz}>
      <Select
        label="Marca"
        placeholder="Escolha a marca"
        data={opcoes}
        value={valor}
        onChange={escolher}
        allowDeselect={false}
        searchable
        nothingFoundMessage="Nenhuma marca encontrada"
        disabled={!editavel}
        onKeyDown={semEnviarOFormularioDoProduto}
      />
      {marcas.length === 0 && (
        <Text size="xs" c="dimmed" data-testid={`${raiz}-vazia`}>
          Nenhuma marca cadastrada nesta conta. Cadastre em{' '}
          <Anchor component={Link} href={`/canais/shopee/${contaId}`} size="xs">
            Canais de venda › Shopee › {contaNome} › Marcas
          </Anchor>
          .
        </Text>
      )}
      {lista.truncada && (
        <Text size="xs" c="dimmed" data-testid={`${raiz}-truncada`}>
          {`Esta conta tem ${String(LIMITE_MARCAS_SHOPEE)} marcas ou mais: as que passam desse número não aparecem aqui.`}
        </Text>
      )}
    </Stack>
  );
}
