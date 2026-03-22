"use client";

import Image from "next/image";
import { ChangeEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { User, onAuthStateChanged, signOut } from "firebase/auth";
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
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
import { documentDoc, documentsCol } from "@/lib/firestore-paths";

type UserProfile = {
  uid: string;
  email: string;
  displayName: string;
  companyId: string;
  companyName: string;
  role: "owner" | "admin" | "member";
};

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
  updateMemo?: string;
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

type SavedMemo = {
  id: string;
  text: string;
  createdAt?: Date;
};

type UploadStatus = {
  fileName: string;
  progress: number;
};

type SelectedKnowledge = {
  id: string;
  name: string;
};

type KnowledgeComment = {
  id: string;
  text: string;
  authorName: string;
  createdAt?: Date;
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeKnowledgeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/\s+/g, " ")
    .trim();
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

function isStorageObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string };
  return candidate.code === "storage/object-not-found";
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
  const normalized = sanitizeExtractedText(text);
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
    const prices = sources.flatMap((source) =>
      extractPriceLines([source.updateMemo ?? "", source.text].join(" ")).map((line) => `${source.name}: ${line}`),
    );
    if (prices.length > 0) {
      return [
        "料金",
        ...prices.map((line) => `・${line}`),
      ].join("\n");
    }
    return [
      "本文内に料金情報は確認できませんでした。",
      "料金表や価格記載のある本文があれば、その内容だけで再回答できます。",
    ].join("\n");
  }

  let bestSource: SourceItem | null = null;
  let bestScore = -1;
  let bestSnippet = "";

  for (const source of sources) {
    const mergedText = [source.updateMemo ?? "", source.text].filter(Boolean).join(" ");
    const normalizedSource = normalizeText(mergedText);
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
        const end = Math.min(mergedText.length, firstHitIndex + 220);
        bestSnippet = mergedText.slice(start, end).replace(/\s+/g, " ").trim();
      } else {
        bestSnippet = mergedText.slice(0, 220).replace(/\s+/g, " ").trim();
      }
    }
  }

  if (!bestSource) return "回答に使えるテキストを見つけられませんでした。";

  if (bestSource.updateMemo && bestScore <= 0) {
    return `${bestSource.name} の変更メモ: ${bestSource.updateMemo}`;
  }

  if (bestSource.summary && bestScore <= 0) {
    return `${bestSource.name} の概要: ${bestSource.summary}`;
  }

  return `「${bestSource.name}」を参照: ${bestSnippet}`;
}

function hasAppliedUpdateMemo(sources: SourceItem[]): boolean {
  return sources.some((source) => Boolean(source.updateMemo?.trim()));
}

function pickRelevantSourceNames(question: string, sources: SourceItem[], limitCount = 3): string[] {
  if (sources.length === 0) return [];

  const normalizedQuestion = normalizeText(question);
  const tokens = normalizedQuestion
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  const scored = sources.map((source) => {
    const normalizedSource = normalizeText(source.text);
    if (!normalizedSource) return { name: source.name, score: 0 };
    const score = tokens.reduce((acc, token) => (normalizedSource.includes(token) ? acc + 1 : acc), 0);
    return { name: source.name, score };
  });

  const top = scored
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.score > 0)
    .slice(0, limitCount)
    .map((item) => item.name);

  if (top.length > 0) return Array.from(new Set(top));
  return Array.from(new Set(sources.slice(0, limitCount).map((source) => source.name)));
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

function buildPersonalChatLabel(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日のチャット`;
}

function formatChatThreadLabel(thread: ChatThread): string {
  return buildPersonalChatLabel(thread.createdAt ?? new Date());
}

function buildPdfSummaryMessage(fileName: string, summary: string): string {
  const summaryLine = summary.trim() || "概要を抽出できませんでした。";
  return `「${fileName}」をアップロードしました。\n概要: ${summaryLine}`;
}

async function analyzePdfText(
  fileName: string,
  text: string,
): Promise<{ summary: string }> {
  const response = await fetch("/api/pdf-analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, text }),
  });

  if (!response.ok) {
    throw new Error(`analyze failed: ${response.status}`);
  }

  const data = (await response.json()) as { summary?: string };
  return {
    summary: String(data.summary ?? "").trim(),
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
        updateMemo: source.updateMemo ?? "",
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
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [urlSubmitting, setUrlSubmitting] = useState(false);
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [selectedKnowledge, setSelectedKnowledge] = useState<SelectedKnowledge | null>(null);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [sending, setSending] = useState(false);
  const [thinkingDots, setThinkingDots] = useState(1);
  const [question, setQuestion] = useState("");
  const [globalSources, setGlobalSources] = useState<SourceItem[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [showMemoModal, setShowMemoModal] = useState(false);
  const [savedMemos, setSavedMemos] = useState<SavedMemo[]>([]);
  const [showPersonalSection, setShowPersonalSection] = useState(true);
  const [commentText, setCommentText] = useState("");
  const [comments, setComments] = useState<KnowledgeComment[]>([]);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const [updateMemoDraft, setUpdateMemoDraft] = useState("");
  const [updateMemoSubmitting, setUpdateMemoSubmitting] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingAssistantCountRef = useRef<number | null>(null);
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
          role: (data.role as "owner" | "admin" | "member") ?? "member",
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
    if (!authUser || !profile?.companyId) {
      setGlobalSources([]);
      return;
    }

    const docsQuery = query(
      documentsCol(profile.companyId),
      orderBy("createdAt", "desc"),
      limit(20),
    );
    const unsub = onSnapshot(docsQuery, (snapshot) => {
      const next = snapshot.docs.map((snap) => {
        const text = String(snap.data().text ?? "");
        return {
          id: snap.id,
          name: String(snap.data().name ?? "Untitled PDF"),
          text,
          summary: String(snap.data().summary ?? ""),
          updateMemo: String(snap.data().updateMemo ?? ""),
          storagePath: String(snap.data().storagePath ?? ""),
          inheritedFromDocumentId: String(snap.data().inheritedFromDocumentId ?? ""),
          createdAt: toDate(snap.data().createdAt),
        };
      });
      setGlobalSources(next);
    }, (snapshotError) => logError("documents-snapshot", snapshotError));

    return () => unsub();
  }, [authUser, profile?.companyId]);

  useEffect(() => {
    if (!authUser) {
      setSources([]);
      return;
    }

    setSources(globalSources);
  }, [authUser, globalSources]);

  useEffect(() => {
    if (!authUser) {
      setChatThreads([]);
      setSelectedChatId(null);
      return;
    }

    const chatsRef = collection(db, "users", authUser.uid, "chats");
    const chatsQuery = query(chatsRef, where("scopeType", "==", "personal"));

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
  }, [authUser]);

  const selectedSource = useMemo(
    () => (selectedKnowledge ? sources.find((source) => source.id === selectedKnowledge.id) ?? null : null),
    [selectedKnowledge, sources],
  );
  const chatTitle = "パーソナルチャット";

  useEffect(() => {
    if (!messagesContainerRef.current) return;
    messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
  }, [messages, uploading]);

  useEffect(() => {
    if (!sending) return;
    const expectedAssistantCount = pendingAssistantCountRef.current;
    if (expectedAssistantCount == null) return;
    const currentAssistantCount = messages.filter((message) => message.sender === "assistant").length;
    if (currentAssistantCount >= expectedAssistantCount) {
      pendingAssistantCountRef.current = null;
      setSending(false);
    }
  }, [messages, sending]);

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
    setUpdateMemoDraft(selectedSource?.updateMemo ?? "");
  }, [selectedSource]);

  useEffect(() => {
    if (!authUser || !profile?.companyId || !selectedSource) {
      setComments([]);
      return;
    }

    const commentsQuery = query(
      collection(db, "organizations", profile.companyId, "documents", selectedSource.id, "comments"),
      orderBy("createdAt", "desc"),
      limit(100),
    );
    const unsub = onSnapshot(
      commentsQuery,
      (snapshot) => {
        const next = snapshot.docs.map((commentDoc) => ({
          id: commentDoc.id,
          text: String(commentDoc.data().text ?? ""),
          authorName: String(commentDoc.data().authorName ?? "投稿者不明"),
          createdAt: toDate(commentDoc.data().createdAt),
        }));
        setComments(next);
      },
      (snapshotError) => logError("comments-snapshot", snapshotError),
    );
    return () => unsub();
  }, [authUser, profile?.companyId, selectedSource]);

  useEffect(() => {
    if (!authUser) {
      setSavedMemos([]);
      return;
    }
    const memosQuery = query(
      collection(db, "users", authUser.uid, "memos"),
      orderBy("createdAt", "desc"),
      limit(100),
    );
    const unsub = onSnapshot(
      memosQuery,
      (snapshot) => {
        const next = snapshot.docs.map((memoDoc) => ({
          id: memoDoc.id,
          text: String(memoDoc.data().text ?? ""),
          createdAt: toDate(memoDoc.data().createdAt),
        }));
        setSavedMemos(next);
      },
      (snapshotError) => logError("memos-snapshot", snapshotError),
    );
    return () => unsub();
  }, [authUser]);

  useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);

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

    setCreatingChat(true);
    try {
      const created = await addDoc(collection(db, "users", authUser.uid, "chats"), {
        scopeType: "personal",
        teamId: "",
        teamName: "",
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

  const ensureActiveChatId = async (): Promise<string | null> => {
    if (selectedChatId) return selectedChatId;
    return createNewChatThread();
  };

  const handleCreatePersonalChat = async () => {
    if (!authUser) return;
    setCreatingChat(true);
    try {
      const created = await addDoc(collection(db, "users", authUser.uid, "chats"), {
        scopeType: "personal",
        teamId: "",
        teamName: "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSelectedChatId(created.id);
    } catch (error) {
      logError("personal-chat-create", error);
    } finally {
      setCreatingChat(false);
    }
  };

  const handleKnowledgeUpload = async (
    files: File[],
    kind: "pdf" | "text",
  ) => {
    if (!authUser || !profile?.companyId || files.length === 0) return;
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
        const storagePath = `users/${authUser.uid}/documents/${Date.now()}-${file.name}`;
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
          storagePath,
          downloadURL,
          companyId: profile.companyId,
          uploadedByUid: authUser.uid,
          uploadedByName: profile.displayName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        await addDoc(documentsCol(profile.companyId), docPayload);

        await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
          sender: "assistant",
          text: buildPdfSummaryMessage(file.name, analysis.summary),
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
    if (!authUser || !profile?.companyId) return;
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
        storagePath: "",
        downloadURL: "",
        sourceType: "text",
        companyId: profile.companyId,
        uploadedByUid: authUser.uid,
        uploadedByName: profile.displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      await addDoc(documentsCol(profile.companyId), docPayload);

      await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
        sender: "assistant",
        text: buildPdfSummaryMessage(`${title}.txt`, analysis.summary),
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
    if (!authUser || !profile?.companyId) return;
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
        sourceType: "url",
        sourceUrl: url,
        storagePath: "",
        downloadURL: "",
        companyId: profile.companyId,
        uploadedByUid: authUser.uid,
        uploadedByName: profile.displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      await addDoc(documentsCol(profile.companyId), docPayload);

      await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
        sender: "assistant",
        text: buildPdfSummaryMessage(extracted.title || url, analysis.summary),
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
    pendingAssistantCountRef.current = messages.filter((message) => message.sender === "assistant").length + 1;
    setSending(true);
    try {
      await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
        sender: "user",
        text: userQuestion,
        createdAt: serverTimestamp(),
      });

      const targetSources = selectedSource ? [selectedSource] : sources;
      const usedUpdateMemo = hasAppliedUpdateMemo(targetSources);
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
      const referenceNames = pickRelevantSourceNames(userQuestion, targetSources);
      if (!assistantReply.includes("参照ナレッジ:")) {
        assistantReply = `${assistantReply}\n\n参照ナレッジ: ${
          referenceNames.length > 0 ? referenceNames.join(" / ") : "なし"
        }`;
      }
      if (usedUpdateMemo && !assistantReply.includes("変更メモを反映")) {
        assistantReply = `${assistantReply}\n変更メモを反映`;
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
      pendingAssistantCountRef.current = null;
      setSending(false);
      try {
        await addDoc(collection(db, "users", authUser.uid, "chats", activeId, "messages"), {
          sender: "assistant",
          text: "回答の生成に失敗しました。もう一度お試しください。",
          createdAt: serverTimestamp(),
        });
      } catch (fallbackError) {
        logError("chat-fallback", fallbackError);
      }
    }
  };

  const handleDeleteSource = async (source: SourceItem) => {
    if (!authUser || !profile?.companyId) return;
    const shouldDelete = window.confirm(`「${source.name}」を削除しますか？`);
    if (!shouldDelete) return;

    setDeletingSourceId(source.id);
    try {
      if (source.storagePath) {
        try {
          await deleteObject(ref(storage, source.storagePath));
        } catch (storageError) {
          if (!isStorageObjectNotFound(storageError)) {
            logError("delete-source-storage", storageError);
          }
        }
      }
      const commentsSnap = await getDocs(
        collection(db, "organizations", profile.companyId, "documents", source.id, "comments"),
      );
      await Promise.all(commentsSnap.docs.map((commentDoc) => deleteDoc(commentDoc.ref)));
      await deleteDoc(documentDoc(profile.companyId, source.id));
      if (selectedKnowledge?.id === source.id) {
        setSelectedKnowledge(null);
        setCommentText("");
      }
    } catch (deleteError) {
      logError("delete-source", deleteError);
    } finally {
      setDeletingSourceId(null);
    }
  };

  const deleteChatThreadInternal = async (thread: ChatThread) => {
    if (!authUser) return;
    try {
      const chatRef = doc(db, "users", authUser.uid, "chats", thread.id);
      const messagesSnap = await getDocs(collection(db, "users", authUser.uid, "chats", thread.id, "messages"));
      await Promise.all(messagesSnap.docs.map((messageDoc) => deleteDoc(messageDoc.ref)));

      const documentsSnap = await getDocs(collection(db, "users", authUser.uid, "chats", thread.id, "documents"));
      for (const documentDoc of documentsSnap.docs) {
        const data = documentDoc.data();
        const storagePath = String(data.storagePath ?? "");
        const inheritedFromDocumentId = String(data.inheritedFromDocumentId ?? "");
        if (storagePath && !inheritedFromDocumentId) {
          try {
            await deleteObject(ref(storage, storagePath));
          } catch (storageError) {
            if (!isStorageObjectNotFound(storageError)) {
              logError("delete-chat-thread-storage", storageError);
            }
          }
        }
        await deleteDoc(documentDoc.ref);
      }

      await deleteDoc(chatRef);
      if (selectedChatId === thread.id) {
        setSelectedChatId(null);
      }
      setActionNotice("チャット履歴を削除しました。");
    } catch (error) {
      logError("delete-chat-thread", error);
    }
  };

  const handleDeleteChatThread = async (thread: ChatThread) => {
    if (!authUser) return;
    const shouldDelete = window.confirm(`「${formatChatThreadLabel(thread)}」を削除しますか？`);
    if (!shouldDelete) return;

    setDeletingChatId(thread.id);
    try {
      await deleteChatThreadInternal(thread);
    } finally {
      setDeletingChatId(null);
    }
  };

  const handleCopyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(formatAssistantMessage(text));
      setActionNotice("回答をコピーしました。");
    } catch (error) {
      logError("copy-message", error);
    }
  };

  const handleSaveMemo = async (text: string) => {
    if (!authUser) return;
    try {
      const formatted = formatAssistantMessage(text);
      const memosCol = collection(db, "users", authUser.uid, "memos");
      await addDoc(memosCol, {
        text: formatted,
        createdAt: serverTimestamp(),
      });

      const overflowQuery = query(memosCol, orderBy("createdAt", "desc"), limit(200));
      const overflowSnap = await getDocs(overflowQuery);
      const overflowDocs = overflowSnap.docs.slice(100);
      await Promise.all(overflowDocs.map((memoDoc) => deleteDoc(memoDoc.ref)));
      setActionNotice("メモに保存しました。");
    } catch (error) {
      logError("save-memo", error);
    }
  };

  const openMemoModal = () => {
    setShowMemoModal(true);
  };

  const handleDeleteMemo = async (memoId: string) => {
    if (!authUser) return;
    try {
      await deleteDoc(doc(db, "users", authUser.uid, "memos", memoId));
      setActionNotice("メモを削除しました。");
    } catch (error) {
      logError("delete-memo", error);
    }
  };

  const handleReuseMemo = (text: string) => {
    const normalized = text.trim();
    if (!normalized) return;
    setQuestion((prev) => (prev.trim() ? `${prev.trim()}\n\n${normalized}` : normalized));
    setActionNotice("メモを入力欄に追加しました。");
  };

  const handleClearMemos = async () => {
    if (!authUser) return;
    const shouldDelete = window.confirm("メモをすべて削除しますか？");
    if (!shouldDelete) return;
    try {
      const memosCol = collection(db, "users", authUser.uid, "memos");
      while (true) {
        const chunk = await getDocs(query(memosCol, limit(200)));
        if (chunk.empty) break;
        await Promise.all(chunk.docs.map((memoDoc) => deleteDoc(memoDoc.ref)));
      }
      setActionNotice("メモをすべて削除しました。");
    } catch (error) {
      logError("clear-memos", error);
    }
  };

  const handleSubmitComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authUser || !profile || !profile.companyId || !selectedSource || !commentText.trim()) return;

    setCommentSubmitting(true);
    try {
      await addDoc(collection(db, "organizations", profile.companyId, "documents", selectedSource.id, "comments"), {
        text: commentText.trim(),
        authorName: profile.displayName,
        authorUid: authUser.uid,
        createdAt: serverTimestamp(),
      });
      setCommentText("");
      setActionNotice("コメントを追加しました。");
    } catch (error) {
      logError("comment-submit", error);
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!authUser || !profile?.companyId || !selectedSource) return;
    setDeletingCommentId(commentId);
    try {
      await deleteDoc(doc(db, "organizations", profile.companyId, "documents", selectedSource.id, "comments", commentId));
      setActionNotice("コメントを削除しました。");
    } catch (error) {
      logError("comment-delete", error);
    } finally {
      setDeletingCommentId(null);
    }
  };

  const handleSaveUpdateMemo = async () => {
    if (!authUser || !profile?.companyId || !selectedSource) return;
    setUpdateMemoSubmitting(true);
    try {
      await updateDoc(documentDoc(profile.companyId, selectedSource.id), {
        updateMemo: updateMemoDraft.trim(),
        updatedAt: serverTimestamp(),
      });
      setActionNotice("変更メモを保存しました。");
    } catch (error) {
      logError("update-memo-save", error);
    } finally {
      setUpdateMemoSubmitting(false);
    }
  };

  const renderTextWithLinks = (line: string, keyPrefix: string): ReactNode[] => {
    const nodes: ReactNode[] = [];
    const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    const plainUrlRegex = /(https?:\/\/[^\s]+)/g;
    let lineCursor = 0;
    let markdownMatch: RegExpExecArray | null;
    let nodeIndex = 0;

    const pushTextWithPlainUrls = (segment: string, segmentKey: string) => {
      let textCursor = 0;
      let plainMatch: RegExpExecArray | null;
      plainUrlRegex.lastIndex = 0;
      while ((plainMatch = plainUrlRegex.exec(segment)) !== null) {
        const [url] = plainMatch;
        const start = plainMatch.index;
        if (start > textCursor) {
          nodes.push(segment.slice(textCursor, start));
        }
        nodes.push(
          <a
            key={`${segmentKey}-url-${nodeIndex += 1}`}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-[#6d89df] underline-offset-2 hover:text-[#163a95]"
          >
            {url}
          </a>,
        );
        textCursor = start + url.length;
      }
      if (textCursor < segment.length) {
        nodes.push(segment.slice(textCursor));
      }
    };

    markdownLinkRegex.lastIndex = 0;
    while ((markdownMatch = markdownLinkRegex.exec(line)) !== null) {
      const [fullMatch, label, href] = markdownMatch;
      const start = markdownMatch.index;
      if (start > lineCursor) {
        pushTextWithPlainUrls(line.slice(lineCursor, start), `${keyPrefix}-text-${nodeIndex += 1}`);
      }
      nodes.push(
        <a
          key={`${keyPrefix}-md-${nodeIndex += 1}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-[#6d89df] underline-offset-2 hover:text-[#163a95]"
        >
          {label}
        </a>,
      );
      lineCursor = start + fullMatch.length;
    }

    if (lineCursor < line.length) {
      pushTextWithPlainUrls(line.slice(lineCursor), `${keyPrefix}-tail-${nodeIndex += 1}`);
    }

    return nodes;
  };

  const renderAssistantContent = (rawText: string) => {
    const formatted = formatAssistantMessage(rawText);
    const lines = formatted.split("\n");

    return (
      <div className="space-y-1 leading-relaxed">
        {lines.map((line, index) => {
          if (!line.trim()) {
            return <div key={`line-${index}`} className="h-1" />;
          }

          if (line.startsWith("参照ナレッジ:")) {
            const refsRaw = line.replace("参照ナレッジ:", "").trim();
            if (!refsRaw || refsRaw === "なし") {
              return (
                <div key={`line-${index}`} className="text-sm text-[#465272]">
                  参照ナレッジ: なし
                </div>
              );
            }
            const names = refsRaw.split(/\s*\/\s*/).map((name) => name.trim()).filter(Boolean);
            return (
              <div key={`line-${index}`} className="flex flex-wrap items-center gap-1 text-sm text-[#465272]">
                <span>参照ナレッジ:</span>
                {names.map((name, nameIndex) => {
                  const normalizedName = normalizeKnowledgeName(name);
                  const matched = sources.find((source) => {
                    const sourceName = normalizeKnowledgeName(source.name);
                    return (
                      sourceName === normalizedName ||
                      sourceName.includes(normalizedName) ||
                      normalizedName.includes(sourceName)
                    );
                  });
                  if (matched) {
                    return (
                      <button
                        key={`ref-${name}-${nameIndex}`}
                        type="button"
                        onClick={() => {
                          setSelectedKnowledge({ id: matched.id, name: matched.name });
                        }}
                        className="border border-[#bdd0ff] bg-white px-2 py-0.5 text-xs font-medium text-[#1d46a6] hover:bg-[#eef4ff]"
                      >
                        {name}
                      </button>
                    );
                  }
                  return (
                    <span key={`ref-${name}-${nameIndex}`} className="text-xs text-[#55617f]">
                      {name}
                    </span>
                  );
                })}
              </div>
            );
          }

          return <div key={`line-${index}`}>{renderTextWithLinks(line, `line-${index}`)}</div>;
        })}
      </div>
    );
  };

  const handleLogout = async () => {
    await signOut(auth);
    router.replace("/login");
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#e9eaf4]">
        <p className="text-sm text-[#505565]">読み込み中...</p>
      </main>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-[linear-gradient(180deg,#f8fafc_0%,#eef3f9_100%)]">
      <div className="h-full p-4 text-[15px] md:p-6">
        <div className="grid h-full grid-cols-1 gap-3 xl:grid-cols-[360px_minmax(0,1fr)_300px]">
          <aside className="flex min-h-0 flex-col border border-[#d7e1ee] bg-[#fbfdff] text-[#1f2a37] shadow-[0_18px_40px_rgba(0,37,84,0.08)]">
            <div className="border-b border-[#e2eaf4] px-6 py-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-3">
                    <Image
                      src="/upmologo1.png"
                      alt="upmo logo"
                      width={34}
                      height={34}
                      className="h-[34px] w-[34px] object-contain"
                      priority
                    />
                    <h1 className="font-mono text-2xl font-semibold uppercase tracking-[0.22em] text-[#004aad]">upmo</h1>
                  </div>
                  <p className="mt-2 text-[10px] tracking-[0.16em] text-[#7a8ba3]">
                    {profile?.companyName ?? "会社名"} / {profile?.displayName ?? "ユーザー"}
                  </p>
                </div>
                <button
                  onClick={handleLogout}
                  className="border border-[#d3ddea] bg-white px-3 py-2 text-[10px] font-semibold tracking-[0.14em] text-[#516274] hover:bg-[#f6f9fc]"
                >
                  ログアウト
                </button>
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto p-4">
              <div>
                <div className="mb-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">ナレッジ一覧</p>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowKnowledgeMenu((prev) => !prev)}
                        className="flex h-8 items-center justify-center border border-[#bfd2ec] bg-[#f7fbff] px-3 text-[11px] font-semibold tracking-[0.08em] text-[#004aad] hover:bg-[#eef5ff]"
                      >
                        ＋ナレッジを追加
                      </button>
                      {showKnowledgeMenu ? (
                        <div className="absolute right-0 top-9 z-30 w-40 border border-[#d7e1ee] bg-white p-1 shadow-[0_16px_30px_rgba(0,37,84,0.12)]">
                          <button
                            onClick={() => {
                              setShowKnowledgeMenu(false);
                              pdfInputRef.current?.click();
                            }}
                            className="block w-full px-2 py-1.5 text-left text-xs text-[#314154] hover:bg-[#f3f8ff]"
                          >
                            PDFを追加
                          </button>
                          <button
                            onClick={() => {
                              setShowKnowledgeMenu(false);
                              setShowTextModal(true);
                            }}
                            className="block w-full px-2 py-1.5 text-left text-xs text-[#314154] hover:bg-[#f3f8ff]"
                          >
                            テキストを追加
                          </button>
                          <button
                            onClick={() => {
                              setShowKnowledgeMenu(false);
                              setShowUrlModal(true);
                            }}
                            className="block w-full px-2 py-1.5 text-left text-xs text-[#314154] hover:bg-[#f3f8ff]"
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
                  </div>
                  <ul className="max-h-48 space-y-2 overflow-auto border border-[#e2eaf4] bg-[#f8fbff] p-2">
                    {sources.map((source) => (
                      <li
                        key={source.id}
                        className={`border bg-white p-2 ${
                          selectedKnowledge?.id === source.id
                            ? "border-[#004aad] bg-[#eef5ff]"
                            : "border-[#e1e9f3] bg-white"
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
                            className={`min-w-0 flex-1 px-1 py-1 text-left text-sm ${
                              selectedKnowledge?.id === source.id
                                ? "text-[#004aad]"
                                : "text-[#2f3f53] hover:bg-[#f5f8fc]"
                            }`}
                          >
                            <span className="flex items-center gap-2">
                              <span className="truncate">{source.name}</span>
                              {source.updateMemo?.trim() ? (
                                <span className="shrink-0 border border-[#bfd2ec] bg-[#eef5ff] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.08em] text-[#004aad]">
                                  変更メモあり
                                </span>
                              ) : null}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteSource(source);
                            }}
                            disabled={deletingSourceId === source.id}
                            className="border border-[#d3ddea] px-2 py-1 text-[11px] text-[#6b7d92] disabled:opacity-50"
                          >
                            {deletingSourceId === source.id ? "削除中" : "削除"}
                          </button>
                        </div>
                      </li>
                    ))}
                    {sources.length === 0 ? (
                      <li className="border border-dashed border-[#d7e1ee] p-2 text-xs text-[#7a8ba3]">
                        まだナレッジがありません
                      </li>
                    ) : null}
                  </ul>
                </div>

                <div className="mb-4 border-t border-[#e6edf5]" />

                <button
                  type="button"
                  onClick={() => setShowPersonalSection((prev) => !prev)}
                  className="mb-2 flex w-full items-center justify-between px-1 py-2 text-left"
                >
                  <span className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">チャット履歴</span>
                  <span className="text-sm text-[#7a8ba3]">{showPersonalSection ? "−" : "+"}</span>
                </button>
                {showPersonalSection ? (
                  <>
                    <div className="max-h-48 space-y-1 overflow-auto border border-[#e2eaf4] bg-[#f8fbff] p-2">
                      {chatThreads.map((thread) => (
                        <div key={thread.id} className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedChatId(thread.id)}
                            className={`min-w-0 flex-1 px-2 py-1 text-left text-xs ${
                              selectedChatId === thread.id
                                ? "bg-[#eaf3ff] font-medium text-[#004aad]"
                                : "text-[#5c6d81] hover:bg-[#edf4fb]"
                            }`}
                          >
                            {formatChatThreadLabel(thread)}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteChatThread(thread)}
                            disabled={deletingChatId === thread.id}
                            className="shrink-0 border border-[#d3ddea] px-2 py-1 text-[11px] text-[#6b7d92] disabled:opacity-50"
                          >
                            {deletingChatId === thread.id ? "削除中" : "削除"}
                          </button>
                        </div>
                      ))}
                      {chatThreads.length === 0 ? (
                        <p className="px-2 py-1 text-xs text-[#7a8ba3]">履歴はまだありません</p>
                      ) : null}
                    </div>
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleCreatePersonalChat()}
                  disabled={creatingChat}
                  className="mt-3 w-full border border-[#004aad] bg-[#004aad] px-2 py-2 text-xs font-semibold tracking-[0.08em] text-white hover:bg-[#0b5bc8] disabled:opacity-60"
                >
                  {creatingChat ? "作成中..." : "+NEWチャット"}
                </button>
              </div>
            </div>
          </aside>

          <section className="min-h-0 border border-[#d7e1ee] bg-[linear-gradient(180deg,#ffffff_0%,#f8fbff_100%)] shadow-[0_18px_40px_rgba(0,37,84,0.08)]">
            <div className="border-b border-[#e2eaf4] px-6 py-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">WORKSPACE</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight text-[#243142]">{chatTitle}</h2>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={openMemoModal}
                    className="border border-[#bfd2ec] bg-[#f7fbff] px-3 py-2 text-xs font-semibold tracking-[0.08em] text-[#004aad] hover:bg-[#eef5ff] xl:hidden"
                  >
                    メモ一覧
                  </button>
                </div>
              </div>
            </div>

            <div className="flex h-[calc(100%-72px)] min-h-0 flex-col">
              <div ref={messagesContainerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
                {actionNotice ? (
                  <div className="border border-[#d7e4f3] bg-[#f3f8fd] px-3 py-2 text-sm text-[#486179]">
                    {actionNotice}
                  </div>
                ) : null}
                {messages.length === 0 && sources.length === 0 ? (
                  <div className="mx-auto mt-20 max-w-2xl text-center">
                    <h3 className="text-3xl font-semibold text-[#333640]">
                      ナレッジを追加して始める
                    </h3>
                    <p className="mt-3 text-sm text-[#697082]">
                      まずは PDF やテキストを追加してください。
                    </p>
                  </div>
                ) : null}

                {messages.map((message) => (
                  message.sender === "user" ? (
                    <div
                      key={message.id}
                      className="relative ml-auto w-fit max-w-3xl border border-[#004aad] bg-[#004aad] px-4 py-3 text-base text-white shadow-[4px_4px_0_0_#d7e3f5]"
                    >
                      <p>{message.text}</p>
                    </div>
                  ) : (
                    <div key={message.id} className="mr-auto flex max-w-3xl items-start gap-2">
                      <div className="mt-0.5 inline-flex h-8 w-8 shrink-0 aspect-square items-center justify-center border border-[#bfd2ec] bg-white p-1">
                        <Image
                          src="/upmologo2.png"
                          alt="upmo assistant"
                          width={24}
                          height={24}
                          className="h-6 w-6 object-contain"
                        />
                      </div>
                      <div className="w-fit max-w-3xl border border-[#dde7f2] bg-white px-4 py-3 text-base text-[#2c3948] shadow-[4px_4px_0_0_#edf3fa]">
                        {renderAssistantContent(message.text)}
                        <div className="mt-3 flex items-center gap-2 border-t border-[#edf3fa] pt-2">
                          <button
                            type="button"
                            onClick={() => void handleCopyMessage(message.text)}
                            className="border border-[#d7e1ee] bg-white px-2 py-1 text-xs font-semibold text-[#486179] hover:bg-[#f5f8fc]"
                          >
                            コピー
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSaveMemo(message.text)}
                            className="border border-[#d7e1ee] bg-white px-2 py-1 text-xs font-semibold text-[#486179] hover:bg-[#f5f8fc]"
                          >
                            メモ保存
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                ))}

                {sending ? (
                  <div className="mr-auto flex max-w-3xl items-start gap-2">
                    <div className="mt-0.5 inline-flex h-8 w-8 shrink-0 aspect-square items-center justify-center border border-[#bfd2ec] bg-white p-1">
                      <Image
                        src="/upmologo2.png"
                        alt="upmo assistant"
                        width={24}
                        height={24}
                        className="h-6 w-6 object-contain"
                      />
                    </div>
                    <div className="w-full max-w-md border border-[#d7e4f3] bg-[linear-gradient(180deg,#ffffff_0%,#f5f9ff_100%)] px-4 py-3 text-base text-[#2c3948] shadow-[4px_4px_0_0_#edf3fa]">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">UPMO</p>
                          <p className="mt-1 font-medium text-[#004aad]">
                            回答を組み立てています{".".repeat(thinkingDots)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="h-2 w-2 animate-bounce bg-[#004aad]" />
                          <span className="h-2 w-2 animate-bounce bg-[#69a2e8] [animation-delay:120ms]" />
                          <span className="h-2 w-2 animate-bounce bg-[#b8d3f5] [animation-delay:240ms]" />
                        </div>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden bg-[#e7eef6]">
                        <div className="h-full w-1/3 animate-pulse bg-[#004aad]" />
                      </div>
                    </div>
                  </div>
                ) : null}

                {uploading && uploadStatus ? (
                  <div className="mr-auto w-fit max-w-3xl border border-[#dde7f2] bg-white px-4 py-3 text-sm text-[#2c3948] shadow-[4px_4px_0_0_#edf3fa]">
                    <p className="mb-2">
                      {uploadStatus.fileName} をアップロード中... {uploadStatus.progress}%
                    </p>
                    <div className="h-2 w-full bg-[#e7eef6]">
                      <div
                        className="h-2 bg-[#004aad] transition-all"
                        style={{ width: `${uploadStatus.progress}%` }}
                      />
                    </div>
                  </div>
                ) : null}

              </div>

              <form onSubmit={handleAsk} className="border-t border-[#e2eaf4] bg-[#fbfdff] px-6 py-5">
                <div className="flex items-center gap-3">
                  <input
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="PDF内容について質問してください"
                    className="h-12 flex-1 border border-[#d6e1ee] bg-white px-4 text-base outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
                  />
                  <button
                    disabled={sending}
                    className="h-12 border border-[#004aad] bg-[#004aad] px-5 text-base font-semibold tracking-[0.08em] text-white disabled:opacity-60 hover:bg-[#0b5bc8]"
                  >
                    {sending ? "送信中..." : "送信"}
                  </button>
                </div>
              </form>
            </div>
          </section>

          <aside className="hidden min-h-0 xl:flex xl:flex-col border border-[#d7e1ee] bg-[linear-gradient(180deg,#fdfefe_0%,#f5f9ff_100%)] shadow-[0_18px_40px_rgba(0,37,84,0.08)]">
            <div className="border-b border-[#e2eaf4] bg-white/80 px-5 py-4 backdrop-blur-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">NOTES</p>
                  <h3 className="mt-1 text-base font-semibold text-[#243142]">資料メモ</h3>
                </div>
                {selectedSource ? (
                  <span className="shrink-0 border border-[#bfd2ec] bg-white px-2 py-1 text-[10px] font-semibold tracking-[0.08em] text-[#004aad]">
                    選択中
                  </span>
                ) : null}
              </div>
              {selectedSource ? (
                <div className="mt-3 border border-[#dbe6f4] bg-[#f8fbff] px-3 py-2.5">
                  <p className="truncate text-sm font-semibold text-[#243142]">{selectedSource.name}</p>
                  <p className="mt-1 text-xs text-[#6f8097]">
                    {selectedSource.updateMemo?.trim() ? "変更メモあり" : "変更メモなし"}
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-xs leading-relaxed text-[#7a8ba3]">
                  資料を選択してください。
                </p>
              )}
            </div>
            <div className="min-h-0 overflow-y-auto p-4">
              <div className="space-y-4">
                <section className="border border-[#dbe6f4] bg-white shadow-[4px_4px_0_0_#edf3fa]">
                  <div className="border-b border-[#eaf1f8] px-4 py-3">
                    <p className="text-[11px] font-semibold tracking-[0.14em] text-[#004aad]">UPDATE NOTE</p>
                    <h4 className="mt-1 text-base font-semibold text-[#243142]">回答に反映するメモ</h4>
                    <p className="mt-1 text-xs leading-relaxed text-[#7a8ba3]">
                      ここに書いた内容は、本文より優先して回答に反映されます。
                    </p>
                  </div>
                  {selectedSource ? (
                    <div className="space-y-3 p-4">
                      <textarea
                        value={updateMemoDraft}
                        onChange={(event) => setUpdateMemoDraft(event.target.value)}
                        placeholder="例: 料金は旧資料から変更済みです。最新版は5ID 3,500円 / 1IDです。"
                        className="h-28 w-full border border-[#d6e1ee] bg-[#fbfdff] px-3 py-2 text-sm outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
                      />
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[11px] text-[#7a8ba3]">
                          {updateMemoDraft.trim() ? "保存すると次回回答から反映されます" : "空欄で保存すると変更メモを解除します"}
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleSaveUpdateMemo()}
                          disabled={updateMemoSubmitting}
                          className="border border-[#004aad] bg-[#004aad] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                        >
                          {updateMemoSubmitting ? "保存中..." : "変更メモを保存"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 text-sm leading-relaxed text-[#7a8ba3]">
                      資料を選択してください。
                    </div>
                  )}
                </section>

                <section className="border border-[#dbe6f4] bg-white shadow-[4px_4px_0_0_#edf3fa]">
                  <div className="border-b border-[#eaf1f8] px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold tracking-[0.14em] text-[#004aad]">COMMENTS</p>
                        <h4 className="mt-1 text-base font-semibold text-[#243142]">共有コメント</h4>
                        <p className="mt-1 text-xs leading-relaxed text-[#7a8ba3]">
                          回答には直接使われない、共有用のメモです。
                        </p>
                      </div>
                      <span className="border border-[#dbe6f4] bg-[#f8fbff] px-2 py-1 text-[10px] font-semibold tracking-[0.08em] text-[#6f8097]">
                        {comments.length}件
                      </span>
                    </div>
                  </div>
                  {selectedSource ? (
                    <div className="space-y-4 p-4">
                      <form className="space-y-2 border border-[#e8eef6] bg-[#f8fbff] p-3" onSubmit={handleSubmitComment}>
                        <textarea
                          value={commentText}
                          onChange={(event) => setCommentText(event.target.value)}
                          placeholder="補足、連絡、更新メモなどを残せます"
                          className="h-20 w-full border border-[#d6e1ee] bg-white px-3 py-2 text-sm outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
                        />
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[11px] text-[#7a8ba3]">この欄は伝言用です。回答には直接反映しません。</p>
                          <button
                            type="submit"
                            disabled={commentSubmitting || !commentText.trim()}
                            className="border border-[#004aad] bg-white px-3 py-2 text-xs font-semibold text-[#004aad] disabled:opacity-60"
                          >
                            {commentSubmitting ? "投稿中..." : "コメントを追加"}
                          </button>
                        </div>
                      </form>
                      <div className="space-y-3">
                        {comments.map((comment) => (
                          <article key={comment.id} className="border-l-2 border-[#004aad] bg-[#f8fbff] px-3 py-3">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-xs font-semibold text-[#314154]">{comment.authorName}</p>
                                <p className="text-[11px] text-[#7a8ba3]">
                                  {comment.createdAt ? comment.createdAt.toLocaleString("ja-JP") : "投稿時刻不明"}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => void handleDeleteComment(comment.id)}
                                disabled={deletingCommentId === comment.id}
                                className="border border-[#efc8cf] bg-white px-2 py-1 text-[11px] font-semibold text-[#b64559] disabled:opacity-50"
                              >
                                {deletingCommentId === comment.id ? "削除中" : "削除"}
                              </button>
                            </div>
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#314154]">
                              {comment.text}
                            </p>
                          </article>
                        ))}
                        {comments.length === 0 ? (
                          <div className="border border-dashed border-[#d7e1ee] bg-[#fbfdff] p-4 text-sm leading-relaxed text-[#7a8ba3]">
                            まだコメントはありません。
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 text-sm leading-relaxed text-[#7a8ba3]">
                      資料を選択してください。
                    </div>
                  )}
                </section>

                <section className="border border-[#dbe6f4] bg-white shadow-[4px_4px_0_0_#edf3fa]">
                  <div className="border-b border-[#eaf1f8] px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold tracking-[0.14em] text-[#004aad]">MEMOS</p>
                        <h4 className="mt-1 text-base font-semibold text-[#243142]">保存メモ</h4>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleClearMemos()}
                        disabled={savedMemos.length === 0}
                        className="border border-[#efc8cf] bg-[#fff7f8] px-2 py-1 text-[11px] font-semibold text-[#b64559] disabled:opacity-50"
                      >
                        全削除
                      </button>
                    </div>
                  </div>
                  <div className="space-y-3 p-4">
                    {savedMemos.map((memo) => (
                      <article key={memo.id} className="border border-[#e8eef6] bg-[#fbfdff] p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-[11px] leading-relaxed text-[#7a8ba3]">
                            {memo.createdAt ? memo.createdAt.toLocaleString("ja-JP") : "保存時刻不明"}
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleDeleteMemo(memo.id)}
                            className="border border-[#efc8cf] bg-white px-2 py-1 text-[11px] font-semibold text-[#b64559]"
                          >
                            削除
                          </button>
                        </div>
                        <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-sm leading-relaxed text-[#314154]">
                          {memo.text}
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleCopyMessage(memo.text)}
                            className="border border-[#bfd2ec] bg-white px-2 py-1 text-[11px] font-semibold text-[#004aad] hover:bg-[#eef5ff]"
                          >
                            コピー
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReuseMemo(memo.text)}
                            className="border border-[#bfd2ec] bg-[#eef5ff] px-2 py-1 text-[11px] font-semibold text-[#004aad] hover:bg-[#dfecff]"
                          >
                            再利用
                          </button>
                        </div>
                      </article>
                    ))}
                    {savedMemos.length === 0 ? (
                      <div className="border border-dashed border-[#d7e1ee] bg-[#fbfdff] p-4 text-sm leading-relaxed text-[#7a8ba3]">
                        保存したメモがここに表示されます。
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            </div>
          </aside>

        </div>
      </div>

      {showTextModal ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#eef3f9]/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl border border-[#d7e1ee] bg-white p-6 shadow-[0_18px_40px_rgba(0,37,84,0.12)]">
            <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">KNOWLEDGE</p>
            <h3 className="mt-1 text-lg font-semibold text-[#243142]">テキストを追加</h3>
            <form className="mt-4 space-y-3" onSubmit={handleTextModalSubmit}>
              <input
                value={textTitle}
                onChange={(event) => setTextTitle(event.target.value)}
                placeholder="タイトル（任意）"
                className="h-11 w-full border border-[#d6e1ee] bg-white px-3 text-sm outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
              />
              <textarea
                value={textBody}
                onChange={(event) => setTextBody(event.target.value)}
                placeholder="ここにテキストを貼り付け"
                className="h-48 w-full border border-[#d6e1ee] bg-white px-3 py-2 text-sm outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
                required
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowTextModal(false)}
                  className="border border-[#d7e1ee] bg-white px-3 py-2 text-xs font-semibold text-[#5b6d83]"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="border border-[#004aad] bg-[#004aad] px-3 py-2 text-xs font-semibold text-white"
                >
                  追加
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showUrlModal ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#eef3f9]/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl border border-[#d7e1ee] bg-white p-6 shadow-[0_18px_40px_rgba(0,37,84,0.12)]">
            <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">KNOWLEDGE</p>
            <h3 className="mt-1 text-lg font-semibold text-[#243142]">URLを追加</h3>
            <form className="mt-4 space-y-3" onSubmit={handleUrlModalSubmit}>
              <input
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                placeholder="https://example.com/article"
                className="h-11 w-full border border-[#d6e1ee] bg-white px-3 text-sm outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
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
                  className="border border-[#d7e1ee] bg-white px-3 py-2 text-xs font-semibold text-[#5b6d83]"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={urlSubmitting}
                  className="border border-[#004aad] bg-[#004aad] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {urlSubmitting ? "追加中..." : "追加"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showMemoModal ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#eef3f9]/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-3xl border border-[#d7e1ee] bg-white p-6 shadow-[0_18px_40px_rgba(0,37,84,0.12)]">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">MEMOS</p>
                <h3 className="mt-1 text-lg font-semibold text-[#243142]">保存メモ一覧</h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleClearMemos()}
                  disabled={savedMemos.length === 0}
                  className="border border-[#efc8cf] bg-[#fff7f8] px-3 py-2 text-xs font-semibold text-[#b64559] disabled:opacity-50"
                >
                  全削除
                </button>
                <button
                  type="button"
                  onClick={() => setShowMemoModal(false)}
                  className="border border-[#d7e1ee] bg-white px-3 py-2 text-xs font-semibold text-[#5b6d83]"
                >
                  閉じる
                </button>
              </div>
            </div>
            <div className="mt-4 max-h-[60vh] space-y-3 overflow-auto">
              {savedMemos.map((memo) => (
                <article key={memo.id} className="border border-[#e2eaf4] bg-[#f8fbff] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-[#7a8ba3]">
                      {memo.createdAt ? memo.createdAt.toLocaleString("ja-JP") : "保存時刻不明"}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleCopyMessage(memo.text)}
                        className="border border-[#bfd2ec] bg-white px-2 py-1 text-xs font-semibold text-[#004aad] hover:bg-[#eef5ff]"
                      >
                        コピー
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReuseMemo(memo.text)}
                        className="border border-[#bfd2ec] bg-white px-2 py-1 text-xs font-semibold text-[#004aad] hover:bg-[#eef5ff]"
                      >
                        再利用
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteMemo(memo.id)}
                        className="border border-[#efc8cf] bg-[#fff7f8] px-2 py-1 text-xs font-semibold text-[#b64559] hover:bg-[#fff0f2]"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#314154]">
                    {memo.text}
                  </p>
                </article>
              ))}
              {savedMemos.length === 0 ? (
                <div className="border border-dashed border-[#d7e1ee] p-4 text-sm text-[#7a8ba3]">
                  保存メモはまだありません
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
