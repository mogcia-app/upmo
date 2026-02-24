import { NextResponse } from "next/server";

type PricingPlan = {
  name: string;
  priceMonthlyYen: number | null;
  note: string;
};

type AnalyzeResult = {
  summary: string;
  plans: PricingPlan[];
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
  const normalized = sanitizeText(text);
  const summary = normalized.slice(0, 180) || "概要を抽出できませんでした。";
  const planRegex = /([A-Za-zぁ-んァ-ヶ一-龠ー・\s]{1,20})\s*([0-9]{2,6}(?:,[0-9]{3})*)\s*円\s*\/?\s*月/g;
  const plansMap = new Map<string, PricingPlan>();

  let match = planRegex.exec(normalized);
  while (match) {
    const name = match[1].trim().replace(/\s+/g, " ");
    const priceMonthlyYen = Number(match[2].replace(/,/g, ""));
    const key = `${name}-${priceMonthlyYen}`;
    if (!plansMap.has(key)) {
      plansMap.set(key, {
        name: name || "プラン",
        priceMonthlyYen,
        note: "",
      });
    }
    match = planRegex.exec(normalized);
  }

  return {
    summary,
    plans: Array.from(plansMap.values()).slice(0, 8),
  };
}

function safeParseAnalyze(raw: string): AnalyzeResult | null {
  try {
    const parsed = JSON.parse(raw) as AnalyzeResult;
    if (!parsed || typeof parsed.summary !== "string" || !Array.isArray(parsed.plans)) {
      return null;
    }

    const plans = parsed.plans
      .map((plan) => ({
        name: String(plan.name ?? "").trim(),
        priceMonthlyYen:
          typeof plan.priceMonthlyYen === "number" ? plan.priceMonthlyYen : null,
        note: String(plan.note ?? "").trim(),
      }))
      .filter((plan) => plan.name.length > 0);

    return {
      summary: parsed.summary.trim(),
      plans,
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
      return NextResponse.json(
        { error: "text is required" },
        { status: 400 },
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(fallbackAnalyze(text));
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const prompt = [
      `以下は「${fileName}」の抽出テキストです。`,
      "次のJSONだけを返してください。説明文は不要です。",
      '{ "summary": "200文字以内の日本語要約", "plans": [{ "name": "プラン名", "priceMonthlyYen": 30000, "note": "補足" }] }',
      "priceMonthlyYen は月額料金が不明なら null。",
      "plans は重複なし。最大8件。",
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
      { summary: "概要を抽出できませんでした。", plans: [] },
      { status: 200 },
    );
  }
}
