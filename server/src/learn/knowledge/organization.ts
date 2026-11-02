// Source organisation: folders, placements and display names. Presentation
// only and never identity. docs/CONTRACTS.md, "Source organisation".

import { randomUUID } from "node:crypto";
import type { OrganizationAction, OrganizationFile } from "../../../../shared/learn/sources.ts";
import { ID_PATTERN, badRequest } from "./errors.ts";

/** A body larger than 64 KiB is refused. */
export const ORGANIZATION_BODY_LIMIT = 64 * 1024;

export function emptyOrganization(): OrganizationFile {
  return { version: 1, folders: [], placements: {} };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strict parse. An unsupported version, a duplicate folder id, an empty name, a
 * cycle or a placement for an unknown folder refuses, and the caller leaves the
 * data unchanged.
 */
export function parseOrganization(input: unknown): OrganizationFile {
  if (!isObject(input) || input.version !== 1) throw badRequest("The source organisation has an unsupported version.");
  if (!Array.isArray(input.folders) || !isObject(input.placements)) {
    throw badRequest("The source organisation has an unexpected shape.");
  }
  const folders: OrganizationFile["folders"] = [];
  const ids = new Set<string>();
  for (const f of input.folders) {
    if (!isObject(f) || typeof f.id !== "string" || typeof f.createdAt !== "string") {
      throw badRequest("The source organisation holds a folder with an unexpected shape.");
    }
    if (typeof f.name !== "string" || f.name.trim() === "") throw badRequest("A folder in the source organisation has an empty name.");
    if (ids.has(f.id)) throw badRequest("The source organisation holds two folders with one identifier.");
    ids.add(f.id);
    const parentId = f.parentId === null || f.parentId === undefined ? null : f.parentId;
    if (parentId !== null && typeof parentId !== "string") throw badRequest("A folder has a parent that is not an identifier.");
    folders.push({
      id: f.id,
      name: f.name.trim(),
      parentId,
      createdAt: f.createdAt,
      ...(typeof f.importPath === "string" ? { importPath: f.importPath } : {}),
    });
  }
  const parents = new Map(folders.map((f) => [f.id, f.parentId]));
  for (const f of folders) {
    if (f.parentId !== null && !parents.has(f.parentId)) throw badRequest("A folder has a parent that does not exist.");
    const seen = new Set<string>([f.id]);
    for (let p = f.parentId; p !== null; p = parents.get(p) ?? null) {
      if (seen.has(p)) throw badRequest("The source organisation holds a cycle of folders.");
      seen.add(p);
    }
  }
  const placements: OrganizationFile["placements"] = {};
  for (const [id, raw] of Object.entries(input.placements)) {
    if (!isObject(raw)) throw badRequest("A placement in the source organisation has an unexpected shape.");
    const folderId = raw.folderId === undefined ? null : raw.folderId;
    if (folderId !== null && (typeof folderId !== "string" || !parents.has(folderId))) {
      throw badRequest("A placement names a folder that does not exist.");
    }
    placements[id] = { folderId, ...(typeof raw.name === "string" && raw.name !== "" ? { name: raw.name } : {}) };
  }
  return { version: 1, folders, placements };
}

function isDescendantOrSelf(org: OrganizationFile, folderId: string, candidate: string | null): boolean {
  const parents = new Map(org.folders.map((f) => [f.id, f.parentId]));
  const seen = new Set<string>();
  for (let p = candidate; p !== null; p = parents.get(p) ?? null) {
    if (p === folderId) return true;
    if (seen.has(p)) return false;
    seen.add(p);
  }
  return false;
}

function cleanName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") throw badRequest("A name must be a non empty text.");
  return name.trim();
}

function requireFolder(org: OrganizationFile, id: string | null): void {
  if (id !== null && !org.folders.some((f) => f.id === id)) throw badRequest("The folder does not exist.");
}

export interface ActionResult {
  organization: OrganizationFile;
  createdFolderId?: string;
}

/** Applies one action to the current state and returns the new state. The input is never changed. */
export function applyAction(current: OrganizationFile, action: OrganizationAction, now: Date, newId: () => string = randomUUID): ActionResult {
  const org: OrganizationFile = {
    version: 1,
    folders: current.folders.map((f) => ({ ...f })),
    placements: Object.fromEntries(Object.entries(current.placements).map(([k, v]) => [k, { ...v }])),
  };
  switch (action.type) {
    case "create-folder": {
      const name = cleanName(action.name);
      const parentId = action.parentId ?? null;
      requireFolder(org, parentId);
      const id = `folder_${newId()}`;
      org.folders.push({ id, name, parentId, createdAt: now.toISOString() });
      return { organization: org, createdFolderId: id };
    }
    case "rename-folder": {
      const f = org.folders.find((x) => x.id === action.id);
      if (!f) throw badRequest("The folder does not exist.");
      f.name = cleanName(action.name);
      return { organization: org };
    }
    case "rename-source": {
      if (typeof action.id !== "string" || !ID_PATTERN.test(action.id)) throw badRequest("The source identifier is not valid.");
      const name = cleanName(action.name);
      org.placements[action.id] = { folderId: org.placements[action.id]?.folderId ?? null, name };
      return { organization: org };
    }
    case "move": {
      const parentId = action.parentId ?? null;
      requireFolder(org, parentId);
      if (action.kind === "folder") {
        const f = org.folders.find((x) => x.id === action.id);
        if (!f) throw badRequest("The folder does not exist.");
        if (isDescendantOrSelf(org, f.id, parentId)) throw badRequest("A folder cannot move into itself or one of its own folders.");
        f.parentId = parentId;
      } else if (action.kind === "source") {
        if (typeof action.id !== "string" || !ID_PATTERN.test(action.id)) throw badRequest("The source identifier is not valid.");
        const held = org.placements[action.id];
        org.placements[action.id] = { folderId: parentId, ...(held?.name ? { name: held.name } : {}) };
      } else {
        throw badRequest("The kind must be source or folder.");
      }
      return { organization: org };
    }
    case "delete-folder": {
      if (!org.folders.some((f) => f.id === action.id)) throw badRequest("The folder does not exist.");
      if (org.folders.some((f) => f.parentId === action.id)) throw badRequest("The folder holds other folders and cannot be deleted yet.");
      if (Object.values(org.placements).some((p) => p.folderId === action.id)) {
        throw badRequest("The folder holds sources and cannot be deleted yet.");
      }
      org.folders = org.folders.filter((f) => f.id !== action.id);
      return { organization: org };
    }
    default:
      throw badRequest("The action type is not known.");
  }
}

/** Reads and checks an action from a request body. */
export function parseAction(body: Record<string, unknown>): OrganizationAction {
  const t = body.type;
  const str = (k: string): string => {
    const v = body[k];
    if (typeof v !== "string") throw badRequest(`The field ${k} must be a text.`);
    return v;
  };
  const parent = (): string | null => {
    const v = body.parentId;
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") throw badRequest("The field parentId must be a text or null.");
    return v;
  };
  switch (t) {
    case "create-folder":
      return { type: t, name: str("name"), parentId: parent() };
    case "rename-folder":
      return { type: t, id: str("id"), name: str("name") };
    case "rename-source":
      return { type: t, id: str("id"), name: str("name") };
    case "move": {
      const kind = body.kind;
      if (kind !== "source" && kind !== "folder") throw badRequest("The kind must be source or folder.");
      return { type: t, kind, id: str("id"), parentId: parent() };
    }
    case "delete-folder":
      return { type: t, id: str("id") };
    default:
      throw badRequest("The action type must be create-folder, rename-folder, rename-source, move or delete-folder.");
  }
}

/** Removes the placements of the given sources and then the selected folders bottom up while they are empty. */
export function pruneAfterDeletion(
  current: OrganizationFile,
  removedSources: ReadonlySet<string>,
  selectedFolders: ReadonlySet<string>,
): OrganizationFile {
  const org: OrganizationFile = {
    version: 1,
    folders: current.folders.map((f) => ({ ...f })),
    placements: Object.fromEntries(Object.entries(current.placements).filter(([id]) => !removedSources.has(id)).map(([k, v]) => [k, { ...v }])),
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of [...org.folders]) {
      if (!selectedFolders.has(f.id)) continue;
      const hasFolder = org.folders.some((x) => x.parentId === f.id);
      const hasSource = Object.values(org.placements).some((p) => p.folderId === f.id);
      if (hasFolder || hasSource) continue;
      org.folders = org.folders.filter((x) => x.id !== f.id);
      changed = true;
    }
  }
  return org;
}
