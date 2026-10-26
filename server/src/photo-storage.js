import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function localPhotoPath(key) {
  if(!/^local:photos\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpeg|png|webp)$/.test(key))throw Object.assign(new Error('Invalid photo storage key'),{status:422,code:'INVALID_PHOTO_KEY'});
  const directory=process.env.PHOTO_LOCAL_DIR||fileURLToPath(new URL('../data/photos/',import.meta.url));
  return path.resolve(directory,key.slice('local:photos/'.length));
}
