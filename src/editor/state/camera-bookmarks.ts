import { z } from 'zod';
import type { CameraBookmark } from '../viewport/viewport-controller.js';

/**
 * Saved editor framings, nine per scene, keyed 1–9 like the numpad views they sit beside.
 *
 * They are an editor preference rather than document data: a bookmark describes where *this user*
 * likes to look from, not what the game is, so writing it into the scene would dirty the document
 * and ship a stranger's viewpoints in an export. Browser storage keeps them per project and scene,
 * which is the granularity a framing is meaningful at — slot 3 in the lobby has nothing to do with
 * slot 3 in the arena.
 */

export type BookmarkSlot = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

export const BOOKMARK_SLOTS: readonly BookmarkSlot[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export type CameraBookmarks = Partial<Record<BookmarkSlot, CameraBookmark>>;

const STORAGE_PREFIX = 'coilbox.camera-bookmarks.v1';

/** The subset of `Storage` these functions need, so a test can hand in a Map-backed stand-in. */
export interface BookmarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isBookmarkSlot(value: string): value is BookmarkSlot {
  return BOOKMARK_SLOTS.some((slot) => slot === value);
}

export function bookmarkStorageKey(projectId: string, sceneId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(projectId)}/${encodeURIComponent(sceneId)}`;
}

const tripleSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/**
 * Stored JSON is untrusted the moment it is written: a future field rename, a hand edit, or another
 * tab on an older build can all leave a shape this build does not expect. Each slot is parsed on its
 * own, so a malformed one is dropped rather than taking the other eight with it.
 */
const bookmarkSchema: z.ZodType<CameraBookmark> = z.object({
  projection: z.enum(['perspective', 'orthographic']),
  position: tripleSchema,
  target: tripleSchema,
  up: tripleSchema,
  zoom: z.number().finite().positive(),
  fov: z.number().finite().positive().nullable(),
});

const storedSchema = z.record(z.string(), z.unknown());

/**
 * Web Storage throws as readily as it returns: disabled by policy, blocked in a private window, or
 * over quota. Reads treat any failure as "nothing saved"; writes report it so the caller can say so
 * instead of announcing a bookmark that does not exist.
 */
export function loadBookmarks(storage: BookmarkStorage | undefined, projectId: string, sceneId: string): CameraBookmarks {
  let parsed: unknown;
  try {
    const raw = storage?.getItem(bookmarkStorageKey(projectId, sceneId));
    if (!raw) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const stored = storedSchema.safeParse(parsed);
  if (!stored.success) return {};
  const bookmarks: CameraBookmarks = {};
  for (const slot of BOOKMARK_SLOTS) {
    const bookmark = bookmarkSchema.safeParse(stored.data[slot]);
    if (bookmark.success) bookmarks[slot] = bookmark.data;
  }
  return bookmarks;
}

export function saveBookmarks(
  storage: BookmarkStorage | undefined,
  projectId: string,
  sceneId: string,
  bookmarks: CameraBookmarks,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(bookmarkStorageKey(projectId, sceneId), JSON.stringify(bookmarks));
    return true;
  } catch {
    return false;
  }
}

/** `globalThis.localStorage` itself throws where storage is denied, so acquiring it is guarded too. */
export function browserBookmarkStorage(): BookmarkStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
