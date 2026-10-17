const requestTimeoutMs = 120_000;

function getConfig() {
  const serviceUrl = process.env.SANDBOX_SERVICE_URL;
  const serviceToken = process.env.SANDBOX_SERVICE_TOKEN;
  const previewBase = process.env.SANDBOX_PREVIEW_BASE_URL;
  if (!serviceUrl || !serviceToken || serviceToken.length < 32 || !previewBase) {
    throw Object.assign(new Error("Secure project preview is not configured. Contact the administrator."), { statusCode: 503 });
  }
  let service;
  let preview;
  try {
    service = new URL(serviceUrl);
    preview = new URL(previewBase);
  } catch {
    throw Object.assign(new Error("Secure project preview is not configured. Contact the administrator."), { statusCode: 503 });
  }
  const frontendOrigins = (process.env.FRONTEND_ORIGIN || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (
    service.username || service.password || preview.username || preview.password || service.pathname !== "/" || preview.pathname !== "/" ||
    (process.env.NODE_ENV === "production" && (service.protocol !== "https:" || preview.protocol !== "https:" || frontendOrigins.includes(preview.origin)))
  ) {
    throw Object.assign(new Error("Secure project preview is not configured. Contact the administrator."), { statusCode: 503 });
  }
  return { serviceUrl: service.origin, serviceToken, previewBase: preview.origin };
}

export async function callSandbox(method, path, body, { timeoutMs = requestTimeoutMs } = {}) {
  let config;
  try { config = getConfig(); } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error("Secure project preview is not configured. Contact the administrator."), { statusCode: 503 });
  }
  const { serviceUrl, serviceToken } = config;
  let response;
  try {
    response = await fetch(new URL(path, `${serviceUrl}/`), {
      method,
      headers: { Authorization: `Bearer ${serviceToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw Object.assign(new Error("The isolated preview service is temporarily unavailable."), { statusCode: 503, cause: error });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const statusCode = response.status === 400 || response.status === 429 ? response.status : 502;
    const safeBuildError = response.status === 422 && typeof result?.error === "string" ? result.error.slice(0, 300) : "The isolated preview service could not process this project.";
    throw Object.assign(new Error(statusCode === 400 ? "Project files are not supported by the preview service." : safeBuildError), { statusCode: response.status === 422 ? 422 : statusCode });
  }
  return result;
}

export function getPreviewUrl(previewToken) {
  if (!/^[a-f0-9]{64}$/.test(previewToken || "")) return null;
  return `${getConfig().previewBase}/p/${previewToken}/`;
}
