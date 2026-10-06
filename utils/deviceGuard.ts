// utils/deviceGuard.ts (yalnızca sunucuda kullanılır)
//
// "Bir telefondan aynı gün birden fazla öğrenci için yoklama verilmesin" kuralı.
//
// Önceki yöntem cihazı ekran/GPU/dil gibi özelliklerden ve IP'den tanımaya
// çalışıyordu. Aynı model telefonlar aynı izi ürettiği ve kampüs Wi-Fi'ında
// herkesin IP'si aynı olduğu için farklı öğrenciler yanlışlıkla engelleniyor;
// Wi-Fi'dan mobil veriye geçen biri ise engeli kolayca aşabiliyordu.
//
// Yeni yöntem:
//  - Her tarayıcıya sunucu rastgele ve kalıcı bir kimlik verir (HttpOnly çerez).
//    Aynı kimlik aynı gün başka bir öğrenci için kullanılırsa: KESİN ENGEL.
//    Rastgele olduğu için iki farklı telefon asla aynı kimliği almaz.
//  - Gizli sekme veya ikinci bir tarayıcı yeni kimlik alır; bunu tamamen
//    engellemek mümkün değil. Bu yüzden kimlik yeni oluşturulmuşsa ve birkaç
//    dakika içinde aynı ağdan, aynı model bir cihazdan başka bir öğrenci
//    yoklama verdiyse kayıt engellenmez ama "ŞÜPHELİ" olarak işaretlenir.

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { LOG_COL, SheetRows } from '@/utils/sheets';
import { istanbulDayKey, formatIstanbul } from '@/utils/time';

const COOKIE_NAME = 'ytu_did';
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // tarayıcıların izin verdiği en uzun süre
const FRESH_DEVICE_MS = 15 * 60 * 1000;
const SUSPICION_WINDOW_MS = 5 * 60 * 1000;
// Kayıt sayfasında saklanan kimlik uzunluğu (çakışma olasılığı ihmal edilebilir)
export const DEVICE_ID_LENGTH = 12;

export const RESULT = {
  recorded: 'KAYDEDİLDİ',
  blocked: 'ENGELLENDİ',
  outOfLocation: 'KONUM DIŞI',
  cameraError: 'KAMERA HATASI',
  reset: 'SIFIRLAMA',
  legacy: 'ESKİ KAYIT' // eski biçimli hücreden aktarılan yoklama (cihaz kuralında kullanılmaz)
} as const;

// İstemcinin IP adresi (Vercel bu başlıkları kendisi ayarlar)
export function getClientIP(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstForwarded = forwardedValue?.split(',')[0]?.trim();
  const realIP = req.headers['x-real-ip'];
  return firstForwarded ||
    (Array.isArray(realIP) ? realIP[0] : realIP) ||
    req.socket?.remoteAddress ||
    '';
}

interface LogRowInput {
  now: number;
  week: number | '';
  studentId: string;
  name: string;
  result: string;
  deviceId: string;
  model: string;
  ip: string;
  note: string;
}

// "Yoklama Kayıtları" sayfası satırı (sütun sırası LOG_HEADERS ile aynı)
export function buildLogRow(input: LogRowInput): string[] {
  return [
    formatIstanbul(input.now, true),
    String(input.week),
    input.studentId,
    input.name,
    input.result,
    input.deviceId,
    input.model,
    input.ip,
    input.note,
    String(input.now)
  ];
}

export interface DeviceIdentity {
  id: string;        // kayıt sayfasına yazılan kısa kimlik
  createdAt: number;
  isFresh: boolean;
}

function readCookie(req: NextApiRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Tarayıcının cihaz kimliğini çerezden okur; yoksa oluşturup çerezi ayarlar. */
export function getDeviceIdentity(req: NextApiRequest, res: NextApiResponse): DeviceIdentity {
  const raw = readCookie(req, COOKIE_NAME);
  const match = raw ? /^([0-9a-f]{32})\.(\d{13})$/.exec(raw) : null;
  let token: string;
  let createdAt: number;

  if (match) {
    token = match[1];
    createdAt = Number(match[2]);
  } else {
    token = randomUUID().replace(/-/g, '');
    createdAt = Date.now();
    const forwardedProto = req.headers['x-forwarded-proto'];
    const isHttps = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) === 'https';
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${token}.${createdAt}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax` +
      (isHttps ? '; Secure' : ''));
  }

  return {
    id: token.slice(0, DEVICE_ID_LENGTH),
    createdAt,
    isFresh: Date.now() - createdAt < FRESH_DEVICE_MS
  };
}

interface LogEntry {
  studentId: string;
  result: string;
  deviceId: string;
  model: string;
  ip: string;
  timestamp: number;
}

function parseLog(log: SheetRows): LogEntry[] {
  const entries: LogEntry[] = [];
  for (let i = 1; i < log.length; i++) {
    const row = log[i] || [];
    const timestamp = Number(row[LOG_COL.timestamp]);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    entries.push({
      studentId: String(row[LOG_COL.studentId] ?? '').trim(),
      result: String(row[LOG_COL.result] ?? ''),
      deviceId: String(row[LOG_COL.deviceId] ?? ''),
      model: String(row[LOG_COL.model] ?? ''),
      ip: String(row[LOG_COL.ip] ?? ''),
      timestamp
    });
  }
  return entries;
}

/** Öğretmenin son "Cihaz Kayıtlarını Temizle" zamanı (yoksa 0). */
export function getLastResetAt(log: SheetRows): number {
  let last = 0;
  for (const entry of parseLog(log)) {
    if (entry.result === RESULT.reset && entry.timestamp > last) last = entry.timestamp;
  }
  return last;
}

/** Bu cihaz bugün başka bir öğrenci için kullanıldıysa o öğrencinin numarasını döndürür. */
export function findDeviceConflict(
  log: SheetRows,
  deviceId: string,
  studentId: string,
  now: number
): string | null {
  const today = istanbulDayKey(now);
  const lastReset = getLastResetAt(log);
  for (const entry of parseLog(log)) {
    if (entry.result !== RESULT.recorded) continue;
    if (entry.deviceId !== deviceId || entry.studentId === studentId) continue;
    if (entry.timestamp <= lastReset) continue;
    if (istanbulDayKey(entry.timestamp) !== today) continue;
    return entry.studentId;
  }
  return null;
}

/** Engellenmeyen ama öğretmenin bakması gereken durumlar için not üretir. */
export function findSuspicion(
  log: SheetRows,
  params: { device: DeviceIdentity; model: string; ip: string; studentId: string; now: number }
): string {
  const { device, model, ip, studentId, now } = params;
  if (!device.isFresh || !model || model === 'unknown' || !ip) return '';
  const lastReset = getLastResetAt(log);
  for (const entry of parseLog(log)) {
    if (entry.result !== RESULT.recorded) continue;
    if (entry.studentId === studentId || entry.deviceId === device.id) continue;
    if (entry.timestamp <= lastReset) continue;
    if (entry.model !== model || entry.ip !== ip) continue;
    const ageMs = now - entry.timestamp;
    if (ageMs < 0 || ageMs > SUSPICION_WINDOW_MS) continue;
    const minutes = Math.max(1, Math.round(ageMs / 60000));
    return `⚠️ ŞÜPHELİ: Bu tarayıcı kimliği yeni oluşturulmuş ve ${minutes} dk önce aynı ağdan, ` +
      `aynı model bir cihazdan ${entry.studentId} yoklama vermiş (gizli sekme / ikinci tarayıcı olabilir)`;
  }
  return '';
}
