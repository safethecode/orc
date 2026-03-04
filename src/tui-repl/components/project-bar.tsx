/** @jsxImportSource @opentui/react */
import { useState, useEffect } from "react";
import { useStore } from "../store.ts";

function getGitInfo(): { branch: string; dirty: boolean } | null {
  try {
    const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
    const status = Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString().trim();
    if (!branch) return null;
    return { branch, dirty: status.length > 0 };
  } catch {
    return null;
  }
}

function getClaudeMdCount(): number {
  try {
    const { existsSync } = require("fs");
    let count = 0;
    if (existsSync("CLAUDE.md")) count++;
    return count;
  } catch {
    return 0;
  }
}

export function ProjectBar() {
  const { state } = useStore();
  const [git, setGit] = useState<{ branch: string; dirty: boolean } | null>(null);
  const [claudeMd, setClaudeMd] = useState(0);

  useEffect(() => {
    setGit(getGitInfo());
    setClaudeMd(getClaudeMdCount());
  }, []);

  const projectName = (process.cwd().split("/").pop() ?? "project");
  const tier = state.status.tier ?? "haiku";

  return (
    <box height={1} flexShrink={0} border={["top"]} borderColor="#3d4262" flexDirection="row" paddingLeft={1}>
      <text fg="#565f89">{projectName}</text>
      {git && (
        <box flexDirection="row">
          <text fg="#565f89">{" git:("}</text>
          <text fg="#9ece6a">{git.branch}</text>
          <text fg="#e0af68">{git.dirty ? "*" : ""}</text>
          <text fg="#565f89">{")"}</text>
        </box>
      )}
      {claudeMd > 0 && (
        <box flexDirection="row">
          <text fg="#565f89">{" │ "}</text>
          <text fg="#565f89">{`${claudeMd} CLAUDE.md`}</text>
        </box>
      )}
      <box flexDirection="row">
        <text fg="#565f89">{" │ "}</text>
        <text fg="#565f89">{`${tier} default`}</text>
      </box>
      <box flexGrow={1} />
    </box>
  );
}
