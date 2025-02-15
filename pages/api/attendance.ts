import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

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

      // Cihaz parmak izi kontrolü
      if (!deviceFingerprint) {
        return res.status(400).json({ error: 'Cihaz tanımlayıcısı gerekli' });
      }

      // Bugünün başlangıç timestamp'i
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      // Mevcut cihaz kaydını kontrol et
      const existingAttendance = deviceAttendanceMap.get(deviceFingerprint);
      
      if (existingAttendance) {
        // Aynı gün kontrolü
        if (existingAttendance.timestamp >= today.getTime()) {
          // Farklı öğrenci kontrolü
          if (studentId !== existingAttendance.studentId) {
            return res.status(403).json({ 
              error: 'Bu cihaz bugün başka bir öğrenci için kullanılmış',
              blockedStudentId: existingAttendance.studentId 
            });
          }
        }
      }

      // Cihaz kaydını güncelle veya oluştur
      deviceAttendanceMap.set(deviceFingerprint, {
        studentId,
        timestamp: Date.now(),
        deviceFingerprints: [deviceFingerprint]
      });

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

      // Öğrenciyi bul ve satır numarasını al
      const studentRowIndex = rows.findIndex(row => row[1] === studentId);
      if (studentRowIndex === -1) {
        return res.status(404).json({ error: 'Öğrenci bulunamadı' });
      }

      // Hafta sütunu kontrolü
      const weekColumnIndex = 3 + Number(week) - 1; // D sütunundan başlayarak
      const weekData = rows.map(row => row[weekColumnIndex]);
      
      // Cihaz parmak izi kontrolü - sheets üzerinde
      const deviceFingerprintCheck = weekData.find(cell => 
        cell && 
        cell.includes(`(DF:${deviceFingerprint})`)
      );
      
      if (deviceFingerprintCheck) {
        // Bu cihaz parmak izi zaten kullanılmışsa
        const existingStudentId = rows[rows.findIndex(row => 
          row[weekColumnIndex] && 
          row[weekColumnIndex].includes(`(DF:${deviceFingerprint})`)
        )][1];

        // Farklı bir öğrenci için kullanılmışsa engelle
        if (existingStudentId !== studentId) {
          return res.status(403).json({ 
            error: 'Bu cihaz bu hafta başka bir öğrenci için kullanılmış',
            blockedStudentId: existingStudentId 
          });
        }
      }
      
      // Gerçek satır numarası
      const studentRow = studentRowIndex + 1;

      if (week < 1 || week > 16) {
        return res.status(400).json({ error: 'Geçersiz hafta numarası' });
      }

      // Hafta sütununu belirle
      const weekColumn = String.fromCharCode(68 + Number(week) - 1);
      const range = `${weekColumn}${studentRow}`;

      // Mevcut hafta verilerini kontrol et ve öğrencinin zaten yoklaması var mı diye bak
      const isAlreadyAttended = rows[studentRowIndex][weekColumnIndex] && 
                              rows[studentRowIndex][weekColumnIndex].includes('VAR');

      // Yoklamayı kaydet (cihaz parmak izi ile)
      const updateResult = await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[`VAR (DF:${deviceFingerprint})`]]
        }
      });

      // Başarılı yanıt
      res.status(200).json({ 
        success: true,
        isAlreadyAttended: isAlreadyAttended,
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
        error: error instanceof Error ? error.message : 'Unknown error',
        debug: 'debugInfo'
      });
    }
  }
  else if (req.method === 'DELETE') {
    const { fingerprint } = req.query;

    try {
      // Belirli bir fingerprint'i silme
      if (fingerprint) {
        // 1. Memory'den sil
        deviceAttendanceMap.delete(fingerprint as string);

        // 2. Google Sheets'ten fingerprint'i temizle
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

        let fingerprintFound = false;

        // Fingerprint'i bul ve temizle
        for (let i = 0; i < rows.length; i++) {
          for (let j = 3; j < rows[i].length; j++) { // D sütunundan başla
            const cell = rows[i][j];
            if (cell && cell.includes(`(DF:${fingerprint})`)) {
              fingerprintFound = true;
              // Hücreyi güncelle - sadece "VAR" bırak
              const range = `${String.fromCharCode(65 + j)}${i + 1}`; // A=65
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