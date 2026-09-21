// stdio channel — a readline REPL. Proves the Life gateway with zero network.
// Reads a line: a plain line is a task (submitted to the agent); a slash command
// drives the nerve (queue) or a subagent (delegate).
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import type { Context } from "cordis";
import type { Channel } from "./types.js";
import type { Host } from "../gateway/index.js";

export class StdioChannel implements Channel {
  id = "stdio";

  async start(host: Host, _ctx?: Context): Promise<void> {
    const rl = createInterface({ input: stdin, output: stdout, prompt: "apex> " });
    console.log("Apex Agent — 努力向人一样工作 / Work like a human");
    console.log("Type a task, or a slash command (/queue, /delegate, /help, /quit).\n");
    rl.prompt();
    for await (const line of rl) {
      const text = line.trim();
      if (!text) {
        rl.prompt();
        continue;
      }
      if (text === "/quit" || text === "/q" || text === "/exit") break;
      if (text === "/help") {
        console.log("Commands:\n  /queue add <input> [--p N]   enqueue a task\n  /queue list                  list the queue\n  /queue run                   run ready tasks\n  /delegate <goal>             spawn a sub-agent\n  /quit                        exit");
        rl.prompt();
        continue;
      }
      if (text.startsWith("/queue ")) {
        await this.queue(host, text.slice(7).trim());
        rl.prompt();
        continue;
      }
      if (text.startsWith("/delegate ")) {
        try {
          console.log(await host.delegate(text.slice(10).trim()));
        } catch (e) {
          console.log(`error: ${e instanceof Error ? e.message : e}`);
        }
        rl.prompt();
        continue;
      }
      try {
        const outcome = await host.submit({ text });
        console.log(host.report(outcome));
      } catch (e) {
        console.log(`error: ${e instanceof Error ? e.message : e}`);
      }
      rl.prompt();
    }
    rl.close();
  }

  private async queue(host: Host, arg: string): Promise<void> {
    const [op, ...rest] = arg.split(/\s+/);
    if (op === "add") {
      const pIdx = rest.indexOf("--p");
      const priority = pIdx >= 0 ? Number(rest[pIdx + 1] ?? 0) : 0;
      const input = rest.slice(0, pIdx >= 0 ? pIdx : undefined).join(" ").trim();
      if (!input) return console.log("usage: /queue add <input> [--p N]");
      console.log(`queued ${host.queueAdd(input, Number.isFinite(priority) ? priority : 0)}`);
    } else if (op === "list") {
      const rows = host.queueList();
      if (rows.length === 0) return console.log("(queue empty)");
      for (const r of rows) console.log(`  ${r.id}  pri=${r.priority}  [${r.status}]  ${r.input.slice(0, 50)}`);
    } else if (op === "run") {
      const done = await host.queueRun();
      if (done.length === 0) return console.log("(no ready tasks)");
      for (const t of done) console.log(`  ${t.id}: ${t.status}`);
    } else {
      console.log("usage: /queue add|list|run");
    }
  }

  async stop(): Promise<void> {
    // stdin cannot be force-closed cleanly; the loop exits on /quit or EOF.
  }
}
