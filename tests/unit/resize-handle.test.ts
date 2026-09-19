import { describe, expect, it } from 'vitest';
import { nextSize } from '@editor/ui/resize-math.js';

describe('nextSize', () => {
  it('grows in the positive direction and clamps to the maximum', () => {
    expect(nextSize({ startSize: 300, startPointer: 10, pointer: 60, direction: 1, min: 220, max: 320 })).toBe(320);
  });

  it('grows when dragging toward the negative direction', () => {
    expect(nextSize({ startSize: 300, startPointer: 100, pointer: 40, direction: -1, min: 220, max: 620 })).toBe(360);
  });

  it('clamps in both directions', () => {
    expect(nextSize({ startSize: 300, startPointer: 0, pointer: -200, direction: 1, min: 220, max: 620 })).toBe(220);
    expect(nextSize({ startSize: 300, startPointer: 0, pointer: -400, direction: -1, min: 220, max: 320 })).toBe(320);
  });
});
