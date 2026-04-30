"use client";

import { useTheme } from "@/components/ThemeProvider";

/**
 * MONTHLY LIFE COACHING 加入LP v4
 * - 白基調・余白多め・タイポグラフィ重視
 * - 画像はプロフィール写真1枚のみ
 * - 装飾控えめ、品格優先
 */
export default function SubscribePage() {
  const { theme, toggleTheme } = useTheme();
  const subscribeUrl = process.env.NEXT_PUBLIC_SUBSCRIPTION_LANDING_URL || "";

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}>
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="fixed top-5 right-5 z-50 p-3 rounded-full transition-all duration-200 hover:scale-105"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-subtle)",
          color: "var(--text-secondary)",
        }}
        aria-label="テーマ切替"
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>

      {/* ────────── Header bar (minimal) ────────── */}
      <header className="sticky top-0 z-40 backdrop-blur-md"
              style={{ backgroundColor: "var(--bg-primary)CC", borderBottom: "1px solid var(--border-subtle)" }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="text-sm font-bold tracking-[0.2em] uppercase" style={{ color: "var(--text-primary)" }}>
            Monthly Life Coaching
          </div>
          {subscribeUrl && (
            <a href={subscribeUrl}
               className="hidden md:inline-flex items-center px-5 py-2 rounded-full text-sm font-bold transition-colors"
               style={{ backgroundColor: "#111", color: "#fff" }}>
              加入する
            </a>
          )}
        </div>
      </header>

      {/* ────────── Hero ────────── */}
      <section className="px-6 pt-20 pb-24 md:pt-28 md:pb-32">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-xs font-bold tracking-[0.3em] uppercase mb-8" style={{ color: "#15803d" }}>
            ─ Monthly Life Coaching ─
          </p>
          <h1 className="font-bold mb-8 leading-[1.15] tracking-tight"
              style={{ color: "var(--text-primary)", fontSize: "clamp(2.25rem, 5.5vw, 4.5rem)" }}>
            頑張らなくても、<br />
            豊かさが流れこむ人生へ。
          </h1>
          <p className="text-lg md:text-xl mb-12 leading-relaxed max-w-2xl mx-auto"
             style={{ color: "var(--text-secondary)" }}>
            三凛さとしの月1グループコーチングと、24時間いつでも頼れるAIコーチbot。<br className="hidden md:inline" />
            意識を本気で書き換えて、現実をひっくり返す月額プラン。
          </p>

          {/* CTA */}
          <div className="inline-flex flex-col items-center gap-4">
            {subscribeUrl ? (
              <a href={subscribeUrl}
                 className="inline-flex items-center justify-center px-12 py-5 rounded-full text-lg font-bold transition-transform hover:scale-[1.03]"
                 style={{ backgroundColor: "#111", color: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,0.15)" }}>
                月¥9,800で加入する →
              </a>
            ) : (
              <div className="px-8 py-4 rounded-full text-sm" style={{ backgroundColor: "#fef2f2", color: "#dc2626" }}>
                ⚠ 申込URL準備中
              </div>
            )}
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              月額9,800円（税込）・いつでも解約OK・初月から課金
            </p>
          </div>
        </div>
      </section>

      {/* ────────── Existing user notice ────────── */}
      <section className="px-6 pb-16">
        <div
          className="max-w-3xl mx-auto px-6 py-5 md:px-8 md:py-6 rounded-2xl flex items-start gap-4"
          style={{
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-base"
               style={{ backgroundColor: "#15803d", color: "#fff" }}>
            ✓
          </div>
          <div className="flex-1 text-sm md:text-base leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            <p className="font-bold mb-1" style={{ color: "var(--text-primary)" }}>
              すでに「豊かさタッピング」をご受講中の方へ
            </p>
            <p>
              ご購入から<strong>365日以内</strong>の方は、このプランへの加入なしでAIコーチbotをご利用いただけます。
              MyASPにご登録のメールアドレスで <a href="/login" className="underline font-medium" style={{ color: "#15803d" }}>ログインページ</a> からそのままログインしてください。
            </p>
          </div>
        </div>
      </section>

      {/* ────────── Section: For You ────────── */}
      <section className="px-6 py-20 md:py-28" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="max-w-5xl mx-auto">
          <div className="mb-16 text-center">
            <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              For You
            </p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
              こんなあなたへ
            </h2>
          </div>
          <ul className="grid md:grid-cols-2 gap-x-12 gap-y-5">
            {[
              "豊かさ・お金のメンタルブロックを根こそぎ外したい",
              "頑張らずに豊かさ・自由・充実を全部手に入れたい",
              "心から安心しリラックスしながら、現実面も豊かになりたい",
              "お金・豊かさ・自由を青天井に増やしていきたい",
              "夢を叶えたい／100%後悔しない人生を生きたい",
              "幸せなお金持ちになりたい",
              "意識を本当に変えて、現実そのものを変容させたい",
              "三凛さとしから直接グループコーチングを受けたい",
            ].map((text, i) => (
              <li key={i} className="flex items-start gap-3 text-base md:text-lg leading-relaxed"
                  style={{ color: "var(--text-primary)" }}>
                <span className="flex-shrink-0 mt-2 w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#15803d" }} />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ────────── Section: Your Future ────────── */}
      <section className="px-6 py-20 md:py-28" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <div className="max-w-5xl mx-auto">
          <div className="mb-16 text-center">
            <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              Your Future
            </p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4" style={{ color: "var(--text-primary)" }}>
              続けることで、こうなる
            </h2>
            <p className="text-base md:text-lg" style={{ color: "var(--text-secondary)" }}>
              内側が変われば、外の現実は嘘みたいに動きはじめる
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-x-10 gap-y-12">
            {[
              { num: "01", title: "月収が上がる", desc: "豊かさのブロックが外れて、収入が自然と増える" },
              { num: "02", title: "不安が減る", desc: "毎日が安心と幸せの感覚に包まれる" },
              { num: "03", title: "人間関係が良くなる", desc: "家族・パートナー・周りが穏やかになる" },
              { num: "04", title: "頑張らずに進む", desc: "頑張っていないのに物事がどんどん前へ" },
              { num: "05", title: "他力が働く", desc: "なぜか助けてもらえる、応援される人になる" },
              { num: "06", title: "悩みが消える", desc: "ぐるぐる悩む時間そのものが減る" },
              { num: "07", title: "日々が幸せ", desc: "安心と充実が日常になる" },
              { num: "08", title: "他力で夢が叶う", desc: "大きな夢が思いがけない流れで実現" },
              { num: "09", title: "選択肢が広がる", desc: "場所も働き方も自由に選べる人生に" },
            ].map((item, i) => (
              <div key={i}>
                <div className="text-sm font-mono mb-2" style={{ color: "#15803d", opacity: 0.7 }}>
                  {item.num}
                </div>
                <h3 className="text-xl font-bold mb-2" style={{ color: "var(--text-primary)" }}>
                  {item.title}
                </h3>
                <p className="text-base leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ────────── Section: What's Included ────────── */}
      <section className="px-6 py-20 md:py-28" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="max-w-5xl mx-auto">
          <div className="mb-16 text-center">
            <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              What's Included
            </p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4" style={{ color: "var(--text-primary)" }}>
              プラン内容
            </h2>
            <p className="text-base md:text-lg" style={{ color: "var(--text-secondary)" }}>
              月額9,800円で、すべて含まれます
            </p>
          </div>

          <div className="space-y-4">
            {/* Main Benefit */}
            <div className="rounded-3xl p-8 md:p-12"
                 style={{ backgroundColor: "#0f1f17", color: "#ffffff" }}>
              <div className="grid md:grid-cols-[auto_1fr] gap-6 md:gap-10 items-start">
                <div className="text-3xl md:text-4xl font-mono font-bold opacity-30">01</div>
                <div>
                  <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#fde68a" }}>
                    Main Benefit ★
                  </p>
                  <h3 className="text-2xl md:text-4xl font-bold mb-5 leading-tight">
                    三凛さとし直接の<br />
                    月1グループコーチング
                  </h3>
                  <p className="text-base md:text-lg leading-relaxed opacity-90 mb-4">
                    <strong style={{ color: "#fde68a" }}>このプランの本命がこれです。</strong>
                    成功と達成のディクシャからはじまり、あなたの現実を堰き止めている内側のブロックに高い解像度で気づき、その場で解消していくプロセス。
                  </p>
                  <p className="text-base md:text-lg leading-relaxed opacity-90 mb-6">
                    2025年5月から世界最先端の意識研究機関 oneness（インド）で Sri Krishnaji・Sri Preethaji に師事した三凛が、1年間で実証した「意識を本気で書き換える」ワークを月1で受けられます。
                  </p>
                  <div className="inline-block text-sm px-4 py-2 rounded-full" style={{ backgroundColor: "rgba(253,230,138,0.15)", color: "#fde68a" }}>
                    単発で受けたら数万円相当の価値
                  </div>
                </div>
              </div>
            </div>

            {/* AI Coach Bot */}
            <div className="rounded-3xl p-8 md:p-12"
                 style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-subtle)" }}>
              <div className="grid md:grid-cols-[auto_1fr] gap-6 md:gap-10 items-start">
                <div className="text-3xl md:text-4xl font-mono font-bold" style={{ color: "var(--text-muted)", opacity: 0.4 }}>02</div>
                <div>
                  <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
                    AI Coach Bot
                  </p>
                  <h3 className="text-2xl md:text-4xl font-bold mb-5 leading-tight" style={{ color: "var(--text-primary)" }}>
                    24時間365日<br />
                    AIコーチbot使い放題
                  </h3>
                  <p className="text-base md:text-lg leading-relaxed mb-6" style={{ color: "var(--text-secondary)" }}>
                    深夜2時の不安、朝の焦り、仕事中のイライラ。その瞬間にAIコーチに話しかけて、タッピングのお題を出してもらえる。過去の会話履歴も全部残るので、自分の変容の過程も振り返れます。
                  </p>
                  <ul className="grid md:grid-cols-2 gap-x-8 gap-y-2 text-base" style={{ color: "var(--text-secondary)" }}>
                    {[
                      "タッピングのお題出し（24h）",
                      "お金のメンタルブロックの言語化",
                      "人生相談・お悩み相談",
                      "過去の履歴がそのまま残る",
                      "🎤 音声入力にも対応",
                      "1日15回まで（実質無制限）",
                    ].map((t, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span style={{ color: "#15803d" }}>✓</span> {t}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* Continuity */}
            <div className="rounded-3xl p-8 md:p-12"
                 style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-subtle)" }}>
              <div className="grid md:grid-cols-[auto_1fr] gap-6 md:gap-10 items-start">
                <div className="text-3xl md:text-4xl font-mono font-bold" style={{ color: "var(--text-muted)", opacity: 0.4 }}>03</div>
                <div>
                  <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
                    Continuity
                  </p>
                  <h3 className="text-2xl md:text-4xl font-bold mb-5 leading-tight" style={{ color: "var(--text-primary)" }}>
                    継続だからこそ<br />
                    深まる変容
                  </h3>
                  <p className="text-base md:text-lg leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    意識の書き換えは「1回受けて終わり」ではありません。毎月の積み重ねで、3ヶ月後、半年後、1年後の自分がまったく別人のようになっていく。タッピングと内省を毎日の習慣にして、「悟った意識状態」「美しい意識状態」を日常に落とし込みます。
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ────────── Section: Your Coach ────────── */}
      <section className="px-6 py-20 md:py-32" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <div className="max-w-6xl mx-auto">
          <div className="mb-12 md:mb-16 text-center">
            <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              Your Coach
            </p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
              三凛さとし
            </h2>
            <p className="text-base md:text-lg mt-3" style={{ color: "var(--text-secondary)" }}>
              ライフコーチ・作家
            </p>
          </div>

          <div className="grid md:grid-cols-[2fr_3fr] gap-10 md:gap-16 items-start">
            {/* Profile photo */}
            <div className="relative">
              <div className="aspect-[3/4] rounded-3xl overflow-hidden"
                   style={{ backgroundColor: "#dbeafe" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/satoshi-profile.jpg"
                  alt="三凛さとし"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>

            {/* Bio */}
            <div className="space-y-6 text-base md:text-lg leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              <p>
                ライフコーチ・作家として<strong style={{ color: "var(--text-primary)" }}>12年以上</strong>活動。世界4拠点（ポルトガル・マルタ・タイ・ドバイ）を転々としながら、SNSフォロワー合計<strong style={{ color: "var(--text-primary)" }}>約50万人</strong>、これまで<strong style={{ color: "var(--text-primary)" }}>数万人</strong>の人生変容に関わってきました。
              </p>
              <p>
                テレビ・雑誌・ラジオ・新聞での出演実績多数。お金の引き寄せ、親子関係、人間関係、仕事、健康と、人生の根幹に関わるテーマで発信しています。<strong style={{ color: "var(--text-primary)" }}>LINE占いの公認占い師</strong>でもあり、スピリチュアル・開運・自己啓発・心理学・占いと幅広い分野で活動。
              </p>
              <div className="pt-6 mt-6" style={{ borderTop: "1px solid var(--border-subtle)" }}>
                <p className="text-xs font-bold tracking-[0.2em] uppercase mb-3" style={{ color: "#15803d" }}>
                  ─ 大きな転機：2024–2026 ─
                </p>
                <p className="mb-4">
                  2024年末、人工衛星打ち上げ事業をきっかけにSNSがプチ炎上、事業も<strong style={{ color: "var(--text-primary)" }}>1億円の赤字</strong>。そこから2025年5月、インドの oneness で Sri Krishnaji・Sri Preethaji に師事。1年間学び続けた結果——
                </p>
                <p className="mb-4">
                  2026年4月、<strong style={{ color: "var(--text-primary)" }}>夢叶フェス</strong>を開催。立ち上げから<strong>たった3週間</strong>で、ユニーク<strong style={{ color: "var(--text-primary)" }}>2.3万人</strong>・リアルタイム視聴のべ<strong style={{ color: "var(--text-primary)" }}>5.3万人</strong>を動員。日本の自己啓発業界では過去最大規模のフェスに。
                </p>
                <p>
                  仕事時間は半分以下、YouTubeもほぼ手放した。でも売上と利益は増えた。<strong style={{ color: "var(--text-primary)" }}>この変容の裏には、瞑想とタッピングがありました。</strong>
                </p>
                <p className="mt-4">
                  このプランは、その1年間で身体で実証してきた「意識の書き換え方」を、毎月のグループコーチングで直接伝えていく場です。
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ────────── Section: Stories ────────── */}
      <section className="px-6 py-20 md:py-28" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="max-w-5xl mx-auto">
          <div className="mb-16 text-center">
            <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              Success Stories
            </p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4" style={{ color: "var(--text-primary)" }}>
              実践者の声
            </h2>
            <p className="text-base md:text-lg" style={{ color: "var(--text-secondary)" }}>
              内側を変えた人たちの「現実」
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-x-10 gap-y-16">
            {[
              {
                photo: "/testimonials/miwa.jpg",
                badge: "底辺生活 → 月収 22倍",
                name: "MIWAさん",
                story: "人前に出るのが苦手でしたが、メンタルブロックを外しミセスオブザイヤー2025グランプリ受賞。50万円のドレスを躊躇なく買える生活に。日本と世界を駆け巡る人生になりました。",
              },
              {
                photo: "/testimonials/yuta.jpg",
                badge: "借金 6,000万 → 年商 1億超",
                name: "ゆうたさん",
                story: "パワハラに悩まされた介護士時代、当時の婚約者に婚約破棄もされました。タッピングに出会って三凛さんから直接指導を受け、売れっ子カウンセラー兼発信者に。彼女もできました。",
              },
              {
                photo: "/testimonials/usagi.jpg",
                badge: "限界OL → 年収 3,500万",
                name: "うさぎさん",
                story: "コロナ禍に副業講座に複数チャレンジするも次々挫折。2021年にタッピングに出会い「稼ぐことへのメンタルブロック」に集中して取り組み、収入は10倍に。月1で海外へ行ける生活になりました。",
              },
              {
                photo: "/testimonials/yoshida.jpg",
                badge: "パン屋パート → 月収 5倍",
                name: "よしだりよさん",
                story: "自分責めが減り、感謝してお金を受け取れるように。念願だった東京の一等地に引っ越しました。家族との関係もかなり良くなりました。",
              },
              {
                photo: "/testimonials/tamura.jpg",
                badge: "我慢OL → 女性経営者",
                name: "田村望さん（51歳）",
                story: "損保会社で我慢して働くOLから女性経営者になり、念願だった地元の県知事とお仕事まで実現。行動のスピードが圧倒的にUP、家族の協力も得られるように、若返りも実現しました。",
              },
            ].map((v, i) => (
              <div key={i}>
                <div className="aspect-[3/4] rounded-2xl overflow-hidden mb-5"
                     style={{ backgroundColor: "var(--bg-secondary)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={v.photo} alt={v.name} className="w-full h-full object-cover" />
                </div>
                <p className="text-xs font-bold tracking-[0.2em] uppercase mb-3" style={{ color: "#15803d" }}>
                  {v.badge}
                </p>
                <p className="text-base md:text-lg leading-relaxed mb-4" style={{ color: "var(--text-primary)" }}>
                  「{v.story}」
                </p>
                <p className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
                  — {v.name}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ────────── Section: FAQ ────────── */}
      <section className="px-6 py-20 md:py-28" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <div className="max-w-3xl mx-auto">
          <div className="mb-16 text-center">
            <p className="text-xs font-bold tracking-[0.3em] uppercase mb-3" style={{ color: "#15803d" }}>
              FAQ
            </p>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
              よくある質問
            </h2>
          </div>
          <div className="space-y-3">
            {[
              {
                q: "解約はいつでもできますか？",
                a: "はい、ネットからいつでも解約可能です。決済日の7日前までに手続きいただければ、次回の決済は走りません。引き留めや解約理由のヒアリングもありません。",
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
                a: "決済完了後、ご登録のメールアドレスでログインページからログインしていただけば、すぐにAIコーチbotが使えるようになります。利用方法のご案内メールも届きます。",
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
                a: "ご購入から365日以内であれば、追加の加入なしでAIコーチbotをご利用いただけます。MyASPに登録のメールアドレスでログインページから直接ログインしてください。365日経過後も継続したい方、毎月の三凛グループコーチングを受けたい方はこのプランへのご加入をご検討ください。",
              },
              {
                q: "音声入力は使えますか？",
                a: "はい。AIコーチbotではマイクボタンから日本語の音声入力ができます（Chrome / Safari / Edge対応）。スマホからも使えます。",
              },
            ].map((item, i) => (
              <details
                key={i}
                className="group rounded-2xl"
                style={{
                  backgroundColor: "var(--bg-primary)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <summary className="cursor-pointer px-6 py-5 font-bold flex items-center justify-between gap-4 list-none"
                         style={{ color: "var(--text-primary)" }}>
                  <span className="flex-1">{item.q}</span>
                  <span className="flex-shrink-0 transition-transform group-open:rotate-45 text-2xl font-light"
                        style={{ color: "var(--text-muted)" }}>+</span>
                </summary>
                <div className="px-6 pb-6 -mt-1 text-base leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  {item.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ────────── Section: Final CTA ────────── */}
      <section className="px-6 py-24 md:py-32 text-center" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div className="max-w-3xl mx-auto">
          <p className="text-xs font-bold tracking-[0.3em] uppercase mb-6" style={{ color: "#15803d" }}>
            ─ Start Your Transformation ─
          </p>
          <h2 className="font-bold mb-8 leading-[1.2] tracking-tight"
              style={{ color: "var(--text-primary)", fontSize: "clamp(2rem, 4.5vw, 3.5rem)" }}>
            あなたの人生は、<br />
            あなたの意識でできている。
          </h2>
          <p className="text-base md:text-lg mb-12 leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            意識を変えれば、現実は雪崩のように変わる。<br />
            その瞬間を、月1のセッションとAIコーチで一緒につくりましょう。
          </p>

          <div className="inline-flex flex-col items-center gap-3">
            {subscribeUrl ? (
              <a href={subscribeUrl}
                 className="inline-flex items-center justify-center px-12 py-5 rounded-full text-lg font-bold transition-transform hover:scale-[1.03]"
                 style={{ backgroundColor: "#111", color: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,0.15)" }}>
                月¥9,800で加入する →
              </a>
            ) : (
              <div className="px-8 py-4 rounded-full text-sm" style={{ backgroundColor: "#fef2f2", color: "#dc2626" }}>
                ⚠ 申込URL準備中
              </div>
            )}
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              月額9,800円（税込）・1ヶ月毎課金・決済日7日前までの解約で次月停止
            </p>
          </div>
        </div>
      </section>

      {/* ────────── Footer ────────── */}
      <footer className="px-6 py-10 text-center text-sm"
              style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border-subtle)" }}>
        <a href="/login" className="underline hover:opacity-80">ログインページへ</a>
        <p className="mt-4 opacity-60">
          © 三凛さとし · MONTHLY LIFE COACHING
        </p>
      </footer>
    </div>
  );
}
