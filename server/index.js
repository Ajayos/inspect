/* global Headers, URL, Response, Request */
const VERSION_ENDPOINTS = new Set(["/__version", "/api/version"]);

function isDocumentRequest(request, response, isFallback = false) {
  if (isFallback) return true;

  const pathname = new URL(request.url).pathname;
  if (
    pathname === "/" ||
    pathname.endsWith("/") ||
    pathname === "/index.html" ||
    pathname.endsWith(".html") ||
    pathname.endsWith("/version.json") ||
    pathname.endsWith("/manifest.json") ||
    pathname.endsWith(".webmanifest") ||
    pathname === "/sw.js" ||
    pathname.endsWith("-sw.js") ||
    pathname === "/service-worker.js"
  ) {
    return true;
  }

  const contentType = response?.headers?.get("content-type")?.toLowerCase() || "";
  return contentType.includes("text/html") || contentType.includes("application/manifest+json");
}

function isHashedAssetRequest(pathname) {
  return /^\/assets\/.*-[a-zA-Z0-9_-]{8,}\.[a-z0-9]+$/i.test(pathname) || /.*-[a-zA-Z0-9_-]{8,}\.[a-z0-9]+$/i.test(pathname);
}

function isStaticAssetPath(pathname) {
  return (
    /^\/assets\//i.test(pathname) ||
    /\.(?:js|mjs|cjs|css|json|map|woff|woff2|ttf|eot|png|jpg|jpeg|svg|webp|gif|avif|ico|mp3|mp4|webm|wasm|pdf|txt)$/i.test(pathname)
  );
}

function isVersionEndpoint(pathname) {
  return VERSION_ENDPOINTS.has(pathname);
}

function resolveAppVersion(headers, env) {
  const etag = headers?.get("ETag");
  if (etag) return etag.replace(/["']/g, "");
  return env?.VERSION || env?.CF_PAGES_COMMIT_SHA || env?.CF_PAGES_BRANCH || "latest";
}

function createVersionResponse(request, url, env, existingHeaders = null) {
  const tenant = url.hostname;
  const version = resolveAppVersion(existingHeaders, env);
  const payload = JSON.stringify({
    status: "ok",
    tenant,
    version,
    timestamp: Date.now(),
    updatePolicy: "instant-revalidate",
    cacheVersion: "3"
  });

  return new Response(request.method === "HEAD" ? null : payload, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      "X-Tenant": tenant,
      "X-Version": version,
      "X-Cache-Status": "version-endpoint-no-store",
      "X-Update-Policy": "instant-revalidate"
    }
  });
}

export function withPlatformHeaders(response, request, options = {}, env = {}) {
  const normalizedOptions =
    typeof options === "boolean"
      ? { isDocument: options, isFallback: options, cacheStatus: null }
      : {
          isDocument: false,
          isFallback: false,
          cacheStatus: null,
          ...options
        };

  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  const pathname = url.pathname;
  const isDocument = isDocumentRequest(request, response, normalizedOptions.isFallback) || normalizedOptions.isDocument;
  const isHashedAsset = !isDocument && isHashedAssetRequest(pathname);

  const vary = headers.get("Vary");
  const varyTokens = vary ? vary.split(",").map((value) => value.trim().toLowerCase()) : [];
  const neededVary = ["Host", "Accept-Encoding"].filter((token) => !varyTokens.includes(token.toLowerCase()));
  if (neededVary.length > 0) {
    headers.set("Vary", vary ? `${vary}, ${neededVary.join(", ")}` : neededVary.join(", "));
  }

  headers.set("X-Tenant", url.hostname);

  const version = resolveAppVersion(headers, env);
  headers.set("X-Version", version);
  headers.set("X-Update-Policy", "instant-revalidate");

  if (isDocument) {
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
    headers.set("CDN-Cache-Control", "no-store");
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    headers.set("Surrogate-Control", "no-store");
    headers.set(
      "X-Cache-Status",
      normalizedOptions.cacheStatus || (normalizedOptions.isFallback ? "fallback-document-no-store" : "document-no-store")
    );
  } else if (isHashedAsset) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("CDN-Cache-Control", "public, max-age=31536000, immutable");
    headers.set("X-Cache-Status", normalizedOptions.cacheStatus || "immutable-asset");
  } else {
    headers.set("Cache-Control", "public, max-age=60, must-revalidate, stale-while-revalidate=86400");
    headers.set("X-Cache-Status", normalizedOptions.cacheStatus || "revalidate-asset");
  }

  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (["GET", "HEAD"].includes(request.method) && isVersionEndpoint(url.pathname)) {
      return createVersionResponse(request, url, env);
    }

    const response = await env.ASSETS.fetch(request);

    if (url.pathname === "/version.json" && response.status === 404 && ["GET", "HEAD"].includes(request.method)) {
      return createVersionResponse(request, url, env, response.headers);
    }

    if (response.status !== 404 || !["GET", "HEAD"].includes(request.method)) {
      if (response.status === 404 && isStaticAssetPath(url.pathname)) {
        const notFoundResponse = withPlatformHeaders(
          response,
          request,
          {
            isDocument: false,
            cacheStatus: "asset-not-found-update-required"
          },
          env
        );
        const headers = new Headers(notFoundResponse.headers);
        headers.set("X-Update-Required", "true");
        headers.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
        return new Response(notFoundResponse.body, {
          headers,
          status: notFoundResponse.status,
          statusText: notFoundResponse.statusText
        });
      }
      return withPlatformHeaders(
        response,
        request,
        {
          isDocument: isDocumentRequest(request, response, false)
        },
        env
      );
    }

    if (isStaticAssetPath(url.pathname)) {
      const notFoundResponse = withPlatformHeaders(
        response,
        request,
        {
          isDocument: false,
          cacheStatus: "asset-not-found-update-required"
        },
        env
      );
      const headers = new Headers(notFoundResponse.headers);
      headers.set("X-Update-Required", "true");
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
      return new Response(notFoundResponse.body, {
        headers,
        status: notFoundResponse.status,
        statusText: notFoundResponse.statusText
      });
    }

    const fallbackUrl = new URL("/index.html", request.url);
    const fallback = await env.ASSETS.fetch(new Request(fallbackUrl, request));
    return withPlatformHeaders(
      fallback,
      request,
      {
        isDocument: true,
        isFallback: true,
        cacheStatus: "fallback-document-no-store"
      },
      env
    );
  }
};

export default worker;
