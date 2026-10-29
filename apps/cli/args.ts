export function parsePlanSteps(rest: string[]): string[] {
  return rest.map((step) => step.trim()).filter((step) => step.length > 0);
}

export function parseIntendArgs(rest: string[]): { purpose: string; final: boolean; step?: number } {
  let final = false;
  let step: number | undefined;
  const parts: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index] ?? "";
    if (part === "--final") {
      final = true;
      continue;
    }
    if (part === "--step") {
      const raw = rest[index + 1];
      index += 1;
      const value = Number(raw);
      if (!raw || !Number.isInteger(value) || value < 1) throw new Error("步骤必须是从 1 开始的整数");
      step = value;
      continue;
    }
    parts.push(part);
  }
  return { purpose: parts.join(" ").trim(), final, ...(step == null ? {} : { step }) };
}
