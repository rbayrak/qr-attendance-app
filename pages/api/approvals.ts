// pages/api/approvals.ts
// Öğretmen paneli: öğretmen onayı bekleyen yoklamalar (bkz. utils/deviceGuard.ts)
//
// GET  -> bekleyenler (uyarılarıyla), bugün reddedilenler, bugün kontrol
//         edilmesi önerilen kayıtlar, ayarlar
// POST -> { action: 'approve' | 'reject', studentId, week }   bekleyen istek
//         { action: 'approveClean' }                          uyarısızların hepsini onayla
//         { action: 'override', studentId, week }             reddedilene yine de yoklama ver
//         { action: 'cancel', studentId, week }               kontrol listesindeki kaydı iptal et
//         { action: 'setAutoApprove', enabled }               otomatik onay ayarı
//
// Onay: yoklama yazılır, öğrencinin önceki cihaz eşleşmesi kaldırılır ve
// isteği gönderdiği cihaz yeni kayıtlı cihazı olur. Ret: yoklama yazılmaz.
// "Yine de yoklama ver": aynı tarayıcıdan reddedilen öğrenciye (ör. telefonu
// bozuk, arkadaşınınkini kullandı) yoklama yazılır; cihaz kaydı DEĞİŞMEZ.
// İptal (otomatik onaylanan / kayıt döneminde serbestçe kaydedilen): hücre
// boşaltılır, öğrencinin cihaz eşleşmesi kaldırılır.

import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTeacher } from '@/utils/teacherAuth';
import { getSheetData, writeMainCell, appendLogRow, isRetryableError, SheetData } from '@/utils/sheets';
import {
  analyzeDevices,
  openPendingEntries,
  unattendedRecordsToday,
  sameBrowserBlocksToday,
  sameBrowserOwner,
  warningsFor,
  parseReasonTag,
  reasonLabel,
  isRegistrationOpen,
  settingRow,
  buildLogRow,
  RESULT,
  NOTE_TEACHER_APPROVED,
  NOTE_TEACHER_OVERRIDE,
  NOTE_AUTO_APPROVED,
  REGISTRATION_CLASS_DAYS,
  LogEntry,
  DeviceAnalysis
} from '@/utils/deviceGuard';
import { findStudentRow, weekColumn, hasAttended, nameLookup } from '@/utils/roster';
import { formatIstanbul } from '@/utils/time';

export interface ApprovalItem {
  studentId: string;
  name: string;
  week: number;
  at: string;
  reason: string;
  level: 'clean' | 'weak' | 'strong';
  warnings: { level: 'weak' | 'strong'; text: string }[];
}

function describe(
  analysis: DeviceAnalysis,
  data: SheetData,
  entry: LogEntry,
  options: { recordedOnly?: boolean } = {}
): ApprovalItem {
  const nameOf = nameLookup(data.main);
  const reason = parseReasonTag(entry.note);
  const { level, warnings } = warningsFor(analysis, entry, reason, nameOf, undefined, options);
  return {
    studentId: entry.studentId,
    name: entry.name || nameOf(entry.studentId),
    week: entry.week,
    at: formatIstanbul(entry.timestamp),
    reason: reasonLabel(reason, nameOf),
    level,
    warnings
  };
}

// Sonuçlanmamış ve hücresi henüz "VAR" olmayan bekleyen kayıtlar
function currentPending(data: SheetData, analysis: DeviceAnalysis): LogEntry[] {
  return openPendingEntries(analysis).filter(entry => {
    const row = findStudentRow(data.main, entry.studentId);
    return row !== -1 && !hasAttended(data.main, row, entry.week);
  });
}

// Bugün öğretmene sorulmadan yazılan kayıtlardan kontrol edilmesi gerekenler:
// tüm otomatik onaylar ve sonradan uyarı oluşan serbest ilk kayıtlar
// (yalnızca diğer öğrencilerin yazılmış yoklamalarıyla karşılaştırılır; bekleyen
// istekler zaten kendi listesinde görünüyor)
function reviewItems(data: SheetData, analysis: DeviceAnalysis, now: number) {
  return unattendedRecordsToday(analysis, now)
    .map(entry => {
      const auto = entry.note.startsWith(NOTE_AUTO_APPROVED);
      const item = describe(analysis, data, entry, { recordedOnly: true });
      return {
        entry,
        auto,
        item: { ...item, reason: auto ? 'Otomatik onaylandı' : 'Kayıt döneminde öğretmen onayı olmadan kaydedildi' }
      };
    })
    .filter(({ item, auto }) => auto || item.level !== 'clean');
}

function blockedItems(data: SheetData, analysis: DeviceAnalysis, now: number) {
  const nameOf = nameLookup(data.main);
  return sameBrowserBlocksToday(analysis, now).map(entry => {
    const owner = sameBrowserOwner(entry);
    const item: ApprovalItem = {
      studentId: entry.studentId,
      name: entry.name || nameOf(entry.studentId),
      week: entry.week,
      at: formatIstanbul(entry.timestamp),
      reason: `${owner} ${nameOf(owner)} tarafından kullanılan telefondan (tarayıcıdan) denedi; yoklama reddedildi`,
      level: 'strong',
      warnings: []
    };
    return { entry, item };
  });
}

const RISK_ORDER = { strong: 2, weak: 1, clean: 0 } as const;

function buildState(data: SheetData) {
  const analysis = analyzeDevices(data.log);
  const now = Date.now();
  return {
    // Yüksek riskliler en üstte; aynı seviyede en yeni önce
    pending: currentPending(data, analysis)
      .map(entry => describe(analysis, data, entry))
      .sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level]),
    blocked: blockedItems(data, analysis, now).map(({ item }) => item),
    review: reviewItems(data, analysis, now).map(({ item }) => item),
    autoApproveEnabled: analysis.autoApproveEnabled,
    registration: {
      open: isRegistrationOpen(analysis, now),
      classDays: analysis.classDays.length,
      limit: REGISTRATION_CLASS_DAYS
    }
  };
}

async function approve(data: SheetData, analysis: DeviceAnalysis, entry: LogEntry, now: number) {
  const row = findStudentRow(data.main, entry.studentId);
  if (row === -1) throw new Error(`${entry.studentId} listede yok`);
  const base = { week: entry.week, studentId: entry.studentId, name: entry.name };
  // İsteğin geldiği tarayıcı bu arada başka bir öğrenciye kaydolduysa onay yalnızca
  // yoklamayı yazar; telefonun sahibi değiştirilmez
  const owner = analysis.deviceOwner.get(entry.deviceId);
  const takenByOther = !!owner && owner.id !== entry.studentId;
  const writes: Promise<void>[] = takenByOther
    ? [appendLogRow(buildLogRow({
        ...base, now, result: RESULT.recorded, deviceId: '', model: entry.model, ip: entry.ip,
        note: `${NOTE_TEACHER_APPROVED} (istek: ${formatIstanbul(entry.timestamp, true)}; tarayıcı ${owner!.id} adına ` +
          'kayıtlı olduğu için cihaz kaydı yapılmadı)'
      }))]
    : [
        // Önce eski eşleşme kaldırılır, sonra (1 ms sonra) yeni cihazla kayıt yazılır
        appendLogRow(buildLogRow({
          ...base, now, result: RESULT.release, deviceId: '', model: '', ip: '',
          note: 'Öğretmen onayı: önceki cihaz eşleşmesi kaldırıldı'
        })),
        appendLogRow(buildLogRow({
          ...base, now: now + 1, result: RESULT.recorded,
          deviceId: entry.deviceId, model: entry.model, ip: entry.ip,
          note: `${NOTE_TEACHER_APPROVED} (istek: ${formatIstanbul(entry.timestamp, true)})`
        }))
      ];
  if (!hasAttended(data.main, row, entry.week)) {
    writes.push(writeMainCell(row, weekColumn(entry.week), 'VAR'));
  }
  await Promise.all(writes);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireTeacher(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      return res.status(200).json(buildState(await getSheetData()));
    }

    const body = req.body || {};
    const action = String(body.action ?? '');
    const studentId = String(body.studentId ?? '').trim();
    const week = Number(body.week);
    // Kararlar güncel veriyle verilir
    const data = await getSheetData({ force: true });
    const analysis = analyzeDevices(data.log);
    const now = Date.now();
    const pending = currentPending(data, analysis);
    const findPending = () => pending.find(entry => entry.studentId === studentId && entry.week === week);

    let message = '';
    if (action === 'approve') {
      const entry = findPending();
      if (!entry) return res.status(404).json({ error: 'Bekleyen istek bulunamadı (başka bir işlemle sonuçlanmış olabilir)' });
      await approve(data, analysis, entry, now);
      message = `${entry.studentId} ${entry.name}: Hafta ${entry.week} onaylandı`;
    } else if (action === 'approveClean') {
      const clean = pending.filter(entry => describe(analysis, data, entry).level === 'clean');
      // Aynı anda gönderilir; her öğrencinin satırları kendi içinde sıralı zamanlıdır
      await Promise.all(clean.map((entry, i) => approve(data, analysis, entry, now + i * 2)));
      message = clean.length > 0 ? `${clean.length} istek onaylandı` : 'Uyarısız bekleyen istek yok';
    } else if (action === 'reject') {
      const entry = findPending();
      if (!entry) return res.status(404).json({ error: 'Bekleyen istek bulunamadı (başka bir işlemle sonuçlanmış olabilir)' });
      await appendLogRow(buildLogRow({
        now, week: entry.week, studentId: entry.studentId, name: entry.name, result: RESULT.rejected,
        deviceId: entry.deviceId, model: entry.model, ip: entry.ip, note: 'Öğretmen reddetti'
      }));
      message = `${entry.studentId} ${entry.name}: Hafta ${entry.week} reddedildi`;
    } else if (action === 'override') {
      const found = blockedItems(data, analysis, now)
        .find(({ entry }) => entry.studentId === studentId && entry.week === week);
      if (!found) return res.status(404).json({ error: 'Reddedilen deneme bulunamadı (başka bir işlemle sonuçlanmış olabilir)' });
      const entry = found.entry;
      const row = findStudentRow(data.main, entry.studentId);
      if (row === -1) return res.status(404).json({ error: `${entry.studentId} listede yok` });
      // Cihaz kimliği boş yazılır: telefon kimin adına kayıtlıysa onun kalır
      await Promise.all([
        ...(!hasAttended(data.main, row, entry.week) ? [writeMainCell(row, weekColumn(entry.week), 'VAR')] : []),
        appendLogRow(buildLogRow({
          now, week: entry.week, studentId: entry.studentId, name: entry.name, result: RESULT.recorded,
          deviceId: '', model: entry.model, ip: entry.ip,
          note: `${NOTE_TEACHER_OVERRIDE}: ${sameBrowserOwner(entry)} tarafından kullanılan telefondan (cihaz kaydı değişmedi)`
        }))
      ]);
      message = `${entry.studentId} ${entry.name}: Hafta ${entry.week} yoklaması verildi`;
    } else if (action === 'cancel') {
      const found = reviewItems(data, analysis, now)
        .find(({ entry }) => entry.studentId === studentId && entry.week === week);
      if (!found) return res.status(404).json({ error: 'İptal edilecek kayıt bulunamadı' });
      const entry = found.entry;
      const row = findStudentRow(data.main, entry.studentId);
      const base = { week: entry.week, studentId: entry.studentId, name: entry.name };
      await Promise.all([
        ...(row !== -1 ? [writeMainCell(row, weekColumn(entry.week), '')] : []),
        appendLogRow(buildLogRow({
          ...base, now, result: RESULT.cancelled, deviceId: entry.deviceId, model: entry.model, ip: entry.ip,
          note: 'Öğretmen kaydı iptal etti'
        })),
        appendLogRow(buildLogRow({
          ...base, now: now + 1, result: RESULT.release, deviceId: '', model: '', ip: '',
          note: 'Kayıt iptal edildi: cihaz eşleşmesi kaldırıldı'
        }))
      ]);
      message = `${entry.studentId} ${entry.name}: Hafta ${entry.week} yoklaması iptal edildi`;
    } else if (action === 'setAutoApprove') {
      const enabled = body.enabled === true;
      await appendLogRow(settingRow(now, enabled));
      message = enabled ? 'Otomatik onay açıldı' : 'Otomatik onay kapatıldı';
    } else {
      return res.status(400).json({ error: 'Geçersiz işlem' });
    }

    return res.status(200).json({ success: true, message, ...buildState(await getSheetData()) });
  } catch (error) {
    console.error('Onay işlemi hatası:', error);
    return res.status(isRetryableError(error) ? 503 : 500).json({
      error: 'İşlem yapılamadı, lütfen tekrar deneyin'
    });
  }
}
