import { describe, expect, it } from 'vitest';
import {
  bookmarkStorageKey,
  isBookmarkSlot,
  loadBookmarks,
  saveBookmarks,
  type BookmarkStorage,
} from '../../src/editor/state/camera-bookmarks.js';
import type { CameraBookmark } from '../../src/editor/viewport/viewport-controller.js';

function memoryStorage(seed: Record<string, string> = {}): BookmarkStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const front: CameraBookmark = {
  projection: 'orthographic',
  position: [0, 0.5, 12],
  target: [0, 0.5, 0],
  up: [0, 1, 0],
  zoom: 1.5,
};

describe('camera bookmarks', () => {
  it('round-trips through storage, per project and scene', () => {
    const storage = memoryStorage();
    saveBookmarks(storage, 'demo', 'main', { '1': front });
    expect(loadBookmarks(storage, 'demo', 'main')).toEqual({ '1': front });
    expect(loadBookmarks(storage, 'demo', 'arena')).toEqual({});
    expect(loadBookmarks(storage, 'other', 'main')).toEqual({});
  });

  it('keys cannot collide across ids that contain the separator', () => {
    expect(bookmarkStorageKey('a/b', 'c')).not.toEqual(bookmarkStorageKey('a', 'b/c'));
  });

  it('drops a malformed slot without losing the others', () => {
    const key = bookmarkStorageKey('demo', 'main');
    const storage = memoryStorage({
      [key]: JSON.stringify({
        '1': front,
        '2': { ...front, projection: 'fisheye' },
        '3': { ...front, position: [0, 1] },
        '4': { ...front, zoom: 0 },
        '5': 'nonsense',
        '12': front,
      }),
    });
    expect(loadBookmarks(storage, 'demo', 'main')).toEqual({ '1': front });
  });

  it('treats unreadable storage as empty', () => {
    const key = bookmarkStorageKey('demo', 'main');
    expect(loadBookmarks(memoryStorage({ [key]: '{not json' }), 'demo', 'main')).toEqual({});
    expect(loadBookmarks(memoryStorage({ [key]: '[]' }), 'demo', 'main')).toEqual({});
    expect(loadBookmarks(undefined, 'demo', 'main')).toEqual({});
  });

  it('recognises the nine slots and nothing else', () => {
    expect(isBookmarkSlot('1')).toBe(true);
    expect(isBookmarkSlot('9')).toBe(true);
    expect(isBookmarkSlot('0')).toBe(false);
    expect(isBookmarkSlot('10')).toBe(false);
  });
});
