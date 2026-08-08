# FocusMemory Work Memory MCP Server

MCP 서버로, 작업 이력/결정 기록, 문서 검색, 코드 그래프 탐색을 제공합니다.

## 아키텍처

| 기능 | 백엔드 | 저장소 |
|------|--------|--------|
| 작업 이력 & 결정 (work_memory) | Qdrant 벡터 검색 | `work_memory` 컬렉션 |
| 결정 인과 연쇄 (decision_chains) | Qdrant 벡터 + 체인 탐색 | `decision_chains` 컬렉션 |
| 코드 시맨틱 검색 (code_chunks) | Qdrant 벡터 검색 | `code_chunks` 컬렉션 |
| 코드 그래프 (graph_nodes/edges) | Qdrant payload 키워드 검색 | `graph_nodes`, `graph_edges` |
| 문서 & 계획 텍스트 검색 | Meilisearch 풀텍스트 검색 | `docs_plans` 인덱스 |

## 설치

```bash
cd work-memory-mcp
npm install
```

## 환경 설정

`.env.example`을 복사하고 값을 수정합니다:

```bash
cp .env.example .env
```

필수 변수:
- `QDRANT_URL` — Qdrant 서버 주소 (예: `http://127.0.0.1:6333`)
- `BGE_URL` — BGE-M3 임베딩 서버 주소
- `MEILI_HOST` / `MEILI_MASTER_KEY` — Meilisearch 설정

선택 변수:
- `SUMMARY_LLM_URL` / `SUMMARY_LLM_MODEL` — 경량 LLM (prune & summarize용, 없으면 graceful fallback)
- `GRAPH_ROOT` — 코드 그래프/코드 시맨틱 검색 대상 루트 디렉토리
- `DOCS_DIR` / `PLANS_DIR` — 문서 및 계획 파일 위치

## Qdrant 컬렉션 생성

```bash
npm run create-collections
```

`work_memory`, `graph_nodes`, `graph_edges`, `code_chunks`, `decision_chains` 컬렉션과 payload 인덱스를 생성합니다.

## 초기 데이터 수집

```bash
# 첫 실행: 모든 파일 강제 수집
npm run auto-ingest --force

# 이후 실행: 변경된 파일만 증분 수집 (mtime 기반)
npm run auto-ingest
```

`autoIngest.js`는 다음을 처리합니다:
1. `docs/`, `plans/` 하위 `.md` 파일을 스캔하여 Meilisearch에 업서트
2. 삭제된 파일은 Meilisearch에서 제거
3. 코드 시맨틱 검색용 code_chunks를 Qdrant에 색인

정기 실행 (cron 예시):
```bash
*/5 * * * * cd /path/to/work-memory-mcp && npm run auto-ingest
```

## MCP 서버 실행

```bash
npm start
```

Qwen Code의 `settings.json`에서 MCP 서버로 등록합니다:

```json
{
  "mcpServers": {
    "focus-memory": {
      "command": "node",
      "args": ["index.js"],
      "cwd": "/path/to/work-memory-mcp"
    }
  }
}
```

## MCP 도구

| 도구 | 설명 |
|------|------|
| `search_memory` | **통합 검색** — scoring 기반 라우팅으로 work_memory, graph, decision_chains + Meilisearch 병렬 탐색 |
| `search_work_memory` | 작업 이력/결정 검색 (Meilisearch plans + Qdrant work_memory) |
| `search_project_facts` | 문서 텍스트 검색 (Meilisearch docs) |
| `remember_decision` | 결정 기록. work_memory + decision_chains에 저장, 자동 대체 감지 |
| `trace_decision_chain` | 주제의 결정 연쇄 체인 추적 |

## 코드 그래프 빌드

```bash
# 전체 그래프 재빌드
npm run build-graph

# 코드 시맨틱 색인 (증분)
npm run index-chunks
npm run index-chunks -- --force    # 강제 전량 재색인
```

## 프로젝트 초기화

새 프로젝트에 docs/plans 디렉토리와 `.focusmemoryignore`를 생성:

```bash
node init.js /path/to/your/project
```
