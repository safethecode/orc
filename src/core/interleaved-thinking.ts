export interface ThinkingBlock {
  content: string;
  startedAt: number;
  completedAt?: number;
  tokens?: number;
}

export type ContentType = "text" | "thinking";

export interface ParsedChunk {
  type: ContentType;
  content: string;
}

const THINKING_OPEN = /<(?:thinking|reasoning)>/;
const THINKING_CLOSE = /<\/(?:thinking|reasoning)>/;

export class InterleavedThinkingParser {
  private currentBlock: ThinkingBlock | null = null;
  private blocks: ThinkingBlock[] = [];
  private totalThinkingTokens = 0;
  private inThinking = false;
  private buffer = "";

  constructor() {}

  parse(delta: string): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    let remaining = this.buffer + delta;
    this.buffer = "";

    while (remaining.length > 0) {
      if (this.inThinking) {
        const closeMatch = remaining.match(THINKING_CLOSE);
        if (closeMatch && closeMatch.index !== undefined) {
          // Content before the closing tag is thinking
          const thinkingContent = remaining.slice(0, closeMatch.index);
          if (thinkingContent) {
            this.appendThinking(thinkingContent);
            chunks.push({ type: "thinking", content: thinkingContent });
          }
          this.endThinking();
          remaining = remaining.slice(
            closeMatch.index + closeMatch[0].length,
          );
        } else {
          // Check for partial closing tag at end of buffer
          const partialClose = this.findPartialTag(remaining);
          if (partialClose !== -1) {
            const safe = remaining.slice(0, partialClose);
            if (safe) {
              this.appendThinking(safe);
              chunks.push({ type: "thinking", content: safe });
            }
            this.buffer = remaining.slice(partialClose);
            remaining = "";
          } else {
            // All remaining is thinking content
            this.appendThinking(remaining);
            chunks.push({ type: "thinking", content: remaining });
            remaining = "";
          }
        }
      } else {
        const openMatch = remaining.match(THINKING_OPEN);
        if (openMatch && openMatch.index !== undefined) {
          // Content before the opening tag is text
          const textContent = remaining.slice(0, openMatch.index);
          if (textContent) {
            chunks.push({ type: "text", content: textContent });
          }
          this.startThinking();
          remaining = remaining.slice(
            openMatch.index + openMatch[0].length,
          );
        } else {
          // Check for partial opening tag at end of buffer
          const partialOpen = this.findPartialTag(remaining);
          if (partialOpen !== -1) {
            const safe = remaining.slice(0, partialOpen);
            if (safe) {
              chunks.push({ type: "text", content: safe });
            }
            this.buffer = remaining.slice(partialOpen);
            remaining = "";
          } else {
            // All remaining is text
            chunks.push({ type: "text", content: remaining });
            remaining = "";
          }
        }
      }
    }

    return chunks;
  }

  /**
   * Find a partial tag at the end of the string.
   * Returns the index where the partial tag starts, or -1 if none found.
   */
  private findPartialTag(str: string): number {
    // Check for partial matches of <thinking>, </thinking>, <reasoning>, </reasoning>
    const tags = [
      "<thinking>",
      "</thinking>",
      "<reasoning>",
      "</reasoning>",
    ];
    for (let i = 1; i < Math.min(str.length, 13); i++) {
      const tail = str.slice(str.length - i);
      for (const tag of tags) {
        if (tag.startsWith(tail)) {
          return str.length - i;
        }
      }
    }
    return -1;
  }

  private appendThinking(content: string): void {
    if (this.currentBlock) {
      this.currentBlock.content += content;
    }
  }

  startThinking(): void {
    this.inThinking = true;
    this.currentBlock = {
      content: "",
      startedAt: Date.now(),
    };
  }

  endThinking(): void {
    if (this.currentBlock) {
      this.currentBlock.completedAt = Date.now();
      // Rough token estimate: ~4 chars per token
      this.currentBlock.tokens = Math.ceil(
        this.currentBlock.content.length / 4,
      );
      this.totalThinkingTokens += this.currentBlock.tokens;
      this.blocks.push(this.currentBlock);
      this.currentBlock = null;
    }
    this.inThinking = false;
  }

  addThinkingContent(content: string): void {
    if (!this.inThinking) {
      this.startThinking();
    }
    if (this.currentBlock) {
      this.currentBlock.content += content;
    }
  }

  addTextContent(content: string): ParsedChunk {
    return { type: "text", content };
  }

  getBlocks(): ThinkingBlock[] {
    return [...this.blocks];
  }

  getTotalThinkingTokens(): number {
    return this.totalThinkingTokens;
  }

  isThinking(): boolean {
    return this.inThinking;
  }

  reset(): void {
    this.currentBlock = null;
    this.blocks = [];
    this.totalThinkingTokens = 0;
    this.inThinking = false;
    this.buffer = "";
  }

  static formatThinking(content: string): string {
    return `\x1b[2m${content}\x1b[0m`;
  }
}
