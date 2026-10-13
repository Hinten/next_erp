'use client';

import { useEffect, useRef } from 'react';

// This module statically imports the (heavy) emoji-mart Picker + its data set;
// it is only ever pulled in via the `next/dynamic` boundary in `EmojiButton`
// (ssr:false), so the ~1MB emoji data lands in a lazy chunk loaded on first open.
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';
import pt from '@emoji-mart/data/i18n/pt.json';

/** The single field of an emoji-mart selection we consume. */
interface EmojiSelection {
  native?: string;
}

export default function EmojiPickerInner({
  onSelect,
  theme,
}: {
  onSelect: (native: string) => void;
  theme: 'light' | 'dark' | 'auto';
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The picker creates its open shadow root synchronously in its child effect.
    const shadowRoot = containerRef.current?.querySelector('em-emoji-picker')?.shadowRoot;
    if (!shadowRoot) return;

    // Category titles need a solid surface when colourful emojis scroll behind
    // them. Inherited theme variables keep that surface readable in both modes.
    const headerStyles = new CSSStyleSheet();
    headerStyles.replaceSync(`
      #root .sticky {
        background-color: var(--mantine-color-body);
        color: var(--mantine-color-text);
        -webkit-backdrop-filter: none;
        backdrop-filter: none;
      }
    `);
    shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, headerStyles];
    return () => {
      shadowRoot.adoptedStyleSheets = shadowRoot.adoptedStyleSheets.filter(
        (sheet) => sheet !== headerStyles,
      );
    };
  }, []);

  return (
    <div ref={containerRef}>
      <Picker
        data={data}
        theme={theme}
        previewPosition="none"
        skinTonePosition="none"
        locale="pt"
        i18n={pt}
        onEmojiSelect={(emoji: EmojiSelection) => {
          if (emoji.native) onSelect(emoji.native);
        }}
      />
    </div>
  );
}
