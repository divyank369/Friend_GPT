const apiBaseUrl = import.meta.env.VITE_API_URL || "http://localhost:8080";

export function apiFetch(path, options = {}) {
    return fetch(`${apiBaseUrl}${path}`, {
        ...options,
        credentials: "include"
    });
}