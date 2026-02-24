import { NextResponse } from "next/server";

type PricingPlan = {
  name: string;
  priceMonthlyYen: number | null;
  note: string;
};

type SourceInput = {
  name: string;
  text?: string;
  summary?: string;
  pricingPlans?: PricingPlan[];
};

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function buildContext(sources: SourceInput[]): string {
  return sources
    .slice(0, 5)
    .map((source, idx) => {
      const plans =
        source.pricingPlans && source.pricingPlans.length > 0
          ? source.pricingPlans
              .map((plan) => {
                const amount =
                  typeof plan.priceMonthlyYen === "number"
                    ? `${plan.priceMonthlyYen}円/月`
                    : "価格不明";
                return `${plan.name}: ${amount}${plan.note ? ` (${plan.note})` : ""}`;
              })
              .join(" / ")
          : "なし";
      return [
        `## Source ${idx + 1}: ${source.name}`,
        `Summary: ${compact(source.summary ?? "").slice(0, 350) || "なし"}`,
        `Pricing: ${plans}`,
        `Text: ${compact(source.text ?? "").slice(0, 1800) || "なし"}`,
      ].join("\n");
    })
    .join("\n\n");
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      question?: string;
      selectedSourceName?: string | null;
      sources?: SourceInput[];
    };
    const question = (body.question ?? "").trim();
    const sources = Array.isArray(body.sources) ? body.sources : [];
    const selectedSourceName = body.selectedSourceName ?? null;

    if (!question) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        answer:
          "OPENAI_API_KEY が未設定のため、拡張回答を生成できません。設定後に再試行してください。",
      });
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const context = buildContext(sources);

    const prompt = [
      "あなたは社内ナレッジアシスタントです。",
      "基本は与えられたナレッジを根拠に回答しつつ、質問が一般論や作成依頼の場合は実務的な提案や雛形を追加してください。",
      "不明な事実は断定しないでください。",
      selectedSourceName ? `現在選択中のナレッジ: ${selectedSourceName}` : "選択中ナレッジ: なし",
      "",
      "利用可能ナレッジ:",
      context || "なし",
      "",
      `ユーザー質問: ${question}`,
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
      return NextResponse.json({ answer: "回答生成に失敗しました。" }, { status: 200 });
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };

    const text =
      data.output_text ??
      data.output?.flatMap((item) => item.content ?? []).map((c) => c.text ?? "").join("") ??
      "";

    return NextResponse.json({
      answer: text.trim() || "回答を生成できませんでした。",
    });
  } catch (error) {
    console.error("[api/chat] failed", error);
    return NextResponse.json({ answer: "回答生成に失敗しました。" }, { status: 200 });
  }
}
