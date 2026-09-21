// plugins/ — registry of loaded plugins + runtime dynamic load/unload of external Cordis
// plugins (import an npm package, mount it on the container, unmount it).
import { Context, Service } from "cordis";
import type { Plugin, Fiber } from "cordis";
import type { PluginInfo } from "../types.js";

export class PluginsService extends Service {
  private loaded = new Map<string, PluginInfo["source"]>();
  private fibers = new Map<string, Fiber>();

  constructor(ctx: Context) {
    super(ctx, "plugins");
  }

  register(name: string, source: PluginInfo["source"] = "core"): void {
    this.loaded.set(name, source);
  }

  list(): PluginInfo[] {
    return [...this.loaded.entries()].map(([name, source]) => ({ name, loaded: true, source }));
  }

  // Dynamic load: import an npm package and mount its Cordis plugin at runtime.
  async load(name: string): Promise<boolean> {
    // Reject re-loading an already-mounted plugin (a second mount would leak the first fiber).
    if (this.fibers.has(name) || this.loaded.has(name)) return false;
    try {
      const mod = await import(name);
      const plugin = ((mod as { default?: Plugin.Object }).default ?? mod) as Plugin.Object;
      if (typeof plugin !== "object" || typeof plugin.apply !== "function") return false;
      const fiber = await this.ctx.plugin(plugin);
      this.fibers.set(name, fiber);
      this.loaded.set(name, "external");
      return true;
    } catch {
      return false;
    }
  }

  // Unload a dynamically-loaded plugin by name (dispose its fiber).
  async unload(name: string): Promise<boolean> {
    const fiber = this.fibers.get(name);
    if (!fiber) return false;
    try {
      await fiber.dispose();
      this.fibers.delete(name);
      this.loaded.delete(name);
      return true;
    } catch {
      return false;
    }
  }
}

export const corePlugins: Plugin.Object = {
  name: "core-plugins",
  apply(ctx: Context) {
    new PluginsService(ctx);
  },
};
