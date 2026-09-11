import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { button, color, fontFamily, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { DOM, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import type { ProjectSummary } from '../state/editor-session.js';

/**
 * Project home (plan §3): game cards with create, open, and — in later stages — duplicate,
 * rename, archive, import, and export source.
 *
 * Project ids become folder names, so the form validates the same shape the workspace
 * service enforces instead of letting the request fail with a server error.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * The two "quiet secondary text" treatments, kept as reusable fragments.
 *
 * `styles.muted` is the editor-wide `.muted` convention; `cardMeta` is the 11px lowercase variant
 * the home cards use. Both set `margin: 0` because they are applied to `p` elements, whose default
 * margin would otherwise break the card rhythm.
 */
const muted = {
  color: color.muted,
  margin: 0,
} as const;

const wideButton = {
  fontSize: fontSize.sm,
  whiteSpace: 'nowrap',
} as const;

const styles = stylex.create({
  home: {
    padding: '24px',
    maxWidth: '1100px',
    marginInline: 'auto',
    width: '100%',
    overflow: 'auto',
  },
  homeHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.lg,
    marginBlockEnd: '18px',
  },
  homeTitle: {
    margin: 0,
    marginBlockEnd: space.xs,
    fontSize: '20px',
  },
  homeSubtitle: muted,
  homeActions: {
    display: 'flex',
    gap: space.sm,
  },
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    padding: '8px 12px',
    borderRadius: radius.lg,
    marginBlockEnd: '14px',
  },
  bannerError: {
    backgroundColor: '#3a1418',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: '#7a2630',
    color: '#ffd7db',
  },
  createForm: {
    display: 'flex',
    gap: space.md,
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    padding: '12px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.line,
    borderRadius: '10px',
    backgroundColor: color.panel,
    marginBlockEnd: '18px',
  },
  createField: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    color: color.muted,
  },
  hint: {
    color: color.warn,
  },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '12px',
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.line,
    borderRadius: '10px',
    backgroundColor: color.panel,
  },
  cardThumb: {
    width: '46px',
    height: '46px',
    display: 'grid',
    placeItems: 'center',
    backgroundColor: '#10141c',
    borderRadius: radius.lg,
    fontSize: '20px',
  },
  cardThumbImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    borderRadius: radius.lg,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    margin: 0,
    marginBlockEnd: space.xxs,
    fontSize: '14px',
  },
  cardMeta: {
    ...muted,
    fontSize: fontSize.xs,
  },
  cardActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
  },
  cardActionButton: wideButton,
  archives: {
    marginBlockStart: '26px',
  },
  archivesTitle: {
    fontSize: '14px',
    margin: 0,
    marginBlockEnd: '8px',
  },
  archivesList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
  },
  archiveRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    padding: '6px 10px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.line,
    borderRadius: radius.lg,
    backgroundColor: color.panel,
  },
  mono: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
  },
  muted,
  empty: {
    color: color.muted,
    padding: '14px',
    textAlign: 'center',
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

  return (
    <div {...withDomClass(styles.home, DOM.home)}>
      <header {...stylex.props(styles.homeHeader)}>
        <div>
          <h1 {...stylex.props(styles.homeTitle)}>Coilbox</h1>
          <p {...stylex.props(styles.homeSubtitle)}>
            Local-first game studio for Three.js projects. Games are ordinary folders in your workspace.
          </p>
        </div>
        <div {...stylex.props(styles.homeActions)}>
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
            + New game
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
          {id && idProblem && (
            <span {...stylex.props(styles.hint)}>
              {idProblem}
            </span>
          )}
        </form>
      )}

      <div {...stylex.props(styles.cards)}>
        {snapshot.projects.map((project) => (
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
                {entry.reason && (
                  <span {...stylex.props(styles.muted)}>{entry.reason}</span>
                )}
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
  return (
    <article {...withDomClass(styles.card, DOM.card)}>
      <div {...stylex.props(styles.cardThumb)} aria-hidden="true">
        {project.hasThumbnail ? (
          <img
            {...stylex.props(styles.cardThumbImage)}
            src={`/api/projects/${encodeURIComponent(project.id)}/thumbnail`}
            alt=""
          />
        ) : (
          '🎮'
        )}
      </div>
      <div {...stylex.props(styles.cardBody)}>
        <h2 {...stylex.props(styles.cardTitle)}>{project.name}</h2>
        <p {...stylex.props(styles.cardMeta)}>
          {project.id} · {project.sceneCount} scene{project.sceneCount === 1 ? '' : 's'}
        </p>
        <p {...stylex.props(styles.cardMeta)}>Updated {new Date(project.modifiedAt).toLocaleString()}</p>
      </div>
      <div {...stylex.props(styles.cardActions)}>
        <button {...stylex.props(styles.cardActionButton, button.primary)} type="button" onClick={onOpen}>
          Open
        </button>
        <button
          {...stylex.props(styles.cardActionButton)}
          type="button"
          disabled={busy}
          onClick={onDuplicate}
          title="Copy this project"
        >
          Duplicate
        </button>
        <button
          {...stylex.props(styles.cardActionButton)}
          type="button"
          disabled={busy}
          onClick={onExport}
          title="Download a source archive"
        >
          Export source
        </button>
        <button
          {...stylex.props(styles.cardActionButton)}
          type="button"
          disabled={busy}
          onClick={onArchive}
          title="Move to the recoverable archive"
        >
          Archive
        </button>
      </div>
    </article>
  );
}
