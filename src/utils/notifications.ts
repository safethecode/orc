export function notify(message: string): void {
  process.stdout.write(`\x1b]9;${message}\x07`);
}

export function bell(): void {
  process.stdout.write("\x07");
}
