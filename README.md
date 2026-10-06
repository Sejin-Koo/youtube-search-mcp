# youtube-search-mcp

유튜브 **공개 데이터**를 조회하는 MCP 서버입니다. YouTube Data API v3를 **API 키 하나**로 호출하며, OAuth는 쓰지 않습니다.
기업·이슈 관련 영상과 댓글 여론, 특정 채널의 공개 콘텐츠 현황을 분석하는 용도입니다.

## 도구

| 도구 | 사용 API (유닛) | 하는 일 |
|---|---|---|
| `youtube_search_videos` | search.list (페이지당 100) | 여러 검색어 결과를 영상ID로 합치고 각 영상이 걸린 검색어를 표시. 검색어별 잘림 여부 보고. 예상 3,000유닛 초과 시 `allow_large` 없이는 실행 안 함 |
| `youtube_get_videos` | videos.list (50건당 1) | 제목·채널·게시일·길이·조회수·좋아요·댓글 수·태그·설명란. 댓글 수 필드가 없으면 댓글 사용 중지로 표시 |
| `youtube_get_comments` | commentThreads.list + comments.list (100건당 1) | 원댓글·대댓글 전량(스레드당 5개 제한을 comments.list로 보완), 채널 소유자 댓글 표시, 통계 댓글 수와 수집 수 함께 보고 |
| `youtube_search_channels` | search.list type=channel (100) | 채널 검색 |
| `youtube_get_channels` | channels.list (1) | 채널ID·@핸들·채널 URL로 채널 상세(구독자·영상 수·업로드 재생목록ID) |
| `youtube_list_channel_videos` | playlistItems.list (50건당 1) | 채널 업로드 목록 전수 나열 — 검색보다 100배 저렴 |
| `youtube_trending_videos` | videos.list chart=mostPopular (1) | 지역·카테고리별 인기 급상승 |
| `youtube_quota_info` | 없음 (0) | 유닛 단가, 일일 한도, 다음 초기화 시각(KST), 키 설정 여부 |

모든 도구는 응답에 **이번 호출의 추정 사용 유닛**과 **잘림 여부**를 함께 돌려줍니다.
일일 할당량(프로젝트 기본 10,000유닛)은 태평양 시간 자정, 한국 시간 16~17시에 초기화됩니다.

## 범위 밖

- YouTube Analytics / Reporting API (채널 소유자 OAuth 필요)
- 자막 원문 다운로드 (`captions.download` — OAuth 필요)
- 비공개·일부공개 영상, 구독 관리, 업로드·댓글 작성 등 쓰기 작업

DB·캐시는 두지 않습니다. 여론 데이터는 필요할 때마다 다시 조회합니다.

## 환경변수 (Vercel)

| 이름 | 내용 |
|---|---|
| `YOUTUBE_API_KEY` | Google Cloud 프로젝트의 API 키 (YouTube Data API v3 사용 설정 필요) |
| `MCP_GATE_KEYS` | 접근 허용 게이트키 목록(쉼표 구분). 비어 있으면 게이트 비활성 |
| `MCP_GATE_MODE` | `enforce`면 키 없는 호출을 401로 차단, 그 밖이면 기록만 |

키 값은 저장소에 두지 않습니다. 환경변수를 바꾼 뒤에는 재배포해야 반영됩니다.

## 호출 주소

```
https://<배포 도메인>/api/mcp?k=<게이트키>
```

## 로컬 검증

```bash
npm install
YOUTUBE_API_KEY=... node smoke.mjs                 # 전체 (약 370유닛)
YOUTUBE_API_KEY=... node smoke.mjs youtube_get_videos  # 일부 도구만
```
