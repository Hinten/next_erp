'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, getDocs, type Firestore } from 'firebase/firestore';
import {
  Autocomplete,
  Button,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { movimentoBalancoCollection } from '@/lib/data/movimentoBalancoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';

import {
  MENSAGEM_SKU,
  classificarProduto,
  resolverSkuBalanco,
  type VerdictoSku,
} from './resolveSkuBalanco';
import { construirOpcoes, opcaoSelecionada, type OpcaoProduto } from './opcoesProduto';

/**
 * Firestore prefix-range sentinel — the high private-use codepoint the produtos
 * list and the preço picker already use to bound a `startsWith` range.
 */
const PREFIX_SENTINEL = '';

export interface LancamentoFormProps {
  db: Firestore;
  balancoId: string;
  usuarioOuterRef: string;
  disabled: boolean;
  onLancado: (verdicto: VerdictoSku['kind']) => void;
}

/**
 * The counting input. Two modes, scan first — that is what an operator holding
 * a barcode gun in a warehouse actually uses, and it was legacy's default too.
 *
 * ⚠️ Every failure is PERSISTED as an error movimento rather than shown and
 * forgotten. A scan happened on the floor; if it resolved to nothing, the
 * operator needs to see it in the Erros panel afterwards and go find the item.
 * That is also why the catch below is narrow (CLAUDE.md rule 6): only a
 * Firestore failure becomes an error row — anything else rethrows, because an
 * unexpected bug must not be filed away as if it were a bad barcode.
 */
export function LancamentoForm({
  db,
  balancoId,
  usuarioOuterRef,
  disabled,
  onLancado,
}: LancamentoFormProps) {
  const [modo, setModo] = useState<'scan' | 'manual'>('scan');
  const [sku, setSku] = useState('');
  const [busca, setBusca] = useState('');
  const [opcoes, setOpcoes] = useState<OpcaoProduto[]>([]);
  // The produto the operator actually picked. Held explicitly rather than
  // re-derived from `opcoes` at submit time, because `opcoes` is search state
  // and can be replaced or emptied between the click and the click on Lançar.
  const [selecionado, setSelecionado] = useState<OpcaoProduto | null>(null);
  const [quantidade, setQuantidade] = useState<number | string>(1);
  const [ocupado, setOcupado] = useState(false);
  const skuRef = useRef<HTMLInputElement>(null);

  // Refocus the scan box whenever it becomes usable: a barcode gun types and
  // submits, so anything that steals focus silently drops the next scan.
  useEffect(() => {
    if (modo === 'scan' && !disabled) skuRef.current?.focus();
  }, [modo, disabled, ocupado]);

  const gravar = useCallback(
    async (verdicto: VerdictoSku, entrada: string, unidades: number) => {
      const erro = verdicto.kind === 'produto' ? null : MENSAGEM_SKU[verdicto.kind];
      await addDoc(movimentoBalancoCollection.ref(db, { balancoId }), {
        produtoOuterRef:
          verdicto.kind === 'produto' || verdicto.kind === 'kit'
            ? `documents/produtos/${verdicto.produtoId}`
            : null,
        produtoId:
          verdicto.kind === 'produto' || verdicto.kind === 'kit' ? verdicto.produtoId : null,
        // An error row carries 0: it is excluded from every total, and a
        // phantom 1 would be a lie if the filter were ever dropped.
        quantidade: erro ? 0 : unidades,
        usuarioOuterRef,
        removido: false,
        error: erro !== null,
        // Legacy left this null on a kit row, so the Erros panel showed rows
        // titled literally "Error" with nothing to identify them.
        errorInput: erro ? entrada : null,
        errorMessage: erro,
        timestamp: Date.now(),
      });
      onLancado(verdicto.kind);
    },
    [db, balancoId, usuarioOuterRef, onLancado],
  );

  async function lancarSku() {
    const entrada = sku.trim();
    if (!entrada || ocupado) return;
    setOcupado(true);
    try {
      await gravar(await resolverSkuBalanco(db, entrada), entrada, 1);
      setSku('');
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
      await gravar({ kind: 'nao-encontrado' }, entrada, 1);
      setSku('');
    } finally {
      setOcupado(false);
    }
  }

  async function buscarProdutos(termo: string) {
    setBusca(termo);

    // Clicking a suggestion makes Mantine fire `onChange` with the option's
    // LABEL, not the typed text. Re-querying with that label would search
    // `nome >= "Nome — SKU"`, match nothing, and empty `opcoes` — so a term
    // that already names an option is a selection, not a search.
    const escolhido = opcaoSelecionada(opcoes, termo);
    if (escolhido) {
      setSelecionado(escolhido);
      return;
    }
    setSelecionado(null);

    const t = termo.trim();
    if (t.length < 2) {
      setOpcoes([]);
      return;
    }
    const achados = await getDocs(
      buildQuery(produtoCollection.ref(db, {}), [
        whereOp('nome', '>=', t),
        whereOp('nome', '<=', `${t}${PREFIX_SENTINEL}`),
        orderByField('nome', 'asc'),
        limit(10),
      ]),
    );
    setOpcoes(construirOpcoes(achados.docs.map((d) => ({ id: d.id, produto: d.data() }))));
  }

  async function lancarManual() {
    const escolhido = selecionado;
    const unidades = typeof quantidade === 'number' ? quantidade : Number(quantidade);
    if (!escolhido || !Number.isFinite(unidades) || ocupado) return;
    setOcupado(true);
    try {
      await gravar(
        classificarProduto(escolhido.id, escolhido.produto),
        escolhido.value,
        Math.trunc(unidades),
      );
      setBusca('');
      setOpcoes([]);
      setSelecionado(null);
      setQuantidade(1);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <SegmentedControl
          value={modo}
          onChange={(v) => setModo(v as 'scan' | 'manual')}
          data={[
            { value: 'scan', label: 'Leitor (SKU)' },
            { value: 'manual', label: 'Manual' },
          ]}
          disabled={disabled}
        />

        {modo === 'scan' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void lancarSku();
            }}
          >
            <TextInput
              ref={skuRef}
              label="SKU"
              placeholder="Bipe ou digite o SKU e pressione Enter"
              value={sku}
              onChange={(e) => setSku(e.currentTarget.value)}
              disabled={disabled || ocupado}
              autoComplete="off"
              aria-label="SKU do produto"
            />
            <Text size="xs" c="dimmed" mt={4}>
              Cada leitura lança 1 unidade. Leituras sem correspondência viram um erro registrado.
            </Text>
          </form>
        ) : (
          <Group align="flex-end" gap="sm">
            <Autocomplete
              label="Produto"
              placeholder="Busque pelo nome"
              value={busca}
              onChange={(v) => void buscarProdutos(v)}
              data={opcoes.map((o) => o.value)}
              disabled={disabled || ocupado}
              style={{ flex: 1 }}
              aria-label="Produto"
            />
            <NumberInput
              label="Quantidade"
              value={quantidade}
              onChange={setQuantidade}
              min={-9999}
              step={1}
              allowDecimal={false}
              w={140}
              disabled={disabled || ocupado}
              aria-label="Quantidade"
            />
            {/* Disabled until a produto is actually chosen: typing a partial
                name resolves to nothing, and a button that accepts the click
                and does nothing is indistinguishable from a lost lançamento. */}
            <Button
              onClick={() => void lancarManual()}
              disabled={disabled || ocupado || selecionado === null}
            >
              Lançar
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
