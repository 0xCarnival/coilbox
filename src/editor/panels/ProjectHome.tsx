import { useEffect, useState } from 'react';
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

  useEffect(() => {
    void session.refreshProjects();
  }, [session]);

  const idProblem =
    id.length === 0
      ? 'Choose a folder name'
      : !ID_PATTERN.test(id) || id.includes('..')
        ? 'Use letters, numbers, dot, dash, or underscore'
        : null;

  const create = async () => {
    if (idProblem) return;
    const ok = await session.createProject({ id, name: name.trim() || id });
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
        <button type="button" className="primary" onClick={() => setCreating((value) => !value)}>
          + New game
        </button>
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
          <button type="submit" className="primary" disabled={Boolean(idProblem)}>
            Create
          </button>
          {id && idProblem && <span className="hint">{idProblem}</span>}
        </form>
      )}

      <div className="cards">
        {snapshot.projects.map((project) => (
          <ProjectCard key={project.id} project={project} onOpen={() => void session.openProject(project.id)} />
        ))}
        {snapshot.projects.length === 0 && !snapshot.loading && (
          <div className="panel-empty">
            No games yet. Create one, or run <code>pnpm studio create my-game</code> from a terminal.
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen(): void }): JSX.Element {
  return (
    <article className="card">
      <div className="card-thumb" aria-hidden="true">
        {project.hasThumbnail ? '🖼' : '🎮'}
      </div>
      <div className="card-body">
        <h2>{project.name}</h2>
        <p className="muted">
          {project.id} · {project.sceneCount} scene{project.sceneCount === 1 ? '' : 's'}
        </p>
        <p className="muted">Updated {new Date(project.modifiedAt).toLocaleString()}</p>
      </div>
      <button type="button" className="primary" onClick={onOpen}>
        Open
      </button>
    </article>
  );
}
