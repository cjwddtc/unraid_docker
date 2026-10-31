import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ROOT = "/data/runtime";
const INBOX = `${ROOT}/voice-control`;
const read = (path: string): any => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } };
const atomic = (path: string, value: any) => { writeFileSync(path + ".tmp", JSON.stringify(value)); renameSync(path + ".tmp", path); };

export default function(pi: ExtensionAPI) {
  mkdirSync(INBOX, { recursive: true });
  let ctx: ExtensionContext | undefined;
  let phase = "idle";
  let connectedAt = 0;
  let chain = Promise.resolve();
  let closing = false;
  let alive = true;
  const log = (event: string) => appendFileSync("/data/voice-policy.log", `${new Date().toISOString()} ${event}\n`);
  const state = () => atomic(`${ROOT}/voice-state.json`, { phase, updated: Date.now()/1000, idleSeconds: 60 });
  state();
  async function control(action: string, text?: string) {
    if (!ctx || !alive) throw new Error("Pi session is not ready");
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      let off: () => void = () => {};
      const timeout = setTimeout(() => { off(); reject(new Error("Live control timed out")); }, 45000);
      off = pi.events.on(`pi-voice:reply:${id}`, (result: any) => {
        clearTimeout(timeout); off();
        result?.ok ? resolve() : reject(new Error(result?.error ?? "Live control failed"));
      });
      pi.events.emit("pi-voice:control", { id, action, text });
    });
  }
  function queue(action: string, text?: string) {
    chain = chain.then(async () => {
      if (!alive) return;
      log(`control-${action}`);
      await control(action, text);
      log(`ready-${action}`);
      if (action === "start") {
        const cue = spawn("paplay", ["/data/ready.wav"], { stdio: "ignore" });
        cue.on("error", () => log("ready-cue-error"));
        cue.on("exit", code => log(`ready-cue-exit-${code}`));
      }
    }).catch((error) => {
      log(`error-${action}: ${String(error).slice(0,250)}`);
      ctx?.ui.notify(`Voice: ${String(error).slice(0,250)}`, "warning");
    });
    return chain;
  }
  pi.on("session_start", (_event, context) => { ctx = context; });
  const offState = pi.events.on("pi-voice:state", (event: any) => {
    const previous = phase;
    phase = event.phase;
    if (phase === "listening" && ["connecting", "idle", "paused", "error"].includes(previous)) connectedAt = Date.now()/1000;
    state();
  });
  const offNotify = pi.events.on("pi-voice:notify", (event: any) => {
    const text = String(event?.text ?? "").trim();
    if (text) void queue("announce", text.slice(0,16000));
  });
  // This command is also a human-visible control/status entry point.
  pi.registerCommand("voice-auto", {
    description: "Wakeword 你好助手: on, off, status, start, pause; idle timeout is 60 seconds",
    handler: async (args, context) => {
      ctx = context;
      const arg = args.trim();
      if (arg === "on") writeFileSync("/data/wake-enabled", "");
      if (arg === "off") {
        for (const path of ["/data/wake-enabled", "/data/vad-enabled"]) if (existsSync(path)) unlinkSync(path);
        await queue("pause");
      }
      if (arg === "start" || arg === "pause") await queue(arg);
      context.ui.notify(JSON.stringify({ phase, vad: read(`${ROOT}/vad-state.json`), timeoutSeconds: 60 }), "info");
    },
  });
  const timer = setInterval(() => {
    if (!ctx || !alive) return;
    for (const file of readdirSync(INBOX).filter(x => x.endsWith(".json"))) {
      const path = `${INBOX}/${file}`;
      const item = read(path);
      unlinkSync(path);
      if (Date.now()/1000 - Number(item.created ?? 0) > 120) { log("stale-request-dropped"); continue; }
      if (item.action === "start" && (
        (item.source === "wakeword" && existsSync("/data/wake-enabled")) ||
        (item.source === "vad" && existsSync("/data/vad-enabled"))
      )) void queue("start");
      if (item.action === "announce" && typeof item.text === "string") void queue("announce", item.text.slice(0,16000));
      if (item.action === "pause") void queue("pause");
    }
    const vad = read(`${ROOT}/vad-state.json`);
    const lastHuman = Math.max(Number(vad.lastVoice ?? 0), connectedAt);
    if (["listening", "muted"].includes(phase) && lastHuman && Date.now()/1000-lastHuman >= 60 && !closing) {
      closing = true;
      void queue("pause").finally(() => { closing = false; });
    }
  }, 200);
  pi.on("session_shutdown", () => { alive=false; clearInterval(timer); offNotify(); offState(); phase="idle"; state(); });
}
