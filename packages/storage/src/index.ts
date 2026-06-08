export { arquivoCollection } from './collection';
export { StorageUploadError } from './errors';
export { sha512Hex, toBytes } from './hash';
export { extensionForContentType } from './mime';
export { buildFotoRefs, type FotoRefs } from './foto';
export {
  uploadFile,
  uploadProductImage,
  uploadFromUrl,
  type UploadResult,
  type UploadFileArgs,
  type UploadProductImageArgs,
  type UploadFromUrlArgs,
} from './upload';
