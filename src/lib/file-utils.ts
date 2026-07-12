import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  LoadedDocument,
  MetaDocument,
  MetaLoc,
  MetaTypeEntry,
} from "./types.js";

function globToRegExp(glob: string): RegExp {
  // Escape regex special chars except * and ?
  let s = glob.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  s = s.replace(/\*\*/g, "<<<TWOSTAR>>>");
  s = s.replace(/\*/g, "[^/]*");
  s = s.replace(/<<<TWOSTAR>>>/g, ".*");
  s = s.replace(/\?/g, ".");

  return new RegExp(`^${s}$`);
}

function matchesAny(relPath: string, patterns?: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const posixPath = relPath.split(path.sep).join("/");
  return patterns.some((p) => globToRegExp(p).test(posixPath));
}

export async function collectMetaFiles(
  inputPath: string,
  includePatterns?: string[] | undefined,
  excludePatterns?: string[] | undefined,
): Promise<string[]> {
  const resolvedInput = path.resolve(inputPath);
  const stat = await fs.stat(resolvedInput);

  if (stat.isFile()) {
    if (!resolvedInput.endsWith(".lua")) return [];
    const rel = path.basename(resolvedInput);
    if (excludePatterns && matchesAny(rel, excludePatterns)) return [];
    if (
      includePatterns &&
      includePatterns.length > 0 &&
      !matchesAny(rel, includePatterns)
    )
      return [];
    return [resolvedInput];
  }

  const files: string[] = [];
  await walkDirectory(resolvedInput, files);
  const filtered = files
    .filter((file) => file.endsWith(".lua"))
    .filter((file) => {
      const rel = path.relative(resolvedInput, file).split(path.sep).join("/");
      if (excludePatterns && matchesAny(rel, excludePatterns)) return false;
      if (
        includePatterns &&
        includePatterns.length > 0 &&
        !matchesAny(rel, includePatterns)
      )
        return false;
      return true;
    });

  return filtered.sort((left, right) => left.localeCompare(right));
}

export async function resolveJsonPath(options: {
  metaFile: string;
  sourceRoot: string;
  jsonRoot: string | undefined;
}): Promise<string> {
  if (!options.jsonRoot) {
    return toJsonPath(options.metaFile);
  }

  const jsonStat = await fs.stat(options.jsonRoot);
  if (jsonStat.isDirectory()) {
    const relativeMetaPath = path.relative(
      options.sourceRoot,
      options.metaFile,
    );
    const directPath = path.join(
      options.jsonRoot,
      toJsonRelativePath(relativeMetaPath),
    );

    try {
      await fs.access(directPath);
      return directPath;
    } catch {
      const fallback = await findJsonFileByBaseName(
        options.jsonRoot,
        path.basename(directPath),
      );
      if (fallback) {
        return fallback;
      }

      return directPath;
    }
  }

  return path.resolve(options.jsonRoot);
}

export async function loadAggregatedDocuments(options: {
  jsonPath: string;
  fallbackMetaFile: string;
}): Promise<LoadedDocument[]> {
  const jsonText = await fs.readFile(options.jsonPath, "utf8");
  const document = JSON.parse(jsonText) as MetaDocument;
  return splitDocumentBySourceFile(
    document,
    options.fallbackMetaFile,
    options.jsonPath,
  );
}

function splitDocumentBySourceFile(
  document: MetaDocument,
  fallbackMetaFile: string,
  jsonPath: string,
): LoadedDocument[] {
  const groups = new Map<string, MetaDocument>();

  const ensureGroup = (metaFile: string): MetaDocument => {
    const existing = groups.get(metaFile);
    if (existing) {
      return existing;
    }

    const created: MetaDocument = { types: [], globals: [] };
    groups.set(metaFile, created);
    return created;
  };

  const addToGroup = (
    metaFile: string | undefined,
    kind: "types" | "globals",
    entry: MetaTypeEntry,
  ): void => {
    const resolvedMetaFile = metaFile ?? fallbackMetaFile;
    const group = ensureGroup(resolvedMetaFile);
    const bucket = group[kind];
    if (bucket) {
      bucket.push(entry);
    }
  };

  for (const entry of document.types ?? []) {
    addToGroup(getEntrySourceFile(entry), "types", entry);
  }

  for (const entry of document.globals ?? []) {
    addToGroup(getEntrySourceFile(entry), "globals", entry);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([metaFile, groupedDocument]) => ({
      metaFile,
      jsonPath,
      document: groupedDocument,
    }));
}

function getEntrySourceFile(entry: {
  loc?: MetaLoc | MetaLoc[] | null;
}): string | undefined {
  if (Array.isArray(entry.loc)) {
    return entry.loc[0]?.file;
  }

  return entry.loc?.file;
}

export function toJsonPath(inputPath: string): string {
  return path.join(
    path.dirname(inputPath),
    toJsonFileName(path.basename(inputPath)),
  );
}

function toJsonRelativePath(relativePath: string): string {
  return path.join(
    path.dirname(relativePath),
    toJsonFileName(path.basename(relativePath)),
  );
}

function toJsonFileName(fileName: string): string {
  return fileName.replace(/\.meta\.lua$/i, ".json").replace(/\.lua$/i, ".json");
}

async function findJsonFileByBaseName(
  rootDir: string,
  fileName: string,
): Promise<string | undefined> {
  for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
    const resolved = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      const nestedMatch = await findJsonFileByBaseName(resolved, fileName);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.isFile() && entry.name === fileName) {
      return resolved;
    }
  }

  return undefined;
}

async function walkDirectory(directory: string, files: string[]): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(resolved, files);
      continue;
    }

    if (entry.isFile()) {
      files.push(resolved);
    }
  }
}
