/**
 * HTTP/HTTPS transport layer for the Git smart-HTTP protocol.
 *
 * Handles:
 *   - HTTP and HTTPS (auto-selected by URL scheme)
 *   - Basic authentication (credentials in URL or env vars)
 *   - Redirects (up to 5 hops)
 *   - Large response buffering
 */

import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import { ParsedUrl } from "./remote";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const MAX_REDIRECTS = 5;
const USER_AGENT = "lgit/0.1.0";

export async function httpGet(
  url: string,
  headers: Record<string, string> = {},
  redirects = 0,
): Promise<HttpResponse> {
  return request("GET", url, null, headers, redirects);
}

export async function httpPost(
  url: string,
  body: Buffer,
  headers: Record<string, string> = {},
  redirects = 0,
): Promise<HttpResponse> {
  return request("POST", url, body, headers, redirects);
}

// ---- core ------------------------------------------------------------------

function request(
  method: string,
  urlStr: string,
  body: Buffer | null,
  extraHdrs: Record<string, string>,
  redirects: number,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;

    const reqHeaders: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Content-Type": body
        ? (extraHdrs["Content-Type"] ?? "application/octet-stream")
        : "",
      ...extraHdrs,
    };

    // Basic auth — from URL or GIT_HTTP_PASSWORD / GIT_HTTP_USER env vars
    const user = parsed.username || process.env.GIT_HTTP_USER;
    const pass = parsed.password || process.env.GIT_HTTP_PASSWORD;
    if (user && pass) {
      reqHeaders["Authorization"] =
        "Basic " +
        Buffer.from(
          `${decodeURIComponent(user)}:${decodeURIComponent(pass)}`,
        ).toString("base64");
    }

    if (body) reqHeaders["Content-Length"] = String(body.length);

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method,
      headers: reqHeaders,
    };

    if (isHttps) {
      const caPath = process.env.GIT_SSL_CAINFO;
      if (caPath) {
        (options as https.RequestOptions).ca = fs.readFileSync(caPath);
      }
    }

    const req = mod.request(options, (res) => {
      // Follow redirects
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirects >= MAX_REDIRECTS) {
          return reject(new Error(`Too many redirects for ${urlStr}`));
        }
        res.resume(); // drain
        return resolve(
          request(method, res.headers.location, body, extraHdrs, redirects + 1),
        );
      }

      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          respHeaders[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: respHeaders,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    });

    req.on("error", (e) => {
      console.log("Error--------------------", e);
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}
