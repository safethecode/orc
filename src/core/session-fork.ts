import type { ConversationTurn } from "../config/types.ts";

export interface SessionBranch {
  id: string;
  parentId: string | null;
  forkPoint: number;
  label: string;
  turns: ConversationTurn[];
  createdAt: string;
}

export class SessionForkManager {
  private branches: Map<string, SessionBranch> = new Map();
  private activeBranchId: string;

  constructor() {
    const mainId = crypto.randomUUID();
    this.branches.set(mainId, {
      id: mainId,
      parentId: null,
      forkPoint: 0,
      label: "main",
      turns: [],
      createdAt: new Date().toISOString(),
    });
    this.activeBranchId = mainId;
  }

  fork(atIndex: number, label?: string): SessionBranch {
    const currentBranch = this.getActive();
    const clampedIndex = Math.min(atIndex, currentBranch.turns.length);

    // Copy turns up to (and including) the fork point
    const copiedTurns = currentBranch.turns
      .slice(0, clampedIndex)
      .map((t) => ({ ...t }));

    const newId = crypto.randomUUID();
    const branchCount = this.branches.size;
    const newBranch: SessionBranch = {
      id: newId,
      parentId: currentBranch.id,
      forkPoint: clampedIndex,
      label: label ?? `branch-${branchCount}`,
      turns: copiedTurns,
      createdAt: new Date().toISOString(),
    };

    this.branches.set(newId, newBranch);
    this.activeBranchId = newId;

    return newBranch;
  }

  switchTo(branchId: string): SessionBranch | null {
    const branch = this.branches.get(branchId);
    if (!branch) return null;
    this.activeBranchId = branchId;
    return branch;
  }

  getActive(): SessionBranch {
    return this.branches.get(this.activeBranchId)!;
  }

  addTurn(turn: ConversationTurn): void {
    const branch = this.getActive();
    branch.turns.push(turn);
  }

  listBranches(): Array<{
    id: string;
    label: string;
    forkPoint: number;
    turnCount: number;
    active: boolean;
  }> {
    const result: Array<{
      id: string;
      label: string;
      forkPoint: number;
      turnCount: number;
      active: boolean;
    }> = [];

    for (const branch of this.branches.values()) {
      result.push({
        id: branch.id,
        label: branch.label,
        forkPoint: branch.forkPoint,
        turnCount: branch.turns.length,
        active: branch.id === this.activeBranchId,
      });
    }

    return result;
  }

  deleteBranch(branchId: string): boolean {
    const branch = this.branches.get(branchId);
    if (!branch) return false;

    // Cannot delete the main branch (parentId === null)
    if (branch.parentId === null) return false;

    // Cannot delete the active branch
    if (branchId === this.activeBranchId) return false;

    // Check if any other branch has this branch as parent — prevent orphans
    for (const b of this.branches.values()) {
      if (b.parentId === branchId) return false;
    }

    this.branches.delete(branchId);
    return true;
  }

  formatTree(): string {
    // Find the root (main) branch
    const root = [...this.branches.values()].find((b) => b.parentId === null);
    if (!root) return "(empty)";

    const lines: string[] = [];
    this.buildTree(root, lines, "", "");
    return lines.join("\n");
  }

  private buildTree(
    branch: SessionBranch,
    lines: string[],
    linePrefix: string,
    continuationPrefix: string,
  ): void {
    const activeMarker = branch.id === this.activeBranchId ? " <- active" : "";
    const forkInfo =
      branch.parentId !== null
        ? `forked at #${branch.forkPoint}, `
        : "";
    lines.push(
      `${linePrefix}${branch.label} (${forkInfo}${branch.turns.length} turns)${activeMarker}`,
    );

    // Find children of this branch
    const children = [...this.branches.values()].filter(
      (b) => b.parentId === branch.id,
    );

    for (let i = 0; i < children.length; i++) {
      const isLast = i === children.length - 1;
      const connector = isLast ? "\u2514\u2500 " : "\u251C\u2500 ";
      const nextContinuation = isLast ? "   " : "\u2502  ";
      this.buildTree(
        children[i],
        lines,
        continuationPrefix + connector,
        continuationPrefix + nextContinuation,
      );
    }
  }
}
