"use strict";

const TRANSPORT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_NETWORK_ACCESS_DENIED",
  "ERR_PROXY_CONNECTION_FAILED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function normalizeRequestUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""), "https://codex.invalid");
    const pathname = parsed.pathname.startsWith("/backend-api/")
      ? parsed.pathname.slice("/backend-api".length)
      : parsed.pathname;
    return { pathname, searchParams: parsed.searchParams };
  } catch {
    return null;
  }
}

function matchPluginServiceRequest(request) {
  if (!request || String(request.method || "GET").toUpperCase() !== "GET") {
    return null;
  }
  const parsed = normalizeRequestUrl(request.url);
  if (!parsed) return null;

  if (parsed.pathname === "/ps/plugins/home") {
    return { surface: "home", value: { sections: [] } };
  }
  if (parsed.pathname === "/ps/plugins/workspace/created") {
    return { surface: "workspace-created", value: { plugins: [] } };
  }
  if (parsed.pathname === "/ps/plugins/workspace/shared") {
    return { surface: "workspace-shared", value: { plugins: [] } };
  }
  if (parsed.pathname !== "/ps/plugins/list") return null;

  const scope = String(parsed.searchParams.get("scope") || "").toUpperCase();
  if (scope === "USER") {
    return { surface: "user-list", value: { plugins: [] } };
  }
  if (scope === "WORKSPACE") {
    return {
      surface: "workspace-list",
      value: { plugins: [], pagination: { next_page_token: null } },
    };
  }
  return null;
}

function isPluginServiceTransportError(errorLike) {
  const values = [];
  const seen = new Set();
  let current = errorLike;
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    if (typeof current === "object") seen.add(current);
    const name = typeof current.name === "string" ? current.name : "";
    const code =
      typeof current.errorCode === "string"
        ? current.errorCode
        : typeof current.code === "string"
          ? current.code
          : "";
    const message =
      typeof current.error === "string"
        ? current.error
        : typeof current.message === "string"
          ? current.message
          : "";
    if (name === "AbortError" || code === "ABORT_ERR") return false;
    if (code) values.push(code);
    if (message) values.push(message);
    current = typeof current === "object" ? current.cause : null;
  }

  for (const value of values) {
    if (TRANSPORT_ERROR_CODES.has(value)) return true;
    for (const code of TRANSPORT_ERROR_CODES) {
      if (value.includes(code)) return true;
    }
  }
  return (
    errorLike instanceof TypeError &&
    values.some((value) => /\bfetch failed\b|\bnetwork request failed\b/i.test(value))
  );
}

function createPluginServiceFallbackResponse(requestId, match) {
  const body = JSON.stringify(match.value);
  return {
    requestId: String(requestId || ""),
    responseType: "success",
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: body,
    bodyJsonString: body,
  };
}

function pluginServiceFallbackForError(request, errorLike) {
  const match = matchPluginServiceRequest(request);
  if (!match || !isPluginServiceTransportError(errorLike)) return null;
  return createPluginServiceFallbackResponse(request.requestId, match);
}

module.exports = {
  createPluginServiceFallbackResponse,
  isPluginServiceTransportError,
  matchPluginServiceRequest,
  pluginServiceFallbackForError,
};
