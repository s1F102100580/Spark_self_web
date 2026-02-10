// api/qbox.js
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  // キャッシュ無効（リアルタイム反映）
  res.setHeader("Cache-Control", "no-store");

  const UPSTASH_URL = process.env.KV_REST_API_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ ok: false, error: "KV env vars missing" });
  }

  // Upstash Redis REST 呼び出し
  async function upstash(command, ...args) {
    const path = [command, ...args].map(a => encodeURIComponent(String(a))).join("/");
    const url = `${UPSTASH_URL}/${path}`;

    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || `Upstash error: ${r.status}`);
    return data?.result;
  }

  // IPレート制限（荒れ対策の最低限）
  function getIP() {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
    return "unknown";
  }

  const ip = getIP();
  const rlKey = `qbox:rl:${ip}`;
  try {
    const count = await upstash("incr", rlKey);
    // 60秒でリセット
    if (count === 1) await upstash("expire", rlKey, 60);
    if (count > 8) {
      return res.status(429).json({ ok: false, error: "Too many requests. Try later." });
    }
  } catch (e) {
    // レート制限失敗は致命じゃないので続行
  }

  const listKey = "qbox:items";
  const promptId = (req.query?.promptId || "default").toString();

  // GET: 一覧取得
  if (req.method === "GET") {
    try {
      const raw = await upstash("lrange", listKey, 0, 99); // 最新100件
      const items = (raw || [])
        .map(s => {
          try { return JSON.parse(s); } catch { return null; }
        })
        .filter(Boolean)
        .filter(it => (it.promptId || "default") === promptId);

      return res.status(200).json({ ok: true, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

// POST: 投稿
if (req.method === "POST") {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const name = (body?.name || "").toString().trim().slice(0, 32);
    const song = (body?.song || "").toString().trim().slice(0, 80);
    const lyric = (body?.lyric || "").toString().trim().slice(0, 120);

    if (!song) return res.status(400).json({ ok: false, error: "song required" });
    if (!lyric) return res.status(400).json({ ok: false, error: "lyric required" });

    const item = {
      id: `q_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      promptId,
      name: name || "匿名",
      song,
      lyric,
      createdAt: new Date().toISOString(),
    };

    await upstash("lpush", listKey, JSON.stringify(item));
    await upstash("ltrim", listKey, 0, 199);

    return res.status(201).json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
}
