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
//  默认源：football-data.org (v4) —— 免费档(Free Tier)就包含 FIFA 世界杯(WC)，
//  且不像 API-Football 免费档那样把赛季锁在 2022–2024。免费档限速 10 次/分钟，
//  配合下方 CDN 缓存(约 15 分钟)绰绰有余。
//    注册拿 token：https://www.football-data.org/client/register
//
//  （历史：本来用 API-Football(api-sports.io)，但其免费档报
//    "Free plans do not have access to this season, try from 2022 to 2024."，
//    拿不到 2026，故改用 football-data.org。）
//
//  世界杯参数：
//    competition = "WC"  // football-data.org 里 FIFA 世界杯的竞赛代码
//    season      = 2026  // 2026 美加墨世界杯（按起始年份）
//
//  淘汰赛各 stage 名称（football-data.org 的 match.stage 字段）：
//    "LAST_32" / "LAST_16" / "QUARTER_FINALS" / "SEMI_FINALS" /
//    "THIRD_PLACE" / "FINAL"；小组赛是 "GROUP_STAGE"。
//    本函数只挑出下面 ROUND_TO_STAGE 里列出的淘汰赛 stage，其余自动忽略。
// ----------------------------------------------------------------------------
const API_CONFIG = {
  BASE_URL: "https://api.football-data.org/v4",
  COMPETITION: "WC",
  SEASON: 2026,
  TIMEOUT_MS: 4000, // 服务端自身超时，留在前端 5s 之内

  // 拼请求头（密钥从环境变量取）
  headers() {
    return { "X-Auth-Token": process.env.FOOTBALL_API_KEY || "" };
  },

  // 一次取该竞赛该赛季的全部比赛，本地再按 stage 过滤淘汰赛（省请求次数）。
  // 注：若该赛季尚未开放/报错，可去掉 ?season=2026 改用 currentSeason。
  fixturesUrl() {
    return `${this.BASE_URL}/competitions/${this.COMPETITION}/matches?season=${this.SEASON}`;
  },

  // 上游 stage 名称 → 前端使用的中文 stage（也是只保留淘汰赛的白名单）
  ROUND_TO_STAGE: {
    "LAST_32": "32强赛",
    "LAST_16": "16强赛",
    "QUARTER_FINALS": "1/4决赛",
    "SEMI_FINALS": "半决赛",
    "THIRD_PLACE": "季军赛",
    "FINAL": "决赛",
  },

  // 字段映射：上游 match 对象 → 我们关心的字段。集中在此方便换源。
  map: {
    round: (m) => m && m.stage,
    timestamp: (m) => (m && m.utcDate ? Math.floor(Date.parse(m.utcDate) / 1000) : 0),
    homeName: (m) => m && m.homeTeam && m.homeTeam.name,
    awayName: (m) => m && m.awayTeam && m.awayTeam.name,
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

    // football-data.org 出错时用 HTTP 状态码 + { message, errorCode }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error("上游 HTTP " + resp.status + (data && data.message ? "：" + data.message : ""));
    }

    const arr = (data && data.matches) || [];
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
