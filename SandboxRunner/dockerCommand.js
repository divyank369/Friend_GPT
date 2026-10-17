import { spawn } from "node:child_process";

export function createDockerCommandRunner({ spawnProcess = spawn, binary = "docker", prefixArgs = [] } = {}) {
  return function runDocker(args, { timeout = 90_000, captureLimit = 12_000, onChild = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnProcess(binary, [...prefixArgs, ...args], { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
      onChild(child);
      let output = "";
      let settled = false;
      const collect = (chunk) => { if (output.length < captureLimit) output += chunk.toString().slice(0, captureLimit - output.length); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.once("error", (error) => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(Object.assign(new Error("Container runtime is unavailable"), { cause: error })); }
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0) resolve(output.trim());
        else reject(Object.assign(new Error("Sandbox task failed"), { timedOut: code === null, output: output.slice(0, captureLimit) }));
      });
    });
  };
}

let prefixArgs = [];
try { prefixArgs = JSON.parse(process.env.SANDBOX_DOCKER_PREFIX_ARGS || "[]"); } catch {}
if (!Array.isArray(prefixArgs) || prefixArgs.some((arg) => typeof arg !== "string")) prefixArgs = [];

export const runDocker = createDockerCommandRunner({
  binary: process.env.SANDBOX_DOCKER_BIN || "docker",
  prefixArgs
});
