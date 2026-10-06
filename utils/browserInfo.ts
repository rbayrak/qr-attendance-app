// utils/browserInfo.ts (istemci)
// Kamera sorunlarını teşhis etmek için tarayıcı bilgisi.

// Instagram, Facebook vb. uygulamaların kendi içindeki tarayıcılar kameraya
// çoğu zaman izin vermez; öğrenciyi Safari/Chrome'a yönlendirmek gerekir.
export function detectInAppBrowser(userAgent: string): string | null {
  const checks: [RegExp, string][] = [
    [/Instagram/i, 'Instagram'],
    [/FBAN|FBAV|FB_IAB/i, 'Facebook'],
    [/LinkedInApp/i, 'LinkedIn'],
    [/Twitter/i, 'X (Twitter)'],
    [/Snapchat/i, 'Snapchat'],
    [/musical_ly|Bytedance|TikTok/i, 'TikTok'],
    [/Line\//i, 'LINE'],
    [/Telegram/i, 'Telegram'],
    [/GSA\//i, 'Google uygulaması'],
    [/; wv\)/i, 'Android uygulama içi tarayıcı']
  ];
  for (const [pattern, name] of checks) {
    if (pattern.test(userAgent)) return name;
  }
  return null;
}

// Kapanınca çerezleri ve site verilerini kendiliğinden silen tarayıcılar.
// Bunlarda telefonun kaydı her seferinde kaybolur; öğrenci her hafta öğretmen
// onayına düşmesin diye önceden uyarılır. (Gizli sekme güvenilir biçimde tespit
// edilemiyor; tarayıcılar bunu kasten gizliyor.)
export function detectEphemeralBrowser(userAgent: string): string | null {
  const checks: [RegExp, string][] = [
    [/DuckDuckGo\/|\bDdg\//i, 'DuckDuckGo'],
    [/\bFocus\/|\bKlar\//i, 'Firefox Focus']
  ];
  for (const [pattern, name] of checks) {
    if (pattern.test(userAgent)) return name;
  }
  return null;
}

// Kısa tarayıcı özeti: "iOS 17.5 / Safari", "Android 14 / Chrome 129"
export function browserSummary(userAgent: string): string {
  const ios = /OS (\d+)[_.](\d+)/.exec(userAgent);
  const android = /Android (\d+(?:\.\d+)?)/.exec(userAgent);
  const os = /iPhone|iPad|iPod/.test(userAgent) && ios
    ? `iOS ${ios[1]}.${ios[2]}`
    : android
      ? `Android ${android[1]}`
      : /Windows/.test(userAgent) ? 'Windows' : /Mac OS X/.test(userAgent) ? 'macOS' : 'Diğer';

  let browser = 'Diğer';
  const version = (pattern: RegExp) => pattern.exec(userAgent)?.[1] ?? '';
  if (/SamsungBrowser/.test(userAgent)) browser = `Samsung Internet ${version(/SamsungBrowser\/(\d+)/)}`;
  else if (/CriOS/.test(userAgent)) browser = `Chrome (iOS) ${version(/CriOS\/(\d+)/)}`;
  else if (/FxiOS/.test(userAgent)) browser = `Firefox (iOS) ${version(/FxiOS\/(\d+)/)}`;
  else if (/EdgiOS|EdgA|Edg\//.test(userAgent)) browser = 'Edge';
  else if (/OPR|Opera/.test(userAgent)) browser = 'Opera';
  else if (/MiuiBrowser/.test(userAgent)) browser = 'Xiaomi Tarayıcı';
  else if (/Firefox\//.test(userAgent)) browser = `Firefox ${version(/Firefox\/(\d+)/)}`;
  else if (/Chrome\//.test(userAgent)) browser = `Chrome ${version(/Chrome\/(\d+)/)}`;
  else if (/Safari\//.test(userAgent)) browser = 'Safari';

  return `${os} / ${browser.trim()}`;
}
