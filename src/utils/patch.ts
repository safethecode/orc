import { existsSync } from "node:fs";

export interface PatchChunk {
  searchLines: string[];
  replaceLines: string[];
}

export interface FilePatch {
  filePath: string;
  action: "modify" | "create" | "delete";
  chunks: PatchChunk[];
}

export function parsePatch(patchText: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const lines = patchText.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Scan for *** file:
    if (!lines[i].startsWith("*** file:")) {
      i++;
      continue;
    }

    const filePath = lines[i].slice("*** file:".length).trim();
    i++;

    let action: FilePatch["action"] = "modify";
    if (i < lines.length && lines[i].startsWith("*** action:")) {
      action = lines[i].slice("*** action:".length).trim() as FilePatch["action"];
      i++;
    }

    const chunks: PatchChunk[] = [];

    // Parse chunks until next file header or end marker
    while (i < lines.length) {
      if (
        lines[i].startsWith("*** file:") ||
        lines[i].startsWith("*** End Patch")
      ) {
        break;
      }

      if (lines[i] === "--- search") {
        i++;
        const searchLines: string[] = [];
        while (i < lines.length && lines[i] !== "+++ replace") {
          searchLines.push(lines[i]);
          i++;
        }

        if (i < lines.length && lines[i] === "+++ replace") {
          i++;
        }

        const replaceLines: string[] = [];
        while (
          i < lines.length &&
          lines[i] !== "--- search" &&
          !lines[i].startsWith("*** file:") &&
          !lines[i].startsWith("*** End Patch")
        ) {
          replaceLines.push(lines[i]);
          i++;
        }

        chunks.push({ searchLines, replaceLines });
        continue;
      }

      i++;
    }

    patches.push({ filePath, action, chunks });
  }

  return patches;
}

function fuzzyIndexOf(contentLines: string[], searchLines: string[], start: number): number {
  // Try exact match first
  for (let i = start; i <= contentLines.length - searchLines.length; i++) {
    let match = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j] !== searchLines[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }

  // Fuzzy: trim leading/trailing whitespace for comparison
  for (let i = start; i <= contentLines.length - searchLines.length; i++) {
    let match = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j].trim()) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }

  return -1;
}

export function applyPatch(content: string, patch: FilePatch): string {
  if (patch.action === "create") {
    return patch.chunks.map((c) => c.replaceLines.join("\n")).join("\n");
  }

  if (patch.action === "delete") {
    return "";
  }

  const lines = content.split("\n");
  let offset = 0;

  for (const chunk of patch.chunks) {
    const idx = fuzzyIndexOf(lines, chunk.searchLines, offset);
    if (idx === -1) {
      throw new Error(
        `Patch failed: could not find search block starting with "${chunk.searchLines[0]}"`,
      );
    }

    lines.splice(idx, chunk.searchLines.length, ...chunk.replaceLines);
    offset = idx + chunk.replaceLines.length;
  }

  return lines.join("\n");
}

export async function applyPatches(
  patches: FilePatch[],
): Promise<{ applied: string[]; failed: string[] }> {
  const applied: string[] = [];
  const failed: string[] = [];

  for (const patch of patches) {
    try {
      if (patch.action === "delete") {
        const { unlink } = await import("node:fs/promises");
        if (existsSync(patch.filePath)) {
          await unlink(patch.filePath);
        }
        applied.push(patch.filePath);
        continue;
      }

      if (patch.action === "create") {
        const result = applyPatch("", patch);
        await Bun.write(patch.filePath, result);
        applied.push(patch.filePath);
        continue;
      }

      // modify
      const file = Bun.file(patch.filePath);
      const content = await file.text();
      const result = applyPatch(content, patch);
      await Bun.write(patch.filePath, result);
      applied.push(patch.filePath);
    } catch {
      failed.push(patch.filePath);
    }
  }

  return { applied, failed };
}
