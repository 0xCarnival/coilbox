import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
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
    <div className="home">
      <header className="home-header">
        <div>
          <h1>Coilbox</h1>
          <p>Local-first game studio for Three.js projects. Games are ordinary folders in your workspace.</p>
        </div>
        <div className="home-actions">
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
          <button type="button" className="primary" onClick={() => setCreating((value) => !value)}>
            + New game
          </button>
        </div>
      </header>

      {snapshot.projectError && (
        <div className="banner error" role="alert">
          {snapshot.projectError}
          <button type="button" onClick={() => void session.refreshProjects()}>
            Retry
          </button>
        </div>
      )}

      {creating && (
        <form
          className="create-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            <span>Folder name</span>
            <input value={id} onChange={(event) => setId(event.target.value)} placeholder="collect-room" autoFocus />
          </label>
          <label>
            <span>Display name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Collect Room" />
          </label>
          <label>
            <span>Template</span>
            <select value={template} onChange={(event) => setTemplate(event.target.value)}>
              <option value="blank">Blank</option>
              <option value="collect-room">Collect Room</option>
              <option value="physics-targets">Physics Targets</option>
            </select>
          </label>
          <button type="submit" className="primary" disabled={Boolean(idProblem)}>
            Create
          </button>
          {id && idProblem && <span className="hint">{idProblem}</span>}
        </form>
      )}

      <div className="cards">
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
          <div className="panel-empty">
            No games yet. Create one, or run <code>pnpm studio create my-game</code> from a terminal.
          </div>
        )}
      </div>

      {archives.length > 0 && (
        <section className="archives">
          <h2>Archived</h2>
          <ul>
            {archives.map((entry) => (
              <li key={entry.directory}>
                <span className="mono">{entry.projectId}</span>
                <span className="muted">{entry.archivedAt ? new Date(entry.archivedAt).toLocaleString() : ''}</span>
                {entry.reason && <span className="muted">{entry.reason}</span>}
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
    <article className="card">
      <div className="card-thumb" aria-hidden="true">
        {project.hasThumbnail ? (
          <img src={`/api/projects/${encodeURIComponent(project.id)}/thumbnail`} alt="" />
        ) : (
          '🎮'
        )}
      </div>
      <div className="card-body">
        <h2>{project.name}</h2>
        <p className="muted">
          {project.id} · {project.sceneCount} scene{project.sceneCount === 1 ? '' : 's'}
        </p>
        <p className="muted">Updated {new Date(project.modifiedAt).toLocaleString()}</p>
      </div>
      <div className="card-actions">
        <button type="button" className="primary" onClick={onOpen}>
          Open
        </button>
        <button type="button" disabled={busy} onClick={onDuplicate} title="Copy this project">
          Duplicate
        </button>
        <button type="button" disabled={busy} onClick={onExport} title="Download a source archive">
          Export source
        </button>
        <button type="button" disabled={busy} onClick={onArchive} title="Move to the recoverable archive">
          Archive
        </button>
      </div>
    </article>
  );
}
