import { useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { AssetEntry } from '@schema/index.js';
import { button, color, fontFamily, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { PanelSection, SegmentedControl, type SegmentedOption } from '../ui/Controls.js';
import { DOM, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';

/**
 * Asset browser (plan §3, §4): import, inspect, and remove the project's assets.
 *
 * The panel is deliberately blunt about failures. A refused import states what this version
 * supports, and removing an asset that a scene still uses is refused with the list of
 * scenes — losing a model silently is the failure mode this panel exists to prevent.
 */

/**
 * The asset kinds, in the order a person looks for them.
 *
 * Models first because they are what a scene is mostly made of, then the images a material uses,
 * then audio.
 */
/** The two layouts the asset list offers. */
type AssetView = 'grouped' | 'flat';

const ASSET_GROUPS = [
  { kind: 'model', title: 'Models' },
  { kind: 'image', title: 'Images' },
  { kind: 'audio', title: 'Audio' },
] as const;

const styles = stylex.create({
  browser: {
    paddingBlock: space.sm,
    paddingInline: space.md,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    minHeight: 0,
  },
  dragging: {
    outlineWidth: '1px',
    outlineStyle: 'dashed',
    outlineColor: color.primary,
    outlineOffset: '-4px',
    borderRadius: radius.lg,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  muted: {
    color: color.dim,
    margin: 0,
    fontSize: fontSize.xs,
  },
  mono: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
  },
  warn: {
    color: color.warn,
    fontSize: fontSize.xs,
  },
  empty: {
    color: color.dim,
    padding: space.lg,
    textAlign: 'center',
    fontSize: fontSize.sm,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontVariantNumeric: 'tabular-nums',
  },
  /**
   * `.asset-table th` / `.asset-table td` were descendant rules. Each cell carries its own style
   * instead, which removes the selector entirely — and because a class beats a bare element
   * selector, the earlier `td { padding: 4px 6px }` from `base.css` no longer competes with it.
   */
  /**
   * The header row is a tracked micro-label, which is what lets it stay quiet: at 10px uppercase
   * it reads as a column heading without needing a rule beneath it to separate it from the data.
   */
  headCell: {
    textAlign: 'left',
    color: color.dim,
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
    paddingBlock: space.sm,
    paddingInline: space.sm,
  },
  /**
   * Rows are separated by a tint rather than a border per cell. A rule under every row is what made
   * a four-row table read as a spreadsheet; at this density the row hover already marks the row.
   */
  cell: {
    paddingBlock: space.sm,
    paddingInline: space.sm,
    verticalAlign: 'top',
    fontSize: fontSize.sm,
  },
  /**
   * `.asset-table tr:hover td` tinted the *cells*, not the row box. A collapsed table's row box is
   * not reliably painted, so the tint is applied to the cells and driven by hover state rather than
   * by a `:hover` rule on the row — same pixels, no dependence on row-box painting.
   */
  cellHovered: {
    backgroundColor: color.wash,
  },
  actions: {
    display: 'flex',
    gap: space.xs,
    whiteSpace: 'nowrap',
  },
  /** The layout switch sits at the trailing edge of the panel's toolbar. */
  viewSwitch: {
    width: '200px',
    flexShrink: 0,
  },
  /** The stack of per-kind sections. The panel scrolls; this column does not. */
  groups: {
    display: 'flex',
    flexDirection: 'column',
  },
  /** The count beside a section's title. */
  groupCount: {
    marginInlineStart: 'auto',
    paddingInline: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    fontSize: fontSize.micro,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: color.muted,
  },
});

export function AssetBrowser(): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * Grouped by kind, or one flat list.
   *
   * Grouping is the better default — the kind was already a column, which is the tell that it wanted
   * to be a grouping — but a flat list is what you want when you are hunting one file by name and do
   * not remember what kind it was. Both are cheap, so the panel offers the choice rather than
   * guessing.
   */
  const [view, setView] = useState<AssetView>('grouped');

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
      {...stylex.props(styles.browser, dragging && styles.dragging)}
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
      <div {...withDomClass(styles.toolbar, DOM.assetToolbar)}>
        <button {...stylex.props(button.primary)} type="button" disabled={busy || snapshot.importing} onClick={() => inputRef.current?.click()}>
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
        <span {...stylex.props(styles.muted)}>
          Drag files here. Supported: self-contained .glb models, PNG/JPEG/WebP images, MP3/OGG/WAV audio.
        </span>
        {assets.length > 0 ? (
          <span {...stylex.props(styles.viewSwitch)}>
            <SegmentedControl<AssetView>
              ariaLabel="Asset list layout"
              value={view}
              onChange={setView}
              options={
                [
                  { value: 'grouped', label: 'By kind' },
                  { value: 'flat', label: 'Flat' },
                ] satisfies readonly SegmentedOption<AssetView>[]
              }
            />
          </span>
        ) : null}
      </div>

      {assets.length === 0 ? (
        <div {...withDomClass(styles.empty, DOM.panelEmpty)}>
          No assets yet. Import a .glb to place a model, or keep building with primitives.
        </div>
      ) : view === 'flat' ? (
        <table {...withDomClass(styles.table, DOM.assetTable)}>
          <thead>
            <tr>
              <th {...stylex.props(styles.headCell)}>Id</th>
              <th {...stylex.props(styles.headCell)}>Kind</th>
              <th {...stylex.props(styles.headCell)}>Size</th>
              <th {...stylex.props(styles.headCell)}>Used by</th>
              <th {...stylex.props(styles.headCell)}>Notes</th>
              <th {...stylex.props(styles.headCell)} />
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
      ) : (
        /**
         * One collapsible section per asset kind, each with its count.
         *
         * A single flat table made the reader scan every row to find the audio files, and the kind
         * was already a column — which is the tell that it wanted to be a grouping. Sections also
         * give the panel a place to say "3 models" without a second header row.
         *
         * The `.asset-table` hook stays on each table rather than moving to a wrapper, because the
         * browser gates count rows through it and a wrapper would count nothing.
         */
        <div {...stylex.props(styles.groups)}>
          {ASSET_GROUPS.map(({ kind, title }) => {
            const members = assets.filter((asset) => asset.kind === kind);
            if (members.length === 0) return null;
            return (
              <PanelSection key={kind} title={title} aside={<span {...stylex.props(styles.groupCount)}>{members.length}</span>}>
                <table {...withDomClass(styles.table, DOM.assetTable)}>
                  <thead>
                    <tr>
                      <th {...stylex.props(styles.headCell)}>Id</th>
                      <th {...stylex.props(styles.headCell)}>Size</th>
                      <th {...stylex.props(styles.headCell)}>Used by</th>
                      <th {...stylex.props(styles.headCell)}>Notes</th>
                      <th {...stylex.props(styles.headCell)} />
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((asset) => (
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
              </PanelSection>
            );
          })}
        </div>
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
  const [hovered, setHovered] = useState(false);
  const unsupported = asset.requires.filter((extension) =>
    ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension),
  );
  const cell = [styles.cell, hovered && styles.cellHovered] as const;

  return (
    <tr
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-asset-id={asset.id}
    >
      <td {...stylex.props(...cell, styles.mono)}>{asset.id}</td>
      <td {...stylex.props(...cell)}>{asset.kind}</td>
      <td {...stylex.props(...cell)}>{formatBytes(asset.bytes)}</td>
      <td {...stylex.props(...cell)}>
        {usage.length === 0 ? (
          <span {...stylex.props(styles.muted)}>unused</span>
        ) : (
          usage.map((entry) => (
            <div key={`${entry.sceneId}:${entry.entityId}`} {...stylex.props(styles.muted)}>
              {entry.entityName}{' '}
              <span {...stylex.props(styles.mono)}>({entry.sceneId})</span>
            </div>
          ))
        )}
      </td>
      <td {...stylex.props(...cell)}>
        {unsupported.length > 0 ? (
          <span {...stylex.props(styles.warn)}>needs {unsupported.join(', ')} — this version cannot decode it</span>
        ) : (
          <span {...stylex.props(styles.muted, styles.mono)} title={asset.hash}>
            {asset.hash.slice(0, 15)}…
          </span>
        )}
      </td>
      <td {...stylex.props(...cell, styles.actions)}>
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
