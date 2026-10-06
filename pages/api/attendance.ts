// pages/api/attendance.ts

import { NextApiRequest, NextApiResponse } from 'next';
import { ResponseData } from '@/types/types';
import {
  getSheetData,
  writeMainCell,
  appendLogRow,
  isRetryableError,
  columnLetter
} from '@/utils/sheets';
import {
  getDeviceIdentity,
  analyzeDevices,
  decideDevice,
  warningsFor,
  reasonTag,
  openPendingEntries,
  deviceModel,
  sameBrowserNote,
  buildLogRow,
  getClientIP,
  RESULT,
  NOTE_AUTO_APPROVED,
  NOTE_FIRST_REGISTRATION
} from '@/utils/deviceGuard';
import {
  STUDENT_ID_COLUMN,
  STUDENT_NAME_COLUMN,
  FIRST_WEEK_COLUMN,
  MAX_WEEK,
  findStudentRow,
  rowStudentId,
  rowStudentName,
  weekColumn,
  hasAttended,
  nameLookup
} from '@/utils/roster';
import { getPlace, distanceKm, isValidCoordinate, MAX_DISTANCE_KM } from '@/utils/places';
import { parseQrPayload, isLegacyQr } from '@/utils/qrFormat';
import { isQrSignatureValid, requireTeacher } from '@/utils/teacherAuth';
import { detectInAppBrowser } from '@/utils/browserInfo';

// QR öğretmen ekranında 60 sn'de bir değişir. Süresi dolan QR bir süre daha
// kabul edilir: öğrenci QR'ı geçerliyken okutmuş ama istek yavaş ağ ya da
// sunucu yoğunluğu yüzünden geç ulaşmış olabilir.
const QR_GRACE_SEC = 2 * 60;
// Geçerlilik süresi bundan uzun bir QR'ı yalnızca uygulamanın eski sürümü üretir
// (15 dk geçerli QR); fotoğrafı paylaşılıp uzun süre kullanılmasın diye kabul edilmez.
const QR_MAX_REMAINING_SEC = 5 * 60;

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

// Kayıt sayfasına yazılamaması yoklama sonucunu değiştirmemeli
async function safeAppendLog(row: string[]) {
  try {
    await appendLogRow(row);
  } catch (error) {
    console.error('Kayıt satırı yazılamadı:', error);
  }
}

const REGISTERED_HINT = 'Bu telefon ve tarayıcı adınıza kaydedildi. Yoklamayı hep bu tarayıcıdan verin; gizli sekme kullanmayın.';

// POST: yoklama kaydı
async function handlePostRequest(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  try {
    const body = req.body || {};
    const inputStudentId = String(body.studentId ?? '').trim();
    const qrText = typeof body.qr === 'string' ? body.qr : '';
    const lat = body.lat;
    const lng = body.lng;
    const userAgent = String(req.headers['user-agent'] ?? '');
    // Cihaz imzası: donanım + tarayıcı ayrıntıları (yalnızca uyarı / onaya düşürme için)
    const model = deviceModel(body.hardwareSignature, userAgent, body.deviceDetail);

    // 1. Temel validasyonlar
    if (!inputStudentId) {
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
      console.warn(`Geçersiz QR imzası: öğrenci=${inputStudentId} qr=${qrText}`);
      return res.status(400).json({ error: 'Geçersiz QR kod. Öğretmenin yansıttığı QR kodu okutun.' });
    }
    const week = qr.week;
    if (week < 1 || week > MAX_WEEK) {
      return res.status(400).json({ error: 'Geçersiz hafta numarası' });
    }
    const now = Date.now();
    const nowSec = now / 1000;
    if (nowSec > qr.expiresAtSec + QR_GRACE_SEC) {
      return res.status(400).json({
        error: 'QR kodun süresi doldu. Ekrandaki güncel QR kodu tekrar okutun.',
        qrExpired: true
      });
    }
    if (qr.expiresAtSec - nowSec > QR_MAX_REMAINING_SEC) {
      return res.status(400).json({
        error: 'Bu QR kod uygulamanın eski sürümüyle üretilmiş. Öğretmeninizden sayfayı yenileyip yeni QR oluşturmasını isteyin.'
      });
    }

    const place = getPlace(qr.place);
    if (!place) {
      return res.status(400).json({ error: 'QR koddaki konum sunucuda tanımlı değil. Lütfen öğretmeninize bildirin.' });
    }

    const device = getDeviceIdentity(req, res);
    const ip = getClientIP(req) || 'unknown';

    // 3. Öğrenciyi bul (ana sayfa + kayıt sayfası tek okumada, paylaşılan önbellekten).
    //    "ç..." / "C..." gibi yazımlar listedeki asıl numarayla eşleşir; bundan
    //    sonra her yerde tablodaki asıl numara kullanılır.
    const data = await getSheetData();
    const studentRowIndex = findStudentRow(data.main, inputStudentId);
    if (studentRowIndex === -1) {
      return res.status(404).json({ error: 'Öğrenci bulunamadı' });
    }
    const studentId = rowStudentId(data.main, studentRowIndex);
    const studentName = rowStudentName(data.main, studentRowIndex);
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

    // 5. Bu hafta yoklaması zaten alınmış mı? Hiçbir şey yazmadığı için cihaz
    //    kontrolünden önce yapılır: başka tarayıcıdan tekrar okutan öğrenci
    //    gereksiz bir uyarı görmez. (Kota tasarrufu; istemcinin otomatik tekrar
    //    denemeleri de güvenle sonuçlanır.)
    const weekColumnIndex = weekColumn(week);
    if (hasAttended(data.main, studentRowIndex, week)) {
      return res.status(200).json({ success: true, isAlreadyAttended: true, studentId, studentName });
    }

    // 6. Öğrenci-cihaz eşleştirmesi (bkz. utils/deviceGuard.ts)
    const analysis = analyzeDevices(data.log);
    const decision = decideDevice(analysis, { deviceId: device.id, studentId, model, ip, now });

    // Aynı tarayıcı (çerez silinmemiş) başka bir öğrenciye kayıtlı: kesin kanıt, yoklama alınmaz
    if (decision.kind === 'reject') {
      await safeAppendLog(buildLogRow({
        ...logBase,
        result: RESULT.blocked,
        note: sameBrowserNote(decision.otherStudentId)
      }));
      return res.status(403).json({
        error: `Yoklamanız alınmadı. Bu telefon (tarayıcı) ${decision.otherStudentId} numaralı öğrenci tarafından kullanılıyor; ` +
          'aynı telefondan ikinci bir öğrenci yoklama veremez. Kendi telefonunuzla tekrar deneyin. ' +
          'Telefonunuz yanınızda değilse öğretmeninize başvurun.',
        blockedStudentId: decision.otherStudentId
      });
    }

    // Yeni bir eşleşme oluşturacak istekler uygulama içi tarayıcıdan kabul edilmez:
    // Instagram vb. kendi tarayıcısının ayrı çerezleri vardır, öğrenci sonraki
    // hafta Safari/Chrome'dan gelince telefonu "değişmiş" görünürdü.
    if (decision.kind !== 'registered') {
      const inApp = detectInAppBrowser(userAgent);
      if (inApp) {
        await safeAppendLog(buildLogRow({
          ...logBase,
          result: RESULT.blocked,
          note: `Uygulama içi tarayıcı (${inApp}): Safari/Chrome'da açması istendi`
        }));
        return res.status(400).json({
          error: `Bu sayfa ${inApp} içinde açıldı. Yoklamayı vermek için sağ üstteki menüden ` +
            '"Tarayıcıda aç" (Safari/Chrome) seçeneğini kullanın ve QR\'ı orada okutun.',
          inAppBrowser: true
        });
      }
    }

    const nameOf = nameLookup(data.main);

    if (decision.kind === 'pending') {
      // Aynı cihazdan aynı hafta için zaten bekleyen bir istek varsa tekrar yazma
      const alreadyPending = openPendingEntries(analysis).some(entry =>
        entry.studentId === studentId && entry.week === week && entry.deviceId === device.id);
      const reasonCode = decision.reason.code;

      if (!alreadyPending) {
        const subject = { studentId, week, deviceId: device.id, model, ip, timestamp: now };
        const { level, warnings } = warningsFor(analysis, subject, decision.reason, nameOf, now);

        // İsteğe bağlı otomatik onay: uyarısız cihaz değişikliği, öğrenci başına dönemde 1 kez
        // (şüpheli yeni kayıt asla otomatik onaylanmaz)
        if (analysis.autoApproveEnabled && level === 'clean' && reasonCode !== 'suspiciousRegistration' &&
          reasonCode !== 'deviceOwnedByOther' && !analysis.autoApprovalUsed.has(studentId)) {
          await Promise.all([
            writeMainCell(studentRowIndex, weekColumnIndex, 'VAR'),
            appendLogRow(buildLogRow({
              ...logBase, deviceId: '', model: '', ip: '', result: RESULT.release,
              note: 'Otomatik onay: önceki cihaz eşleşmesi kaldırıldı'
            })),
            appendLogRow(buildLogRow({
              ...logBase, now: now + 1, result: RESULT.recorded,
              note: `${NOTE_AUTO_APPROVED} (${decision.reason.code === 'firstRegistration' ? 'ilk kayıt' : 'cihaz değişikliği'})`
            }))
          ]);
          return res.status(200).json({
            success: true,
            isAlreadyAttended: false,
            studentId,
            studentName,
            registered: true,
            message: REGISTERED_HINT
          });
        }

        await appendLogRow(buildLogRow({
          ...logBase,
          result: RESULT.pending,
          note: [reasonTag(decision.reason), ...warnings.map(w => `${w.level === 'strong' ? '⚠️' : '•'} ${w.text}`)].join(' ')
        }));
      }

      const message = reasonCode === 'suspiciousRegistration'
        ? 'Yoklamanız henüz alınmadı: bu telefondan az önce başka bir öğrenci yoklama vermiş görünüyor. ' +
          'İsteğiniz öğretmen onayına gönderildi; öğretmeniniz onaylarsa yoklamanız sayılır.'
        : reasonCode === 'firstRegistration'
          ? 'İlk kez yoklama veriyorsunuz; yoklamanız öğretmen onayına gönderildi. Başka bir şey yapmanıza gerek yok.'
          : 'Telefonunuz veya tarayıcınız değişmiş görünüyor (çerezler silinmiş, gizli sekme ya da farklı tarayıcı). ' +
            'Yoklamanız öğretmen onayına gönderildi; başka bir şey yapmanıza gerek yok.';
      // Eski sürüm sayfalar "success" görmeden "error" metnini gösterir
      return res.status(202).json({ pendingApproval: true, studentId, studentName, message, error: message });
    }

    // 7. Yoklamayı kaydet: hücreye sadece "VAR", tarih/saat ve ayrıntılar kayıt
    //    sayfasına (ikisi diğer öğrencilerin yazmalarıyla birlikte tek istekte gider)
    // Kayıt dönemindeki ilk kayıt işaretlenir: öğretmen panelinde, sonradan uyarı
    // oluşursa (ör. ağ değiştirip aynı telefondan deneyen) "kontrol edin" listesinde görünür
    let note = '';
    if (decision.kind === 'register') {
      const { warnings } = warningsFor(analysis,
        { studentId, week, deviceId: device.id, model, ip, timestamp: now },
        { code: 'firstRegistration' }, nameOf, now);
      note = [NOTE_FIRST_REGISTRATION, ...warnings.map(w => `• ${w.text}`)].join(' ');
    }
    await Promise.all([
      writeMainCell(studentRowIndex, weekColumnIndex, 'VAR'),
      appendLogRow(buildLogRow({ ...logBase, result: RESULT.recorded, note }))
    ]);

    return res.status(200).json({
      success: true,
      isAlreadyAttended: false,
      studentId,
      studentName,
      ...(decision.kind === 'register' ? { registered: true, message: REGISTERED_HINT } : {}),
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
//    ve onay bekleyen istekler artık sayılmaz, yeni kayıt dönemi başlar
//    (kayıtlar silinmez, geçmiş korunur)
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
