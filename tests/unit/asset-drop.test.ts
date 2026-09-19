import { describe, expect, it } from 'vitest';
import { ASSET_DRAG_MIME, hasAssetDrag, readAssetDrag } from '@editor/assets/asset-drop.js';

class FakeDataTransfer implements DataTransfer {
  dropEffect: DataTransfer['dropEffect'] = 'none';
  effectAllowed: DataTransfer['effectAllowed'] = 'all';
  files = {} as FileList;
  items = {} as DataTransferItemList;
  constructor(
    private readonly raw: string,
    readonly types: string[],
  ) {}
  clearData(): void {}
  getData(): string {
    return this.raw;
  }
  setData(): void {}
  setDragImage(): void {}
}

function dataTransfer(raw: string, types: string[] = [ASSET_DRAG_MIME]): DataTransfer {
  return new FakeDataTransfer(raw, types);
}

describe('asset drag payloads', () => {
  it('reads a valid payload', () => {
    expect(readAssetDrag(dataTransfer(JSON.stringify({ assetId: 'crate', kind: 'model' })))).toEqual({
      assetId: 'crate',
      kind: 'model',
    });
  });

  it('rejects malformed JSON and unknown kinds', () => {
    expect(readAssetDrag(dataTransfer('{'))).toBeNull();
    expect(readAssetDrag(dataTransfer(JSON.stringify({ assetId: 'crate', kind: 'video' })))).toBeNull();
  });

  it('detects the custom drag type without reading protected drag data', () => {
    expect(hasAssetDrag(dataTransfer('', [ASSET_DRAG_MIME]))).toBe(true);
    expect(hasAssetDrag(dataTransfer('', ['Files']))).toBe(false);
  });
});
