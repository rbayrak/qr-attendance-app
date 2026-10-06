// utils/deviceGuard.ts (yalnızca sunucuda kullanılır)
//
// "Her öğrenci yoklamayı yalnızca kendi telefonundan verebilsin" kuralı.
//
// Cihaz kimliği: her tarayıcıya sunucunun verdiği rastgele, kalıcı bir kimlik
// (HttpOnly çerez). Ekran/GPU/IP gibi özelliklerden cihaz tanımaya çalışmak
// aynı model telefonları ve kampüs Wi-Fi'ındaki herkesi aynı gösterdiği için
// kullanılmaz; rastgele kimlikte iki farklı telefon asla aynı kimliği almaz.
//
// Çerez telefonda silinebilir (tarayıcı verilerini temizleme, gizli sekme,
// başka tarayıcı). Silinen çerezin yerine gelen yeni kimlik, sunucu açısından
// yeni bir telefondan ayırt edilemez. Bu yüzden kural iki yönlü EŞLEŞTİRMEDİR:
//  1. Bir cihaz kimliğiyle yoklama veren ilk öğrenci o cihazın sahibidir;
//     o cihazla başka öğrenci yoklama veremez (gün/QR fark etmez).
//  2. Bir öğrencinin yoklama verdiği ilk cihaz onun kayıtlı cihazıdır; o
//     öğrenci adına başka (ör. çerezi silinmiş, yeni) bir kimlikten yoklama
//     verilemez.
// Böylece "kendi yoklamasını ver, çerezleri sil, arkadaşı için tekrar ver"
// işe yaramaz: arkadaşın kayıtlı cihazı farklıdır. Telefonunu değiştiren ya da
// tarayıcı verilerini silen öğrenci için öğretmen panelinden o öğrencinin
// cihaz kaydı sıfırlanır (CİHAZ SERBEST satırı); bir sonraki yoklamasında yeni
// cihazı kaydedilir. "Cihaz Kayıtlarını Temizle" (SIFIRLAMA) herkesinkini siler.
//
// Henüz hiç yoklama vermemiş bir öğrenci için yeni bir kimlik engellenemez
// (ilk hafta herkes böyledir); kimlik ilk kez görülüyorsa ve birkaç dakika
// içinde aynı ağdan, aynı model bir cihazdan başka bir öğrenci yoklama verdiyse
// kayıt "ŞÜPHELİ" olarak işaretlenir.

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { LOG_COL, SheetRows } from '@/utils/sheets';
import { formatIstanbul } from '@/utils/time';

const COOKIE_NAME = 'ytu_did';
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // tarayıcıların izin verdiği en uzun süre
const SUSPICION_WINDOW_MS = 5 * 60 * 1000;
// Kayıt sayfasında saklanan kimlik uzunluğu (çakışma olasılığı ihmal edilebilir)
export const DEVICE_ID_LENGTH = 12;

export const RESULT = {
  recorded: 'KAYDEDİLDİ',
  blocked: 'ENGELLENDİ',
  outOfLocation: 'KONUM DIŞI',
  cameraError: 'KAMERA HATASI',
  reset: 'SIFIRLAMA',
  release: 'CİHAZ SERBEST', // öğretmen tek bir öğrencinin cihaz kaydını sıfırladı
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
  id: string; // kayıt sayfasına yazılan kısa kimlik
}

function readCookie(req: NextApiRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return undefined; // bozuk çerez: yenisi verilir
    }
  }
  return undefined;
}

/** Tarayıcının cihaz kimliğini çerezden okur; yoksa oluşturup çerezi ayarlar. */
export function getDeviceIdentity(req: NextApiRequest, res: NextApiResponse): DeviceIdentity {
  const raw = readCookie(req, COOKIE_NAME);
  // Çerezdeki oluşturulma zamanı yalnızca biçim uyumluluğu için duruyor; istemci
  // değiştirebileceği için hiçbir kararda kullanılmaz
  const match = raw ? /^([0-9a-f]{32})\.(\d{13})$/.exec(raw) : null;
  let token: string;

  if (match) {
    token = match[1];
  } else {
    token = randomUUID().replace(/-/g, '');
    const forwardedProto = req.headers['x-forwarded-proto'];
    const isHttps = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) === 'https';
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${token}.${Date.now()}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax` +
      (isHttps ? '; Secure' : ''));
  }

  return { id: token.slice(0, DEVICE_ID_LENGTH) };
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
      deviceId: String(row[LOG_COL.deviceId] ?? '').trim(),
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

interface Binding {
  id: string; // cihaz kimliği ya da öğrenci numarası
  timestamp: number;
}

export interface DeviceBindings {
  /** cihaz kimliği -> o cihazın sahibi olan öğrenci */
  deviceOwner: Map<string, Binding>;
  /** öğrenci numarası -> öğrencinin kayıtlı cihazı */
  studentDevice: Map<string, Binding>;
  /** Kayıt sayfasında yoklamada (sıfırlamalardan bağımsız) hiç görülmüş cihazlar */
  seenDevices: Set<string>;
  entries: LogEntry[];
  lastResetAt: number;
}

/**
 * Kayıt sayfasından geçerli eşleştirmeleri çıkarır. Yalnızca KAYDEDİLDİ satırları
 * eşleştirme oluşturur; son SIFIRLAMA'dan ve öğrencinin son CİHAZ SERBEST
 * satırından önceki kayıtlar sayılmaz. Birden fazla eşleşme varsa en yenisi geçerlidir.
 */
export function getDeviceBindings(log: SheetRows): DeviceBindings {
  const entries = parseLog(log);
  let lastResetAt = 0;
  const releasedAt = new Map<string, number>();
  for (const entry of entries) {
    if (entry.result === RESULT.reset && entry.timestamp > lastResetAt) {
      lastResetAt = entry.timestamp;
    } else if (entry.result === RESULT.release && entry.studentId &&
      entry.timestamp > (releasedAt.get(entry.studentId) ?? 0)) {
      releasedAt.set(entry.studentId, entry.timestamp);
    }
  }

  const deviceOwner = new Map<string, Binding>();
  const studentDevice = new Map<string, Binding>();
  const seenDevices = new Set<string>();
  for (const entry of entries) {
    if (entry.result !== RESULT.recorded || !entry.deviceId || !entry.studentId) continue;
    seenDevices.add(entry.deviceId);
    if (entry.timestamp <= lastResetAt) continue;
    if (entry.timestamp <= (releasedAt.get(entry.studentId) ?? 0)) continue;
    const owner = deviceOwner.get(entry.deviceId);
    if (!owner || entry.timestamp >= owner.timestamp) {
      deviceOwner.set(entry.deviceId, { id: entry.studentId, timestamp: entry.timestamp });
    }
    const device = studentDevice.get(entry.studentId);
    if (!device || entry.timestamp >= device.timestamp) {
      studentDevice.set(entry.studentId, { id: entry.deviceId, timestamp: entry.timestamp });
    }
  }

  return { deviceOwner, studentDevice, seenDevices, entries, lastResetAt };
}

export type DeviceConflict =
  // Bu cihaz başka bir öğrenciye kayıtlı
  | { kind: 'deviceOwnedByOther'; otherStudentId: string }
  // Öğrencinin kayıtlı cihazı başka (bu cihaz yeni ya da başka tarayıcı)
  | { kind: 'studentBoundElsewhere'; registeredDeviceId: string };

/** Bu öğrenci bu cihazla yoklama veremiyorsa nedenini döndürür. */
export function findDeviceConflict(
  bindings: DeviceBindings,
  deviceId: string,
  studentId: string
): DeviceConflict | null {
  const owner = bindings.deviceOwner.get(deviceId);
  if (owner && owner.id !== studentId) {
    return { kind: 'deviceOwnedByOther', otherStudentId: owner.id };
  }
  const registered = bindings.studentDevice.get(studentId);
  if (registered && registered.id !== deviceId) {
    return { kind: 'studentBoundElsewhere', registeredDeviceId: registered.id };
  }
  return null;
}

/** Engellenmeyen ama öğretmenin bakması gereken durumlar için not üretir. */
export function findSuspicion(
  bindings: DeviceBindings,
  params: { device: DeviceIdentity; model: string; ip: string; studentId: string; now: number }
): string {
  const { device, model, ip, studentId, now } = params;
  // Daha önce yoklamada kullanılmış bir cihaz "yeni kimlik" değildir
  if (bindings.seenDevices.has(device.id) || !model || model === 'unknown' || !ip) return '';
  for (const entry of bindings.entries) {
    if (entry.result !== RESULT.recorded) continue;
    if (entry.studentId === studentId || entry.deviceId === device.id) continue;
    if (entry.timestamp <= bindings.lastResetAt) continue;
    if (entry.model !== model || entry.ip !== ip) continue;
    const ageMs = now - entry.timestamp;
    if (ageMs < 0 || ageMs > SUSPICION_WINDOW_MS) continue;
    const minutes = Math.max(1, Math.round(ageMs / 60000));
    return `⚠️ ŞÜPHELİ: Bu tarayıcı kimliği ilk kez kullanılıyor ve ${minutes} dk önce aynı ağdan, ` +
      `aynı model bir cihazdan ${entry.studentId} yoklama vermiş (çerez silme / gizli sekme / ikinci tarayıcı olabilir)`;
  }
  return '';
}
