export const SESSION_COOKIE_NAME = "friendgpt_session";
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export function getSessionCookieOptions(environment = process.env) {
  const configuredSameSite = environment.SESSION_COOKIE_SAME_SITE?.toLowerCase();
  // Render's onrender.com hostnames are separate sites, so its default needs None.
  const sameSite = configuredSameSite || (environment.NODE_ENV === "production" ? "none" : "lax");
  if (!["lax", "strict", "none"].includes(sameSite)) {
    throw new Error("SESSION_COOKIE_SAME_SITE must be lax, strict, or none");
  }
  const secure = environment.NODE_ENV === "production" || sameSite === "none";
  return { httpOnly: true, secure, sameSite, path: "/" };
}
