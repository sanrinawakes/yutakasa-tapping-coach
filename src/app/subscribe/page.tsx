"use client";

import { useTheme } from "@/components/ThemeProvider";

/**
 * MONTHLY LIFE COACHING 加入LP
 * 白基調ミニマル、プロフィール写真メイン
 */

const PROFILE_IMG = "/satoshi-profile.jpg"; // public/satoshi-profile.jpg
const HERO_BG_IMG =
  "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=2400&q=80&auto=format&fit=crop"; // 海・自由
const FREEDOM_IMG =
  "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1600&q=80&auto=format&fit=crop"; // 山頂・自由
const ABUNDANCE_IMG =
  "https://images.unsplash.com/photo-1507608616759-54f48f0af0ee?w=1600&q=80&auto=format&fit=crop"; // 朝のカフェ・豊かさ
const TAPPING_IMG =
  "https://images.unsplash.com/photo-1545389336-cf090694435e?w=1600&q=80&auto=format&fit=crop"; // 瞑想・タッピング

export default function SubscribePage() {
  const { theme, toggleTheme } = useTheme();
  const subscribeUrl = process.env.NEXT_PUBLIC_SUBSCRIPTION_LANDING_URL || "";

  return (
    <div
      className="min-h-screen"
      style={{
        backgroundColor: "#ffffff",
        color: "#1a1a1a",
      }}
    >
      {/* テーマ切替ボタン */}
      <button
        onClick={toggleTheme}
        className="fixed top-5 right-5 z-50 p-3 rounded-full transition-all duration-200 hover:scale-110"
        style={{
          backgroundColor: "rgba(255,255,255,0.95)",
          border: "1px solid #e5e5e5",
          color: "#666",
          boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        }}
        aria-label="テーマ切替"
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>

      {/* ===== HERO ===== */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.95) 100%), url(${HERO_BG_IMG})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
        <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32">
          <div className="grid md:grid-cols-2 gap-10 md:gap-16 items-center">
            <div>
              <div
                className="inline-block text-xs md:text-sm font-bold tracking-[0.3em] uppercase mb-6"
                style={{ color: "#15803d" }}
              >
                MONTHLY LIFE COACHING
              </div>
              <h1
                className="text-4xl md:text-6xl font-bold leading-[1.15] mb-6"
                style={{ color: "#0a0a0a", letterSpacing: "-0.02em" }}
              >
                頑張らなくても<br />
                豊かさが流れこむ<br />
                人生へ。
              </h1>
              <p className="text-base md:text-lg leading-relaxed mb-10" style={{ color: "#444" }}>
                三凛さとし直接の月1グループコーチング ×<br />
                24時間365日いつでも頼れるAIコーチbot。<br />
                意識を本気で書き換えて、現実をひっくり返す。
              </p>
              <div className="flex flex-wrap items-center gap-6 mb-8">
                <div>
                  <div className="text-xs font-bold tracking-widest uppercase mb-1" style={{ color: "#15803d" }}>
                    月額
                  </div>
                  <div className="text-5xl md:text-6xl font-bold" style={{ color: "#0a0a0a" }}>
                    ¥9,800
                  </div>
                  <div className="text-sm" style={{ color: "#888" }}>
                    （税込）・いつでも解約OK
                  </div>
                </div>
              </div>
              {subscribeUrl ? (
                <a
                  href={subscribeUrl}
                  className="inline-block px-10 py-4 rounded-full font-bold text-lg transition-all duration-200 hover:scale-105"
                  style={{
                    background: "linear-gradient(135deg, #166534, #15803d)",
                    color: "#fff",
                    boxShadow: "0 6px 20px rgba(22, 101, 52, 0.3)",
                  }}
                >
                  今すぐ加入する →
                </a>
              ) : (
                <div className="inline-block px-6 py-3 rounded-xl text-sm" style={{ backgroundColor: "#fee2e2", color: "#991b1b" }}>
                  申込URL準備中
                </div>
              )}
            </div>

            {/* 三凛さとし写真 */}
            <div className="flex justify-center md:justify-end">
              <div
                className="relative w-full max-w-md aspect-[3/4] rounded-3xl overflow-hidden"
                style={{ boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}
              >
                <img
                  src={PROFILE_IMG}
                  alt="三凛さとし"
                  className="w-full h-full object-cover"
                  style={{ display: "block" }}
                />
                <div
                  className="absolute bottom-0 left-0 right-0 p-5 text-white"
                  style={{
                    background: "linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.7) 100%)",
                  }}
                >
                  <div className="text-xs font-bold tracking-widest uppercase opacity-90 mb-1">Your Coach</div>
                  <div className="text-2xl font-bold">三凛さとし</div>
                  <div className="text-sm opacity-90">ライフコーチ／作家</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== すでに豊かさタッピング受講中の方へ ===== */}
      <section className="px-6 py-12" style={{ backgroundColor: "#f0fdf4" }}>
        <div className="max-w-4xl mx-auto">
          <div
            className="rounded-2xl p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center gap-5"
            style={{ backgroundColor: "#fff", border: "1px solid #bbf7d0" }}
          >
            <div className="flex-shrink-0 w-14 h-14 rounded-full flex items-center justify-center text-2xl"
                 style={{ background: "linear-gradient(135deg, #166534, #15803d)" }}>
              💡
            </div>
            <div className="flex-1">
              <h3 className="text-lg md:text-xl font-bold mb-2" style={{ color: "#0a0a0a" }}>
                すでに「豊かさタッピング」をご受講中の方へ
              </h3>
              <p className="text-sm md:text-base leading-relaxed" style={{ color: "#444" }}>
                ご購入から<strong>365日以内</strong>の方は、このプランへの加入なしでAIコーチbotをご利用いただけます。
                MyASPに登録したメールアドレスで <a href="/login" className="underline font-bold" style={{ color: "#15803d" }}>ログインページ</a> からそのままログインしてください。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ===== こんなあなたへ ===== */}
      <section className="px-6 py-20 md:py-28">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <div className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              FOR YOU
            </div>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: "#0a0a0a", letterSpacing: "-0.02em" }}>
              こんなあなたへ
            </h2>
            <p className="text-base md:text-lg" style={{ color: "#666" }}>
              ひとつでも当てはまるなら、このプランはあなたのためのものです
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {[
              "豊かさ・お金のメンタルブロックを根こそぎ外したい",
              "頑張らずに豊かさ・自由・充実を全部手に入れたい",
              "心から安心しリラックスしながら、現実面も豊かになりたい",
              "お金・豊かさ・自由を青天井に増やしていきたい",
              "夢を叶えたい／何が夢かまだわからないけど100%後悔しない人生を生きたい",
              "幸せなお金持ちになりたい（働く幸せ＋資産が毎月増える）",
              "意識を本当に変えて、現実そのものを変容させたい",
              "三凛さとしから直接グループコーチングを受けたい",
            ].map((text, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-5 rounded-xl"
                style={{ backgroundColor: "#fafafa", border: "1px solid #f0f0f0" }}
              >
                <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs text-white font-bold mt-0.5"
                      style={{ background: "linear-gradient(135deg, #166534, #15803d)" }}>
                  ✓
                </span>
                <p className="text-base leading-relaxed" style={{ color: "#222" }}>
                  {text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== 続けることで起こる変化 + イメージ画像 ===== */}
      <section className="relative px-6 py-20 md:py-28" style={{ backgroundColor: "#fafafa" }}>
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <div className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              YOUR FUTURE
            </div>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: "#0a0a0a", letterSpacing: "-0.02em" }}>
              続けることで起こる変化
            </h2>
            <p className="text-base md:text-lg" style={{ color: "#666" }}>
              内側が変われば、外の現実は嘘みたいに動きはじめる
            </p>
          </div>

          {/* 自由・豊かさのイメージ */}
          <div className="grid md:grid-cols-2 gap-4 mb-12">
            <div className="rounded-2xl overflow-hidden aspect-[4/3]" style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}>
              <img src={FREEDOM_IMG} alt="自由" className="w-full h-full object-cover" />
            </div>
            <div className="rounded-2xl overflow-hidden aspect-[4/3]" style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}>
              <img src={ABUNDANCE_IMG} alt="豊かさ" className="w-full h-full object-cover" />
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {[
              { title: "月収が上がる", desc: "豊かさのブロックが外れて、収入が自然と増えていく" },
              { title: "不安が減る", desc: "毎日が安心と幸せの感覚に包まれる" },
              { title: "人間関係が良くなる", desc: "家族・パートナー・周りとの関係が穏やかに" },
              { title: "頑張らずに進む", desc: "頑張ってないのに物事がどんどん前に動く" },
              { title: "他力が働く", desc: "なぜか助けてもらえる、応援される人になる" },
              { title: "悩みが消える", desc: "ぐるぐる悩む時間そのものが減っていく" },
              { title: "日々が幸せ", desc: "安心と充実が日常になる" },
              { title: "他力で夢が叶う", desc: "大きな夢が思いがけない流れで実現する" },
              { title: "選択肢が広がる", desc: "場所も働き方も自由に選べる人生に" },
            ].map((item, i) => (
              <div
                key={i}
                className="p-6 rounded-xl"
                style={{ backgroundColor: "#fff", border: "1px solid #f0f0f0" }}
              >
                <div className="text-xs font-bold tracking-widest uppercase mb-3" style={{ color: "#15803d" }}>
                  {String(i + 1).padStart(2, "0")}
                </div>
                <h3 className="text-lg font-bold mb-2" style={{ color: "#0a0a0a" }}>
                  {item.title}
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: "#666" }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== プラン内容 ===== */}
      <section className="px-6 py-20 md:py-28">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <div className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              WHAT'S INCLUDED
            </div>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: "#0a0a0a", letterSpacing: "-0.02em" }}>
              プラン内容
            </h2>
            <p className="text-base md:text-lg" style={{ color: "#666" }}>
              月額9,800円で、これ全部つきます
            </p>
          </div>

          <div className="space-y-5">
            {/* メイン */}
            <div
              className="rounded-2xl overflow-hidden"
              style={{ background: "linear-gradient(135deg, #14532d 0%, #166534 100%)" }}
            >
              <div className="p-8 md:p-12 text-white">
                <div className="text-xs font-bold tracking-[0.3em] uppercase mb-3 opacity-80">
                  ⭐ MAIN BENEFIT
                </div>
                <h3 className="text-2xl md:text-3xl font-bold mb-4 leading-tight">
                  三凛さとし直接<br />
                  月1グループコーチング
                </h3>
                <p className="text-base md:text-lg leading-relaxed opacity-95 mb-6">
                  <strong className="text-yellow-200">ここが本命です。</strong><br />
                  成功と達成のディクシャからはじまり、
                  あなたの現実を堰き止めている内側のブロックに高い解像度で気づき、
                  その場で解消していくプロセス。
                </p>
                <p className="text-sm md:text-base leading-relaxed opacity-90">
                  2025年5月から世界最先端の意識研究機関 oneness（インド）で
                  Sri Krishnaji・Sri Preethaji に師事した三凛が、1年間で実証した
                  「意識を本気で書き換える」ワークを月1で受けられます。
                </p>
                <div className="mt-5 inline-block text-sm bg-white/15 backdrop-blur px-4 py-2 rounded-full">
                  💎 単発で受けたら数万円相当の価値
                </div>
              </div>
            </div>

            {/* AIコーチbot */}
            <div className="rounded-2xl overflow-hidden grid md:grid-cols-2"
                 style={{ backgroundColor: "#fff", border: "1px solid #e5e5e5" }}>
              <div className="aspect-[4/3] md:aspect-auto">
                <img src={TAPPING_IMG} alt="タッピング" className="w-full h-full object-cover" />
              </div>
              <div className="p-8 md:p-10">
                <div className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
                  AI COACH BOT
                </div>
                <h3 className="text-2xl md:text-3xl font-bold mb-4" style={{ color: "#0a0a0a" }}>
                  24時間365日<br />
                  AIコーチbot使い放題
                </h3>
                <p className="text-sm md:text-base leading-relaxed mb-5" style={{ color: "#444" }}>
                  深夜2時の不安、朝の焦り、仕事中のイライラ。
                  その瞬間にAIコーチに話しかけて、
                  タッピングのお題を出してもらえる。
                </p>
                <ul className="space-y-2 text-sm md:text-base" style={{ color: "#444" }}>
                  <li className="flex items-center gap-2">
                    <span style={{ color: "#15803d" }}>✓</span>
                    タッピングのお題出し（24h）
                  </li>
                  <li className="flex items-center gap-2">
                    <span style={{ color: "#15803d" }}>✓</span>
                    お金のメンタルブロックの言語化
                  </li>
                  <li className="flex items-center gap-2">
                    <span style={{ color: "#15803d" }}>✓</span>
                    人生相談・お悩み相談
                  </li>
                  <li className="flex items-center gap-2">
                    <span style={{ color: "#15803d" }}>✓</span>
                    過去の履歴がそのまま残る
                  </li>
                  <li className="flex items-center gap-2">
                    <span style={{ color: "#15803d" }}>✓</span>
                    🎤 音声入力にも対応
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== 講師：三凛さとし ===== */}
      <section className="px-6 py-20 md:py-28" style={{ backgroundColor: "#fafafa" }}>
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <div className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              YOUR COACH
            </div>
            <h2 className="text-3xl md:text-5xl font-bold" style={{ color: "#0a0a0a", letterSpacing: "-0.02em" }}>
              講師：三凛さとし
            </h2>
          </div>

          <div className="grid md:grid-cols-5 gap-10 items-center">
            <div className="md:col-span-2">
              <div
                className="rounded-3xl overflow-hidden aspect-[3/4]"
                style={{ boxShadow: "0 16px 48px rgba(0,0,0,0.12)" }}
              >
                <img src={PROFILE_IMG} alt="三凛さとし" className="w-full h-full object-cover" />
              </div>
            </div>

            <div className="md:col-span-3 space-y-5 text-base md:text-lg leading-relaxed" style={{ color: "#333" }}>
              <p>
                ライフコーチ・作家として<strong>12年以上</strong>活動。
                世界4拠点（ポルトガル・マルタ・タイ・ドバイ）を転々としながら、
                SNSフォロワー合計<strong>約50万人</strong>、
                これまで<strong>数万人</strong>の人生変容に関わってきました。
              </p>
              <p>
                テレビ・雑誌・ラジオ・新聞での出演実績多数。
                お金の引き寄せ（金運）、親子関係、人間関係、仕事、健康と、
                人生の根幹に関わるテーマで発信。
                <strong>LINE占いの公認占い師</strong>でもあり、
                スピリチュアル・開運・自己啓発・心理学・占いと幅広い分野で活動しています。
              </p>

              <div className="border-l-4 pl-5 py-1" style={{ borderColor: "#ca8a04" }}>
                <p className="text-sm font-bold tracking-widest uppercase mb-2" style={{ color: "#ca8a04" }}>
                  🌀 大きな転機：2024〜2026
                </p>
                <p className="text-sm md:text-base">
                  2024年末、人工衛星打ち上げ事業をきっかけにSNSがプチ炎上、
                  事業も<strong>1億円の赤字</strong>。
                  そこから2025年5月、インドのoneness で Sri Krishnaji・Sri Preethaji に師事。
                  1年間学び続けた結果——
                </p>
                <p className="text-sm md:text-base mt-3">
                  2026年4月、<strong>夢叶フェス</strong>を開催。
                  立ち上げから<strong>たった3週間</strong>で、
                  ユニーク<strong>2.3万人</strong>・リアルタイム視聴のべ<strong>5.3万人</strong>を動員。
                  日本の自己啓発業界では過去最大規模のフェスに。
                </p>
                <p className="text-sm md:text-base mt-3">
                  仕事時間は半分以下、YouTubeもほぼ手放した。
                  でも売上と利益は増えた。
                  <strong>この変容の裏には、瞑想とタッピングがありました。</strong>
                </p>
              </div>

              <p>
                このプランは、その1年間で身体で実証してきた「意識の書き換え方」を、
                毎月のグループコーチングで直接お伝えしていく場です。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ===== 実践者の声 ===== */}
      <section className="px-6 py-20 md:py-28">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <div className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              SUCCESS STORIES
            </div>
            <h2 className="text-3xl md:text-5xl font-bold mb-4" style={{ color: "#0a0a0a", letterSpacing: "-0.02em" }}>
              タッピング実践者の声
            </h2>
            <p className="text-base md:text-lg" style={{ color: "#666" }}>
              内側を変えた人たちの「現実」がこちら
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-5">
            {[
              {
                name: "MIWAさん",
                badge: "底辺生活 → 月収22倍",
                story: "人前に出るのが苦手でしたが、メンタルブロックを外しミセスオブザイヤー2025グランプリ受賞！50万円のドレスを躊躇なく買える生活に。日本と世界を駆け巡る人生に。",
              },
              {
                name: "ゆうたさん",
                badge: "借金6,000万 → 年商1億超",
                story: "パワハラに悩まされた介護士時代、当時の婚約者に婚約破棄もされてしまいました。タッピングに出会って三凛さんから直接指導を受け、売れっ子カウンセラー兼発信者に！彼女もGET！",
              },
              {
                name: "うさぎさん",
                badge: "限界OL → 年収3,500万",
                story: "コロナ禍に副業講座に複数チャレンジするも次々挫折。2021年にタッピングに出会い「稼ぐことへのメンタルブロック」に集中して取り組んで収入は10倍に！月1で海外へ行ける生活に。",
              },
              {
                name: "よしだりよさん",
                badge: "パン屋パート → 月収5倍",
                story: "自分責めが減り、感謝してお金を受け取れるように。念願だった東京の一等地に引っ越しました。家族との関係もかなり良くなりました。",
              },
              {
                name: "田村望さん（51歳）",
                badge: "我慢OL → 女性経営者",
                story: "損保会社で我慢して働くOLから女性経営者になり、念願だった地元の県知事とお仕事まで実現！行動のスピードが圧倒的にUP。家族の協力も得られるように。若返りも実現しました。",
              },
            ].map((v, i) => (
              <div
                key={i}
                className="p-6 md:p-8 rounded-2xl"
                style={{ backgroundColor: "#fff", border: "1px solid #f0f0f0" }}
              >
                <div
                  className="inline-block px-3 py-1 rounded-full text-xs font-bold mb-4"
                  style={{
                    background: "linear-gradient(135deg, #ca8a04, #f59e0b)",
                    color: "#fff",
                  }}
                >
                  {v.badge}
                </div>
                <h3 className="text-base font-bold mb-3" style={{ color: "#0a0a0a" }}>
                  {v.name}
                </h3>
                <p className="text-sm md:text-base leading-relaxed" style={{ color: "#444" }}>
                  「{v.story}」
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Q&A ===== */}
      <section className="px-6 py-20 md:py-28" style={{ backgroundColor: "#fafafa" }}>
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-14">
            <div className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              FAQ
            </div>
            <h2 className="text-3xl md:text-5xl font-bold" style={{ color: "#0a0a0a", letterSpacing: "-0.02em" }}>
              よくある質問
            </h2>
          </div>

          <div className="space-y-3">
            {[
              {
                q: "解約はいつでもできますか？",
                a: "はい、ネットからいつでも解約可能です。決済日の7日前までにご解約手続きをいただければ、次回の決済は走りません。引き留めや解約理由のヒアリングなどもありません。",
              },
              {
                q: "途中で辞めても違約金はかかりますか？",
                a: "一切かかりません。お試しで1ヶ月だけ受けて合わなければ解約、で全くOKです。",
              },
              {
                q: "決済が失敗したらどうなりますか？",
                a: "決済が止まったタイミングで自動的にbotへのアクセスも停止します。再開したい場合は再度お申込みください。",
              },
              {
                q: "決済後、すぐにbotが使えますか？",
                a: "決済完了後、自動的にあなたのメールアドレスでアカウントが作成されます。決済時のメールアドレスでログインページからログインしてください。AIコーチbotはすぐにご利用いただけます。",
              },
              {
                q: "タッピング初心者でも大丈夫ですか？",
                a: "全く問題ありません。AIコーチがあなたのレベルに合わせてタッピングのお題を出してくれますし、月1のグループコーチングでも基礎から丁寧にお伝えします。",
              },
              {
                q: "海外在住でも参加できますか？",
                a: "もちろん大丈夫です。グループコーチングはオンライン開催、AIコーチbotもブラウザがあればどこからでも使えます。",
              },
              {
                q: "すでに豊かさタッピングを受講しているのですが、加入する必要はありますか？",
                a: "ご購入から365日以内であれば、追加加入なしでAIコーチbotをそのままご利用いただけます。月1のグループコーチングを希望される方はぜひこちらにご加入ください。",
              },
              {
                q: "音声入力は使えますか？",
                a: "はい、使えます。Chrome / Safari / Edge ブラウザで、AIコーチへのメッセージをマイクから音声入力できます（日本語対応）。",
              },
            ].map((item, i) => (
              <details
                key={i}
                className="group rounded-xl overflow-hidden transition-all"
                style={{ backgroundColor: "#fff", border: "1px solid #f0f0f0" }}
              >
                <summary
                  className="cursor-pointer p-5 md:p-6 font-bold flex items-start justify-between gap-4 list-none"
                  style={{ color: "#0a0a0a" }}
                >
                  <span className="text-base md:text-lg">{item.q}</span>
                  <span className="text-2xl flex-shrink-0 transition-transform group-open:rotate-45" style={{ color: "#15803d" }}>
                    +
                  </span>
                </summary>
                <div className="px-5 md:px-6 pb-5 md:pb-6 text-sm md:text-base leading-relaxed" style={{ color: "#555" }}>
                  {item.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ===== 最終CTA ===== */}
      <section
        className="relative px-6 py-24 md:py-32 text-center text-white overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #14532d 0%, #166534 50%, #15803d 100%)",
        }}
      >
        <div className="relative max-w-3xl mx-auto">
          <div className="text-xs font-bold tracking-[0.3em] uppercase mb-6 opacity-80">
            START YOUR TRANSFORMATION
          </div>
          <h2 className="text-3xl md:text-5xl font-bold mb-6 leading-tight" style={{ letterSpacing: "-0.02em" }}>
            あなたの人生は、<br />
            あなたの意識でできている。
          </h2>
          <p className="text-base md:text-lg mb-10 opacity-95 leading-relaxed">
            意識を変えれば、現実は雪崩のように変わる。<br />
            その瞬間を、月1のセッションとAIコーチで一緒につくろう。
          </p>

          <div className="inline-block bg-white text-gray-900 rounded-2xl px-8 py-6 mb-8" style={{ boxShadow: "0 12px 40px rgba(0,0,0,0.25)" }}>
            <div className="text-xs font-bold tracking-widest uppercase mb-1" style={{ color: "#15803d" }}>
              月額継続コーチング
            </div>
            <div className="text-5xl md:text-6xl font-bold" style={{ color: "#0a0a0a" }}>
              ¥9,800
            </div>
            <div className="text-sm" style={{ color: "#666" }}>/ 月（税込）・いつでも解約OK</div>
          </div>

          <div>
            {subscribeUrl ? (
              <a
                href={subscribeUrl}
                className="inline-block px-12 py-5 rounded-full font-bold text-xl transition-all duration-200 hover:scale-105"
                style={{
                  background: "linear-gradient(135deg, #ca8a04, #f59e0b)",
                  color: "#fff",
                  boxShadow: "0 10px 30px rgba(202, 138, 4, 0.5)",
                }}
              >
                今すぐ加入する →
              </a>
            ) : (
              <div className="bg-red-500/20 border border-red-300 rounded-xl px-6 py-4 text-base inline-block">
                ⚠ 申込URL準備中
              </div>
            )}
          </div>
          <p className="text-sm mt-6 opacity-80">
            初月から月額9,800円・1ヶ月毎課金・決済日の7日前までの解約で次月課金停止
          </p>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="px-6 py-10 text-center text-sm" style={{ color: "#888", backgroundColor: "#fafafa" }}>
        <a href="/login" className="underline hover:opacity-80" style={{ color: "#15803d" }}>
          ← ログインに戻る
        </a>
        <p className="mt-4 opacity-70">© 三凛さとし / MONTHLY LIFE COACHING</p>
      </footer>
    </div>
  );
}
