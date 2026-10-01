const apiBaseUrl = (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:8080" : ""))
    .replace(/\/+$/, "");

export function apiFetch(path, options = {}) {
    if (!apiBaseUrl) {
        return Promise.reject(new Error("The API URL is not configured for this deployment"));
    }

    return fetch(`${apiBaseUrl}${path}`, {
        ...options,
        credentials: "include"
    });
}