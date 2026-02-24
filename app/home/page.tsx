"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { User, onAuthStateChanged, signOut } from "firebase/auth";
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";

import { auth } from "@/lib/firebase-auth";
import { db } from "@/lib/firebase-firestore";
import { storage } from "@/lib/firebase-storage";

type UserProfile = {
  uid: string;
  email: string;
  displayName: string;
  companyId: string;
  companyName: string;
  role: "owner" | "member";
};

type CompanyMember = {
  uid: string;
  email: string;
  displayName: string;
};

type TeamItem = {
  id: string;
  name: string;
  memberUids: string[];
};

type ActiveChat =
  | { type: "personal" }
  | { type: "team"; teamId: string };

type ChatThread = {
  id: string;
  scopeType: "personal" | "team";
  teamId?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

type SourceItem = {
  id: string;
  name: string;
  text: string;
  summary?: string;
  pricingPlans?: PricingPlan[];
  storagePath?: string;
  inheritedFromDocumentId?: string;
  createdAt?: Date;
};

type ChatMessage = {
  id: string;
  sender: "user" | "assistant";
  text: string;
  createdAt?: Date;
};

type PricingPlan = {
  name: string;
  priceMonthlyYen: number | null;
  note: string;
};

type UploadStatus = {
  fileName: string;
  progress: number;
};

type SelectedKnowledge = {
  id: string;
  name: string;
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function sanitizeExtractedText(value: string): string {
  const normalized = value.normalize("NFKC");
  return normalized
    .replace(
      /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Timestamp) return value.toDate();
  return undefined;
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  }
  const buffer = await file.arrayBuffer();
  const document = await pdfjs.getDocument({ data: buffer }).promise;

  const pages: string[] = [];
  for (let pageIndex = 1; pageIndex <= document.numPages; pageIndex += 1) {
    const page = await document.getPage(pageIndex);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
    if (text) pages.push(text);
  }

  return sanitizeExtractedText(pages.join("\n"));
}

function extractPriceLines(text: string): string[] {
  const lines = sanitizeExtractedText(text)
    .split(/(?<=円\s*\/?\s*月)/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const priceLike = lines.filter((line) =>
    /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,6})\s*円\s*\/?\s*月/.test(line),
  );

  return Array.from(new Set(priceLike)).slice(0, 5);
}

function buildAssistantReply(question: string, sources: SourceItem[]): string {
  if (sources.length === 0) {
    return "先にPDFをアップロードしてください。";
  }

  const normalizedQuestion = normalizeText(question);
  const tokens = normalizedQuestion
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  const isPriceQuestion = /料金|価格|費用|プラン|月額|値段/.test(question);
  if (isPriceQuestion) {
    const structuredPlans = sources
      .flatMap((source) => source.pricingPlans ?? [])
      .filter((plan) => plan.name.length > 0);

    if (structuredPlans.length > 0) {
      const deduped = Array.from(
        new Map(
          structuredPlans.map((plan) => [
            `${plan.name}-${plan.priceMonthlyYen ?? "null"}`,
            plan,
          ]),
        ).values(),
      );
      const priceLines = deduped.map((plan) => {
        const amount =
          typeof plan.priceMonthlyYen === "number"
            ? `${plan.priceMonthlyYen.toLocaleString("ja-JP")}円/月`
            : "価格不明";
        return `${plan.name}: ${amount}${plan.note ? `（${plan.note}）` : ""}`;
      });
      return `料金情報:\n${priceLines.join("\n")}`;
    }

    const prices = sources.flatMap((source) => extractPriceLines(source.text));
    if (prices.length > 0) {
      return `料金情報:\n${prices.join("\n")}`;
    }
  }

  let bestSource: SourceItem | null = null;
  let bestScore = -1;
  let bestSnippet = "";

  for (const source of sources) {
    const normalizedSource = normalizeText(source.text);
    if (!normalizedSource) continue;

    let score = 0;
    let firstHitIndex = -1;
    for (const token of tokens) {
      const index = normalizedSource.indexOf(token);
      if (index >= 0) {
        score += 1;
        if (firstHitIndex < 0 || index < firstHitIndex) firstHitIndex = index;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestSource = source;
      if (firstHitIndex >= 0) {
        const start = Math.max(0, firstHitIndex - 80);
        const end = Math.min(source.text.length, firstHitIndex + 220);
        bestSnippet = source.text.slice(start, end).replace(/\s+/g, " ").trim();
      } else {
        bestSnippet = source.text.slice(0, 220).replace(/\s+/g, " ").trim();
      }
    }
  }

  if (!bestSource) return "回答に使えるテキストを見つけられませんでした。";

  if (bestSource.summary && bestScore <= 0) {
    return `${bestSource.name} の概要: ${bestSource.summary}`;
  }

  return `「${bestSource.name}」を参照: ${bestSnippet}`;
}

function formatAssistantMessage(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`{1,3}/g, "")
    .replace(/\b務方針\b/g, "運用方針")
    .replace(/\s+([0-9]+\.)\s+/g, "\n$1 ")
    .replace(/。\s+/g, "。\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parsePricingPlans(value: unknown): PricingPlan[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const plan = item as Partial<PricingPlan>;
      return {
        name: String(plan.name ?? "").trim(),
        priceMonthlyYen:
          typeof plan.priceMonthlyYen === "number" ? plan.priceMonthlyYen : null,
        note: String(plan.note ?? "").trim(),
      };
    })
    .filter((plan) => plan.name.length > 0);
}

function buildPersonalChatLabel(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日のチャット`;
}

function formatChatThreadLabel(thread: ChatThread): string {
  return buildPersonalChatLabel(thread.createdAt ?? new Date());
}

function buildPdfSummaryMessage(fileName: string, summary: string, plans: PricingPlan[]): string {
  const summaryLine = summary.trim() || "概要を抽出できませんでした。";
  const planLine =
    plans.length > 0
      ? `料金: ${plans
          .map((plan) => {
            const amount =
              typeof plan.priceMonthlyYen === "number"
                ? `${plan.priceMonthlyYen.toLocaleString("ja-JP")}円/月`
                : "価格不明";
            return `${plan.name} ${amount}`;
          })
          .join(" / ")}`
      : "料金: 抽出なし";
  return `「${fileName}」をアップロードしました。\n概要: ${summaryLine}\n${planLine}`;
}

async function analyzePdfText(
  fileName: string,
  text: string,
): Promise<{ summary: string; plans: PricingPlan[] }> {
  const response = await fetch("/api/pdf-analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, text }),
  });

  if (!response.ok) {
    throw new Error(`analyze failed: ${response.status}`);
  }

  const data = (await response.json()) as { summary?: string; plans?: unknown };
  return {
    summary: String(data.summary ?? "").trim(),
    plans: parsePricingPlans(data.plans),
  };
}

async function extractUrlContent(url: string): Promise<{ title: string; text: string }> {
  const response = await fetch("/api/url-extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    throw new Error(`url extract failed: ${response.status}`);
  }
  const data = (await response.json()) as { title?: string; text?: string };
  return {
    title: String(data.title ?? "").trim(),
    text: sanitizeExtractedText(String(data.text ?? "")),
  };
}

async function generateAiReply(params: {
  question: string;
  selectedSourceName: string | null;
  sources: SourceItem[];
}): Promise<string> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: params.question,
      selectedSourceName: params.selectedSourceName,
      sources: params.sources.map((source) => ({
        name: source.name,
        summary: source.summary ?? "",
        text: source.text,
        pricingPlans: source.pricingPlans ?? [],
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(`chat api failed: ${response.status}`);
  }
  const data = (await response.json()) as { answer?: string };
  return String(data.answer ?? "").trim();
}

export default function HomePage() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const [showKnowledgeMenu, setShowKnowledgeMenu] = useState(false);
  const [showTextModal, setShowTextModal] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showTeamChatModal, setShowTeamChatModal] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamSubmitting, setTeamSubmitting] = useState(false);
  const [companyMembers, setCompanyMembers] = useState<CompanyMember[]>([]);
  const [teams, setTeams] = useState<TeamItem[]>([]);
  const [selectedMemberUids, setSelectedMemberUids] = useState<string[]>([]);
  const [activeChat, setActiveChat] = useState<ActiveChat>({ type: "personal" });
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [urlSubmitting, setUrlSubmitting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);
  const [showUploadedList, setShowUploadedList] = useState(false);
  const [selectedKnowledge, setSelectedKnowledge] = useState<SelectedKnowledge | null>(null);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [inheritSourceIds, setInheritSourceIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [thinkingDots, setThinkingDots] = useState(1);
  const [question, setQuestion] = useState("");
  const [globalSources, setGlobalSources] = useState<SourceItem[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const logError = (context: string, error: unknown) => {
    if (error instanceof Error) {
      console.error(`[home] ${context}:`, error.message);
      return;
    }
    console.error(`[home] ${context}:`, error);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setAuthUser(user);
      if (!user) {
        setLoading(false);
        router.replace("/login");
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (!userSnap.exists()) {
          logError("profile", "ユーザープロファイルが見つかりません。");
          setLoading(false);
          return;
        }

        const data = userSnap.data();
        setProfile({
          uid: user.uid,
          email: String(data.email ?? user.email ?? ""),
          displayName: String(data.displayName ?? user.displayName ?? user.email ?? user.uid),
          companyId: String(data.companyId ?? ""),
          companyName: String(data.companyName ?? ""),
          role: (data.role as "owner" | "member") ?? "member",
        });
      } catch (authError) {
        logError("auth-init", authError);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!authUser) {
      setGlobalSources([]);
      return;
    }

    const docsQuery = query(
      collection(db, "users", authUser.uid, "documents"),
      orderBy("createdAt", "desc"),
      limit(20),
    );
    const unsub = onSnapshot(docsQuery, (snapshot) => {
      const next = snapshot.docs.map((snap) => ({
        id: snap.id,
        name: String(snap.data().name ?? "Untitled PDF"),
        text: String(snap.data().text ?? ""),
        summary: String(snap.data().summary ?? ""),
        pricingPlans: parsePricingPlans(snap.data().pricingPlans),
        storagePath: String(snap.data().storagePath ?? ""),
        inheritedFromDocumentId: String(snap.data().inheritedFromDocumentId ?? ""),
        createdAt: toDate(snap.data().createdAt),
      }));
      setGlobalSources(next);
    }, (snapshotError) => logError("documents-snapshot", snapshotError));

    return () => unsub();
  }, [authUser]);

  useEffect(() => {
    if (!authUser) {
      setSources([]);
      return;
    }

    if (activeChat.type === "team") {
      if (!selectedChatId) {
        setSources([]);
        return;
      }

      const teamDocsQuery = query(
        collection(db, "users", authUser.uid, "chats", selectedChatId, "documents"),
        orderBy("createdAt", "desc"),
        limit(50),
      );
      const unsub = onSnapshot(teamDocsQuery, (snapshot) => {
        const next = snapshot.docs.map((snap) => ({
          id: snap.id,
          name: String(snap.data().name ?? "Untitled"),
          text: String(snap.data().text ?? ""),
          summary: String(snap.data().summary ?? ""),
          pricingPlans: parsePricingPlans(snap.data().pricingPlans),
          storagePath: String(snap.data().storagePath ?? ""),
          inheritedFromDocumentId: String(snap.data().inheritedFromDocumentId ?? ""),
          createdAt: toDate(snap.data().createdAt),
        }));
        setSources(next);
      }, (snapshotError) => logError("team-documents-snapshot", snapshotError));

      return () => unsub();
    }

    setSources(globalSources);
  }, [authUser, activeChat.type, selectedChatId, globalSources]);

  useEffect(() => {
    if (!profile?.companyId) {
      setCompanyMembers([]);
      return;
    }

    const membersQuery = query(
      collection(db, "users"),
      where("companyId", "==", profile.companyId),
      limit(50),
    );
    const unsub = onSnapshot(
      membersQuery,
      (snapshot) => {
        const next = snapshot.docs
          .map((memberDoc) => ({
            uid: memberDoc.id,
            email: String(memberDoc.data().email ?? ""),
            displayName: String(memberDoc.data().displayName ?? memberDoc.data().email ?? memberDoc.id),
          }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"));
        setCompanyMembers(next);
      },
      (snapshotError) => logError("company-members-snapshot", snapshotError),
    );

    return () => unsub();
  }, [profile?.companyId]);

  useEffect(() => {
    if (!authUser || !profile?.companyId) {
      setTeams([]);
      return;
    }

    const teamsQuery = query(
      collection(db, "companies", profile.companyId, "teams"),
      where("memberUids", "array-contains", authUser.uid),
      limit(30),
    );
    const unsub = onSnapshot(
      teamsQuery,
      (snapshot) => {
        const next = snapshot.docs
          .map((teamDoc) => ({
            id: teamDoc.id,
            name: String(teamDoc.data().name ?? "無題のチーム"),
            memberUids: Array.isArray(teamDoc.data().memberUids)
              ? (teamDoc.data().memberUids as string[])
              : [],
          }))
          .sort((a, b) => a.name.localeCompare(b.name, "ja"));
        setTeams(next);
      },
      (snapshotError) => logError("teams-snapshot", snapshotError),
    );

    return () => unsub();
  }, [authUser, profile?.companyId]);

  useEffect(() => {
    if (!authUser) {
      setChatThreads([]);
      setSelectedChatId(null);
      return;
    }
    if (activeChat.type === "team" && !activeChat.teamId) {
      setChatThreads([]);
      setSelectedChatId(null);
      return;
    }

    const chatsRef = collection(db, "users", authUser.uid, "chats");
    const chatsQuery =
      activeChat.type === "team"
        ? query(chatsRef, where("scopeType", "==", "team"), where("teamId", "==", activeChat.teamId))
        : query(chatsRef, where("scopeType", "==", "personal"));

    const unsub = onSnapshot(
      chatsQuery,
      (snapshot) => {
        const next = snapshot.docs
          .map((snap) => ({
            id: snap.id,
            scopeType: (snap.data().scopeType as "personal" | "team") ?? "personal",
            teamId: String(snap.data().teamId ?? ""),
            createdAt: toDate(snap.data().createdAt),
            updatedAt: toDate(snap.data().updatedAt),
          }))
          .sort((a, b) => {
            const aTime = a.updatedAt?.getTime() ?? a.createdAt?.getTime() ?? 0;
            const bTime = b.updatedAt?.getTime() ?? b.createdAt?.getTime() ?? 0;
            return bTime - aTime;
          });
        setChatThreads(next);
        setSelectedChatId((prev) => {
          if (prev && next.some((thread) => thread.id === prev)) return prev;
          return next.length > 0 ? next[0].id : null;
        });
      },
      (snapshotError) => logError("chats-snapshot", snapshotError),
    );

    return () => unsub();
  }, [authUser, activeChat]);

  const selectedSource = useMemo(
    () => (selectedKnowledge ? sources.find((source) => source.id === selectedKnowledge.id) ?? null : null),
    [selectedKnowledge, sources],
  );
  const selectedKnowledgeLabel = selectedSource?.name ?? selectedKnowledge?.name ?? null;
  const selectedTeam = useMemo(
    () => (activeChat.type === "team" ? teams.find((team) => team.id === activeChat.teamId) ?? null : null),
    [activeChat, teams],
  );
  const selectedThread = useMemo(
    () => (selectedChatId ? chatThreads.find((thread) => thread.id === selectedChatId) ?? null : null),
    [selectedChatId, chatThreads],
  );
  const chatTitle = activeChat.type === "team" && selectedTeam
    ? `${selectedTeam.name}のチャット`
    : formatChatThreadLabel(selectedThread ?? { id: "default", scopeType: "personal", createdAt: new Date() });

  useEffect(() => {
    if (activeChat.type !== "team") return;
    const stillExists = teams.some((team) => team.id === activeChat.teamId);
    if (!stillExists) {
      setActiveChat({ type: "personal" });
    }
  }, [activeChat, teams]);

  useEffect(() => {
    if (!messagesContainerRef.current) return;
    messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
  }, [messages, uploading]);

  useEffect(() => {
    if (!sending) {
      setThinkingDots(1);
      return;
    }
    const timer = window.setInterval(() => {
      setThinkingDots((prev) => (prev >= 3 ? 1 : prev + 1));
    }, 420);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    if (!selectedKnowledge) return;
    const exists = sources.some((source) => source.id === selectedKnowledge.id);
    if (!exists) {
      setSelectedKnowledge(null);
    }
  }, [sources, selectedKnowledge]);

  useEffect(() => {
    if (!authUser || !selectedChatId) {
      setMessages([]);
      return;
    }

    const messagesQuery = query(
      collection(db, "users", authUser.uid, "chats", selectedChatId, "messages"),
      orderBy("createdAt", "asc"),
    );
    const unsub = onSnapshot(messagesQuery, (snapshot) => {
      const next = snapshot.docs.map((snap) => ({
        id: snap.id,
        sender: (snap.data().sender as "user" | "assistant") ?? "assistant",
        text: String(snap.data().text ?? ""),
        createdAt: toDate(snap.data().createdAt),
      }));
      setMessages(next);
    }, (snapshotError) => logError("messages-snapshot", snapshotError));

    return () => unsub();
  }, [authUser, selectedChatId]);

  const createNewChatThread = async (): Promise<string | null> => {
    if (!authUser) return null;
    if (activeChat.type === "team" && !selectedTeam) return null;

    setCreatingChat(true);
    try {
      const created = await addDoc(collection(db, "users", authUser.uid, "chats"), {
        scopeType: activeChat.type,
        teamId: activeChat.type === "team" ? selectedTeam?.id ?? "" : "",
        teamName: activeChat.type === "team" ? selectedTeam?.name ?? "" : "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSelectedChatId(created.id);
      return created.id;
    } catch (error) {
      logError("chat-create", error);
      return null;
    } finally {
      setCreatingChat(false);
    }
  };

  const createTeamChatWithInheritance = async (sourceIds: string[]): Promise<string | null> => {
    if (!authUser || !selectedTeam) return null;

    setCreatingChat(true);
    try {
      const created = await addDoc(collection(db, "users", authUser.uid, "chats"), {
        scopeType: "team",
        teamId: selectedTeam.id,
        teamName: selectedTeam.name,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const inheritTargets = globalSources.filter((source) => sourceIds.includes(source.id));
      for (const source of inheritTargets) {
        await addDoc(collection(db, "users", authUser.uid, "chats", created.id, "documents"), {
          name: source.name,
          text: source.text,
          summary: source.summary ?? "",
          pricingPlans: source.pricingPlans ?? [],
          storagePath: source.storagePath ?? "",
          inheritedFromDocumentId: source.id,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      setSelectedChatId(created.id);
      return created.id;
    } catch (error) {
      logError("team-chat-create", error);
      return null;
    } finally {
      setCreatingChat(false);
    }
  };

  const ensureActiveChatId = async (): Promise<string | null> => {
    if (selectedChatId) return selectedChatId;
    return createNewChatThread();
  };

  const handleCreateNewChat = async () => {
    if (activeChat.type === "team") {
      setInheritSourceIds([]);
      setShowTeamChatModal(true);
      return;
    }
    await createNewChatThread();
  };

  const toggleInheritSource = (sourceId: string) => {
    setInheritSourceIds((prev) =>
      prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId],
    );
  };

  const handleTeamChatCreateSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const createdId = await createTeamChatWithInheritance(inheritSourceIds);
    if (!createdId) return;
    setInheritSourceIds([]);
    setShowTeamChatModal(false);
  };

  const handleKnowledgeUpload = async (
    files: File[],
    kind: "pdf" | "text",
  ) => {
    if (!authUser || files.length === 0) return;
    const activeId = await ensureActiveChatId();
    if (!activeId) return;

    setUploading(true);
    try {
      for (const file of files) {
        if (
          kind === "pdf" &&
          file.type !== "application/pdf" &&
          !file.name.toLowerCase().endsWith(".pdf")
        ) {
          throw new Error("PDFを選択してください。");
        }
        if (
          kind === "text" &&
          !file.type.startsWith("text/") &&
          !/\.(txt|md|csv)$/i.test(file.name)
        ) {
          throw new Error("テキストファイル（txt / md / csv）を選択してください。");
        }

        const text =
          kind === "pdf"
            ? await extractPdfText(file)
            : sanitizeExtractedText(await file.text());
        const analysis = await analyzePdfText(file.name, text);
        const storagePath =
          activeChat.type === "team"
            ? `users/${authUser.uid}/chats/${activeId}/documents/${Date.now()}-${file.name}`
            : `users/${authUser.uid}/documents/${Date.now()}-${file.name}`;
        const objectRef = ref(storage, storagePath);
        setUploadStatus({ fileName: file.name, progress: 0 });
        await new Promise<void>((resolve, reject) => {
          const task = uploadBytesResumable(objectRef, file, { contentType: file.type });
          task.on(
            "state_changed",
            (snapshot) => {
              const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
              setUploadStatus({ fileName: file.name, progress });
            },
            (uploadError) => reject(uploadError),
            () => resolve(),
          );
        });
        const downloadURL = await getDownloadURL(objectRef);

        const docPayload = {
          name: file.name,
          text,
          summary: analysis.summary,
          pricingPlans: analysis.plans,
          storagePath,
          downloadURL,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (activeChat.type === "team") {
          await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "documents"), docPayload);
        } else {
          await addDoc(collection(db, "users", authUser.uid, "documents"), docPayload);
        }

        await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
          sender: "assistant",
          text: buildPdfSummaryMessage(file.name, analysis.summary, analysis.plans),
          createdAt: serverTimestamp(),
        });
        await updateDoc(doc(db, "users", authUser.uid, "chats", activeId), {
          updatedAt: serverTimestamp(),
        });
      }
    } catch (uploadError) {
      logError("upload", uploadError);
    } finally {
      setUploading(false);
      setUploadStatus(null);
    }
  };

  const handleUpload = (
    event: ChangeEvent<HTMLInputElement>,
    kind: "pdf" | "text",
  ) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void handleKnowledgeUpload(files, kind);
  };

  const handleTextModalSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authUser) return;
    const activeId = await ensureActiveChatId();
    if (!activeId) return;

    const title = textTitle.trim() || "テキストナレッジ";
    const body = sanitizeExtractedText(textBody);
    if (!body) return;

    setUploading(true);
    setUploadStatus({ fileName: title, progress: 100 });

    try {
      const analysis = await analyzePdfText(title, body);
      const docPayload = {
        name: `${title}.txt`,
        text: body,
        summary: analysis.summary,
        pricingPlans: analysis.plans,
        storagePath: "",
        downloadURL: "",
        sourceType: "text",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (activeChat.type === "team") {
        await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "documents"), docPayload);
      } else {
        await addDoc(collection(db, "users", authUser.uid, "documents"), docPayload);
      }

      await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
        sender: "assistant",
        text: buildPdfSummaryMessage(`${title}.txt`, analysis.summary, analysis.plans),
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "users", authUser.uid, "chats", activeId), {
        updatedAt: serverTimestamp(),
      });

      setTextTitle("");
      setTextBody("");
      setShowTextModal(false);
    } catch (error) {
      logError("text-modal-submit", error);
    } finally {
      setUploading(false);
      setUploadStatus(null);
    }
  };

  const handleUrlModalSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authUser) return;
    const activeId = await ensureActiveChatId();
    if (!activeId) return;

    const url = urlInput.trim();
    if (!url) return;

    setUrlSubmitting(true);
    setUploading(true);
    setUploadStatus({ fileName: "URL", progress: 30 });
    try {
      const extracted = await extractUrlContent(url);
      setUploadStatus({ fileName: extracted.title || url, progress: 60 });
      if (!extracted.text) {
        throw new Error("URLから本文を抽出できませんでした。");
      }

      const analysis = await analyzePdfText(extracted.title || url, extracted.text);
      setUploadStatus({ fileName: extracted.title || url, progress: 100 });
      const docPayload = {
        name: extracted.title || url,
        text: extracted.text,
        summary: analysis.summary,
        pricingPlans: analysis.plans,
        sourceType: "url",
        sourceUrl: url,
        storagePath: "",
        downloadURL: "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (activeChat.type === "team") {
        await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "documents"), docPayload);
      } else {
        await addDoc(collection(db, "users", authUser.uid, "documents"), docPayload);
      }

      await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
        sender: "assistant",
        text: buildPdfSummaryMessage(extracted.title || url, analysis.summary, analysis.plans),
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "users", authUser.uid, "chats", activeId), {
        updatedAt: serverTimestamp(),
      });

      setUrlInput("");
      setShowUrlModal(false);
    } catch (error) {
      logError("url-modal-submit", error);
    } finally {
      setUploading(false);
      setUploadStatus(null);
      setUrlSubmitting(false);
    }
  };

  const handleAsk = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authUser || !question.trim() || sending) return;
    const activeId = await ensureActiveChatId();
    if (!activeId) return;

    const userQuestion = question.trim();
    setQuestion("");
    setSending(true);
    try {
      await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
        sender: "user",
        text: userQuestion,
        createdAt: serverTimestamp(),
      });

      const targetSources = selectedSource ? [selectedSource] : sources;
      let assistantReply = "";
      try {
        assistantReply = await generateAiReply({
          question: userQuestion,
          selectedSourceName: selectedSource?.name ?? null,
          sources: targetSources,
        });
      } catch (apiError) {
        logError("chat-api", apiError);
      }
      if (!assistantReply) {
        assistantReply = buildAssistantReply(userQuestion, targetSources);
      }
      await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
        sender: "assistant",
        text: assistantReply,
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "users", authUser.uid, "chats", activeId), {
        updatedAt: serverTimestamp(),
      });
    } catch (chatError) {
      logError("chat-send", chatError);
      try {
        await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
          sender: "assistant",
          text: "回答の生成に失敗しました。もう一度お試しください。",
          createdAt: serverTimestamp(),
        });
      } catch (fallbackError) {
        logError("chat-fallback", fallbackError);
      }
    } finally {
      setSending(false);
    }
  };

  const handleDeleteSource = async (source: SourceItem) => {
    if (!authUser) return;
    if (activeChat.type === "team" && !selectedChatId) return;
    const shouldDelete = window.confirm(`「${source.name}」を削除しますか？`);
    if (!shouldDelete) return;

    setDeletingSourceId(source.id);
    try {
      const deletingTeamLocalSource = activeChat.type === "team" && !source.inheritedFromDocumentId;
      if (source.storagePath && (activeChat.type !== "team" || deletingTeamLocalSource)) {
        await deleteObject(ref(storage, source.storagePath));
      }
      if (activeChat.type === "team") {
        if (!selectedChatId) return;
        await deleteDoc(doc(db, "users", authUser.uid, "chats", selectedChatId, "documents", source.id));
      } else {
        await deleteDoc(doc(db, "users", authUser.uid, "documents", source.id));
      }
      if (selectedKnowledge?.id === source.id) {
        setSelectedKnowledge(null);
      }
    } catch (deleteError) {
      logError("delete-source", deleteError);
    } finally {
      setDeletingSourceId(null);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    router.replace("/login");
  };

  const openInviteModal = () => {
    setTeamName("");
    setInviteEmail("");
    setSelectedMemberUids(authUser ? [authUser.uid] : []);
    setShowInviteModal(true);
  };

  const closeInviteModal = () => {
    if (inviteSubmitting || teamSubmitting) return;
    setTeamName("");
    setInviteEmail("");
    setSelectedMemberUids([]);
    setShowInviteModal(false);
  };

  const toggleMemberSelection = (memberUid: string) => {
    setSelectedMemberUids((prev) =>
      prev.includes(memberUid) ? prev.filter((uid) => uid !== memberUid) : [...prev, memberUid],
    );
  };

  const handleCreateTeam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authUser || !profile?.companyId) return;

    const normalizedName = teamName.trim();
    if (!normalizedName) {
      logError("team-create", "チーム名を入力してください。");
      return;
    }

    const memberUids = Array.from(new Set([authUser.uid, ...selectedMemberUids]));

    setTeamSubmitting(true);
    try {
      await addDoc(collection(db, "companies", profile.companyId, "teams"), {
        companyId: profile.companyId,
        companyName: profile.companyName,
        name: normalizedName,
        memberUids,
        memberCount: memberUids.length,
        createdByUid: authUser.uid,
        createdByName: profile.displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setTeamName("");
      setSelectedMemberUids([authUser.uid]);
      setShowInviteModal(false);
    } catch (error) {
      logError("team-create-submit", error);
    } finally {
      setTeamSubmitting(false);
    }
  };

  const handleInviteSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authUser || !profile) return;
    if (!profile.companyId) {
      logError("team-invite", "companyId が未設定です。");
      return;
    }

    const email = inviteEmail.trim().toLowerCase();
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!looksLikeEmail) {
      logError("team-invite", "メールアドレス形式が不正です。");
      return;
    }

    setInviteSubmitting(true);
    try {
      await addDoc(collection(db, "companies", profile.companyId, "teamInvites"), {
        companyId: profile.companyId,
        companyName: profile.companyName,
        email,
        status: "PENDING",
        invitedByUid: authUser.uid,
        invitedByName: profile.displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setInviteEmail("");
      setShowInviteModal(false);
    } catch (error) {
      logError("team-invite-submit", error);
    } finally {
      setInviteSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#e9eaf4]">
        <p className="text-sm text-[#505565]">読み込み中...</p>
      </main>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-[radial-gradient(1200px_620px_at_20%_-10%,#e7eeff_0%,#edf1fa_45%,#e9edf6_100%)]">
      <div className="origin-top-left h-[calc(100vh/0.65)] [transform:scale(0.65)] [width:calc(100%/0.65)] p-5 md:p-6">
        <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-[420px_1fr]">
          <aside className="rounded-lg border border-[#d8deef] bg-white/90 shadow-[0_14px_40px_rgba(17,41,120,0.08)] backdrop-blur-sm">
            <div className="border-b border-[#dedfea] px-6 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h1 className="text-xl font-semibold tracking-tight text-[#20263a]">チャット履歴</h1>
                  <p className="mt-1 text-sm text-[#5a627c]">
                    {profile?.companyName ?? "会社名"} / {profile?.displayName ?? "ユーザー"}
                  </p>
                </div>
                <button
                  onClick={handleLogout}
                  className="rounded-md border border-[#d4dcf0] bg-white px-3 py-2 text-xs font-medium text-[#334066] hover:bg-[#f7f9ff]"
                >
                  ログアウト
                </button>
              </div>
            </div>

            <div className="p-4">
              <button
                type="button"
                onClick={openInviteModal}
                className="w-full rounded-md border border-[#cfd8f0] bg-white px-3 py-2 text-sm font-medium text-[#2f3f6d] hover:bg-[#f7f9ff]"
              >
                ＋チーム追加
              </button>

              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold tracking-wide text-[#6a748f]">チーム</p>
                <div className="space-y-2">
                  {teams.map((team) => (
                    <div key={team.id} className="space-y-1">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveChat({ type: "team", teamId: team.id });
                          setSelectedChatId(null);
                        }}
                        className={`w-full rounded-sm border px-3 py-2 text-left text-sm ${
                          activeChat.type === "team" && activeChat.teamId === team.id
                            ? "border-[#1440e1] bg-[#eff3ff] text-[#1440e1]"
                            : "border-[#e2e5f0] bg-white text-[#2f354a] hover:bg-[#f8faff]"
                        }`}
                      >
                        {team.name}
                      </button>
                      {activeChat.type === "team" && activeChat.teamId === team.id ? (
                        <div className="space-y-1 rounded-sm border border-[#e4e8f4] bg-[#fafbff] p-2">
                          {chatThreads.map((thread) => (
                            <button
                              key={thread.id}
                              type="button"
                              onClick={() => setSelectedChatId(thread.id)}
                              className={`w-full rounded-sm px-2 py-1 text-left text-xs ${
                                selectedChatId === thread.id
                                  ? "bg-[#eaf0ff] font-medium text-[#1440e1]"
                                  : "text-[#4b5268] hover:bg-[#f1f4ff]"
                              }`}
                            >
                              {formatChatThreadLabel(thread)}
                            </button>
                          ))}
                          {chatThreads.length === 0 ? (
                            <p className="px-2 py-1 text-xs text-[#7a8198]">履歴はまだありません</p>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void handleCreateNewChat()}
                            disabled={creatingChat}
                            className="w-full rounded-sm border border-[#cfd8f0] bg-white px-2 py-1 text-xs font-medium text-[#1440e1] hover:bg-[#f5f8ff] disabled:opacity-60"
                          >
                            {creatingChat ? "作成中..." : "+NEWチャット"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {teams.length === 0 ? (
                    <p className="rounded-sm border border-dashed border-[#d8deee] px-3 py-2 text-xs text-[#7a8198]">
                      チームがまだありません
                    </p>
                  ) : null}
                </div>

                <div className="my-4 border-t border-[#e2e7f5]" />

                <p className="mb-2 text-xs font-semibold tracking-wide text-[#6a748f]">個人チャット履歴</p>
                <button
                  type="button"
                  onClick={() => {
                    setActiveChat({ type: "personal" });
                    setSelectedChatId(null);
                  }}
                  className={`w-full rounded-sm border px-3 py-2 text-left text-sm ${
                    activeChat.type === "personal"
                      ? "border-[#1440e1] bg-[#eff3ff] text-[#1440e1]"
                      : "border-[#e2e5f0] bg-white text-[#2f354a] hover:bg-[#f8faff]"
                  }`}
                >
                  個人チャット
                </button>
                {activeChat.type === "personal" ? (
                  <div className="mt-2 space-y-2">
                    <div className="space-y-1 rounded-sm border border-[#e4e8f4] bg-[#fafbff] p-2">
                      {chatThreads.map((thread) => (
                        <button
                          key={thread.id}
                          type="button"
                          onClick={() => setSelectedChatId(thread.id)}
                          className={`w-full rounded-sm px-2 py-1 text-left text-xs ${
                            selectedChatId === thread.id
                              ? "bg-[#eaf0ff] font-medium text-[#1440e1]"
                              : "text-[#4b5268] hover:bg-[#f1f4ff]"
                          }`}
                        >
                          {formatChatThreadLabel(thread)}
                        </button>
                      ))}
                      {chatThreads.length === 0 ? (
                        <p className="px-2 py-1 text-xs text-[#7a8198]">履歴はまだありません</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCreateNewChat()}
                      disabled={creatingChat}
                      className="w-full rounded-sm border border-[#cfd8f0] bg-white px-2 py-1 text-xs font-medium text-[#1440e1] hover:bg-[#f5f8ff] disabled:opacity-60"
                    >
                      {creatingChat ? "作成中..." : "+NEWチャット"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </aside>

          <section className="min-h-0 rounded-lg border border-[#d8deef] bg-white/90 shadow-[0_14px_40px_rgba(17,41,120,0.08)] backdrop-blur-sm">
            <div className="border-b border-[#dedfea] px-6 py-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold tracking-tight text-[#20263a]">{chatTitle}</h2>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <button
                      onClick={() => setShowKnowledgeMenu((prev) => !prev)}
                      className="flex h-8 items-center justify-center rounded-md border border-[#cfd8f0] bg-white px-3 text-xs font-medium text-[#2f3f6d] hover:bg-[#f7f9ff]"
                    >
                      ＋ナレッジを追加
                    </button>
                    {showKnowledgeMenu ? (
                      <div className="absolute right-0 top-9 z-30 w-36 rounded-sm border border-[#d5d7e3] bg-white p-1 shadow-sm">
                        <button
                          onClick={() => {
                            setShowKnowledgeMenu(false);
                            pdfInputRef.current?.click();
                          }}
                          className="block w-full rounded-sm px-2 py-1 text-left text-xs text-[#2f3345] hover:bg-[#f2f4fb]"
                        >
                          PDFを追加
                        </button>
                        <button
                          onClick={() => {
                            setShowKnowledgeMenu(false);
                            setShowTextModal(true);
                          }}
                          className="block w-full rounded-sm px-2 py-1 text-left text-xs text-[#2f3345] hover:bg-[#f2f4fb]"
                        >
                          テキストを追加
                        </button>
                        <button
                          onClick={() => {
                            setShowKnowledgeMenu(false);
                            setShowUrlModal(true);
                          }}
                          className="block w-full rounded-sm px-2 py-1 text-left text-xs text-[#2f3345] hover:bg-[#f2f4fb]"
                        >
                          URLを追加
                        </button>
                      </div>
                    ) : null}
                    <input
                      ref={pdfInputRef}
                      type="file"
                      accept="application/pdf"
                      multiple
                      onChange={(event) => handleUpload(event, "pdf")}
                      className="hidden"
                    />
                  </div>
                  <button
                    onClick={() => setShowUploadedList((prev) => !prev)}
                    className="rounded-md border border-[#cfd8f0] bg-white px-2 py-1 text-xs font-medium text-[#1440e1] hover:bg-[#f7f9ff]"
                  >
                    {showUploadedList ? "一覧を閉じる" : "一覧を開く"}
                  </button>
                </div>
              </div>
            </div>

            {selectedKnowledgeLabel ? (
              <div className="border-b border-[#eef1f8] px-6 py-2 text-center text-sm font-semibold text-[#1440e1]">
                --------- {selectedKnowledgeLabel} を選択中 ---------
              </div>
            ) : null}

            <div className="flex h-[calc(100%-72px)] min-h-0 flex-col">
              {showUploadedList ? (
                <div className="border-b border-[#dedfea] bg-[#fbfbfd] px-6 py-4">
                  <p className="text-xs text-[#6f7280]">アップロード済みナレッジ</p>
                  <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
                    {sources.map((source) => (
                      <li
                        key={source.id}
                        className={`rounded-sm border bg-white p-2 ${
                          selectedKnowledge?.id === source.id
                            ? "border-[#1440e1]"
                            : "border-[#e2e3eb]"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedKnowledge({
                                id: source.id,
                                name: source.name,
                              })
                            }
                            className="min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left text-sm text-[#2f3240] hover:bg-[#f2f4fb]"
                          >
                            {source.name}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteSource(source);
                            }}
                            disabled={deletingSourceId === source.id}
                            className="rounded-sm border border-[#d5d7e3] px-2 py-1 text-[11px] text-[#5a5e6d] disabled:opacity-50"
                          >
                            {deletingSourceId === source.id ? "削除中" : "削除"}
                          </button>
                        </div>
                      </li>
                    ))}
                    {sources.length === 0 ? (
                      <li className="rounded-sm border border-dashed border-[#d5d7e4] p-2 text-xs text-[#6f7280]">
                        まだナレッジがありません
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}

              <div ref={messagesContainerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
                {messages.length === 0 && activeChat.type === "team" && sources.length === 0 ? (
                  <div className="mx-auto mt-20 max-w-2xl text-center">
                    <h3 className="text-3xl font-semibold text-[#333640]">
                      ナレッジを追加して始める
                    </h3>
                    <p className="mt-3 text-sm text-[#697082]">
                      このチーム専用のナレッジを追加してください。
                    </p>
                  </div>
                ) : null}

                {messages.map((message) => (
                  message.sender === "user" ? (
                    <div
                      key={message.id}
                      className="relative ml-auto w-fit max-w-3xl rounded-[10px] border border-[#e1e6f2] bg-white px-4 py-3 text-sm text-[#1f2433] shadow-[3px_3px_0_0_#d6dae4] after:absolute after:-bottom-[6px] after:right-2 after:h-3 after:w-3 after:rotate-45 after:border-r after:border-b after:border-[#e1e6f2] after:bg-white after:shadow-[2px_2px_0_0_#d6dae4] after:content-['']"
                    >
                      <p>{message.text}</p>
                    </div>
                  ) : (
                    <div key={message.id} className="mr-auto flex max-w-3xl items-start gap-2">
                      <div className="mt-0.5 inline-flex h-7 w-7 shrink-0 aspect-square items-center justify-center rounded-full bg-[#1440e1] text-white">
                        <svg
                          viewBox="0 0 24 24"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M12 4v2" />
                          <rect x="6" y="7" width="12" height="10" rx="2" />
                          <circle cx="10" cy="12" r="1" fill="currentColor" />
                          <circle cx="14" cy="12" r="1" fill="currentColor" />
                          <path d="M9 15h6" />
                        </svg>
                      </div>
                      <div className="w-fit max-w-3xl rounded-[10px] border border-[#cfdcff] bg-[#eaf0ff] px-4 py-3 text-sm text-[#1f2a44] shadow-[3px_3px_0_0_#cfdcff]">
                        <p className="whitespace-pre-wrap leading-relaxed">
                          {formatAssistantMessage(message.text)}
                        </p>
                      </div>
                    </div>
                  )
                ))}

                {sending ? (
                  <div className="mr-auto flex max-w-3xl items-start gap-2">
                    <div className="mt-0.5 inline-flex h-7 w-7 shrink-0 aspect-square items-center justify-center rounded-full bg-[#1440e1] text-white">
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 4v2" />
                        <rect x="6" y="7" width="12" height="10" rx="2" />
                        <circle cx="10" cy="12" r="1" fill="currentColor" />
                        <circle cx="14" cy="12" r="1" fill="currentColor" />
                        <path d="M9 15h6" />
                      </svg>
                    </div>
                    <div className="w-fit max-w-3xl rounded-[10px] border border-[#cfdcff] bg-[#eaf0ff] px-4 py-3 text-sm text-[#1f2a44] shadow-[3px_3px_0_0_#cfdcff]">
                      <p className="font-medium text-[#254086]">
                        考え中{".".repeat(thinkingDots)}
                      </p>
                      <div className="mt-1 flex items-center gap-1">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#5a79e8]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#5a79e8] [animation-delay:120ms]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#5a79e8] [animation-delay:240ms]" />
                      </div>
                    </div>
                  </div>
                ) : null}

                {uploading && uploadStatus ? (
                  <div className="mr-auto w-fit max-w-3xl rounded-[10px] border border-[#cfdcff] bg-[#eaf0ff] px-4 py-3 text-sm text-[#1f2a44] shadow-[3px_3px_0_0_#cfdcff]">
                    <p className="mb-2">
                      {uploadStatus.fileName} をアップロード中... {uploadStatus.progress}%
                    </p>
                    <div className="h-2 w-full rounded-sm bg-[#e8eaf2]">
                      <div
                        className="h-2 rounded-sm bg-[#1440e1] transition-all"
                        style={{ width: `${uploadStatus.progress}%` }}
                      />
                    </div>
                  </div>
                ) : null}

              </div>

              <form onSubmit={handleAsk} className="border-t border-[#dedfea] bg-white px-6 py-4">
                <div className="flex items-center gap-3">
                  <input
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="PDF内容について質問してください"
                    className="h-12 flex-1 rounded-sm border border-[#d7dae6] px-4 text-sm outline-none focus:border-[#6b739a]"
                  />
                  <button
                    disabled={sending}
                    className="h-12 rounded-sm bg-[#1440e1] px-5 text-sm font-medium text-white disabled:opacity-60"
                  >
                    {sending ? "送信中..." : "送信"}
                  </button>
                </div>
              </form>
            </div>
          </section>

        </div>
      </div>

      {showTextModal ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-xl rounded-md border border-[#d7d8e2] bg-white p-5">
            <h3 className="text-base font-semibold text-[#2d2f39]">テキストを追加</h3>
            <form className="mt-4 space-y-3" onSubmit={handleTextModalSubmit}>
              <input
                value={textTitle}
                onChange={(event) => setTextTitle(event.target.value)}
                placeholder="タイトル（任意）"
                className="h-10 w-full rounded-sm border border-[#d7dae6] px-3 text-sm outline-none focus:border-[#6b739a]"
              />
              <textarea
                value={textBody}
                onChange={(event) => setTextBody(event.target.value)}
                placeholder="ここにテキストを貼り付け"
                className="h-48 w-full rounded-sm border border-[#d7dae6] px-3 py-2 text-sm outline-none focus:border-[#6b739a]"
                required
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowTextModal(false)}
                  className="rounded-sm border border-[#d5d7e3] px-3 py-2 text-xs text-[#4a4f60]"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="rounded-sm bg-[#1440e1] px-3 py-2 text-xs text-white"
                >
                  追加
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showUrlModal ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-xl rounded-md border border-[#d7d8e2] bg-white p-5">
            <h3 className="text-base font-semibold text-[#2d2f39]">URLを追加</h3>
            <form className="mt-4 space-y-3" onSubmit={handleUrlModalSubmit}>
              <input
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                placeholder="https://example.com/article"
                className="h-10 w-full rounded-sm border border-[#d7dae6] px-3 text-sm outline-none focus:border-[#6b739a]"
                required
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (urlSubmitting) return;
                    setUrlInput("");
                    setShowUrlModal(false);
                  }}
                  className="rounded-sm border border-[#d5d7e3] px-3 py-2 text-xs text-[#4a4f60]"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={urlSubmitting}
                  className="rounded-sm bg-[#1440e1] px-3 py-2 text-xs text-white disabled:opacity-60"
                >
                  {urlSubmitting ? "追加中..." : "追加"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showTeamChatModal ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-xl rounded-md border border-[#d7d8e2] bg-white p-5">
            <h3 className="text-base font-semibold text-[#2d2f39]">チームチャットを作成</h3>
            <p className="mt-2 text-xs text-[#6a748f]">
              引き継ぎたいナレッジがあれば選択してください。選択しない場合は空のチームチャットを作成します。
            </p>
            <form className="mt-4 space-y-3" onSubmit={handleTeamChatCreateSubmit}>
              <div className="max-h-64 space-y-2 overflow-auto rounded-sm border border-[#e2e5f0] bg-[#fbfcff] p-3">
                {globalSources.map((source) => (
                  <label
                    key={source.id}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-[#f2f5ff]"
                  >
                    <input
                      type="checkbox"
                      checked={inheritSourceIds.includes(source.id)}
                      onChange={() => toggleInheritSource(source.id)}
                      className="h-4 w-4 accent-[#1440e1]"
                    />
                    <span className="truncate text-sm text-[#2f354a]">{source.name}</span>
                  </label>
                ))}
                {globalSources.length === 0 ? (
                  <p className="text-xs text-[#7a8198]">登録済みナレッジがありません</p>
                ) : null}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (creatingChat) return;
                    setInheritSourceIds([]);
                    setShowTeamChatModal(false);
                  }}
                  className="rounded-sm border border-[#d5d7e3] px-3 py-2 text-xs text-[#4a4f60]"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={creatingChat}
                  className="rounded-sm bg-[#1440e1] px-3 py-2 text-xs text-white disabled:opacity-60"
                >
                  {creatingChat ? "作成中..." : "作成する"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showInviteModal ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-xl rounded-md border border-[#d7d8e2] bg-white p-5">
            <h3 className="text-base font-semibold text-[#2d2f39]">チーム追加</h3>
            <p className="mt-2 text-xs text-[#6a748f]">
              チーム名とメンバーを設定し、必要なら下からメンバー招待もできます。
            </p>

            <form className="mt-4 space-y-3" onSubmit={handleCreateTeam}>
              <input
                value={teamName}
                onChange={(event) => setTeamName(event.target.value)}
                placeholder="チーム名を入力"
                className="h-10 w-full rounded-sm border border-[#d7dae6] px-3 text-sm outline-none focus:border-[#6b739a]"
                required
              />
              <div className="rounded-sm border border-[#e2e5f0] bg-[#fbfcff] p-3">
                <p className="text-xs font-medium text-[#5f6986]">同じ会社のメンバー</p>
                {companyMembers.length === 0 ? (
                  <p className="mt-2 text-xs text-[#7a849d]">ここに同じ会社のメンバーが表示されます</p>
                ) : (
                  <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
                    {companyMembers.map((member) => (
                      <li key={member.uid}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-[#f2f5ff]">
                          <input
                            type="checkbox"
                            checked={selectedMemberUids.includes(member.uid)}
                            onChange={() => toggleMemberSelection(member.uid)}
                            className="h-4 w-4 accent-[#1440e1]"
                          />
                          <span className="text-sm text-[#2f354a]">{member.displayName}</span>
                          <span className="truncate text-xs text-[#7a8198]">{member.email}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeInviteModal}
                  className="rounded-sm border border-[#d5d7e3] px-3 py-2 text-xs text-[#4a4f60]"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={teamSubmitting}
                  className="rounded-sm bg-[#1440e1] px-3 py-2 text-xs text-white disabled:opacity-60"
                >
                  {teamSubmitting ? "作成中..." : "チームを作成"}
                </button>
              </div>
            </form>

            <div className="my-4 h-px bg-[#e5e8f2]" />

            <form className="space-y-3" onSubmit={handleInviteSubmit}>
              <p className="text-xs font-medium text-[#5f6986]">メンバー招待</p>
              <input
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="example@company.com"
                className="h-10 w-full rounded-sm border border-[#d7dae6] px-3 text-sm outline-none focus:border-[#6b739a]"
                required
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={inviteSubmitting}
                  className="rounded-sm border border-[#c8d3f7] bg-[#f5f7ff] px-3 py-2 text-xs font-medium text-[#1440e1] disabled:opacity-60"
                >
                  {inviteSubmitting ? "送信中..." : "招待を送信"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
