/**
 * run.js — Entry point for Railway
 * Runs the BCB-informed scalping bot every 60 seconds with auto-restart.
 */

import { spawn } from "child_process";

const BOTS = [
  { name: "SCALPER", file: "bot.js" },
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
    console.log(`[${bot.name}] Exited (code ${code}) — restarting in 60s...`);
    setTimeout(() => start(bot), 60_000);
  });

  proc.on("error", (err) => {
    console.error(`[${bot.name}] Spawn error: ${err.message} — restarting in 60s...`);
    setTimeout(() => start(bot), 60_000);
  });
}

console.log("═══════════════════════════════════════════════════════════");
console.log("  Railway — Combined Bot Runner");
console.log(`  ${new Date().toISOString()}`);
console.log("═══════════════════════════════════════════════════════════\n");

BOTS.forEach(start);

// Keep the parent process alive
setInterval(() => {}, 60_000);
