/**
 * POST /api/upload/signed-url
 * GET  /api/uploads/:filename
 *
 * File upload via local filesystem. The action requests a signed URL,
 * we return a PUT URL pointing at our own server + a public GET URL.
 * The action then PUTs the file directly.
 *
 * PUT  /api/uploads/:token/:filename  — upload endpoint
 * GET  /api/uploads/:filename         — public download
 */

import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { config } from "../config.ts";

const uploadsDir = join(config.dataDir, "uploads");
if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}

function signUploadToken(filename: string): string {
  return createHmac("sha256", config.secret).update(filename).digest("hex").slice(0, 32);
}

export async function signedUrlHandler(c: Context) {
  const body = await c.req.json<{
    filename: string;
    contentType: string;
    contentLength: number;
  }>();

  if (!body.filename || !body.contentType) {
    return c.json({ error: "filename and contentType required" }, 400);
  }

  // 10MB limit
  if (body.contentLength > 10 * 1024 * 1024) {
    return c.json({ error: "file too large (max 10MB)" }, 400);
  }

  const storedName = `${randomUUID()}-${body.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const token = signUploadToken(storedName);

  const uploadUrl = `${config.publicUrl}/api/uploads/${token}/${storedName}`;
  const publicUrl = `${config.publicUrl}/api/uploads/${storedName}`;

  return c.json({ uploadUrl, publicUrl });
}

export async function uploadPutHandler(c: Context) {
  const token = c.req.param("token");
  const filename = c.req.param("filename");

  const expected = signUploadToken(filename);
  if (token !== expected) {
    return c.text("forbidden", 403);
  }

  const body = await c.req.arrayBuffer();
  const filePath = join(uploadsDir, filename);
  writeFileSync(filePath, Buffer.from(body));

  return c.text("ok", 200);
}

export function uploadGetHandler(c: Context) {
  const filename = c.req.param("filename");
  const safeName = filename.replace(/\.\./g, "").replace(/[/\\]/g, "");
  const filePath = join(uploadsDir, safeName);

  if (!existsSync(filePath)) {
    return c.text("not found", 404);
  }

  const data = readFileSync(filePath);

  // basic content-type detection
  const ext = safeName.split(".").pop()?.toLowerCase();
  const contentTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
  };
  const contentType = contentTypes[ext ?? ""] ?? "application/octet-stream";

  return c.body(data, 200, {
    "Content-Type": contentType,
    "Content-Length": data.length.toString(),
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
