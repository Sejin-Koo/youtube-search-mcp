// 실제 API 키로 모든 도구를 MCP 프로토콜 그대로(인메모리 전송) 호출하는 스모크 테스트.
//   YOUTUBE_API_KEY=... node smoke.mjs [도구명 ...]
// 할당량을 쓰므로(검색 1페이지 = 100유닛) 필요한 도구만 골라 돌릴 수 있다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./lib/server.js";

const server = buildServer();
const client = new Client({ name: "smoke", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);

const only = new Set(process.argv.slice(2));
let totalUnits = 0;

async function call(name, args, check) {
  if (only.size && !only.has(name) && !only.has(`${name}:${check?.name || ""}`)) return null;
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || "";
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 오류 문구 */
  }
  const units = body?.요약?.추정사용유닛 ?? body?.추정사용유닛 ?? 0;
  totalUnits += units;
  const verdict = check ? check(body, text, r) : !r.isError;
  console.log(`${verdict ? "✅" : "❌"} ${name} ${JSON.stringify(args).slice(0, 120)} (${Date.now() - t0}ms, ${units}u)`);
  console.log("   ", text.slice(0, 600).replace(/\n/g, " "));
  return body;
}

const tools = await client.listTools();
console.log("도구:", tools.tools.map((t) => t.name).join(", "));

await call("youtube_quota_info", {}, (b) => b && b.서버.YOUTUBE_API_KEY_설정됨 === true);

// 정상 경로
await call("youtube_get_channels", { handle: "@YouTube" }, (b) => b?.채널?.length === 1);
await call("youtube_get_videos", { video_ids: "dQw4w9WgXcQ, https://youtu.be/jNQXAC9IVRw, AAAAAAAAAAA" }, (b) => b?.요약?.조회됨 === 2 && b.조회안된ID.length === 1);
await call("youtube_search_videos", { queries: ["포니링크", "젬백스링크"], max_per_query: "50", include_stats: "true" }, (b) => b?.요약?.합산영상수_중복제거 > 0);
await call("youtube_search_channels", { query: "퓨처링크", max_results: 3, include_stats: true }, (b) => Array.isArray(b?.채널));
await call("youtube_list_channel_videos", { handle: "@YouTube", max_scan: 60 }, (b) => b?.영상?.length > 0 && b.요약.잘림 === true);
await call("youtube_list_channel_videos", { handle: "@YouTube", published_after: "2026-01-01" }, (b) => b?.영상?.length >= 0 && b.요약);
await call("youtube_trending_videos", { region: "KR", max_results: 5 }, (b) => b?.영상?.length === 5);
await call("youtube_get_comments", { video_id: "jNQXAC9IVRw", max_threads: 30, order: "relevance" }, (b) => b?.요약?.수집원댓글수 > 0);

// 안내 경로
await call("youtube_search_videos", { queries: ["a", "b", "c", "d", "e", "f", "g"], max_per_query: 500 }, (b) => b?.실행안함 === true);
await call("youtube_get_channels", { handle: "@this-handle-should-not-exist-zz9x" }, (b) => b?.요약?.건수 === 0);
await call("youtube_get_videos", { video_ids: [] }, (b, t, r) => r.isError === true);
await call("youtube_get_comments", { video_id: "AAAAAAAAAAA" }, (b, t, r) => r.isError === true && /찾을 수 없습니다/.test(t));

console.log(`\n이번 스모크 추정 사용 유닛 합계: ${totalUnits}`);
process.exit(0);
