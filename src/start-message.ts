export function startMessage() {
  const startText = [
    "لینک رو بفرست، فایلش رو همین‌جا بگیر ⚡️",
    "",
    "⬇️ دانلود: YouTube، Pornhub، اینستاگرام، X،",
    "Pinterest، TikTok، SoundCloud و Aparat",
    "",
    "🎵 آهنگ: اسم آهنگ و خواننده یا /music",
    "🔎 تشخیص آهنگ: ویس، صدا یا ویدیو؛ در گروه ریپلای + /shazam",
    "🔎 آهنگ اینستاگرام: «پیداکردن آهنگ» یا /findmusic لینک",
    "🎼 پلی‌لیست: /playlist لینک 1-20",
    "🎵 Bandcamp: لینک آهنگ یا آلبوم • /bandcamp لینک",
    "⬇️ Reddit: ویدیو، عکس و گالری • /reddit لینک",
    "🎧 فقط صدا: دکمهٔ «فقط صدا» یا /audio لینک",
    "",
    "ضبط لایو: /live username",
    "بازپخش: /replay لینک",
    "توقف ضبط: دکمهٔ زیر پیام",
  ].join("\n");
  const boldLabels = ["دانلود:", "آهنگ:", "تشخیص آهنگ:", "آهنگ اینستاگرام:",
    "پلی‌لیست:", "فقط صدا:", "ضبط لایو:", "بازپخش:"];
  return { text: startText, entities: boldLabels.map(label => ({
    type: "bold", offset: startText.indexOf(label), length: label.length,
  })) };
}
