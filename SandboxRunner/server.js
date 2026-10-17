import http from "node:http";
import net from "node:net";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, chmod, chown, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runDocker } from "./dockerCommand.js";

const PORT = Number(process.env.PORT || 8090);
const API_TOKEN = process.env.SANDBOX_SERVICE_TOKEN || "";
const DATA_DIR = process.env.SANDBOX_DATA_DIR || path.join(tmpdir(), "sigmagpt-sandboxes");
const NODE_IMAGE = process.env.SANDBOX_NODE_IMAGE || "node:22-alpine";
const publicPreviewUrl = new URL(process.env.SANDBOX_PUBLIC_ORIGIN || "http://localhost:8090");
if (publicPreviewUrl.username || publicPreviewUrl.password || publicPreviewUrl.pathname !== "/" || (process.env.NODE_ENV === "production" && publicPreviewUrl.protocol !== "https:")) {
  throw new Error("SANDBOX_PUBLIC_ORIGIN must be a dedicated HTTPS origin in production");
}
const frameOrigins = (process.env.SANDBOX_FRAME_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || !["https:", "http:"].includes(url.protocol)) throw new Error("SANDBOX_FRAME_ORIGINS must contain only HTTP or HTTPS origins");
  return url.origin;
});
if (process.env.NODE_ENV === "production" && frameOrigins.length === 0) throw new Error("Configure SANDBOX_FRAME_ORIGINS for the SigmaGPT frontend");
const previewSocketOrigin = `${publicPreviewUrl.protocol === "https:" ? "wss:" : "ws:"}//${publicPreviewUrl.host}`;
const previewCsp = `default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' ${publicPreviewUrl.origin} ${previewSocketOrigin}; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors ${frameOrigins.length ? frameOrigins.join(" ") : "'none'"}`;
const MAX_FILE_BYTES = 30000;
const MAX_TOTAL_BYTES = 180000;
const SESSION_TTL_MS = 20 * 60 * 1000;
const MAX_SESSIONS = 4;
const sessions = new Map();
const deploymentBuilds = new Set();
function cleanLog(value) {
  return String(value || "")
    .replace(/(?:Bearer\s+)[\w.-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password|authorization|credential|auth)(\s*[=:]\s*)[^\s,;"']+/gi, "$1$2[redacted]")
    .replace(/\/workspace\/([A-Za-z0-9_./-]+)/g, "$1")
    .replace(/(?:\/[^\s:]+){2,}/g, "[sandbox path]")
    .slice(-8000);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!API_TOKEN || !req.headers.authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(req.headers.authorization.slice(7));
  const expected = Buffer.from(API_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(req, limit = 1_000_000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw Object.assign(new Error("Request is too large"), { status: 413 });
  }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

const packageAllowlist = new Set(["react", "react-dom", "vite", "@vitejs/plugin-react"]);
const extensions = new Set([".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".svg"]);

function normalizeProject(project) {
  if (!project || project.projectType !== "react-vite" || !Array.isArray(project.files) || project.files.length < 1 || project.files.length > 30) {
    throw Object.assign(new Error("Unsupported React + Vite project"), { status: 400 });
  }
  const files = [];
  let total = 0;
  const paths = new Set();
  for (const file of project.files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw Object.assign(new Error("Invalid project file"), { status: 400 });
    const parts = file.path.split("/");
    if (file.path.length > 180 || file.path.includes("\\") || file.path.startsWith("/") || /^[a-z]:/i.test(file.path) || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === "node_modules" || part.toLowerCase() === ".git") || !extensions.has(path.posix.extname(file.path).toLowerCase()) || paths.has(file.path)) {
      throw Object.assign(new Error("Unsafe project file path"), { status: 400 });
    }
    const bytes = Buffer.byteLength(file.content);
    if (bytes > MAX_FILE_BYTES || (total += bytes) > MAX_TOTAL_BYTES) throw Object.assign(new Error("Project size limit exceeded"), { status: 400 });
    paths.add(file.path);
    files.push({ path: file.path, content: file.content });
  }
  const manifestFile = files.find(({ path: filePath }) => filePath === "package.json");
  if (!manifestFile || !files.some(({ path: filePath }) => filePath === "index.html")) throw Object.assign(new Error("React + Vite manifest or index.html is missing"), { status: 400 });
  let manifest;
  try { manifest = JSON.parse(manifestFile.content); } catch { throw Object.assign(new Error("Invalid package.json"), { status: 400 }); }
  const requested = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
  if (Object.keys(requested).some((name) => !packageAllowlist.has(name)) || Object.values(requested).some((version) => typeof version !== "string" || !/^[~^]?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))) {
    throw Object.assign(new Error("Unsupported dependency list"), { status: 400 });
  }
  if (!requested.vite || !requested.react || !requested["react-dom"]) throw Object.assign(new Error("React, React DOM, and Vite are required"), { status: 400 });
  const dependencies = Object.fromEntries(Object.entries(requested).sort(([a], [b]) => a.localeCompare(b)));
  const packageJson = JSON.stringify({ name: "generated-preview", version: "1.0.0", private: true, type: "module", scripts: { dev: "vite --host 0.0.0.0 --port 4173 --strictPort" }, dependencies }, null, 2);
  return files.map((file) => file.path === "package.json" ? { ...file, content: packageJson } : file);
}

async function writeProject(files) {
  const folder = await mkdtemp(path.join(DATA_DIR, "project-"));
  try {
    try {
      await chown(folder, 1000, 1000);
      await chmod(folder, 0o700);
    } catch { /* The service should run with a filesystem that supports container UID ownership. */ }
    for (const file of files) {
      const target = path.resolve(folder, ...file.path.split("/"));
      if (!target.startsWith(`${folder}${path.sep}`)) throw Object.assign(new Error("Unsafe project file path"), { status: 400 });
      const parent = path.dirname(target);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      try { await chown(parent, 1000, 1000); } catch {}
      await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
      try { await chown(target, 1000, 1000); } catch {}
    }
    return folder;
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function sessionInfo(session) {
  return { status: session.status, ...(session.error ? { error: session.error } : {}), ...(session.diagnostics ? { diagnostics: session.diagnostics } : {}) };
}

async function buildAndRun(session) {
  session.phase = "dependencies";
  try {
    const network = process.env.SANDBOX_BUILD_NETWORK || "sigmagpt-build-egress";
    const buildName = `sg-build-${session.id}`;
    const moduleVolume = `sg-modules-${session.id}`;
    session.moduleVolume = moduleVolume;
    await runDocker(["volume", "create", "--driver", "local", "--label", `sigmagpt.session=${session.id}`,
      "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", "o=size=512m,uid=1000,gid=1000,mode=0755", moduleVolume], { timeout: 10_000 });
    const buildArgs = ["run", "--rm", "--name", buildName, "--label", "sigmagpt.session=" + session.id,
      "--network", network, "--memory=512m", "--cpus=0.75", "--pids-limit=64", "--security-opt=no-new-privileges",
      "--cap-drop=ALL", "--user=1000:1000", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs", "/home/node/.npm:rw,noexec,nosuid,size=96m", "-v", `${session.folder}:/workspace:rw`, "--mount", `type=volume,src=${moduleVolume},dst=/workspace/node_modules`, "-w", "/workspace", NODE_IMAGE,
      "npm", "install", "--registry=http://sandbox-runner:8090/npm/", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", "--no-save"];
    await runDocker(buildArgs, { timeout: 90_000, onChild: (child) => {
      session.child = child;
      session.childClosed = new Promise((resolve) => child.once("close", resolve));
    } });
    session.child = null;
    session.childClosed = null;
    if (session.stopping) return;

    session.phase = "runtime";
    const runtimeName = `sg-preview-${session.id}`;
    const runtimeArgs = ["run", "-d", "--name", runtimeName, "--label", "sigmagpt.session=" + session.id,
      "--network", process.env.SANDBOX_PREVIEW_NETWORK || "sigmagpt-preview-internal", "--publish", "127.0.0.1::4173",
      "--memory=512m", "--cpus=0.75", "--pids-limit=64", "--security-opt=no-new-privileges", "--cap-drop=ALL", "--user=1000:1000",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "-v", `${session.folder}:/workspace:ro`, "--mount", `type=volume,src=${moduleVolume},dst=/workspace/node_modules,readonly`, "-w", "/workspace", NODE_IMAGE,
      "npm", "run", "dev", "--", "--base", `/p/${session.previewToken}/`];
    await runDocker(runtimeArgs, { timeout: 12_000, onChild: (child) => {
      session.child = child;
      session.childClosed = new Promise((resolve) => child.once("close", resolve));
    } });
    session.child = null;
    session.childClosed = null;
    if (session.stopping) return;
    session.container = runtimeName;
    const mapping = await runDocker(["port", runtimeName, "4173/tcp"], { timeout: 5000 });
    const match = mapping.match(/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error("No private preview port was allocated");
    session.port = Number(match[1]);

    const readyDeadline = Date.now() + 30_000;
    while (!session.stopping && Date.now() < readyDeadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${session.port}/`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { session.status = "running"; return; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!session.stopping) throw new Error("Preview server readiness timed out");
  } catch (error) {
    if (session.stopping) return;
    session.status = "failed";
    session.diagnostics = {
      category: session.phase === "dependencies" ? "dependencies" : "runtime",
      message: session.phase === "dependencies" ? "Dependency installation failed." : (error?.timedOut ? "The preview exceeded its build or startup time limit." : "The preview server could not start."),
      logs: cleanLog(error?.output || error?.message || "")
    };
    session.error = error?.timedOut ? "The project exceeded its build time limit." : "The isolated project could not be built or started.";
    await Promise.all([
      runDocker(["rm", "-f", `sg-build-${session.id}`], { timeout: 10_000 }).catch(() => {}),
      runDocker(["rm", "-f", `sg-preview-${session.id}`], { timeout: 10_000 }).catch(() => {})
    ]);
    await runDocker(["volume", "rm", "-f", `sg-modules-${session.id}`], { timeout: 10_000 }).catch(() => {});
    await rm(session.folder, { recursive: true, force: true }).catch(() => {});
    session.folder = null;
  } finally {
    session.child = null;
  }
}

async function stopSession(session, status = "stopped") {
  session.stopping = true;
  session.previewToken = "";
  if (session.child) session.child.kill("SIGKILL");
  if (session.childClosed) await Promise.race([session.childClosed, new Promise((resolve) => setTimeout(resolve, 1500))]);
  await Promise.all([
    runDocker(["rm", "-f", `sg-build-${session.id}`], { timeout: 10_000 }).catch(() => {}),
    runDocker(["rm", "-f", `sg-preview-${session.id}`], { timeout: 10_000 }).catch(() => {})
  ]);
  await runDocker(["volume", "rm", "-f", `sg-modules-${session.id}`], { timeout: 10_000 }).catch(() => {});
  await rm(session.folder, { recursive: true, force: true }).catch(() => {});
  session.status = status;
  session.port = null;
}

async function proxyNpmRegistry(req, res, url) {
  if (!["GET", "HEAD"].includes(req.method) || !url.pathname.startsWith("/npm/")) return false;
  const suffix = url.pathname.slice("/npm/".length);
  if (!suffix || suffix.includes("\\") || suffix.split("/").some((part) => part === "..")) {
    send(res, 400, { error: "Invalid registry path" });
    return true;
  }
  let target = new URL(`https://registry.npmjs.org/${suffix}${url.search}`);
  if (target.origin !== "https://registry.npmjs.org") { send(res, 400, { error: "Invalid registry path" }); return true; }
  try {
    let upstream;
    for (let redirect = 0; redirect < 4; redirect += 1) {
      upstream = await fetch(target, {
        method: req.method,
        headers: { accept: req.headers.accept || "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000)
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get("location");
      if (!location) throw new Error("Invalid package registry response");
      const redirected = new URL(location, target);
      if (redirected.protocol !== "https:" || redirected.hostname !== "registry.npmjs.org") throw new Error("Registry redirect is outside the allowlist");
      target = redirected;
    }
    const headers = {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    };
    if (req.method === "HEAD") { res.writeHead(upstream.status, headers); res.end(); return true; }
    if (headers["Content-Type"].includes("json") && upstream.ok) {
      const text = await upstream.text();
      if (Buffer.byteLength(text) > 8_000_000) { send(res, 502, { error: "Registry metadata is too large" }); return true; }
      const rewritten = text.replaceAll("https://registry.npmjs.org/", "http://sandbox-runner:8090/npm/");
      headers["Content-Length"] = String(Buffer.byteLength(rewritten));
      res.writeHead(upstream.status, headers);
      res.end(rewritten);
      return true;
    }
    res.writeHead(upstream.status, headers);
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch {
    send(res, 502, { error: "Package registry request failed" });
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://sandbox.local");
  if (url.pathname === "/health") return send(res, 200, { status: "ok" });
  if (url.pathname.startsWith("/p/")) return proxyPreview(req, res, url);
  if (await proxyNpmRegistry(req, res, url)) return;
  if (!authorized(req)) return send(res, 401, { error: "Authentication required" });
  if (req.method === "POST" && url.pathname === "/v1/sessions") {
    try {
      const body = await readJson(req);
      if (!/^[0-9a-f-]{36}$/.test(body.sessionId || "") || !/^[0-9a-f]{64}$/.test(body.previewToken || "") || sessions.has(body.sessionId)) return send(res, 400, { error: "Invalid project session" });
      if ([...sessions.values()].filter((session) => ["building", "running"].includes(session.status)).length >= MAX_SESSIONS) return send(res, 429, { error: "Preview capacity is temporarily full" });
      const files = normalizeProject(body.project);
      await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
      const folder = await writeProject(files);
      const session = { id: body.sessionId, previewToken: body.previewToken, folder, status: "building", createdAt: Date.now(), port: null, stopping: false };
      sessions.set(session.id, session);
      void buildAndRun(session);
      return send(res, 202, sessionInfo(session));
    } catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : "The isolated runner could not accept the project." }); }
  }
  const buildMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]{36})\/build$/);
  if (buildMatch && req.method === "POST") {
    const session = sessions.get(buildMatch[1]);
    if (!session || session.status !== "running" || !session.folder || !session.moduleVolume) return send(res, 409, { error: "A ready preview is required for a production build." });
    if (deploymentBuilds.size >= 2) return send(res, 429, { error: "Production build capacity is temporarily full." });
    const buildName = `sg-deploy-${session.id}`;
    deploymentBuilds.add(session.id);
    try {
      const limits = ["--label", "sigmagpt.session=" + session.id, "--memory=512m", "--cpus=0.75", "--pids-limit=64", "--security-opt=no-new-privileges", "--cap-drop=ALL", "--user=1000:1000", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"];
      const mounts = (mode) => ["-v", `${session.folder}:/workspace:${mode}`, "--mount", `type=volume,src=${session.moduleVolume},dst=/workspace/node_modules,readonly`, "-w", "/workspace", NODE_IMAGE];
      await runDocker(["run", "--rm", "--network=none", "--name", buildName, ...limits, ...mounts("rw"), "npm", "run", "build"], { timeout: 90_000, captureLimit: 8000 });
      const extractScript = `const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');const root='/workspace/dist';const denied=/(^|\\/)(?:\\.env(?:\\..*)?|\\.git|node_modules)(?:\\/|$)|\\.(?:pem|key|p12|pfx|crt|cer)$/i;const mime={html:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',wasm:'application/wasm'};let total=0;const files=[];async function walk(dir,base=''){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const rel=base?base+'/'+entry.name:entry.name;if(denied.test(rel)||rel.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('unsafe output');const full=path.join(dir,entry.name);const st=await fs.lstat(full);if(st.isSymbolicLink())throw Error('symlink output');if(st.isDirectory()){await walk(full,rel);continue}if(!st.isFile()||files.length>=500)throw Error('invalid output');total+=st.size;if(total>18*1024*1024)throw Error('output too large');const data=await fs.readFile(full);const ext=rel.split('.').pop().toLowerCase();files.push({path:rel,content:data.toString('base64'),contentType:mime[ext]||'application/octet-stream',hash:crypto.createHash('sha256').update(data).digest('hex')})}};(async()=>{await walk(root);if(!files.some(f=>f.path==='index.html'))throw Error('missing index');process.stdout.write(JSON.stringify({files}))})().catch(e=>{console.error(e.message);process.exit(1)})`;
      const output = await runDocker(["run", "--rm", "--network=none", "--name", buildName, ...limits, ...mounts("ro"), "node", "-e", extractScript], { timeout: 20_000, captureLimit: 26 * 1024 * 1024 });
      const result = JSON.parse(output);
      if (!Array.isArray(result.files) || result.files.length < 1 || result.files.length > 500) throw new Error("Invalid build output");
      return send(res, 200, { files: result.files });
    } catch (error) {
      await runDocker(["rm", "-f", buildName], { timeout: 10_000 }).catch(() => {});
      const safeMessage = error?.timedOut ? "The production build exceeded its 90 second limit." : /npm run build|Sandbox task failed/i.test(error?.output || "") ? "The production build failed. Review the project code and preview before trying again." : "The isolated production build could not be completed.";
      return send(res, 422, { error: safeMessage });
    } finally { deploymentBuilds.delete(session.id); }
  }
  const match = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]{36})$/);
  if (match && req.method === "GET") {
    const session = sessions.get(match[1]);
    if (session?.status === "running" && session.container) {
      const output = await runDocker(["logs", "--tail", "80", session.container], { timeout: 5000, captureLimit: 8000 }).catch(() => "");
      if (output && /(\[plugin:vite:|SyntaxError|TypeError|ReferenceError|Failed to resolve import|Internal server error)/i.test(output)) {
        const category = /(\[plugin:vite:|Failed to resolve import|Internal server error)/i.test(output) ? "build" : "runtime";
        session.diagnostics = { category, message: category === "build" ? "Vite reported a source transform or module resolution error." : "The preview server reported a runtime error.", logs: cleanLog(output) };
      }
    }
    return session ? send(res, 200, sessionInfo(session)) : send(res, 404, { error: "Preview session not found" });
  }
  if (match && req.method === "DELETE") {
    const session = sessions.get(match[1]);
    if (session) { await stopSession(session); sessions.delete(match[1]); }
    return send(res, 200, { status: "stopped" });
  }
  return send(res, 404, { error: "Not found" });
});

async function proxyPreview(req, res, url) {
  const match = url.pathname.match(/^\/p\/([a-f0-9]{64})(\/.*)?$/);
  const token = match?.[1];
  const session = token && [...sessions.values()].find((item) => item.status === "running" && item.previewToken === token && item.port);
  if (!session) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Preview not found or expired"); }
  const requestPath = match[2] || "/";
  if (requestPath.split("/").some((part) => part === "..")) { res.writeHead(400); return res.end(); }
  if (requestPath === "/__sigmagpt_diagnostics") {
    if (req.method !== "POST") { res.writeHead(405, { "Cache-Control": "no-store" }); return res.end(); }
    try {
      const report = await readJson(req, 4096);
      const errors = Array.isArray(report.errors) ? report.errors.slice(0, 10).filter((item) => typeof item === "string").map(cleanLog) : [];
      if (!errors.length) return send(res, 400, { error: "Invalid diagnostic report" });
      const category = ["browser-runtime", "network"].includes(report.category) ? report.category : "browser-runtime";
      session.diagnostics = { category, message: category === "network" ? "A preview resource failed to load." : "Browser runtime errors were reported by the preview.", logs: errors.join("\n").slice(0, 8000) };
      return send(res, 202, { status: "accepted" });
    } catch {
      res.writeHead(413, { "Cache-Control": "no-store" });
      return res.end();
    }
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { "Cache-Control": "no-store" }); return res.end(); }
  try {
    const upstream = await fetch(`http://127.0.0.1:${session.port}${requestPath}${url.search}`, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: { accept: req.headers.accept || "*/*" },
      signal: AbortSignal.timeout(10_000)
    });
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    if (req.method !== "HEAD" && contentType.includes("text/html") && upstream.ok) {
      const html = await upstream.text();
      const reportUrl = `/p/${session.previewToken}/__sigmagpt_diagnostics`;
      const script = `<script>(function(){var u=${JSON.stringify(reportUrl)},n=0;function send(v,c){if(n++>=10)return;try{fetch(u,{method:'POST',mode:'no-cors',keepalive:true,headers:{'Content-Type':'text/plain'},body:JSON.stringify({category:c||'browser-runtime',errors:[String(v).slice(0,800)]})})}catch(e){}}window.addEventListener('error',function(e){if(e.target&&e.target!==window){send('resource failed: '+(e.target.src||e.target.href||e.target.tagName),'network');return}send('runtime: '+(e.message||'script error')+' '+(e.filename||'')+':'+(e.lineno||''))},true);window.addEventListener('unhandledrejection',function(e){send('runtime rejection: '+String(e.reason))});var old=console.error;console.error=function(){send('console.error: '+Array.from(arguments).map(String).join(' ').slice(0,800));return old.apply(console,arguments)}})();</script>`;
      const injected = html.includes("</head>") ? html.replace("</head>", `${script}</head>`) : `${script}${html}`;
      res.writeHead(upstream.status, {
        "Content-Type": contentType, "Content-Length": String(Buffer.byteLength(injected)), "Cache-Control": "no-store",
        "Content-Security-Policy": previewCsp, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"
      });
      return res.end(injected);
    }
    res.writeHead(upstream.status, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Security-Policy": previewCsp,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") return res.end();
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    return res.end();
  } catch { res.writeHead(502, { "Cache-Control": "no-store" }); return res.end("Preview is temporarily unavailable"); }
}

server.on("upgrade", (req, socket, head) => {
  const match = new URL(req.url, "http://sandbox.local").pathname.match(/^\/p\/([a-f0-9]{64})(\/.*)?$/);
  const session = match && [...sessions.values()].find((item) => item.status === "running" && item.previewToken === match[1] && item.port);
  if (!session) return socket.destroy();
  const upstream = net.connect(session.port, "127.0.0.1", () => {
    const requestPath = `${match[2] || "/"}${new URL(req.url, "http://sandbox.local").search}`;
    const headers = Object.entries(req.headers).filter(([key]) => key.toLowerCase() !== "host").map(([key, value]) => `${key}: ${value}`).join("\r\n");
    upstream.write(`${req.method} ${requestPath} HTTP/${req.httpVersion}\r\nHost: 127.0.0.1:${session.port}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) void stopSession(session, "expired").finally(() => sessions.delete(id));
  }
}, 30_000).unref();

if (!API_TOKEN || API_TOKEN.length < 32) throw new Error("SANDBOX_SERVICE_TOKEN must contain at least 32 characters");
await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
const orphanedContainers = await runDocker(["ps", "-aq", "--filter", "label=sigmagpt.session"], { timeout: 15_000 }).catch(() => "");
if (orphanedContainers) await runDocker(["rm", "-f", ...orphanedContainers.split(/\s+/).filter(Boolean)], { timeout: 30_000 }).catch(() => {});
const orphanedVolumes = await runDocker(["volume", "ls", "-q", "--filter", "label=sigmagpt.session"], { timeout: 15_000 }).catch(() => "");
if (orphanedVolumes) await runDocker(["volume", "rm", "-f", ...orphanedVolumes.split(/\s+/).filter(Boolean)], { timeout: 30_000 }).catch(() => {});
for (const entry of await readdir(DATA_DIR, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("project-")) await rm(path.join(DATA_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
}
server.listen(PORT, "0.0.0.0", () => console.log(`Sandbox runner listening on ${PORT}`));
