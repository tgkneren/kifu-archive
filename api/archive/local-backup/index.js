import {
  getLocalArchiveBackup,
  readBackupJsonBody,
  requireAuthUser,
  saveLocalArchiveBackup,
  sendJson,
} from "../../_archive.js";

function cleanBackupRecord(record) {
  if (!record || typeof record !== "object" || typeof record.sgf !== "string" || !record.sgf.trim()) return null;
  return {
    ...record,
    localArchiveId: String(record.localArchiveId || ""),
    title: String(record.title || "Imported SGF").slice(0, 160),
    event: String(record.event || "").slice(0, 160),
    round: String(record.round || "").slice(0, 80),
    date: String(record.date || "").slice(0, 40),
    result: String(record.result || "").slice(0, 40),
    visibility: ["private", "unlisted", "public"].includes(record.visibility) ? record.visibility : "private",
    opponentVisibility: record.opponentVisibility === "hidden" ? "hidden" : "show",
    recorderColor: ["black", "white"].includes(record.recorderColor) ? record.recorderColor : "",
    boardSize: String(record.boardSize || "19x19").slice(0, 20),
    recorderNickname: String(record.recorderNickname || "Anonymous recorder").slice(0, 120),
    sgf: record.sgf,
    sourceType: "local",
    savedAt: record.savedAt || new Date().toISOString(),
  };
}

function cleanRecords(records) {
  if (!Array.isArray(records)) {
    const error = new Error("Archive backup records must be an array");
    error.statusCode = 400;
    throw error;
  }
  if (records.length > 2000) {
    const error = new Error("Archive backup has too many records");
    error.statusCode = 413;
    throw error;
  }
  return records.map(cleanBackupRecord).filter(Boolean);
}

export default async function handler(request, response) {
  try {
    const user = await requireAuthUser(request);

    if (request.method === "GET") {
      const backup = await getLocalArchiveBackup(user.id);
      sendJson(response, 200, {
        records: backup?.records || [],
        updatedAt: backup?.updatedAt || null,
      });
      return;
    }

    if (request.method === "PUT") {
      const body = await readBackupJsonBody(request);
      const records = cleanRecords(body.records);
      const backup = await saveLocalArchiveBackup(user.id, records);
      sendJson(response, 200, {
        records: backup?.records || records,
        updatedAt: backup?.updatedAt || new Date().toISOString(),
        count: records.length,
      });
      return;
    }

    response.setHeader("allow", "GET, PUT");
    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    const status = error.statusCode || 500;
    const message = status === 413 ? "Archive backup is too large" : error.message || "Could not manage archive backup";
    sendJson(response, status, { error: message });
  }
}
