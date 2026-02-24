import { NextResponse } from "next/server";

type ExtractResult = {
  title: string;
  text: string;
};

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  if (host.endsWith(".local")) return true;
  if (host === "0.0.0.0" || host.startsWith("127.")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

function sanitizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(html: string): string {
  return sanitizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'"),
  );
}

function extractTitle(html: string, fallback: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? fallback;
  return sanitizeText(title).slice(0, 120) || fallback;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { url?: string };
    const rawUrl = String(body.url ?? "").trim();
    if (!rawUrl) {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return NextResponse.json({ error: "http/https only" }, { status: 400 });
    }
    if (isPrivateHostname(parsed.hostname)) {
      return NextResponse.json({ error: "private host is not allowed" }, { status: 400 });
    }

    const response = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "upmo-url-fetcher/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      return NextResponse.json({ error: `fetch failed: ${response.status}` }, { status: 400 });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return NextResponse.json({ error: "html page only" }, { status: 400 });
    }

    const html = await response.text();
    const title = extractTitle(html, parsed.hostname);
    const text = htmlToText(html).slice(0, 50000);

    const result: ExtractResult = { title, text };
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/url-extract] failed", error);
    return NextResponse.json({ error: "extract failed" }, { status: 500 });
  }
}

