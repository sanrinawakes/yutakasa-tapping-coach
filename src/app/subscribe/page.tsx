"use client";

/**
 * MONTHLY LIFE COACHING 加入LP v5
 * セールスレター形式：Word風シンプルレイアウト・黒/赤/青の3色・縦長で読みやすく
 */
export default function SubscribePage() {
  const subscribeUrl = process.env.NEXT_PUBLIC_SUBSCRIPTION_LANDING_URL || "";

  return (
    <article
      style={{
        backgroundColor: "#ffffff",
        color: "#111111",
        fontFamily: "'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif",
        lineHeight: 1.9,
        fontSize: "17px",
      }}
    >
      <div style={{ maxWidth: "720px", margin: "0 auto", padding: "60px 24px" }}>

        {/* タイトル */}
        <header style={{ textAlign: "center", marginBottom: "60px" }}>
          <p style={{ fontSize: "13px", letterSpacing: "0.3em", color: "#888", marginBottom: "30px", fontWeight: "bold" }}>
            ━ MONTHLY LIFE COACHING ━
          </p>
          <h1 style={{
            fontSize: "32px",
            fontWeight: "bold",
            lineHeight: 1.5,
            color: "#c00000",
            marginBottom: "30px",
            textAlign: "center",
          }}>
            頑張らなくても、<br />
            豊かさが流れこむ人生へ。
          </h1>
          <p style={{ fontSize: "16px", color: "#444", lineHeight: 2 }}>
            三凛さとしの月1グループコーチング × 24時間頼れるAIコーチbot<br />
            意識を本気で書き換えて、現実をひっくり返す月額プラン
          </p>
        </header>

        <Hr />

        {/* 共感パート */}
        <section style={{ marginBottom: "60px" }}>
          <p>こんにちは、三凛さとしです。</p>

          <p style={{ marginTop: "1.5em" }}>
            このページを開いてくださったあなたは、きっと今、<br />
            こんな思いを抱えているのではないでしょうか。
          </p>

          <ul style={{ marginTop: "2em", marginBottom: "2em", paddingLeft: 0, listStyle: "none" }}>
            {[
              "頑張っているのに、なかなか報われない",
              "お金や豊かさに対して、どこかブロックを感じる",
              "夢はあるけど、なかなか前に進めない",
              "なんとなく不安と焦りがあって、心から安心できない",
              "意識を本当に変えて、人生そのものを変えたい",
            ].map((s, i) => (
              <li key={i} style={{ marginBottom: "0.6em", paddingLeft: "1.5em", textIndent: "-1.5em" }}>
                <span style={{ color: "#c00000", fontWeight: "bold" }}>□</span>　{s}
              </li>
            ))}
          </ul>

          <p>
            ひとつでも当てはまったあなたへ、<br />
            <strong style={{ color: "#c00000" }}>このプランは、あなたのためのものです。</strong>
          </p>
        </section>

        <Hr />

        {/* なぜタッピング+月1セッションが効くのか */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: "#c00000", textAlign: "center", marginBottom: "40px", lineHeight: 1.5 }}>
            なぜ、意識を変えると<br />
            人生が雪崩のように動き出すのか？
          </h2>

          <p>
            実は私自身、2024年末に大きな挫折を経験しました。
          </p>
          <p style={{ marginTop: "1em" }}>
            人工衛星の打ち上げ事業をきっかけにSNSがプチ炎上、<br />
            事業は<strong style={{ color: "#c00000" }}>1億円の赤字</strong>。
          </p>
          <p style={{ marginTop: "1em" }}>
            「もうダメかもしれない」<br />
            そう思った時期も、正直ありました。
          </p>

          <p style={{ marginTop: "2em" }}>
            そこから2025年5月、私はインドへ渡りました。
          </p>
          <p style={{ marginTop: "1em" }}>
            世界最先端の意識研究機関「<strong>oneness</strong>」で、<br />
            <strong>Sri Krishnaji</strong>と<strong>Sri Preethaji</strong>に師事するためです。
          </p>

          <p style={{ marginTop: "2em" }}>
            そして1年間、毎日のように<br />
            <strong style={{ color: "#c00000" }}>瞑想</strong>と<strong style={{ color: "#c00000" }}>タッピング</strong>を続けながら、<br />
            自分の内側のブロックと向き合いました。
          </p>

          <p style={{ marginTop: "2em" }}>
            すると、何が起きたか——
          </p>

          <ul style={{ marginTop: "1.5em", marginBottom: "1.5em", paddingLeft: 0, listStyle: "none" }}>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ 仕事する時間は<strong>半分以下</strong>に
            </li>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ YouTubeもほぼ手放した
            </li>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ それなのに、<strong style={{ color: "#c00000" }}>売上も利益も増えた</strong>
            </li>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ 2026年4月、立ち上げから<strong>たった3週間</strong>で<br />
              　<strong style={{ color: "#c00000" }}>夢叶フェス（ユニーク2.3万人・延べ5.3万人動員）</strong>を実現
            </li>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ 日本の自己啓発業界では<strong>過去最大規模</strong>のフェスに
            </li>
          </ul>

          <p style={{ marginTop: "2em" }}>
            正直、自分でも信じられないくらいの変化でした。
          </p>
          <p style={{ marginTop: "1em" }}>
            <strong style={{ color: "#c00000" }}>そしてこの変容の裏には、</strong><br />
            <strong style={{ color: "#c00000" }}>瞑想とタッピングがありました。</strong>
          </p>

          <p style={{ marginTop: "2em" }}>
            意識を本気で書き換える。<br />
            内側の苦しみ（不安、恐怖、焦り、怒り、悲しみ、傷つき）と<br />
            日々ちゃんと向き合う。
          </p>
          <p style={{ marginTop: "1em" }}>
            これさえできれば、<strong>現実は本当に変わる</strong>のです。
          </p>
        </section>

        <Hr />

        {/* 講師紹介 */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: "#c00000", textAlign: "center", marginBottom: "40px", lineHeight: 1.5 }}>
            講師：三凛さとし
          </h2>

          <div style={{ textAlign: "center", marginBottom: "30px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/satoshi-profile.jpg"
              alt="三凛さとし"
              style={{
                maxWidth: "320px",
                width: "100%",
                borderRadius: "8px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
              }}
            />
          </div>

          <p>
            改めまして、<strong>三凛さとし</strong>と申します。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            今は世界4拠点生活で、<br />
            ポルトガル・マルタ・タイ・ドバイを転々としながら、<br />
            <strong>ライフコーチ・作家として12年以上</strong>活動しています。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            SNSのフォロワーは合計<strong style={{ color: "#c00000" }}>約50万人</strong>、<br />
            これまで<strong style={{ color: "#c00000" }}>数万人</strong>の方の人生変容に関わらせていただきました。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            テレビ・雑誌・ラジオ・新聞でも取り上げていただき、<br />
            主にお金の引き寄せ（金運）の話、<br />
            親子関係や人間関係、お仕事、健康といった<br />
            人生において大切なテーマで発信しています。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            <strong>LINE占いの公認占い師</strong>でもあります。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            スピリチュアル、開運、自己啓発、心理学、占い——<br />
            幅広い分野で活動している人間です。
          </p>
        </section>

        <Hr />

        {/* 実践者の声 */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: "#c00000", textAlign: "center", marginBottom: "20px", lineHeight: 1.5 }}>
            タッピング実践者の声
          </h2>
          <p style={{ textAlign: "center", color: "#666", marginBottom: "50px" }}>
            内側を変えた人たちの「現実」がこちら
          </p>

          {[
            {
              photo: "/testimonials/miwa.jpg",
              name: "MIWAさん",
              headline: "底辺生活から月収22倍！豊かさと美を両方手に入れました",
              story: "人前に出るのが苦手でしたが、メンタルブロックを外して、ミセスオブザイヤー2025グランプリを受賞することができました。今では50万円のドレスを躊躇なく買える生活に。日本と世界を駆け巡る人生になり、人脈にも恵まれて最高です。",
            },
            {
              photo: "/testimonials/yuta.jpg",
              name: "ゆうたさん",
              headline: "借金6,000万円から年商1億円超え！彼女もできました",
              story: "パワハラに悩まされた介護士時代、当時の婚約者に婚約破棄もされました。タッピングに出会って三凛さんから直接指導を受け、売れっ子カウンセラー兼発信者になりました。",
            },
            {
              photo: "/testimonials/usagi.jpg",
              name: "うさぎさん",
              headline: "限界OLから年収3,500万円！月1で海外へ",
              story: "コロナ禍に副業講座に複数チャレンジするも、次々挫折しました。2021年にタッピングに出会い、「稼ぐことへのメンタルブロック」に集中して取り組んだ結果、収入は10倍になりました。",
            },
            {
              photo: "/testimonials/yoshida.jpg",
              name: "よしだりよさん",
              headline: "パン屋さんのパートからカウンセラーへ！月収5倍",
              story: "自分責めが減り、感謝してお金を受け取れるようになりました。念願だった東京の一等地に引っ越しました。家族との関係もかなり良くなりました。",
            },
            {
              photo: "/testimonials/tamura.jpg",
              name: "田村望さん（51歳）",
              headline: "我慢して働くOLから女性経営者へ！県知事とお仕事も",
              story: "損保会社で我慢して働くOLから、女性経営者になりました。念願だった地元の県知事とのお仕事も実現！行動のスピードが圧倒的にUPし、自分の大好きな仕事で起業できて幸せです。家族の協力も得られるように、若返りも実現しました。",
            },
          ].map((v, i) => (
            <div key={i} style={{
              marginBottom: "50px",
              paddingBottom: "40px",
              borderBottom: i < 4 ? "1px dashed #ddd" : "none",
            }}>
              <div style={{ textAlign: "center", marginBottom: "20px" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={v.photo}
                  alt={v.name}
                  style={{
                    maxWidth: "240px",
                    width: "100%",
                    borderRadius: "8px",
                  }}
                />
              </div>
              <p style={{
                fontSize: "20px",
                fontWeight: "bold",
                color: "#c00000",
                textAlign: "center",
                marginBottom: "16px",
                lineHeight: 1.6,
              }}>
                「{v.headline}」
              </p>
              <p style={{ marginBottom: "0.8em" }}>
                {v.story}
              </p>
              <p style={{ textAlign: "right", color: "#666", fontSize: "15px" }}>
                — {v.name}
              </p>
            </div>
          ))}

          <p style={{ marginTop: "30px" }}>
            こうした変化は、特別な人だけに起こるものではありません。
          </p>
          <p style={{ marginTop: "1em" }}>
            <strong style={{ color: "#c00000" }}>意識を本気で書き換えれば、</strong><br />
            <strong style={{ color: "#c00000" }}>誰の人生にも、こうした変化は起こります。</strong>
          </p>
        </section>

        <Hr />

        {/* プラン内容 */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: "#c00000", textAlign: "center", marginBottom: "40px", lineHeight: 1.5 }}>
            このプランで得られる<br />
            ふたつの大きな価値
          </h2>

          <h3 style={{ fontSize: "22px", fontWeight: "bold", color: "#c00000", marginTop: "40px", marginBottom: "20px" }}>
            ① 三凛さとし直接の月1グループコーチング
          </h3>
          <p>
            <strong style={{ color: "#c00000" }}>このプランの本命がこちらです。</strong>
          </p>
          <p style={{ marginTop: "1em" }}>
            毎月のセッションで、<br />
            成功と達成のディクシャからはじまり、<br />
            あなたの現実を堰き止めている内側のブロックに<br />
            高い解像度で気づき、その場で解消していくプロセスを行います。
          </p>
          <p style={{ marginTop: "1em" }}>
            私が1年間、インドのonenessで学び、身体で実証してきた<br />
            「意識の書き換え方」を、毎月の場で直接お伝えします。
          </p>
          <p style={{ marginTop: "1em" }}>
            <strong>単発で受けたら数万円相当の価値</strong>のあるセッションを、<br />
            このプランに加入していただければ毎月受けられます。
          </p>

          <h3 style={{ fontSize: "22px", fontWeight: "bold", color: "#c00000", marginTop: "50px", marginBottom: "20px" }}>
            ② 24時間365日 AIコーチbot使い放題
          </h3>
          <p>
            深夜2時の不安。<br />
            朝の焦り。<br />
            仕事中のイライラ。
          </p>
          <p style={{ marginTop: "1em" }}>
            その瞬間に、AIコーチに話しかけて、<br />
            タッピングのお題を出してもらえます。
          </p>
          <p style={{ marginTop: "1em" }}>
            過去の会話履歴も全部残るので、<br />
            自分の変容の過程を振り返ることもできます。
          </p>

          <p style={{ marginTop: "1.5em", marginBottom: "0.8em" }}><strong>具体的にこんなことができます：</strong></p>
          <ul style={{ paddingLeft: "1.5em", marginTop: 0 }}>
            <li>タッピングのお題出し（24時間いつでも）</li>
            <li>お金・豊かさのメンタルブロックの言語化</li>
            <li>人生相談・お悩み相談</li>
            <li>過去のチャット履歴がそのまま残る</li>
            <li>🎤 音声入力にも対応（マイクで話しかけられる）</li>
            <li>1日15回まで（実質無制限）</li>
          </ul>

          <p style={{ marginTop: "2em" }}>
            意識の書き換えは、月1のセッションだけでは深まりません。
          </p>
          <p style={{ marginTop: "1em" }}>
            <strong style={{ color: "#c00000" }}>毎日の積み重ねが、変容を生みます。</strong>
          </p>
          <p style={{ marginTop: "1em" }}>
            だからこそ、月1の直接セッションと、<br />
            24時間頼れるAIコーチbotを<br />
            <strong>セットでご提供しています。</strong>
          </p>
        </section>

        <Hr />

        {/* 価格 */}
        <section style={{ marginBottom: "60px", textAlign: "center" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: "#c00000", marginBottom: "30px", lineHeight: 1.5 }}>
            気になる料金は？
          </h2>

          <p>
            これだけの内容を含んだプランの料金は——
          </p>

          <div style={{
            margin: "30px auto",
            padding: "40px 30px",
            border: "3px double #c00000",
            borderRadius: "8px",
            display: "inline-block",
            textAlign: "center",
          }}>
            <p style={{ fontSize: "16px", color: "#888", marginBottom: "10px" }}>月額</p>
            <p style={{ fontSize: "56px", fontWeight: "bold", color: "#c00000", lineHeight: 1, marginBottom: "10px" }}>
              ¥9,800
            </p>
            <p style={{ fontSize: "14px", color: "#666" }}>（税込）／ 月</p>
          </div>

          <p style={{ marginTop: "20px" }}>
            1日あたり、たった<strong style={{ color: "#c00000" }}>320円</strong>。
          </p>
          <p style={{ marginTop: "1em" }}>
            毎日のスタバ1杯分よりも安い金額で、<br />
            あなたの人生そのものを書き換えるサポートが受けられます。
          </p>
        </section>

        <Hr />

        {/* 安心ポイント */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: "#c00000", textAlign: "center", marginBottom: "30px", lineHeight: 1.5 }}>
            安心して始めていただくために
          </h2>

          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: "#c00000" }}>◆ いつでも解約できます</strong><br />
            ネットからいつでも解約可能。引き留めや解約理由のヒアリングも一切ありません。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: "#c00000" }}>◆ 違約金は一切ありません</strong><br />
            お試しで1ヶ月だけ受けてみて、合わなければ解約、で全くOKです。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: "#c00000" }}>◆ 解約は決済日の7日前までに</strong><br />
            決済日の7日前までに解約手続きをいただければ、次回の決済は走りません。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: "#c00000" }}>◆ 海外在住でも参加OK</strong><br />
            グループコーチングはオンライン開催。AIコーチbotもブラウザがあればどこからでも使えます。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: "#c00000" }}>◆ タッピング初心者でも大丈夫</strong><br />
            AIコーチがあなたのレベルに合わせてお題を出してくれます。月1のセッションでも基礎から丁寧にお伝えします。
          </p>
        </section>

        <Hr />

        {/* 既存ユーザー向け案内（青字） */}
        <section style={{
          marginBottom: "60px",
          padding: "30px",
          backgroundColor: "#f0f7ff",
          border: "2px solid #1d4ed8",
          borderRadius: "8px",
        }}>
          <h3 style={{ color: "#1d4ed8", fontSize: "18px", fontWeight: "bold", marginBottom: "16px" }}>
            ※ すでに「豊かさタッピング」をご受講中の方へ
          </h3>
          <p style={{ color: "#1d4ed8" }}>
            ご購入から<strong>365日以内</strong>の方は、このプランへのご加入なしで、AIコーチbotをそのままご利用いただけます。
          </p>
          <p style={{ color: "#1d4ed8", marginTop: "1em" }}>
            MyASPにご登録のメールアドレスで、<a href="/login" style={{ color: "#1d4ed8", textDecoration: "underline", fontWeight: "bold" }}>ログインページ</a>からそのままログインしてください。
          </p>
          <p style={{ color: "#1d4ed8", marginTop: "1em" }}>
            365日経過後も継続したい方、毎月の三凛グループコーチングを受けたい方は、ぜひこのプランへのご加入をご検討ください。
          </p>
        </section>

        <Hr />

        {/* 追伸 */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "22px", fontWeight: "bold", color: "#c00000", marginBottom: "30px" }}>
            追伸
          </h2>

          <p>
            最後まで読んでくださって、ありがとうございます。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            私自身、人生の中で本当に大きな挫折を経験して、<br />
            「もう全部終わった」と思った時期もありました。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            でもそこから、<strong>意識を本気で書き換える</strong>ことで、<br />
            たった1年で、<br />
            人生はまったく違う景色に変わりました。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            この変化を、ひとりでも多くの方に体験していただきたい。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: "#c00000" }}>あなたの人生は、あなたの意識でできています。</strong>
          </p>
          <p style={{ marginTop: "1.2em" }}>
            意識を変えれば、現実は雪崩のように変わります。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            その瞬間を、月1のセッションとAIコーチで、<br />
            私と一緒につくっていきましょう。
          </p>
          <p style={{ marginTop: "2em", textAlign: "right" }}>
            三凛さとし
          </p>
        </section>

        <Hr />

        {/* 最終CTA */}
        <section style={{ textAlign: "center", marginBottom: "40px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: "#c00000", marginBottom: "30px", lineHeight: 1.5 }}>
            さあ、はじめましょう。
          </h2>
          <p style={{ marginBottom: "30px" }}>
            人生を書き換える1ヶ月目を、今日からスタート。
          </p>

          {subscribeUrl ? (
            <a
              href={subscribeUrl}
              style={{
                display: "inline-block",
                padding: "20px 60px",
                fontSize: "20px",
                fontWeight: "bold",
                color: "#fff",
                backgroundColor: "#c00000",
                borderRadius: "8px",
                textDecoration: "none",
                boxShadow: "0 4px 12px rgba(192, 0, 0, 0.3)",
              }}
            >
              月¥9,800で加入する →
            </a>
          ) : (
            <div style={{ padding: "20px", backgroundColor: "#fef2f2", color: "#c00000", borderRadius: "8px", display: "inline-block" }}>
              ⚠ 申込URL準備中
            </div>
          )}

          <p style={{ marginTop: "20px", fontSize: "14px", color: "#666" }}>
            月額9,800円（税込）・初月から課金・1ヶ月毎・いつでも解約OK
          </p>
        </section>

        <Hr />

        {/* Footer */}
        <footer style={{ textAlign: "center", color: "#888", fontSize: "14px", paddingTop: "20px" }}>
          <p>
            <a href="/login" style={{ color: "#1d4ed8", textDecoration: "underline" }}>ログインページへ</a>
          </p>
          <p style={{ marginTop: "16px" }}>© 三凛さとし · MONTHLY LIFE COACHING</p>
        </footer>

      </div>
    </article>
  );
}

function Hr() {
  return (
    <hr style={{
      border: "none",
      borderTop: "1px solid #ddd",
      margin: "60px 0",
      width: "60%",
      marginLeft: "auto",
      marginRight: "auto",
    }} />
  );
}
