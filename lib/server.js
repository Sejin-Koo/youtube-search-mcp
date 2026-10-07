// youtube-search-mcp — 유튜브 공개 데이터 조회 MCP 서버
//
// API 키(YOUTUBE_API_KEY) 하나로 조회 가능한 공개 범위만 다룬다.
//   영상 검색 · 영상 상세 · 댓글(대댓글 전량) · 채널 검색 · 채널 상세 ·
//   채널 업로드 목록 · 인기 급상승 · 할당량 안내
// OAuth가 필요한 것(YouTube Analytics/Reporting, 자막 원문, 비공개 영상, 쓰기 작업)은 범위 밖이다.
// DB·캐시는 두지 않는다 — 여론 데이터는 필요할 때마다 다시 조회한다.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  ytGet,
  QuotaMeter,
  UNIT_COST,
  DAILY_QUOTA_DEFAULT,
  keyConfigured,
  nextQuotaResetKst,
  toKst,
  toRfc3339,
  durationSeconds,
  decodeEntities,
  extractVideoId,
  chunk,
  YouTubeApiError,
} from "./youtube.js";

export const SERVER_VERSION = "1.0.0";

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

// 응답이 크면(대댓글 수천 건 등) 들여쓰기를 빼서 크기를 30%가량 줄인다
const ok = (obj) => {
  let text = JSON.stringify(obj, null, 2);
  if (text.length > 100000) text = JSON.stringify(obj);
  return { content: [{ type: "text", text }] };
};
const fail = (e, meter) => ({
  content: [
    {
      type: "text",
      text:
        `오류: ${e && e.message ? e.message : String(e)}` +
        (meter ? `\n(이번 호출 추정 사용 유닛: ${meter.units})` : ""),
    },
  ],
  isError: true,
});

/** MCP 클라이언트가 인자를 문자열로 직렬화해 보내는 경우가 있어 number/boolean은 관대하게 받는다 */
const num = (min, max, def) => {
  let s = z.coerce.number().int();
  if (min !== undefined) s = s.min(min);
  if (max !== undefined) s = s.max(max);
  return def === undefined ? s.optional() : s.default(def);
};
const bool = (def = false) =>
  z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(def);

/** 배열 또는 JSON 배열 문자열. splitPlain=true면 쉼표·공백·줄바꿈으로 나눈 문자열도 받는다 */
const strList = ({ splitPlain }) =>
  z.union([z.array(z.string()), z.string()]).transform((v) => {
    let a;
    if (Array.isArray(v)) a = v;
    else {
      const s = v.trim();
      if (s.startsWith("[")) {
        try {
          const j = JSON.parse(s);
          if (Array.isArray(j)) a = j.map(String);
        } catch {
          /* 아래로 */
        }
      }
      if (!a) a = splitPlain ? s.split(/[\s,]+/) : s.split(/\n+/);
    }
    return a.map((x) => String(x).trim()).filter(Boolean);
  });

const toInt = (v) => (v === undefined || v === null ? null : Number(v));

/** videos.list 응답 1건을 정리한다 */
function shapeVideo(v, { includeDescription }) {
  const sn = v.snippet || {};
  const st = v.statistics || {};
  const cd = v.contentDetails || {};
  const out = {
    영상ID: v.id,
    URL: `https://www.youtube.com/watch?v=${v.id}`,
    제목: sn.title,
    채널명: sn.channelTitle,
    채널ID: sn.channelId,
    게시일시_KST: toKst(sn.publishedAt),
    길이초: durationSeconds(cd.duration),
    조회수: toInt(st.viewCount),
    좋아요: st.likeCount === undefined ? "비공개" : toInt(st.likeCount),
    댓글수: st.commentCount === undefined ? null : toInt(st.commentCount),
    // commentCount 필드가 아예 없으면 댓글 사용 중지로 본다(댓글 0개인 영상은 "0"이 온다)
    댓글사용중지: st.commentCount === undefined,
    카테고리ID: sn.categoryId,
    라이브: sn.liveBroadcastContent && sn.liveBroadcastContent !== "none" ? sn.liveBroadcastContent : v.liveStreamingDetails ? "종료된 라이브" : false,
    태그: sn.tags || [],
    기본언어: sn.defaultLanguage || sn.defaultAudioLanguage || null,
  };
  if (includeDescription) out.설명란 = sn.description || "";
  return out;
}

/** 영상ID 목록의 상세를 50건 단위로 받는다 */
async function fetchVideos(ids, meter, { includeDescription = false } = {}) {
  const found = new Map();
  for (const part of chunk([...new Set(ids)], 50)) {
    const r = await ytGet(
      "videos",
      { part: "snippet,statistics,contentDetails,liveStreamingDetails", id: part, maxResults: 50 },
      meter
    );
    for (const v of r.items || []) found.set(v.id, shapeVideo(v, { includeDescription }));
  }
  return found;
}

function shapeComment(c, ownerChannelId) {
  const s = c.snippet || {};
  const author = s.authorChannelId && s.authorChannelId.value;
  return {
    댓글ID: c.id,
    작성자: s.authorDisplayName,
    작성자채널ID: author || null,
    채널소유자: !!(author && ownerChannelId && author === ownerChannelId),
    내용: s.textOriginal ?? s.textDisplay,
    좋아요: toInt(s.likeCount),
    작성일시_KST: toKst(s.publishedAt),
    수정됨: !!(s.updatedAt && s.publishedAt && s.updatedAt !== s.publishedAt),
  };
}

/** 채널 ID·@핸들·채널 URL을 {id} 또는 {forHandle}로 정리 */
function channelLookupParams({ channel_id, handle }) {
  if (channel_id) {
    const m = String(channel_id).match(/(UC[A-Za-z0-9_-]{22})/);
    return { id: m ? m[1] : String(channel_id).trim() };
  }
  if (handle) {
    let h = String(handle).trim();
    const m = h.match(/youtube\.com\/(@[^/?#]+)/);
    if (m) h = m[1];
    h = decodeURIComponent(h);
    if (!h.startsWith("@")) h = "@" + h;
    return { forHandle: h };
  }
  return null;
}

// ── 서버 ─────────────────────────────────────────────────────────────────────

export function buildServer() {
  const server = new McpServer({ name: "youtube-search-mcp", version: SERVER_VERSION });

  // ── 1. 영상 검색 ───────────────────────────────────────────────────────────
  server.registerTool(
    "youtube_search_videos",
    {
      title: "유튜브 영상 검색 (여러 검색어 합산·중복 제거)",
      description:
        "여러 검색어로 유튜브 영상을 검색해 영상ID 기준으로 합치고, 각 영상이 어느 검색어에 걸렸는지 표시한다. " +
        "검색어 하나만으로는 크게 모자라므로 회사명·따옴표 회사명·이전 상호·영문 표기·사업 키워드 등을 함께 넣을 것. " +
        "할당량: 검색 1페이지(최대 50건)가 100유닛이다(일일 기본 10,000유닛). " +
        "예상 최대 사용량(검색어 수 × 페이지 상한 × 100)이 3,000유닛을 넘으면 allow_large=true 없이는 실행하지 않는다. " +
        "totalResults(근사치)는 실제 건수가 아니므로 건수로 쓰지 말 것 — 실제로 받은 건수만 보고한다. " +
        "검색어별로 max_per_query에서 멈췄는지(잘림)와 결과가 끝났는지를 표시한다. " +
        "특정 채널의 영상 전수는 이 도구가 아니라 youtube_list_channel_videos(1유닛)를 쓸 것. " +
        "결과는 게시일 최신순으로 정렬한다.",
      inputSchema: {
        queries: strList({ splitPlain: false }).describe(
          "검색어 배열(최대 10개). 예: [\"포니링크\", \"\\\"포니링크\\\"\", \"젬백스링크\", \"PonyLink\"]. 문자열 하나를 주면 줄바꿈 단위로 나눈다"
        ),
        published_after: z.string().optional().describe("이 시각 이후 게시. YYYY-MM-DD(한국 시간 그날 0시) 또는 RFC3339"),
        published_before: z.string().optional().describe("이 날짜까지 게시(YYYY-MM-DD면 그날 하루 포함) 또는 RFC3339"),
        order: z.enum(["relevance", "date", "viewCount", "rating", "title"]).default("relevance").describe("정렬 기준(검색 API에 전달)"),
        region: z.string().default("KR").describe("regionCode (ISO 3166-1 alpha-2). 빈 문자열이면 지정 안 함"),
        language: z.string().default("ko").describe("relevanceLanguage. 빈 문자열이면 지정 안 함"),
        duration: z.enum(["any", "short", "medium", "long"]).default("any").describe("short(4분 미만)·medium(4~20분)·long(20분 초과)"),
        channel_id: z.string().optional().describe("이 채널 안에서만 검색 (UC로 시작하는 채널ID)"),
        max_per_query: num(1, 500, 100).describe("검색어당 최대 수집 건수(기본 100). 페이지 상한은 이 값을 50으로 나눈 올림값(기본 2페이지 = 200유닛)이다 — 검색 API는 한 페이지에 50건을 다 채우지 않는 일이 잦아, 건수 대신 페이지로 할당량을 묶는다"),
        safe_search: z.enum(["none", "moderate", "strict"]).default("none").describe("기본 none — moderate(검색 API 기본값)는 일부 영상을 걸러낸다"),
        include_stats: bool(false).describe("true면 합친 영상들의 조회수·좋아요·댓글수·길이를 videos.list로 붙인다(50건당 1유닛)"),
        allow_large: bool(false).describe("예상 최대 사용량이 3,000유닛을 넘어도 실행"),
      },
    },
    async (a) => {
      const meter = new QuotaMeter();
      try {
        const queries = [...new Set(a.queries)];
        if (queries.length === 0) throw new Error("queries가 비어 있습니다.");
        if (queries.length > 10) throw new Error(`검색어는 최대 10개입니다(받은 수 ${queries.length}).`);
        const pagesPerQuery = Math.ceil(a.max_per_query / 50);
        const estMax = queries.length * pagesPerQuery * UNIT_COST.search;
        if (estMax > 3000 && !a.allow_large) {
          return ok({
            실행안함: true,
            사유: `예상 최대 사용량 ${estMax}유닛(검색어 ${queries.length}개 × ${pagesPerQuery}페이지 × 100유닛)이 3,000유닛을 넘습니다.`,
            안내: "max_per_query를 줄이거나 검색어를 나누어 호출하세요. 그대로 진행하려면 allow_large=true를 주세요.",
            일일한도: DAILY_QUOTA_DEFAULT,
          });
        }
        const publishedAfter = toRfc3339(a.published_after);
        const publishedBefore = toRfc3339(a.published_before, { endOfDay: true });

        const merged = new Map(); // videoId → record
        const perQuery = [];
        // 일일 한도(검색 호출 횟수·유닛)에 걸리면 그때까지 받은 결과를 버리지 않고 돌려준다
        const DAILY_STOP = ["dailySearchLimitExceeded", "dailyLimitPerMetric", "quotaExceeded", "dailyLimitExceeded"];
        let limitHit = null;
        for (const q of queries) {
          if (limitHit) {
            perQuery.push({ 검색어: q, 받은건수: 0, 페이지수: 0, 종료사유: "조회 안 함 — 일일 한도 도달", 잘림: true, totalResults_근사치_건수로쓰지말것: null });
            continue;
          }
          let token;
          let got = 0;
          let pages = 0;
          let totalApprox = null;
          let stop = "";
          const seenInQuery = new Set();
          while (true) {
            const want = Math.min(50, a.max_per_query - got);
            let r;
            try {
              r = await ytGet(
              "search",
              {
                part: "snippet",
                q,
                type: "video",
                maxResults: want,
                order: a.order,
                regionCode: a.region || undefined,
                relevanceLanguage: a.language || undefined,
                videoDuration: a.duration !== "any" ? a.duration : undefined,
                channelId: a.channel_id,
                publishedAfter,
                publishedBefore,
                safeSearch: a.safe_search,
                pageToken: token,
              },
              meter
            );
            } catch (e) {
              if (!DAILY_STOP.includes(e.reason)) throw e;
              limitHit = e;
              stop = "일일 한도 도달 — 중단";
              break;
            }
            pages++;
            if (totalApprox === null && r.pageInfo) totalApprox = r.pageInfo.totalResults ?? null;
            const items = r.items || [];
            for (const it of items) {
              const id = it.id && it.id.videoId;
              if (!id || seenInQuery.has(id)) continue;
              seenInQuery.add(id);
              got++;
              const sn = it.snippet || {};
              let rec = merged.get(id);
              if (!rec) {
                rec = {
                  영상ID: id,
                  URL: `https://www.youtube.com/watch?v=${id}`,
                  제목: decodeEntities(sn.title),
                  채널명: decodeEntities(sn.channelTitle),
                  채널ID: sn.channelId,
                  게시일시_KST: toKst(sn.publishedAt),
                  설명_앞부분: decodeEntities(sn.description),
                  라이브: sn.liveBroadcastContent && sn.liveBroadcastContent !== "none" ? sn.liveBroadcastContent : false,
                  걸린검색어: [],
                  _pub: sn.publishedAt || "",
                };
                merged.set(id, rec);
              }
              rec.걸린검색어.push(q);
            }
            token = r.nextPageToken;
            if (!token) {
              stop = "결과 끝(다음 페이지 없음)";
              break;
            }
            if (got >= a.max_per_query) {
              stop = "max_per_query 도달 — 더 있음";
              break;
            }
            if (pages >= pagesPerQuery) {
              stop = `페이지 상한(${pagesPerQuery}) 도달 — 더 있음`;
              break;
            }
            if (items.length === 0) {
              stop = "빈 페이지 — 중단";
              break;
            }
          }
          perQuery.push({
            검색어: q,
            받은건수: got,
            페이지수: pages,
            종료사유: stop,
            잘림: stop.includes("더 있음"),
            totalResults_근사치_건수로쓰지말것: totalApprox,
          });
        }

        let list = [...merged.values()].sort((x, y) => (y._pub > x._pub ? 1 : y._pub < x._pub ? -1 : 0));
        list.forEach((r) => delete r._pub);

        if (a.include_stats && list.length) {
          const det = await fetchVideos(list.map((r) => r.영상ID), meter);
          list = list.map((r) => {
            const d = det.get(r.영상ID);
            if (!d) return { ...r, 상세: "조회 안 됨(삭제·비공개 가능)" };
            return { ...r, 길이초: d.길이초, 조회수: d.조회수, 좋아요: d.좋아요, 댓글수: d.댓글수, 댓글사용중지: d.댓글사용중지 };
          });
        }

        const anyCut = perQuery.some((p) => p.잘림) || !!limitHit;
        return ok({
          요약: {
            검색어수: queries.length,
            합산영상수_중복제거: list.length,
            검색어별합계_중복포함: perQuery.reduce((s, p) => s + p.받은건수, 0),
            잘림: anyCut,
            ...meter.report(),
          },
          검색어별: perQuery,
          ...(limitHit ? { 한도도달: limitHit.message } : {}),
          유의사항: [
            ...(limitHit
              ? ["★ 일일 한도에 걸려 일부 검색어를 조회하지 못했다(위 '한도도달'). 아래 결과는 부분 결과이며, 초기화 전에는 재시도해도 거부된다."]
              : []),
            "합산영상수는 이번 조회에서 실제로 받은 영상 수다. totalResults는 YouTube가 주는 근사치라 건수로 쓰지 말 것.",
            anyCut
              ? "일부 검색어가 max_per_query 또는 페이지 상한에서 멈췄다(잘림). 더 받으려면 max_per_query를 올리거나 기간(published_after/before)을 나눠 다시 조회할 것."
              : "모든 검색어가 결과 끝까지 수집됐다. 단, 검색 API는 한 검색어에 줄 수 있는 결과 수에 자체 상한이 있어 '결과 끝'이 곧 전수라는 뜻은 아니다 — 기간을 나눠 재조회하면 더 나올 수 있다.",
            "제목·설명란에 검색어가 실제로 들어 있는지는 직접 확인할 것. 검색 API는 태그·자막·관련도로도 영상을 돌려준다.",
            "설명_앞부분은 검색 API가 잘라서 주는 일부다. 전문은 youtube_get_videos(include_description=true).",
          ],
          영상: list,
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 2. 영상 상세 ───────────────────────────────────────────────────────────
  server.registerTool(
    "youtube_get_videos",
    {
      title: "유튜브 영상 상세 조회",
      description:
        "영상ID(또는 영상 URL) 목록의 제목·채널·게시일·길이(초)·조회수·좋아요·댓글 수·태그·카테고리·라이브 여부를 돌려준다. " +
        "include_description=true면 설명란 전문도 준다. 50건당 1유닛. " +
        "댓글수 필드가 응답에 없으면 '댓글사용중지: true'로 표시한다. 조회되지 않은 ID(삭제·비공개)는 따로 나열한다.",
      inputSchema: {
        video_ids: strList({ splitPlain: true }).describe("영상ID 또는 URL 배열(최대 500)"),
        include_description: bool(false).describe("설명란 전문 포함 여부"),
      },
    },
    async ({ video_ids, include_description }) => {
      const meter = new QuotaMeter();
      try {
        const ids = [...new Set(video_ids.map(extractVideoId))];
        if (!ids.length) throw new Error("video_ids가 비어 있습니다.");
        if (ids.length > 500) throw new Error(`한 번에 최대 500건입니다(받은 수 ${ids.length}).`);
        const det = await fetchVideos(ids, meter, { includeDescription: include_description });
        const missing = ids.filter((id) => !det.has(id));
        const list = ids.filter((id) => det.has(id)).map((id) => det.get(id));
        return ok({
          요약: {
            요청: ids.length,
            조회됨: list.length,
            조회안됨: missing.length,
            댓글사용중지: list.filter((v) => v.댓글사용중지).length,
            ...meter.report(),
          },
          조회안된ID: missing,
          영상: list,
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 3. 댓글 ───────────────────────────────────────────────────────────────
  server.registerTool(
    "youtube_get_comments",
    {
      title: "유튜브 영상 댓글 수집 (대댓글 전량)",
      description:
        "한 영상의 원댓글과 대댓글을 수집한다. 원댓글 100건당 1유닛, 대댓글 전량 조회 시 스레드마다 추가 유닛. " +
        "commentThreads는 대댓글을 스레드당 최대 5개만 주므로, 대댓글이 더 있으면 comments.list로 전량을 받는다. " +
        "채널 소유자가 단 댓글은 '채널소유자: true'로 표시한다. " +
        "통계상 댓글 수(대댓글 포함)와 실제 수집 수가 다를 수 있으므로 둘 다 보고한다(삭제·검토 대기·스팸 처리 댓글은 API로 안 나온다). " +
        "댓글이 꺼진 영상은 오류 대신 댓글사용중지로 돌려준다. " +
        "주의: 댓글의 상당수는 영상 주제와 무관하다(크리에이터 인사, 홍보, 다른 종목 이야기) — 분석 전에 걸러낼 것.",
      inputSchema: {
        video_id: z.string().describe("영상ID 또는 영상 URL"),
        order: z.enum(["time", "relevance"]).default("time").describe("time(최신순) 또는 relevance(인기순)"),
        max_threads: num(1, 1000, 300).describe("최대 원댓글 수(기본 300)"),
        include_replies: bool(true).describe("대댓글 포함 여부"),
        max_replies_per_thread: num(0, 1000, 200).describe("스레드당 최대 대댓글 수(기본 200)"),
        max_total_replies: num(0, 5000, 1000).describe("이번 호출 전체의 대댓글 상한(기본 1000) — 인기 영상은 원댓글 몇십 개에 대댓글이 수천 개 붙어 응답이 과도해진다"),
        search_terms: z.string().optional().describe("이 문자열이 들어간 댓글만 (commentThreads의 searchTerms)"),
      },
    },
    async (a) => {
      const meter = new QuotaMeter();
      try {
        const vid = extractVideoId(a.video_id);
        const det = await fetchVideos([vid], meter);
        const video = det.get(vid);
        if (!video) throw new YouTubeApiError(`영상을 찾을 수 없습니다(${vid}). 삭제·비공개 영상이거나 ID가 틀렸습니다.`, { reason: "videoNotFound" });
        const head = {
          영상ID: vid,
          제목: video.제목,
          채널명: video.채널명,
          채널ID: video.채널ID,
          통계상댓글수_대댓글포함: video.댓글수,
        };
        if (video.댓글사용중지) {
          return ok({ 영상: head, 댓글사용중지: true, 안내: "이 영상은 댓글 사용이 중지되어 있어 수집할 댓글이 없습니다.", ...meter.report() });
        }

        const threads = [];
        let token;
        let threadCut = false;
        while (threads.length < a.max_threads) {
          let r;
          try {
            r = await ytGet(
              "commentThreads",
              {
                part: "snippet,replies",
                videoId: vid,
                order: a.order,
                maxResults: Math.min(100, a.max_threads - threads.length),
                textFormat: "plainText",
                searchTerms: a.search_terms,
                pageToken: token,
              },
              meter
            );
          } catch (e) {
            if (e.reason === "commentsDisabled") {
              return ok({ 영상: head, 댓글사용중지: true, 안내: e.message, ...meter.report() });
            }
            throw e;
          }
          for (const t of r.items || []) {
            const top = t.snippet && t.snippet.topLevelComment;
            if (!top) continue;
            const rec = shapeComment(top, video.채널ID);
            rec.대댓글수 = t.snippet.totalReplyCount || 0;
            rec._inline = ((t.replies && t.replies.comments) || []).map((c) => shapeComment(c, video.채널ID));
            threads.push(rec);
          }
          token = r.nextPageToken;
          if (!token) break;
          if (threads.length >= a.max_threads) {
            threadCut = true;
            break;
          }
        }

        let repliesCollected = 0;
        let replyCutThreads = 0;
        let totalCapHit = false;
        for (const t of threads) {
          if (!a.include_replies) {
            delete t._inline;
            continue;
          }
          let replies = t._inline;
          delete t._inline;
          const cap = Math.max(0, Math.min(a.max_replies_per_thread, a.max_total_replies - repliesCollected));
          if (cap < a.max_replies_per_thread && t.대댓글수 > cap) totalCapHit = true;
          if (t.대댓글수 > replies.length && cap > replies.length) {
            // inline 5개로는 모자라므로 전량을 다시 받는다
            replies = [];
            let rt;
            while (replies.length < cap) {
              const r = await ytGet(
                "comments",
                { part: "snippet", parentId: t.댓글ID, maxResults: Math.min(100, cap - replies.length), textFormat: "plainText", pageToken: rt },
                meter
              );
              for (const c of r.items || []) replies.push(shapeComment(c, video.채널ID));
              rt = r.nextPageToken;
              if (!rt) break;
            }
          }
          if (replies.length > cap) replies = replies.slice(0, cap);
          if (t.대댓글수 > replies.length) {
            t.대댓글잘림 = true;
            replyCutThreads++;
          }
          replies.sort((x, y) => (x.작성일시_KST > y.작성일시_KST ? 1 : x.작성일시_KST < y.작성일시_KST ? -1 : 0));
          t.대댓글 = replies;
          repliesCollected += replies.length;
        }

        const ownerCount =
          threads.filter((t) => t.채널소유자).length +
          threads.reduce((s, t) => s + (t.대댓글 || []).filter((c) => c.채널소유자).length, 0);
        const total = threads.length + repliesCollected;
        const notes = [];
        if (a.search_terms) notes.push(`search_terms='${a.search_terms}'로 거른 결과라 통계상 댓글 수와 비교하지 말 것.`);
        else if (video.댓글수 !== null && total !== video.댓글수 && !threadCut && replyCutThreads === 0)
          notes.push(
            `통계상 댓글 수(${video.댓글수})와 수집 수(${total})가 다르다. 삭제·검토 대기·스팸 처리된 댓글은 API로 나오지 않고, 통계는 갱신이 늦을 수 있다.`
          );
        if (threadCut) notes.push(`max_threads(${a.max_threads})에서 멈췄다 — 원댓글이 더 있다(잘림).`);
        if (replyCutThreads) notes.push(`대댓글이 상한에서 잘린 스레드가 ${replyCutThreads}개 있다(스레드당 max_replies_per_thread, 전체 max_total_replies).`);
        if (totalCapHit) notes.push(`전체 대댓글 상한 max_total_replies(${a.max_total_replies})에 걸려 뒤쪽 스레드의 대댓글은 일부 또는 전부 빠졌다.`);
        if (!a.include_replies) notes.push("include_replies=false — 대댓글은 수집하지 않았다(대댓글수만 표시).");

        return ok({
          영상: head,
          요약: {
            수집원댓글수: threads.length,
            수집대댓글수: repliesCollected,
            수집합계: total,
            채널소유자댓글수: ownerCount,
            정렬: a.order,
            잘림: threadCut || replyCutThreads > 0,
            ...meter.report(),
          },
          유의사항: notes,
          댓글: threads,
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 4. 채널 검색 ───────────────────────────────────────────────────────────
  server.registerTool(
    "youtube_search_channels",
    {
      title: "유튜브 채널 검색",
      description:
        "검색어로 채널을 찾아 채널ID·이름·설명을 돌려준다. 1페이지(최대 50건)에 100유닛. " +
        "@핸들을 이미 알면 이 도구 대신 youtube_get_channels(handle=…)를 쓸 것(1유닛). " +
        "include_stats=true면 구독자·영상 수 등을 channels.list로 붙인다(50건당 1유닛).",
      inputSchema: {
        query: z.string().describe("검색어"),
        max_results: num(1, 50, 10).describe("최대 건수(기본 10)"),
        region: z.string().default("KR").describe("regionCode. 빈 문자열이면 지정 안 함"),
        include_stats: bool(false),
      },
    },
    async ({ query, max_results, region, include_stats }) => {
      const meter = new QuotaMeter();
      try {
        const r = await ytGet(
          "search",
          { part: "snippet", q: query, type: "channel", maxResults: max_results, regionCode: region || undefined },
          meter
        );
        let list = (r.items || []).map((it) => ({
          채널ID: it.id && it.id.channelId,
          채널명: decodeEntities(it.snippet && it.snippet.channelTitle),
          설명: decodeEntities(it.snippet && it.snippet.description),
          개설일시_KST: toKst(it.snippet && it.snippet.publishedAt),
          URL: it.id && it.id.channelId ? `https://www.youtube.com/channel/${it.id.channelId}` : null,
        }));
        if (include_stats && list.length) {
          const ch = await ytGet("channels", { part: "snippet,statistics", id: list.map((c) => c.채널ID), maxResults: 50 }, meter);
          const map = new Map((ch.items || []).map((c) => [c.id, c]));
          list = list.map((c) => {
            const d = map.get(c.채널ID);
            if (!d) return c;
            const st = d.statistics || {};
            return {
              ...c,
              핸들: d.snippet && d.snippet.customUrl,
              구독자수: st.hiddenSubscriberCount ? "비공개" : toInt(st.subscriberCount),
              영상수: toInt(st.videoCount),
              총조회수: toInt(st.viewCount),
            };
          });
        }
        return ok({ 요약: { 건수: list.length, ...meter.report() }, 채널: list });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 5. 채널 상세 ───────────────────────────────────────────────────────────
  server.registerTool(
    "youtube_get_channels",
    {
      title: "유튜브 채널 상세 조회",
      description:
        "채널ID 목록 또는 @핸들 하나로 채널의 이름·핸들·설명·개설일·국가·구독자 수(비공개면 '비공개')·영상 수·총 조회수·업로드 재생목록ID를 돌려준다. 호출당 1유닛. " +
        "채널 URL(youtube.com/@핸들, youtube.com/channel/UC…)도 받는다.",
      inputSchema: {
        channel_ids: strList({ splitPlain: true }).optional().describe("채널ID(UC…) 또는 채널 URL 배열(최대 50)"),
        handle: z.string().optional().describe("@핸들 또는 youtube.com/@핸들 URL (channel_ids가 없을 때)"),
      },
    },
    async ({ channel_ids, handle }) => {
      const meter = new QuotaMeter();
      try {
        let params;
        if (channel_ids && channel_ids.length) {
          const ids = channel_ids.map((c) => channelLookupParams({ channel_id: c }).id);
          if (ids.length > 50) throw new Error("channel_ids는 최대 50개입니다.");
          params = { id: ids };
        } else if (handle) params = channelLookupParams({ handle });
        else throw new Error("channel_ids 또는 handle 중 하나는 필요합니다.");
        const r = await ytGet("channels", { part: "snippet,statistics,contentDetails", maxResults: 50, ...params }, meter);
        const list = (r.items || []).map((d) => {
          const sn = d.snippet || {};
          const st = d.statistics || {};
          return {
            채널ID: d.id,
            채널명: sn.title,
            핸들: sn.customUrl || null,
            URL: `https://www.youtube.com/channel/${d.id}`,
            설명: sn.description,
            개설일시_KST: toKst(sn.publishedAt),
            국가: sn.country || null,
            구독자수: st.hiddenSubscriberCount ? "비공개" : toInt(st.subscriberCount),
            영상수: toInt(st.videoCount),
            총조회수: toInt(st.viewCount),
            업로드재생목록ID: d.contentDetails && d.contentDetails.relatedPlaylists && d.contentDetails.relatedPlaylists.uploads,
          };
        });
        const notes = [];
        if (!list.length) notes.push("일치하는 채널이 없습니다. 핸들 철자나 채널ID를 확인하거나 youtube_search_channels로 찾으세요.");
        if (params.id) {
          const got = new Set(list.map((c) => c.채널ID));
          const miss = params.id.filter((i) => !got.has(i));
          if (miss.length) notes.push(`조회되지 않은 채널ID: ${miss.join(", ")}`);
        }
        notes.push("구독자 수는 YouTube가 반올림한 공개값이다(1,000명 이상은 유효숫자 3자리).");
        return ok({ 요약: { 건수: list.length, ...meter.report() }, 유의사항: notes, 채널: list });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 6. 채널 업로드 목록 ────────────────────────────────────────────────────
  server.registerTool(
    "youtube_list_channel_videos",
    {
      title: "채널 업로드 영상 전체 나열",
      description:
        "채널의 업로드 재생목록(또는 지정한 재생목록)을 페이지 단위로 읽어 공개 영상을 나열한다. 50건당 1유닛으로, " +
        "검색(100유닛)보다 훨씬 싸므로 특정 채널의 영상 전수 조회는 이 도구를 쓸 것. " +
        "채널은 channel_id·handle·playlist_id 중 하나로 지정한다. " +
        "업로드 재생목록은 최신순이므로 published_after를 주면 그보다 오래된 영상이 연속으로 나올 때 읽기를 멈춘다. " +
        "max_scan은 읽을 최대 항목 수(기간 필터 적용 전)이며, 거기서 멈췄으면 잘림으로 표시한다. " +
        "비공개·삭제 영상은 목록에 자리만 남아 있어 따로 세고 결과에서 뺀다.",
      inputSchema: {
        channel_id: z.string().optional().describe("채널ID(UC…) 또는 채널 URL"),
        handle: z.string().optional().describe("@핸들"),
        playlist_id: z.string().optional().describe("재생목록ID (업로드 목록이 아닌 특정 재생목록을 읽을 때)"),
        published_after: z.string().optional().describe("YYYY-MM-DD(한국 시간) 또는 RFC3339"),
        published_before: z.string().optional().describe("YYYY-MM-DD(그날 포함) 또는 RFC3339"),
        max_scan: num(1, 5000, 500).describe("읽을 최대 항목 수(기본 500 = 10유닛)"),
        include_stats: bool(false).describe("true면 조회수·좋아요·댓글수·길이를 붙인다(50건당 1유닛 추가)"),
      },
    },
    async (a) => {
      const meter = new QuotaMeter();
      try {
        let playlistId = a.playlist_id;
        let channel = null;
        if (!playlistId) {
          const p = channelLookupParams({ channel_id: a.channel_id, handle: a.handle });
          if (!p) throw new Error("channel_id·handle·playlist_id 중 하나는 필요합니다.");
          const r = await ytGet("channels", { part: "snippet,contentDetails,statistics", ...p }, meter);
          const d = (r.items || [])[0];
          if (!d) throw new YouTubeApiError("채널을 찾을 수 없습니다. 핸들 철자나 채널ID를 확인하세요.", { reason: "channelNotFound" });
          playlistId = d.contentDetails.relatedPlaylists.uploads;
          channel = {
            채널ID: d.id,
            채널명: d.snippet.title,
            핸들: d.snippet.customUrl || null,
            통계상영상수: toInt(d.statistics && d.statistics.videoCount),
          };
        }
        const after = toRfc3339(a.published_after);
        const before = toRfc3339(a.published_before, { endOfDay: true });

        const out = [];
        let scanned = 0;
        let hidden = 0;
        let token;
        let stop = "";
        let olderRun = 0;
        const OLDER_RUN_STOP = 5;
        outer: while (true) {
          const r = await ytGet(
            "playlistItems",
            { part: "snippet,contentDetails,status", playlistId, maxResults: Math.min(50, a.max_scan - scanned), pageToken: token },
            meter
          );
          for (const it of r.items || []) {
            scanned++;
            const sn = it.snippet || {};
            const cd = it.contentDetails || {};
            const pub = cd.videoPublishedAt;
            const privacy = it.status && it.status.privacyStatus;
            if (!pub || (privacy && privacy !== "public")) {
              hidden++;
              continue;
            }
            if (after && pub < after) {
              olderRun++;
              if (!a.playlist_id && olderRun >= OLDER_RUN_STOP) {
                stop = `published_after보다 오래된 영상이 ${OLDER_RUN_STOP}건 연속 — 이후는 더 오래된 영상으로 보고 중단`;
                break outer;
              }
              continue;
            }
            olderRun = 0;
            if (before && pub >= before) continue;
            out.push({
              영상ID: cd.videoId,
              URL: `https://www.youtube.com/watch?v=${cd.videoId}`,
              제목: sn.title,
              게시일시_KST: toKst(pub),
              설명_앞부분: (sn.description || "").slice(0, 200),
            });
          }
          token = r.nextPageToken;
          if (!token) {
            stop = stop || "목록 끝";
            break;
          }
          if (scanned >= a.max_scan) {
            stop = "max_scan 도달 — 더 있음";
            break;
          }
        }

        let list = out;
        if (a.include_stats && list.length) {
          const det = await fetchVideos(list.map((v) => v.영상ID), meter);
          list = list.map((v) => {
            const d = det.get(v.영상ID);
            return d ? { ...v, 길이초: d.길이초, 조회수: d.조회수, 좋아요: d.좋아요, 댓글수: d.댓글수, 댓글사용중지: d.댓글사용중지 } : v;
          });
        }
        const cut = stop.startsWith("max_scan");
        const notes = [];
        if (cut) notes.push("max_scan에서 멈췄다(잘림). 더 읽으려면 max_scan을 올리거나 published_after로 범위를 좁힐 것.");
        if (hidden) notes.push(`비공개·삭제·예약 영상 ${hidden}건은 목록에 자리만 있어 제외했다.`);
        if (channel && channel.통계상영상수 !== null && !after && !before && !cut)
          notes.push(`채널 통계상 영상 수 ${channel.통계상영상수} / 이번에 나열한 공개 영상 ${list.length}. 통계는 갱신이 늦거나 일부공개 영상을 포함할 수 있다.`);
        return ok({
          채널: channel,
          재생목록ID: playlistId,
          요약: { 읽은항목: scanned, 결과건수: list.length, 제외_비공개삭제: hidden, 종료사유: stop, 잘림: cut, ...meter.report() },
          유의사항: notes,
          영상: list,
        });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 7. 인기 급상승 ─────────────────────────────────────────────────────────
  server.registerTool(
    "youtube_trending_videos",
    {
      title: "인기 급상승 영상",
      description:
        "지역별 인기 급상승(mostPopular) 영상 목록. 50건당 1유닛. category_id로 카테고리를 좁힐 수 있다 " +
        "(예: 25 뉴스·정치, 28 과학기술, 22 인물·블로그, 24 엔터테인먼트, 10 음악, 20 게임). " +
        "카테고리에 따라 해당 지역 차트가 제공되지 않으면 오류가 난다.",
      inputSchema: {
        region: z.string().default("KR").describe("regionCode"),
        category_id: z.string().optional().describe("videoCategoryId"),
        max_results: num(1, 200, 50).describe("최대 건수(기본 50)"),
      },
    },
    async ({ region, category_id, max_results }) => {
      const meter = new QuotaMeter();
      try {
        const list = [];
        let token;
        while (list.length < max_results) {
          const r = await ytGet(
            "videos",
            {
              part: "snippet,statistics,contentDetails",
              chart: "mostPopular",
              regionCode: region,
              videoCategoryId: category_id,
              maxResults: Math.min(50, max_results - list.length),
              pageToken: token,
            },
            meter
          );
          for (const v of r.items || []) list.push({ 순위: list.length + 1, ...shapeVideo(v, { includeDescription: false }) });
          token = r.nextPageToken;
          if (!token) break;
        }
        return ok({ 요약: { 지역: region, 카테고리ID: category_id || "전체", 건수: list.length, ...meter.report() }, 영상: list });
      } catch (e) {
        return fail(e, meter);
      }
    }
  );

  // ── 8. 할당량 안내 ─────────────────────────────────────────────────────────
  server.registerTool(
    "youtube_quota_info",
    {
      title: "할당량·도구 안내",
      description:
        "도구별 유닛 단가, 일일 한도(프로젝트 기본 10,000유닛), 다음 초기화 시각(한국 시간), 서버 설정 상태를 돌려준다. " +
        "API를 호출하지 않으므로 할당량을 쓰지 않는다. 남은 할당량은 API로 알 수 없어 Google Cloud 콘솔에서 확인해야 한다. " +
        "키 값은 반환하지 않고 설정 여부만 알린다.",
      inputSchema: {},
    },
    async () =>
      ok({
        서버: { 이름: "youtube-search-mcp", 버전: SERVER_VERSION, YOUTUBE_API_KEY_설정됨: keyConfigured() },
        일일한도_기본: DAILY_QUOTA_DEFAULT,
        검색호출_일일한도: "search.list는 유닛과 별개로 프로젝트당 하루 100회(defaultSearchListPerDayPerProject, 2026-10-07 실측). youtube_search_videos·youtube_search_channels의 페이지 하나가 1회다. 이 한도에 걸리면 YouTube가 rateLimitExceeded로 표시하지만 순간 과부하가 아니므로 초기화까지 재시도하지 말 것",
        다음초기화_KST: nextQuotaResetKst(),
        초기화기준: "태평양 시간 자정(한국 시간 16시 또는 17시 — 미국 서머타임에 따라 다름)",
        남은할당량확인: "API로는 조회할 수 없다. Google Cloud 콘솔 > API 및 서비스 > YouTube Data API v3 > 할당량에서 확인",
        도구별단가: {
          youtube_search_videos: "검색어당 페이지(최대 50건)마다 100유닛 + include_stats 시 50건당 1유닛",
          youtube_search_channels: "100유닛 + include_stats 시 1유닛",
          youtube_get_videos: "50건당 1유닛",
          youtube_get_comments: "영상 정보 1유닛 + 원댓글 100건당 1유닛 + 대댓글이 6개 이상인 스레드마다 100건당 1유닛",
          youtube_get_channels: "1유닛",
          youtube_list_channel_videos: "채널 확인 1유닛 + 50건당 1유닛 (+ include_stats 시 50건당 1유닛)",
          youtube_trending_videos: "50건당 1유닛",
          youtube_quota_info: "0유닛",
        },
        아끼는법: [
          "채널 단위 전수 조회는 검색 대신 youtube_list_channel_videos(1유닛)를 쓴다.",
          "검색은 max_per_query를 필요한 만큼만 — 기본 100(2페이지=200유닛).",
          "영상 상세가 필요하면 검색 결과에 include_stats=true를 주는 편이 별도 호출보다 간단하다(같은 비용).",
        ],
        범위밖: [
          "YouTube Analytics/Reporting(채널 소유자 OAuth 필요)",
          "자막 원문 다운로드(captions.download — OAuth 필요)",
          "비공개·일부공개 영상, 구독 관리, 업로드·댓글 작성 등 쓰기 작업",
        ],
      })
  );

  return server;
}
