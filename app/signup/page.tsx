"use client";

import Image from "next/image";
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
  const [showPassword, setShowPassword] = useState(false);
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
    <main className="min-h-screen bg-white p-6 md:p-10">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] w-full max-w-6xl grid-cols-1 overflow-hidden border border-[#d7e1ee] bg-white shadow-[0_24px_60px_rgba(0,37,84,0.10)] lg:grid-cols-[1.05fr_0.95fr]">
        <section className="flex flex-col justify-between border-b border-[#e2eaf4] bg-white p-8 lg:border-b-0 lg:border-r lg:p-12">
          <div>
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center border border-[#bfd2ec] bg-white shadow-[4px_4px_0_0_#e8f0fb]">
                <Image
                  src="/upmologo1.png"
                  alt="upmo logo"
                  width={38}
                  height={38}
                  className="h-10 w-10 object-contain"
                  priority
                />
              </div>
              <div>
                <p className="text-[11px] font-semibold tracking-[0.22em] text-[#7a8ba3]">KNOWLEDGE WORKSPACE</p>
                <h1 className="mt-1 font-mono text-3xl font-semibold uppercase tracking-[0.22em] text-[#004aad]">
                  upmo
                </h1>
              </div>
            </div>

            <div className="mt-12 max-w-xl">
              <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">SIGN UP</p>
              <h2 className="mt-3 text-4xl font-semibold leading-tight text-[#243142]">
                社内専用の AI 基盤を、
                <br />
                すぐに使い始める
              </h2>
              <p className="mt-5 max-w-lg text-sm leading-7 text-[#607286]">
                会社名とアカウント情報を登録すると、社内ナレッジを一元化するワークスペースを作成できます
              </p>
            </div>
          </div>

          <div className="mt-10 border-t border-[#edf3fa] pt-6">
            <p className="max-w-md text-sm leading-7 text-[#607286]">
              会社ごとの情報を分散させず、アップロードした資料をそのまま業務で使える状態に整えます
            </p>
          </div>
        </section>

        <section className="flex items-center justify-center bg-white p-8 lg:p-12">
          <div className="w-full max-w-md">
            <div className="border border-[#dbe6f4] bg-white p-8 shadow-[6px_6px_0_0_#edf3fa]">
              <p className="text-[11px] font-semibold tracking-[0.18em] text-[#7a8ba3]">CREATE ACCOUNT</p>
              <h3 className="mt-2 text-2xl font-semibold text-[#243142]">新規登録</h3>
              <p className="mt-2 text-sm leading-relaxed text-[#6f8097]">
                名前、会社名、メールアドレス、パスワードを入力してください
              </p>

              <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
                <label className="grid gap-2 text-sm font-medium text-[#435468]">
                  名前
                  <input
                    required
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="h-12 border border-[#d6e1ee] bg-[#fbfdff] px-3 text-sm outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
                    placeholder="山田 太郎"
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium text-[#435468]">
                  会社名
                  <input
                    required
                    type="text"
                    autoComplete="organization"
                    value={companyName}
                    onChange={(event) => setCompanyName(event.target.value)}
                    className="h-12 border border-[#d6e1ee] bg-[#fbfdff] px-3 text-sm outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
                    placeholder="株式会社サンプル"
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium text-[#435468]">
                  メールアドレス
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="h-12 border border-[#d6e1ee] bg-[#fbfdff] px-3 text-sm outline-none placeholder:text-[#93a3b8] focus:border-[#004aad]"
                    placeholder="name@company.com"
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium text-[#435468]">
                  パスワード（6文字以上）
                  <div className="flex h-12 items-center border border-[#d6e1ee] bg-[#fbfdff] focus-within:border-[#004aad]">
                    <input
                      required
                      minLength={6}
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className="h-full flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-[#93a3b8]"
                      placeholder="パスワードを入力"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="h-full border-l border-[#e2eaf4] px-3 text-xs font-semibold text-[#004aad]"
                    >
                      {showPassword ? "非表示" : "表示"}
                    </button>
                  </div>
                </label>
                {error ? (
                  <div className="border border-[#efc8cf] bg-[#fff7f8] px-3 py-2 text-sm text-[#b64559]">
                    {error}
                  </div>
                ) : null}
                <button
                  type="submit"
                  disabled={loading}
                  className="mt-2 h-12 border border-[#004aad] bg-[#004aad] text-sm font-semibold tracking-[0.08em] text-white disabled:opacity-60 hover:bg-[#0b5bc8]"
                >
                  {loading ? "作成中..." : "アカウント作成"}
                </button>
              </form>

              <div className="mt-6 border-t border-[#edf3fa] pt-4 text-sm text-[#636776]">
                すでにアカウントがある場合は{" "}
                <Link href="/login" className="font-semibold text-[#004aad] underline underline-offset-2">
                  ログイン
                </Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
