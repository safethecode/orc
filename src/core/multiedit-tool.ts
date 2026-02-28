export interface EditOp {
  oldString: string;
  newString: string;
}

export interface EditResult {
  filePath: string;
  applied: number;
  failed: number;
  errors: string[];
}

/**
 * MultiEdit Tool — performs multiple sequential edit operations on a single
 * file in one call. Each edit replaces the first occurrence of `oldString`
 * with `newString`, operating on the content produced by all preceding edits.
 */
export class MultiEditTool {
  constructor() {}

  /** Apply multiple edits to a file sequentially */
  async applyEdits(filePath: string, edits: EditOp[]): Promise<EditResult> {
    const result: EditResult = { filePath, applied: 0, failed: 0, errors: [] };

    if (edits.length === 0) {
      result.errors.push("No edits provided");
      return result;
    }

    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) {
      result.failed = edits.length;
      result.errors.push(`File not found: ${filePath}`);
      return result;
    }

    let content = await file.text();

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];

      if (edit.oldString === edit.newString) {
        result.failed++;
        result.errors.push(`Edit ${i}: oldString and newString are identical`);
        continue;
      }

      const idx = content.indexOf(edit.oldString);
      if (idx === -1) {
        result.failed++;
        result.errors.push(
          `Edit ${i}: oldString not found in current content`,
        );
        continue;
      }

      content =
        content.slice(0, idx) +
        edit.newString +
        content.slice(idx + edit.oldString.length);
      result.applied++;
    }

    if (result.applied > 0) {
      await Bun.write(filePath, content);
    }

    return result;
  }

  /** Validate edits before applying (dry-run) */
  async validate(
    filePath: string,
    edits: EditOp[],
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (edits.length === 0) {
      return { valid: false, errors: ["No edits provided"] };
    }

    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) {
      return { valid: false, errors: [`File not found: ${filePath}`] };
    }

    let content = await file.text();

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];

      if (edit.oldString === edit.newString) {
        errors.push(`Edit ${i}: oldString and newString are identical`);
        continue;
      }

      const idx = content.indexOf(edit.oldString);
      if (idx === -1) {
        errors.push(`Edit ${i}: oldString not found in current content`);
        continue;
      }

      // Simulate the replacement so subsequent edits see updated content
      content =
        content.slice(0, idx) +
        edit.newString +
        content.slice(idx + edit.oldString.length);
    }

    return { valid: errors.length === 0, errors };
  }

  /** Format result for display */
  formatResult(result: EditResult): string {
    const status = result.failed === 0 ? "OK" : "PARTIAL";
    const parts = [
      `MultiEdit ${status}: ${result.applied} applied, ${result.failed} failed`,
      `  File: ${result.filePath}`,
    ];

    for (const err of result.errors) {
      parts.push(`  Error: ${err}`);
    }

    return parts.join("\n");
  }
}
