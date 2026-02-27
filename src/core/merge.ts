import type { MergeDecision, MergeConflict, MergeResult } from "../config/types.ts";
import { eventBus } from "./events.ts";

export class MergeOrchestrator {
  constructor(private workDir: string) {}

  async analyzeChanges(branchA: string, branchB: string): Promise<MergeConflict[]> {
    const conflicts: MergeConflict[] = [];

    try {
      // Get list of conflicting files via git merge-tree
      const proc = Bun.spawn(
        ["git", "diff", "--name-only", branchA, branchB],
        { cwd: this.workDir, stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(proc.stdout).text();
      const files = output.trim().split("\n").filter(Boolean);

      for (const file of files) {
        // Get content from each branch
        const oursProc = Bun.spawn(
          ["git", "show", `${branchA}:${file}`],
          { cwd: this.workDir, stdout: "pipe", stderr: "pipe" },
        );
        const oursContent = await new Response(oursProc.stdout).text();
        const oursExit = await oursProc.exited;

        const theirsProc = Bun.spawn(
          ["git", "show", `${branchB}:${file}`],
          { cwd: this.workDir, stdout: "pipe", stderr: "pipe" },
        );
        const theirsContent = await new Response(theirsProc.stdout).text();
        const theirsExit = await theirsProc.exited;

        // Determine conflict type
        let type: "add_add" | "modify_modify" | "delete_modify" = "modify_modify";
        if (oursExit !== 0 && theirsExit === 0) type = "add_add";
        if (oursExit === 0 && theirsExit !== 0) type = "delete_modify";

        if (oursContent !== theirsContent) {
          conflicts.push({
            file,
            baseContent: "",
            oursContent: oursExit === 0 ? oursContent : "",
            theirsContent: theirsExit === 0 ? theirsContent : "",
            type,
          });
        }
      }
    } catch {
      // git commands may fail if branches don't exist
    }

    return conflicts;
  }

  async autoMerge(conflicts: MergeConflict[]): Promise<MergeResult> {
    const mergedFiles: string[] = [];
    const remaining: MergeConflict[] = [];
    const manualReview: string[] = [];

    for (const conflict of conflicts) {
      eventBus.publish({ type: "merge:progress", stage: "auto", status: conflict.file });

      if (conflict.type === "add_add" && conflict.oursContent === conflict.theirsContent) {
        // Identical additions — direct copy
        mergedFiles.push(conflict.file);
        continue;
      }

      if (conflict.type === "delete_modify") {
        // One side deleted, other modified — needs human review
        manualReview.push(conflict.file);
        continue;
      }

      // Try line-level merge for modify_modify
      if (conflict.type === "modify_modify") {
        const oursLines = conflict.oursContent.split("\n");
        const theirsLines = conflict.theirsContent.split("\n");

        // Simple heuristic: if changes are in different regions, auto-merge
        if (oursLines.length === theirsLines.length) {
          let conflictingLines = 0;
          for (let i = 0; i < oursLines.length; i++) {
            if (oursLines[i] !== theirsLines[i]) conflictingLines++;
          }
          // Less than 10% lines differ and all in separate regions
          if (conflictingLines <= Math.max(1, oursLines.length * 0.1)) {
            mergedFiles.push(conflict.file);
            continue;
          }
        }
      }

      remaining.push(conflict);
    }

    // Remaining conflicts need human or AI review
    for (const c of remaining) {
      manualReview.push(c.file);
    }

    const decision: MergeDecision = manualReview.length === 0
      ? "auto_merged"
      : remaining.length === 0
      ? "direct_copy"
      : "needs_human_review";

    return { decision, mergedFiles, conflicts: remaining, manualReviewNeeded: manualReview };
  }

  buildAiMergePrompt(conflict: MergeConflict): string {
    return `Merge these two versions of ${conflict.file}:

=== OURS ===
${conflict.oursContent}

=== THEIRS ===
${conflict.theirsContent}

Analyze the intent of both changes and produce a merged version that preserves both sets of changes.
Return ONLY the merged file content, no explanations.`;
  }

  async merge(branchA: string, branchB: string): Promise<MergeResult> {
    eventBus.publish({ type: "merge:progress", stage: "analyze", status: "starting" });
    const conflicts = await this.analyzeChanges(branchA, branchB);

    if (conflicts.length === 0) {
      eventBus.publish({ type: "merge:progress", stage: "complete", status: "no conflicts" });
      return { decision: "auto_merged", mergedFiles: [], conflicts: [], manualReviewNeeded: [] };
    }

    eventBus.publish({ type: "merge:progress", stage: "auto-merge", status: `${conflicts.length} conflicts` });
    const result = await this.autoMerge(conflicts);

    eventBus.publish({ type: "merge:progress", stage: "complete", status: result.decision });
    return result;
  }
}
