import { requireAuthUser, sendJson } from "../../_archive.js";

export default async function handler(request, response) {
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
}
