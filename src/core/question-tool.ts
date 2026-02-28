import { EventEmitter } from "node:events";

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface Question {
  id: string;
  text: string;
  options: QuestionOption[];
  multiSelect: boolean;
  defaultValue?: string;
  timeoutMs: number;
  askedAt: string;
}

export interface QuestionResult {
  questionId: string;
  answer: string | string[];
  answeredAt: string;
  timedOut: boolean;
}

export class QuestionManager extends EventEmitter {
  private pendingQuestions = new Map<
    string,
    { question: Question; resolve: (result: QuestionResult) => void }
  >();
  private defaultTimeoutMs = 300_000; // 5 minutes

  constructor() {
    super();
  }

  async ask(
    text: string,
    options: QuestionOption[],
    opts?: { multiSelect?: boolean; timeoutMs?: number; defaultValue?: string },
  ): Promise<QuestionResult> {
    const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;

    const question: Question = {
      id,
      text,
      options,
      multiSelect: opts?.multiSelect ?? false,
      defaultValue: opts?.defaultValue,
      timeoutMs,
      askedAt: new Date().toISOString(),
    };

    return new Promise<QuestionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingQuestions.has(id)) return;
        this.pendingQuestions.delete(id);

        const fallback = question.defaultValue ?? options[0]?.value ?? "";
        const result: QuestionResult = {
          questionId: id,
          answer: question.multiSelect ? [fallback] : fallback,
          answeredAt: new Date().toISOString(),
          timedOut: true,
        };

        this.emit("question:timeout", question);
        resolve(result);
      }, timeoutMs);

      this.pendingQuestions.set(id, {
        question,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });

      this.emit("question:ask", question);
    });
  }

  reply(questionId: string, answer: string | string[]): boolean {
    const entry = this.pendingQuestions.get(questionId);
    if (!entry) return false;

    this.pendingQuestions.delete(questionId);

    const result: QuestionResult = {
      questionId,
      answer,
      answeredAt: new Date().toISOString(),
      timedOut: false,
    };

    entry.resolve(result);
    this.emit("question:reply", result);
    return true;
  }

  hasPending(): boolean {
    return this.pendingQuestions.size > 0;
  }

  getPending(): Question[] {
    return [...this.pendingQuestions.values()].map((e) => e.question);
  }

  cancel(questionId: string): void {
    const entry = this.pendingQuestions.get(questionId);
    if (!entry) return;

    this.pendingQuestions.delete(questionId);

    const result: QuestionResult = {
      questionId,
      answer: entry.question.multiSelect ? [] : "",
      answeredAt: new Date().toISOString(),
      timedOut: false,
    };

    entry.resolve(result);
    this.emit("question:cancel", entry.question);
  }
}
