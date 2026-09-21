// prompts/ — the soft-layer data (提示词 = 数据, physically separated from code so it
// can be versioned and swapped independently). Loaded once at module import.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

export const SYSTEM_PROMPT = readFileSync(join(dir, "cortex.system.md"), "utf-8").trim();
export const EXTRACT_FACT_PROMPT = readFileSync(join(dir, "evolve.extract_fact.md"), "utf-8").trim();
export const REFLECT_PROMPT = readFileSync(join(dir, "evolve.reflect.md"), "utf-8").trim();
