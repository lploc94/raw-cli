export function safeTerminalText(value: string): string {
  return value.replace(/\x1b/g, "␛").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (character) =>
    `^${String.fromCharCode(character.charCodeAt(0) ^ 64)}`);
}
