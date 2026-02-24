import Link from "next/link";

export default function RootPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#eef0f8] p-6">
      <section className="w-full max-w-md rounded-md border border-[#d7d8e2] bg-[#f8f8fb] p-8">
        <h1 className="text-2xl font-semibold text-[#2f3240]">Upmo</h1>
        <p className="mt-3 text-sm text-[#636776]">
          社内向けチャットにログインするか、新規登録してください。
        </p>
        <div className="mt-6 grid gap-3">
          <Link
            href="/login"
            className="flex h-11 items-center justify-center rounded-sm bg-[#2f3345] text-sm font-medium text-white"
          >
            ログイン
          </Link>
          <Link
            href="/signup"
            className="flex h-11 items-center justify-center rounded-sm border border-[#cfd1de] bg-white text-sm font-medium text-[#2f3345]"
          >
            新規登録
          </Link>
        </div>
      </section>
    </main>
  );
}
