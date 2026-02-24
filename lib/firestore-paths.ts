import { collection, doc } from "firebase/firestore";

import { db } from "@/lib/firebase-firestore";

export type ThreadVisibility = "team" | "private";
export type MemberRole = "owner" | "admin" | "member";

export const organizationsCol = () => collection(db, "organizations");
export const organizationDoc = (orgId: string) => doc(db, "organizations", orgId);

export const membersCol = (orgId: string) =>
  collection(db, "organizations", orgId, "members");
export const memberDoc = (orgId: string, uid: string) =>
  doc(db, "organizations", orgId, "members", uid);

export const threadsCol = (orgId: string) =>
  collection(db, "organizations", orgId, "threads");
export const threadDoc = (orgId: string, threadId: string) =>
  doc(db, "organizations", orgId, "threads", threadId);

export const messagesCol = (orgId: string, threadId: string) =>
  collection(db, "organizations", orgId, "threads", threadId, "messages");
export const messageDoc = (orgId: string, threadId: string, messageId: string) =>
  doc(db, "organizations", orgId, "threads", threadId, "messages", messageId);

export const documentsCol = (orgId: string) =>
  collection(db, "organizations", orgId, "documents");
export const documentDoc = (orgId: string, documentId: string) =>
  doc(db, "organizations", orgId, "documents", documentId);

export const chunksCol = (orgId: string) =>
  collection(db, "organizations", orgId, "chunks");
export const chunkDoc = (orgId: string, chunkId: string) =>
  doc(db, "organizations", orgId, "chunks", chunkId);
