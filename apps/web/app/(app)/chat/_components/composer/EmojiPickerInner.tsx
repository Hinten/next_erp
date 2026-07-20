'use client';

// This module statically imports the (heavy) emoji-mart Picker + its data set;
// it is only ever pulled in via the `next/dynamic` boundary in `EmojiButton`
// (ssr:false), so the ~1MB emoji data lands in a lazy chunk loaded on first open.
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

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
  return (
    <Picker
      data={data}
      theme={theme}
      previewPosition="none"
      skinTonePosition="none"
      locale="pt"
      onEmojiSelect={(emoji: EmojiSelection) => {
        if (emoji.native) onSelect(emoji.native);
      }}
    />
  );
}
