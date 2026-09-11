import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { button, color, fontFamily, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { DOM, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import type { ProjectSummary } from '../state/editor-session.js';
import { Archive, Copy, Download, Play, Plus, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Project home (plan §3): game cards with create, open, and — in later stages — duplicate,
 * rename, archive, import, and export source.
 *
 * Project ids become folder names, so the form validates the same shape the workspace
 * service enforces instead of letting the request fail with a server error.
 *
 * ## Layout
 *
 * The page is a launcher, so the thumbnails are the content and everything else is supporting
 * text. The card is thumbnail-first: a 16:9 still, a title, one metadata line, and a single
 * primary action. The previous card stacked four equally-weighted buttons in a column beside a
 * 46px icon, which made a launcher look like a settings table and repeated the project's name
 * three times (title, id, and the folder it lives in).
 *
 * The four secondary actions did not disappear — they moved into a per-card overflow menu. The
 * visible "Open" button stays on the card because that is the action, and a card whose only
 * affordance is a hover-revealed menu is a card that looks broken when nothing is hovered.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * The two "quiet secondary text" treatments, kept as reusable fragments.
 *
 * `muted` is the home's metadata voice; `cardMeta` is the same at card scale. Both set `margin: 0`
 * because they are applied to `p` elements, whose default margin would otherwise break the rhythm.
 */
const muted = {
  color: color.dim,
  margin: 0,
  fontSize: fontSize.sm,
} as const;

const styles = stylex.create({
  home: {
    paddingBlock: space.lg,
    paddingInline: space.lg,
    maxWidth: '1180px',
    marginInline: 'auto',
    width: '100%',
    overflow: 'auto',
  },
  homeHeader: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: space.lg,
    marginBlockEnd: space.lg,
    flexWrap: 'wrap',
  },
  /**
   * The wordmark is the one large piece of type in the editor. It is not a heading for the page's
   * content so much as a nameplate for the product, which is why the accent dot sits inside it —
   * it is the only place the accent is used decoratively, and it is what makes the header feel
   * designed rather than defaulted.
   */
  homeTitle: {
    margin: 0,
    marginBlockEnd: space.xs,
    fontSize: '21px',
    fontWeight: 600,
    letterSpacing: '-0.015em',
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
  },
  homeTitleDot: {
    width: '8px',
    height: '8px',
    borderRadius: radius.pill,
    backgroundColor: color.primary,
  },
  homeSubtitle: muted,
  homeActions: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
  },
  /** The header's filter field, which only appears once the grid is long enough to need it. */
  searchWrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    color: color.dim,
  },
  searchIcon: {
    position: 'absolute',
    insetInlineStart: '7px',
    pointerEvents: 'none',
    display: 'grid',
    placeItems: 'center',
  },
  search: {
    width: '180px',
    paddingInlineStart: '25px',
  },
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.lg,
    marginBlockEnd: space.md,
    fontSize: fontSize.sm,
  },
  bannerError: {
    backgroundColor: 'rgba(46, 20, 18, 0.8)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.danger,
    color: '#f6ddd9',
  },
  /**
   * The create form is a panel, not a bordered strip inside the page: while it is open it is the
   * page's primary content, so it takes the same surface as a card.
   */
  createForm: {
    display: 'flex',
    gap: space.md,
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    paddingBlock: space.md,
    paddingInline: space.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.panel,
    marginBlockEnd: space.lg,
  },
  createField: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    color: color.dim,
    fontSize: fontSize.xs,
  },
  hint: {
    color: color.warn,
    fontSize: fontSize.xs,
  },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(272px, 1fr))',
    gap: space.md,
  },
  /**
   * A card is a surface with a thumbnail well at the top and a footer row at the bottom. The
   * thumbnail well is a fixed 16:9 so a grid of cards has one visual rhythm regardless of what
   * image each project has — and so the placeholder occupies exactly the same space as a real
   * capture, which is what stops the empty state from looking like a broken image.
   */
  card: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: color.panel,
    overflow: 'hidden',
    transition: 'border-color 120ms ease, background-color 120ms ease',
    ':hover': {
      borderColor: color['border-strong'],
      backgroundColor: color['panel-2'],
    },
  },
  /** The hover a card raises for its own children. StyleX has no descendant selector, so the
   *  "show the actions" state is a named class the footer reads rather than a rule reaching in. */
  cardHovered: {
    borderColor: color['border-strong'],
    backgroundColor: color['panel-2'],
  },
  cardThumb: {
    aspectRatio: '16 / 9',
    display: 'grid',
    placeItems: 'center',
    backgroundColor: color.bg,
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
    color: color.dim,
    overflow: 'hidden',
  },
  cardThumbImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xxs,
    paddingBlock: space.md,
    paddingInline: space.md,
    minWidth: 0,
  },
  cardTitle: {
    margin: 0,
    fontSize: fontSize.md,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** One metadata line, not two. The id is what a terminal user needs; the date is what a human does. */
  cardMeta: {
    ...muted,
    fontSize: fontSize.xs,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    paddingBlock: space.sm,
    paddingInline: space.md,
  },
  cardSpacer: {
    flex: 1,
  },
  cardOpen: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    paddingInline: space.md,
  },
  /**
   * The four secondary actions collapse to icon buttons that appear on hover.
   *
   * The first attempt put them behind an overflow menu, which does not work here: a card sets
   * `overflow: hidden` so its thumbnail can be clipped to the card's radius, and that clips a
   * popover too. A menu anchored to the footer was cut off at the card's edge.
   *
   * Revealing the row on hover keeps the resting card to a title and one action, and because the
   * icons carry `title` and `aria-label`, nothing becomes unreachable for a pointer that cannot
   * hover — the row is a layout choice, not a gate on the action.
   */
  cardActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    opacity: 0,
    transition: 'opacity 120ms ease',
  },
  cardActionsVisible: {
    opacity: 1,
  },
  /** The action row is revealed by the card's hover, so the card owns the hover state. */
  cardAction: {
    display: 'grid',
    placeItems: 'center',
    width: '26px',
    height: '26px',
    paddingInline: 0,
    color: color.dim,
    ':hover': {
      color: color.text,
    },
  },
  iconButton: {
    display: 'grid',
    placeItems: 'center',
    width: '28px',
    height: '28px',
    paddingInline: 0,
    color: color.dim,
    ':hover': {
      color: color.text,
    },
  },
  archives: {
    marginBlockStart: space.lg,
  },
  archivesTitle: {
    ...muted,
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    marginBlockEnd: space.sm,
  },
  archivesList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: space.xxs,
  },
  archiveRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.panel,
    fontSize: fontSize.sm,
  },
  mono: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    color: color.muted,
  },
  muted,
  empty: {
    color: color.dim,
    padding: space.lg,
    textAlign: 'center',
    fontSize: fontSize.sm,
    gridColumn: '1 / -1',
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: color.border,
    borderRadius: radius.lg,
  },
});

export function ProjectHome(): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [creating, setCreating] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [template, setTemplate] = useState('blank');
  const [filter, setFilter] = useState('');
  const [archives, setArchives] = useState<Array<{ directory: string; projectId: string; archivedAt: string; reason: string }>>([]);
  const importRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void session.refreshProjects();
    void session.client
      .listArchives()
      .then((result) => setArchives(result.archives))
      .catch(() => setArchives([]));
  }, [session]);

  const idProblem =
    id.length === 0
      ? 'Choose a folder name'
      : !ID_PATTERN.test(id) || id.includes('..')
        ? 'Use letters, numbers, dot, dash, or underscore'
        : null;

  const create = async () => {
    if (idProblem) return;
    const ok = await session.createProject({ id, name: name.trim() || id, template });
    if (ok) {
      setCreating(false);
      setId('');
      setName('');
    }
  };

  const needle = filter.trim().toLowerCase();
  const visibleProjects = needle
    ? snapshot.projects.filter(
        (project) => project.name.toLowerCase().includes(needle) || project.id.toLowerCase().includes(needle),
      )
    : snapshot.projects;

  return (
    <div {...withDomClass(styles.home, DOM.home)}>
      <header {...stylex.props(styles.homeHeader)}>
        <div>
          <h1 {...stylex.props(styles.homeTitle)}>
            <span {...stylex.props(styles.homeTitleDot)} />
            Coilbox
          </h1>
          <p {...stylex.props(styles.homeSubtitle)}>
            Local-first game studio for Three.js projects. Games are ordinary folders in your workspace.
          </p>
        </div>
        <div {...stylex.props(styles.homeActions)}>
          {/**
           * Search earns its place only once the grid is long enough to scan. Below that it is a
           * control that can never find anything the eye could not.
           */}
          {snapshot.projects.length > 6 && (
            <span {...stylex.props(styles.searchWrap)}>
              <span {...stylex.props(styles.searchIcon)}>
                <Search size={14} />
              </span>
              <input
                {...stylex.props(styles.search)}
                type="search"
                value={filter}
                placeholder="Filter games"
                aria-label="Filter games"
                onChange={(event) => setFilter(event.target.value)}
              />
            </span>
          )}
          <button type="button" onClick={() => importRef.current?.click()} disabled={busy !== null}>
            Import source…
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".gz,.tgz,application/gzip"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (importRef.current) importRef.current.value = '';
              if (!file) return;
              setBusy('importing');
              await session.importSource(file);
              setBusy(null);
            }}
          />
          <button {...stylex.props(button.primary)} type="button" onClick={() => setCreating((value) => !value)}>
            <Plus size={16} />
            New game
          </button>
        </div>
      </header>

      {snapshot.projectError && (
        <div {...stylex.props(styles.banner, styles.bannerError)} role="alert">
          {snapshot.projectError}
          <button type="button" onClick={() => void session.refreshProjects()}>
            Retry
          </button>
        </div>
      )}

      {creating && (
        <form
          {...stylex.props(styles.createForm)}
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label {...stylex.props(styles.createField)}>
            <span>Folder name</span>
            <input value={id} onChange={(event) => setId(event.target.value)} placeholder="collect-room" autoFocus />
          </label>
          <label {...stylex.props(styles.createField)}>
            <span>Display name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Collect Room" />
          </label>
          <label {...stylex.props(styles.createField)}>
            <span>Template</span>
            <select value={template} onChange={(event) => setTemplate(event.target.value)}>
              <option value="blank">Blank</option>
              <option value="collect-room">Collect Room</option>
              <option value="physics-targets">Physics Targets</option>
            </select>
          </label>
          <button {...stylex.props(button.primary)} type="submit" disabled={Boolean(idProblem)}>
            Create
          </button>
          {id && idProblem && <span {...stylex.props(styles.hint)}>{idProblem}</span>}
        </form>
      )}

      <div {...stylex.props(styles.cards)}>
        {visibleProjects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            busy={busy !== null}
            onOpen={() => void session.openProject(project.id)}
            onDuplicate={async () => {
              const suggested = `${project.id}-copy`;
              const newId = globalThis.prompt('New project id', suggested);
              if (!newId) return;
              setBusy(`duplicating ${project.id}`);
              await session.duplicateProject(newId, `${project.name} copy`);
              setBusy(null);
            }}
            onExport={() => void session.exportSource(project.id)}
            onArchive={async () => {
              if (!globalThis.confirm(`Archive "${project.name}"? It moves to the workspace archive and can be restored.`)) return;
              setBusy(`archiving ${project.id}`);
              await session.archiveProject();
              const result = await session.client.listArchives().catch(() => null);
              if (result) setArchives(result.archives);
              setBusy(null);
            }}
          />
        ))}
        {snapshot.projects.length === 0 && !snapshot.loading && (
          <div {...withDomClass(styles.empty, DOM.panelEmpty)}>
            No games yet. Create one, or run <code>pnpm studio create my-game</code> from a terminal.
          </div>
        )}
        {snapshot.projects.length > 0 && visibleProjects.length === 0 && (
          <div {...withDomClass(styles.empty, DOM.panelEmpty)}>No games match “{filter}”.</div>
        )}
      </div>

      {archives.length > 0 && (
        <section {...stylex.props(styles.archives)}>
          <h2 {...stylex.props(styles.archivesTitle)}>Archived</h2>
          <ul {...stylex.props(styles.archivesList)}>
            {archives.map((entry) => (
              <li {...stylex.props(styles.archiveRow)} key={entry.directory}>
                <span {...stylex.props(styles.mono)}>{entry.projectId}</span>
                <span {...stylex.props(styles.muted)}>
                  {entry.archivedAt ? new Date(entry.archivedAt).toLocaleString() : ''}
                </span>
                {entry.reason && <span {...stylex.props(styles.muted)}>{entry.reason}</span>}
                <span {...stylex.props(styles.cardSpacer)} />
                <button
                  type="button"
                  onClick={async () => {
                    setBusy(`restoring ${entry.directory}`);
                    const ok = await session.client.restoreArchive(entry.directory).catch(() => null);
                    if (ok) {
                      const result = await session.client.listArchives();
                      setArchives(result.archives);
                      await session.refreshProjects();
                    }
                    setBusy(null);
                  }}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onDuplicate,
  onExport,
  onArchive,
  busy,
}: {
  project: ProjectSummary;
  onOpen(): void;
  onDuplicate(): void;
  onExport(): void;
  onArchive(): void;
  busy: boolean;
}): JSX.Element {
  /**
   * The card owns its hover state rather than relying on a CSS `:hover` rule, because StyleX has no
   * descendant selector and the action row is a child that has to react to the card being hovered.
   * `onFocusCapture`/`onBlurCapture` extend the same reveal to keyboard focus, so tabbing to an
   * action does not reach a control that is invisible.
   */
  const [hovered, setHovered] = useState(false);
  /**
   * The secondary actions, kept as data so the row is a map rather than three near-identical
   * buttons. Each carries an icon plus a title and an aria-label, so the icon is never the only
   * name the control has.
   */
  const secondaryActions: Array<{ label: string; title: string; Icon: LucideIcon; run(): void }> = [
    { label: 'Duplicate', title: 'Copy this project', Icon: Copy, run: onDuplicate },
    { label: 'Export source', title: 'Download a source archive', Icon: Download, run: onExport },
    { label: 'Archive', title: 'Move to the recoverable archive', Icon: Archive, run: onArchive },
  ];

  return (
    <article
      {...withDomClass(styles.card, hovered && styles.cardHovered, DOM.card)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={() => setHovered(false)}
    >
      <div {...stylex.props(styles.cardThumb)} aria-hidden="true">
        {project.hasThumbnail ? (
          <img
            {...stylex.props(styles.cardThumbImage)}
            src={`/api/projects/${encodeURIComponent(project.id)}/thumbnail`}
            alt=""
          />
        ) : (
          /**
           * The placeholder is a glyph on the app backdrop rather than an emoji. An emoji here
           * rendered in the platform's colour font, which put a full-colour cartoon in the middle
           * of a monochrome page and read as a missing asset rather than a deliberate blank.
           */
          <Play size={28} />
        )}
      </div>
      <div {...stylex.props(styles.cardBody)}>
        <h2 {...stylex.props(styles.cardTitle)}>{project.name}</h2>
        <p {...stylex.props(styles.cardMeta)}>
          {project.id} · {project.sceneCount} scene{project.sceneCount === 1 ? '' : 's'} · updated{' '}
          {new Date(project.modifiedAt).toLocaleDateString()}
        </p>
      </div>
      <div {...stylex.props(styles.cardFooter)}>
        <div {...stylex.props(styles.cardActions, hovered && styles.cardActionsVisible)}>
          {secondaryActions.map((action) => (
            <button
              key={action.label}
              {...stylex.props(styles.cardAction)}
              type="button"
              title={action.title}
              aria-label={`${action.label} ${project.name}`}
              disabled={busy}
              onClick={action.run}
            >
              <action.Icon size={14} />
            </button>
          ))}
        </div>
        <span {...stylex.props(styles.cardSpacer)} />
        <button {...stylex.props(button.primary, styles.cardOpen)} type="button" onClick={onOpen}>
          Open
        </button>
      </div>
    </article>
  );
}
