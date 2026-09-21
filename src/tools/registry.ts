// Tools service — built-in tool registry with enable/disable.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { ToolDeclaration } from "../types.js";

export class ToolsService extends Service {
  private tools = new Map<string, ToolDeclaration>();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  register(tool: ToolDeclaration): void {
    // Duplicate tool names are a silent override hazard; fail loud so collisions surface at
    // assembly time (duplicate names throw).
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): ToolDeclaration[] {
    return [...this.tools.values()].map((t) => ({ ...t }));
  }

  get(name: string): ToolDeclaration | undefined {
    return this.tools.get(name);
  }

  enable(name: string): boolean {
    const t = this.tools.get(name);
    if (!t) return false;
    t.enabled = true;
    return true;
  }

  disable(name: string): boolean {
    const t = this.tools.get(name);
    if (!t) return false;
    t.enabled = false;
    return true;
  }
}

export const coreTools: Plugin.Object = {
  name: "core-tools",
  apply(ctx: Context) {
    new ToolsService(ctx);
  },
};
