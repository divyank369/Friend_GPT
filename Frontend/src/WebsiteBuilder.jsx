import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import "./WebsiteBuilder.css";

const MAX_REQUIREMENTS = 6000;
const activeRepairStates = new Set(["analyzing", "preparing", "applying", "rebuilding"]);
const diagnosticLabels = {
    dependencies: "Dependency installation",
    build: "Vite build error",
    runtime: "Preview runtime error",
    "browser-runtime": "Browser runtime",
    network: "Network resource"
};

function WebsiteBuilder() {
    const [requirements, setRequirements] = useState("");
    const [projectType, setProjectType] = useState("react-vite");
    const [project, setProject] = useState(null);
    const [selectedPath, setSelectedPath] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [preview, setPreview] = useState(null);
    const [runBusy, setRunBusy] = useState(false);
    const [autoFix, setAutoFix] = useState(false);
    const [fixBusy, setFixBusy] = useState(false);
    const [revertBusy, setRevertBusy] = useState(false);
    const [revisionDetails, setRevisionDetails] = useState({});
    const [deployments, setDeployments] = useState([]);
    const [deployBusy, setDeployBusy] = useState(false);
    const autoFixHandled = useRef("");
    const projectIdRef = useRef("");
    const syncedRevisionRef = useRef("");

    const updatePreview = useCallback((result) => {
        projectIdRef.current = result.projectId || "";
        if (Array.isArray(result.files) && result.revisions?.length) syncedRevisionRef.current = result.revisions[result.revisions.length - 1].revisionId;
        setPreview(result);
        if (Array.isArray(result.files) && result.files.length) {
            setProject((current) => current ? { ...current, files: result.files, name: result.projectName || current.name } : current);
            setSelectedPath((current) => result.files.some((file) => file.path === current) ? current : result.files[0].path);
        }
    }, []);

    useEffect(() => {
        const repairActive = activeRepairStates.has(preview?.repair?.status);
        if (!preview?.projectId || (!repairActive && !["building", "running", "failed"].includes(preview.status))) return undefined;
        let cancelled = false;
        const poll = async () => {
            try {
                const response = await apiFetch(`/api/website-builder/projects/${encodeURIComponent(preview.projectId)}`);
                const result = await response.json().catch(() => null);
                if (!response.ok) throw new Error(result?.error || "Could not check project status.");
                if (cancelled) return;
                const latestRevisionId = result.revisions?.at(-1)?.revisionId;
                if (latestRevisionId && latestRevisionId !== syncedRevisionRef.current) {
                    const filesResponse = await apiFetch(`/api/website-builder/projects/${encodeURIComponent(preview.projectId)}?includeFiles=1`);
                    const filesResult = await filesResponse.json().catch(() => null);
                    if (filesResponse.ok && Array.isArray(filesResult?.files)) updatePreview(filesResult);
                    else updatePreview(result);
                } else updatePreview(result);
            } catch (requestError) {
                if (!cancelled) setPreview((current) => ({ ...current, error: requestError.message || "Could not check project status." }));
            }
        };
        void poll();
        const timer = setInterval(poll, 1800);
        return () => { cancelled = true; clearInterval(timer); };
    }, [preview?.projectId, preview?.status, preview?.repair?.status, updatePreview]);

    const generateProject = async (event) => {
        event.preventDefault();
        setBusy(true); setError("");
        try {
            const response = await apiFetch("/api/website-builder/generate", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requirements, projectType })
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not generate this project.");
            setProject(result); setSelectedPath(result.files[0]?.path || ""); projectIdRef.current = ""; syncedRevisionRef.current = ""; setRevisionDetails({}); setPreview(null); setDeployments([]); autoFixHandled.current = "";
        } catch (requestError) { setError(requestError.message || "Could not generate this project."); }
        finally { setBusy(false); }
    };

    const runProject = async () => {
        if (!project) return;
        setRunBusy(true); setError(""); projectIdRef.current = ""; syncedRevisionRef.current = ""; setRevisionDetails({}); setPreview(null); setDeployments([]);
        try {
            const response = await apiFetch("/api/website-builder/projects", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project })
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not start this preview.");
            updatePreview(result);
        } catch (requestError) { projectIdRef.current = ""; setPreview({ status: "failed", error: requestError.message || "Could not start this preview." }); }
        finally { setRunBusy(false); }
    };

    const requestFix = useCallback(async () => {
        const projectId = projectIdRef.current;
        if (!projectId) return;
        try {
            const response = await apiFetch(`/api/website-builder/projects/${encodeURIComponent(projectId)}/fix`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxAttempts: 3 })
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not start error repair.");
            updatePreview(result);
        } catch (requestError) { setError(requestError.message || "Could not start error repair."); }
    }, [updatePreview]);

    const fixErrors = useCallback(async () => {
        if (fixBusy) return;
        setFixBusy(true);
        try { await requestFix(); }
        finally { setFixBusy(false); }
    }, [fixBusy, requestFix]);

    const applyRepair = useCallback(async () => {
        const projectId = projectIdRef.current;
        if (!projectId) return;
        try {
            const response = await apiFetch(`/api/website-builder/projects/${encodeURIComponent(projectId)}/fix/apply`, { method: "POST" });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not apply the repair.");
            updatePreview(result);
        } catch (requestError) { setError(requestError.message || "Could not apply the repair."); }
    }, [updatePreview]);

    const dismissRepair = useCallback(async () => {
        const projectId = projectIdRef.current;
        if (!projectId) return;
        try {
            const response = await apiFetch(`/api/website-builder/projects/${encodeURIComponent(projectId)}/fix/cancel`, { method: "POST" });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not dismiss the repair.");
            updatePreview(result);
        } catch (requestError) { setError(requestError.message || "Could not dismiss the repair."); }
    }, [updatePreview]);

    useEffect(() => {
        const diagnostic = preview?.diagnostics;
        if (!autoFix || !preview?.projectId) return;
        if (!diagnostic || activeRepairStates.has(preview?.repair?.status) || preview?.repair?.status === "awaiting-confirmation") return;
        const key = `${preview.projectId}:${diagnostic.category}:${diagnostic.logs}`;
        if (autoFixHandled.current === key) return;
        autoFixHandled.current = key;
        if (window.confirm("SigmaGPT detected a preview error. Allow AI to prepare a patch for review? No code will change until you apply it.")) {
            const timer = setTimeout(() => { void requestFix(); }, 0);
            return () => clearTimeout(timer);
        }
        return undefined;
    }, [autoFix, preview, requestFix]);

    const stopProject = async () => {
        if (!preview?.projectId) return;
        try {
            const response = await apiFetch(`/api/website-builder/projects/${encodeURIComponent(preview.projectId)}`, { method: "DELETE" });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not stop the preview.");
            updatePreview(result);
        } catch (requestError) { setPreview((current) => ({ ...current, error: requestError.message || "Could not stop the preview." })); }
    };

    const revertRevision = async (revision) => {
        if (!preview?.projectId || !window.confirm(`Revert “${revision.summary}” and rebuild the preview?`)) return;
        setRevertBusy(true);
        try {
            const response = await apiFetch(`/api/website-builder/projects/${encodeURIComponent(preview.projectId)}/revisions/${encodeURIComponent(revision.revisionId)}/revert`, { method: "POST" });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not revert this revision.");
            updatePreview(result);
        } catch (requestError) { setError(requestError.message || "Could not revert this revision."); }
        finally { setRevertBusy(false); }
    };

    const loadRevision = async (revisionId) => {
        if (!preview?.projectId || revisionDetails[revisionId]) return;
        try {
            const response = await apiFetch(`/api/website-builder/projects/${encodeURIComponent(preview.projectId)}/revisions/${encodeURIComponent(revisionId)}`);
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not load revision changes.");
            setRevisionDetails((current) => ({ ...current, [revisionId]: result.changes || [] }));
        } catch (requestError) { setError(requestError.message || "Could not load revision changes."); }
    };

    const loadDeployments = useCallback(async (projectId) => {
        if (!projectId) return;
        try {
            const response = await apiFetch(`/api/website-builder/deployments?projectId=${encodeURIComponent(projectId)}`);
            const result = await response.json().catch(() => null);
            if (response.ok && Array.isArray(result?.deployments)) setDeployments(result.deployments);
        } catch { /* Keep the last known deployment history when the API is temporarily unavailable. */ }
    }, []);

    useEffect(() => {
        if (!preview?.projectId) return undefined;
        const timer = setTimeout(() => { void loadDeployments(preview.projectId); }, 0);
        return () => clearTimeout(timer);
    }, [preview?.projectId, loadDeployments]);

    useEffect(() => {
        if (!preview?.projectId) return undefined;
        const activeIds = deployments.filter((item) => ["building", "deploying"].includes(item.status)).map((item) => item.deploymentId);
        if (!activeIds.length) return undefined;
        let cancelled = false;
        const poll = async () => {
            const updates = await Promise.all(activeIds.map(async (id) => {
                try {
                    const response = await apiFetch(`/api/website-builder/deployments/${encodeURIComponent(id)}`);
                    const result = await response.json().catch(() => null);
                    return response.ok ? result : null;
                } catch { return null; }
            }));
            if (cancelled) return;
            setDeployments((current) => current.map((deployment) => updates.find((item) => item?.deploymentId === deployment.deploymentId) || deployment));
        };
        const timer = setInterval(() => { void poll(); }, 2000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [preview?.projectId, deployments]);

    const startDeployment = async (projectId, deploymentId = "") => {
        if (!projectId || deployBusy) return;
        const message = deploymentId
            ? "Publish the current project revision to the existing public website? The live site will be updated."
            : "Publish this website publicly? Anyone with the public URL will be able to view it.";
        if (!window.confirm(message)) return;
        setDeployBusy(true); setError("");
        try {
            const route = deploymentId
                ? `/api/website-builder/deployments/${encodeURIComponent(deploymentId)}/redeploy`
                : `/api/website-builder/projects/${encodeURIComponent(projectId)}/deployments`;
            const response = await apiFetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not publish this website.");
            setDeployments((current) => [result, ...current.filter((item) => item.deploymentId !== result.deploymentId)]);
        } catch (requestError) { setError(requestError.message || "Could not publish this website."); }
        finally { setDeployBusy(false); }
    };

    const deleteDeployment = async (deployment) => {
        if (!window.confirm("Delete this deployment from the hosting provider? The provider may not allow deleting its current live deployment.")) return;
        setDeployBusy(true); setError("");
        try {
            const response = await apiFetch(`/api/website-builder/deployments/${encodeURIComponent(deployment.deploymentId)}`, { method: "DELETE" });
            const result = await response.json().catch(() => null);
            if (!response.ok) throw new Error(result?.error || "Could not delete this deployment.");
            setDeployments((current) => current.map((item) => item.deploymentId === result.deploymentId ? result : item));
        } catch (requestError) { setError(requestError.message || "Could not delete this deployment."); }
        finally { setDeployBusy(false); }
    };

    const selectedFile = project?.files.find((file) => file.path === selectedPath);
    const diagnostic = preview?.diagnostics;
    const changedPaths = preview?.repair?.paths || preview?.repair?.changes?.map((change) => change.path) || preview?.revisions?.at(-1)?.paths || [];

    return (
        <main className="website-builder" aria-label="Website builder">
            <section className="builder-intro">
                <p className="builder-eyebrow">WEBSITE BUILDER</p>
                <h1>Describe your website</h1>
                <p>Generate source files, review an isolated preview, and publish a static React + Vite website.</p>
                <form className="builder-form" onSubmit={generateProject}>
                    <label htmlFor="builder-requirements">What should the website do?</label>
                    <textarea id="builder-requirements" maxLength={MAX_REQUIREMENTS} minLength={1} onChange={(event) => setRequirements(event.target.value)} placeholder="A responsive portfolio for a photographer, with a dark gallery, about section, and contact form…" required rows={5} value={requirements} />
                    <div className="builder-form-footer">
                        <label htmlFor="builder-project-type">Project type</label>
                        <select id="builder-project-type" onChange={(event) => setProjectType(event.target.value)} value={projectType}>
                            <option value="react-vite">React + Vite</option><option value="html-css-js">HTML, CSS + JavaScript</option>
                        </select>
                        <span>{requirements.length}/{MAX_REQUIREMENTS}</span>
                        <button disabled={busy || !requirements.trim()} type="submit">{busy ? "Generating…" : "Generate files"}</button>
                    </div>
                </form>
                {error && <p className="builder-error" role="alert">{error}</p>}
            </section>

            {project && <section className="project-browser" aria-label={`${project.name} project files`}>
                <div className="project-files">
                    <h2>Files <span>{project.files.length}</span></h2>
                    <button className="run-project" disabled={project.projectType !== "react-vite" || runBusy || preview?.status === "building" || preview?.status === "running"} onClick={runProject} type="button">{runBusy ? "Starting…" : "Run Project"}</button>
                    {project.projectType !== "react-vite" && <p className="preview-unsupported">Live preview currently supports React + Vite only.</p>}
                    <label className="autofix-option"><input checked={autoFix} onChange={(event) => setAutoFix(event.target.checked)} type="checkbox" /> Auto-fix detected errors (asks before applying)</label>
                    {preview && <div aria-live="polite" className={`preview-status preview-${preview.status}`} role={preview.status === "failed" ? "alert" : "status"}>
                        <strong>{preview.status === "building" ? "Building preview…" : preview.status === "running" ? "Preview is ready" : preview.status === "failed" ? "Preview failed" : `Preview ${preview.status}`}</strong>
                        {preview.error && <p>{preview.error}</p>}
                        {preview.projectId && ["running", "building", "failed"].includes(preview.status) && <button onClick={stopProject} type="button">Stop preview</button>}
                    </div>}
                    {project.projectType === "react-vite" && <section className="deployment-panel" aria-label="Website deployment">
                        <h3>Publish website</h3>
                        <p className="deployment-preview-label">Temporary preview: {preview?.previewUrl || "Run the project to create a preview"}</p>
                        <p className="deployment-ready">{preview?.status === "running" ? "Ready to deploy" : "A successful preview is required before publishing"}</p>
                        <button className="deploy-website" disabled={deployBusy || preview?.status !== "running" || deployments.some((item) => ["building", "deploying"].includes(item.status))} onClick={() => startDeployment(preview.projectId)} type="button">{deployBusy ? "Starting…" : "Deploy Website"}</button>
                        {deployments.length > 0 && <div className="deployment-history">
                            <h4>Deployment history</h4>
                            {deployments.map((deployment) => <article className={`deployment-item deployment-${deployment.status}`} key={deployment.deploymentId}>
                                <strong>{deployment.status === "success" ? "Deployment successful" : deployment.status === "building" ? "Build in progress" : deployment.status === "deploying" ? "Deployment in progress" : deployment.status === "deleted" ? "Deployment deleted" : "Deployment failed"}</strong>
                                <span>{new Date(deployment.createdAt).toLocaleString()}</span>
                                {deployment.error && <p role="alert">{deployment.error}</p>}
                                {deployment.publicUrl && <div className="deployment-url"><span>Public website:</span><a href={deployment.publicUrl} rel="noopener noreferrer" target="_blank">{deployment.publicUrl}</a><button onClick={() => { void navigator.clipboard?.writeText(deployment.publicUrl); }} type="button">Copy URL</button></div>}
                                {deployment.status === "success" && preview?.status === "running" && <button className="redeploy-website" disabled={deployBusy} onClick={() => startDeployment(preview.projectId, deployment.deploymentId)} type="button">Redeploy current revision</button>}
                                {deployment.status === "success" && <button className="delete-deployment" disabled={deployBusy} onClick={() => deleteDeployment(deployment)} type="button">Delete deployment</button>}
                            </article>)}
                        </div>}
                    </section>}
                    {diagnostic && <section className="repair-diagnostic" aria-label="Preview error details">
                        <strong>{diagnosticLabels[diagnostic.category] || "Preview error"}</strong>
                        <p>{diagnostic.message}</p>
                        {diagnostic.logs && <details><summary>View sanitized logs</summary><pre>{diagnostic.logs}</pre></details>}
                        {preview?.projectId && !activeRepairStates.has(preview.repair?.status) && preview.repair?.status !== "awaiting-confirmation" && <button className="fix-errors" disabled={fixBusy || !["running", "failed"].includes(preview.status)} onClick={fixErrors} type="button">{fixBusy ? "Analyzing error…" : "Fix Errors"}</button>}
                    </section>}
                    {preview?.repair && <section className={`repair-progress repair-${preview.repair.status}`} aria-live="polite" aria-label="Repair progress">
                        <strong>{preview.repair.progress}</strong>
                        {activeRepairStates.has(preview.repair.status) && <p>Attempt {preview.repair.attempts} of {preview.repair.maxAttempts}</p>}
                        {preview.repair.error && <p role="alert">{preview.repair.error}</p>}
                        {preview.repair.diagnostics?.logs && <details><summary>Latest rebuild logs</summary><pre>{preview.repair.diagnostics.logs}</pre></details>}
                        {preview.repair.summary && <p>{preview.repair.summary}</p>}
                        {changedPaths.length > 0 && <p>Changed files: {changedPaths.join(", ")}</p>}
                        {preview.repair.status === "awaiting-confirmation" && preview.repair.changes?.map((change) => <details className="proposed-diff" key={change.path}>
                            <summary>Review {change.path}</summary><pre className="diff-before">− {change.before}</pre><pre className="diff-after">+ {change.after}</pre>
                        </details>)}
                        {preview.repair.status === "awaiting-confirmation" && <div className="repair-confirm-actions">
                            <button onClick={applyRepair} type="button">Apply proposed fix and rebuild</button><button onClick={dismissRepair} type="button">Dismiss</button>
                        </div>}
                    </section>}
                    {preview?.revisions?.length > 0 && <section className="revision-list" aria-label="Project revisions">
                        <h3>Repair history</h3>
                        {[...preview.revisions].reverse().map((revision) => <details key={revision.revisionId} onToggle={(event) => { if (event.currentTarget.open) void loadRevision(revision.revisionId); }}>
                            <summary>{revision.summary} · {new Date(revision.createdAt).toLocaleString()}</summary>
                            {(revisionDetails[revision.revisionId] || []).map((change) => <div className="revision-diff" key={change.path}>
                                <strong>{change.path}</strong><pre className="diff-before">− {change.before}</pre><pre className="diff-after">+ {change.after}</pre>
                            </div>)}
                            <button disabled={revertBusy || preview.status !== "running" || activeRepairStates.has(preview.repair?.status)} onClick={() => revertRevision(revision)} type="button">{revertBusy ? "Rebuilding…" : "Revert this revision"}</button>
                        </details>)}
                    </section>}
                    <ul role="tree" aria-label="Project files">{project.files.map((file) => <li key={file.path} role="treeitem" aria-selected={selectedPath === file.path}>
                        <button className={selectedPath === file.path ? "selected" : ""} onClick={() => setSelectedPath(file.path)} type="button">{file.path}</button>
                    </li>)}</ul>
                </div>
                <div className="project-code"><div className="code-title">{selectedPath}</div><pre><code>{selectedFile?.content || "Select a file to view its code."}</code></pre></div>
                {preview?.status === "running" && preview.previewUrl && <div className="preview-frame-wrap">
                    <div className="preview-frame-heading">Live preview · temporary session</div>
                    <iframe title={`${project.name} live preview`} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" src={preview.previewUrl} />
                </div>}
            </section>}
        </main>
    );
}

export default WebsiteBuilder;
