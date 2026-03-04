/** @jsxImportSource @opentui/react */
import { useState, useRef, useEffect } from "react";
import { FileRefResolver } from "../../repl/file-ref.ts";
import { COMMANDS } from "../../repl/commands.ts";
import { FilePickerOverlay } from "./file-picker-overlay.tsx";

interface Props {
  onSubmit: (text: string) => void;
}

interface FileMatch {
  path: string;
  name: string;
}

interface PickerState {
  active: boolean;
  atIndex: number;
  matches: FileMatch[];
  selected: number;
}

interface CmdHintState {
  active: boolean;
  matches: string[];
  selected: number;
}

const EMPTY_PICKER: PickerState = { active: false, atIndex: 0, matches: [], selected: 0 };
const EMPTY_HINT: CmdHintState = { active: false, matches: [], selected: 0 };

export function InputArea({ onSubmit }: Props) {
  const textareaRef = useRef<any>(null);
  const fileRef = useRef(new FileRefResolver(process.cwd()));

  const [picker, setPicker] = useState<PickerState>(EMPTY_PICKER);
  const pickerRef = useRef<PickerState>(EMPTY_PICKER);
  pickerRef.current = picker;

  const [cmdHint, setCmdHint] = useState<CmdHintState>(EMPTY_HINT);
  const cmdHintRef = useRef<CmdHintState>(EMPTY_HINT);
  cmdHintRef.current = cmdHint;

  // Warm file cache
  useEffect(() => {
    fileRef.current.warmCache().catch(() => {});
  }, []);

  // Wire submit + content change + cursor change + key interceptor
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;

    // Submit
    ta.onSubmit = () => {
      const text = (ta.plainText ?? "").trim();
      if (!text) return;

      // If command hint active and Tab was used to fill, don't submit
      // (Tab fills command, Enter submits — this is the normal flow)
      onSubmit(text);
      ta.setText("");
      setPicker(EMPTY_PICKER);
      setCmdHint(EMPTY_HINT);
    };

    // Content change → detect @ trigger and / hints
    ta.onContentChange = () => {
      const text = ta.plainText ?? "";
      const cursor = ta.cursorOffset;

      // ── / Command hints ──
      if (text.startsWith("/")) {
        const hits = COMMANDS.filter((c) => c.startsWith(text.trimEnd()));
        if (hits.length > 0 && text.trimEnd() !== hits[0]) {
          setCmdHint({ active: true, matches: hits.slice(0, 8), selected: 0 });
        } else {
          setCmdHint(EMPTY_HINT);
        }
        // Don't show file picker when typing commands
        if (pickerRef.current.active) setPicker(EMPTY_PICKER);
        return;
      }
      setCmdHint(EMPTY_HINT);

      // ── @ File picker ──
      const beforeCursor = text.slice(0, cursor);
      const lastAt = beforeCursor.lastIndexOf("@");

      if (lastAt >= 0 && (lastAt === 0 || /\s/.test(text[lastAt - 1]))) {
        const query = text.slice(lastAt + 1, cursor);
        if (!/\s/.test(query)) {
          const results = fileRef.current.searchSync(query, 6);
          setPicker({
            active: true,
            atIndex: lastAt,
            matches: results.map((m) => ({ path: m.path, name: m.name })),
            selected: 0,
          });
          return;
        }
      }

      // No trigger → close picker
      if (pickerRef.current.active) setPicker(EMPTY_PICKER);
    };

    // Cursor change → dismiss picker if cursor leaves @ range
    ta.onCursorChange = () => {
      const pk = pickerRef.current;
      if (!pk.active) return;
      const cursor = ta.cursorOffset;
      const text = ta.plainText ?? "";
      if (cursor <= pk.atIndex || text[pk.atIndex] !== "@") {
        setPicker(EMPTY_PICKER);
      }
    };

    // Key interceptor — intercept Tab/Up/Down/Escape when picker or hint active
    const origHandleKeyPress = ta.__origHandleKeyPress ?? ta.handleKeyPress.bind(ta);
    if (!ta.__origHandleKeyPress) ta.__origHandleKeyPress = origHandleKeyPress;

    ta.handleKeyPress = (key: any) => {
      const pk = pickerRef.current;
      const ch = cmdHintRef.current;

      // ── File picker keys ──
      if (pk.active && pk.matches.length > 0) {
        if (key.name === "tab") {
          const text = ta.plainText ?? "";
          const cursor = ta.cursorOffset;
          const before = text.slice(0, pk.atIndex);
          const after = text.slice(cursor);
          const selected = pk.matches[pk.selected];
          if (selected) {
            const replacement = `@${selected.path} `;
            const newText = before + replacement + after;
            ta.setText(newText);
            ta.cursorOffset = before.length + replacement.length;
          }
          setPicker(EMPTY_PICKER);
          key.preventDefault?.();
          return true;
        }
        if (key.name === "up") {
          setPicker((prev) => ({
            ...prev,
            selected: ((prev.selected - 1) + prev.matches.length) % prev.matches.length,
          }));
          key.preventDefault?.();
          return true;
        }
        if (key.name === "down") {
          setPicker((prev) => ({
            ...prev,
            selected: (prev.selected + 1) % prev.matches.length,
          }));
          key.preventDefault?.();
          return true;
        }
        if (key.name === "escape") {
          setPicker(EMPTY_PICKER);
          key.preventDefault?.();
          return true;
        }
      }

      // ── Command hint keys ──
      if (ch.active && ch.matches.length > 0) {
        if (key.name === "tab") {
          const selected = ch.matches[ch.selected];
          if (selected) {
            ta.setText(selected + " ");
            ta.cursorOffset = selected.length + 1;
          }
          setCmdHint(EMPTY_HINT);
          key.preventDefault?.();
          return true;
        }
        if (key.name === "up") {
          setCmdHint((prev) => ({
            ...prev,
            selected: ((prev.selected - 1) + prev.matches.length) % prev.matches.length,
          }));
          key.preventDefault?.();
          return true;
        }
        if (key.name === "down") {
          setCmdHint((prev) => ({
            ...prev,
            selected: (prev.selected + 1) % prev.matches.length,
          }));
          key.preventDefault?.();
          return true;
        }
        if (key.name === "escape") {
          setCmdHint(EMPTY_HINT);
          key.preventDefault?.();
          return true;
        }
      }

      return origHandleKeyPress(key);
    };
  }, [onSubmit]);

  return (
    <box flexShrink={0} flexDirection="column">
      {/* File picker overlay */}
      <FilePickerOverlay
        matches={picker.matches}
        selected={picker.selected}
        visible={picker.active}
      />
      {/* Command hint overlay */}
      {cmdHint.active && cmdHint.matches.length > 0 && (
        <box flexDirection="row" paddingLeft={2}>
          {cmdHint.matches.map((cmd, i) => {
            const isSelected = i === cmdHint.selected;
            return (
              <text
                key={cmd}
                fg={isSelected ? "#7aa2f7" : "#565f89"}
                bold={isSelected}
              >
                {cmd + "  "}
              </text>
            );
          })}
        </box>
      )}
      {/* Input row */}
      <box flexDirection="row" maxHeight={6}>
        <text fg="#bb9af7" bold>{"❯ "}</text>
        <textarea
          ref={textareaRef}
          wrapMode="word"
          maxHeight={6}
          placeholder="Type a message..."
          flexGrow={1}
          focused
          keyBindings={[
            { name: "enter", action: "submit" },
            { name: "enter", shift: true, action: "newline" },
          ]}
        />
      </box>
    </box>
  );
}
