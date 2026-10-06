// utils/time.ts
// Tüm tarih/saat işlemleri İstanbul saatine göre yapılır (sunucu UTC'de çalışır).

const TIME_ZONE = 'Europe/Istanbul';
const DAY_MS = 24 * 60 * 60 * 1000;

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function istanbulParts(ms: number) {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(new Date(ms))) {
    parts[part.type] = part.value;
  }
  return parts;
}

// "06.10.2026 14:32" (withSeconds: "06.10.2026 14:32:05")
export function formatIstanbul(ms: number, withSeconds = false): string {
  const p = istanbulParts(ms);
  const time = withSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
  return `${p.day}.${p.month}.${p.year} ${time}`;
}

// Gün anahtarı: "2026-10-06" (İstanbul takvim günü)
export function istanbulDayKey(ms: number): string {
  const p = istanbulParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

// İki gün anahtarı arasındaki takvim günü farkı
export function dayKeyDiff(fromKey: string, toKey: string): number {
  const toUtc = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / DAY_MS);
}

// "06.10.2026" veya "06.10.2026 14:32" metninden gün anahtarı çıkarır
export function dayKeyFromTurkishDate(text: string): string | null {
  const match = /(\d{2})\.(\d{2})\.(\d{4})/.exec(text);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}
