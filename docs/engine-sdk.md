# Engine SDK — writing behaviors

A behavior is the only place game logic lives. The runtime creates one instance per behavior
component in Play or in an export — never while a scene is being edited — and gives it a narrow
context. This guide is what you need to write one.

## The shape of a behavior

```ts
import type { BehaviorDefinition } from './types.js';

export const doorOpener: BehaviorDefinition = {
  id: 'game.door',                     // lowercase, dots and dashes, stable forever
  name: 'Door',                        // shown in the inspector
  description: 'Opens when the player is close and the score is high enough.',
  properties: [                        // declared once: inspector, validator, registry.json
    { key: 'openDistance', label: 'Open distance', type: 'number', default: 2.5, min: 0.5, max: 10, step: 0.1 },
    { key: 'requiredScore', label: 'Required score', type: 'number', default: 0, min: 0, max: 100, step: 1 },
    { key: 'playerName', label: 'Player entity name', type: 'text', default: 'Player' },
    { key: 'openStateKey', label: 'State key', type: 'text', default: 'doorOpen' },
  ],
  create(context) {
    let open = false;
    return {
      start() {
        context.setState(context.properties.openStateKey as string, false);
      },
      fixedUpdate() {
        if (open) return;
        const player = context.findEntityByName(String(context.properties.playerName));
        if (!player) return;
        const score = context.getState<number>('score') ?? 0;
        if (score < Number(context.properties.requiredScore)) return;
        if (distance(context, player) > Number(context.properties.openDistance)) return;
        open = true;
        context.setState(context.properties.openStateKey as string, true);
        context.setBodyEnabled(context.entityId, false);   // stop blocking the way
        context.playSound({ volume: 0.8 });
        context.emit('door-opened');
        context.log('opened');
      },
    };
  },
};

function distance(context: Parameters<typeof doorOpener.create>[0], other: string): number {
  const a = context.scratch.transform;
  const b = new Float32Array(7);
  if (!context.readTransform(context.entityId, a) || !context.readTransform(other, b)) return Number.POSITIVE_INFINITY;
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}
```

Register it in `src/runtime/behaviors/library.ts`:

```ts
export const BEHAVIOR_LIBRARY: BehaviorDefinition[] = [ /* … */ doorOpener ];
```

Then `pnpm games` regenerates the demo projects' `scripts/registry.json` from the library, and a
project you are authoring can reference `game.door` in a scene document:

```json
{
  "type": "behavior",
  "behaviorId": "game.door",
  "properties": { "openDistance": 3, "requiredScore": 2 }
}
```

## Lifecycle

| Hook | When it runs | Use it for |
| --- | --- | --- |
| `start()` | once, after the world and its physics bodies exist | reading initial transforms, initialising state |
| `fixedUpdate(delta)` | every fixed simulation step (1/60 s by default) | movement, physics changes, rules — anything gameplay |
| `update(delta)` | every rendered frame | camera smoothing and presentation only; never step physics here |
| `onPhysicsEvent(event)` | when a contact, hit, or sensor event involves this entity | triggers, impacts |
| `dispose()` | when the world is torn down | releasing listeners, audio, anything you created |

`fixedUpdate` advances on the fixed step, so Pause and Step behave predictably — which is also why
animation, movement, and rules belong there rather than in `update`.

## The context

Everything a behavior can touch. There is deliberately no filesystem, no document store, and no
editor access.

```ts
context.entityId                  // this entity's id
context.behaviorId                // this behavior's registered id
context.properties                // declared defaults merged with the entity's stored values
context.scratch                   // { transform, velocity } reusable Float32Arrays — do not allocate per tick

// Entities
context.findEntityByName(name)    // EntityId | null
context.findEntityById(id)        // EntityId | null

// Transforms (write into your scratch buffers; arrays are [x, y, z, qx, qy, qz, qw])
context.readTransform(id, out)    // boolean
context.readVelocity(id, out)     // boolean (3 components)
context.moveKinematic(id, position, rotation)   // kinematic bodies only
context.moveCharacter(id, position, rotation)   // kinematic characters: sweeps walls, slides
  // `position` is rewritten with where the character actually got to
context.applyImpulse(id, impulse, point?)
context.setLinearVelocity(id, velocity)
context.isPhysicsBody(id)
context.setBodyType(id, 'static' | 'dynamic' | 'kinematic')
context.setBodyEnabled(id, enabled)             // collected pickups, opened doors
context.raycast(origin, direction, maxDistance)
  // → { hit, entityId, distance, point, normal }

// Input — actions, never keys
context.isActionDown('moveForward')
context.wasActionPressed('jump')
context.wasActionReleased('interact')
context.moveAxis()                // { x, y } already normalised for diagonals
context.pointer()                 // { x, y (NDC), clientX, clientY, down, justPressed, justReleased }

// Game state — the small object HUD bindings also read
context.getState<T>(key)
context.setState(key, value)

// Presentation
context.playClip(clip | null, { loop, speed, autoplay })   // this entity's model clips
context.playSound({ volume, loop })                        // this entity's audio asset
context.prepareAudio()                                     // decode ahead of the first play
context.showOverlay('start' | 'win' | 'lose' | 'pause' | null)
context.setOverlayVisible(kind, visible)
context.setHudText(elementId, text)

// Flow
context.requestScene(sceneId)     // the session rebuilds the world for another scene
context.requestRestart()
context.requestAction('restart' | 'nextScene' | 'resume' | 'none')

// Reporting
context.log(message, data?)
context.emit(event, payload?)
context.on(event, handler)        // → unsubscribe
```

## Property descriptors

Property metadata is declared once and shared by the inspector, the validator, and
`scripts/registry.json`. The supported types are deliberately restricted:

| `type` | Inspector control | Notes |
| --- | --- | --- |
| `number` | number field | supports `min`, `max`, `step` |
| `boolean` | checkbox | |
| `text` | text field | |
| `enum` | dropdown | requires `options: string[]` |
| `entity` | entity picker | value is an entity id or `null` |
| `asset` | asset picker | value is an asset id |

Add `advanced: true` to keep a field collapsed under "advanced", and `description` for the help
text. `group` labels a set of related fields.

## Conventions and hard rules

- **Forward is local −Z.** The camera and light aiming helpers follow it, and the character mover
  computes facing from it. `Object3D.lookAt` uses +Z for plain objects and −Z for cameras — do not
  build rotations with the wrong one.
- **Physics owns dynamic transforms.** Write to kinematic bodies through `moveKinematic`; never set
  a dynamic body's transform directly and expect it to stick.
- **Characters move with `moveCharacter`, not `moveKinematic`, when walls matter.** It sweeps the
  entity's collider horizontally against the world, so a wall stops the character and a diagonal
  push slides along it. Sensors (triggers) are passed through, and the position you pass in is
  rewritten with the resolved result — use that, not the value you asked for.
- **Do not allocate per tick.** Use `context.scratch`; the loop runs 60 times a second for every
  entity.
- **Never throw out of a hook.** A throwing behavior is reported against its entity and skipped, but
  the frame still has to complete; guard your preconditions and log instead.
- **Resolve entities by name or id, and tolerate `null`.** A design-time reference can be missing at
  runtime; failing softly with a log beats a crash.
- **Units are metres and seconds**; rotations are quaternions in documents and degrees in the
  inspector. The world is Y-up.

## Testing a behavior

Behaviors are plain objects, so they can be driven without a browser: create a real Box3D world
through the physics adapter, build a `BehaviorRuntime` with a small host, and step it. See
`tests/unit/behaviors.test.ts` for a working harness — it covers the character mover's grounding,
triggers, knock-down detection, the launcher, and the camera.

```bash
pnpm test                                   # everything
pnpm vitest run tests/unit/behaviors.test.ts   # just the behavior suite
```
