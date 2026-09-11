import { useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AssetEntry } from '@schema/index.js';
import { useSession, useSessionSnapshot } from '../hooks.js';

/**
 * Asset browser (plan §3, §4): import, inspect, and remove the project's assets.
 *
 * The panel is deliberately blunt about failures. A refused import states what this version
 * supports, and removing an asset that a scene still uses is refused with the list of
 * scenes — losing a model silently is the failure mode this panel exists to prevent.
 */

export function AssetBrowser(): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const assets = snapshot.assets;

  const importFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    const list = Array.from(files);
    await session.importFiles(list);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div
      className={`asset-browser${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void importFiles(event.dataTransfer.files);
      }}
    >
      <div className="asset-toolbar">
        <button type="button" className="primary" disabled={busy || snapshot.importing} onClick={() => inputRef.current?.click()}>
          {busy || snapshot.importing ? 'Importing…' : 'Import files'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".glb,.gltf,.png,.jpg,.jpeg,.webp,.mp3,.ogg,.wav"
          style={{ display: 'none' }}
          onChange={(event) => void importFiles(event.target.files)}
        />
        <span className="muted">
          Drag files here. Supported: self-contained .glb models, PNG/JPEG/WebP images, MP3/OGG/WAV audio.
        </span>
      </div>

      {assets.length === 0 ? (
        <div className="panel-empty">
          No assets yet. Import a .glb to place a model, or keep building with primitives.
        </div>
      ) : (
        <table className="asset-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Kind</th>
              <th>Size</th>
              <th>Used by</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                usage={snapshot.assetUsage[asset.id] ?? []}
                onDelete={() => void session.deleteAsset(asset.id)}
                onReplace={(file) => void session.replaceAsset(asset.id, file)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AssetRow({
  asset,
  usage,
  onDelete,
  onReplace,
}: {
  asset: AssetEntry;
  usage: Array<{ sceneId: string; entityId: string; entityName: string }>;
  onDelete(): void;
  onReplace(file: File): void;
}): JSX.Element {
  const replaceRef = useRef<HTMLInputElement | null>(null);
  const unsupported = asset.requires.filter((extension) =>
    ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension),
  );

  return (
    <tr data-asset-id={asset.id}>
      <td className="mono">{asset.id}</td>
      <td>{asset.kind}</td>
      <td>{formatBytes(asset.bytes)}</td>
      <td>
        {usage.length === 0 ? (
          <span className="muted">unused</span>
        ) : (
          usage.map((entry) => (
            <div key={`${entry.sceneId}:${entry.entityId}`} className="muted">
              {entry.entityName} <span className="mono">({entry.sceneId})</span>
            </div>
          ))
        )}
      </td>
      <td>
        {unsupported.length > 0 ? (
          <span className="warn">needs {unsupported.join(', ')} — this version cannot decode it</span>
        ) : (
          <span className="muted mono" title={asset.hash}>
            {asset.hash.slice(0, 15)}…
          </span>
        )}
      </td>
      <td className="asset-actions">
        <button type="button" title="Replace the file behind this asset id" onClick={() => replaceRef.current?.click()}>
          Replace
        </button>
        <input
          ref={replaceRef}
          type="file"
          accept=".glb,.gltf,.png,.jpg,.jpeg,.webp,.mp3,.ogg,.wav"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onReplace(file);
            if (replaceRef.current) replaceRef.current.value = '';
          }}
        />
        <button type="button" title={usage.length > 0 ? 'Remove the references first' : 'Remove from the project'} onClick={onDelete}>
          Remove
        </button>
      </td>
    </tr>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
