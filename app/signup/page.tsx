"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  increment,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { auth } from "@/lib/firebase-auth";
import { db } from "@/lib/firebase-firestore";

const DEFAULT_SEAT_LIMIT = 10;

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const credentials = await createUserWithEmailAndPassword(auth, email, password);
      const uid = credentials.user.uid;
      const displayName = name.trim();
      const normalizedCompanyName = companyName.trim();

      if (displayName) {
        await updateProfile(credentials.user, { displayName });
      }

      const companiesRef = collection(db, "companies");
      const existingCompanySnapshot = await getDocs(
        query(companiesRef, where("name", "==", normalizedCompanyName), limit(1)),
      );

      let activeCompanyId = "";
      let role: "owner" | "member" = "member";

      if (existingCompanySnapshot.empty) {
        const companyRef = await addDoc(companiesRef, {
          name: normalizedCompanyName,
          seatLimit: DEFAULT_SEAT_LIMIT,
          seatsUsed: 1,
          ownerUid: uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        activeCompanyId = companyRef.id;
        role = "owner";
      } else {
        const existingCompany = existingCompanySnapshot.docs[0];
        const data = existingCompany.data();
        const seatLimit = Number(data.seatLimit ?? DEFAULT_SEAT_LIMIT);
        const seatsUsed = Number(data.seatsUsed ?? 0);

        if (seatsUsed >= seatLimit) {
          throw new Error("この会社の利用可能ID数（10）に達しています。管理者に連絡してください。");
        }

        activeCompanyId = existingCompany.id;
        await updateDoc(doc(db, "companies", activeCompanyId), {
          seatsUsed: increment(1),
          updatedAt: serverTimestamp(),
        });
      }

      await setDoc(doc(db, "users", uid), {
        uid,
        email,
        displayName: displayName || email,
        companyId: activeCompanyId,
        companyName: normalizedCompanyName,
        role,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      router.push("/home");
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : "新規登録に失敗しました。";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#eef0f8] p-6">
      <section className="w-full max-w-md rounded-md border border-[#d7d8e2] bg-[#f8f8fb] p-8">
        <h1 className="text-2xl font-semibold text-[#2f3240]">新規登録</h1>
        <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
          <label className="grid gap-2 text-sm text-[#474b59]">
            名前
            <input
              required
              type="text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-11 rounded-sm border border-[#cfd1de] bg-white px-3 outline-none focus:border-[#6b739a]"
            />
          </label>
          <label className="grid gap-2 text-sm text-[#474b59]">
            会社名
            <input
              required
              type="text"
              autoComplete="organization"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              className="h-11 rounded-sm border border-[#cfd1de] bg-white px-3 outline-none focus:border-[#6b739a]"
            />
          </label>
          <label className="grid gap-2 text-sm text-[#474b59]">
            メールアドレス
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-11 rounded-sm border border-[#cfd1de] bg-white px-3 outline-none focus:border-[#6b739a]"
            />
          </label>
          <label className="grid gap-2 text-sm text-[#474b59]">
            パスワード（6文字以上）
            <input
              required
              minLength={6}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-11 rounded-sm border border-[#cfd1de] bg-white px-3 outline-none focus:border-[#6b739a]"
            />
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button
            type="submit"
            disabled={loading}
            className="mt-2 h-11 rounded-sm bg-[#2f3345] text-sm font-medium text-white disabled:opacity-60"
          >
            {loading ? "作成中..." : "アカウント作成"}
          </button>
        </form>
        <p className="mt-4 text-sm text-[#636776]">
          すでにアカウントがある場合は{" "}
          <Link href="/login" className="text-[#2f3345] underline">
            ログイン
          </Link>
        </p>
      </section>
    </main>
  );
}
