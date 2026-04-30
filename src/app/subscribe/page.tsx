"use client";

import { useTheme } from "@/components/ThemeProvider";

/**
 * MONTHLY LIFE COACHING 加入LP
 * 月額9,800円・三凛さとし直接グループコーチング+AIコーチbotサブスク
 */
export default function SubscribePage() {
  const { theme, toggleTheme } = useTheme();
  const subscribeUrl = process.env.NEXT_PUBLIC_SUBSCRIPTION_LANDING_URL || "";

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-primary)" }}>
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="fixed top-5 right-5 z-50 p-3 rounded-full transition-all duration-200 hover:scale-110"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-secondary)",
          color: "var(--text-secondary)",
          boxShadow: "var(--shadow-sm)",
        }}
        aria-label="テーマ切替"
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>

      {/* Hero */}
      <section
        className="relative px-6 py-20 md:py-32 overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #166534 0%, #15803d 50%, #ca8a04 100%)",
        }}
      >
        <div className="max-w-5xl mx-auto text-center text-white relative z-10">
          <div className="inline-block px-4 py-2 rounded-full mb-6 text-sm font-bold tracking-widest uppercase"
               style={{ backgroundColor: "rgba(255,255,255,0.15)", backdropFilter: "blur(10px)" }}>
            🌿 MONTHLY LIFE COACHING
          </div>
          <h1 className="text-4xl md:text-6xl font-bold mb-6 leading-tight tracking-tight">
            頑張らなくても<br />
            <span style={{ color: "#fde68a" }}>豊かさ・自由・幸せ</span>が<br />
            雪崩のように流れこむ人生へ
          </h1>
          <p className="text-lg md:text-2xl mb-10 leading-relaxed opacity-95">
            三凛さとしの月1グループコーチング × 24時間AIコーチbot<br />
            <span className="text-base md:text-xl opacity-80">
              意識を本気で書き換えて、現実をひっくり返す。
            </span>
          </p>
          <div className="inline-block bg-white text-gray-900 rounded-2xl p-6 md:p-8 shadow-2xl mb-8">
            <div className="text-sm font-bold tracking-widest uppercase mb-2" style={{ color: "#15803d" }}>
              月額継続コーチングプラン
            </div>
            <div className="text-5xl md:text-6xl font-bold mb-1" style={{ color: "#15803d" }}>
              ¥9,800
            </div>
            <div className="text-sm opacity-70">/ 月（税込）・いつでも解約OK</div>
          </div>
          {subscribeUrl ? (
            <div>
              <a
                href={subscribeUrl}
                className="inline-block px-12 py-5 rounded-full font-bold text-xl text-white transition-all duration-200 hover:scale-105"
                style={{
                  background: "linear-gradient(135deg, #ca8a04, #f59e0b)",
                  boxShadow: "0 8px 24px rgba(202, 138, 4, 0.5)",
                }}
              >
                今すぐ加入する →
              </a>
              <p className="text-sm mt-4 opacity-80">クレジットカード決済・1分で完了</p>
            </div>
          ) : (
            <div className="bg-red-500/20 border border-red-300 rounded-xl px-6 py-4 text-base">
              ⚠ 申込URL準備中。サポートまでご連絡ください。
            </div>
          )}
        </div>
      </section>

      {/* こんな人のためのプラン */}
      <section className="px-6 py-20 md:py-24" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold text-center mb-4" style={{ color: "var(--text-primary)" }}>
            こんなあなたへ
          </h2>
          <p className="text-center text-lg mb-12 opacity-70" style={{ color: "var(--text-secondary)" }}>
            ひとつでも当てはまるなら、このプランはあなたのためのものです
          </p>
          <div className="grid md:grid-cols-2 gap-5">
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
                className="flex items-start gap-4 p-5 rounded-2xl"
                style={{
                  backgroundColor: "var(--bg-card)",
                  border: "1px solid var(--border-secondary)",
                }}
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white font-bold"
                     style={{ background: "linear-gradient(135deg, #166534, #15803d)" }}>
                  ✓
                </div>
                <p className="text-base md:text-lg leading-relaxed" style={{ color: "var(--text-primary)" }}>
                  {text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 得られる変化 */}
      <section className="px-6 py-20 md:py-24" style={{ backgroundColor: "var(--bg-primary)" }}>
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold text-center mb-4" style={{ color: "var(--text-primary)" }}>
            続けることで起こる変化
          </h2>
          <p className="text-center text-lg mb-12 opacity-70" style={{ color: "var(--text-secondary)" }}>
            内側が変われば、外の現実は嘘みたいに動きはじめます
          </p>
          <div className="grid md:grid-cols-3 gap-5">
            {[
              { emoji: "💰", title: "月収が上がる", desc: "豊かさのブロックが外れて、収入が自然と増えていく" },
              { emoji: "😌", title: "不安が減る", desc: "毎日が安心と幸せの感覚に包まれる" },
              { emoji: "👨‍👩‍👧", title: "人間関係が良くなる", desc: "家族・パートナー・周りとの関係が穏やかに" },
              { emoji: "🌊", title: "頑張らずに進む", desc: "頑張ってないのに物事がどんどん前に動く" },
              { emoji: "🤝", title: "他力が働く", desc: "なぜか助けてもらえる、応援される人になる" },
              { emoji: "✨", title: "悩みが消える", desc: "ぐるぐる悩む時間そのものが減っていく" },
              { emoji: "🏖️", title: "日々が幸せ", desc: "安心と充実が日常になる" },
              { emoji: "🎯", title: "他力で夢が叶う", desc: "大きな夢が思いがけない流れで実現する" },
              { emoji: "🌍", title: "選択肢が広がる", desc: "場所も働き方も自由に選べる人生に" },
            ].map((item, i) => (
              <div
                key={i}
                className="p-6 rounded-2xl text-center transition-transform hover:-translate-y-1"
                style={{
                  backgroundColor: "var(--bg-card)",
                  border: "1px solid var(--border-secondary)",
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <div className="text-5xl mb-4">{item.emoji}</div>
                <h3 className="text-xl font-bold mb-3" style={{ color: "var(--text-primary)" }}>
                  {item.title}
                </h3>
                <p className="text-base opacity-80" style={{ color: "var(--text-secondary)" }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* プラン内容 */}
      <section className="px-6 py-20 md:py-24" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold text-center mb-4" style={{ color: "var(--text-primary)" }}>
            プラン内容
          </h2>
          <p className="text-center text-lg mb-12 opacity-70" style={{ color: "var(--text-secondary)" }}>
            月額9,800円で、これ全部つきます
          </p>
          <div className="space-y-6">
            {/* メイン特典 */}
            <div className="p-8 md:p-10 rounded-3xl"
                 style={{
                   background: "linear-gradient(135deg, #166534, #15803d)",
                   color: "white",
                 }}>
              <div className="flex items-start gap-5">
                <div className="text-5xl flex-shrink-0">🎙️</div>
                <div>
                  <div className="text-sm font-bold tracking-widest uppercase mb-2 opacity-80">⭐ MAIN ⭐</div>
                  <h3 className="text-2xl md:text-3xl font-bold mb-3">
                    三凛さとし直接 月1グループコーチング
                  </h3>
                  <p className="text-base md:text-lg leading-relaxed opacity-95 mb-4">
                    <strong className="text-yellow-200">ここが本命です。</strong>
                    成功と達成のディクシャからはじまり、
                    あなたの現実を堰き止めている内側のブロックに高い解像度で気づき、
                    その場で解消していくプロセス。<br /><br />
                    2025年5月から世界最先端の意識研究機関 oneness（インド）で
                    Sri Krishnaji・Sri Preethaji に師事した三凛が、1年間で実証した
                    「意識を本気で書き換える」ワークを月1で受けられます。
                  </p>
                  <div className="text-sm opacity-90 bg-white/10 px-4 py-2 rounded-lg inline-block">
                    💎 単発で受けたら数万円相当の価値
                  </div>
                </div>
              </div>
            </div>

            {/* AI コーチbot */}
            <div className="p-8 md:p-10 rounded-3xl"
                 style={{
                   backgroundColor: "var(--bg-card)",
                   border: "1px solid var(--border-secondary)",
                 }}>
              <div className="flex items-start gap-5">
                <div className="text-5xl flex-shrink-0">🤖</div>
                <div>
                  <h3 className="text-2xl md:text-3xl font-bold mb-3" style={{ color: "var(--text-primary)" }}>
                    24時間365日 AIコーチbot使い放題
                  </h3>
                  <p className="text-base md:text-lg leading-relaxed mb-4" style={{ color: "var(--text-secondary)" }}>
                    深夜2時の不安、朝の焦り、仕事中のイライラ。
                    その瞬間にAIコーチに話しかけてタッピングのお題を出してもらえる。
                    過去のチャット履歴も全部残るので、自分の変容の過程も振り返れます。
                  </p>
                  <ul className="space-y-2 text-base" style={{ color: "var(--text-secondary)" }}>
                    <li>✓ タッピングのお題出し（24時間いつでも）</li>
                    <li>✓ お金・豊かさのメンタルブロックの言語化</li>
                    <li>✓ 人生相談・お悩み相談</li>
                    <li>✓ 日々の感情と向き合う伴走者として</li>
                    <li>✓ 1日15回まで（実質無制限）</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* 既存コミュニティ価値 */}
            <div className="p-8 md:p-10 rounded-3xl"
                 style={{
                   backgroundColor: "var(--bg-card)",
                   border: "1px solid var(--border-secondary)",
                 }}>
              <div className="flex items-start gap-5">
                <div className="text-5xl flex-shrink-0">🌱</div>
                <div>
                  <h3 className="text-2xl md:text-3xl font-bold mb-3" style={{ color: "var(--text-primary)" }}>
                    継続だからこそ深まる変容
                  </h3>
                  <p className="text-base md:text-lg leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    意識の書き換えは「1回受けて終わり」ではありません。
                    毎月の積み重ねで、3ヶ月後、半年後、1年後の自分が
                    まったく別人のようになっていく。
                    タッピングと内省を毎日の習慣にして、
                    「悟った意識状態」「美しい意識状態」を日常に落とし込みます。
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 三凛さとし紹介 */}
      <section className="px-6 py-20 md:py-24" style={{ backgroundColor: "var(--bg-primary)" }}>
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold text-center mb-12" style={{ color: "var(--text-primary)" }}>
            講師：三凛さとし
          </h2>
          <div
            className="rounded-3xl p-8 md:p-12"
            style={{
              backgroundColor: "var(--bg-card)",
              border: "1px solid var(--border-secondary)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <div className="space-y-6 text-base md:text-lg leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              <p>
                ライフコーチ・作家として<strong style={{ color: "var(--text-primary)" }}>12年以上</strong>活動。
                世界4拠点（ポルトガル・マルタ・タイ・ドバイ）を転々としながら、
                SNSフォロワー合計<strong style={{ color: "var(--text-primary)" }}>約50万人</strong>、
                これまで<strong style={{ color: "var(--text-primary)" }}>数万人</strong>の人生変容に関わってきました。
              </p>
              <p>
                テレビ・雑誌・ラジオ・新聞での出演実績多数。
                お金の引き寄せ（金運）、親子関係、人間関係、仕事、健康と、
                人生の根幹に関わるテーマで発信しています。
                <strong style={{ color: "var(--text-primary)" }}>LINE占いの公認占い師</strong>でもあり、
                スピリチュアル・開運・自己啓発・心理学・占いと幅広い分野で活動。
              </p>
              <div className="my-8 p-6 rounded-2xl"
                   style={{
                     backgroundColor: "var(--accent-gold-soft)",
                     border: "1px solid rgba(200, 164, 21, 0.2)",
                   }}>
                <p className="font-bold mb-3" style={{ color: "var(--text-primary)" }}>
                  🌀 大きな転機：2024〜2026
                </p>
                <p>
                  2024年末、人工衛星打ち上げ事業をきっかけにSNSがプチ炎上、
                  事業も<strong>1億円の赤字</strong>。
                  そこから2025年5月、インドのoneness で Sri Krishnaji・Sri Preethaji に師事。
                  1年間学び続けた結果——
                </p>
                <p className="mt-4">
                  2026年4月、<strong style={{ color: "var(--text-primary)" }}>夢叶フェス</strong>を開催。
                  立ち上げから<strong>たった3週間</strong>で、
                  ユニーク<strong>2.3万人</strong>・リアルタイム視聴のべ<strong>5.3万人</strong>を動員。
                  <strong style={{ color: "var(--text-primary)" }}>日本の自己啓発業界では過去最大規模</strong>のフェスに。
                </p>
                <p className="mt-4">
                  仕事時間は半分以下、YouTubeもほぼ手放した。
                  でも売上と利益は増えた。
                  <strong style={{ color: "var(--text-primary)" }}>この変容の裏には、瞑想とタッピングがありました。</strong>
                </p>
              </div>
              <p>
                このプランは、その1年間で身体で実証してきた
                「意識の書き換え方」を、毎月のグループコーチングで直接伝えていく場です。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 実践者の声 */}
      <section className="px-6 py-20 md:py-24" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold text-center mb-4" style={{ color: "var(--text-primary)" }}>
            タッピング実践者の声
          </h2>
          <p className="text-center text-lg mb-12 opacity-70" style={{ color: "var(--text-secondary)" }}>
            内側を変えた人たちの「現実」がこちら
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            {[
              {
                name: "MIWAさん",
                badge: "底辺生活 → 月収22倍",
                story: "人前に出るのが苦手でしたが、メンタルブロックを外しミセスオブザイヤー2025グランプリ受賞！50万円のドレスを躊躇なく買える生活に。日本と世界を駆け巡る人生に。人脈にも恵まれて最高です ❤",
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
                story: "損保会社で我慢して働くOLから女性経営者になり、念願だった地元の県知事とお仕事まで実現！行動のスピードが圧倒的にUP。家族の協力も得られるように。若返りも実現しました ❤",
              },
            ].map((v, i) => (
              <div
                key={i}
                className="p-6 md:p-8 rounded-2xl"
                style={{
                  backgroundColor: "var(--bg-card)",
                  border: "1px solid var(--border-secondary)",
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <div className="inline-block px-4 py-1 rounded-full text-sm font-bold mb-4"
                     style={{
                       background: "linear-gradient(135deg, #ca8a04, #f59e0b)",
                       color: "white",
                     }}>
                  {v.badge}
                </div>
                <h3 className="text-xl font-bold mb-3" style={{ color: "var(--text-primary)" }}>
                  {v.name}
                </h3>
                <p className="text-base leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  「{v.story}」
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Q&A */}
      <section className="px-6 py-20 md:py-24" style={{ backgroundColor: "var(--bg-primary)" }}>
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold text-center mb-12" style={{ color: "var(--text-primary)" }}>
            よくある質問
          </h2>
          <div className="space-y-4">
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
                q: "AIコーチbotだけ使いたいのですが？",
                a: "このプランはbot＋月1のグループコーチングがセットです。本命は三凛との直接セッションなので、ぜひグループコーチングにもご参加ください。",
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
                q: "365日のbot利用権を持っていますが、サブスクと併用できますか？",
                a: "はい、365日の利用権がある間はそのまま使い続けられます。365日経過後はサブスクに加入していれば継続利用できます。",
              },
            ].map((item, i) => (
              <details
                key={i}
                className="rounded-2xl overflow-hidden"
                style={{
                  backgroundColor: "var(--bg-card)",
                  border: "1px solid var(--border-secondary)",
                }}
              >
                <summary className="cursor-pointer p-6 font-bold text-lg flex items-start justify-between gap-4 hover:opacity-80"
                         style={{ color: "var(--text-primary)" }}>
                  <span>Q. {item.q}</span>
                  <span className="text-2xl flex-shrink-0">+</span>
                </summary>
                <div className="px-6 pb-6 text-base leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  A. {item.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA再掲 */}
      <section
        className="px-6 py-20 md:py-28 text-center text-white"
        style={{
          background: "linear-gradient(135deg, #166534 0%, #15803d 50%, #ca8a04 100%)",
        }}
      >
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold mb-6 leading-tight">
            あなたの人生は、<br />
            あなたの意識でできている。
          </h2>
          <p className="text-lg md:text-xl mb-10 opacity-95 leading-relaxed">
            意識を変えれば、現実は雪崩のように変わる。<br />
            その瞬間を、月1のセッションとAIコーチで一緒に作ろう。
          </p>
          <div className="inline-block bg-white text-gray-900 rounded-2xl p-6 md:p-8 shadow-2xl mb-8">
            <div className="text-5xl md:text-6xl font-bold mb-1" style={{ color: "#15803d" }}>
              ¥9,800
            </div>
            <div className="text-sm opacity-70">/ 月（税込）・いつでも解約OK</div>
          </div>
          <div>
            {subscribeUrl ? (
              <a
                href={subscribeUrl}
                className="inline-block px-12 py-5 rounded-full font-bold text-xl text-white transition-all duration-200 hover:scale-105"
                style={{
                  background: "linear-gradient(135deg, #ca8a04, #f59e0b)",
                  boxShadow: "0 8px 24px rgba(202, 138, 4, 0.5)",
                }}
              >
                今すぐ加入する →
              </a>
            ) : (
              <div className="bg-red-500/20 border border-red-300 rounded-xl px-6 py-4 text-base inline-block">
                ⚠ 申込URL準備中。
              </div>
            )}
          </div>
          <p className="text-sm mt-6 opacity-80">
            初月から月額9,800円・1ヶ月毎課金・決済日の7日前までの解約で次月課金停止
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-6 py-10 text-center text-sm" style={{ color: "var(--text-muted)", backgroundColor: "var(--bg-secondary)" }}>
        <a href="/login" className="underline hover:opacity-80">← ログインに戻る</a>
        <p className="mt-4 opacity-70">
          © 三凛さとし / MONTHLY LIFE COACHING
        </p>
      </footer>
    </div>
  );
}
