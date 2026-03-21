import { describe, it, expect } from "bun:test";
import { createTuiRenderer } from "../tui-renderer.ts";
import type { ModelTier } from "../../config/types.ts";

describe("createTuiRenderer", () => {
  function collect() {
    const actions: any[] = [];
    const dispatch = (action: any) => actions.push(action);
    const renderer = createTuiRenderer(dispatch);
    return { actions, renderer };
  }

  it("dispatches APPEND_MESSAGE on welcome", () => {
    const { actions, renderer } = collect();
    renderer.welcome(["coder", "architect"]);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("APPEND_MESSAGE");
    expect(actions[0].message.type).toBe("welcome");
    expect(actions[0].message.content).toContain("coder");
  });

  it("dispatches STREAMING_START on startBox", () => {
    const { actions, renderer } = collect();
    renderer.startBox("sonnet" as ModelTier);
    expect(actions[0]).toEqual({ type: "STREAMING_START", tier: "sonnet" });
  });

  it("dispatches STREAMING_DELTA on text", () => {
    const { actions, renderer } = collect();
    renderer.text("hello");
    expect(actions[0]).toEqual({ type: "STREAMING_DELTA", text: "hello" });
  });

  it("dispatches STREAMING_COMMIT on endBox", () => {
    const { actions, renderer } = collect();
    renderer.endBox();
    expect(actions[0]).toEqual({ type: "STREAMING_COMMIT" });
  });

  it("dispatches STATUS_UPDATE on startSpinner", () => {
    const { actions, renderer } = collect();
    renderer.startSpinner("coder", "sonnet" as ModelTier);
    expect(actions[0].type).toBe("STATUS_UPDATE");
    expect(actions[0].partial.agentState).toBe("thinking");
    expect(actions[0].partial.agentName).toBe("coder");
  });

  it("dispatches idle on stopSpinner", () => {
    const { actions, renderer } = collect();
    renderer.stopSpinner();
    expect(actions[0].partial.agentState).toBe("idle");
  });

  it("dispatches cost update on updateCostLive", () => {
    const { actions, renderer } = collect();
    renderer.updateCostLive(0.05);
    expect(actions[0].partial.cost).toBe(0.05);
  });

  it("dispatches error message on error", () => {
    const { actions, renderer } = collect();
    renderer.error("something failed");
    expect(actions[0].message.type).toBe("error");
    expect(actions[0].message.content).toBe("something failed");
  });

  it("dispatches tool message on toolUse", () => {
    const { actions, renderer } = collect();
    renderer.toolUse("Read", "/src/index.ts", false, { file_path: "/src/index.ts" });
    expect(actions[0].type).toBe("PUSH_RECENT_TOOL");
    expect(actions[0].tool).toBe("Read index.ts");
    expect(actions[1].type).toBe("STATUS_UPDATE");
    expect(actions[2].type).toBe("APPEND_MESSAGE");
  });

  it("dispatches CLEAR on separator for visual separation", () => {
    const { actions, renderer } = collect();
    renderer.separator();
    expect(actions[0].message.type).toBe("separator");
  });
});
