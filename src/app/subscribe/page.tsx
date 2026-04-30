"use client";

/**
 * MONTHLY LIFE COACHING 加入LP v6
 * ユーザー指示反映版：青字基調、ゴールドアクセント、僕一人称、Krishnaji画像
 */
export default function SubscribePage() {
  const subscribeUrl = process.env.NEXT_PUBLIC_SUBSCRIPTION_LANDING_URL || "";

  // 色定義
  const C = {
    text: "#111111",
    sub: "#444444",
    muted: "#888888",
    blue: "#1d4ed8",      // メインアクセント
    blueDeep: "#1e3a8a",  // 強調
    blueSoft: "#eff6ff",  // パネル背景
    red: "#c00000",        // 緊急時のみ
    gold: "#ca8a04",
    goldLight: "#f59e0b",
    line: "#dddddd",
  };

  return (
    <article
      style={{
        backgroundColor: "#ffffff",
        color: C.text,
        fontFamily: "'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif",
        lineHeight: 1.9,
        fontSize: "17px",
      }}
    >
      <div style={{ maxWidth: "720px", margin: "0 auto", padding: "60px 24px" }}>

        {/* タイトル */}
        <header style={{ textAlign: "center", marginBottom: "60px" }}>
          <p style={{ fontSize: "13px", letterSpacing: "0.3em", color: C.muted, marginBottom: "30px", fontWeight: "bold" }}>
            ━ MONTHLY LIFE COACHING ━
          </p>
          <h1 style={{
            fontSize: "32px",
            fontWeight: "bold",
            lineHeight: 1.55,
            color: C.blue,
            marginBottom: "30px",
            textAlign: "center",
          }}>
            頑張らなくても豊かさが流れこむ<br />
            <span style={{
              background: `linear-gradient(90deg, ${C.gold}, ${C.goldLight})`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              fontSize: "1.15em",
              letterSpacing: "0.04em",
            }}>
              意識のステージ
            </span>
            へ。
          </h1>
          <p style={{ fontSize: "16px", color: C.sub, lineHeight: 2 }}>
            三凛さとしの月1グループコーチング × 24時間頼れる「幸せなお金引き寄せbot」<br />
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
                <span style={{ color: C.blue, fontWeight: "bold" }}>□</span>　{s}
              </li>
            ))}
          </ul>

          <p>
            ひとつでも当てはまったあなたへ、<br />
            <strong style={{ color: C.blue }}>このプランは、あなたのためのものです。</strong>
          </p>
        </section>

        <Hr />

        {/* 僕のストーリー */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: C.blue, textAlign: "center", marginBottom: "40px", lineHeight: 1.5 }}>
            なぜ、意識を変えると<br />
            人生が雪崩のように動き出すのか？
          </h2>

          <p>
            実は僕自身、2024年末に大きな挫折を経験しました。
          </p>
          <p style={{ marginTop: "1em" }}>
            人工衛星の打ち上げ事業をきっかけにSNSがプチ炎上、<br />
            事業は<strong>1億円の赤字</strong>。
          </p>
          <p style={{ marginTop: "1em" }}>
            「もうダメかもしれない」<br />
            そう思った時期も、正直ありました。
          </p>

          <p style={{ marginTop: "2em" }}>
            そこから2025年5月、僕はインドへ渡りました。
          </p>
          <p style={{ marginTop: "1em" }}>
            世界最先端の意識研究機関「<strong>oneness</strong>」で、<br />
            <strong>Sri Krishnaji</strong>と<strong>Sri Preethaji</strong>に師事するためです。
          </p>

          {/* Krishnaji & Preethaji 写真 */}
          <figure style={{ margin: "32px 0", textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/krishnaji-preethaji.jpg"
              alt="Sri Krishnaji と Sri Preethaji"
              style={{ maxWidth: "100%", borderRadius: "8px", boxShadow: "0 4px 16px rgba(0,0,0,0.1)" }}
            />
            <figcaption style={{ fontSize: "13px", color: C.muted, marginTop: "8px" }}>
              師である Sri Krishnaji と Sri Preethaji
            </figcaption>
          </figure>

          <p style={{ marginTop: "2em" }}>
            学びの場は、世界中の意識探求者が集う<br />
            インド・<strong>ekam キャンパス</strong>。
          </p>

          {/* ekamキャンパス画像 */}
          <figure style={{ margin: "32px 0", textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/ekam-campus.jpg"
              alt="ekam キャンパス"
              style={{ maxWidth: "100%", borderRadius: "8px", boxShadow: "0 4px 16px rgba(0,0,0,0.1)" }}
            />
            <figcaption style={{ fontSize: "13px", color: C.muted, marginTop: "8px" }}>
              インド・ekam キャンパス
            </figcaption>
          </figure>

          <p style={{ marginTop: "2em" }}>
            そして1年間、毎日、<br />
            <strong>瞑想</strong>と<strong>タッピング</strong>を続けながら、<br />
            自分の内側のブロックと向き合いました。
          </p>

          <p style={{ marginTop: "2em" }}>
            すると——
          </p>

          <ul style={{ marginTop: "1.5em", marginBottom: "1.5em", paddingLeft: 0, listStyle: "none" }}>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ 仕事する時間は<strong>半分以下</strong>に
            </li>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ YouTubeもほぼ手放し<strong>暇人に</strong>
            </li>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ それなのに、<strong style={{ color: C.blue }}>売上も利益も増えた</strong>
            </li>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ 2026年4月、立ち上げから<strong>たった3週間</strong>で<br />
              　<strong style={{ color: C.blue }}>夢叶フェス（登録2.3万人・延べ5.3万人動員）</strong>を実現
            </li>
            <li style={{ marginBottom: "0.5em" }}>
              ✓ 日本の自己啓発業界では<strong>過去最大規模</strong>のフェスになり、<strong>ニュースにも取り上げられる</strong>
            </li>
          </ul>

          <p style={{ marginTop: "2em" }}>
            大きく変わったのは、<br />
            <strong style={{ color: C.blue }}>自分が必死で動いてないのに、まわりが勝手に動いてくれて、大きな成果があがるようになったこと</strong>。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            自分が忙しくなることなく、<br />
            必要な展開や協力を得て、<br />
            思ってもみなかった恩恵に恵まれる——<br />
            そういう人生のステージに移ったのです。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: C.blue }}>自分は苦労もせず、何かに抗うこともなく、</strong><br />
            <strong style={{ color: C.blue }}>でも人間離れした結果が出る。</strong>
          </p>
          <p style={{ marginTop: "1.2em" }}>
            これこそが、<br />
            三凛コーチングのテーマでありコンセプトです。
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

        {/* 実践者の声 */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: C.blue, textAlign: "center", marginBottom: "20px", lineHeight: 1.5 }}>
            タッピング実践者の声
          </h2>
          <p style={{ textAlign: "center", color: C.muted, marginBottom: "50px" }}>
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
              borderBottom: i < 4 ? `1px dashed ${C.line}` : "none",
            }}>
              <div style={{ textAlign: "center", marginBottom: "20px" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={v.photo}
                  alt={v.name}
                  style={{ maxWidth: "240px", width: "100%", borderRadius: "8px" }}
                />
              </div>
              <p style={{
                fontSize: "20px",
                fontWeight: "bold",
                color: C.blue,
                textAlign: "center",
                marginBottom: "16px",
                lineHeight: 1.6,
              }}>
                「{v.headline}」
              </p>
              <p style={{ marginBottom: "0.8em" }}>{v.story}</p>
              <p style={{ textAlign: "right", color: C.muted, fontSize: "15px" }}>— {v.name}</p>
            </div>
          ))}

          <p style={{ marginTop: "30px" }}>
            こうした変化は、特別な人だけに起こるものではありません。
          </p>
          <p style={{ marginTop: "1em" }}>
            <strong style={{ color: C.blue }}>意識状態を正しく調整すれば、</strong><br />
            <strong style={{ color: C.blue }}>誰の人生にも、奇跡のような変容が起こります。</strong>
          </p>
        </section>

        <Hr />

        {/* プラン内容 */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: C.blue, textAlign: "center", marginBottom: "40px", lineHeight: 1.5 }}>
            このプランで得られる<br />
            4つの大きな価値
          </h2>

          {/* ① 三凛コーチング */}
          <h3 style={{ fontSize: "22px", fontWeight: "bold", color: C.blue, marginTop: "40px", marginBottom: "20px" }}>
            ① 三凛さとし直接の月1グループコーチング
          </h3>
          <p>
            <strong style={{ color: C.blue }}>このプランの本命がこちらです。</strong>
          </p>
          <p style={{ marginTop: "1em" }}>
            毎月毎回、<strong>特定の苦しみ</strong>（不安、恐怖、怒り、悲しみ、焦りなど）に視点をあてて、次のセッションまでの1ヶ月間で、どんな苦しみ・感情をタッピングしていくかをレクチャーします。
          </p>
          <p style={{ marginTop: "1em" }}>
            参加者どうしのシェアも交えながら、毎月、ネガティブ感情を綺麗さっぱり掃除していきます。
          </p>
          <p style={{ marginTop: "1em" }}>
            地味に思えるかもしれません。
          </p>
          <p style={{ marginTop: "1em" }}>
            でも、<strong>僕が毎回1,000〜1,500万円かけて参加している oneness の合宿でも、やることは同じ</strong>です。
          </p>
          <p style={{ marginTop: "1em" }}>
            ただひたすら苦しみを見つけて解消していく——<br />
            これだけ。
          </p>
          <p style={{ marginTop: "1em" }}>
            結局これをやらずに、<br />
            いくら外側の行動を変えたり、思考法を学んでも、<br />
            苦しみが消えないので人生は楽にも豊かにもなりません。
          </p>
          <p style={{ marginTop: "1em" }}>
            <strong style={{ color: C.blue }}>美しい意識状態 ＝ 素晴らしい引き寄せが起きる状態</strong>。<br />
            その美しい意識状態に近づいていくための、毎月のコーチングです。
          </p>

          {/* 開催スケジュール */}
          <div style={{
            marginTop: "30px",
            padding: "24px 28px",
            backgroundColor: C.blueSoft,
            border: `1px solid ${C.blue}`,
            borderRadius: "8px",
          }}>
            <p style={{ fontWeight: "bold", color: C.blue, marginBottom: "12px" }}>
              ◆ 開催スケジュール
            </p>
            <ul style={{ paddingLeft: "1.5em", margin: 0, color: C.text }}>
              <li style={{ marginBottom: "0.5em" }}>
                <strong>毎月 第4金曜日 20:00〜</strong>（オンラインZoom開催）
              </li>
              <li style={{ marginBottom: "0.5em" }}>
                Zoom URLは <strong>前日まで</strong>にご登録のメールアドレスへお送りします
              </li>
              <li style={{ marginBottom: "0.5em" }}>
                第3金曜日など別日に変更となる場合は <strong>前月までに</strong> ご連絡します
              </li>
              <li style={{ marginBottom: "0.5em" }}>
                欠席される場合、<strong>前日までにご連絡</strong>いただければ、<strong style={{ color: C.gold }}>年1回まで返金対応</strong>いたします
              </li>
            </ul>
          </div>

          {/* ② 成功と達成のディクシャ */}
          <h3 style={{ fontSize: "22px", fontWeight: "bold", color: C.blue, marginTop: "50px", marginBottom: "20px" }}>
            ② 成功と達成のディクシャ
          </h3>
          <p>
            これは本来、<strong>1,200万円・14日間</strong>かけないと習得できない、<br />
            <strong>現実面での豊かさを引き寄せる脳波に書き換えるエネルギーワーク</strong>です。
          </p>
          <p style={{ marginTop: "1em" }}>
            毎月のコーチング冒頭でこのディクシャを行います。
          </p>
          <p style={{ marginTop: "1em" }}>
            あなたの脳波が、<br />
            <strong>豊かさを引き寄せる状態</strong>へと整えられていきます。
          </p>

          {/* ③ Krishnajiの祝福（青枠で目立たせる） */}
          <div style={{
            marginTop: "50px",
            marginBottom: "30px",
            padding: "30px",
            backgroundColor: C.blueSoft,
            border: `2px solid ${C.blue}`,
            borderRadius: "8px",
          }}>
            <p style={{ fontSize: "13px", letterSpacing: "0.2em", color: C.gold, fontWeight: "bold", marginBottom: "12px" }}>
              ★ 本日中のお申込み限定 ★
            </p>
            <h3 style={{ fontSize: "22px", fontWeight: "bold", color: C.blue, marginBottom: "20px" }}>
              ③ Sri Krishnaji からの祝福エネルギー
            </h3>
            <p>
              僕の師であり、今、世界のスピリチュアルにおいて<br />
              <strong>最も影響力のある悟った聖者</strong>——<br />
              それが<strong>Sri Krishnaji</strong>。
            </p>
            <p style={{ marginTop: "1em" }}>
              僕は年に3〜4回、<br />
              毎回数千万円を払って Krishnaji に直接会いに行っています。
            </p>
            <p style={{ marginTop: "1em" }}>
              そこでは毎回、<strong>3つの願い事</strong>をお願いできます。
            </p>
            <p style={{ marginTop: "1em" }}>
              そのうちの<strong>1回</strong>を実は使って、<br />
              この毎月の三凛コーチングについても認識してもらっていて、<br />
              うちの口座やサービスすべてを祝福してもらっています。
            </p>
            <p style={{ marginTop: "1em" }}>
              そして、<strong style={{ color: C.gold }}>当日中にお申込みいただいた方</strong>に関しては、<br />
              <strong>Sri Krishnaji からも祝福していただける</strong>ようにしています。
            </p>
            <p style={{ marginTop: "1em", fontSize: "15px", color: C.sub }}>
              これは値段がつけられない価値です。<br />
              本日中にご決断いただいた方だけの特典になります。
            </p>
          </div>

          {/* ④ 幸せなお金引き寄せbot */}
          <h3 style={{ fontSize: "22px", fontWeight: "bold", color: C.blue, marginTop: "50px", marginBottom: "20px" }}>
            ④ 24時間365日「幸せなお金引き寄せbot」使い放題
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
            <strong style={{ color: C.blue }}>毎日の積み重ねが、変容を生みます。</strong>
          </p>
          <p style={{ marginTop: "1em" }}>
            だからこそ、月1の直接セッションと、<br />
            24時間頼れる「幸せなお金引き寄せbot」を<br />
            <strong>セットでご提供しています。</strong>
          </p>
        </section>

        <Hr />

        {/* 価格 */}
        <section style={{ marginBottom: "60px", textAlign: "center" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: C.blue, marginBottom: "30px", lineHeight: 1.5 }}>
            気になる料金は？
          </h2>

          <p>これだけの内容を含んだプランの料金は——</p>

          <div style={{
            margin: "30px auto",
            padding: "40px 30px",
            border: `3px double ${C.blue}`,
            borderRadius: "8px",
            display: "inline-block",
            textAlign: "center",
          }}>
            <p style={{ fontSize: "16px", color: C.muted, marginBottom: "10px" }}>月額</p>
            <p style={{ fontSize: "56px", fontWeight: "bold", color: C.blue, lineHeight: 1, marginBottom: "10px" }}>
              ¥9,800
            </p>
            <p style={{ fontSize: "14px", color: C.sub }}>（税込）／ 月</p>
          </div>

          <p style={{ marginTop: "20px" }}>
            1日あたり、たった<strong style={{ color: C.blue }}>320円</strong>。
          </p>
          <p style={{ marginTop: "1em" }}>
            毎日のスタバ1杯分よりも安い金額で、<br />
            あなたの人生そのものを書き換えるサポートが受けられます。
          </p>
        </section>

        <Hr />

        {/* 安心ポイント（縮小） */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: C.blue, textAlign: "center", marginBottom: "30px", lineHeight: 1.5 }}>
            安心して始めていただくために
          </h2>

          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: C.blue }}>◆ いつでも解約できます</strong><br />
            ネットからいつでも解約可能。引き留めや解約理由のヒアリングも一切ありません。決済日の7日前までに手続きいただければ、次回の決済は走りません。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            <strong style={{ color: C.blue }}>◆ 海外在住でも参加OK</strong><br />
            グループコーチングはオンライン開催。「幸せなお金引き寄せbot」もブラウザがあればどこからでも使えます。
          </p>
        </section>

        <Hr />

        {/* 既存ユーザー向け案内 */}
        <section style={{
          marginBottom: "60px",
          padding: "30px",
          backgroundColor: C.blueSoft,
          border: `2px solid ${C.blue}`,
          borderRadius: "8px",
        }}>
          <h3 style={{ color: C.blue, fontSize: "18px", fontWeight: "bold", marginBottom: "16px" }}>
            ※ すでに「豊かさタッピング」をご受講中の方へ
          </h3>
          <p style={{ color: C.blue }}>
            ご購入から<strong>365日以内</strong>の方は、このプランへのご加入なしで、AIコーチbotをそのままご利用いただけます。
          </p>
          <p style={{ color: C.blue, marginTop: "1em" }}>
            MyASPにご登録のメールアドレスで、<a href="/login" style={{ color: C.blue, textDecoration: "underline", fontWeight: "bold" }}>ログインページ</a>からそのままログインしてください。
          </p>
          <p style={{ color: C.blue, marginTop: "1em" }}>
            365日経過後も継続したい方、毎月の三凛グループコーチングを受けたい方は、ぜひこのプランへのご加入をご検討ください。
          </p>
          <p style={{ color: C.blue, marginTop: "1em" }}>
            <strong>※ アカウントはそのまま引き継がれます。</strong><br />
            このプランへのお申込み時に <strong>豊かさタッピングと同じメールアドレス</strong> をご利用いただければ、
            これまでのチャット履歴やAIコーチとの会話メモリは <strong>すべてそのまま</strong>。
            ログイン情報も変わりません。
          </p>
        </section>

        <Hr />

        {/* 追伸 */}
        <section style={{ marginBottom: "60px" }}>
          <h2 style={{ fontSize: "22px", fontWeight: "bold", color: C.blue, marginBottom: "30px" }}>
            追伸
          </h2>

          <p>最後まで読んでくださって、ありがとうございます。</p>
          <p style={{ marginTop: "1.2em" }}>
            僕自身、人生の中で本当に大きな挫折を経験して、<br />
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
            <strong style={{ color: C.blue }}>あなたの人生は、あなたの意識でできています。</strong>
          </p>
          <p style={{ marginTop: "1.2em" }}>
            意識を変えれば、現実は雪崩のように変わります。
          </p>
          <p style={{ marginTop: "1.2em" }}>
            その瞬間を、月1のセッションと「幸せなお金引き寄せbot」で、<br />
            僕と一緒につくっていきましょう。
          </p>
          <p style={{ marginTop: "2em", textAlign: "right" }}>三凛さとし</p>
        </section>

        <Hr />

        {/* 最終CTA */}
        <section style={{ textAlign: "center", marginBottom: "60px" }}>
          <h2 style={{ fontSize: "26px", fontWeight: "bold", color: C.blue, marginBottom: "30px", lineHeight: 1.5 }}>
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
                background: `linear-gradient(135deg, ${C.blueDeep}, ${C.blue})`,
                borderRadius: "8px",
                textDecoration: "none",
                boxShadow: `0 4px 12px rgba(30, 58, 138, 0.3)`,
              }}
            >
              月¥9,800で加入する →
            </a>
          ) : (
            <div style={{ padding: "20px", backgroundColor: "#fef2f2", color: C.red, borderRadius: "8px", display: "inline-block" }}>
              ⚠ 申込URL準備中
            </div>
          )}

          <p style={{ marginTop: "20px", fontSize: "14px", color: C.muted }}>
            月額9,800円（税込）・初月から課金・1ヶ月毎・いつでも解約OK
          </p>
        </section>

        <Hr />

        {/* プロフィール（最後に配置） */}
        <section style={{ marginBottom: "40px" }}>
          <h2 style={{ fontSize: "22px", fontWeight: "bold", color: C.blue, textAlign: "center", marginBottom: "30px", lineHeight: 1.5 }}>
            プロフィール
          </h2>

          <div style={{ textAlign: "center", marginBottom: "30px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/satoshi-profile.jpg"
              alt="三凛さとし"
              style={{
                maxWidth: "280px",
                width: "100%",
                borderRadius: "8px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
              }}
            />
          </div>

          <p style={{ fontSize: "20px", fontWeight: "bold", textAlign: "center", marginBottom: "20px" }}>
            三凛さとし
          </p>
          <p style={{ textAlign: "center", color: C.sub, marginBottom: "20px", fontSize: "15px" }}>
            ライフコーチ・作家
          </p>

          <p>
            ライフコーチ・作家として<strong>12年以上</strong>活動。
          </p>
          <p style={{ marginTop: "1em" }}>
            世界4拠点（ポルトガル・マルタ・タイ・ドバイ）を転々としながら、<br />
            SNSフォロワー合計<strong>約50万人</strong>、これまで<strong>数万人</strong>の人生変容に関わってきた。
          </p>
          <p style={{ marginTop: "1em" }}>
            テレビ・雑誌・ラジオ・新聞での出演実績多数。<br />
            お金の引き寄せ（金運）、親子関係、人間関係、仕事、健康と、人生の根幹に関わるテーマで発信している。<br />
            <strong>LINE占いの公認占い師</strong>でもあり、スピリチュアル・開運・自己啓発・心理学・占いと幅広い分野で活動。
          </p>
          <p style={{ marginTop: "1em" }}>
            2025年からインドの oneness で <strong>Sri Krishnaji・Sri Preethaji</strong> に師事。<br />
            2026年4月、立ち上げから3週間で<strong>夢叶フェス（登録2.3万人・延べ5.3万人動員）</strong>を開催。<br />
            日本の自己啓発業界では過去最大規模のフェスとなり、ニュースにも取り上げられる。
          </p>
        </section>

        <Hr />

        {/* Footer */}
        <footer style={{ textAlign: "center", color: C.muted, fontSize: "14px", paddingTop: "20px" }}>
          <p>
            <a href="/login" style={{ color: C.blue, textDecoration: "underline" }}>ログインページへ</a>
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
      margin: "60px auto",
      width: "60%",
    }} />
  );
}
