'use client';

import { useState } from 'react';
import {
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { CHAVE_NFE_REGEX } from '@delfrance/schemas';
import { usePermission } from '@/lib/auth';

import type { EnviNfeFilter, EnviNfeFilterMode } from '../_lib/resolveChaves';

export interface EnviNfeFilterBarProps {
  /** `null` clears the applied filter (Limpar). */
  readonly onApply: (filter: EnviNfeFilter | null) => void;
  readonly disabled?: boolean;
}

/**
 * Filter bar for /nfe/comunicacoes — one mode at a time (the four funnel into
 * a single `targetsChnfe` predicate). The chave mode filters the enviNfe list
 * directly; the other three resolve chaves first (see `resolveChaves`), so
 * they need read access to the collections they traverse:
 *
 *  - nNF / ID pedido → nfev4 reads (PERM.nfe.read)
 *  - Nº pedido       → pedidos + nfev4 reads (PERM.pedido.read + PERM.nfe.read)
 */
export function EnviNfeFilterBar({ onApply, disabled }: EnviNfeFilterBarProps) {
  const { allowed: nfeRead } = usePermission(PERM.nfe.read);
  const { allowed: pedidoRead } = usePermission(PERM.pedido.read);

  const [mode, setMode] = useState<EnviNfeFilterMode>('chave');
  const [term, setTerm] = useState('');
  // Whether a filter is currently applied on the parent — a mode switch must
  // clear it (emit null), or the table would stay invisibly constrained by
  // the previous mode's filter behind an empty-looking input.
  const [hasApplied, setHasApplied] = useState(false);

  const chaveInvalid = mode === 'chave' && term.length > 0 && !CHAVE_NFE_REGEX.test(term);
  const canApply =
    !disabled && term.trim().length > 0 && (mode !== 'chave' || CHAVE_NFE_REGEX.test(term));

  const modes = [
    { value: 'chave', label: 'Chave' },
    { value: 'nnf', label: 'nNF', disabled: !nfeRead },
    { value: 'pedidoNumero', label: 'Nº pedido', disabled: !nfeRead || !pedidoRead },
    { value: 'pedidoId', label: 'ID pedido', disabled: !nfeRead },
  ];
  const someModeBlocked = modes.some((m) => m.disabled);

  const switchMode = (next: string) => {
    setMode(next as EnviNfeFilterMode);
    setTerm('');
    if (hasApplied) {
      setHasApplied(false);
      onApply(null);
    }
  };

  const apply = () => {
    if (!canApply) return;
    setHasApplied(true);
    onApply({ mode, term: term.trim() });
  };

  const clear = () => {
    setTerm('');
    setHasApplied(false);
    onApply(null);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <Stack gap="xs">
        <Group align="flex-end" wrap="wrap">
          <SegmentedControl
            data={modes}
            value={mode}
            onChange={switchMode}
            disabled={disabled}
            size="sm"
          />
          {mode === 'chave' && (
            <TextInput
              label="Chave NF-e"
              placeholder="44 dígitos"
              value={term}
              onChange={(e) => setTerm(e.currentTarget.value.trim())}
              error={chaveInvalid ? 'A chave tem exatamente 44 dígitos' : undefined}
              disabled={disabled}
              w={380}
            />
          )}
          {mode === 'nnf' && (
            <NumberInput
              label="Número da NF-e (nNF)"
              placeholder="ex.: 1234"
              value={term === '' ? '' : Number(term)}
              onChange={(v) => setTerm(v === '' || v == null ? '' : String(v))}
              allowDecimal={false}
              allowNegative={false}
              disabled={disabled}
              w={220}
            />
          )}
          {mode === 'pedidoNumero' && (
            <TextInput
              label="Número do pedido"
              placeholder="ex.: 2026-000123"
              value={term}
              onChange={(e) => setTerm(e.currentTarget.value)}
              disabled={disabled}
              w={260}
            />
          )}
          {mode === 'pedidoId' && (
            <TextInput
              label="ID do pedido"
              placeholder="id do documento"
              value={term}
              onChange={(e) => setTerm(e.currentTarget.value.trim())}
              disabled={disabled}
              w={300}
            />
          )}
          <Button type="submit" disabled={!canApply}>
            Aplicar
          </Button>
          <Button variant="default" onClick={clear} disabled={disabled}>
            Limpar
          </Button>
        </Group>
        {someModeBlocked && (
          <Text size="xs" c="dimmed">
            Filtros por nNF e pedido exigem permissão de leitura de NF-e (nfe.read); o filtro por
            número de pedido exige também leitura de pedidos (pedido.read).
          </Text>
        )}
      </Stack>
    </form>
  );
}
