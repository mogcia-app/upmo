import { NextResponse } from "next/server";

type SourceInput = {
  name: string;
  text?: string;
  summary?: string;
  updateMemo?: string;
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

function isPriceQuestion(question: string): boolean {
  return /料金|価格|費用|プラン|月額|値段/.test(question);
}

function extractStrictPricingEvidence(text: string): string[] {
  const normalized = sanitizeText(text);
  if (!normalized) return [];

  const matches: string[] = [];
  const idPriceRegex = /([0-9０-９]+ID)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,6})円\s*\/\s*([0-9０-９]+ID)/g;
  const contactRegex = /([0-9０-９]+ID\s*[〜~\-]*)\s*(お問い合わせください)/g;
  const monthlyRegex = /([A-Za-zぁ-んァ-ヶ一-龠ー・]{1,20})\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,6})円\s*\/\s*(月|月額)/g;

  for (const match of normalized.matchAll(idPriceRegex)) {
    matches.push(`${match[1]} ${match[2]}円 / ${match[3]}`);
  }
  for (const match of normalized.matchAll(contactRegex)) {
    matches.push(`${match[1].trim()} ${match[2]}`);
  }
  for (const match of normalized.matchAll(monthlyRegex)) {
    matches.push(`${match[1].trim()} ${match[2]}円 / ${match[3]}`);
  }

  return Array.from(new Set(matches)).slice(0, 6);
}

function buildStrictPricingAnswer(sources: SourceInput[]): string {
  const usedUpdateMemo = sources.some((source) => Boolean(source.updateMemo?.trim()));
  const evidence = sources.flatMap((source) =>
    extractStrictPricingEvidence([source.updateMemo ?? "", source.text ?? ""].join(" ")).map((line) => `${source.name}: ${line}`),
  );

  if (evidence.length === 0) {
    const names = sources.map((source) => source.name).filter(Boolean);
    return [
      "本文内に料金情報は確認できませんでした。",
      "料金表や価格記載のある本文があれば、その内容だけで再回答できます。",
      `参照ナレッジ: ${names.length > 0 ? names.join(" / ") : "なし"}`,
      ...(usedUpdateMemo ? ["変更メモを反映"] : []),
    ].join("\n");
  }

  const sourceNames = Array.from(new Set(evidence.map((item) => item.split(":")[0])));
  return [
    "料金",
    ...evidence.map((line) => `・${line}`),
    `参照ナレッジ: ${sourceNames.join(" / ")}`,
    ...(usedUpdateMemo ? ["変更メモを反映"] : []),
  ].join("\n");
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function buildContext(sources: SourceInput[]): string {
  return sources
    .slice(0, 5)
    .map((source, idx) => {
      return [
        `## Source ${idx + 1}: ${source.name}`,
        `Summary: ${compact(source.summary ?? "").slice(0, 350) || "なし"}`,
        `UpdateMemo: ${compact(source.updateMemo ?? "").slice(0, 350) || "なし"}`,
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

    if (isPriceQuestion(question)) {
      return NextResponse.json({
        answer: buildStrictPricingAnswer(sources),
      });
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
      "回答はまず質問に対する結論を1〜3文で先に答えてください。",
      "固定の見出し（要点、詳細、次のアクション）は不要です。必要な補足だけ短く追加してください。",
      "聞かれていないことまで広げすぎないでください。",
      "ナレッジに UpdateMemo がある場合は、それを最新の補足情報として本文より優先して扱ってください。",
      "Comments は渡されません。回答に反映してよいのは本文と UpdateMemo だけです。",
      "利用したナレッジ名を文末に必ず `参照ナレッジ: ...` の形式で書いてください。ナレッジがない場合は `参照ナレッジ: なし` と書いてください。",
      "不明な事実は断定しないでください。",
      "料金・価格・プランについては、与えられたナレッジに明記されている内容だけを回答してください。",
      "料金の記載が見当たらない場合は、料金情報は確認できないと明記してください。具体的な金額やプラン名を推測で補わないでください。",
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
