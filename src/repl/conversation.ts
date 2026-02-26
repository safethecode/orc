import type { ConversationTurn } from "../config/types.ts";

export class Conversation {
  private turns: ConversationTurn[] = [];
  private language: string | undefined;

  setLanguage(lang: string): void {
    this.language = lang;
  }

  getLanguage(): string | undefined {
    return this.language;
  }

  add(turn: ConversationTurn): void {
    this.turns.push(turn);
  }

  buildContext(maxTurns: number = 10): string {
    const recent = this.turns.slice(-maxTurns);
    if (recent.length === 0) return "";

    return recent
      .map((t) => {
        const prefix = t.role === "user" ? "User" : `Assistant (${t.agentName ?? "unknown"})`;
        return `${prefix}: ${t.content}`;
      })
      .join("\n\n");
  }

  buildPrompt(userInput: string, maxTurns: number = 10): string {
    const context = this.buildContext(maxTurns);
    if (!context) return userInput;

    return `Previous conversation:\n${context}\n\nUser: ${userInput}`;
  }

  get length(): number {
    return this.turns.length;
  }

  clear(): void {
    this.turns = [];
  }

  lastAssistant(): ConversationTurn | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === "assistant") return this.turns[i];
    }
    return undefined;
  }
}
