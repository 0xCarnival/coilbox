import { z } from 'zod';
import type { AssetKind, EntityId } from '@schema/index.js';
import { audioComponent, materialComponent } from '@schema/index.js';
import type { EditorSession } from '../state/editor-session.js';
import { createEntity } from '../document/factory.js';
import { createEntityId } from '../document/commands.js';

export const ASSET_DRAG_MIME = 'application/x-coilbox-asset';

const payloadSchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(['model', 'image', 'audio']),
});

export interface AssetDragPayload {
  assetId: string;
  kind: AssetKind;
}

export function readAssetDrag(dataTransfer: DataTransfer): AssetDragPayload | null {
  const raw = dataTransfer.getData(ASSET_DRAG_MIME);
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function hasAssetDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(ASSET_DRAG_MIME);
}

export interface AssetDropTarget {
  entityId: EntityId | null;
  point: [number, number, number];
}

export function applyAssetDrop(
  session: EditorSession,
  payload: AssetDragPayload,
  target: AssetDropTarget,
): { ok: true; message: string } | { ok: false; message: string } {
  const scene = session.scene;
  if (!scene) return { ok: false, message: 'Open a scene before placing an asset.' };
  if (payload.kind === 'model') {
    const id = createEntityId('model', scene.entities.map((entity) => entity.id));
    const entity = createEntity('group', {
      id,
      name: payload.assetId,
      position: target.point,
      usedIds: scene.entities.map((candidate) => candidate.id),
    });
    entity.components = [{ type: 'model', assetId: payload.assetId, castShadow: true, receiveShadow: true }];
    session.execute({ kind: 'insertEntities', entities: [entity], label: 'Place model' });
    session.select(id);
    return { ok: true, message: `Placed ${payload.assetId}` };
  }

  if (target.entityId === null) {
    return {
      ok: false,
      message:
        payload.kind === 'image'
          ? 'Drop an image on a box, sphere, plane, capsule or cylinder to use it as that object\'s texture.'
          : 'Drop a sound on an object to attach it.',
    };
  }
  const entity = scene.entities.find((candidate) => candidate.id === target.entityId);
  if (!entity) return { ok: false, message: 'The drop target no longer exists.' };
  if (payload.kind === 'image') {
    if (!entity.components.some((component) => component.type === 'primitive')) {
      return {
        ok: false,
        message: 'Drop an image on a box, sphere, plane, capsule or cylinder to use it as that object\'s texture.',
      };
    }
    if (entity.components.some((component) => component.type === 'material')) {
      session.execute({
        kind: 'setComponentProperty',
        entityId: entity.id,
        componentType: 'material',
        property: 'map',
        value: payload.assetId,
      });
    } else {
      session.execute({
        kind: 'addComponent',
        entityId: entity.id,
        component: materialComponent.parse({ type: 'material', map: payload.assetId }),
      });
    }
    return { ok: true, message: `Applied ${payload.assetId}` };
  }
  const audio = audioComponent.parse({ type: 'audio', assetId: payload.assetId });
  if (entity.components.some((component) => component.type === 'audio')) {
    session.execute({
      kind: 'setComponentProperty',
      entityId: entity.id,
      componentType: 'audio',
      property: 'assetId',
      value: payload.assetId,
    });
  } else {
    session.execute({ kind: 'addComponent', entityId: entity.id, component: audio });
  }
  return { ok: true, message: `Attached ${payload.assetId}` };
}
