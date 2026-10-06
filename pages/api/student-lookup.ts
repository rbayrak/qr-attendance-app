// pages/api/student-lookup.ts
// Öğrenci sayfası: yazılan numaranın listede olup olmadığını söyler.
//
// Önceden sayfa tüm sınıf listesini (numara + ad soyad) /api/students ile
// indiriyordu; sitenin adresini bilen herkes listenin tamamını görebiliyordu.
// Artık yalnızca yazılan numara sorulur; yanıt olarak listedeki asıl numara ve
// adın baş harfleri döner (ör. "Z. T."). Tam ad yalnızca geçerli QR ve konumla
// yoklama verildiğinde gösterilir.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getMainRows } from '@/utils/sheets';
import { findStudentRow, rowStudentId, rowStudentName } from '@/utils/roster';
import { getClientIP } from '@/utils/deviceGuard';

// Numara taramasına karşı örnek başına basit sınır (kampüs Wi-Fi'ında tüm
// sınıf aynı IP'den geldiği için cömert tutuldu)
const MAX_LOOKUPS_PER_WINDOW = 300;
const WINDOW_MS = 60 * 1000;
const recentLookups = new Map<string, number[]>();

function isRateLimited(ip: string, now: number): boolean {
  const list = (recentLookups.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (list.length >= MAX_LOOKUPS_PER_WINDOW) {
    recentLookups.set(ip, list);
    return true;
  }
  list.push(now);
  recentLookups.set(ip, list);
  if (recentLookups.size > 5000) recentLookups.clear(); // bellek sınırı
  return false;
}

/** "Zeynep Ayşe Test" -> "Z. A. T." */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toLocaleUpperCase('tr-TR')}.`)
    .join(' ');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const input = String(req.body?.studentId ?? '').slice(0, 40);
  if (!input.trim()) {
    return res.status(400).json({ error: 'Öğrenci numarası gerekli' });
  }
  if (isRateLimited(getClientIP(req) || 'unknown', Date.now())) {
    return res.status(429).json({ error: 'Çok fazla deneme. Biraz bekleyip tekrar deneyin.', retryable: true });
  }

  try {
    // Ana sayfa nadiren değişir: sınıf aynı anda sayfayı açınca her istek ayrı okuma yapmasın
    const rows = await getMainRows({ maxAgeMs: 60000 });
    const row = findStudentRow(rows, input);
    if (row === -1) {
      return res.status(200).json({ found: false });
    }
    return res.status(200).json({
      found: true,
      studentId: rowStudentId(rows, row),
      initials: initials(rowStudentName(rows, row))
    });
  } catch (error) {
    console.error('Öğrenci arama hatası:', error);
    return res.status(503).json({ error: 'Sunucu yoğun, lütfen tekrar deneyin', retryable: true });
  }
}
