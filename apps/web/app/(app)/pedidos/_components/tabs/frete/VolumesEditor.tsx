'use client';

import { useState } from 'react';
import { ActionIcon, Button, Divider, Group, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import type { VolumeFormState } from '../../types';
import type { PedidoFormHandle } from './fields';
import { fretePath } from './fields';
import { pesoPedido, volumePadrao } from './pesoPedido';
import { estimarDimensoes, type EstimativaDimensoes } from '@delfrance/schemas';
import { notificarAvisoDimensoes } from './notificarAviso';
import { loadProdutoPesoMap } from './produtoPeso';
import { DecimalInput } from '@delfrance/ui';

export interface VolumesEditorProps {
  form: PedidoFormHandle;
  db: Firestore;
  disabled?: boolean;
  /** FOB allows a single volume (legacy `maximoDeVolumes: 1`). */
  maxVolumes?: number;
}

export function VolumesEditor({ form, db, disabled, maxVolumes }: VolumesEditorProps) {
  const volumes = (form.watch(fretePath('volumes')) as VolumeFormState[] | null) ?? [];

  const itensFlat = form.watch('_itensFlat') ?? [];
  const queryClient = useQueryClient();
  const [adicionando, setAdicionando] = useState(false);

  /**
   * Add a volume weighed by `getPesoPedido` (#371) instead of a blind 1kg
   * guess. The weight is fetched **on click**, not on mount: the same cache
   * entry the activation seed (`seedVolumePadrao`) fills, so the usual path
   * costs no extra read, and a Frete tab the operator only looks at costs
   * none at all.
   *
   * A read failure still adds the volume — the operator asked for one — but
   * falls back to `volumePadrao()`'s 1kg and says so, rather than presenting a
   * fabricated weight as if it had been computed.
   */
  async function adicionarVolume() {
    const itens = itensFlat.filter((i) => !i._delete);
    setAdicionando(true);
    let peso = 1;
    let estimativa: EstimativaDimensoes | undefined;
    try {
      const medidas = await loadProdutoPesoMap(
        queryClient,
        db,
        itens.map((i) => i.produtoUid),
      );
      peso = pesoPedido(itens, medidas);
      estimativa = estimarDimensoes(itens, medidas);
    } catch (err) {
      if (!(err instanceof FirebaseError)) throw err;
      notifications.show({
        color: 'yellow',
        title: 'Peso do pedido',
        message: 'Não foi possível calcular o peso do pedido. Confira o peso do volume.',
      });
    } finally {
      setAdicionando(false);
    }
    // Re-read across the await — the list may have changed while it ran, e.g.
    // the activation seed landing. `canAdd` was evaluated a render ago, so the
    // cap has to be re-checked against the CURRENT list or a FOB block
    // (maxVolumes 1) could end up with two.
    const atuais = (form.getValues(fretePath('volumes')) as VolumeFormState[] | null) ?? [];
    if (maxVolumes != null && atuais.length >= maxVolumes) return;
    update([...atuais, volumePadrao(peso, estimativa)]);
    // Same box as the activation seed, so the same explanation — adding a
    // volume by hand must not be the one path that stays quiet about a clamped
    // or surcharged box.
    notificarAvisoDimensoes(estimativa?.aviso);
  }

  const update = (next: VolumeFormState[]) => {
    form.setValue(fretePath('volumes'), next.length > 0 ? next : null, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const setVolume = (index: number, patch: Partial<VolumeFormState>) => {
    update(volumes.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  };

  const setDimensao = (index: number, key: 'altura' | 'largura' | 'comprimento', value: number) => {
    const current = volumes[index]?.dimensoes ?? { altura: 0, largura: 0, comprimento: 0 };
    setVolume(index, { dimensoes: { ...current, [key]: value } });
  };

  const num = (
    label: string,
    value: number | null,
    onChange: (v: number | null) => void,
    decimalScale = 2,
  ) => (
    <DecimalInput
      label={label}
      value={value}
      onChange={onChange}
      min={0}
      decimalScale={decimalScale}
      allowDecimal={decimalScale > 0}
      disabled={disabled}
      w={110}
    />
  );

  const text = (label: string, value: string | null, onChange: (v: string | null) => void) => (
    <TextInput
      label={label}
      value={value ?? ''}
      onChange={(e) => onChange(e.currentTarget.value || null)}
      maxLength={60}
      disabled={disabled}
      w={140}
    />
  );

  const canAdd = maxVolumes == null || volumes.length < maxVolumes;

  return (
    <Stack gap="xs">
      <Divider label="Volumes" labelPosition="center" />
      {volumes.length === 0 && (
        <Text size="sm" c="dimmed" ta="center">
          Nenhum volume.
        </Text>
      )}
      {volumes.map((vol, index) => (
        <Stack key={index} gap={4}>
          <Group gap="xs">
            <Text size="sm" fw={500}>
              Volume {index + 1}
            </Text>
            <ActionIcon
              type="button"
              color="red"
              variant="subtle"
              size="sm"
              onClick={() => update(volumes.filter((_, i) => i !== index))}
              aria-label={`Remover volume ${index + 1}`}
              disabled={disabled}
            >
              ✕
            </ActionIcon>
          </Group>
          <Group gap="xs" align="end">
            {num('Altura (cm)', vol.dimensoes?.altura ?? null, (v) =>
              setDimensao(index, 'altura', v ?? 0),
            )}
            {num('Largura (cm)', vol.dimensoes?.largura ?? null, (v) =>
              setDimensao(index, 'largura', v ?? 0),
            )}
            {num('Comprimento (cm)', vol.dimensoes?.comprimento ?? null, (v) =>
              setDimensao(index, 'comprimento', v ?? 0),
            )}
            {num('Peso bruto (kg)', vol.pesoBruto, (v) => setVolume(index, { pesoBruto: v }), 3)}
            {num(
              'Peso líquido (kg)',
              vol.pesoLiquido,
              (v) => setVolume(index, { pesoLiquido: v }),
              3,
            )}
            {num('Quantidade', vol.quantidade, (v) => setVolume(index, { quantidade: v }), 0)}
            {text('Espécie', vol.especie, (v) => setVolume(index, { especie: v }))}
            {text('Marca', vol.marca, (v) => setVolume(index, { marca: v }))}
            {text('Numeração', vol.numero, (v) => setVolume(index, { numero: v }))}
          </Group>
        </Stack>
      ))}
      {canAdd && (
        <Group justify="center">
          <Button
            type="button"
            variant="light"
            size="xs"
            onClick={() => void adicionarVolume()}
            loading={adicionando}
            disabled={disabled || adicionando}
          >
            + Novo volume
          </Button>
        </Group>
      )}
    </Stack>
  );
}
