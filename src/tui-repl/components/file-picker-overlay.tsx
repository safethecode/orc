/** @jsxImportSource @opentui/react */

export interface PickerMatch {
  kind: "file" | "agent";
  path: string;
  name: string;
  role?: string;
}

interface Props {
  matches: PickerMatch[];
  selected: number;
  visible: boolean;
}

export function FilePickerOverlay({ matches, selected, visible }: Props) {
  if (!visible || matches.length === 0) return null;

  const display = matches.slice(0, 8);

  return (
    <box flexDirection="column" height={display.length}>
      {display.map((item, i) => {
        const isSelected = i === selected;
        if (item.kind === "agent") {
          return (
            <box key={`agent-${item.name}`} flexDirection="row">
              <text fg={isSelected ? "#7aa2f7" : "#565f89"} bold={isSelected}>
                {isSelected ? "▸ " : "  "}
              </text>
              <text fg={isSelected ? "#7dcfff" : "#73daca"} bold={isSelected}>
                {`@${item.name}`}
              </text>
              <text fg="#565f89" dim>{item.role ? `  ${item.role}` : "  agent"}</text>
            </box>
          );
        }
        return (
          <box key={item.path} flexDirection="row">
            <text fg={isSelected ? "#7aa2f7" : "#565f89"} bold={isSelected}>
              {isSelected ? "▸ " : "  "}
            </text>
            <text fg={isSelected ? "#c0caf5" : "#565f89"}>{item.name}</text>
            <text fg="#414868" dim>{`  ${item.path}`}</text>
          </box>
        );
      })}
    </box>
  );
}
