import { describe, expect, it } from 'vitest';
import {
  derivativeArquivoId,
  firebaseDownloadUrl,
  isDerivativeName,
  isWatchedProductOriginal,
  mediaPath,
  normalizeName,
  parseProductMediaDir,
  parseProductOriginalPath,
  productAnexoPath,
  productArquivoId,
  productDerivativePath,
  productOriginalPath,
  productVideoPath,
} from './storagePaths';

const PID = 'prod123';
const HASH = 'a'.repeat(16);

describe('path builders', () => {
  it('builds product original / derivative / video / anexo and media paths', () => {
    expect(productOriginalPath(PID, HASH, 'png')).toBe(`produtos/${PID}/originals/${HASH}.png`);
    expect(productOriginalPath(PID, HASH)).toBe(`produtos/${PID}/originals/${HASH}`);
    expect(productDerivativePath(PID, HASH, '200')).toBe(
      `produtos/${PID}/derivatives/${HASH}_200.jpeg`,
    );
    expect(productVideoPath(PID, HASH, 'mp4')).toBe(`produtos/${PID}/videos/${HASH}.mp4`);
    expect(productAnexoPath(PID, HASH, 'pdf')).toBe(`produtos/${PID}/anexos/${HASH}.pdf`);
    expect(productAnexoPath(PID, HASH)).toBe(`produtos/${PID}/anexos/${HASH}`);
    expect(mediaPath(HASH, '.PNG')).toBe(`media/${HASH}.png`);
  });
});

describe('parseProductOriginalPath / isWatchedProductOriginal', () => {
  it('round-trips a watched original (with and without extension)', () => {
    expect(parseProductOriginalPath(`produtos/${PID}/originals/${HASH}.png`)).toEqual({
      produtoId: PID,
      hash: HASH,
      ext: 'png',
    });
    expect(parseProductOriginalPath(`produtos/${PID}/originals/${HASH}`)).toEqual({
      produtoId: PID,
      hash: HASH,
      ext: null,
    });
  });

  it('returns null for derivatives, videos, media and garbage', () => {
    expect(parseProductOriginalPath(productDerivativePath(PID, HASH, '200'))).toBeNull();
    expect(parseProductOriginalPath(productVideoPath(PID, HASH, 'mp4'))).toBeNull();
    expect(parseProductOriginalPath(mediaPath(HASH, 'png'))).toBeNull();
    expect(parseProductOriginalPath('produtos/x/originals/a/b')).toBeNull();
    expect(parseProductOriginalPath('whatever')).toBeNull();
  });

  it('isWatchedProductOriginal matches only originals', () => {
    expect(isWatchedProductOriginal(productOriginalPath(PID, HASH, 'png'))).toBe(true);
    expect(isWatchedProductOriginal(productDerivativePath(PID, HASH, '400'))).toBe(false);
    expect(isWatchedProductOriginal(productVideoPath(PID, HASH, 'mp4'))).toBe(false);
    expect(isWatchedProductOriginal(mediaPath(HASH, 'png'))).toBe(false);
  });
});

describe('parseProductMediaDir', () => {
  it('parses the originals, videos and anexos directories to {produtoId, kind}', () => {
    // filepath is the directory portion (no filename) — what Arquivo.filepath holds.
    expect(parseProductMediaDir(`produtos/${PID}/originals`)).toEqual({
      produtoId: PID,
      kind: 'originals',
    });
    expect(parseProductMediaDir(`produtos/${PID}/videos`)).toEqual({
      produtoId: PID,
      kind: 'videos',
    });
    expect(parseProductMediaDir(`produtos/${PID}/anexos`)).toEqual({
      produtoId: PID,
      kind: 'anexos',
    });
  });

  it('returns null for derivatives, generic media, and malformed paths', () => {
    expect(parseProductMediaDir(`produtos/${PID}/derivatives`)).toBeNull();
    expect(parseProductMediaDir('media')).toBeNull();
    expect(parseProductMediaDir(`produtos/${PID}`)).toBeNull(); // too shallow
    expect(parseProductMediaDir(`produtos/${PID}/originals/extra`)).toBeNull(); // too deep
    expect(parseProductMediaDir('produtos//originals')).toBeNull(); // empty produtoId
    expect(parseProductMediaDir(null)).toBeNull();
    expect(parseProductMediaDir(undefined)).toBeNull();
  });
});

describe('isDerivativeName', () => {
  it('flags derivative suffixes only', () => {
    expect(isDerivativeName(`${HASH}_200.jpeg`)).toBe(true);
    expect(isDerivativeName(`produtos/${PID}/derivatives/${HASH}_jpeg.jpeg`)).toBe(true);
    expect(isDerivativeName(`${HASH}.png`)).toBe(false);
    expect(isDerivativeName(productOriginalPath(PID, HASH, 'png'))).toBe(false);
  });
});

describe('arquivo ids', () => {
  it('builds product-scoped original and derivative ids', () => {
    expect(productArquivoId(PID, HASH)).toBe(`${PID}_${HASH}`);
    expect(derivativeArquivoId(PID, HASH, '200')).toBe(`${PID}_${HASH}_200`);
  });
});

describe('normalizeName', () => {
  it('lowercases and sanitizes, preserving the extension', () => {
    expect(normalizeName('Minha Foto (1).JPG')).toBe('minha_foto__1_.jpg');
    expect(normalizeName('semextensao')).toBe('semextensao');
  });
});

describe('firebaseDownloadUrl', () => {
  it('builds a tokened, percent-encoded download URL', () => {
    expect(
      firebaseDownloadUrl('demo-erp.appspot.com', 'produtos/p1/derivatives/h_200.jpeg', 'tok-123'),
    ).toBe(
      'https://firebasestorage.googleapis.com/v0/b/demo-erp.appspot.com' +
        '/o/produtos%2Fp1%2Fderivatives%2Fh_200.jpeg?alt=media&token=tok-123',
    );
  });
});
