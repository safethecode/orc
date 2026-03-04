/** @jsxImportSource @opentui/react */

export function App() {
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text bold fg="#7aa2f7">orc</text>
        <text fg="#565f89"> loading...</text>
      </box>
    </box>
  );
}
