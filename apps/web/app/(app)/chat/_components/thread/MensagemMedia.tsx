'use client';

import { useRef, useState } from 'react';
import { Anchor, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconFile, IconPhoto } from '@tabler/icons-react';
import type { Filetype, Mensagem } from '@delfrance/schemas';
import { FILETYPE } from '@delfrance/schemas';
import { HighlightedText } from '@/lib/chat/highlight';
import { isHttpUrl } from '@/lib/chat/safeUrl';
import { useArquivo } from '../../_hooks/useArquivo';

const MAX_MEDIA_HEIGHT = 260;

interface ResolvedMedia {
  ref: string;
  /** Explicit kind from the sub-object; `null` → derive from the arquivo. */
  kind: 'image' | 'video' | 'audio' | 'document' | null;
  caption: string | null;
}

/** Pick the media the mensagem carries (typed sub-objects, then legacy fields). */
function resolveMedia(m: Mensagem): ResolvedMedia | null {
  if (m.image?.image)
    return { ref: m.image.image, kind: 'image', caption: m.image.caption ?? null };
  if (m.sticker?.sticker)
    return { ref: m.sticker.sticker, kind: 'image', caption: m.sticker.caption ?? null };
  if (m.video?.video)
    return { ref: m.video.video, kind: 'video', caption: m.video.caption ?? null };
  if (m.audio?.audio) return { ref: m.audio.audio, kind: 'audio', caption: null };
  if (m.genericDocument?.genericDocument)
    return {
      ref: m.genericDocument.genericDocument,
      kind: 'document',
      caption: m.genericDocument.caption ?? null,
    };
  // Legacy single-attachment field (older docs) — derive the kind from the arquivo.
  if (typeof m.anexoStorage === 'string')
    return { ref: m.anexoStorage, kind: null, caption: m.anexoDescription ?? null };
  return null;
}

/** Whether the mensagem carries any renderable media (sub-object or legacy field).
 * The legacy `anexo_url` counts only when it is a safe http(s) URL. */
export function hasMedia(m: Mensagem): boolean {
  return resolveMedia(m) != null || isHttpUrl(m.anexo_url);
}

/** Map an arquivo filetype to a render kind when the sub-object didn't say. */
function kindForFiletype(filetype: Filetype): 'image' | 'video' | 'audio' | 'document' {
  if (filetype === FILETYPE.image || filetype === FILETYPE.sticker) return 'image';
  if (filetype === FILETYPE.video) return 'video';
  if (filetype === FILETYPE.audio) return 'audio';
  return 'document';
}

/**
 * Render a mensagem's media (legacy `visualizadorArquivos` inline preview):
 *   - image/sticker → `<img>` (capped height, click opens the full file);
 *   - video → `<video controls>`;
 *   - audio → `<audio controls>` + a playback-rate button (1x→1.5x→2x cycle,
 *     legacy had 0.5–3x);
 *   - document → a download link (icon + filename).
 * The legacy `anexo_url` (a bare URL, no arquivo doc) renders as a plain link —
 * but only when it is a safe http(s) URL (guarded against a `javascript:` scheme).
 *
 * `searchRegex`/`searchActive` thread the in-thread search context so a media
 * caption highlights matches like a text body does (null regex → plain text).
 */
export function MensagemMedia({
  mensagem,
  searchRegex = null,
  searchActive = false,
}: {
  mensagem: Mensagem;
  searchRegex?: RegExp | null;
  searchActive?: boolean;
}) {
  const media = resolveMedia(mensagem);

  if (!media) {
    // Legacy plain-URL attachment (no arquivo doc) — externally sourced, so only
    // an http(s) URL is rendered as a link; anything else is dropped.
    if (isHttpUrl(mensagem.anexo_url)) {
      return (
        <Anchor
          href={mensagem.anexo_url as string}
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
        >
          <Group gap={4} wrap="nowrap">
            <IconFile size={16} />
            Anexo
          </Group>
        </Anchor>
      );
    }
    return null;
  }

  return <MediaByArquivo media={media} searchRegex={searchRegex} searchActive={searchActive} />;
}

function MediaByArquivo({
  media,
  searchRegex,
  searchActive,
}: {
  media: ResolvedMedia;
  searchRegex: RegExp | null;
  searchActive: boolean;
}) {
  const { arquivo, loading } = useArquivo(media.ref);

  if (loading) {
    return (
      <Group gap={6} py="xs">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          Carregando anexo…
        </Text>
      </Group>
    );
  }

  if (!arquivo || !arquivo.url) {
    return (
      <Group gap={4} c="dimmed">
        <IconPhoto size={16} />
        <Text size="xs">Anexo indisponível</Text>
      </Group>
    );
  }

  const kind = media.kind ?? kindForFiletype(arquivo.filetype);
  const nome = arquivo.originalFilename ?? arquivo.filename;

  return (
    <Stack gap={4} maw={360}>
      {kind === 'image' && <ImageMedia url={arquivo.url} alt={nome} />}
      {kind === 'video' && (
        <video
          controls
          src={arquivo.url}
          style={{ maxHeight: MAX_MEDIA_HEIGHT, maxWidth: '100%', borderRadius: 6 }}
        />
      )}
      {kind === 'audio' && <AudioMedia url={arquivo.url} />}
      {kind === 'document' && <DocumentMedia url={arquivo.url} nome={nome} />}
      {media.caption && media.caption.trim() !== '' && (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <HighlightedText text={media.caption} regex={searchRegex} active={searchActive} />
        </Text>
      )}
    </Stack>
  );
}

function ImageMedia({ url, alt }: { url: string; alt: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title="Abrir imagem">
      {/* eslint-disable-next-line @next/next/no-img-element -- Firebase Storage URL, not a Next static asset */}
      <img
        src={url}
        alt={alt}
        style={{
          maxHeight: MAX_MEDIA_HEIGHT,
          maxWidth: '100%',
          borderRadius: 6,
          display: 'block',
          cursor: 'zoom-in',
        }}
      />
    </a>
  );
}

const RATES = [1, 1.5, 2] as const;

function AudioMedia({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [rateIndex, setRateIndex] = useState(0);

  function cycleRate() {
    const next = (rateIndex + 1) % RATES.length;
    setRateIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = RATES[next]!;
  }

  return (
    <Group gap={6} wrap="nowrap" align="center">
      <audio ref={audioRef} controls src={url} style={{ maxWidth: 240 }} />
      <Button size="compact-xs" variant="light" onClick={cycleRate} aria-label="Velocidade">
        {RATES[rateIndex]}x
      </Button>
    </Group>
  );
}

function DocumentMedia({ url, nome }: { url: string; nome: string }) {
  return (
    <Anchor href={url} target="_blank" rel="noopener noreferrer" download size="sm">
      <Group gap={6} wrap="nowrap">
        <IconFile size={18} />
        <Text size="sm" lineClamp={1}>
          {nome}
        </Text>
      </Group>
    </Anchor>
  );
}
