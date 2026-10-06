// pages/api/device-release.ts
// Öğretmen paneli: tek bir öğrencinin cihaz kaydını sıfırlar.
// Telefonunu değiştiren ya da tarayıcı verilerini silen öğrenci, kayıtlı cihazı
// farklı olduğu için yoklama veremez (bkz. utils/deviceGuard.ts). Bu istek
// kayıt sayfasına "CİHAZ SERBEST" satırı ekler: öğrencinin önceki cihaz
// eşleşmeleri artık sayılmaz, bir sonraki yoklamasında kullandığı cihaz kaydedilir.
// Kayıtlar silinmez, geçmiş korunur.

import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTeacher } from '@/utils/teacherAuth';
import { getSheetData, appendLogRow, isRetryableError } from '@/utils/sheets';
import { buildLogRow, getDeviceBindings, RESULT } from '@/utils/deviceGuard';

// Öğrenci numarası B, adı C sütununda
const STUDENT_ID_COLUMN = 1;
const STUDENT_NAME_COLUMN = 2;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireTeacher(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  const studentId = String(req.body?.studentId ?? '').trim();
  if (!studentId) {
    return res.status(400).json({ error: 'Öğrenci numarası gerekli' });
  }

  try {
    const data = await getSheetData({ force: true });
    const row = data.main.slice(1).find(r => String(r?.[STUDENT_ID_COLUMN] ?? '').trim() === studentId);
    if (!row) {
      return res.status(404).json({ error: `${studentId} numaralı öğrenci listede yok` });
    }
    const name = String(row[STUDENT_NAME_COLUMN] ?? '');
    const hadDevice = getDeviceBindings(data.log).studentDevice.has(studentId);

    await appendLogRow(buildLogRow({
      now: Date.now(), week: '', studentId, name, result: RESULT.release,
      deviceId: '', model: '', ip: '', note: 'Öğretmen öğrencinin cihaz kaydını sıfırladı'
    }));

    return res.status(200).json({
      success: true,
      message: hadDevice
        ? `${studentId} ${name}: cihaz kaydı sıfırlandı. Bir sonraki yoklamada kullandığı telefon kaydedilecek.`
        : `${studentId} ${name}: zaten kayıtlı bir cihazı yoktu, yoklama verebilir.`
    });
  } catch (error) {
    console.error('Cihaz kaydı sıfırlama hatası:', error);
    return res.status(isRetryableError(error) ? 503 : 500).json({
      error: 'Cihaz kaydı sıfırlanamadı, lütfen tekrar deneyin'
    });
  }
}
