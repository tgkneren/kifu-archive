import {
  deletePublicGameByOwner,
  findPublicGameByPublicId,
  publicGameView,
  requireAuthUser,
  sendJson,
} from "../../_archive.js";

function publicIdFromRequest(request) {
  const direct = request.query?.publicId;
  if (Array.isArray(direct)) return direct[0];
  if (direct) return direct;
  const url = new URL(request.url || "", "http://localhost");
  return url.pathname.split("/").filter(Boolean).pop() || "";
}

export default async function handler(request, response) {
  const publicId = publicIdFromRequest(request);
  if (!publicId) {
    sendJson(response, 400, { error: "Missing public game id" });
    return;
  }

  if (request.method === "GET") {
    try {
      const game = await findPublicGameByPublicId(publicId);
      if (!game) {
        sendJson(response, 404, { error: "Public game not found" });
        return;
      }
      sendJson(response, 200, { game: publicGameView(game) });
    } catch {
      sendJson(response, 503, { error: "Public archive is unavailable" });
    }
    return;
  }

  if (request.method === "DELETE") {
    try {
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
      if (game.ownerUserId) {
        await deletePublicGameByOwner(publicId, user.id);
        sendJson(response, 200, { deleted: true, publicId });
        return;
      }
      sendJson(response, 403, { error: "This older record has no Google owner. Admin cleanup is required." });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message || "Could not delete public game" });
    }
    return;
  }

  response.setHeader("allow", "GET, DELETE");
  sendJson(response, 405, { error: "Method not allowed" });
}
