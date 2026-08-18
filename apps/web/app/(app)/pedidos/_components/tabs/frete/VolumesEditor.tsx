'use client';

import {
  ActionIcon,
  Button,
  Divider,
  Group,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import type { VolumeFormState } from '../../types';
import type { PedidoFormHandle } from './fields';
import { fretePath } from './fields';
import { volumePadrao } from './pesoPedido';

export interface VolumesEditorProps {
  form: PedidoFormHandle;
  disabled?: boolean;
  /** FOB allows a single volume (legacy `maximoDeVolumes: 1`). */
  maxVolumes?: number;
}

export function VolumesEditor({ form, disabled, maxVolumes }: VolumesEditorProps) {
  const volumes = (form.watch(fretePath('volumes')) as VolumeFormState[] | null) ?? [];

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
    <NumberInput
      label={label}
      value={value ?? ''}
      onChange={(v) => onChange(typeof v === 'number' ? v : null)}
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
            onClick={() => update([...volumes, volumePadrao()])}
            disabled={disabled}
          >
            + Novo volume
          </Button>
        </Group>
      )}
    </Stack>
  );
}
