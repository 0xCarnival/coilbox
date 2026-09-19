import { describe, expect, it } from 'vitest';
import { expireToasts, MAX_TOASTS, nextExpiry, pushToast, TOAST_MS } from '../../src/editor/ui/toast-queue.js';

const entry = (id: number, message: string, level = 'info', detail?: string) => ({ id, level, message, detail });

describe('toast queue', () => {
  it('collapses an identical message into one toast with a count and a fresh clock', () => {
    let queue = pushToast([], entry(1, 'Saved'), 1000);
    queue = pushToast(queue, entry(2, 'Saved'), 2000);
    queue = pushToast(queue, entry(3, 'Saved'), 3000);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: 3, message: 'Saved', count: 3, expiresAt: 3000 + TOAST_MS });
  });

  it('keeps different levels or details apart and pulls a repeat to the front', () => {
    let queue = pushToast([], entry(1, 'Import failed', 'error', 'a.glb'), 0);
    queue = pushToast(queue, entry(2, 'Import failed', 'error', 'b.glb'), 0);
    queue = pushToast(queue, entry(3, 'Import failed', 'warning', 'a.glb'), 0);
    expect(queue).toHaveLength(3);
    queue = pushToast(queue, entry(4, 'Import failed', 'error', 'a.glb'), 10);
    expect(queue.map((toast) => toast.id)).toEqual([2, 3, 4]);
    expect(queue[2]?.count).toBe(2);
  });

  it('never shows more than the cap, dropping the oldest', () => {
    let queue: ReturnType<typeof pushToast> = [];
    for (let id = 1; id <= MAX_TOASTS + 2; id += 1) queue = pushToast(queue, entry(id, `Message ${id}`), id);
    expect(queue).toHaveLength(MAX_TOASTS);
    expect(queue[0]?.message).toBe('Message 3');
  });

  it('expires toasts by their own clock and reports the next expiry', () => {
    let queue = pushToast([], entry(1, 'First'), 0);
    queue = pushToast(queue, entry(2, 'Second'), 1000);
    expect(nextExpiry(queue)).toBe(TOAST_MS);
    const later = expireToasts(queue, TOAST_MS);
    expect(later.map((toast) => toast.message)).toEqual(['Second']);
    expect(expireToasts(later, TOAST_MS)).toBe(later);
    expect(nextExpiry([])).toBeNull();
  });
});
