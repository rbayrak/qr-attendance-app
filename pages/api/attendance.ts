// pages/api/attendance.ts

import { NextApiRequest, NextApiResponse } from 'next';
import { ResponseData } from '@/types/types';
import {
  getSheetData,
  writeMainCell,
  appendLogRow,
  isRetryableError,
  columnLetter,
  SheetRows
} from '@/utils/sheets';
import {
  getDeviceIdentity,
  findDeviceConflict,
  findSuspicion,
  buildLogRow,
  getClientIP,
  RESULT
} from '@/utils/deviceGuard';
import { getPlace, distanceKm, isValidCoordinate, MAX_DISTANCE_KM } from '@/utils/places';
import { parseQrPayload, isLegacyQr } from '@/utils/qrFormat';
import { isQrSignatureValid, requireTeacher } from '@/utils/teacherAuth';

// Öğrenci numarası B, adı C sütununda; 1. hafta D sütununda
const STUDENT_ID_COLUMN = 1;
const STUDENT_NAME_COLUMN = 2;
const FIRST_WEEK_COLUMN = 3;
const MAX_WEEK = 16;
// Öğretmen bilgisayarı ile sunucu saati arasındaki küçük farklar için tolerans
const QR_EXPIRY_TOLERANCE_SEC = 5 * 60;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method === 'POST') {
    return handlePostRequest(req, res);
  }
  if (req.method === 'DELETE') {
    if (!requireTeacher(req, res)) return;
    return handleResetRequest(res);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

function findStudentRow(rows: SheetRows, studentId: string): number {
  for (let i = 1; i < rows.length; i++) {
    const cell = rows[i]?.[STUDENT_ID_COLUMN];
    if (cell !== undefined && cell !== null && String(cell).trim() === studentId) {
      return i;
    }
  }
  return -1;
}

// Kayıt sayfasına yazılamaması yoklama sonucunu değiştirmemeli
async function safeAppendLog(row: string[]) {
  try {
    await appendLogRow(row);
  } catch (error) {
    console.error('Kayıt satırı yazılamadı:', error);
  }
}

// POST: yoklama kaydı
async function handlePostRequest(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  try {
    const body = req.body || {};
    const studentId = String(body.studentId ?? '').trim();
    const qrText = typeof body.qr === 'string' ? body.qr : '';
    const lat = body.lat;
    const lng = body.lng;
    const model = typeof body.hardwareSignature === 'string'
      ? body.hardwareSignature.slice(0, 8)
      : 'unknown';

    // 1. Temel validasyonlar
    if (!studentId) {
      return res.status(400).json({ error: 'Öğrenci numarası gerekli' });
    }

    if (!qrText || !isValidCoordinate(lat, lng)) {
      // Öğrencinin tarayıcısında uygulamanın eski sürümü açık kalmış olabilir
      return res.status(400).json({ error: 'Uygulama güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.' });
    }

    // 2. QR doğrulama: biçim, öğretmen imzası, süre
    const qr = parseQrPayload(qrText);
    if (!qr) {
      return res.status(400).json({
        error: isLegacyQr(qrText)
          ? 'Bu QR kod uygulamanın eski sürümüne ait. Öğretmeninizden sayfayı yenileyip yeni QR oluşturmasını isteyin.'
          : 'Geçersiz QR kod'
      });
    }
    if (!isQrSignatureValid(qr)) {
      console.warn(`Geçersiz QR imzası: öğrenci=${studentId} qr=${qrText}`);
      return res.status(400).json({ error: 'Geçersiz QR kod. Öğretmenin yansıttığı QR kodu okutun.' });
    }
    const week = qr.week;
    if (week < 1 || week > MAX_WEEK) {
      return res.status(400).json({ error: 'Geçersiz hafta numarası' });
    }
    const now = Date.now();
    if (now / 1000 > qr.expiresAtSec + QR_EXPIRY_TOLERANCE_SEC) {
      return res.status(400).json({ error: 'QR kodun süresi dolmuş. Öğretmeninizden yeni QR isteyin.' });
    }

    const place = getPlace(qr.place);
    if (!place) {
      return res.status(400).json({ error: 'QR koddaki konum sunucuda tanımlı değil. Lütfen öğretmeninize bildirin.' });
    }

    const device = getDeviceIdentity(req, res);
    const ip = getClientIP(req) || 'unknown';

    // 3. Öğrenciyi bul (ana sayfa + kayıt sayfası tek okumada, paylaşılan önbellekten)
    const data = await getSheetData();
    const studentRowIndex = findStudentRow(data.main, studentId);
    if (studentRowIndex === -1) {
      return res.status(404).json({ error: 'Öğrenci bulunamadı' });
    }
    const studentName = String(data.main[studentRowIndex]?.[STUDENT_NAME_COLUMN] ?? '');
    const logBase = { now, week, studentId, name: studentName, deviceId: device.id, model, ip };

    // 4. Konum kontrolü (sunucuda; QR'daki konuma göre)
    const distance = distanceKm(lat, lng, place.lat, place.lng);
    if (distance > MAX_DISTANCE_KM) {
      const meters = Math.round(distance * 1000);
      await safeAppendLog(buildLogRow({
        ...logBase,
        result: RESULT.outOfLocation,
        note: `${place.name} konumuna ${meters} m uzakta`
      }));
      return res.status(403).json({
        error: place.code === 'O'
          ? `Sınıf konumunda değilsiniz (${meters} metre uzaktasınız)`
          : 'Yoklama konumunda değilsiniz',
        locationError: true
      });
    }

    // 5. "Bu telefonla bugün başka öğrenci yoklama verdi mi?"
    const conflictStudentId = findDeviceConflict(data.log, device.id, studentId, now);
    if (conflictStudentId) {
      await safeAppendLog(buildLogRow({
        ...logBase,
        result: RESULT.blocked,
        note: `Bu cihazla bugün ${conflictStudentId} yoklama vermiş`
      }));
      return res.status(403).json({
        error: `Bu telefonla bugün ${conflictStudentId} numaralı öğrenci yoklama verdi. ` +
          'Her öğrenci kendi telefonunu kullanmalı. Bir sorun varsa öğretmeninize başvurun.',
        blockedStudentId: conflictStudentId
      });
    }

    // 6. Mevcut yoklama kontrolü - zaten varsa tekrar yazma (kota tasarrufu,
    //    ayrıca istemcinin otomatik tekrar denemeleri güvenle sonuçlanır)
    const weekColumnIndex = FIRST_WEEK_COLUMN + week - 1;
    const currentValue = data.main[studentRowIndex]?.[weekColumnIndex];
    if (typeof currentValue === 'string' && currentValue.includes('VAR')) {
      return res.status(200).json({ success: true, isAlreadyAttended: true });
    }

    // 7. Yoklamayı kaydet: hücreye sadece "VAR", tarih/saat ve ayrıntılar kayıt
    //    sayfasına (ikisi diğer öğrencilerin yazmalarıyla birlikte tek istekte gider)
    const note = findSuspicion(data.log, { device, model, ip, studentId, now });
    await Promise.all([
      writeMainCell(studentRowIndex, weekColumnIndex, 'VAR'),
      appendLogRow(buildLogRow({ ...logBase, result: RESULT.recorded, note }))
    ]);

    return res.status(200).json({
      success: true,
      isAlreadyAttended: false,
      debug: {
        operationDetails: {
          ogrenciNo: studentId,
          bulunanSatir: studentRowIndex + 1,
          sutun: columnLetter(weekColumnIndex),
          weekNumber: week
        }
      }
    });

  } catch (error) {
    console.error('Yoklama kayıt hatası:', error);
    if (isRetryableError(error)) {
      return res.status(503).json({
        error: 'Sunucu yoğun, lütfen tekrar deneyin',
        retryable: true
      });
    }
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Bilinmeyen hata'
    });
  }
}

// DELETE: "Cihaz Kayıtlarını Temizle"
//  - Kayıt sayfasına SIFIRLAMA satırı ekler: bu andan önceki cihaz eşleşmeleri
//    artık engel oluşturmaz (kayıtlar silinmez, geçmiş korunur)
//  - Eski sürümün yazdığı "VAR (DF:..) (HW:..) (IP:..) (DATE:..)" hücrelerini
//    sadece "VAR" yapar; hücredeki tarih/saat kayıt sayfasına aktarılır
async function handleResetRequest(res: NextApiResponse<ResponseData>) {
  try {
    const now = Date.now();
    const data = await getSheetData({ force: true });

    const writes: Promise<void>[] = [];
    let convertedCells = 0;
    for (let row = 1; row < data.main.length; row++) {
      for (let col = FIRST_WEEK_COLUMN; col < FIRST_WEEK_COLUMN + MAX_WEEK; col++) {
        const cell = data.main[row]?.[col];
        // Yalnızca eski sistemin ürettiği hücreler (öğretmenin elle yazdığı notlara dokunulmaz)
        if (typeof cell !== 'string' || !cell.startsWith('VAR') || !/\((DF|HW|IP|DATE):/.test(cell)) continue;
        writes.push(writeMainCell(row, col, 'VAR'));
        convertedCells++;

        const dateMatch = /\(DATE:(\d{12,14})\)/.exec(cell);
        if (dateMatch) {
          writes.push(appendLogRow(buildLogRow({
            now: Number(dateMatch[1]),
            week: col - FIRST_WEEK_COLUMN + 1,
            studentId: String(data.main[row]?.[STUDENT_ID_COLUMN] ?? '').trim(),
            name: String(data.main[row]?.[STUDENT_NAME_COLUMN] ?? ''),
            result: RESULT.legacy,
            deviceId: '', model: '', ip: '',
            note: 'Eski biçimli hücreden aktarıldı'
          })));
        }
      }
    }
    writes.push(appendLogRow(buildLogRow({
      now, week: '', studentId: '', name: '', result: RESULT.reset,
      deviceId: '', model: '', ip: '', note: 'Öğretmen cihaz kayıtlarını sıfırladı'
    })));

    await Promise.all(writes);
    console.log(`Cihaz kayıtları sıfırlandı, ${convertedCells} eski biçimli hücre dönüştürüldü`);

    return res.status(200).json({
      success: true,
      message: convertedCells > 0
        ? `Cihaz kayıtları sıfırlandı, ${convertedCells} eski biçimli hücre sadeleştirildi`
        : 'Cihaz kayıtları sıfırlandı'
    });
  } catch (error) {
    console.error('Sıfırlama hatası:', error);
    return res.status(isRetryableError(error) ? 503 : 500).json({
      error: 'Cihaz kayıtları sıfırlanamadı, lütfen tekrar deneyin'
    });
  }
}
