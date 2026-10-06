// pages/api/logs.ts
// Öğretmen panelindeki "Debug Konsolu": bugünkü olayları "Yoklama Kayıtları"
// sayfasından okuyup satır satır gösterir (yalnızca öğretmen).
//
// Önceden öğrenci sayfaları konsola satırı kendileri gönderiyordu (şifresiz);
// sitenin adresini bilen herkes konsola sahte satır ("✅ ... kaydedildi")
// yazabiliyordu. Satırlar ayrıca her sunucu örneğinin belleğinde ayrı
// tutulduğu için eksik görünebiliyordu. Artık tek kaynak kayıt sayfası: sahte
// satır eklenemez, tüm örnekler aynı şeyi gösterir.

import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTeacher } from '@/utils/teacherAuth';
import { getSheetData, LOG_COL } from '@/utils/sheets';
import { RESULT } from '@/utils/deviceGuard';
import { istanbulDayKey, formatIstanbul } from '@/utils/time';

const MAX_LINES = 500;

const ICONS: Record<string, string> = {
  [RESULT.recorded]: '✅',
  [RESULT.pending]: '🕓',
  [RESULT.rejected]: '🚫',
  [RESULT.cancelled]: '↩️',
  [RESULT.blocked]: '⛔',
  [RESULT.outOfLocation]: '📍',
  [RESULT.cameraError]: '📷',
  [RESULT.reset]: '🔄',
  [RESULT.release]: '🔓',
  [RESULT.setting]: '⚙️'
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Loglar öğrenci adları içerir: yalnızca öğretmen okuyabilir
  if (!requireTeacher(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { log } = await getSheetData();
    const today = istanbulDayKey(Date.now());
    const lines: { timestamp: number; text: string }[] = [];
    for (let i = 1; i < log.length; i++) {
      const row = log[i] || [];
      const timestamp = Number(row[LOG_COL.timestamp]);
      if (!Number.isFinite(timestamp) || istanbulDayKey(timestamp) !== today) continue;
      const result = String(row[LOG_COL.result] ?? '');
      const who = [row[LOG_COL.studentId], row[LOG_COL.name]].filter(Boolean).join(' ');
      const week = row[LOG_COL.week] ? `Hafta ${row[LOG_COL.week]}` : '';
      const note = String(row[LOG_COL.note] ?? '').slice(0, 300);
      // "06.10.2026 14:32:05" -> "[14:32:05]"
      const time = formatIstanbul(timestamp, true).slice(11);
      lines.push({
        timestamp,
        text: `[${time}] ${ICONS[result] ?? '•'} ${[result, who, week, note].filter(Boolean).join(' · ')}`
      });
    }
    const sorted = lines
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_LINES)
      .map(line => line.text);
    return res.status(200).json({ logs: sorted });
  } catch (error) {
    console.error('Log okuma hatası:', error);
    return res.status(503).json({ error: 'Kayıtlar okunamadı, tekrar deneyin' });
  }
}
