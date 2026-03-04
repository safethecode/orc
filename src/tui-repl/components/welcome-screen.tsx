/** @jsxImportSource @opentui/react */
import type { MessageMeta } from "../store.ts";

interface Props {
  profiles: string;
  meta?: MessageMeta;
}

export function WelcomeScreen({ profiles, meta }: Props) {
  const names = profiles.split(", ").filter(Boolean);
  const version = meta?.version ?? "0.1.0";
  const cwd = meta?.cwd ?? process.cwd();
  const defaultTier = meta?.defaultTier ?? "haiku";
  const mcpServers = meta?.mcpServers ?? [];
  const formatters = meta?.formatters ?? [];

  // Shorten path: ~/... for home directory
  const home = process.env.HOME ?? "";
  const shortCwd = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

  return (
    <box
      border
      borderStyle="rounded"
      borderColor="#3d4262"
      title={` orc v${version} `}
      titleAlignment="left"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row">
        {/* Left column: logo + model + project */}
        <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1} paddingLeft={1}>
          <asciifont text="orc" font="slick" color="#bb9af7" />
          <box paddingTop={1} flexDirection="row" gap={1}>
            <text fg="#9ece6a">{defaultTier}</text>
            <text fg="#565f89">{"·"}</text>
            <text fg="#7dcfff">{names[0] ?? "default"}</text>
          </box>
          <text fg="#565f89">{shortCwd}</text>
          {mcpServers.length > 0 && (
            <box flexDirection="row" gap={1} paddingTop={1}>
              <text fg="#9ece6a">{"\uD83D\uDD0C"}</text>
              <text fg="#565f89">{mcpServers.join(", ")}</text>
            </box>
          )}
          {formatters.length > 0 && (
            <box flexDirection="row" gap={1}>
              <text fg="#7dcfff">{"\uD83D\uDCE6"}</text>
              <text fg="#565f89">{formatters.join(", ")}</text>
            </box>
          )}
        </box>

        {/* Vertical divider */}
        <box width={1} paddingTop={1} paddingBottom={1}>
          <text fg="#3d4262">{"│"}</text>
        </box>

        {/* Right column: tips + agents */}
        <box flexDirection="column" width={30} paddingTop={1} paddingBottom={1} paddingLeft={2}>
          <text fg="#c0caf5" bold>Getting started</text>
          <text fg="#565f89">type naturally or <text fg="#bb9af7">/help</text></text>
          <box border={["top"]} borderColor="#3d4262" />
          <text fg="#c0caf5" bold>Agents</text>
          <text fg="#7dcfff">{names.length > 4 ? names.slice(0, 4).join(", ") + ", ..." : names.join(", ")}</text>
        </box>
      </box>
    </box>
  );
}
