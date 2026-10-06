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
// Kanıtın gücüne göre üç sonuç:
//  - KESİN RET (ENGELLENDİ): aynı tarayıcıdan (çerez silinmemiş) ikinci bir
//    öğrenci. Tahmin değil, kesin kanıt; yoklama alınmaz. Telefonu bozuk öğrenci
//    için öğretmen panelinden "yine de yoklama ver" denebilir (cihaz kaydı değişmez).
//  - ÖĞRETMEN ONAYI (ONAY BEKLİYOR, yoklama sayılmaz):
//      * öğrencinin kayıtlı cihazı farklı (çerez silinmiş, gizli sekme, yeni telefon)
//      * kayıt dönemi bittikten sonra ilk kez gelen öğrenci
//      * kayıt döneminde bile şüpheli yeni kayıt: son 5 dk içinde aynı ağdan ve
//        aynı cihaz imzasıyla başka öğrenci yoklama verdi/denedi (çerez silinip
//        aynı telefondan tekrar deneniyor olabilir), ya da bu öğrenci için bugün
//        başka öğrencinin tarayıcısından denendi, ya da öğrencinin bekleyen isteği var
//  - KAYIT: kayıtlı cihaz ya da kayıt döneminde temiz ilk kayıt.
// Aynı Wi-Fi'daki aynı model iki telefon sunucuya aynı görünebildiği için
// tahmine dayalı durumlar reddedilmez, öğretmene bırakılır.
//
// Cihaz imzası: "hhhhhhhh-dddddd". İlk kısım donanım özellikleri (ekran, GPU vb.;
// aynı model telefonlarda aynı), ikinci kısım tarayıcı sürümü, dil, karanlık mod,
// depolama kotası ve Android'de telefon modeli gibi ayrıntılar. Çerez silinince
// ikisi de değişmez. Tam imza + aynı ağ = güçlü benzerlik; yalnızca donanım
// kısmı aynı = zayıf benzerlik (aynı model başka telefon ya da ağ/ayar değiştirmiş).
//
// Kayıt dönemi: son "Cihaz Kayıtlarını Temizle"den sonraki ilk 2 ders günü.
// İsteğe bağlı otomatik onay: uyarısız cihaz değişikliği, öğrenci başına dönemde 1 kez.

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID, createHash } from 'crypto';
import { LOG_COL, SheetRows } from '@/utils/sheets';
import { formatIstanbul, istanbulDayKey } from '@/utils/time';

const COOKIE_NAME = 'ytu_did';
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // tarayıcıların izin verdiği en uzun süre
// Kayıt döneminde bile yeni kaydı onaya düşüren benzerlik süresi
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
  // Öğretmen panelindeki bildirim listelerini temizledi (bekleyen istekler onaylanmamış sayılır)
  clearNotifications: 'BİLDİRİMLER TEMİZLENDİ',
  legacy: 'ESKİ KAYIT' // eski biçimli hücreden aktarılan yoklama (cihaz kuralında kullanılmaz)
} as const;

// KAYDEDİLDİ satırlarının not başlangıçları
export const NOTE_AUTO_APPROVED = 'Otomatik onay';
export const NOTE_TEACHER_APPROVED = 'Öğretmen onayı';
export const NOTE_FIRST_REGISTRATION = 'İlk kayıt';
// Öğretmenin reddedilen bir denemeye rağmen yoklama vermesi (cihaz kaydı değişmez)
export const NOTE_TEACHER_OVERRIDE = 'Öğretmen kararı';
// Aynı tarayıcıdan ikinci öğrenci denemesi (ENGELLENDİ satırının not etiketi)
const SAME_BROWSER_TAG = '[AYNI TARAYICI:';

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
// Cihaz imzası
// ---------------------------------------------------------------------------

const HARDWARE_PART_LENGTH = 8;

/**
 * "hhhhhhhh-dddddd": donanım imzası + tarayıcı ayrıntılarının özeti.
 * Donanım imzası alınamadıysa "unknown". İstemciden geldiği için yalnızca
 * öğretmene uyarı göstermekte ve onaya düşürmekte kullanılır, asla tek başına
 * yoklama vermek için kullanılmaz.
 */
export function deviceModel(hardwareSignature: unknown, userAgent: string, detail: unknown): string {
  if (typeof hardwareSignature !== 'string' || !/^[0-9a-f]{8}/i.test(hardwareSignature)) return 'unknown';
  const extra = typeof detail === 'string' ? detail.slice(0, 300) : '';
  const digest = createHash('sha256').update(`${userAgent}|${extra}`).digest('hex').slice(0, 6);
  return `${hardwareSignature.slice(0, HARDWARE_PART_LENGTH).toLowerCase()}-${digest}`;
}

function isKnownModel(model: string): boolean {
  return /^[0-9a-f]{8}/i.test(model);
}

/** Donanım kısmı aynı mı? (aynı model telefon; eski 8 karakterlik kayıtlarla da çalışır) */
function sameHardware(a: string, b: string): boolean {
  return isKnownModel(a) && isKnownModel(b) &&
    a.slice(0, HARDWARE_PART_LENGTH).toLowerCase() === b.slice(0, HARDWARE_PART_LENGTH).toLowerCase();
}

/** Tam imza aynı mı? (ayrıntı kısmı olmayan eski kayıtlarda yalnızca donanım karşılaştırılır) */
function sameFullModel(a: string, b: string): boolean {
  if (!sameHardware(a, b)) return false;
  return a.length <= HARDWARE_PART_LENGTH || b.length <= HARDWARE_PART_LENGTH || a.toLowerCase() === b.toLowerCase();
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
  /** Öğretmenin son "Bildirimleri temizle" zamanı (listeler bundan sonrasını gösterir) */
  lastClearAt: number;
  /** cihaz kimliği -> o cihazın sahibi olan öğrenci */
  deviceOwner: Map<string, Binding>;
  /** öğrenci numarası -> öğrencinin kayıtlı cihazı */
  studentDevice: Map<string, Binding>;
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
  let lastClearAt = 0;
  let autoApproveEnabled = false;
  const releasedAt = new Map<string, number>();
  for (const entry of entries) {
    if (entry.result === RESULT.reset) {
      lastResetAt = Math.max(lastResetAt, entry.timestamp);
    } else if (entry.result === RESULT.clearNotifications) {
      lastClearAt = Math.max(lastClearAt, entry.timestamp);
    } else if (entry.result === RESULT.release && entry.studentId) {
      releasedAt.set(entry.studentId, Math.max(releasedAt.get(entry.studentId) ?? 0, entry.timestamp));
    } else if (entry.result === RESULT.setting) {
      const match = new RegExp(`^${SETTING_AUTO_APPROVE}=(\\d)`).exec(entry.note);
      if (match) autoApproveEnabled = match[1] === '1';
    }
  }

  const deviceOwner = new Map<string, Binding>();
  const studentDevice = new Map<string, Binding>();
  const autoApprovalUsed = new Set<string>();
  const approvalCount = new Map<string, number>();
  const studentsPerDay = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (entry.result !== RESULT.recorded || !entry.studentId) continue;
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
    entries, lastResetAt, lastClearAt, deviceOwner, studentDevice,
    autoApprovalUsed, approvalCount, autoApproveEnabled, classDays
  };
}

/** Kayıt dönemi açık mı? (bugünden önceki ders günü sayısı sınırın altında) */
export function isRegistrationOpen(analysis: DeviceAnalysis, now: number): boolean {
  const today = istanbulDayKey(now);
  return analysis.classDays.filter(day => day < today).length < REGISTRATION_CLASS_DAYS;
}

export function clearNotificationsRow(now: number): string[] {
  return buildLogRow({
    now, week: '', studentId: '', name: '', result: RESULT.clearNotifications,
    deviceId: '', model: '', ip: '', note: 'Öğretmen bildirim listelerini temizledi'
  });
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
  | { code: 'deviceOwnedByOther'; otherStudentId: string } // eski sürümün satırları için
  | { code: 'firstRegistration' }
  | { code: 'suspiciousRegistration' };

export type DeviceDecision =
  | { kind: 'registered' }           // öğrencinin kayıtlı cihazı
  | { kind: 'register' }             // kayıt dönemi: temiz ilk kayıt
  | { kind: 'reject'; otherStudentId: string } // aynı tarayıcı başka öğrenciye kayıtlı
  | { kind: 'pending'; reason: PendingReason };

export interface DeviceRequest {
  deviceId: string;
  studentId: string;
  model: string;
  ip: string;
  now: number;
}

function isSameBrowserBlock(entry: LogEntry): boolean {
  return entry.result === RESULT.blocked && entry.note.startsWith(SAME_BROWSER_TAG);
}

export function sameBrowserNote(otherStudentId: string): string {
  return `${SAME_BROWSER_TAG} ${otherStudentId}] Bu tarayıcı başka bir öğrenci tarafından kullanılıyor; yoklama reddedildi`;
}

function sameBrowserOther(entry: LogEntry): string {
  return /^\[AYNI TARAYICI: ([^\]]+)\]/.exec(entry.note)?.[1] ?? '';
}

/**
 * Kayıt döneminde yeni bir kayıt şüpheli mi? (yalnızca geçmiş satırlara bakar)
 * Çerezini silip aynı telefondan arkadaşı için tekrar deneyen birinin izleri.
 */
function isSuspiciousRegistration(analysis: DeviceAnalysis, request: DeviceRequest): boolean {
  const today = istanbulDayKey(request.now);
  if (openPendingEntries(analysis).some(entry => entry.studentId === request.studentId)) return true;
  for (const entry of analysis.entries) {
    if (entry.timestamp >= request.now) break;
    if (entry.timestamp <= analysis.lastResetAt) continue;
    if (entry.studentId === request.studentId) {
      if (isSameBrowserBlock(entry) && istanbulDayKey(entry.timestamp) === today) return true;
      continue;
    }
    if (entry.result !== RESULT.recorded && entry.result !== RESULT.pending && entry.result !== RESULT.rejected) continue;
    // Bu tarayıcı daha önce başka bir öğrenci için kullanılmış (ör. o istek reddedilmiş): süre sınırı yok
    if (entry.deviceId && entry.deviceId === request.deviceId) return true;
    if (entry.result === RESULT.rejected) continue;
    if (request.now - entry.timestamp > SUSPICION_WINDOW_MS) continue;
    if (sameFullModel(entry.model, request.model) && entry.ip && entry.ip === request.ip) return true;
  }
  return false;
}

/**
 * Bu tarayıcıyı şu an kim kullanıyor? Kayıtlı sahibi ya da bu tarayıcıdan
 * gönderilmiş, henüz sonuçlanmamış bir onay isteğinin sahibi.
 */
export function browserClaimant(analysis: DeviceAnalysis, deviceId: string, studentId: string): string | null {
  const owner = analysis.deviceOwner.get(deviceId);
  if (owner && owner.id !== studentId) return owner.id;
  const claim = openPendingEntries(analysis)
    .find(entry => entry.deviceId === deviceId && entry.studentId !== studentId);
  return claim ? claim.studentId : null;
}

export function decideDevice(analysis: DeviceAnalysis, request: DeviceRequest): DeviceDecision {
  const { deviceId, studentId, now } = request;
  // Aynı tarayıcı (çerez) başka bir öğrenci tarafından kullanılıyor: kesin kanıt
  const claimant = browserClaimant(analysis, deviceId, studentId);
  if (claimant) {
    return { kind: 'reject', otherStudentId: claimant };
  }
  const registered = analysis.studentDevice.get(studentId);
  if (registered) {
    return registered.id === deviceId
      ? { kind: 'registered' }
      : { kind: 'pending', reason: { code: 'deviceChanged' } };
  }
  if (!isRegistrationOpen(analysis, now)) {
    return { kind: 'pending', reason: { code: 'firstRegistration' } };
  }
  return isSuspiciousRegistration(analysis, request)
    ? { kind: 'pending', reason: { code: 'suspiciousRegistration' } }
    : { kind: 'register' };
}

// Bekleyen satırın notunun başındaki neden etiketi
const REASON_TAGS = {
  deviceChanged: '[CİHAZ DEĞİŞTİ]',
  deviceOwnedByOther: '[TELEFON BAŞKASINA KAYITLI:',
  firstRegistration: '[İLK KAYIT]',
  suspiciousRegistration: '[ŞÜPHELİ YENİ KAYIT]'
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
  if (note.startsWith(REASON_TAGS.suspiciousRegistration)) return { code: 'suspiciousRegistration' };
  return { code: 'deviceChanged' };
}

export function reasonLabel(reason: PendingReason, nameOf: (id: string) => string): string {
  switch (reason.code) {
    case 'deviceChanged': return 'Telefonu / tarayıcısı değişmiş (çerezler silinmiş, gizli sekme ya da yeni telefon olabilir)';
    case 'firstRegistration': return 'İlk kez yoklama veriyor (kayıt dönemi bitti)';
    case 'suspiciousRegistration': return 'Yeni tarayıcıdan ilk kayıt; aynı telefondan başka öğrenci olabilir';
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
  until?: number,
  options: { recordedOnly?: boolean } = {}
): { level: WarningLevel; warnings: Warning[] } {
  const warnings: Warning[] = [];

  if (reason.code === 'deviceOwnedByOther') {
    warnings.push({
      level: 'strong',
      text: `Bu telefon ${reason.otherStudentId} ${nameOf(reason.otherStudentId)} adına kayıtlı: aynı telefondan iki öğrenci`
    });
  }

  const modelKnown = isKnownModel(subject.model);
  if (!modelKnown) {
    warnings.push({ level: 'weak', text: 'Telefon modeli alınamadı, benzer cihaz kontrolü yapılamadı' });
  }

  let sameNetwork: LogEntry | null = null;
  let sameModelOnly: LogEntry | null = null;
  let sameBrowser: LogEntry | null = null;
  let sameModelCount = 0;
  for (const entry of analysis.entries) {
    if (until !== undefined && entry.timestamp >= until) break;
    if (entry.result !== RESULT.recorded && (options.recordedOnly || entry.result !== RESULT.pending)) continue;
    if (entry.studentId === subject.studentId || entry.timestamp <= analysis.lastResetAt) continue;
    const delta = subject.timestamp - entry.timestamp;
    if (Math.abs(delta) > SIMILARITY_WINDOW_MS) continue;
    const closer = (current: LogEntry | null) =>
      !current || Math.abs(subject.timestamp - entry.timestamp) < Math.abs(subject.timestamp - current.timestamp);
    if (!modelKnown || !sameHardware(entry.model, subject.model)) continue;
    sameModelCount++;
    // Yüksek risk: 5 dk içinde aynı ağdan, aynı cihaz imzasıyla başka öğrenci (aynı telefon olabilir)
    if (sameFullModel(entry.model, subject.model) && entry.ip && entry.ip === subject.ip &&
      Math.abs(delta) <= SUSPICION_WINDOW_MS) {
      if (closer(sameNetwork)) sameNetwork = entry;
    } else if (closer(sameModelOnly)) {
      sameModelOnly = entry;
    }
  }

  // Aynı tarayıcı (çerez) başka öğrenci için kullanılmış mı? (süre sınırı yok)
  if (reason.code !== 'deviceOwnedByOther' && subject.deviceId) {
    for (const entry of analysis.entries) {
      if (until !== undefined && entry.timestamp >= until) break;
      if (entry.timestamp <= analysis.lastResetAt || entry.studentId === subject.studentId) continue;
      if (entry.deviceId !== subject.deviceId) continue;
      if (entry.result !== RESULT.recorded && (options.recordedOnly || entry.result !== RESULT.pending)) continue;
      if (!sameBrowser || Math.abs(subject.timestamp - entry.timestamp) < Math.abs(subject.timestamp - sameBrowser.timestamp)) {
        sameBrowser = entry;
      }
    }
  }

  const describe = (entry: LogEntry) =>
    `${timeDistance(subject.timestamp - entry.timestamp)} ${entry.studentId} ${nameOf(entry.studentId)} ` +
    (entry.result === RESULT.pending ? 'için onay istendi' : 'yoklama verdi');
  if (sameBrowser) {
    warnings.push({ level: 'strong', text: `Aynı tarayıcıdan ${describe(sameBrowser)}` });
  }
  // Panelde (güncel durum): bu tarayıcı şu an başka öğrenciye kayıtlı mı?
  if (until === undefined && subject.deviceId) {
    const owner = analysis.deviceOwner.get(subject.deviceId);
    if (owner && owner.id !== subject.studentId && (!sameBrowser || sameBrowser.studentId !== owner.id)) {
      warnings.push({ level: 'strong', text: `Bu tarayıcı şu an ${owner.id} ${nameOf(owner.id)} adına kayıtlı` });
    }
  }
  if (sameNetwork) {
    warnings.push({ level: 'strong', text: `Aynı ağdan ve aynı cihaz imzasıyla ${describe(sameNetwork)}` });
  } else if (sameModelOnly) {
    warnings.push({
      level: 'weak',
      text: `Aynı model telefondan (farklı ağ / ayar ya da 5 dk'dan uzun arayla) ${describe(sameModelOnly)}` +
        (sameModelCount > 1 ? `; bu aralıkta aynı modelden ${sameModelCount} kayıt var` : '')
    });
  }

  // Bu öğrenci için bugün başka öğrencinin tarayıcısından denendi mi?
  const subjectDay = istanbulDayKey(subject.timestamp);
  for (const entry of analysis.entries) {
    if (until !== undefined && entry.timestamp >= until) break;
    if (entry.studentId !== subject.studentId || !isSameBrowserBlock(entry)) continue;
    if (entry.timestamp <= analysis.lastResetAt || istanbulDayKey(entry.timestamp) !== subjectDay) continue;
    const other = sameBrowserOther(entry);
    warnings.push({
      level: 'strong',
      text: `Bu öğrenci için ${timeDistance(subject.timestamp - entry.timestamp)} ${other} ${nameOf(other)} ` +
        'tarafından kullanılan tarayıcıdan denendi (reddedildi)'
    });
    break;
  }

  for (const entry of analysis.entries) {
    if (until !== undefined && entry.timestamp >= until) break;
    if (entry.result === RESULT.rejected && entry.studentId === subject.studentId &&
      entry.week === subject.week && entry.timestamp > analysis.lastResetAt && entry.timestamp < subject.timestamp) {
      warnings.push({ level: 'weak', text: 'Bu hafta için daha önce bir onay isteği reddedilmiş' });
      break;
    }
  }

  // Şüpheli yeni kayıt hiçbir zaman "uyarısız" görünmez (toplu/otomatik onaya girmez)
  if (reason.code === 'suspiciousRegistration' && !warnings.some(w => w.level === 'strong')) {
    warnings.push({
      level: 'strong',
      text: 'Kayıt döneminde şüpheli yeni kayıt: bu öğrencinin bekleyen bir isteği vardı ya da az önce aynı telefondan başka öğrenci denendi'
    });
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

/**
 * Sonuçlanmamış (onaylanmamış/reddedilmemiş) en son bekleyen kayıtlar; öğrenci+hafta başına bir tane.
 * `since` öncesindeki istekler sayılmaz. Cihaz kuralı (varsayılan): son sıfırlama ya da son
 * "Bildirimleri temizle", hangisi yeniyse (temizlenen istek reddedilmiş gibi tarayıcıyı bırakır).
 * Öğretmen listesi: yalnızca son "Bildirimleri temizle" (sıfırlama listeyi etkilemez).
 */
export function openPendingEntries(
  analysis: DeviceAnalysis,
  since: number = Math.max(analysis.lastResetAt, analysis.lastClearAt)
): LogEntry[] {
  const latest = new Map<string, LogEntry>();
  const resolvedAt = new Map<string, number>();
  const key = (entry: LogEntry) => `${entry.studentId}|${entry.week}`;
  for (const entry of analysis.entries) {
    if (entry.timestamp <= since || !entry.studentId) continue;
    if (entry.result === RESULT.pending) {
      latest.set(key(entry), entry);
    } else if (entry.result === RESULT.rejected ||
      (entry.result === RESULT.recorded && !entry.note.startsWith(NOTE_FIRST_REGISTRATION))) {
      // Bekleyen istek yalnızca öğretmenin kararıyla (onay/ret/otomatik onay) ya da
      // öğrencinin kayıtlı cihazından gelen yoklamayla kapanır; yeni bir tarayıcıdan
      // yapılan ilk kayıt onu kapatamaz (çerez silinerek öğretmenden gizlenemez)
      resolvedAt.set(key(entry), Math.max(resolvedAt.get(key(entry)) ?? 0, entry.timestamp));
    }
  }
  return [...latest.values()]
    .filter(entry => entry.timestamp > (resolvedAt.get(key(entry)) ?? 0))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Bugün öğretmene sorulmadan yazılan ve iptal edilmemiş kayıtlar: otomatik
 * onaylananlar ve kayıt döneminde serbestçe yapılan ilk kayıtlar. (Hangilerinin
 * gösterileceğine uyarılara bakılarak API'de karar verilir.)
 */
export function unattendedRecordsToday(analysis: DeviceAnalysis, now: number, since: number = analysis.lastClearAt): LogEntry[] {
  const today = istanbulDayKey(now);
  const cancelledAt = new Map<string, number>();
  for (const entry of analysis.entries) {
    if (entry.result === RESULT.cancelled) {
      const k = `${entry.studentId}|${entry.week}`;
      cancelledAt.set(k, Math.max(cancelledAt.get(k) ?? 0, entry.timestamp));
    }
  }
  return analysis.entries
    .filter(entry => entry.result === RESULT.recorded &&
      (entry.note.startsWith(NOTE_AUTO_APPROVED) || entry.note.startsWith(NOTE_FIRST_REGISTRATION)) &&
      entry.timestamp > since && istanbulDayKey(entry.timestamp) === today &&
      entry.timestamp > (cancelledAt.get(`${entry.studentId}|${entry.week}`) ?? 0))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** Bugün aynı tarayıcıdan reddedilen ve sonradan yoklaması yazılmamış denemeler (öğrenci+hafta başına son deneme) */
export function sameBrowserBlocksToday(analysis: DeviceAnalysis, now: number, since: number = analysis.lastClearAt): LogEntry[] {
  const today = istanbulDayKey(now);
  const latest = new Map<string, LogEntry>();
  const recordedAt = new Map<string, number>();
  const key = (entry: LogEntry) => `${entry.studentId}|${entry.week}`;
  for (const entry of analysis.entries) {
    if (entry.timestamp <= since || !entry.studentId) continue;
    if (isSameBrowserBlock(entry) && istanbulDayKey(entry.timestamp) === today) {
      latest.set(key(entry), entry);
    } else if (entry.result === RESULT.recorded) {
      recordedAt.set(key(entry), Math.max(recordedAt.get(key(entry)) ?? 0, entry.timestamp));
    }
  }
  return [...latest.values()]
    .filter(entry => entry.timestamp > (recordedAt.get(key(entry)) ?? 0))
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function sameBrowserOwner(entry: LogEntry): string {
  return sameBrowserOther(entry);
}
