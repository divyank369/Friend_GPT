const apiBaseUrl = (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:8080" : ""))
    .replace(/\/+$/, "");

// Build asset URLs against the same configured API origin as authenticated fetches.
export function apiUrl(path) {
    return `${apiBaseUrl}${path}`;
}

export function apiFetch(path, options = {}) {
    if (!apiBaseUrl) {
        return Promise.reject(new Error("The API URL is not configured for this deployment"));
    }

    return fetch(apiUrl(path), {
        ...options,
        credentials: "include"
    });
}
