import { randomUUID } from 'node:crypto';

/** Generate an opaque server-side id (UUID v4). Ids are treated as opaque non-empty strings. */
export function newId(): string {
  return randomUUID();
}
