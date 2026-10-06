// pages/api/week-suggestion.ts
// Öğretmen paneli için "önerilen hafta": son yoklamanın alındığı haftaya,
// o günden bu yana geçen süreye göre hafta ekler (7 gün = 1 hafta).

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSheetData, LOG_COL } from '@/utils/sheets';
import { RESULT } from '@/utils/deviceGuard';
import { istanbulDayKey, dayKeyDiff, dayKeyFromTurkishDate } from '@/utils/time';

const FIRST_WEEK_COLUMN = 3;
const MAX_WEEK = 16;

// Hücredeki yoklama tarihini gün anahtarı olarak döndürür (yoksa null).
// Yeni kayıtlarda hücrede yalnızca "VAR" bulunur, tarih kayıt sayfasından gelir;
// burada eski biçimli ya da öğretmenin elle tarih yazdığı hücreler okunur.
function cellDayKey(cell: string): string | null {
  const fromText = dayKeyFromTurkishDate(cell); // "VAR 06.10.2026"
  if (fromText) return fromText;
  const legacy = /\(DATE:(\d{12,14})\)/.exec(cell); // eski biçim
  return legacy ? istanbulDayKey(Number(legacy[1])) : null;
}

const formatDayKey = (key: string) => {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { main, log } = await getSheetData();

    // Yoklama alınmış son hafta
    let lastWeek = 0;
    for (let week = 1; week <= MAX_WEEK; week++) {
      const col = FIRST_WEEK_COLUMN + week - 1;
      if (main.slice(1).some(row => String(row?.[col] ?? '').includes('VAR'))) {
        lastWeek = week;
      }
    }

    if (lastWeek === 0) {
      return res.status(200).json({ suggestedWeek: 1, lastWeek: null, lastDate: null });
    }

    // O haftanın en son yoklama günü (hücrelerden ve kayıt sayfasından)
    let lastDayKey: string | null = null;
    const consider = (key: string | null) => {
      if (key && (!lastDayKey || key > lastDayKey)) lastDayKey = key;
    };
    const col = FIRST_WEEK_COLUMN + lastWeek - 1;
    for (const row of main.slice(1)) {
      const cell = String(row?.[col] ?? '');
      if (cell.includes('VAR')) consider(cellDayKey(cell));
    }
    for (const row of log.slice(1)) {
      const result = row[LOG_COL.result];
      if ((result === RESULT.recorded || result === RESULT.legacy) && Number(row[LOG_COL.week]) === lastWeek) {
        const timestamp = Number(row[LOG_COL.timestamp]);
        if (Number.isFinite(timestamp) && timestamp > 0) consider(istanbulDayKey(timestamp));
      }
    }

    if (!lastDayKey) {
      // Tarih bilinmiyorsa (elle yazılmış "VAR" gibi) bir sonraki haftayı öner
      return res.status(200).json({
        suggestedWeek: Math.min(MAX_WEEK, lastWeek + 1),
        lastWeek,
        lastDate: null
      });
    }

    const daysSince = dayKeyDiff(lastDayKey, istanbulDayKey(Date.now()));
    const suggestedWeek = daysSince <= 0
      ? lastWeek // aynı gün: aynı derse devam
      : Math.min(MAX_WEEK, lastWeek + Math.max(1, Math.round(daysSince / 7)));

    return res.status(200).json({
      suggestedWeek,
      lastWeek,
      lastDate: formatDayKey(lastDayKey),
      daysSince
    });
  } catch (error) {
    console.error('Hafta önerisi hatası:', error);
    return res.status(500).json({ error: 'Hafta önerisi hesaplanamadı' });
  }
}
