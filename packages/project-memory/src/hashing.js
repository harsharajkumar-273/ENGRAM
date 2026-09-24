import { createHash } from 'crypto';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
