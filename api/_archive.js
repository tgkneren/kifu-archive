import { createHash, randomBytes, randomUUID } from "node:crypto";

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
const supabasePublicGamesTable = process.env.SUPABASE_PUBLIC_GAMES_TABLE || "public_games";
const MAX_BODY_BYTES = 512 * 1024;
const MAX_SGF_BYTES = 300 * 1024;

function requireSupabaseArchive() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    const error = new Error("Public archive is not configured");
    error.statusCode = 503;
    throw error;
  }
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
  requireSupabaseArchive();
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

export async function listPublicGames() {
  const rows = await supabaseRequest("?hidden_at=is.null&select=*&order=created_at.desc");
  return rows.map(fromDbRecord);
}

export async function findPublicGameByPublicId(publicId) {
  const rows = await supabaseRequest(`?public_id=eq.${encodeURIComponent(publicId)}&hidden_at=is.null&select=*&limit=1`);
  return rows[0] ? fromDbRecord(rows[0]) : null;
}

export async function findPublicGameBySgfHash(sgfHash) {
  const rows = await supabaseRequest(`?sgf_hash=eq.${encodeURIComponent(sgfHash)}&select=*&limit=1`);
  return rows[0] ? fromDbRecord(rows[0]) : null;
}

export async function createPublicGame(record) {
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

export async function deletePublicGame(publicId, ownerTokenHash) {
  const rows = await supabaseRequest(
    `?public_id=eq.${encodeURIComponent(publicId)}&owner_token_hash=eq.${encodeURIComponent(ownerTokenHash)}`,
    {
      method: "DELETE",
      prefer: "return=representation",
    }
  );
  return rows.length > 0;
}

export async function deletePublicGameByOwner(publicId, ownerUserId) {
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

export async function requireAuthUser(request) {
  const authorization = request.headers.authorization || request.headers.Authorization || "";
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

export async function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
  if (Buffer.isBuffer(request.body)) return JSON.parse(request.body.toString("utf8") || "{}");
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
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

export function sendJson(response, status, payload) {
  response.status(status).json(payload);
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function sgfSignature(sgf) {
  return createHash("sha256").update(String(sgf || "").replace(/\s+/g, "").trim()).digest("hex");
}

export function makePublicId() {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

export function makeOwnerToken() {
  return randomBytes(32).toString("base64url");
}

export function makeRecordId() {
  return randomUUID();
}

export function cleanText(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

export function publicGameView(game) {
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

export function gameFromBody(body) {
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

export function isLikelySgf(text) {
  const value = String(text || "").trim();
  return value.startsWith("(") && value.includes("GM[1]") && value.includes("SZ[");
}

export function validatePublicGame(cleanGame) {
  if (!cleanGame.sgf.trim()) {
    const error = new Error("Missing SGF content");
    error.statusCode = 400;
    throw error;
  }
  if (Buffer.byteLength(cleanGame.sgf, "utf8") > MAX_SGF_BYTES) {
    const error = new Error("SGF is too large for public beta.");
    error.statusCode = 413;
    throw error;
  }
  if (!isLikelySgf(cleanGame.sgf)) {
    const error = new Error("Invalid SGF content");
    error.statusCode = 400;
    throw error;
  }
}
