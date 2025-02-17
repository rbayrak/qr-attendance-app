import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateFingerprint } from '@/utils/serverFingerprint';

type ResponseData = {
  success?: boolean;
  error?: string;
  message?: string;
  debug?: any;
  blockedStudentId?: string;
  isAlreadyAttended?: boolean;
};

interface DeviceAttendanceRecord {
  studentId: string;
  timestamp: number;
  deviceFingerprints: string[];
}

// Cihaz bazlı yoklama kayıtları
const deviceAttendanceMap = new Map<string, DeviceAttendanceRecord>();

// Fingerprint kontrolü fonksiyonu
const checkFingerprint = async (
  sheets: any,
  fingerprint: string,
  studentId: string,
  weekColumnIndex: number
): Promise<{
  isBlocked: boolean;
  existingStudentId?: string;
  error?: string;
}> => {
  try {
    // Önce fingerprint validasyonu
    const validationResult = await validateFingerprint(fingerprint, studentId);
    if (!validationResult.isValid) {
      return {
        isBlocked: true,
        error: validationResult.error
      };
    }

    // Tüm verileri çek
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'A:Z',
    });

    const rows = response.data.values;
    if (!rows) return { isBlocked: false };

    // Search for fingerprint in sheet
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][weekColumnIndex] && 
          rows[i][weekColumnIndex].includes(`(DF:${fingerprint})`)) {
        if (rows[i][1] !== studentId) {
          return {
            isBlocked: true,
            existingStudentId: rows[i][1]
          };
        }
      }
    }

    return { isBlocked: false };
  } catch (error) {
    console.error('Fingerprint check error:', error);
    return { 
      isBlocked: true,
      error: 'Fingerprint kontrol hatası'
    };
  }
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method === 'POST') {
    try {
      const { studentId, week, clientIP, deviceFingerprint } = req.body;

      if (!studentId || !week) {
        return res.status(400).json({ error: 'Öğrenci ID ve hafta bilgisi gerekli' });
      }

      if (!deviceFingerprint) {
        return res.status(400).json({ error: 'Cihaz tanımlayıcısı gerekli' });
      }

      // Bugünün başlangıç timestamp'i
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      // Mevcut cihaz kaydını kontrol et
      const existingAttendance = deviceAttendanceMap.get(deviceFingerprint);
      
      if (existingAttendance) {
        if (existingAttendance.timestamp >= today.getTime()) {
          if (studentId !== existingAttendance.studentId) {
            return res.status(403).json({ 
              error: 'Bu cihaz bugün başka bir öğrenci için kullanılmış',
              blockedStudentId: existingAttendance.studentId 
            });
          }
        }
      }

      // Google Sheets yetkilendirmesi
      const auth = new google.auth.GoogleAuth({
        credentials: {
          type: 'service_account',
          project_id: process.env.GOOGLE_PROJECT_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      const sheets = google.sheets({ version: 'v4', auth });

      // Tüm verileri çek
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A:Z',
      });

      const rows = response.data.values;
      if (!rows) {
        return res.status(404).json({ error: 'Veri bulunamadı' });
      }

      // Öğrenciyi bul
      const studentRowIndex = rows.findIndex(row => row[1] === studentId);
      if (studentRowIndex === -1) {
        return res.status(404).json({ error: 'Öğrenci bulunamadı' });
      }

      // Hafta kontrolü
      if (week < 1 || week > 16) {
        return res.status(400).json({ error: 'Geçersiz hafta numarası' });
      }

      const weekColumnIndex = 3 + Number(week) - 1;

      // Gelişmiş fingerprint kontrolü
      const fingerprintCheck = await checkFingerprint(sheets, deviceFingerprint, studentId, weekColumnIndex);
      
      if (fingerprintCheck.isBlocked) {
        return res.status(403).json({ 
          error: fingerprintCheck.error || 'Bu cihaz başka bir öğrenci için kullanılmış',
          blockedStudentId: fingerprintCheck.existingStudentId
        });
      }

      // Yoklama kaydı için değerleri hesapla
      const studentRow = studentRowIndex + 1;
      const weekColumn = String.fromCharCode(68 + Number(week) - 1);
      const range = `${weekColumn}${studentRow}`;

      // Mevcut yoklama kontrolü
      const isAlreadyAttended = rows[studentRowIndex][weekColumnIndex] && 
                               rows[studentRowIndex][weekColumnIndex].includes('VAR');

      // Cihaz kaydını güncelle
      deviceAttendanceMap.set(deviceFingerprint, {
        studentId,
        timestamp: Date.now(),
        deviceFingerprints: [deviceFingerprint]
      });

      // Yoklamayı kaydet
      const updateResult = await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[`VAR (DF:${deviceFingerprint})`]]
        }
      });

      res.status(200).json({ 
        success: true,
        isAlreadyAttended,
        debug: {
          operationDetails: {
            ogrenciNo: studentId,
            bulunanSatir: studentRow,
            sutun: weekColumn,
            aralik: range,
            weekNumber: week,
            deviceFingerprint: deviceFingerprint
          },
          updateResult: updateResult.data
        }
      });

    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
  else if (req.method === 'DELETE') {
    const { fingerprint } = req.query;

    try {
      if (fingerprint) {
        // Memory'den sil
        deviceAttendanceMap.delete(fingerprint as string);

        // Google Sheets'ten temizle
        const auth = new google.auth.GoogleAuth({
          credentials: {
            type: 'service_account',
            project_id: process.env.GOOGLE_PROJECT_ID,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
          },
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'A:Z',
        });

        const rows = response.data.values;
        if (!rows) {
          return res.status(404).json({ error: 'Veri bulunamadı' });
        }

        let fingerprintFound = false;

        // Fingerprint'i bul ve temizle
        for (let i = 0; i < rows.length; i++) {
          for (let j = 3; j < rows[i].length; j++) {
            const cell = rows[i][j];
            if (cell && cell.includes(`(DF:${fingerprint})`)) {
              fingerprintFound = true;
              const range = `${String.fromCharCode(65 + j)}${i + 1}`;
              await sheets.spreadsheets.values.update({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: range,
                valueInputOption: 'RAW',
                requestBody: {
                  values: [['VAR']]
                }
              });
            }
          }
        }

        if (!fingerprintFound && !deviceAttendanceMap.has(fingerprint as string)) {
          return res.status(404).json({ error: 'Fingerprint bulunamadı' });
        }

        return res.status(200).json({ 
          success: true,
          message: `${fingerprint} fingerprint'i silindi`
        });
      }

      // Tüm kayıtları temizle
      deviceAttendanceMap.clear();
      return res.status(200).json({ 
        success: true,
        message: 'Tüm cihaz kayıtları temizlendi'
      });
    } catch (error) {
      console.error('Delete Error:', error);
      return res.status(500).json({ 
        error: 'İşlem sırasında bir hata oluştu'
      });
    }
  }
  else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}