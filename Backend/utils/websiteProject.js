export const MAX_WEBSITE_REQUIREMENTS = 6000;
export const MAX_PROJECT_FILES = 30;
export const MAX_PROJECT_FILE_CHARACTERS = 30000;
export const MAX_PROJECT_TOTAL_CHARACTERS = 180000;

const allowedPreviewPackages = new Set(["react", "react-dom", "vite", "@vitejs/plugin-react"]);

const allowedExtensions = new Set([".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".svg"]);

export function validateWebsiteProject(value) {
  let project;
  try {
    const candidate = typeof value === "string" ? value : JSON.stringify(value);
    const json = candidate.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("missing json");
    project = JSON.parse(json);
  } catch {
    throw Object.assign(new Error("The generated project was not valid structured data. Please try again."), { statusCode: 502 });
  }

  const allowedTypes = new Set(["react-vite", "html-css-js"]);
  if (!allowedTypes.has(project.projectType) || !Array.isArray(project.files) || project.files.length < 1 || project.files.length > MAX_PROJECT_FILES) {
    throw Object.assign(new Error("The generated project did not match the supported project format. Please try again."), { statusCode: 502 });
  }

  let totalCharacters = 0;
  const seenPaths = new Set();
  const files = project.files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw Object.assign(new Error("The generated project contains an invalid file."), { statusCode: 502 });
    }
    const path = file.path;
    const segments = path.split("/");
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (
      path.length > 180 || path.includes("\\") || path.startsWith("/") || /^[a-zA-Z]:/.test(path) ||
      path.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..") ||
      !allowedExtensions.has(extension) || seenPaths.has(path)
    ) {
      throw Object.assign(new Error("The generated project contains an unsafe or unsupported file path."), { statusCode: 502 });
    }
    if (file.content.length > MAX_PROJECT_FILE_CHARACTERS) {
      throw Object.assign(new Error("A generated file exceeded the allowed size."), { statusCode: 502 });
    }
    totalCharacters += file.content.length;
    if (totalCharacters > MAX_PROJECT_TOTAL_CHARACTERS) {
      throw Object.assign(new Error("The generated project exceeded the allowed size."), { statusCode: 502 });
    }
    seenPaths.add(path);
    return { path, content: file.content };
  });

  return {
    projectType: project.projectType,
    name: typeof project.name === "string" ? project.name.slice(0, 80) : "Generated website",
    files
  };
}

export function validateReactPreviewProject(project) {
  if (!project || project.projectType !== "react-vite") {
    throw Object.assign(new Error("Live preview currently supports React + Vite projects."), { statusCode: 400 });
  }
  const validated = validateWebsiteProject(project);
  const packageFile = validated.files.find((file) => file.path === "package.json");
  if (!packageFile) throw Object.assign(new Error("The React + Vite project needs a package.json file."), { statusCode: 400 });
  let manifest;
  try { manifest = JSON.parse(packageFile.content); } catch {
    throw Object.assign(new Error("The project package.json is not valid."), { statusCode: 400 });
  }
  const dependencies = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
  if (Object.keys(dependencies).some((name) => !allowedPreviewPackages.has(name))) {
    throw Object.assign(new Error("This preview supports React, React DOM, Vite, and the Vite React plugin only."), { statusCode: 400 });
  }
  for (const version of Object.values(dependencies)) {
    if (typeof version !== "string" || !/^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw Object.assign(new Error("The project contains an unsupported package version."), { statusCode: 400 });
    }
  }
  if (!dependencies.vite || !dependencies.react || !dependencies["react-dom"]) {
    throw Object.assign(new Error("The project must list React, React DOM, and Vite."), { statusCode: 400 });
  }
  if (!validated.files.some((file) => file.path === "index.html")) {
    throw Object.assign(new Error("The React + Vite project needs an index.html file."), { statusCode: 400 });
  }
  return validated;
}
