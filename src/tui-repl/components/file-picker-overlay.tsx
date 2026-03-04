/** @jsxImportSource @opentui/react */

interface FileMatch {
  path: string;
  name: string;
}

interface Props {
  matches: FileMatch[];
  selected: number;
  visible: boolean;
}

export function FilePickerOverlay({ matches, selected, visible }: Props) {
  if (!visible || matches.length === 0) return null;

  const display = matches.slice(0, 6);

  return (
    <box flexDirection="column" height={display.length}>
      {display.map((file, i) => {
        const isSelected = i === selected;
        return (
          <box key={file.path} flexDirection="row">
            <text fg={isSelected ? "#7aa2f7" : "#565f89"} bold={isSelected}>
              {isSelected ? "▸ " : "  "}
            </text>
            <text fg={isSelected ? "#c0caf5" : "#565f89"}>{file.name}</text>
            <text fg="#414868" dim>{`  ${file.path}`}</text>
          </box>
        );
      })}
    </box>
  );
}
