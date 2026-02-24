"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";

import { auth } from "@/lib/firebase-auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      router.push("/home");
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : "ログインに失敗しました。";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#eef0f8] p-6">
      <section className="w-full max-w-md rounded-md border border-[#d7d8e2] bg-[#f8f8fb] p-8">
        <h1 className="text-2xl font-semibold text-[#2f3240]">ログイン</h1>
        <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
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
            パスワード
            <input
              required
              type="password"
              autoComplete="current-password"
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
            {loading ? "ログイン中..." : "ログイン"}
          </button>
        </form>
        <p className="mt-4 text-sm text-[#636776]">
          アカウントがない場合は{" "}
          <Link href="/signup" className="text-[#2f3345] underline">
            新規登録
          </Link>
        </p>
      </section>
    </main>
  );
}
