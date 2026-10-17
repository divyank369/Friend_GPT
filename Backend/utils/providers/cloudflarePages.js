const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const MAX_PROVIDER_REQUEST_MS = 20_000;

function cloudflareConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !/^[a-f0-9]{16,32}$/i.test(accountId) || !token || token.length < 20) {
    throw Object.assign(new Error("Website publishing is not configured. Contact the administrator."), { statusCode: 503 });
  }
  return { accountId, token };
}

function pagesProjectName(id) {
  return `sg-${id.replace(/[^a-f0-9]/gi, "").slice(0, 32).toLowerCase()}`;
}

async function request(path, { token, method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(MAX_PROVIDER_REQUEST_MS)
    });
  } catch (error) {
    throw Object.assign(new Error(error.name === "TimeoutError" ? "The hosting provider request timed out." : "The hosting provider is temporarily unavailable."), { statusCode: 502 });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.success === false) {
    const error = Object.assign(new Error(response.status === 429 ? "The hosting provider is rate limiting requests." : "The hosting provider rejected this deployment."), { statusCode: response.status === 429 ? 429 : 502 });
    error.providerStatus = response.status;
    throw error;
  }
  return result?.result;
}

function contentTypeFor(filePath) {
  const ext = filePath.split(".").pop().toLowerCase();
  return ({ html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", txt: "text/plain", xml: "application/xml", wasm: "application/wasm" })[ext] || "application/octet-stream";
}

export function createCloudflarePagesAdapter() {
  const { accountId, token } = cloudflareConfig();
  const encodedAccount = encodeURIComponent(accountId);
  const projectPath = (name) => `/accounts/${encodedAccount}/pages/projects/${encodeURIComponent(name)}`;

  async function ensureProject(name) {
    try {
      const existing = await request(projectPath(name), { token });
      if (existing?.name !== name) throw new Error("The hosting provider returned an invalid Pages project.");
    } catch (error) {
      if (error.providerStatus !== 404) throw error;
      try {
        const created = await request(projectPath(name), { token, method: "POST", body: { name, production_branch: "main" } });
        if (created?.name !== name) throw new Error("The hosting provider returned an invalid Pages project.");
      } catch (createError) {
        if (createError.providerStatus !== 409) throw createError;
        const existing = await request(projectPath(name), { token });
        if (existing?.name !== name) throw new Error("The hosting provider returned an invalid Pages project.");
      }
    }
  }

  return {
    name: "cloudflare-pages",
    projectName: pagesProjectName,
    async deploy(name, files) {
      await ensureProject(name);
      const uploadTokenResult = await request(`${projectPath(name)}/upload-token`, { token });
      if (typeof uploadTokenResult?.jwt !== "string" || uploadTokenResult.jwt.length < 20) throw new Error("The hosting provider did not issue a valid upload token.");
      const jwt = uploadTokenResult.jwt;
      const assets = files.map((file) => ({ ...file, contentType: file.contentType || contentTypeFor(file.path) }));
      const missingResult = await request("/pages/assets/check-missing", { token: jwt, body: { hashes: assets.map((file) => file.hash) } });
      if (!Array.isArray(missingResult) && !Array.isArray(missingResult?.missing)) throw new Error("The hosting provider returned an invalid asset response.");
      const missing = new Set(Array.isArray(missingResult) ? missingResult : missingResult.missing);
      for (let offset = 0; offset < assets.length; offset += 20) {
        const batch = assets.slice(offset, offset + 20).filter((file) => missing.has(file.hash));
        if (!batch.length) continue;
        const upload = await request("/pages/assets/upload", {
          token: jwt,
          body: batch.map((file) => ({ key: file.hash, value: file.content, base64: true, metadata: { contentType: file.contentType } }))
        });
        if (upload?.success === false) throw new Error("The hosting provider could not upload the production assets.");
      }
      const manifest = Object.fromEntries(assets.map((file) => [file.path, file.hash]));
      if (Object.keys(manifest).length !== assets.length) throw new Error("The production build has duplicate asset paths.");
      const form = new FormData();
      form.set("branch", "main");
      form.set("commit_dirty", "false");
      form.set("manifest", JSON.stringify(manifest));
      let response;
      try {
        response = await fetch(`${API_ORIGIN}${projectPath(name)}/deployments`, {
          method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
          signal: AbortSignal.timeout(MAX_PROVIDER_REQUEST_MS)
        });
      } catch (error) {
        throw Object.assign(new Error(error.name === "TimeoutError" ? "The hosting provider request timed out." : "The hosting provider is temporarily unavailable."), { statusCode: 502 });
      }
      const envelope = await response.json().catch(() => null);
      const result = envelope?.result;
      if (!response.ok || envelope?.success !== true || !result || typeof result.id !== "string" || !/^[a-f0-9-]{20,}$/i.test(result.id)) {
        throw Object.assign(new Error(response.status === 429 ? "The hosting provider is rate limiting requests." : "The hosting provider did not confirm deployment creation."), { statusCode: response.status === 429 ? 429 : 502 });
      }
      const urls = [...(Array.isArray(result.aliases) ? result.aliases : []), result.url].filter((url) => typeof url === "string");
      const publicUrl = urls.find((url) => {
        try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === `${name}.pages.dev`; } catch { return false; }
      }) || urls.find((url) => { try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname.endsWith(".pages.dev"); } catch { return false; } });
      if (!publicUrl) throw new Error("The hosting provider did not return a valid public website URL.");
      return { id: result.id, publicUrl, status: result.latest_stage?.status || result.status || "deploying" };
    },
    async status(name, id) {
      const result = await request(`${projectPath(name)}/deployments/${encodeURIComponent(id)}`, { token });
      if (!result || result.id !== id) throw new Error("The hosting provider returned an invalid deployment status.");
      const urls = [...(Array.isArray(result.aliases) ? result.aliases : []), result.url].filter((url) => typeof url === "string");
      const publicUrl = urls.find((url) => { try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === `${name}.pages.dev`; } catch { return false; } })
        || urls.find((url) => { try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname.endsWith(".pages.dev"); } catch { return false; } });
      return { status: result.latest_stage?.status || result.status || "deploying", publicUrl };
    },
    async deleteDeployment(name, id) {
      const result = await request(`${projectPath(name)}/deployments/${encodeURIComponent(id)}`, { token, method: "DELETE" });
      if (result?.id && result.id !== id) throw new Error("The hosting provider returned an invalid deletion response.");
      return { deleted: true };
    }
  };
}
