#!/usr/bin/env node
// Stop hook — check if work is complete and user should record decision via remember_decision
// Uses 'ask' to let the user decide, avoiding false positives from heuristic misfires.

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qwen', 'tmp', 'tool-calls');
fs.mkdirSync(STATE_DIR, { recursive: true });

// Completion signal patterns — conservative to minimize false positives
const COMPLETION_PATTERNS = [
  /테스트.*통과|all checks?\s*pass/i,
  /버그?.*수정|bug.{0,5}fix|fixed the bug/i,
  /기능.*완성|구현 완료|feature delivered|implementation complete/i,
  /ready to commit|커밋.?해줘|commit this/i,
  /done with the changes|작업 완료|수정 완료/i,
];

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event;
  try {
    event = JSON.parse(raw);
  } catch { returnAllow(); }

  const sessionId = event.session_id;
  if (!sessionId) returnAllow();

  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  const logFile = path.join(STATE_DIR, `${sessionId}.jsonl`);

  // Read current state
  let state = {};
  try {
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch {}

  // Already recorded or user explicitly declined — skip
  if (state.decisionRecorded || state.decisionDeclined) {
    returnAllow();
  }

  // Check for code changes in tool log
  const hasCodeChange = readToolLog(logFile).some(t => ['edit', 'write_file'].includes(t.tool));

  // Check for completion signal in last assistant message
  const msg = event.last_assistant_message || '';
  const looksComplete = COMPLETION_PATTERNS.some(p => p.test(msg));

  // Conservative: both code change AND completion signal required
  if (hasCodeChange && looksComplete) {
    returnAsk();
  }

  returnAllow();
}

function readToolLog(logFile) {
  try {
    if (!fs.existsSync(logFile)) return [];
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    return lines.map(l => {
      try { return JSON.parse(l); } catch { return {}; }
    }).filter(t => t.tool);
  } catch { return []; }
}

function returnAllow() {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

function returnAsk() {
  process.stdout.write(JSON.stringify({
    decision: 'ask',
    reason: '[Hard Gate] 코드 변경과 완료 신호가 감지되었습니다.',
    stopReason: '이번 작업의 핵심 결정/수정 사항을 기억해둘까요? (예/아니오)\n"예"면 remember_decision을 호출하고, "아니오"면 넘어갑니다.'
  }));
  process.exit(0);
}

main();
