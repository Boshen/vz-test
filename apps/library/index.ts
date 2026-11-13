import { nanoid } from "nanoid";
export function makeRecord(value: number) {
  return { id: nanoid(), squared: value * value };
}
export async function description() {
  return (await import("./description.ts")).description;
}
