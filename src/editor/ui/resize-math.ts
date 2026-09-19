export interface ResizeMathInput {
  startSize: number;
  startPointer: number;
  pointer: number;
  direction: 1 | -1;
  min: number;
  max: number;
}

export function nextSize({ startSize, startPointer, pointer, direction, min, max }: ResizeMathInput): number {
  return Math.max(min, Math.min(startSize + direction * (pointer - startPointer), max));
}
