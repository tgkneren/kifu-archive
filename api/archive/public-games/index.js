import {
  createPublicGame,
  findPublicGameByPublicId,
  findPublicGameBySgfHash,
  gameFromBody,
  listPublicGames,
  makeOwnerToken,
  makePublicId,
  publicGameView,
  readJsonBody,
  requireAuthUser,
  sendJson,
  sgfSignature,
  hashToken,
  makeRecordId,
  validatePublicGame,
} from "../../_archive.js";

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_PUBLISHES = 20;
const publishRateLimits = new Map();

function clientKey(request) {
  return String(request.headers["x-forwarded-for"] || request.headers["x-real-ip"] || "unknown").split(",")[0].trim();
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

function sgfMoveCount(sgf) {
  return (String(sgf || "").match(/;[BW]\s*\[/g) || []).length;
}

function cleanHandle(value, fallback) {
  const handle = String(value || "").trim().replace(/^@+/, "").replace(/[^\w.-]/g, "").slice(0, 32);
  if (handle) return `@${handle}`;
  const name = String(fallback || "").split("@")[0].replace(/[^\w.-]/g, "").slice(0, 24);
  return name ? `@${name}` : "@anonymous";
}

export default async function handler(request, response) {
  if (request.method === "GET") {
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

  if (request.method !== "POST") {
    response.setHeader("allow", "GET, POST");
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  let cleanGame = null;
  try {
    if (isRateLimited(request)) {
      sendJson(response, 429, { error: "Publish limit reached. Try again later." });
      return;
    }
    const user = await requireAuthUser(request);
    const body = await readJsonBody(request);
    cleanGame = gameFromBody(body);
    validatePublicGame(cleanGame);
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
      id: makeRecordId(),
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
    const status = error.statusCode || 400;
    const message = status === 413 ? "Request body too large" : error.message || "Could not publish SGF";
    sendJson(response, status, { error: message });
  }
}
