#!/usr/bin/env node
/**
 * todoRunner.js — Scheduled TODO execution runner (PM2-managed).
 *
 * Runs daily at 23:40.
 * 1. Target selection: today's TODO file; if it has no pending items (or is
 *    missing), scans the last CATCHUP_LOOKBACK_DAYS for the most recent file
 *    with leftovers, so a failed run is never orphaned by a date rollover.
 * 2. Spawns `qwen` with default instructions + execution prompt, logs output.
 * 3. Final verification: re-reads the file, counts remaining pending item
 *    headers, logs them, and records the outcome (exit code, duration,
 *    pending before/after, error line) in todo_runner_state.json.
 * 4. Triggers FocusMemory auto-ingest on completion.
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
const CATCHUP_LOOKBACK_DAYS = 3; // scan this many past days for leftover items
const STATE_FILE = path.join(FOCUSMEMORY_DIR, "todo_runner_state.json");

// ─── Default instructions (injected into every execution prompt) ───

const DEFAULT_INSTRUCTIONS = `CRITICAL INSTRUCTIONS:
- Do NOT commit, push, or deploy. All changes will be reviewed by the user next morning.
- Process items sequentially, one at a time. Do NOT use parallel sub-agents.
- Progress tracking: Handle ONE item at a time. On start, update its \`##\` header checkbox \`[ ]\` → \`[~]\` (in progress). On completion, update to \`[x]\` and add a 1-2 line result summary below the item. If interrupted or partially done, mark \`[!]\` with "last completed step / remaining steps" so the next run can resume exactly where it left off. For large items, update internal checkboxes (Steps) at each stage.
- Workspace: /opt/homebrew/var/www
- This file is a TODO record. Execute items in order from top to bottom.
- Verification: DDL/data changes ONLY to local DB (127.0.0.1). All functional verification in local environment (127.0.0.1:3000 + headless). Production DB/server is READ-ONLY (zero access).`;

// ─── Helpers ──────────────────────────────────────────────────────

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
 * Local date string (YYYY-MM-DD), shifted back by N days.
 * @param {number} [daysAgo=0]
 * @returns {string}
 */
function dateStr(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Top-level item headers that are not completed: "## [ ]", "## [~]", "## [!]".
 * Inner step checkboxes are ignored — the item header is the contract.
 * @param {string} content
 * @returns {string[]} matching header lines
 */
function listPendingHeaders(content) {
  return content.match(/^## \[(?: |~|!)\].*$/gm) || [];
}

/**
 * Pick the TODO file to process: today's file if it has pending items,
 * otherwise the most recent past file within CATCHUP_LOOKBACK_DAYS with
 * leftovers (a failed run must not be orphaned by a date rollover).
 * @returns {{file: string, date: string, isCatchup: boolean} | null}
 */
function findTargetFile() {
  for (let i = 0; i <= CATCHUP_LOOKBACK_DAYS; i++) {
    const date = dateStr(i);
    const file = path.join(TODOS_DIR, `${date}.md`);
    if (!fs.existsSync(file)) continue;
    const pending = listPendingHeaders(fs.readFileSync(file, "utf-8"));
    if (pending.length > 0) {
      return { file, date, isCatchup: i > 0 };
    }
  }
  return null;
}

/**
 * Pull the most relevant error line from a run log.
 * @param {string} logPath
 * @returns {string} error line, or "" if none found
 */
function extractError(logPath) {
  try {
    const log = fs.readFileSync(logPath, "utf-8");
    const apiErrors = log.match(/\[?API Error:[^\n]*/g);
    if (apiErrors && apiErrors.length > 0) {
      return apiErrors[apiErrors.length - 1].trim();
    }
    const spawnErr = log.match(/=== spawn error: [^\n]*/);
    if (spawnErr) return spawnErr[0].trim();
  } catch {
    // log file missing — no extractable error
  }
  return "";
}

/**
 * Record the run outcome for error tracking (last run + rolling 30).
 * @param {object} record
 * @returns {void}
 */
function saveState(record) {
  let state = { consecutiveFailures: 0, history: [] };
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    // first run — start fresh
  }
  state.consecutiveFailures =
    record.exitCode !== 0 ? (state.consecutiveFailures || 0) + 1 : 0;
  state.lastRun = record;
  state.history = [...(state.history || []), record].slice(-30);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Spawn a child process and wait for it to finish.
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} logPath
 * @param {string} [cwd]
 * @param {object} [env]
 * @returns {Promise<number>} exit code
 */
function runProcess(cmd, args, logPath, cwd, env) {
  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n=== ${cmd} ${args.join(" ")} ===\n`);

    const child = spawn(cmd, args, {
      cwd: cwd || WORKSPACE,
      env: env || process.env,
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

/**
 * Execute the TODO run: pick target file, spawn qwen, auto-ingest,
 * then verify completion and record the outcome.
 * @param {string} [trigger="schedule"] "schedule" | "manual"
 * @returns {Promise<void>}
 */
async function runTodo(trigger = "schedule") {
  const target = findTargetFile();
  const logPath = target ? path.join(LOG_DIR, `todo-${target.date}.log`) : null;

  ensureLogDir();

  if (!target) {
    log(`No pending items in today's file or the last ${CATCHUP_LOOKBACK_DAYS} days. Nothing to do.`);
    return;
  }

  const { file: todoFile, date, isCatchup } = target;
  const startedAt = Date.now();

  log(
    `--- Todo runner triggered for ${date} ` +
      `(${isCatchup ? "CATCH-UP from earlier file" : "daily"}, trigger: ${trigger}) ---`
  );

  const pendingBefore = listPendingHeaders(fs.readFileSync(todoFile, "utf-8"));

  const prompt = `${DEFAULT_INSTRUCTIONS}

Read the TODO file: ${todoFile}${
    isCatchup
      ? ` (carry-over from ${date} — resume exactly where it left off)`
      : " (today's TODO file)"
  }
Execute the pending items (marked [ ], [~] or [!]) from top to bottom, one at a time.
After each item, update its checkbox and record a 1-2 line summary in the file.`;

  // Build env for qwen: ensure PATH and project dir are explicit
  const qwenEnv = {
    ...process.env,
    PATH: `/opt/homebrew/bin:${path.join(process.env.HOME, ".local", "bin")}:${process.env.PATH || "/usr/bin:/bin"}`.split(":").filter(Boolean).join(":"),
    QWEN_CODE_PROJECT_DIR: path.join(process.env.HOME, ".qwen", "projects", "-opt-homebrew-var-www"),
  };

  log(`Spawning qwen execution...`);
  const code = await runProcess(
    QWEN_BIN,
    ["-p", prompt],
    logPath,
    WORKSPACE,
    qwenEnv,
  );
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

  // ── Final verification: did the run actually finish the work? ──
  let pendingAfter = null;
  try {
    pendingAfter = listPendingHeaders(fs.readFileSync(todoFile, "utf-8"));
  } catch {
    log("Final check: TODO file missing after run — cannot verify.");
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const error = code !== 0 ? extractError(logPath) : "";

  if (pendingAfter !== null) {
    if (pendingAfter.length === 0) {
      log(
        `Final check: ALL items completed ` +
          `(was ${pendingBefore.length} pending, ${durationSec}s)`
      );
    } else {
      log(
        `Final check: ${pendingBefore.length} → ${pendingAfter.length} pending ` +
          `(${durationSec}s). Remaining:`
      );
      for (const header of pendingAfter) {
        log(`  ${header.trim()}`);
      }
    }
  }
  if (code !== 0) {
    log(
      `ERROR: qwen failed (exit ${code})${error ? ` — ${error}` : ""}. ` +
        `Leftover items will be picked up by the next run.`
    );
  }

  saveState({
    at: new Date().toISOString(),
    trigger,
    file: path.relative(WORKSPACE, todoFile),
    date,
    catchup: isCatchup,
    exitCode: code,
    durationSec,
    pendingBefore: pendingBefore.length,
    pendingAfter: pendingAfter === null ? null : pendingAfter.length,
    remaining:
      pendingAfter === null ? ["<file missing>"] : pendingAfter.map((h) => h.trim()),
    error,
  });
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

// Dry run: resolve target + pending items, print, exit (no qwen, no state write)
if (process.argv.includes("--dry-run")) {
  const target = findTargetFile();
  if (!target) {
    log("Dry run: no pending items in today's file or the lookback window.");
    process.exit(0);
  }
  const pending = listPendingHeaders(fs.readFileSync(target.file, "utf-8"));
  log(`Dry run: target=${target.date} (catchup=${target.isCatchup}), pending=${pending.length}`);
  for (const header of pending) {
    log(`  ${header.trim()}`);
  }
  process.exit(0);
}

// Support manual trigger: `node todoRunner.js --now`
if (process.argv.includes("--now")) {
  log("Manual trigger (--now)");
  runTodo("manual")
    .catch((err) => log(`Error: ${err.message}`))
    .finally(() => scheduleNext());
} else {
  scheduleNext();
}
