/**
 * E-mail and e-card copy per card language (owner: A12; widened to the ten widget languages by A17,
 * ADR-057: the gift flow follows the giver's conversation language, English for any other).
 * en and vi are the original, reviewed text; ja, ko, zh, th, id, es, fr and de are machine-translated and
 * not yet reviewed by native speakers. The privacy sentences say exactly what the English says: the
 * giver never sees the recipient's photos (try-on), or no photo is taken at all (hearts-only gifts).
 */
import type { Occasion } from "../contracts/giftfit";
import type { Locale } from "@/lib/i18n";

export const LINK_TTL_HOURS = 72;

export interface EmailCopy {
  footer: string;
  footerNoList: string;
  giftSubject(giver: string): string;
  giftIntro(giver: string, recipient: string): string;
  giftBody(giver: string): string;
  giftBodyNoTryOn(giver: string): string;
  giftMessageLabel(giver: string): string;
  giftCta: string;
  reportSubject(recipient: string): string;
  reportIntro(giver: string, recipient: string): string;
  reportIntroNoTryOn(giver: string, recipient: string): string;
  reportBody: string;
  reportBodyNoTryOn: string;
  reportCta: string;
  linkFallback: string;
}

/** The headline at the top of the e-card and the gift e-mail, per occasion. */
export const HEADLINES: Record<Occasion, Record<Locale, string>> = {
  anniversary: { en: "Happy anniversary", vi: "Chúc mừng kỷ niệm", ja: "記念日おめでとう", ko: "기념일 축하해요", zh: "纪念日快乐", th: "สุขสันต์วันครบรอบ", id: "Selamat hari jadi", es: "Feliz aniversario", fr: "Bel anniversaire", de: "Alles Gute zum Jahrestag" },
  birthday: { en: "Happy birthday", vi: "Chúc mừng sinh nhật", ja: "お誕生日おめでとう", ko: "생일 축하해요", zh: "生日快乐", th: "สุขสันต์วันเกิด", id: "Selamat ulang tahun", es: "Feliz cumpleaños", fr: "Joyeux anniversaire", de: "Alles Gute zum Geburtstag" },
  wedding: { en: "Congratulations on your wedding", vi: "Chúc mừng ngày cưới", ja: "ご結婚おめでとう", ko: "결혼을 축하해요", zh: "新婚快乐", th: "ยินดีด้วยกับการแต่งงาน", id: "Selamat atas pernikahanmu", es: "Felicidades por tu boda", fr: "Félicitations pour votre mariage", de: "Herzlichen Glückwunsch zur Hochzeit" },
  holiday: { en: "Happy holidays", vi: "Chúc mừng ngày lễ", ja: "ハッピーホリデー", ko: "즐거운 연휴 보내세요", zh: "节日快乐", th: "สุขสันต์วันหยุด", id: "Selamat hari raya", es: "Felices fiestas", fr: "Joyeuses fêtes", de: "Frohe Feiertage" },
  graduation: { en: "Congratulations, graduate", vi: "Chúc mừng tốt nghiệp", ja: "ご卒業おめでとう", ko: "졸업을 축하해요", zh: "毕业快乐", th: "ยินดีด้วยกับการสำเร็จการศึกษา", id: "Selamat atas kelulusanmu", es: "Felicidades por tu graduación", fr: "Félicitations pour votre diplôme", de: "Herzlichen Glückwunsch zum Abschluss" },
  thank_you: { en: "Thank you", vi: "Cảm ơn bạn", ja: "ありがとう", ko: "고마워요", zh: "谢谢你", th: "ขอบคุณ", id: "Terima kasih", es: "Gracias", fr: "Merci", de: "Danke" },
  just_because: { en: "A little something for you", vi: "Một món quà nhỏ dành cho bạn", ja: "ささやかな贈り物です", ko: "당신을 위한 작은 선물", zh: "送你一份小礼物", th: "ของขวัญเล็กๆ สำหรับคุณ", id: "Sedikit hadiah untukmu", es: "Un detalle para ti", fr: "Un petit quelque chose pour vous", de: "Eine kleine Aufmerksamkeit für dich" },
};

const H = LINK_TTL_HOURS;

export const EMAIL_COPY: Record<Locale, EmailCopy> = {
  en: {
    footer: `Didn't expect this? Ignore it — the link expires in ${H} h. Report abuse: reply to this email.`,
    footerNoList: "This is a one-off message about a single gift. We have not added you to any mailing list.",
    giftSubject: (giver) => (giver ? `${giver} sent you a gift card` : "You've received a GiftFit gift card"),
    giftIntro: (giver, recipient) => `${recipient ? `Hi ${recipient}, ` : ""}${giver || "Someone"} would like to find the jewelry that suits you best.`,
    giftBody: (giver) => `Try a few pieces on with your phone camera and heart the ones you love. ${giver || "The sender"} sees only which pieces suit you, never your photos.`,
    giftBodyNoTryOn: (giver) => `Look through a few pieces from the store and heart the ones you love. No photo is needed; ${giver || "the sender"} sees only which pieces you hearted.`,
    giftMessageLabel: (giver) => `A message from ${giver || "the sender"}`,
    giftCta: "Open your gift",
    reportSubject: (recipient) => (recipient ? `${recipient}'s Fit Report is ready` : "Your Fit Report is ready"),
    reportIntro: (giver, recipient) => `${giver ? `Hi ${giver}, ` : ""}${recipient || "Your recipient"} has finished trying on. Your Fit Report shows which pieces suit them best and why.`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `Hi ${giver}, ` : ""}${recipient || "Your recipient"} has sent their hearts. Your Fit Report shows which pieces they loved and why.`,
    reportBody: "Their photos are never shared with you; the report contains scores and short reasons only.",
    reportBodyNoTryOn: "No photo of them was taken; the report contains their hearts, scores and short reasons only.",
    reportCta: "See the Fit Report",
    linkFallback: "If the button does not work, copy this link into your browser:",
  },
  vi: {
    footer: `Không mong đợi email này? Hãy bỏ qua — liên kết hết hạn sau ${H} giờ. Báo cáo lạm dụng: trả lời email này.`,
    footerNoList: "Đây là thư gửi một lần cho một món quà. Chúng tôi không thêm bạn vào danh sách thư nào.",
    giftSubject: (giver) => (giver ? `${giver} đã gửi bạn một thiệp quà` : "Bạn nhận được một thiệp quà GiftFit"),
    giftIntro: (giver, recipient) => `${recipient ? `Chào ${recipient}, ` : ""}${giver || "Một người"} muốn tìm món trang sức hợp với bạn nhất.`,
    giftBody: (giver) => `Hãy thử vài món bằng camera điện thoại và thả tim những món bạn thích. ${giver || "Người gửi"} chỉ biết món nào hợp với bạn, không bao giờ thấy ảnh của bạn.`,
    giftBodyNoTryOn: (giver) => `Hãy xem vài món của cửa hàng và thả tim những món bạn thích. Không cần chụp ảnh; ${giver || "người gửi"} chỉ biết bạn đã thả tim món nào.`,
    giftMessageLabel: (giver) => `Lời nhắn từ ${giver || "người gửi"}`,
    giftCta: "Mở quà của bạn",
    reportSubject: (recipient) => (recipient ? `Fit Report của ${recipient} đã sẵn sàng` : "Fit Report của bạn đã sẵn sàng"),
    reportIntro: (giver, recipient) => `${giver ? `Chào ${giver}, ` : ""}${recipient || "Người nhận"} đã thử xong. Fit Report cho biết món nào hợp nhất và vì sao.`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `Chào ${giver}, ` : ""}${recipient || "Người nhận"} đã thả tim xong. Fit Report cho biết họ thích món nào và vì sao.`,
    reportBody: "Ảnh của người nhận không bao giờ được chia sẻ với bạn; báo cáo chỉ có điểm số và lý do ngắn gọn.",
    reportBodyNoTryOn: "Không có ảnh nào của người nhận được chụp; báo cáo chỉ có món họ thả tim, điểm số và lý do ngắn gọn.",
    reportCta: "Xem Fit Report",
    linkFallback: "Nếu nút không hoạt động, hãy sao chép liên kết này vào trình duyệt:",
  },
  ja: {
    footer: `心当たりがない場合は、このメールを無視してください。リンクは${H}時間で無効になります。不正利用の報告は、このメールに返信してください。`,
    footerNoList: "これは1つのギフトについての1回限りのメッセージです。メーリングリストには登録していません。",
    giftSubject: (giver) => (giver ? `${giver}さんからギフトカードが届きました` : "GiftFitのギフトカードが届きました"),
    giftIntro: (giver, recipient) => `${recipient ? `${recipient}さん、` : ""}${giver ? `${giver}さん` : "ある方"}が、あなたに一番似合うジュエリーを見つけたいと思っています。`,
    giftBody: (giver) => `スマートフォンのカメラでいくつかのアイテムを試着して、気に入ったものにハートを付けてください。${giver ? `${giver}さん` : "贈り主"}に伝わるのはどのアイテムが似合うかだけで、あなたの写真が見られることはありません。`,
    giftBodyNoTryOn: (giver) => `ストアのアイテムをいくつか見て、気に入ったものにハートを付けてください。写真は必要ありません。${giver ? `${giver}さん` : "贈り主"}に伝わるのは、ハートを付けたアイテムだけです。`,
    giftMessageLabel: (giver) => `${giver ? `${giver}さん` : "贈り主"}からのメッセージ`,
    giftCta: "ギフトを開く",
    reportSubject: (recipient) => (recipient ? `${recipient}さんのFit Reportができました` : "Fit Reportができました"),
    reportIntro: (giver, recipient) => `${giver ? `${giver}さん、` : ""}${recipient ? `${recipient}さん` : "お相手の方"}が試着を終えました。Fit Reportで、どのアイテムが一番似合うか、その理由がわかります。`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `${giver}さん、` : ""}${recipient ? `${recipient}さん` : "お相手の方"}がハートを送りました。Fit Reportで、気に入ったアイテムとその理由がわかります。`,
    reportBody: "お相手の写真があなたに共有されることはありません。レポートにはスコアと短い理由だけが含まれます。",
    reportBodyNoTryOn: "お相手の写真は撮影されていません。レポートにはハート、スコア、短い理由だけが含まれます。",
    reportCta: "Fit Reportを見る",
    linkFallback: "ボタンが使えない場合は、このリンクをブラウザにコピーしてください：",
  },
  ko: {
    footer: `예상하지 못한 메일인가요? 무시하셔도 됩니다. 링크는 ${H}시간 후 만료돼요. 악용 신고: 이 메일에 답장해 주세요.`,
    footerNoList: "선물 하나에 관한 일회성 메시지입니다. 어떤 메일링 리스트에도 추가하지 않았어요.",
    giftSubject: (giver) => (giver ? `${giver} 님이 선물 카드를 보냈어요` : "GiftFit 선물 카드가 도착했어요"),
    giftIntro: (giver, recipient) => `${recipient ? `${recipient} 님, ` : ""}${giver ? `${giver} 님이` : "누군가가"} 당신에게 가장 잘 어울리는 주얼리를 찾고 싶어 해요.`,
    giftBody: (giver) => `휴대폰 카메라로 몇 가지 제품을 착용해 보고 마음에 드는 것에 하트를 눌러 주세요. ${giver ? `${giver} 님은` : "보낸 분은"} 어떤 제품이 어울리는지만 알 수 있고, 당신의 사진은 절대 볼 수 없어요.`,
    giftBodyNoTryOn: (giver) => `매장의 제품 몇 가지를 둘러보고 마음에 드는 것에 하트를 눌러 주세요. 사진은 필요 없어요. ${giver ? `${giver} 님은` : "보낸 분은"} 당신이 하트를 누른 제품만 알 수 있어요.`,
    giftMessageLabel: (giver) => `${giver ? `${giver} 님` : "보낸 분"}의 메시지`,
    giftCta: "선물 열기",
    reportSubject: (recipient) => (recipient ? `${recipient} 님의 Fit Report가 준비됐어요` : "Fit Report가 준비됐어요"),
    reportIntro: (giver, recipient) => `${giver ? `${giver} 님, ` : ""}${recipient ? `${recipient} 님이` : "받는 분이"} 착용을 마쳤어요. Fit Report에서 어떤 제품이 가장 잘 어울리는지와 그 이유를 확인할 수 있어요.`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `${giver} 님, ` : ""}${recipient ? `${recipient} 님이` : "받는 분이"} 하트를 보냈어요. Fit Report에서 마음에 들어 한 제품과 그 이유를 확인할 수 있어요.`,
    reportBody: "받는 분의 사진은 절대 공유되지 않아요. 보고서에는 점수와 짧은 이유만 담겨 있어요.",
    reportBodyNoTryOn: "받는 분의 사진은 촬영되지 않았어요. 보고서에는 하트, 점수, 짧은 이유만 담겨 있어요.",
    reportCta: "Fit Report 보기",
    linkFallback: "버튼이 작동하지 않으면 이 링크를 브라우저에 복사해 붙여 넣으세요:",
  },
  zh: {
    footer: `没想到会收到这封邮件？忽略即可——链接将在 ${H} 小时后失效。举报滥用：请直接回复此邮件。`,
    footerNoList: "这是一封关于一份礼物的一次性邮件。我们没有将你加入任何邮件列表。",
    giftSubject: (giver) => (giver ? `${giver} 给你送来一张礼品卡` : "你收到了一张 GiftFit 礼品卡"),
    giftIntro: (giver, recipient) => `${recipient ? `${recipient}，你好！` : ""}${giver || "有人"}想为你找到最适合你的珠宝。`,
    giftBody: (giver) => `用手机摄像头试戴几件饰品，给喜欢的点亮爱心。${giver || "送礼人"}只会知道哪些饰品适合你，永远看不到你的照片。`,
    giftBodyNoTryOn: (giver) => `浏览店里的几件饰品，给喜欢的点亮爱心。无需拍照；${giver || "送礼人"}只会知道你给哪些饰品点了爱心。`,
    giftMessageLabel: (giver) => `来自${giver || "送礼人"}的留言`,
    giftCta: "打开你的礼物",
    reportSubject: (recipient) => (recipient ? `${recipient}的 Fit Report 已准备好` : "你的 Fit Report 已准备好"),
    reportIntro: (giver, recipient) => `${giver ? `${giver}，你好！` : ""}${recipient || "收礼人"}已完成试戴。Fit Report 会告诉你哪些饰品最适合对方，以及原因。`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `${giver}，你好！` : ""}${recipient || "收礼人"}已送出爱心。Fit Report 会告诉你对方喜欢哪些饰品，以及原因。`,
    reportBody: "对方的照片绝不会分享给你；报告只包含评分和简短的理由。",
    reportBodyNoTryOn: "没有拍摄对方的任何照片；报告只包含对方的爱心、评分和简短的理由。",
    reportCta: "查看 Fit Report",
    linkFallback: "如果按钮无法使用，请将此链接复制到浏览器中：",
  },
  th: {
    footer: `ไม่ได้คาดว่าจะได้รับอีเมลนี้ใช่ไหม ไม่ต้องสนใจได้เลย ลิงก์จะหมดอายุใน ${H} ชั่วโมง แจ้งการใช้งานในทางที่ผิด: ตอบกลับอีเมลนี้`,
    footerNoList: "นี่เป็นข้อความครั้งเดียวเกี่ยวกับของขวัญชิ้นเดียว เราไม่ได้เพิ่มคุณลงในรายชื่ออีเมลใดๆ",
    giftSubject: (giver) => (giver ? `${giver} ส่งการ์ดของขวัญถึงคุณ` : "คุณได้รับการ์ดของขวัญ GiftFit"),
    giftIntro: (giver, recipient) => `${recipient ? `สวัสดี ${recipient} ` : ""}${giver || "มีคนหนึ่ง"}อยากหาเครื่องประดับที่เหมาะกับคุณที่สุด`,
    giftBody: (giver) => `ลองสวมเครื่องประดับสองสามชิ้นด้วยกล้องโทรศัพท์ แล้วกดหัวใจชิ้นที่คุณชอบ ${giver || "ผู้ส่ง"}จะเห็นเพียงว่าชิ้นไหนเหมาะกับคุณ และจะไม่เห็นรูปถ่ายของคุณเลย`,
    giftBodyNoTryOn: (giver) => `ดูเครื่องประดับสองสามชิ้นจากร้าน แล้วกดหัวใจชิ้นที่คุณชอบ ไม่ต้องถ่ายรูป ${giver || "ผู้ส่ง"}จะเห็นเพียงชิ้นที่คุณกดหัวใจ`,
    giftMessageLabel: (giver) => `ข้อความจาก${giver || "ผู้ส่ง"}`,
    giftCta: "เปิดของขวัญของคุณ",
    reportSubject: (recipient) => (recipient ? `Fit Report ของ ${recipient} พร้อมแล้ว` : "Fit Report ของคุณพร้อมแล้ว"),
    reportIntro: (giver, recipient) => `${giver ? `สวัสดี ${giver} ` : ""}${recipient || "ผู้รับ"}ลองสวมเสร็จแล้ว Fit Report จะบอกว่าชิ้นไหนเหมาะกับเขาที่สุดและเพราะอะไร`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `สวัสดี ${giver} ` : ""}${recipient || "ผู้รับ"}ส่งหัวใจแล้ว Fit Report จะบอกว่าเขาชอบชิ้นไหนและเพราะอะไร`,
    reportBody: "รูปถ่ายของผู้รับจะไม่ถูกแชร์ให้คุณ รายงานมีเพียงคะแนนและเหตุผลสั้นๆ",
    reportBodyNoTryOn: "ไม่มีการถ่ายรูปผู้รับ รายงานมีเพียงหัวใจ คะแนน และเหตุผลสั้นๆ",
    reportCta: "ดู Fit Report",
    linkFallback: "หากปุ่มใช้งานไม่ได้ ให้คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์:",
  },
  id: {
    footer: `Tidak mengharapkan email ini? Abaikan saja — tautan kedaluwarsa dalam ${H} jam. Laporkan penyalahgunaan: balas email ini.`,
    footerNoList: "Ini pesan satu kali tentang satu hadiah. Kami tidak menambahkan Anda ke milis apa pun.",
    giftSubject: (giver) => (giver ? `${giver} mengirimi Anda kartu hadiah` : "Anda menerima kartu hadiah GiftFit"),
    giftIntro: (giver, recipient) => `${recipient ? `Hai ${recipient}, ` : ""}${giver || "Seseorang"} ingin menemukan perhiasan yang paling cocok untuk Anda.`,
    giftBody: (giver) => `Coba beberapa perhiasan dengan kamera ponsel Anda dan beri hati pada yang Anda sukai. ${giver || "Pengirim"} hanya melihat perhiasan mana yang cocok untuk Anda, tidak pernah foto Anda.`,
    giftBodyNoTryOn: (giver) => `Lihat beberapa perhiasan dari toko dan beri hati pada yang Anda sukai. Tidak perlu foto; ${giver || "pengirim"} hanya melihat perhiasan mana yang Anda beri hati.`,
    giftMessageLabel: (giver) => `Pesan dari ${giver || "pengirim"}`,
    giftCta: "Buka hadiah Anda",
    reportSubject: (recipient) => (recipient ? `Fit Report ${recipient} sudah siap` : "Fit Report Anda sudah siap"),
    reportIntro: (giver, recipient) => `${giver ? `Hai ${giver}, ` : ""}${recipient || "Penerima"} sudah selesai mencoba. Fit Report Anda menunjukkan perhiasan mana yang paling cocok dan alasannya.`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `Hai ${giver}, ` : ""}${recipient || "Penerima"} sudah mengirim hatinya. Fit Report Anda menunjukkan perhiasan mana yang mereka sukai dan alasannya.`,
    reportBody: "Foto mereka tidak pernah dibagikan kepada Anda; laporan hanya berisi skor dan alasan singkat.",
    reportBodyNoTryOn: "Tidak ada foto mereka yang diambil; laporan hanya berisi hati, skor, dan alasan singkat.",
    reportCta: "Lihat Fit Report",
    linkFallback: "Jika tombol tidak berfungsi, salin tautan ini ke browser Anda:",
  },
  es: {
    footer: `¿No esperabas este mensaje? Ignóralo: el enlace caduca en ${H} h. Para denunciar un abuso, responde a este correo.`,
    footerNoList: "Es un mensaje único sobre un solo regalo. No te hemos añadido a ninguna lista de correo.",
    giftSubject: (giver) => (giver ? `${giver} te ha enviado una tarjeta regalo` : "Has recibido una tarjeta regalo de GiftFit"),
    giftIntro: (giver, recipient) => `${recipient ? `Hola, ${recipient}. ` : ""}${giver || "Alguien"} quiere encontrar las joyas que mejor te quedan.`,
    giftBody: (giver) => `Pruébate algunas piezas con la cámara del móvil y marca con un corazón las que te encanten. ${giver || "Quien te lo envía"} solo ve qué piezas te quedan bien, nunca tus fotos.`,
    giftBodyNoTryOn: (giver) => `Mira algunas piezas de la tienda y marca con un corazón las que te encanten. No hace falta ninguna foto; ${giver || "quien te lo envía"} solo ve qué piezas marcaste.`,
    giftMessageLabel: (giver) => `Un mensaje de ${giver || "quien te lo envía"}`,
    giftCta: "Abre tu regalo",
    reportSubject: (recipient) => (recipient ? `El Fit Report de ${recipient} está listo` : "Tu Fit Report está listo"),
    reportIntro: (giver, recipient) => `${giver ? `Hola, ${giver}. ` : ""}${recipient || "La persona que recibe el regalo"} ya terminó de probarse las piezas. Tu Fit Report muestra cuáles le quedan mejor y por qué.`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `Hola, ${giver}. ` : ""}${recipient || "La persona que recibe el regalo"} ya envió sus corazones. Tu Fit Report muestra qué piezas le encantaron y por qué.`,
    reportBody: "Sus fotos nunca se comparten contigo; el informe solo contiene puntuaciones y razones breves.",
    reportBodyNoTryOn: "No se tomó ninguna foto de esa persona; el informe solo contiene sus corazones, puntuaciones y razones breves.",
    reportCta: "Ver el Fit Report",
    linkFallback: "Si el botón no funciona, copia este enlace en tu navegador:",
  },
  fr: {
    footer: `Vous ne vous attendiez pas à ce message ? Ignorez-le : le lien expire dans ${H} h. Signaler un abus : répondez à cet e-mail.`,
    footerNoList: "Ceci est un message unique concernant un seul cadeau. Nous ne vous avons ajouté à aucune liste de diffusion.",
    giftSubject: (giver) => (giver ? `${giver} vous a envoyé une carte cadeau` : "Vous avez reçu une carte cadeau GiftFit"),
    giftIntro: (giver, recipient) => `${recipient ? `Bonjour ${recipient}, ` : ""}${giver || "Quelqu'un"} aimerait trouver les bijoux qui vous vont le mieux.`,
    giftBody: (giver) => `Essayez quelques pièces avec l'appareil photo de votre téléphone et mettez un cœur sur celles que vous aimez. ${giver || "L'expéditeur"} voit seulement quelles pièces vous vont, jamais vos photos.`,
    giftBodyNoTryOn: (giver) => `Parcourez quelques pièces de la boutique et mettez un cœur sur celles que vous aimez. Aucune photo n'est nécessaire ; ${giver || "l'expéditeur"} voit seulement les pièces que vous avez aimées.`,
    giftMessageLabel: (giver) => (giver ? `Un message de ${giver}` : "Un message de l'expéditeur"),
    giftCta: "Ouvrir votre cadeau",
    reportSubject: (recipient) => (recipient ? `Le Fit Report de ${recipient} est prêt` : "Votre Fit Report est prêt"),
    reportIntro: (giver, recipient) => `${giver ? `Bonjour ${giver}, ` : ""}${recipient || "La personne"} a fini ses essais. Votre Fit Report montre les pièces qui lui vont le mieux, et pourquoi.`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `Bonjour ${giver}, ` : ""}${recipient || "La personne"} a envoyé ses cœurs. Votre Fit Report montre les pièces qu'elle a aimées, et pourquoi.`,
    reportBody: "Ses photos ne vous sont jamais transmises ; le rapport contient uniquement des scores et de courtes explications.",
    reportBodyNoTryOn: "Aucune photo de cette personne n'a été prise ; le rapport contient uniquement ses cœurs, des scores et de courtes explications.",
    reportCta: "Voir le Fit Report",
    linkFallback: "Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :",
  },
  de: {
    footer: `Unerwartet? Ignoriere diese Nachricht – der Link läuft nach ${H} Std. ab. Missbrauch melden: Antworte auf diese E-Mail.`,
    footerNoList: "Dies ist eine einmalige Nachricht zu einem einzelnen Geschenk. Wir haben dich in keine Mailingliste aufgenommen.",
    giftSubject: (giver) => (giver ? `${giver} hat dir eine Geschenkkarte geschickt` : "Du hast eine GiftFit-Geschenkkarte erhalten"),
    giftIntro: (giver, recipient) => `${recipient ? `Hallo ${recipient}, ` : ""}${giver || "Jemand"} möchte den Schmuck finden, der dir am besten steht.`,
    giftBody: (giver) => `Probiere mit der Handykamera ein paar Stücke an und markiere deine Favoriten mit einem Herz. ${giver || "Die schenkende Person"} sieht nur, welche Stücke dir stehen, niemals deine Fotos.`,
    giftBodyNoTryOn: (giver) => `Sieh dir ein paar Stücke aus dem Shop an und markiere deine Favoriten mit einem Herz. Kein Foto nötig; ${giver || "die schenkende Person"} sieht nur, welche Stücke du markiert hast.`,
    giftMessageLabel: (giver) => `Eine Nachricht von ${giver || "der schenkenden Person"}`,
    giftCta: "Geschenk öffnen",
    reportSubject: (recipient) => (recipient ? `Der Fit Report von ${recipient} ist fertig` : "Dein Fit Report ist fertig"),
    reportIntro: (giver, recipient) => `${giver ? `Hallo ${giver}, ` : ""}${recipient || "Die beschenkte Person"} hat die Anprobe abgeschlossen. Dein Fit Report zeigt, welche Stücke am besten passen und warum.`,
    reportIntroNoTryOn: (giver, recipient) => `${giver ? `Hallo ${giver}, ` : ""}${recipient || "Die beschenkte Person"} hat ihre Herzen geschickt. Dein Fit Report zeigt, welche Stücke ihr gefallen haben und warum.`,
    reportBody: "Fotos der beschenkten Person werden nie mit dir geteilt; der Bericht enthält nur Bewertungen und kurze Begründungen.",
    reportBodyNoTryOn: "Es wurde kein Foto der beschenkten Person aufgenommen; der Bericht enthält nur ihre Herzen, Bewertungen und kurze Begründungen.",
    reportCta: "Fit Report ansehen",
    linkFallback: "Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:",
  },
};
