// pages/api/approvals.ts
// Öğretmen paneli: öğretmen onayı bekleyen yoklamalar (bkz. utils/deviceGuard.ts)
//
// GET  -> bekleyenler (uyarılarıyla), bugün otomatik onaylananlar, ayarlar
// POST -> { action: 'approve' | 'reject' | 'cancel', studentId, week }
//         { action: 'approveClean' }               uyarısız olanların hepsini onayla
//         { action: 'setAutoApprove', enabled }    otomatik onay ayarı
//
// Onay: yoklama yazılır, öğrencinin önceki cihaz eşleşmesi kaldırılır ve
// isteği gönderdiği cihaz yeni kayıtlı cihazı olur. Ret: yoklama yazılmaz.
// İptal (otomatik onaylananlar için): hücre boşaltılır, cihaz eşleşmesi kaldırılır.

import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTeacher } from '@/utils/teacherAuth';
import { getSheetData, writeMainCell, appendLogRow, isRetryableError, SheetData } from '@/utils/sheets';
import {
  analyzeDevices,
  openPendingEntries,
  autoApprovedToday,
  warningsFor,
  parseReasonTag,
  reasonLabel,
  isRegistrationOpen,
  settingRow,
  buildLogRow,
  RESULT,
  NOTE_TEACHER_APPROVED,
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

function describe(analysis: DeviceAnalysis, data: SheetData, entry: LogEntry): ApprovalItem {
  const nameOf = nameLookup(data.main);
  const reason = parseReasonTag(entry.note);
  const { level, warnings } = warningsFor(analysis, entry, reason, nameOf);
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

function buildState(data: SheetData) {
  const analysis = analyzeDevices(data.log);
  const now = Date.now();
  return {
    pending: currentPending(data, analysis).map(entry => describe(analysis, data, entry)),
    autoApproved: autoApprovedToday(analysis, now).map(entry => ({
      ...describe(analysis, data, entry),
      reason: 'Otomatik onaylandı'
    })),
    autoApproveEnabled: analysis.autoApproveEnabled,
    registration: {
      open: isRegistrationOpen(analysis, now),
      classDays: analysis.classDays.length,
      limit: REGISTRATION_CLASS_DAYS
    }
  };
}

async function approve(data: SheetData, entry: LogEntry, now: number) {
  const row = findStudentRow(data.main, entry.studentId);
  if (row === -1) throw new Error(`${entry.studentId} listede yok`);
  const base = { week: entry.week, studentId: entry.studentId, name: entry.name };
  const writes: Promise<void>[] = [
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
      await approve(data, entry, now);
      message = `${entry.studentId} ${entry.name}: Hafta ${entry.week} onaylandı`;
    } else if (action === 'approveClean') {
      const clean = pending.filter(entry => describe(analysis, data, entry).level === 'clean');
      // Aynı anda gönderilir; her öğrencinin satırları kendi içinde sıralı zamanlıdır
      await Promise.all(clean.map((entry, i) => approve(data, entry, now + i * 2)));
      message = clean.length > 0 ? `${clean.length} istek onaylandı` : 'Uyarısız bekleyen istek yok';
    } else if (action === 'reject') {
      const entry = findPending();
      if (!entry) return res.status(404).json({ error: 'Bekleyen istek bulunamadı (başka bir işlemle sonuçlanmış olabilir)' });
      await appendLogRow(buildLogRow({
        now, week: entry.week, studentId: entry.studentId, name: entry.name, result: RESULT.rejected,
        deviceId: entry.deviceId, model: entry.model, ip: entry.ip, note: 'Öğretmen reddetti'
      }));
      message = `${entry.studentId} ${entry.name}: Hafta ${entry.week} reddedildi`;
    } else if (action === 'cancel') {
      const entry = autoApprovedToday(analysis, now)
        .find(item => item.studentId === studentId && item.week === week);
      if (!entry) return res.status(404).json({ error: 'Otomatik onaylanan kayıt bulunamadı' });
      const row = findStudentRow(data.main, entry.studentId);
      const base = { week: entry.week, studentId: entry.studentId, name: entry.name };
      await Promise.all([
        ...(row !== -1 ? [writeMainCell(row, weekColumn(entry.week), '')] : []),
        appendLogRow(buildLogRow({
          ...base, now, result: RESULT.cancelled, deviceId: entry.deviceId, model: entry.model, ip: entry.ip,
          note: 'Öğretmen otomatik onayı iptal etti'
        })),
        appendLogRow(buildLogRow({
          ...base, now: now + 1, result: RESULT.release, deviceId: '', model: '', ip: '',
          note: 'Otomatik onay iptal edildi: cihaz eşleşmesi kaldırıldı'
        }))
      ]);
      message = `${entry.studentId} ${entry.name}: Hafta ${entry.week} otomatik onayı iptal edildi`;
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
