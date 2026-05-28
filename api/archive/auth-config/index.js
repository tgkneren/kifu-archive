import { sendJson } from "../../_archive.js";

export default function handler(_request, response) {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  sendJson(response, 200, {
    configured: Boolean(supabaseUrl),
    supabaseUrl,
  });
}
