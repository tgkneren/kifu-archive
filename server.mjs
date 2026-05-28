import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(".");
await loadDotEnv(join(root, ".env"));
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "0.0.0.0";
const dataPath = join(root, "archive-data.json");
const tempDataPath = join(root, "archive-data.tmp.json");
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
const supabasePublicGamesTable = process.env.SUPABASE_PUBLIC_GAMES_TABLE || "public_games";
const MAX_BODY_BYTES = 512 * 1024;
const MAX_SGF_BYTES = 300 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_PUBLISHES = 20;
const publishRateLimits = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

async function loadDotEnv(path) {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const text = await readFile(path, "utf8");
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const index = trimmed.indexOf("=");
      if (index === -1) return;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed
        .slice(index + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    });
  } catch {
    // Local development can run without .env and falls back to archive-data.json.
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readArchiveData() {
  try {
    const data = JSON.parse(await readFile(dataPath, "utf8"));
    return { publicGames: Array.isArray(data.publicGames) ? data.publicGames : [] };
  } catch {
    return { publicGames: [] };
  }
}

async function writeArchiveData(data) {
  await writeFile(tempDataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempDataPath, dataPath);
}

function useSupabaseArchive() {
  return Boolean(supabaseUrl && supabaseServiceRoleKey);
}

function supabaseHeaders(prefer = "") {
  return {
    apikey: supabaseServiceRoleKey,
    authorization: `Bearer ${supabaseServiceRoleKey}`,
    "content-type": "application/json",
    ...(prefer ? { prefer } : {}),
  };
}

function toDbRecord(record, options = {}) {
  const row = {
    id: record.id,
    public_id: record.publicId,
    owner_token_hash: record.ownerTokenHash,
    owner_user_id: record.ownerUserId,
    owner_handle: record.ownerHandle,
    hidden_at: record.hiddenAt,
    hidden_by_user_id: record.hiddenByUserId,
    sgf_hash: record.sgfHash,
    title: record.title,
    black_player_name: record.blackPlayerName,
    white_player_name: record.whitePlayerName,
    date: record.date,
    board_size: record.boardSize,
    komi: record.komi,
    result: record.result,
    event: record.event,
    recorder_nickname: record.recorderNickname,
    notes: record.notes,
    sgf: record.sgf,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
  if (options.includeSharingFields !== false) {
    row.opponent_visibility = record.opponentVisibility;
    row.recorder_color = record.recorderColor;
  }
  return row;
}

function fromDbRecord(row) {
  return {
    id: row.id,
    publicId: row.public_id,
    ownerTokenHash: row.owner_token_hash,
    ownerUserId: row.owner_user_id,
    ownerHandle: row.owner_handle,
    hiddenAt: row.hidden_at,
    hiddenByUserId: row.hidden_by_user_id,
    sgfHash: row.sgf_hash,
    title: row.title,
    blackPlayerName: row.black_player_name,
    whitePlayerName: row.white_player_name,
    date: row.date,
    boardSize: row.board_size,
    komi: row.komi,
    result: row.result,
    event: row.event,
    opponentVisibility: row.opponent_visibility || "show",
    recorderColor: row.recorder_color || "",
    recorderNickname: row.recorder_nickname,
    notes: row.notes,
    sgf: row.sgf,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${supabasePublicGamesTable}${path}`, {
    ...options,
    headers: { ...supabaseHeaders(options.prefer), ...(options.headers || {}) },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || "Supabase request failed");
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function listPublicGames() {
  if (!useSupabaseArchive()) {
    const data = await readArchiveData();
    return data.publicGames.filter((game) => !game.hiddenAt);
  }
  const rows = await supabaseRequest("?hidden_at=is.null&select=*&order=created_at.desc");
  return rows.map(fromDbRecord);
}

async function findPublicGameByPublicId(publicId) {
  if (!useSupabaseArchive()) {
    const data = await readArchiveData();
    return data.publicGames.find((item) => item.publicId === publicId && !item.hiddenAt) || null;
  }
  const rows = await supabaseRequest(`?public_id=eq.${encodeURIComponent(publicId)}&hidden_at=is.null&select=*&limit=1`);
  return rows[0] ? fromDbRecord(rows[0]) : null;
}

async function findPublicGameBySgfHash(sgfHash) {
  if (!useSupabaseArchive()) {
    const data = await readArchiveData();
    return data.publicGames.find((item) => (item.sgfHash || sgfSignature(item.sgf)) === sgfHash) || null;
  }
  const rows = await supabaseRequest(`?sgf_hash=eq.${encodeURIComponent(sgfHash)}&select=*&limit=1`);
  return rows[0] ? fromDbRecord(rows[0]) : null;
}

async function createPublicGame(record) {
  if (!useSupabaseArchive()) {
    const data = await readArchiveData();
    data.publicGames.unshift(record);
    await writeArchiveData(data);
    return record;
  }
  let rows = null;
  try {
    rows = await supabaseRequest("", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify(toDbRecord(record)),
    });
  } catch (error) {
    const message = JSON.stringify(error.payload || {});
    const missingSharingColumns = message.includes("opponent_visibility") || message.includes("recorder_color");
    if (!missingSharingColumns) throw error;
    rows = await supabaseRequest("", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify(toDbRecord(record, { includeSharingFields: false })),
    });
  }
  return fromDbRecord(rows[0]);
}

async function deletePublicGame(publicId, ownerTokenHash) {
  if (!useSupabaseArchive()) {
    const data = await readArchiveData();
    const index = data.publicGames.findIndex((item) => item.publicId === publicId);
    if (index === -1) return false;
    data.publicGames.splice(index, 1);
    await writeArchiveData(data);
    return true;
  }
  const rows = await supabaseRequest(
    `?public_id=eq.${encodeURIComponent(publicId)}&owner_token_hash=eq.${encodeURIComponent(ownerTokenHash)}`,
    {
      method: "DELETE",
      prefer: "return=representation",
    }
  );
  return rows.length > 0;
}

async function deletePublicGameByOwner(publicId, ownerUserId) {
  if (!useSupabaseArchive()) {
    const data = await readArchiveData();
    const index = data.publicGames.findIndex((item) => item.publicId === publicId && item.ownerUserId === ownerUserId);
    if (index === -1) return false;
    data.publicGames[index] = { ...data.publicGames[index], hiddenAt: new Date().toISOString(), hiddenByUserId: ownerUserId };
    await writeArchiveData(data);
    return true;
  }
  const rows = await supabaseRequest(
    `?public_id=eq.${encodeURIComponent(publicId)}&owner_user_id=eq.${encodeURIComponent(ownerUserId)}`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: JSON.stringify({ hidden_at: new Date().toISOString(), hidden_by_user_id: ownerUserId }),
    }
  );
  return rows.length > 0;
}

async function requireAuthUser(request) {
  const authorization = request.headers.authorization || "";
  const token = String(authorization).replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    const error = new Error("Sign in required");
    error.statusCode = 401;
    throw error;
  }
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey || supabaseServiceRoleKey,
      authorization: `Bearer ${token}`,
    },
  });
  const user = await response.json().catch(() => null);
  if (!response.ok || !user?.id) {
    const error = new Error("Invalid sign-in session");
    error.statusCode = 401;
    throw error;
  }
  return user;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function clientKey(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function isRateLimited(request) {
  const key = clientKey(request);
  const now = Date.now();
  const bucket = publishRateLimits.get(key) ?? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  publishRateLimits.set(key, bucket);
  return bucket.count > RATE_LIMIT_MAX_PUBLISHES;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function sgfSignature(sgf) {
  return createHash("sha256").update(String(sgf || "").replace(/\s+/g, "").trim()).digest("hex");
}

function makePublicId() {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

function makeOwnerToken() {
  return randomBytes(32).toString("base64url");
}

function sgfMoveCount(sgf) {
  return (String(sgf || "").match(/;[BW]\s*\[/g) || []).length;
}

function cleanHandle(value, fallback) {
  const handle = String(value || "").trim().replace(/^@+/, "").replace(/[^\w.-]/g, "").slice(0, 32);
  if (handle) return `@${handle}`;
  const name = String(fallback || "").split("@")[0].replace(/[^\w.-]/g, "").slice(0, 24);
  return name ? `@${name}` : "@anonymous";
}

function cleanText(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

function publicGameView(game) {
  return {
    id: game.id,
    publicId: game.publicId,
    title: game.title,
    blackPlayerName: game.blackPlayerName,
    whitePlayerName: game.whitePlayerName,
    date: game.date,
    boardSize: game.boardSize,
    komi: game.komi,
    result: game.result,
    event: game.event,
    opponentVisibility: game.opponentVisibility,
    recorderColor: game.recorderColor,
    recorderNickname: game.recorderNickname,
    ownerHandle: game.ownerHandle,
    notes: game.notes,
    sgf: game.sgf,
    createdAt: game.createdAt,
    sourceType: "public",
    visibility: "public",
  };
}

function gameFromBody(body) {
  const game = body.game ?? {};
  const sgf = String(game.sgf || "");
  return {
    title: cleanText(game.title || "Untitled SGF record"),
    blackPlayerName: cleanText(game.blackPlayerName),
    whitePlayerName: cleanText(game.whitePlayerName),
    date: cleanText(game.date, 32),
    boardSize: cleanText(game.boardSize || "19x19", 16),
    komi: cleanText(game.komi, 24),
    result: cleanText(game.result, 40),
    event: cleanText(game.event, 120),
    opponentVisibility: game.opponentVisibility === "hidden" ? "hidden" : "show",
    recorderColor: ["black", "white"].includes(game.recorderColor) ? game.recorderColor : "",
    recorderNickname: cleanText(game.recorderNickname || "Anonymous recorder", 60),
    ownerHandle: cleanText(game.ownerHandle, 60),
    notes: cleanText(game.notes, 1000),
    sgf,
  };
}

function isLikelySgf(text) {
  const value = String(text || "").trim();
  return value.startsWith("(") && value.includes("GM[1]") && value.includes("SZ[");
}

async function serveIndex(response) {
  const body = await readFile(join(root, "index.html"));
  response.writeHead(200, { "content-type": types[".html"] });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);

  if (url.pathname === "/api/archive/public-games" && request.method === "GET") {
    try {
      let user = null;
      try {
        user = await requireAuthUser(request);
      } catch {
        user = null;
      }
      const games = await listPublicGames();
      sendJson(response, 200, {
        games: games.map((game) => ({
          ...publicGameView(game),
          ownedByCurrentUser: Boolean(user?.id && game.ownerUserId === user.id),
        })),
      });
    } catch {
      sendJson(response, 503, { error: "Public archive is unavailable" });
    }
    return;
  }

  if (url.pathname === "/api/archive/auth-config" && request.method === "GET") {
    sendJson(response, 200, {
      configured: Boolean(supabaseUrl),
      supabaseUrl,
    });
    return;
  }

  if (url.pathname === "/api/archive/me" && request.method === "GET") {
    try {
      const user = await requireAuthUser(request);
      sendJson(response, 200, {
        user: {
          id: user.id,
          email: user.email || "",
          name: user.user_metadata?.full_name || user.user_metadata?.name || "",
        },
      });
    } catch (error) {
      sendJson(response, error.statusCode || 401, { error: error.message || "Sign in required" });
    }
    return;
  }

  const publicGameMatch = url.pathname.match(/^\/api\/archive\/public-games\/([^/]+)$/);
  if (publicGameMatch && request.method === "GET") {
    const publicId = publicGameMatch[1];
    const game = await findPublicGameByPublicId(publicId);
    if (!game) {
      sendJson(response, 404, { error: "Public game not found" });
      return;
    }
    sendJson(response, 200, { game: publicGameView(game) });
    return;
  }

  if (url.pathname === "/api/archive/public-games" && request.method === "POST") {
    let cleanGame = null;
    try {
      if (isRateLimited(request)) {
        sendJson(response, 429, { error: "Publish limit reached. Try again later." });
        return;
      }
      const user = await requireAuthUser(request);
      const body = await readJsonBody(request);
      cleanGame = gameFromBody(body);
      if (!cleanGame.sgf.trim()) {
        sendJson(response, 400, { error: "Missing SGF content" });
        return;
      }
      if (Buffer.byteLength(cleanGame.sgf, "utf8") > MAX_SGF_BYTES) {
        sendJson(response, 413, { error: "SGF is too large for public beta." });
        return;
      }
      if (!isLikelySgf(cleanGame.sgf)) {
        sendJson(response, 400, { error: "Invalid SGF content" });
        return;
      }
      if (sgfMoveCount(cleanGame.sgf) < 2) {
        sendJson(response, 400, { error: "Play at least two moves before publishing." });
        return;
      }

      const cleanGameSignature = sgfSignature(cleanGame.sgf);
      const duplicate = await findPublicGameBySgfHash(cleanGameSignature);
      if (duplicate) {
        sendJson(response, 409, { error: "This SGF is already published.", game: publicGameView(duplicate) });
        return;
      }
      let publicId = makePublicId();
      while (await findPublicGameByPublicId(publicId)) publicId = makePublicId();
      const ownerToken = makeOwnerToken();
      const now = new Date().toISOString();
      const ownerHandle = cleanHandle(body.ownerHandle || cleanGame.ownerHandle || cleanGame.recorderNickname, user.email);
      const record = {
        id: randomUUID(),
        publicId,
        ownerTokenHash: hashToken(ownerToken),
        ownerUserId: user.id,
        ownerHandle,
        sgfHash: cleanGameSignature,
        ...cleanGame,
        recorderNickname: ownerHandle,
        ownerHandle,
        createdAt: now,
        updatedAt: now,
      };
      const created = await createPublicGame(record);
      sendJson(response, 201, { game: publicGameView(created) });
    } catch (error) {
      if (error.statusCode === 409) {
        const duplicate = cleanGame?.sgf ? await findPublicGameBySgfHash(sgfSignature(cleanGame.sgf)) : null;
        sendJson(response, 409, { error: "This SGF is already published.", ...(duplicate ? { game: publicGameView(duplicate) } : {}) });
        return;
      }
      sendJson(response, error.statusCode || 400, { error: error.message || (error.statusCode === 413 ? "Request body too large" : "Could not publish SGF") });
    }
    return;
  }

  if (publicGameMatch && request.method === "DELETE") {
    try {
      const publicId = publicGameMatch[1];
      const user = await requireAuthUser(request);
      const game = await findPublicGameByPublicId(publicId);
      if (!game) {
        sendJson(response, 404, { error: "Public game not found" });
        return;
      }
      if (game.ownerUserId && game.ownerUserId !== user.id) {
        sendJson(response, 403, { error: "Only the owner can unpublish this SGF" });
        return;
      }
      if (!game.ownerUserId) {
        sendJson(response, 403, { error: "This older record has no Google owner. Admin cleanup is required." });
        return;
      }
      await deletePublicGameByOwner(publicId, user.id);
      sendJson(response, 200, { deleted: true, publicId });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message || "Could not delete public game" });
    }
    return;
  }

  if (url.pathname.match(/^\/g\/[^/]+$/)) {
    try {
      await serveIndex(response);
    } catch {
      response.writeHead(500);
      response.end("Could not load app");
    }
    return;
  }

  const pathname = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  if (/^(archive-data|archive-data\.tmp)\.json$/.test(pathname) || /\.(log|exe)$/i.test(pathname)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const filePath = resolve(join(root, pathname));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}/`);
});
