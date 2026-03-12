import { NextResponse } from "next/server";

type AnalyzeResult = {
  summary: string;
};

function sanitizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(
      /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackAnalyze(text: string): AnalyzeResult {
  const summary = sanitizeText(text).slice(0, 180) || "概要を抽出できませんでした。";
  return { summary };
}

function safeParseAnalyze(raw: string): AnalyzeResult | null {
  try {
    const parsed = JSON.parse(raw) as AnalyzeResult;
    if (!parsed || typeof parsed.summary !== "string") {
      return null;
    }

    return {
      summary: parsed.summary.trim(),
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { fileName?: string; text?: string };
    const fileName = body.fileName ?? "PDF";
    const text = sanitizeText(body.text ?? "");

    if (!text) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(fallbackAnalyze(text));
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const prompt = [
      `以下は「${fileName}」の抽出テキストです。`,
      "次のJSONだけを返してください。説明文は不要です。",
      '{ "summary": "200文字以内の日本語要約" }',
      "料金・価格・プラン名の抽出や推測はしないでください。",
      "",
      text.slice(0, 22000),
    ].join("\n");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: prompt,
      }),
    });

    if (!response.ok) {
      return NextResponse.json(fallbackAnalyze(text));
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };

    const outputText =
      data.output_text ??
      data.output?.flatMap((item) => item.content ?? []).map((c) => c.text ?? "").join("") ??
      "";

    const direct = safeParseAnalyze(outputText);
    if (direct) return NextResponse.json(direct);

    const jsonLike = outputText.match(/\{[\s\S]*\}/)?.[0];
    if (jsonLike) {
      const recovered = safeParseAnalyze(jsonLike);
      if (recovered) return NextResponse.json(recovered);
    }

    return NextResponse.json(fallbackAnalyze(text));
  } catch (error) {
    console.error("[api/pdf-analyze] failed", error);
    return NextResponse.json(
      { summary: "概要を抽出できませんでした。" },
      { status: 200 },
    );
  }
}
