#!/usr/bin/env node
/**
 * todoRunner.js — Scheduled TODO execution runner (PM2-managed).
 *
 * Runs daily at 23:40. Checks for today's TODO file in todos/,
 * spawns `qwen` with default instructions + execution prompt,
 * logs output, and triggers FocusMemory auto-ingest on completion.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, "..");
const TODOS_DIR = path.join(WORKSPACE, "todos");
const LOG_DIR = path.join(WORKSPACE, "logs");
const QWEN_BIN = "/opt/homebrew/bin/qwen";
const FOCUSMEMORY_DIR = __dirname;

// ─── Default instructions (injected into every execution prompt) ───

const DEFAULT_INSTRUCTIONS = `CRITICAL INSTRUCTIONS:
- Do NOT commit, push, or deploy. All changes will be reviewed by the user next morning.
- Process items sequentially, one at a time. Do NOT use parallel sub-agents.
- Progress tracking: Handle ONE item at a time. On start, update its \`##\` header checkbox \`[ ]\` → \`[~]\` (in progress). On completion, update to \`[x]\` and add a 1-2 line result summary below the item. If interrupted or partially done, mark \`[!]\` with "last completed step / remaining steps" so the next run can resume exactly where it left off. For large items, update internal checkboxes (Steps) at each stage.
- Workspace: /opt/homebrew/var/www
- This file is a TODO record. Execute items in order from top to bottom.
- Verification: DDL/data changes ONLY to local DB (127.0.0.1). All functional verification in local environment (127.0.0.1:3000 + headless). Production DB/server is READ-ONLY (zero access).`;

// ─── Helpers ──────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Spawn a child process and wait for it to finish.
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} logPath
 * @param {string} [cwd]
 * @returns {Promise<number>} exit code
 */
function runProcess(cmd, args, logPath, cwd) {
  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n=== ${cmd} ${args.join(" ")} ===\n`);

    const child = spawn(cmd, args, {
      cwd: cwd || WORKSPACE,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      logStream.write(chunk);
    });
    child.on("close", (code) => {
      logStream.end(`\n=== exit code: ${code} ===\n`);
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      logStream.write(`\n=== spawn error: ${err.message} ===\n`);
      logStream.end();
      resolve(1);
    });
  });
}

// ─── Main execution ───────────────────────────────────────────────

async function runTodo() {
  const today = todayStr();
  const todoFile = path.join(TODOS_DIR, `${today}.md`);
  const logPath = path.join(LOG_DIR, `todo-${today}.log`);

  ensureLogDir();

  log(`--- Todo runner triggered for ${today} ---`);

  if (!fs.existsSync(todoFile)) {
    log(`No TODO file found: ${todoFile}. Exiting.`);
    return;
  }

  const content = fs.readFileSync(todoFile, "utf-8");
  const hasPending = /\[ \]/.test(content) || /\[~\]/.test(content);

  if (!hasPending) {
    log(`No pending items in ${today}.md (no [ ] or [~] found). Exiting.`);
    return;
  }

  const prompt = `${DEFAULT_INSTRUCTIONS}

Read today's TODO file: ${todoFile}
Execute the pending items (marked [ ] or [~]) from top to bottom, one at a time.
After each item, update its checkbox and record a 1-2 line summary in the file.`;

  log(`Spawning qwen execution...`);
  const code = await runProcess(QWEN_BIN, ["-p", prompt, "-y"], logPath);
  log(`qwen exited with code ${code}`);

  // Trigger auto-ingest to update FocusMemory index
  log("Triggering auto-ingest...");
  const ingestCode = await runProcess(
    "node",
    ["autoIngest.js"],
    logPath,
    FOCUSMEMORY_DIR,
  );
  log(`auto-ingest exited with code ${ingestCode}`);
}

// ─── Scheduler ────────────────────────────────────────────────────

const SCHEDULE_HOUR = 23;
const SCHEDULE_MINUTE = 40;

function nextRunDate() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(SCHEDULE_HOUR, SCHEDULE_MINUTE, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function scheduleNext() {
  const next = nextRunDate();
  const delay = next.getTime() - Date.now();
  log(`Next run scheduled: ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`);

  setTimeout(async () => {
    try {
      await runTodo();
    } catch (err) {
      log(`Error: ${err.message}`);
    }
    scheduleNext();
  }, delay);
}

// ─── Startup ──────────────────────────────────────────────────────

log(`todoRunner started (PID ${process.pid})`);
log(`TODOS_DIR: ${TODOS_DIR}`);
log(`Log directory: ${LOG_DIR}`);

// Support manual trigger: `node todoRunner.js --now`
if (process.argv.includes("--now")) {
  log("Manual trigger (--now)");
  runTodo()
    .catch((err) => log(`Error: ${err.message}`))
    .finally(() => scheduleNext());
} else {
  scheduleNext();
}
