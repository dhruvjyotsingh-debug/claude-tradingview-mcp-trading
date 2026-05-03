/**
 * run.js — Combined entry point for Railway
 * Spawns BCB bot and Scalper as independent child processes.
 * Each has its own logs, crash recovery, and state — they can't interfere.
 */

import { spawn } from "child_process";

const BOTS = [
  { name: "BCB",     file: "bot.js" },
  { name: "SCALPER", file: "scalper.js" },
];

function start(bot) {
  console.log(`[${bot.name}] Starting ${bot.file}...`);

  const proc = spawn("node", [bot.file], { stdio: "pipe" });

  proc.stdout.on("data", (d) =>
    process.stdout.write(d.toString().replace(/^/gm, `[${bot.name}] `))
  );
  proc.stderr.on("data", (d) =>
    process.stderr.write(d.toString().replace(/^/gm, `[${bot.name}] `))
  );

  proc.on("exit", (code) => {
    console.log(`[${bot.name}] Exited (code ${code}) — restarting in 10s...`);
    setTimeout(() => start(bot), 10_000);
  });

  proc.on("error", (err) => {
    console.error(`[${bot.name}] Spawn error: ${err.message} — restarting in 10s...`);
    setTimeout(() => start(bot), 10_000);
  });
}

console.log("═══════════════════════════════════════════════════════════");
console.log("  Railway — Combined Bot Runner");
console.log(`  ${new Date().toISOString()}`);
console.log("═══════════════════════════════════════════════════════════\n");

BOTS.forEach(start);

// Keep the parent process alive
setInterval(() => {}, 60_000);
