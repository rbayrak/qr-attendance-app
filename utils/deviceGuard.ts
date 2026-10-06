// utils/deviceGuard.ts (yalnızca sunucuda kullanılır)
//
// "Her öğrenci yoklamayı yalnızca kendi telefonundan verebilsin" kuralı.
//
// Cihaz kimliği: her tarayıcıya sunucunun verdiği rastgele, kalıcı bir kimlik
// (HttpOnly çerez). Ekran/GPU/IP gibi özelliklerden cihaz tanımaya çalışmak
// aynı model telefonları ve kampüs Wi-Fi'ındaki herkesi aynı gösterdiği için
// kesin karar için kullanılmaz; rastgele kimlikte iki farklı telefon asla aynı
// kimliği almaz. Model ve IP yalnızca öğretmene uyarı göstermek için kullanılır.
//
// İki yönlü EŞLEŞTİRME:
//  1. Bir cihaz kimliğiyle yoklama veren öğrenci o cihazın sahibidir.
//  2. Öğrencinin yoklama verdiği cihaz onun kayıtlı cihazıdır.
// Kayıtlı cihazından gelen öğrencinin yoklaması hemen yazılır.
//
// Çerez silinince (tarayıcı verilerini temizleme, gizli sekme, başka tarayıcı,
// yeni telefon) gelen yeni kimlik, sunucu açısından "aynı telefonla başka
// öğrenci" denemesinden ayırt edilemez. Bu yüzden şu durumlar reddedilmez,
// ÖĞRETMEN ONAYINA düşer (ONAY BEKLİYOR satırı):
//  - öğrencinin kayıtlı cihazı farklı (cihaz değişmiş)
//  - bu cihaz başka bir öğrenciye kayıtlı (aynı telefondan iki öğrenci: güçlü uyarı)
//  - kayıt dönemi bittikten sonra ilk kez gelen öğrenci
// Öğretmen panelinde her bekleyen kaydın yanında, kayıt sayfasından hesaplanan
// uyarılar görünür (ör. "40 sn önce aynı ağdan, aynı model telefondan X yoklama
// verdi"). Onaylanınca yoklama yazılır ve öğrenci yeni cihazına kaydedilir.
// Onay beklenen kayıt yoklama sayılmaz; öğretmen bakmazsa hiçbir şey yazılmaz.
//
// Kayıt dönemi: son "Cihaz Kayıtlarını Temizle"den sonraki ilk 2 ders gününde
// herkes ilk telefonunu serbestçe kaydeder (ilk kez görülen kimlik + birkaç dk
// içinde aynı ağ/model telefondan başka öğrenci -> "ŞÜPHELİ" notu).
//
// İsteğe bağlı otomatik onay (öğretmen panelinden açılır): uyarısız bir cihaz
// değişikliği, öğrenci başına dönemde 1 kez öğretmene sorulmadan onaylanır.

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { LOG_COL, SheetRows } from '@/utils/sheets';
import { formatIstanbul, istanbulDayKey } from '@/utils/time';

const COOKIE_NAME = 'ytu_did';
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // tarayıcıların izin verdiği en uzun süre
const SUSPICION_WINDOW_MS = 5 * 60 * 1000;
// Bekleyen kayıtlarda benzer cihaz aranan zaman aralığı (öncesi ve sonrası)
const SIMILARITY_WINDOW_MS = 10 * 60 * 1000;
// Kayıt dönemi: son sıfırlamadan sonraki ilk bu kadar ders günü
export const REGISTRATION_CLASS_DAYS = 2;
// Bir günün "ders günü" sayılması için o gün yoklaması kaydedilen en az öğrenci
// (öğretmenin birkaç kişilik denemeleri kayıt dönemini bitirmesin)
const CLASS_DAY_MIN_STUDENTS = 10;
// Kayıt sayfasında saklanan kimlik uzunluğu (çakışma olasılığı ihmal edilebilir)
export const DEVICE_ID_LENGTH = 12;

export const RESULT = {
  recorded: 'KAYDEDİLDİ',
  pending: 'ONAY BEKLİYOR',
  rejected: 'REDDEDİLDİ',
  cancelled: 'İPTAL EDİLDİ',
  blocked: 'ENGELLENDİ',
  outOfLocation: 'KONUM DIŞI',
  cameraError: 'KAMERA HATASI',
  reset: 'SIFIRLAMA',
  release: 'CİHAZ SERBEST', // öğrencinin önceki cihaz eşleşmeleri artık sayılmaz
  setting: 'AYAR',
  legacy: 'ESKİ KAYIT' // eski biçimli hücreden aktarılan yoklama (cihaz kuralında kullanılmaz)
} as const;

// KAYDEDİLDİ satırlarının not başlangıçları
export const NOTE_AUTO_APPROVED = 'Otomatik onay';
export const NOTE_TEACHER_APPROVED = 'Öğretmen onayı';

const SETTING_AUTO_APPROVE = 'otomatikOnay';

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

// ---------------------------------------------------------------------------
// Kayıt sayfasının çözümlenmesi
// ---------------------------------------------------------------------------

export interface LogEntry {
  week: number;
  studentId: string;
  name: string;
  result: string;
  deviceId: string;
  model: string;
  ip: string;
  note: string;
  timestamp: number;
}

function parseLog(log: SheetRows): LogEntry[] {
  const entries: LogEntry[] = [];
  for (let i = 1; i < log.length; i++) {
    const row = log[i] || [];
    const timestamp = Number(row[LOG_COL.timestamp]);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    entries.push({
      week: Number(row[LOG_COL.week]) || 0,
      studentId: String(row[LOG_COL.studentId] ?? '').trim(),
      name: String(row[LOG_COL.name] ?? ''),
      result: String(row[LOG_COL.result] ?? ''),
      deviceId: String(row[LOG_COL.deviceId] ?? '').trim(),
      model: String(row[LOG_COL.model] ?? ''),
      ip: String(row[LOG_COL.ip] ?? ''),
      note: String(row[LOG_COL.note] ?? ''),
      timestamp
    });
  }
  // Toplu yazmalar sırayı karıştırabilir; kararlar zaman sırasına göre verilir
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

interface Binding {
  id: string; // cihaz kimliği ya da öğrenci numarası
  timestamp: number;
}

export interface DeviceAnalysis {
  entries: LogEntry[];
  lastResetAt: number;
  /** cihaz kimliği -> o cihazın sahibi olan öğrenci */
  deviceOwner: Map<string, Binding>;
  /** öğrenci numarası -> öğrencinin kayıtlı cihazı */
  studentDevice: Map<string, Binding>;
  /** Kayıt sayfasında (sıfırlamalardan bağımsız) yoklamada hiç görülmüş cihazlar */
  seenDevices: Set<string>;
  /** Son sıfırlamadan sonra otomatik onay hakkını kullanmış öğrenciler */
  autoApprovalUsed: Set<string>;
  /** Son sıfırlamadan sonra öğretmen ya da otomatik onayla cihaz değiştirme sayısı */
  approvalCount: Map<string, number>;
  autoApproveEnabled: boolean;
  /** Son sıfırlamadan sonraki ders günleri (gün anahtarı, sıralı) */
  classDays: string[];
}

/**
 * Kayıt sayfasından geçerli eşleştirmeleri ve ayarları çıkarır. Yalnızca
 * KAYDEDİLDİ satırları eşleştirme oluşturur; son SIFIRLAMA'dan ve öğrencinin
 * son CİHAZ SERBEST satırından önceki kayıtlar sayılmaz. Birden fazla eşleşme
 * varsa en yenisi geçerlidir.
 */
export function analyzeDevices(log: SheetRows): DeviceAnalysis {
  const entries = parseLog(log);
  let lastResetAt = 0;
  let autoApproveEnabled = false;
  const releasedAt = new Map<string, number>();
  for (const entry of entries) {
    if (entry.result === RESULT.reset) {
      lastResetAt = Math.max(lastResetAt, entry.timestamp);
    } else if (entry.result === RESULT.release && entry.studentId) {
      releasedAt.set(entry.studentId, Math.max(releasedAt.get(entry.studentId) ?? 0, entry.timestamp));
    } else if (entry.result === RESULT.setting) {
      const match = new RegExp(`^${SETTING_AUTO_APPROVE}=(\\d)`).exec(entry.note);
      if (match) autoApproveEnabled = match[1] === '1';
    }
  }

  const deviceOwner = new Map<string, Binding>();
  const studentDevice = new Map<string, Binding>();
  const seenDevices = new Set<string>();
  const autoApprovalUsed = new Set<string>();
  const approvalCount = new Map<string, number>();
  const studentsPerDay = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (entry.result !== RESULT.recorded || !entry.studentId) continue;
    if (entry.deviceId) seenDevices.add(entry.deviceId);
    if (entry.timestamp <= lastResetAt) continue;

    const day = istanbulDayKey(entry.timestamp);
    if (!studentsPerDay.has(day)) studentsPerDay.set(day, new Set());
    studentsPerDay.get(day)!.add(entry.studentId);

    if (entry.note.startsWith(NOTE_AUTO_APPROVED)) autoApprovalUsed.add(entry.studentId);
    if (entry.note.startsWith(NOTE_AUTO_APPROVED) || entry.note.startsWith(NOTE_TEACHER_APPROVED)) {
      approvalCount.set(entry.studentId, (approvalCount.get(entry.studentId) ?? 0) + 1);
    }

    if (!entry.deviceId) continue;
    if (entry.timestamp <= (releasedAt.get(entry.studentId) ?? 0)) continue;
    deviceOwner.set(entry.deviceId, { id: entry.studentId, timestamp: entry.timestamp });
    studentDevice.set(entry.studentId, { id: entry.deviceId, timestamp: entry.timestamp });
  }

  const classDays = [...studentsPerDay.entries()]
    .filter(([, students]) => students.size >= CLASS_DAY_MIN_STUDENTS)
    .map(([day]) => day)
    .sort();

  return {
    entries, lastResetAt, deviceOwner, studentDevice, seenDevices,
    autoApprovalUsed, approvalCount, autoApproveEnabled, classDays
  };
}

/** Kayıt dönemi açık mı? (bugünden önceki ders günü sayısı sınırın altında) */
export function isRegistrationOpen(analysis: DeviceAnalysis, now: number): boolean {
  const today = istanbulDayKey(now);
  return analysis.classDays.filter(day => day < today).length < REGISTRATION_CLASS_DAYS;
}

export function settingRow(now: number, autoApprove: boolean): string[] {
  return buildLogRow({
    now, week: '', studentId: '', name: '', result: RESULT.setting,
    deviceId: '', model: '', ip: '',
    note: `${SETTING_AUTO_APPROVE}=${autoApprove ? 1 : 0} (öğretmen panelinden ${autoApprove ? 'açıldı' : 'kapatıldı'})`
  });
}

// ---------------------------------------------------------------------------
// Yoklama anındaki karar
// ---------------------------------------------------------------------------

export type PendingReason =
  | { code: 'deviceChanged' }
  | { code: 'deviceOwnedByOther'; otherStudentId: string }
  | { code: 'firstRegistration' };

export type DeviceDecision =
  | { kind: 'registered' }           // öğrencinin kayıtlı cihazı
  | { kind: 'register' }             // kayıt dönemi: ilk cihaz serbestçe kaydedilir
  | { kind: 'pending'; reason: PendingReason };

export function decideDevice(
  analysis: DeviceAnalysis,
  deviceId: string,
  studentId: string,
  now: number
): DeviceDecision {
  const owner = analysis.deviceOwner.get(deviceId);
  if (owner && owner.id !== studentId) {
    return { kind: 'pending', reason: { code: 'deviceOwnedByOther', otherStudentId: owner.id } };
  }
  const registered = analysis.studentDevice.get(studentId);
  if (registered) {
    return registered.id === deviceId
      ? { kind: 'registered' }
      : { kind: 'pending', reason: { code: 'deviceChanged' } };
  }
  return isRegistrationOpen(analysis, now)
    ? { kind: 'register' }
    : { kind: 'pending', reason: { code: 'firstRegistration' } };
}

// Bekleyen satırın notunun başındaki neden etiketi
const REASON_TAGS = {
  deviceChanged: '[CİHAZ DEĞİŞTİ]',
  deviceOwnedByOther: '[TELEFON BAŞKASINA KAYITLI:',
  firstRegistration: '[İLK KAYIT]'
};

export function reasonTag(reason: PendingReason): string {
  return reason.code === 'deviceOwnedByOther'
    ? `${REASON_TAGS.deviceOwnedByOther} ${reason.otherStudentId}]`
    : REASON_TAGS[reason.code];
}

export function parseReasonTag(note: string): PendingReason {
  const owned = /^\[TELEFON BAŞKASINA KAYITLI: ([^\]]+)\]/.exec(note);
  if (owned) return { code: 'deviceOwnedByOther', otherStudentId: owned[1] };
  if (note.startsWith(REASON_TAGS.firstRegistration)) return { code: 'firstRegistration' };
  return { code: 'deviceChanged' };
}

export function reasonLabel(reason: PendingReason, nameOf: (id: string) => string): string {
  switch (reason.code) {
    case 'deviceChanged': return 'Telefonu / tarayıcısı değişmiş';
    case 'firstRegistration': return 'İlk kez yoklama veriyor (kayıt dönemi bitti)';
    case 'deviceOwnedByOther':
      return `Bu telefon ${reason.otherStudentId} ${nameOf(reason.otherStudentId)} adına kayıtlı`;
  }
}

// ---------------------------------------------------------------------------
// Öğretmene gösterilen uyarılar
// ---------------------------------------------------------------------------

export type WarningLevel = 'clean' | 'weak' | 'strong';

export interface Warning {
  level: 'weak' | 'strong';
  text: string;
}

function timeDistance(ms: number): string {
  const abs = Math.abs(ms);
  const amount = abs < 60000 ? `${Math.max(1, Math.round(abs / 1000))} sn` : `${Math.round(abs / 60000)} dk`;
  return `${amount} ${ms >= 0 ? 'önce' : 'sonra'}`;
}

/**
 * Bir cihaz değişikliği / onay bekleyen kayıt için uyarılar. `until` verilirse
 * yalnızca o andan önceki satırlara bakılır (yoklama anındaki karar); verilmezse
 * sonradan gelen satırlar da hesaba katılır (öğretmen panelinde güncel durum).
 */
export function warningsFor(
  analysis: DeviceAnalysis,
  subject: { studentId: string; week: number; deviceId: string; model: string; ip: string; timestamp: number },
  reason: PendingReason,
  nameOf: (id: string) => string,
  until?: number
): { level: WarningLevel; warnings: Warning[] } {
  const warnings: Warning[] = [];

  if (reason.code === 'deviceOwnedByOther') {
    warnings.push({
      level: 'strong',
      text: `Bu telefon ${reason.otherStudentId} ${nameOf(reason.otherStudentId)} adına kayıtlı: aynı telefondan iki öğrenci`
    });
  }

  const modelKnown = !!subject.model && subject.model !== 'unknown';
  if (!modelKnown) {
    warnings.push({ level: 'weak', text: 'Telefon modeli alınamadı, benzer cihaz kontrolü yapılamadı' });
  }

  let sameNetwork: LogEntry | null = null;
  let sameModelOnly: LogEntry | null = null;
  let sameBrowser: LogEntry | null = null;
  let sameModelCount = 0;
  for (const entry of analysis.entries) {
    if (until !== undefined && entry.timestamp >= until) break;
    if (entry.result !== RESULT.recorded && entry.result !== RESULT.pending) continue;
    if (entry.studentId === subject.studentId || entry.timestamp <= analysis.lastResetAt) continue;
    const delta = subject.timestamp - entry.timestamp;
    if (Math.abs(delta) > SIMILARITY_WINDOW_MS) continue;
    const closer = (current: LogEntry | null) =>
      !current || Math.abs(subject.timestamp - entry.timestamp) < Math.abs(subject.timestamp - current.timestamp);
    if (entry.deviceId && entry.deviceId === subject.deviceId && reason.code !== 'deviceOwnedByOther') {
      if (closer(sameBrowser)) sameBrowser = entry;
    }
    if (!modelKnown || entry.model !== subject.model) continue;
    sameModelCount++;
    if (entry.ip && entry.ip === subject.ip) {
      if (closer(sameNetwork)) sameNetwork = entry;
    } else if (closer(sameModelOnly)) {
      sameModelOnly = entry;
    }
  }

  const describe = (entry: LogEntry) =>
    `${timeDistance(subject.timestamp - entry.timestamp)} ${entry.studentId} ${nameOf(entry.studentId)} ` +
    (entry.result === RESULT.pending ? 'için onay istendi' : 'yoklama verdi');
  if (sameBrowser) {
    warnings.push({ level: 'strong', text: `Aynı tarayıcıdan ${describe(sameBrowser)}` });
  }
  if (sameNetwork) {
    warnings.push({ level: 'strong', text: `Aynı ağdan ve aynı model telefondan ${describe(sameNetwork)}` });
  } else if (sameModelOnly) {
    warnings.push({
      level: 'weak',
      text: `Aynı model telefondan (farklı ağ) ${describe(sameModelOnly)}` +
        (sameModelCount > 1 ? `; bu aralıkta aynı modelden ${sameModelCount} kayıt var` : '')
    });
  }

  for (const entry of analysis.entries) {
    if (until !== undefined && entry.timestamp >= until) break;
    if (entry.result === RESULT.rejected && entry.studentId === subject.studentId &&
      entry.week === subject.week && entry.timestamp > analysis.lastResetAt && entry.timestamp < subject.timestamp) {
      warnings.push({ level: 'weak', text: 'Bu hafta için daha önce bir onay isteği reddedilmiş' });
      break;
    }
  }

  const changes = analysis.approvalCount.get(subject.studentId) ?? 0;
  if (changes >= 2) {
    warnings.push({ level: 'weak', text: `Bu dönem ${changes} kez cihaz değişikliği onaylanmış` });
  }

  const level: WarningLevel = warnings.some(w => w.level === 'strong')
    ? 'strong'
    : warnings.length > 0 ? 'weak' : 'clean';
  return { level, warnings };
}

// ---------------------------------------------------------------------------
// Onay bekleyenler ve otomatik onaylananlar
// ---------------------------------------------------------------------------

/** Sonuçlanmamış (onaylanmamış/reddedilmemiş) en son bekleyen kayıtlar; öğrenci+hafta başına bir tane. */
export function openPendingEntries(analysis: DeviceAnalysis): LogEntry[] {
  const latest = new Map<string, LogEntry>();
  const resolvedAt = new Map<string, number>();
  const key = (entry: LogEntry) => `${entry.studentId}|${entry.week}`;
  for (const entry of analysis.entries) {
    if (entry.timestamp <= analysis.lastResetAt || !entry.studentId) continue;
    if (entry.result === RESULT.pending) {
      latest.set(key(entry), entry);
    } else if (entry.result === RESULT.recorded || entry.result === RESULT.rejected) {
      resolvedAt.set(key(entry), Math.max(resolvedAt.get(key(entry)) ?? 0, entry.timestamp));
    }
  }
  return [...latest.values()]
    .filter(entry => entry.timestamp > (resolvedAt.get(key(entry)) ?? 0))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** Bugün otomatik onaylanan ve iptal edilmemiş kayıtlar */
export function autoApprovedToday(analysis: DeviceAnalysis, now: number): LogEntry[] {
  const today = istanbulDayKey(now);
  const cancelledAt = new Map<string, number>();
  for (const entry of analysis.entries) {
    if (entry.result === RESULT.cancelled) {
      const k = `${entry.studentId}|${entry.week}`;
      cancelledAt.set(k, Math.max(cancelledAt.get(k) ?? 0, entry.timestamp));
    }
  }
  return analysis.entries
    .filter(entry => entry.result === RESULT.recorded && entry.note.startsWith(NOTE_AUTO_APPROVED) &&
      entry.timestamp > analysis.lastResetAt && istanbulDayKey(entry.timestamp) === today &&
      entry.timestamp > (cancelledAt.get(`${entry.studentId}|${entry.week}`) ?? 0))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** Kayıt döneminde ilk kez görülen kimlik için "ŞÜPHELİ" notu (engellemez). */
export function findSuspicion(
  analysis: DeviceAnalysis,
  params: { device: DeviceIdentity; model: string; ip: string; studentId: string; now: number }
): string {
  const { device, model, ip, studentId, now } = params;
  // Daha önce yoklamada kullanılmış bir cihaz "yeni kimlik" değildir
  if (analysis.seenDevices.has(device.id) || !model || model === 'unknown' || !ip) return '';
  for (const entry of analysis.entries) {
    if (entry.result !== RESULT.recorded) continue;
    if (entry.studentId === studentId || entry.deviceId === device.id) continue;
    if (entry.timestamp <= analysis.lastResetAt) continue;
    if (entry.model !== model || entry.ip !== ip) continue;
    const ageMs = now - entry.timestamp;
    if (ageMs < 0 || ageMs > SUSPICION_WINDOW_MS) continue;
    const minutes = Math.max(1, Math.round(ageMs / 60000));
    return `⚠️ ŞÜPHELİ: Bu tarayıcı kimliği ilk kez kullanılıyor ve ${minutes} dk önce aynı ağdan, ` +
      `aynı model bir cihazdan ${entry.studentId} yoklama vermiş (çerez silme / gizli sekme / ikinci tarayıcı olabilir)`;
  }
  return '';
}
