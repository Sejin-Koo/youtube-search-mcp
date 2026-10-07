// YouTube Data API v3 클라이언트 — API 키 방식(공개 데이터 조회 전용)
//
// - 인증: 환경변수 YOUTUBE_API_KEY 하나만 쓴다. OAuth는 쓰지 않는다.
// - 할당량: 호출마다 유닛을 세어 응답에 싣는다(프로젝트 일일 기본 10,000유닛).
// - 오류: Google 오류 응답의 reason을 읽어 사람이 읽을 수 있는 안내로 바꾼다.

const BASE = "https://www.googleapis.com/youtube/v3";

/** 엔드포인트별 1회 호출 유닛 (YouTube Data API 공식 할당량 표 기준) */
export const UNIT_COST = {
  search: 100,
  videos: 1,
  commentThreads: 1,
  comments: 1,
  channels: 1,
  playlistItems: 1,
  videoCategories: 1,
};

export const DAILY_QUOTA_DEFAULT = 10000;

export function keyConfigured() {
  return !!(process.env.YOUTUBE_API_KEY || "").trim();
}

/** 한 번의 도구 호출 동안 쓴 유닛과 호출 수를 센다 */
export class QuotaMeter {
  constructor() {
    this.units = 0;
    this.calls = {};
  }
  add(endpoint) {
    this.units += UNIT_COST[endpoint] ?? 1;
    this.calls[endpoint] = (this.calls[endpoint] || 0) + 1;
  }
  report() {
    return { 추정사용유닛: this.units, 호출수: { ...this.calls } };
  }
}

export class YouTubeApiError extends Error {
  constructor(message, { status, reason, raw } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.raw = raw;
  }
}

/** 태평양 시간 자정(할당량 초기화 시각)을 한국 시간으로 계산한다 — 서머타임 반영 */
export function nextQuotaResetKst(now = new Date()) {
  // 오늘(태평양) 날짜를 구한 뒤, 다음 날 00:00 태평양 시각이 UTC로 언제인지 찾는다
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(now).split("-").map(Number);
  // 태평양 오프셋은 -7 또는 -8. 두 후보 중 태평양 기준 00:00이 되는 쪽을 고른다
  for (const off of [7, 8]) {
    const cand = new Date(Date.UTC(y, m - 1, d + 1, off, 0, 0));
    const hh = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(cand);
    if (hh === "00") return toKst(cand.toISOString());
  }
  return null;
}

/** RFC3339(UTC) → "YYYY-MM-DD HH:mm" 한국 시간 */
export function toKst(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (isNaN(t)) return iso;
  const k = new Date(t.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

/**
 * 날짜 입력을 RFC3339(UTC)로 바꾼다.
 *  - "YYYY-MM-DD" 는 한국 시간 그날 00:00으로 해석한다.
 *    endOfDay=true면 그다음 날 00:00(KST) — 즉 그날 하루를 포함하는 배타적 상한.
 *  - 시각이 들어간 값은 Date가 해석하는 그대로 쓴다(시간대 표기가 없으면 KST로 간주).
 */
export function toRfc3339(input, { endOfDay = false } = {}) {
  if (input === undefined || input === null || input === "") return undefined;
  const s = String(input).trim();
  const dm = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (dm) {
    const [, y, m, d] = dm.map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + (endOfDay ? 1 : 0), 0, 0, 0) - 9 * 3600 * 1000);
    return t.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const t = new Date(hasZone ? s : s.replace(" ", "T") + "+09:00");
  if (isNaN(t)) throw new Error(`날짜 형식을 해석하지 못했습니다: ${s} (예: 2026-10-01 또는 2026-10-01T09:00:00+09:00)`);
  return t.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** ISO8601 기간(PT1H2M3S, P1DT2H 등) → 초 */
export function durationSeconds(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
/** search.list 의 snippet 제목·설명은 HTML 엔티티가 섞여 온다 */
export function decodeEntities(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (e) => ENTITIES[e] ?? e)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** URL·짧은 주소·순수 ID 어느 형태로 와도 영상ID 11자리를 뽑는다 */
export function extractVideoId(s) {
  const v = String(s || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m =
    v.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    v.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    v.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : v;
}

/** 오류 reason별 안내 문구 */
function explain(reason, message, status, info = {}) {
  switch (reason) {
    case "dailySearchLimitExceeded":
      return (
        `오늘 검색 호출 횟수 한도를 모두 썼습니다(일일 search.list ${info.limitValue ?? "100"}회 — 유닛 할당량과 별개의 한도). ` +
        `한국 시간 ${nextQuotaResetKst() ?? "16~17시"}에 초기화되며, 그 전에는 간격을 두고 다시 불러도 계속 거부됩니다(재시도 금지). ` +
        "검색이 아닌 도구(영상 상세·댓글·채널·채널 업로드 목록·인기 급상승)는 유닛이 남아 있는 한 계속 쓸 수 있습니다. " +
        `(YouTube는 이 오류를 rateLimitExceeded로 표시하지만 순간 과부하가 아니라 일일 한도입니다. 한도: ${info.quotaLimit ?? "defaultSearchListPerDayPerProject"})`
      );
    case "dailyLimitPerMetric":
      return `일일 한도를 모두 썼습니다(${info.quotaLimit}${info.limitValue ? ` = ${info.limitValue}` : ""}). 한국 시간 ${nextQuotaResetKst() ?? "16~17시"}에 초기화되며 그 전에는 재시도해도 거부됩니다.`;
    case "quotaExceeded":
    case "dailyLimitExceeded":
      return `일일 할당량을 모두 썼습니다(quotaExceeded). 할당량은 태평양 시간 자정에 초기화되며, 한국 시간으로는 ${nextQuotaResetKst() ?? "16~17시"}입니다. 재시도해도 한도만 더 쓰지는 않지만 결과는 같으므로 초기화 이후에 다시 호출하세요.`;
    case "rateLimitExceeded":
    case "userRateLimitExceeded":
      return "짧은 시간에 요청이 너무 많습니다(rateLimitExceeded). 잠시 뒤 다시 호출하세요.";
    case "commentsDisabled":
      return "이 영상은 댓글 사용이 중지되어 있습니다(commentsDisabled).";
    case "videoNotFound":
      return "영상을 찾을 수 없습니다(videoNotFound). 삭제·비공개 영상이거나 ID가 틀렸습니다.";
    case "channelNotFound":
      return "채널을 찾을 수 없습니다(channelNotFound).";
    case "playlistNotFound":
      return "재생목록을 찾을 수 없습니다(playlistNotFound). 비공개 재생목록이거나 ID가 틀렸습니다.";
    case "API_KEY_SERVICE_BLOCKED":
      return "API 키의 'API 제한' 설정이 YouTube Data API v3를 허용하지 않습니다(API_KEY_SERVICE_BLOCKED). Google Cloud 콘솔 > 사용자 인증 정보 > 해당 키 > API 제한에 YouTube Data API v3를 추가하세요.";
    case "SERVICE_DISABLED":
    case "accessNotConfigured":
      return "Google Cloud 프로젝트에서 YouTube Data API v3가 꺼져 있습니다(SERVICE_DISABLED). 콘솔의 API 라이브러리에서 사용 설정하세요.";
    case "API_KEY_INVALID":
    case "keyInvalid":
      return "API 키가 유효하지 않습니다(API_KEY_INVALID). Vercel 환경변수 YOUTUBE_API_KEY 값을 확인하세요.";
    case "API_KEY_HTTP_REFERRER_BLOCKED":
    case "API_KEY_IP_ADDRESS_BLOCKED":
      return `API 키의 '애플리케이션 제한'(HTTP 리퍼러·IP 주소)에 이 서버의 호출이 막혔습니다(${reason}). 서버(Vercel)에서 쓰는 키는 애플리케이션 제한을 '없음'으로 두고 API 제한으로만 좁히세요.`;
    case "forbidden":
      return `접근이 거부되었습니다(forbidden): ${message}`;
    case "processingFailure":
      return `YouTube 쪽 처리 실패(processingFailure, 일시적일 수 있음): ${message}`;
    default:
      return `YouTube API 오류(HTTP ${status}${reason ? `, ${reason}` : ""}): ${message}`;
  }
}

/**
 * GET 호출. params 중 undefined/null/"" 는 빼고 보낸다.
 * @param {string} endpoint search | videos | commentThreads | comments | channels | playlistItems | videoCategories
 */
export async function ytGet(endpoint, params, meter) {
  const key = (process.env.YOUTUBE_API_KEY || "").trim();
  if (!key) {
    throw new YouTubeApiError(
      "환경변수 YOUTUBE_API_KEY가 설정되어 있지 않습니다. Vercel 프로젝트 Settings > Environment Variables에 등록한 뒤 재배포하세요.",
      { reason: "NO_KEY" }
    );
  }
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  url.searchParams.set("key", key);

  if (meter) meter.add(endpoint);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new YouTubeApiError(`YouTube API에 연결하지 못했습니다: ${e.message}`, { reason: "NETWORK" });
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok || (body && body.error)) {
    const err = (body && body.error) || {};
    const fromErrors = err.errors && err.errors[0] && err.errors[0].reason;
    const fromDetails =
      Array.isArray(err.details) &&
      (err.details.find((d) => d && d.reason) || {}).reason;
    // 키·프로젝트 설정 문제는 details(ErrorInfo)의 reason이 더 구체적이다
    // (errors[0].reason은 forbidden·badRequest처럼 뭉뚱그려 온다)
    const KEY_REASONS = ["API_KEY_SERVICE_BLOCKED", "SERVICE_DISABLED", "API_KEY_INVALID", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED"];
    const reason = KEY_REASONS.includes(fromDetails)
      ? fromDetails
      : fromErrors || fromDetails || err.status || null;
    const message = err.message || text.slice(0, 300) || `HTTP ${res.status}`;
    // ★ 일일 한도 초과도 errors[0].reason이 rateLimitExceeded로 온다(2026-10-07 실측:
    //   search.list 일일 100회 한도 defaultSearchListPerDayPerProject). 순간 과부하와
    //   구분하지 않으면 "잠시 뒤 재시도"를 안내해 호출자가 헛되이 재시도한다.
    //   ErrorInfo.metadata.quota_limit / quota_unit 으로 일일 한도인지 가린다.
    const info = {};
    const ei = Array.isArray(err.details) && err.details.find((d) => d && d.metadata && d.metadata.quota_limit);
    if (ei) {
      info.quotaLimit = ei.metadata.quota_limit;
      info.limitValue = ei.metadata.quota_limit_value;
      info.quotaMetric = ei.metadata.quota_metric;
    }
    let finalReason = reason;
    const perDay =
      (ei && (/PerDay/i.test(ei.metadata.quota_limit || "") || /\/d\//.test(ei.metadata.quota_unit || ""))) ||
      /per day/i.test(message);
    if ((reason === "rateLimitExceeded" || reason === "RATE_LIMIT_EXCEEDED") && perDay) {
      finalReason = /search/i.test(`${info.quotaMetric || ""} ${info.quotaLimit || ""} ${message}`)
        ? "dailySearchLimitExceeded"
        : "dailyLimitPerMetric";
    }
    throw new YouTubeApiError(explain(finalReason, message, res.status, info), {
      status: res.status,
      reason: finalReason,
      raw: message,
    });
  }
  if (!body) throw new YouTubeApiError(`YouTube API가 빈 응답을 돌려주었습니다(HTTP ${res.status}).`, { status: res.status, reason: "EMPTY" });
  return body;
}

/** ID 목록을 n개 단위로 나눈다 */
export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
