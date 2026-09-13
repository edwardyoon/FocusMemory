// FocusMemory garbage collection — time-based retention for unbounded
// accumulators. Whitelist approach: ONLY the two targets below are ever
// touched. Decisions (work_memory type=decision/bug_resolved), decision_chains,
// graph_* and code_chunks are NEVER age-pruned — causal-chain integrity and
// code-index freshness are managed elsewhere (recency decay, file-existence
// sync).
//
//   Phase A — todos/YYYY-MM-DD.md older than GC_TODOS_RETENTION_DAYS are
//             MOVED (not deleted; todos/ is not under version control) to
//             GC_ARCHIVE_DIR/YYYY-MM/. The archive dir lives outside TODOS_DIR
//             so autoIngest never re-indexes it; autoIngest's deleted-file
//             detection drops the Meilisearch doc on the next cycle.
//   Phase B — work_memory points with type=state_checkpoint and
//             timestamp < cutoff are deleted by explicit ID list (narrow
//             filter + ID delete; no broad filter delete against work_memory).
//
// Usage:
//   node garbageCollect.js            # live run (requires GC_ENABLED=on)
//   node garbageCollect.js --dry-run  # report only, nothing is changed
// Scheduled daily via config/com.focusmemory.gc.plist (launchd).

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "path";
import fs from "fs/promises";
import { QdrantClient } from "@qdrant/js-client-rest";

dotenv.config({
  override: true,
  quiet: true,
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"),
});

const TODOS_DIR = process.env.TODOS_DIR || path.join(process.cwd(), "..", "todos");
const GC_ARCHIVE_DIR =
  process.env.GC_ARCHIVE_DIR || path.join(path.dirname(TODOS_DIR), "todos_archive");
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const GC_LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "logs", "gc.log");

const LOCK_FILE = "/tmp/focusmemory-gc.lock";
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Parse a positive integer from an env value, falling back to a default.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function daysToNumber(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Log one line to stdout and append it to logs/gc.log. Best-effort:
 * a log failure never fails the GC run.
 * @param {string} line
 * @returns {Promise<void>}
 */
async function gcLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    await fs.mkdir(path.dirname(GC_LOG_FILE), { recursive: true });
    await fs.appendFile(GC_LOG_FILE, stamped + "\n");
  } catch {}
}

/**
 * Acquire the GC lock (same pattern as autoIngest.js): a stale lock whose
 * PID is dead is taken over; a live lock makes this run exit quietly.
 * @returns {Promise<void>}
 */
async function acquireLock() {
  try {
    const existing = await fs.readFile(LOCK_FILE, "utf-8").catch(() => null);
    if (existing) {
      const { pid, ts } = JSON.parse(existing);
      if (Date.now() - ts < LOCK_STALE_MS) {
        try {
          process.kill(pid, 0);
          console.error(`[lock] Another GC is running (PID ${pid}). Exiting.`);
          process.exit(0);
        } catch {
          // PID dead — stale lock, proceed
        }
      }
    }
    await fs.writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch {
    // Lock file write failed — proceed without lock (fail-open)
  }
}

/**
 * Release the GC lock. Best-effort.
 * @returns {Promise<void>}
 */
async function releaseLock() {
  try {
    await fs.unlink(LOCK_FILE);
  } catch {}
}

/**
 * Local-time YYYY-MM-DD string N days before today (ISO dates compare
 * correctly lexicographically, so string comparison is the date comparison).
 * @param {number} days
 * @returns {string}
 */
function cutoffDateString(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Phase A — archive todo files older than the retention window.
 * @param {number} retentionDays
 * @returns {Promise<{archived: string[], skipped: number}>} archived file
 *   names (non-matching entries are counted in `skipped`, never touched)
 */
async function gcTodos(retentionDays) {
  const archived = [];
  let skipped = 0;
  let entries;
  try {
    entries = await fs.readdir(TODOS_DIR);
  } catch {
    return { archived, skipped };
  }
  const cutoffStr = cutoffDateString(retentionDays);
  for (const name of entries) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) {
      skipped++;
      continue;
    }
    const dateStr = m[1];
    if (dateStr >= cutoffStr) continue;
    const src = path.join(TODOS_DIR, name);
    const monthDir = path.join(GC_ARCHIVE_DIR, dateStr.slice(0, 7));
    try {
      if (!DRY_RUN) {
        await fs.mkdir(monthDir, { recursive: true });
        await fs.rename(src, path.join(monthDir, name));
      }
      archived.push(name);
    } catch (err) {
      console.error(`  ✗ todos: ${name} — ${err.message}`);
    }
  }
  return { archived, skipped };
}

/**
 * Phase B — delete work_memory state_checkpoint points older than the
 * retention window. Only point IDs collected under the narrow
 * (type=state_checkpoint AND timestamp < cutoff) filter are deleted.
 * @param {QdrantClient} qdrant
 * @param {number} retentionDays
 * @returns {Promise<number>} number of points deleted (0 in dry-run means
 *   none matched; the matched count is reported either way)
 */
async function gcCheckpoints(qdrant, retentionDays) {
  const cutoffISO = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const ids = [];
  let offset = null;
  do {
    const req = {
      filter: {
        must: [
          { key: "type", match: { value: "state_checkpoint" } },
          { key: "timestamp", range: { lt: cutoffISO } },
        ],
      },
      limit: 1000,
      with_payload: false,
    };
    if (offset) req.offset = offset;
    const res = await qdrant.scroll("work_memory", req);
    for (const p of res.points) ids.push(p.id);
    offset = res.next_page_offset ?? null;
  } while (offset);

  if (ids.length === 0) return 0;
  if (!DRY_RUN) {
    for (let i = 0; i < ids.length; i += 500) {
      await qdrant.delete("work_memory", { wait: true, points: ids.slice(i, i + 500) });
    }
  }
  return ids.length;
}

/**
 * GC entry point: runs Phase A (todos archive) and Phase B (checkpoint
 * retention) when GC_ENABLED=on, logging a one-line summary to gc.log.
 * @returns {Promise<void>}
 */
async function main() {
  const enabled = (process.env.GC_ENABLED || "off").toLowerCase() === "on";
  console.log("=== FocusMemory GC ===");
  console.log(`[mode] ${DRY_RUN ? "DRY-RUN" : "live"}`);
  if (!enabled) {
    console.log("[skip] GC_ENABLED is not 'on' — nothing to do");
    return;
  }

  await acquireLock();
  const todosDays = daysToNumber(process.env.GC_TODOS_RETENTION_DAYS, 30);
  const checkpointDays = daysToNumber(process.env.GC_CHECKPOINT_RETENTION_DAYS, 30);
  console.log(
    `[config] todos retention ${todosDays}d, checkpoint retention ${checkpointDays}d, archive ${GC_ARCHIVE_DIR}`
  );

  try {
    // ── Phase A: todos retention ─────────────────────────────────
    console.log(`--- Phase A: todos retention (${todosDays}d) ---`);
    const { archived, skipped } = await gcTodos(todosDays);
    console.log(
      `  ${DRY_RUN ? "would archive" : "archived"} ${archived.length} todo file(s) [skipped ${skipped} non-date file(s)]`
    );
    for (const name of archived) {
      console.log(`  [archive] ${name} → ${GC_ARCHIVE_DIR}/${name.slice(0, 7)}/`);
    }

    // ── Phase B: state_checkpoint retention ──────────────────────
    console.log(`--- Phase B: state_checkpoint retention (${checkpointDays}d) ---`);
    const qdrant = new QdrantClient({ url: QDRANT_URL });
    let removed = 0;
    try {
      removed = await gcCheckpoints(qdrant, checkpointDays);
    } catch (err) {
      console.error(`  ✗ checkpoint GC failed (Qdrant unreachable?): ${err.message}`);
    }
    console.log(`  ${DRY_RUN ? "would delete" : "deleted"} ${removed} state_checkpoint point(s)`);

    await gcLog(
      `gc ${DRY_RUN ? "dry-run" : "run"} todos_archived=${archived.length} checkpoints_removed=${removed}`
    );
    console.log("=== Done ===");
  } finally {
    await releaseLock();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  releaseLock();
  process.exit(1);
});
