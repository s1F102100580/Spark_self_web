// api/qbox.js
import crypto from "crypto";
function safeEq(a, b){
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getAdminToken(req){
  // 優先: x-admin-token
  const t = req.headers["x-admin-token"];
  if (typeof t === "string" && t) return t.trim();

  // 予備: Authorization: Bearer xxx
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function isAdmin(req){
  const serverToken = process.env.ADMIN_TOKEN || "";
  if (!serverToken) return false;
  const clientToken = getAdminToken(req);
  return safeEq(clientToken, serverToken);
}


function sha256(s){
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const UPSTASH_URL = process.env.KV_REST_API_URL;
  const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ ok: false, error: "KV env vars missing" });
  }

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

  // IPレート制限（荒れ対策）
  function getIP() {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
    return "unknown";
  }
  const ip = getIP();
  const rlKey = `qbox:rl:${ip}`;
  try {
    const count = await upstash("incr", rlKey);
    if (count === 1) await upstash("expire", rlKey, 60);
    if (count > 12) return res.status(429).json({ ok: false, error: "Too many requests. Try later." });
  } catch {}

  const listKey = "qbox:items";
  const promptId = (req.query?.promptId || "default").toString();

  // 共通：一覧から id を探して、index/rawStr/item を返す
  async function findById(id){
    const raw = await upstash("lrange", listKey, 0, 199); // 200件
    const arr = raw || [];
    for (let i = 0; i < arr.length; i++){
      const s = arr[i];
      try{
        const it = JSON.parse(s);
        if (it && it.id === id) return { index: i, rawStr: s, item: it };
      } catch {}
    }
    return null;
  }

  // GET: 一覧取得（deleteKeyHashは返さない）
  if (req.method === "GET") {
    try {
      const raw = await upstash("lrange", listKey, 0, 99);
      const items = (raw || [])
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean)
        .filter(it => (it.promptId || "default") === promptId)
        .map(({ deleteKeyHash, ...rest }) => rest);

      return res.status(200).json({ ok: true, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // POST: 投稿（deleteKey を1回だけ返す）
if (req.method === "POST") {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // ★ 追加：promptIdの整合チェック（任意だけど強い）
    const bodyPromptId = (body?.promptId || "").toString();
    if (bodyPromptId && bodyPromptId !== promptId) {
      return res.status(400).json({ ok: false, error: "promptId mismatch" });
    }

    const name = (body?.name || "").toString().trim().slice(0, 32);

    const deleteKey = crypto.randomBytes(16).toString("hex");
    const deleteKeyHash = sha256(deleteKey);

    // ★ 本音（answer）があるなら honne として保存
    const answer = (body?.answer || "").toString().trim().slice(0, 120);
    if (answer) {
      const item = {
        id: `q_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        promptId,
        name: name || "匿名",
        answer,
        createdAt: new Date().toISOString(),
        deleteKeyHash,
      };

      await upstash("lpush", listKey, JSON.stringify(item));
      await upstash("ltrim", listKey, 0, 199);

      const { deleteKeyHash: _, ...safeItem } = item;
      return res.status(201).json({ ok: true, item: { ...safeItem, deleteKey } });
    }

    // ★ それ以外は歌詞箱
    const artist = (body?.artist || "").toString().trim();
    const song   = (body?.song || "").toString().trim().slice(0, 80);
    const lyric  = (body?.lyric || "").toString().trim().slice(0, 120);

    const allowedArtists = new Set(["Gum-9", "Fish and Lips", "らそんぶる"]);
    if (!allowedArtists.has(artist)) return res.status(400).json({ ok: false, error: "artist required" });
    if (!song) return res.status(400).json({ ok: false, error: "song required" });
    if (!lyric) return res.status(400).json({ ok: false, error: "lyric required" });

    const item = {
      id: `q_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      promptId,
      name: name || "匿名",
      artist,
      song,
      lyric,
      createdAt: new Date().toISOString(),
      deleteKeyHash,
    };

    await upstash("lpush", listKey, JSON.stringify(item));
    await upstash("ltrim", listKey, 0, 199);

    const { deleteKeyHash: _, ...safeItem } = item;
    return res.status(201).json({ ok: true, item: { ...safeItem, deleteKey } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

  // DELETE: 自分の投稿を削除（deleteKey 必須）
// + 管理者は deleteKey なしで削除OK
if (req.method === "DELETE") {
  try {
    const id = (req.query?.id || "").toString();
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const hit = await findById(id);
    if (!hit) return res.status(404).json({ ok: false, error: "not found" });

    if ((hit.item.promptId || "default") !== promptId) {
      return res.status(400).json({ ok: false, error: "promptId mismatch" });
    }

    const admin = isAdmin(req);

    if (!admin) {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const deleteKey = (body?.deleteKey || "").toString().trim();
      if (!deleteKey) return res.status(400).json({ ok: false, error: "deleteKey required" });

      const hash = sha256(deleteKey);
      if (hash !== hit.item.deleteKeyHash) {
        return res.status(403).json({ ok: false, error: "invalid deleteKey" });
      }
    }

    const removed = await upstash("lrem", listKey, 1, hit.rawStr);
    return res.status(200).json({ ok: true, removed, admin });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

  // PUT: 自分の投稿を編集（deleteKey 必須）
if (req.method === "PUT") {
  try {
    const id = (req.query?.id || "").toString();
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const deleteKey = (body?.deleteKey || "").toString().trim();
    if (!deleteKey) return res.status(400).json({ ok: false, error: "deleteKey required" });

    const hit = await findById(id);
    if (!hit) return res.status(404).json({ ok: false, error: "not found" });

    if ((hit.item.promptId || "default") !== promptId) {
      return res.status(400).json({ ok: false, error: "promptId mismatch" });
    }

    const hash = sha256(deleteKey);
    if (hash !== hit.item.deleteKeyHash) {
      return res.status(403).json({ ok: false, error: "invalid deleteKey" });
    }

    const name = (body?.name || "").toString().trim().slice(0, 32);

    // ★ 本音編集（answerがあれば）
    const answer = (body?.answer || "").toString().trim().slice(0, 120);
    if (answer) {
      const updated = {
        ...hit.item,
        name: name || "匿名",
        answer,
        updatedAt: new Date().toISOString(),
      };
      await upstash("lset", listKey, hit.index, JSON.stringify(updated));
      const { deleteKeyHash, ...safe } = updated;
      return res.status(200).json({ ok: true, item: safe });
    }

    // ★ 歌詞編集
    const artist = (body?.artist || "").toString().trim();
    const song   = (body?.song || "").toString().trim().slice(0, 80);
    const lyric  = (body?.lyric || "").toString().trim().slice(0, 120);

    const allowedArtists = new Set(["Gum-9", "Fish and Lips", "らそんぶる"]);
    if (!allowedArtists.has(artist)) return res.status(400).json({ ok: false, error: "artist required" });
    if (!song) return res.status(400).json({ ok: false, error: "song required" });
    if (!lyric) return res.status(400).json({ ok: false, error: "lyric required" });

    const updated = {
      ...hit.item,
      name: name || "匿名",
      artist, // ★ これ、今のコードだと更新してないので入れた方が綺麗
      song,
      lyric,
      updatedAt: new Date().toISOString(),
    };

    await upstash("lset", listKey, hit.index, JSON.stringify(updated));
    const { deleteKeyHash, ...safe } = updated;
    return res.status(200).json({ ok: true, item: safe });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
}
