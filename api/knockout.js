// ============================================================================
//  /api/knockout  ·  Vercel Serverless Function
// ----------------------------------------------------------------------------
//  作用：服务端用密钥请求上游世界杯接口，取淘汰赛(32强→决赛)的赛程与对阵，
//        归一化成前端约定的固定结构数组返回。上游失败/超时则回退到
//        knockout-skeleton.json（全部 tbd=true），保证接口永远有可用返回。
//
//  ⚠ 密钥只在这里（服务端）从 process.env.FOOTBALL_API_KEY 读取，
//     绝不会出现在前端代码或返回体里。
// ============================================================================

// 兜底骨架：直接 require 进来，Vercel 打包(nft)会自动把这个 JSON 一并带上。
const SKELETON = require("../knockout-skeleton.json");

// ───────────────────────────── API_CONFIG ──────────────────────────────────
//  换数据源时，基本只改这一块。
//
//  默认源：API-Football (api-sports.io) —— 免费档每天 100 次请求。
//
//  • 直连 api-sports.io：BASE_URL = https://v3.football.api-sports.io
//    请求头用 { "x-apisports-key": <KEY> }
//  • 若你用的是 RapidAPI 版：
//      BASE_URL = https://api-football-v1.p.rapidapi.com/v3
//      请求头 = { "x-rapidapi-key": <KEY>,
//                "x-rapidapi-host": "api-football-v1.p.rapidapi.com" }
//
//  世界杯参数：
//    league = 1     // API-Football 里 "World Cup" 的联赛 id 固定为 1
//    season = 2026  // 2026 美加墨世界杯
//
//  淘汰赛各 round 名称：
//    用 GET /fixtures/rounds?league=1&season=2026 可列出本届所有 round。
//    48 队赛制下，淘汰赛 round 形如：
//      "Round of 32" / "Round of 16" / "Quarter-finals" /
//      "Semi-finals" / "3rd Place Final" / "Final"
//    小组赛 round 形如 "Group Stage - 1"，本函数只挑出下面 ROUND_TO_STAGE
//    里列出的淘汰赛 round，其余(小组赛)自动忽略。
// ----------------------------------------------------------------------------
const API_CONFIG = {
  BASE_URL: "https://v3.football.api-sports.io",
  LEAGUE_ID: 1,
  SEASON: 2026,
  TIMEOUT_MS: 4000, // 服务端自身超时，留在前端 5s 之内

  // 拼请求头（密钥从环境变量取）
  headers() {
    return {
      "x-apisports-key": process.env.FOOTBALL_API_KEY || "",
      // RapidAPI 版改用下面两行（并删掉上面那行）：
      // "x-rapidapi-key": process.env.FOOTBALL_API_KEY || "",
      // "x-rapidapi-host": "api-football-v1.p.rapidapi.com",
    };
  },

  // 一次取该联赛该赛季的全部赛程，本地再按 round 过滤淘汰赛（省请求次数）
  fixturesUrl() {
    return `${this.BASE_URL}/fixtures?league=${this.LEAGUE_ID}&season=${this.SEASON}`;
  },

  // 上游 round 名称 → 前端使用的中文 stage（也是只保留淘汰赛的白名单）
  ROUND_TO_STAGE: {
    "Round of 32": "32强赛",
    "Round of 16": "16强赛",
    "Quarter-finals": "1/4决赛",
    "Semi-finals": "半决赛",
    "3rd Place Final": "季军赛",
    "Play-off for 3rd place": "季军赛", // 个别源的别名，防御性兼容
    "Final": "决赛",
  },

  // 字段映射：上游 fixture 对象 → 我们关心的字段。集中在此方便换源。
  map: {
    round: (fx) => fx && fx.league && fx.league.round,
    timestamp: (fx) => (fx && fx.fixture && fx.fixture.timestamp) || 0,
    homeName: (fx) => fx && fx.teams && fx.teams.home && fx.teams.home.name,
    awayName: (fx) => fx && fx.teams && fx.teams.away && fx.teams.away.name,
  },
};
// ────────────────────────────────────────────────────────────────────────────

// 判断一个队名是否"已确定"。上游对未定对阵常给 null 或占位名（如
// "Winner Group A" / "Runner-up D" / "TBD"），这些都视为未定。
function isDetermined(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!s) return false;
  if (/^(tbd|to be determined)$/i.test(s)) return false;
  if (/winner|runner[\s-]?up|loser|to be determined|placeholder/i.test(s)) return false;
  return true;
}

// 把骨架的某条 match 还原成"全未定"初始态
function blankSlot(m) {
  return Object.assign({}, m, { home: null, away: null, tbd: true });
}

// 归一化核心：以骨架为准（时间/场馆/轮次/bracketSlot 固定不变），
// 把上游"已确定的对阵"叠加到对应槽位上。
//
// 配对方式：同一 stage（轮次）内，骨架与上游各自按开赛时间升序排列后，
// 逐位配对。官方赛程里 bracket 槽位与日期/场馆是绑定的，所以同轮按时间
// 排序后顺序一致 —— 这样既能填上真实对阵，又能保留骨架里的 bracketSlot。
function buildKnockout(upstreamFixtures) {
  const result = SKELETON.map(blankSlot);

  // 上游淘汰赛按 stage 分组（非淘汰赛 round 直接丢弃）
  const upByStage = {};
  upstreamFixtures.forEach((fx) => {
    const stage = API_CONFIG.ROUND_TO_STAGE[API_CONFIG.map.round(fx)];
    if (!stage) return;
    (upByStage[stage] || (upByStage[stage] = [])).push(fx);
  });
  Object.keys(upByStage).forEach((s) => {
    upByStage[s].sort((a, b) => API_CONFIG.map.timestamp(a) - API_CONFIG.map.timestamp(b));
  });

  // 骨架(result)也按 stage 分组（保留对象引用，便于直接改写）
  const skByStage = {};
  result.forEach((m) => {
    (skByStage[m.stage] || (skByStage[m.stage] = [])).push(m);
  });
  Object.keys(skByStage).forEach((s) => {
    skByStage[s].sort((a, b) => new Date(a.datetimeUTC) - new Date(b.datetimeUTC));
  });

  // 同轮逐位配对，填入已确定对阵
  Object.keys(skByStage).forEach((stage) => {
    const ups = upByStage[stage] || [];
    skByStage[stage].forEach((slot, i) => {
      const fx = ups[i];
      if (!fx) return;
      const home = API_CONFIG.map.homeName(fx);
      const away = API_CONFIG.map.awayName(fx);
      if (isDetermined(home) && isDetermined(away)) {
        slot.home = home;
        slot.away = away;
        slot.tbd = false;
      }
    });
  });

  return result;
}

// 带超时地请求上游
async function fetchUpstream() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT_MS);
  try {
    const resp = await fetch(API_CONFIG.fixturesUrl(), {
      headers: API_CONFIG.headers(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error("上游 HTTP " + resp.status);

    const data = await resp.json();

    // API-Football 把错误放在 data.errors（对象或数组），results=0
    const errs = data && data.errors;
    const hasErr = errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length);
    if (hasErr) throw new Error("上游返回错误：" + JSON.stringify(errs));

    const arr = (data && data.response) || [];
    if (!Array.isArray(arr) || arr.length === 0) throw new Error("上游无赛程数据");
    return arr;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── handler ─────────────────────────────────────
module.exports = async (req, res) => {
  // 让 Vercel CDN 缓存约 15 分钟、并允许 1 小时内"先返回旧的再后台刷新"，
  // 这样不会每次打开都打上游，稳稳待在免费额度里。
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  let payload;
  let source = "live"; // live | fallback，仅用响应头标注，便于调试
  try {
    if (!process.env.FOOTBALL_API_KEY) throw new Error("未配置 FOOTBALL_API_KEY");
    const upstream = await fetchUpstream();
    payload = buildKnockout(upstream);
  } catch (err) {
    // 上游失败/超时/无 key → 回退骨架（时间/场馆/轮次照常，全部 tbd=true）
    source = "fallback";
    payload = SKELETON.map(blankSlot);
    console.error("[knockout] 回退骨架：", err && err.message);
  }

  res.setHeader("X-Knockout-Source", source);
  // 前端"只认"这个数组结构
  res.status(200).json(payload);
};
